import loadHighs from "highs";
import {
  NO_AVAILABILITY_AFP_PLACEHOLDER_SOURCE,
  deriveShiftSlotIndexes,
  hoursToMinutes,
  isBackToBack,
  maxFeasibleShiftCapacityMinutes,
  minutesToHours,
  solveNonAfpPenaltyTargets,
  stableShiftKey,
  type AssignmentSource,
} from "./allocationCore.js";
import type {
  AllocationAssignment,
  AllocationPlan,
  AllocationRespondentInput,
  AllocationShiftInput,
  FairnessDiagnostics,
  PureAllocationInput,
  PureAllocationOutput,
} from "./allocationEngine.js";

interface OptimizerShift extends AllocationShiftInput {
  slotIndex: number;
  stableShiftKey: string;
}

interface AssignmentCandidate {
  variableKey: string;
  respondent: AllocationRespondentInput;
  shift: OptimizerShift;
  isManual: boolean;
  isNoAvailabilityPlaceholder: boolean;
}

interface ModelBuilder {
  constraints: Map<string, Constraint>;
  variables: Map<string, Map<string, number>>;
  binaries: Set<string>;
}

interface Constraint {
  equal?: number;
  min?: number;
  max?: number;
}

interface OptimizerSolution {
  status: "optimal" | "infeasible" | "unbounded" | "timedout" | "failed";
  result: number;
  variables: [string, number][];
  rawStatus: string;
}

export type GlobalAllocationAttempt =
  | { ok: true; output: PureAllocationOutput }
  | { ok: false; reason: string };

const SOLVER_OPTIONS = {
  output_flag: false,
  presolve: "on",
  time_limit: 4,
  mip_rel_gap: 0,
  mip_abs_gap: 0,
  random_seed: 0,
  threads: 1,
} as const;
const GENERAL_FAIRNESS_BAND_HOURS = 4;
const highsPromise = loadHighs();

function normalizeShifts(shifts: AllocationShiftInput[]): OptimizerShift[] {
  const slotIndexes = deriveShiftSlotIndexes(shifts);
  return shifts
    .map((shift) => {
      const slotIndex = slotIndexes.get(shift.id) ?? 0;
      return {
        ...shift,
        slotIndex,
        stableShiftKey: stableShiftKey({ ...shift, slotIndex }),
      };
    })
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        a.startTime.localeCompare(b.startTime) ||
        a.endTime.localeCompare(b.endTime) ||
        a.slotIndex - b.slotIndex ||
        a.id - b.id,
    );
}

function stdDev(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(
    values.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) /
      values.length,
  );
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function ensureVariable(
  builder: ModelBuilder,
  variableKey: string,
): Map<string, number> {
  const existing = builder.variables.get(variableKey);
  if (existing) return existing;
  const coefficients = new Map<string, number>();
  builder.variables.set(variableKey, coefficients);
  return coefficients;
}

function addCoefficient(
  builder: ModelBuilder,
  variableKey: string,
  constraintKey: string,
  coefficient: number,
): void {
  const coefficients = ensureVariable(builder, variableKey);
  coefficients.set(
    constraintKey,
    (coefficients.get(constraintKey) ?? 0) + coefficient,
  );
}

function formatNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toFixed(8)));
}

function formatExpression(
  terms: Array<{ coefficient: number; variableName: string }>,
): string {
  if (terms.length === 0) return "0";
  return terms
    .map(({ coefficient, variableName }, index) => {
      const sign = coefficient < 0 ? "-" : "+";
      const magnitude = Math.abs(coefficient);
      const renderedMagnitude =
        Math.abs(magnitude - 1) <= 1e-9 ? "" : `${formatNumber(magnitude)} `;
      return `${index === 0 && sign === "+" ? "" : `${sign} `}${renderedMagnitude}${variableName}`;
    })
    .join(" ");
}

function buildLpModel(
  builder: ModelBuilder,
  objective: string,
  direction: "maximize" | "minimize",
): {
  lp: string;
  variableKeyBySolverName: Map<string, string>;
} {
  const variableKeyBySolverName = new Map<string, string>();
  const solverNameByVariableKey = new Map<string, string>();
  Array.from(builder.variables.keys()).forEach((variableKey, index) => {
    const solverName = `v${index + 1}`;
    variableKeyBySolverName.set(solverName, variableKey);
    solverNameByVariableKey.set(variableKey, solverName);
  });

  const termsByConstraint = new Map<
    string,
    Array<{ coefficient: number; variableName: string }>
  >();
  for (const [variableKey, coefficients] of builder.variables) {
    const variableName = solverNameByVariableKey.get(variableKey)!;
    for (const [constraintKey, coefficient] of coefficients) {
      if (Math.abs(coefficient) <= 1e-9) continue;
      termsByConstraint.set(constraintKey, [
        ...(termsByConstraint.get(constraintKey) ?? []),
        { coefficient, variableName },
      ]);
    }
  }

  const objectiveExpression = formatExpression(
    termsByConstraint.get(objective) ?? [],
  );
  const rows: string[] = [];
  let rowIndex = 1;
  for (const [constraintKey, constraint] of builder.constraints) {
    const expression = formatExpression(
      termsByConstraint.get(constraintKey) ?? [],
    );
    if (constraint.equal !== undefined) {
      rows.push(
        ` c${rowIndex}: ${expression} = ${formatNumber(constraint.equal)}`,
      );
      rowIndex += 1;
      continue;
    }
    if (constraint.min !== undefined) {
      rows.push(
        ` c${rowIndex}: ${expression} >= ${formatNumber(constraint.min)}`,
      );
      rowIndex += 1;
    }
    if (constraint.max !== undefined) {
      rows.push(
        ` c${rowIndex}: ${expression} <= ${formatNumber(constraint.max)}`,
      );
      rowIndex += 1;
    }
  }

  const binaryNames = Array.from(builder.binaries)
    .map((variableKey) => solverNameByVariableKey.get(variableKey)!)
    .filter(Boolean);
  const binaryRows: string[] = [];
  for (let index = 0; index < binaryNames.length; index += 16) {
    binaryRows.push(` ${binaryNames.slice(index, index + 16).join(" ")}`);
  }

  return {
    lp: [
      direction === "maximize" ? "Maximize" : "Minimize",
      ` obj: ${objectiveExpression}`,
      "Subject To",
      ...rows,
      ...(binaryRows.length > 0 ? ["Binary", ...binaryRows] : []),
      "End",
    ].join("\n"),
    variableKeyBySolverName,
  };
}

async function solveStage(
  builder: ModelBuilder,
  objective: string,
  direction: "maximize" | "minimize",
): Promise<OptimizerSolution> {
  const highs = await highsPromise;
  const { lp, variableKeyBySolverName } = buildLpModel(
    builder,
    objective,
    direction,
  );
  const rawSolution = highs.solve(lp, SOLVER_OPTIONS);
  const status: OptimizerSolution["status"] =
    rawSolution.Status === "Optimal"
      ? "optimal"
      : rawSolution.Status === "Infeasible"
        ? "infeasible"
        : rawSolution.Status === "Unbounded" ||
            rawSolution.Status === "Primal infeasible or unbounded"
          ? "unbounded"
          : rawSolution.Status === "Time limit reached" ||
              rawSolution.Status === "Iteration limit reached" ||
              rawSolution.Status === "Bound on objective reached" ||
              rawSolution.Status === "Target for objective reached"
            ? "timedout"
            : "failed";
  const variables: [string, number][] = [];
  for (const [solverName, column] of Object.entries(rawSolution.Columns)) {
    if (!("Primal" in column)) continue;
    const variableKey = variableKeyBySolverName.get(solverName);
    if (!variableKey) continue;
    variables.push([variableKey, column.Primal]);
  }
  return {
    status,
    result: rawSolution.ObjectiveValue,
    variables,
    rawStatus: rawSolution.Status,
  };
}

function optimalResult(solution: OptimizerSolution): number | null {
  return solution.status === "optimal" && Number.isFinite(solution.result)
    ? solution.result
    : null;
}

function feasibleResult(solution: OptimizerSolution): number | null {
  return (solution.status === "optimal" || solution.status === "timedout") &&
    Number.isFinite(solution.result)
    ? solution.result
    : null;
}

function selectedVariableKeys(solution: OptimizerSolution): Set<string> {
  return new Set(
    solution.variables
      .filter(([, value]) => value > 0.5)
      .map(([variableKey]) => variableKey),
  );
}

function emptyOutput(
  respondents: AllocationRespondentInput[],
  shifts: OptimizerShift[],
): PureAllocationOutput {
  const plans: AllocationPlan[] = respondents.map((respondent) => ({
    respondentId: respondent.id,
    name: respondent.name,
    category: respondent.category,
    shiftIds: [],
    totalHours: 0,
    isManuallyAdjusted: false,
    penaltyNote: null,
  }));
  return {
    plans,
    assignments: [],
    averageHours: 0,
    stdDev: 0,
    unallocatedShiftIds: shifts.map((shift) => shift.id),
    fairnessDiagnostics: {
      nonPenalizedGeneralMeanHours: 0,
      nonPenalizedGeneralMedianHours: 0,
      nonPenalizedGeneralMinHours: 0,
      nonPenalizedGeneralMaxHours: 0,
      nonPenalizedGeneralRangeHours: 0,
      nonPenalizedGeneralStdDevHours: 0,
      maxDeviationFromMeanHours: 0,
      maxDeviationFromTargetHours: 0,
      sumSquaredDeviationFromTargetHours: 0,
      targetStdDevHours: 2,
      warningStdDevHours: 4,
      repairAttempted: false,
      successfulRepairMoves: 0,
      assignedShiftCountBeforeRepair: 0,
      assignedShiftCountAfterRepair: 0,
      highStdDevReasonCodes: [],
      optimizationMethod: "global_milp",
      optimizerStatus: "optimal",
      backToBackPairDays: 0,
      optimalCoverageProven: true,
    },
  };
}

function addSameDayConstraints(
  builder: ModelBuilder,
  candidates: AssignmentCandidate[],
): string[] {
  const backToBackVariableKeys: string[] = [];
  const byRespondentAndDate = new Map<string, AssignmentCandidate[]>();
  for (const candidate of candidates) {
    const key = `${candidate.respondent.id}:${candidate.shift.date}`;
    byRespondentAndDate.set(key, [
      ...(byRespondentAndDate.get(key) ?? []),
      candidate,
    ]);
    addCoefficient(builder, candidate.variableKey, `day:${key}`, 1);
    builder.constraints.set(`day:${key}`, { max: 2 });
  }

  for (const [respondentDateKey, dayCandidates] of byRespondentAndDate) {
    const sorted = [...dayCandidates].sort(
      (a, b) =>
        a.shift.slotIndex - b.shift.slotIndex ||
        a.shift.startTime.localeCompare(b.shift.startTime) ||
        a.shift.id - b.shift.id,
    );
    for (let firstIndex = 0; firstIndex < sorted.length; firstIndex += 1) {
      for (
        let secondIndex = firstIndex + 1;
        secondIndex < sorted.length;
        secondIndex += 1
      ) {
        const first = sorted[firstIndex];
        const second = sorted[secondIndex];
        if (isBackToBack(first.shift, second.shift)) {
          const pairConstraintKey = `pair:${respondentDateKey}:${first.shift.id}:${second.shift.id}`;
          const pairVariableKey = `b:${respondentDateKey}:${first.shift.id}:${second.shift.id}`;
          builder.constraints.set(pairConstraintKey, { max: 1 });
          addCoefficient(builder, first.variableKey, pairConstraintKey, 1);
          addCoefficient(builder, second.variableKey, pairConstraintKey, 1);
          addCoefficient(builder, pairVariableKey, pairConstraintKey, -1);
          addCoefficient(builder, pairVariableKey, "backToBack", 1);
          builder.binaries.add(pairVariableKey);
          backToBackVariableKeys.push(pairVariableKey);
          continue;
        }

        const nonAdjacentConstraintKey = `nonAdjacent:${respondentDateKey}:${first.shift.id}:${second.shift.id}`;
        builder.constraints.set(nonAdjacentConstraintKey, { max: 1 });
        addCoefficient(builder, first.variableKey, nonAdjacentConstraintKey, 1);
        addCoefficient(
          builder,
          second.variableKey,
          nonAdjacentConstraintKey,
          1,
        );
      }
    }
  }

  return backToBackVariableKeys;
}

function maxFeasibleCapacityMinutes(candidates: AssignmentCandidate[]): number {
  return maxFeasibleShiftCapacityMinutes(
    candidates.map((candidate) => candidate.shift),
    new Set(
      candidates
        .filter((candidate) => candidate.isManual)
        .map((candidate) => candidate.shift.id),
    ),
  );
}

function buildDiagnostics({
  respondents,
  assignments,
  shifts,
  targetMinutesByRespondentId,
  capacityLimitedRespondentIds,
  targetCapacityShortfallMinutes,
  optimizerStatus,
}: {
  respondents: AllocationRespondentInput[];
  assignments: AllocationAssignment[];
  shifts: OptimizerShift[];
  targetMinutesByRespondentId: Map<number, number>;
  capacityLimitedRespondentIds: Set<number>;
  targetCapacityShortfallMinutes: number;
  optimizerStatus: string;
}): FairnessDiagnostics {
  const shiftById = new Map(shifts.map((shift) => [shift.id, shift]));
  const actualMinutesByRespondentId = new Map<number, number>();
  for (const respondent of respondents)
    actualMinutesByRespondentId.set(respondent.id, 0);
  for (const assignment of assignments) {
    actualMinutesByRespondentId.set(
      assignment.respondentId,
      (actualMinutesByRespondentId.get(assignment.respondentId) ?? 0) +
        hoursToMinutes(shiftById.get(assignment.shiftId)?.durationHours ?? 0),
    );
  }

  const equalPool = respondents.filter((respondent) => !respondent.hasAfpCap);
  const nonPenalized = equalPool.filter(
    (respondent) =>
      (!respondent.hasPenalty || respondent.penaltyHours <= 0) &&
      !capacityLimitedRespondentIds.has(respondent.id),
  );
  const nonPenalizedMinutes = nonPenalized.map(
    (respondent) => actualMinutesByRespondentId.get(respondent.id) ?? 0,
  );
  const nonPenalizedMeanMinutes =
    nonPenalizedMinutes.length > 0
      ? nonPenalizedMinutes.reduce((sum, minutes) => sum + minutes, 0) /
        nonPenalizedMinutes.length
      : 0;
  const nonPenalizedMinMinutes =
    nonPenalizedMinutes.length > 0 ? Math.min(...nonPenalizedMinutes) : 0;
  const nonPenalizedMaxMinutes =
    nonPenalizedMinutes.length > 0 ? Math.max(...nonPenalizedMinutes) : 0;
  const targetDeviations = equalPool.map(
    (respondent) =>
      (actualMinutesByRespondentId.get(respondent.id) ?? 0) -
      (targetMinutesByRespondentId.get(respondent.id) ?? 0),
  );
  const maxTargetDeviationMinutes =
    targetDeviations.length > 0
      ? Math.max(...targetDeviations.map((deviation) => Math.abs(deviation)))
      : 0;
  const maxMeanDeviationMinutes =
    nonPenalizedMinutes.length > 0
      ? Math.max(
          ...nonPenalizedMinutes.map((minutes) =>
            Math.abs(minutes - nonPenalizedMeanMinutes),
          ),
        )
      : 0;
  const nonPenalizedStdDevMinutes = stdDev(nonPenalizedMinutes);
  const targetStdDevHours = 2;
  const warningStdDevHours = 4;
  const backToBackPairDays = Array.from(
    assignments.reduce((groups, assignment) => {
      const shift = shiftById.get(assignment.shiftId);
      if (!shift) return groups;
      const key = `${assignment.respondentId}:${shift.date}`;
      groups.set(key, [...(groups.get(key) ?? []), shift]);
      return groups;
    }, new Map<string, OptimizerShift[]>()),
  ).filter(
    ([, dayShifts]) =>
      dayShifts.length === 2 && isBackToBack(dayShifts[0], dayShifts[1]),
  ).length;

  const highStdDevReasonCodes =
    nonPenalizedStdDevMinutes > hoursToMinutes(targetStdDevHours)
      ? [
          ...(targetCapacityShortfallMinutes > 0
            ? ["NON_AFP_CAPACITY_SHORTFALL"]
            : []),
        ]
      : [];

  return {
    nonPenalizedGeneralMeanHours: minutesToHours(nonPenalizedMeanMinutes),
    nonPenalizedGeneralMedianHours: minutesToHours(median(nonPenalizedMinutes)),
    nonPenalizedGeneralMinHours: minutesToHours(nonPenalizedMinMinutes),
    nonPenalizedGeneralMaxHours: minutesToHours(nonPenalizedMaxMinutes),
    nonPenalizedGeneralRangeHours: minutesToHours(
      nonPenalizedMaxMinutes - nonPenalizedMinMinutes,
    ),
    nonPenalizedGeneralStdDevHours: minutesToHours(nonPenalizedStdDevMinutes),
    maxDeviationFromMeanHours: minutesToHours(maxMeanDeviationMinutes),
    maxDeviationFromTargetHours: minutesToHours(maxTargetDeviationMinutes),
    sumSquaredDeviationFromTargetHours: targetDeviations.reduce(
      (sum, deviation) => sum + Math.pow(minutesToHours(deviation), 2),
      0,
    ),
    targetStdDevHours,
    warningStdDevHours,
    repairAttempted: false,
    successfulRepairMoves: 0,
    assignedShiftCountBeforeRepair: assignments.length,
    assignedShiftCountAfterRepair: assignments.length,
    highStdDevReasonCodes,
    optimizationMethod: "global_milp",
    optimizerStatus,
    backToBackPairDays,
    optimalCoverageProven: true,
  };
}

function buildOutput({
  respondents,
  shifts,
  selectedCandidates,
  targetMinutesByRespondentId,
  capacityLimitedRespondentIds,
  targetCapacityShortfallMinutes,
  allowAfpOverCapForAvailableShifts,
  optimizerStatus,
}: {
  respondents: AllocationRespondentInput[];
  shifts: OptimizerShift[];
  selectedCandidates: AssignmentCandidate[];
  targetMinutesByRespondentId: Map<number, number>;
  capacityLimitedRespondentIds: Set<number>;
  targetCapacityShortfallMinutes: number;
  allowAfpOverCapForAvailableShifts: boolean;
  optimizerStatus: string;
}): PureAllocationOutput {
  const sortedCandidates = [...selectedCandidates].sort(
    (a, b) =>
      a.shift.date.localeCompare(b.shift.date) ||
      a.shift.slotIndex - b.shift.slotIndex ||
      a.shift.id - b.shift.id ||
      a.respondent.name.localeCompare(b.respondent.name) ||
      a.respondent.id - b.respondent.id,
  );
  const pairedShiftIds = new Set<number>();
  const byRespondentAndDate = new Map<string, AssignmentCandidate[]>();
  for (const candidate of sortedCandidates) {
    const key = `${candidate.respondent.id}:${candidate.shift.date}`;
    byRespondentAndDate.set(key, [
      ...(byRespondentAndDate.get(key) ?? []),
      candidate,
    ]);
  }
  for (const dayCandidates of byRespondentAndDate.values()) {
    if (
      dayCandidates.length === 2 &&
      isBackToBack(dayCandidates[0].shift, dayCandidates[1].shift)
    ) {
      pairedShiftIds.add(dayCandidates[0].shift.id);
      pairedShiftIds.add(dayCandidates[1].shift.id);
    }
  }

  const normalAfpMinutesByRespondentId = new Map<number, number>();
  for (const candidate of sortedCandidates) {
    if (
      !candidate.isManual ||
      candidate.isNoAvailabilityPlaceholder ||
      !candidate.respondent.hasAfpCap
    ) {
      continue;
    }
    normalAfpMinutesByRespondentId.set(
      candidate.respondent.id,
      (normalAfpMinutesByRespondentId.get(candidate.respondent.id) ?? 0) +
        hoursToMinutes(candidate.shift.durationHours),
    );
  }
  const assignments: AllocationAssignment[] = sortedCandidates.map(
    (candidate) => {
      let source: AssignmentSource;
      if (candidate.isManual) {
        source = "manual";
      } else if (candidate.isNoAvailabilityPlaceholder) {
        source = NO_AVAILABILITY_AFP_PLACEHOLDER_SOURCE;
      } else {
        const currentNormalMinutes =
          normalAfpMinutesByRespondentId.get(candidate.respondent.id) ?? 0;
        const durationMinutes = hoursToMinutes(candidate.shift.durationHours);
        const exceedsCap =
          candidate.respondent.hasAfpCap &&
          currentNormalMinutes + durationMinutes >
            hoursToMinutes(candidate.respondent.afpHoursCap);
        if (exceedsCap && allowAfpOverCapForAvailableShifts) {
          source = "engine_afp_cap_overflow_available";
        } else {
          source = pairedShiftIds.has(candidate.shift.id)
            ? "engine_back_to_back_emergency"
            : "engine_normal";
        }
        if (candidate.respondent.hasAfpCap) {
          normalAfpMinutesByRespondentId.set(
            candidate.respondent.id,
            currentNormalMinutes + durationMinutes,
          );
        }
      }
      return {
        respondentId: candidate.respondent.id,
        shiftId: candidate.shift.id,
        source,
        explanationCodes:
          source === "manual"
            ? ["MANUAL_OVERRIDE"]
            : source === NO_AVAILABILITY_AFP_PLACEHOLDER_SOURCE
              ? ["NO_AVAILABILITY"]
              : source === "engine_afp_cap_overflow_available"
                ? ["BLOCKED_BY_AFP_CAP"]
                : [],
      };
    },
  );

  const shiftById = new Map(shifts.map((shift) => [shift.id, shift]));
  const assignmentsByRespondentId = new Map<number, AllocationAssignment[]>();
  for (const assignment of assignments) {
    assignmentsByRespondentId.set(assignment.respondentId, [
      ...(assignmentsByRespondentId.get(assignment.respondentId) ?? []),
      assignment,
    ]);
  }
  const plans: AllocationPlan[] = respondents.map((respondent) => {
    const respondentAssignments =
      assignmentsByRespondentId.get(respondent.id) ?? [];
    const shiftIds = respondentAssignments.map(
      (assignment) => assignment.shiftId,
    );
    return {
      respondentId: respondent.id,
      name: respondent.name,
      category: respondent.category,
      shiftIds,
      totalHours: shiftIds.reduce(
        (sum, shiftId) => sum + (shiftById.get(shiftId)?.durationHours ?? 0),
        0,
      ),
      isManuallyAdjusted: respondentAssignments.some(
        (assignment) => assignment.source === "manual",
      ),
      penaltyNote: null,
    };
  });
  const allocatedShiftIds = new Set(
    assignments.map((assignment) => assignment.shiftId),
  );
  const allHours = plans.map((plan) => plan.totalHours);

  return {
    plans,
    assignments,
    averageHours:
      allHours.length > 0
        ? allHours.reduce((sum, hours) => sum + hours, 0) / allHours.length
        : 0,
    stdDev: stdDev(allHours),
    unallocatedShiftIds: shifts
      .map((shift) => shift.id)
      .filter((shiftId) => !allocatedShiftIds.has(shiftId)),
    fairnessDiagnostics: buildDiagnostics({
      respondents,
      assignments,
      shifts,
      targetMinutesByRespondentId,
      capacityLimitedRespondentIds,
      targetCapacityShortfallMinutes,
      optimizerStatus,
    }),
  };
}

export async function runGlobalAllocation(
  input: PureAllocationInput,
): Promise<GlobalAllocationAttempt> {
  try {
    if (input.allowExtremeNoAvailabilityAfpStacking) {
      return {
        ok: false,
        reason:
          "extreme_placeholder_stacking_not_supported_by_global_optimizer",
      };
    }

    const shifts = normalizeShifts(input.shifts);
    const respondents = [...input.respondents].sort(
      (a, b) => a.name.localeCompare(b.name) || a.id - b.id,
    );
    if (shifts.length === 0 || respondents.length === 0) {
      return { ok: true, output: emptyOutput(respondents, shifts) };
    }

    const respondentById = new Map(
      respondents.map((respondent) => [respondent.id, respondent]),
    );
    const availabilityCountByShiftId = new Map<number, number>();
    for (const shift of shifts) {
      availabilityCountByShiftId.set(
        shift.id,
        respondents.filter((respondent) =>
          respondent.availableShiftIds.has(shift.id),
        ).length,
      );
    }

    const manualByShiftId = new Map<number, number>();
    for (const manual of input.manualAssignments ?? []) {
      if (
        !manualByShiftId.has(manual.shiftId) &&
        respondentById.has(manual.respondentId)
      ) {
        manualByShiftId.set(manual.shiftId, manual.respondentId);
      }
    }

    const candidates: AssignmentCandidate[] = [];
    for (const shift of shifts) {
      const manualRespondentId = manualByShiftId.get(shift.id);
      if (manualRespondentId !== undefined) {
        const respondent = respondentById.get(manualRespondentId);
        if (respondent) {
          candidates.push({
            variableKey: `x:${respondent.id}:${shift.id}`,
            respondent,
            shift,
            isManual: true,
            isNoAvailabilityPlaceholder: false,
          });
        }
        continue;
      }

      const availabilityCount = availabilityCountByShiftId.get(shift.id) ?? 0;
      if (availabilityCount > 0) {
        for (const respondent of respondents) {
          if (!respondent.availableShiftIds.has(shift.id)) continue;
          candidates.push({
            variableKey: `x:${respondent.id}:${shift.id}`,
            respondent,
            shift,
            isManual: false,
            isNoAvailabilityPlaceholder: false,
          });
        }
        continue;
      }

      if (!input.allowNoAvailabilityAfpPlaceholders) continue;
      for (const respondent of respondents) {
        if (
          respondent.category !== "AFP" ||
          !respondent.allowNoAvailabilityFallback
        ) {
          continue;
        }
        candidates.push({
          variableKey: `x:${respondent.id}:${shift.id}`,
          respondent,
          shift,
          isManual: false,
          isNoAvailabilityPlaceholder: true,
        });
      }
    }

    if (candidates.length === 0) {
      return { ok: true, output: emptyOutput(respondents, shifts) };
    }

    const builder: ModelBuilder = {
      constraints: new Map(),
      variables: new Map(),
      binaries: new Set(),
    };
    const boundedStages: string[] = [];
    for (const candidate of candidates) {
      builder.binaries.add(candidate.variableKey);
      builder.constraints.set(`shift:${candidate.shift.id}`, { max: 1 });
      addCoefficient(
        builder,
        candidate.variableKey,
        `shift:${candidate.shift.id}`,
        1,
      );
      addCoefficient(builder, candidate.variableKey, "coverage", 1);
      addCoefficient(
        builder,
        candidate.variableKey,
        "staffedMinutes",
        hoursToMinutes(candidate.shift.durationHours),
      );
      if (candidate.isManual) {
        builder.constraints.set(`manual:${candidate.shift.id}`, { equal: 1 });
        addCoefficient(
          builder,
          candidate.variableKey,
          `manual:${candidate.shift.id}`,
          1,
        );
      }
    }

    const backToBackVariableKeys = addSameDayConstraints(builder, candidates);

    let hasCapOverflowVariables = false;
    let hasAfpShortfallVariables = false;
    const afpTargetMinutesByRespondentId = new Map<number, number>();
    const afpMaxShortfallVariableKey = "afp:maxShortfall";
    for (const respondent of respondents.filter(
      (candidateRespondent) => candidateRespondent.hasAfpCap,
    )) {
      const capConstraintKey = `afpCap:${respondent.id}`;
      const manualCandidates = candidates.filter(
        (candidate) =>
          candidate.respondent.id === respondent.id &&
          candidate.isManual &&
          !candidate.isNoAvailabilityPlaceholder,
      );
      const normalCandidates = candidates.filter(
        (candidate) =>
          candidate.respondent.id === respondent.id &&
          !candidate.isManual &&
          !candidate.isNoAvailabilityPlaceholder,
      );
      const capMinutes = Math.max(0, hoursToMinutes(respondent.afpHoursCap));
      const manualMinutes = manualCandidates.reduce(
        (sum, candidate) => sum + hoursToMinutes(candidate.shift.durationHours),
        0,
      );
      const feasibleCapacityMinutes = maxFeasibleCapacityMinutes([
        ...manualCandidates,
        ...normalCandidates,
      ]);
      const targetMinutes = Math.min(capMinutes, feasibleCapacityMinutes);
      afpTargetMinutesByRespondentId.set(respondent.id, targetMinutes);

      if (normalCandidates.length > 0) {
        builder.constraints.set(capConstraintKey, {
          max: Math.max(0, capMinutes - Math.min(capMinutes, manualMinutes)),
        });
        for (const candidate of normalCandidates) {
          addCoefficient(
            builder,
            candidate.variableKey,
            capConstraintKey,
            hoursToMinutes(candidate.shift.durationHours),
          );
        }
        if (input.allowAfpOverCapForAvailableShifts) {
          const overageVariableKey = `capOverage:${respondent.id}`;
          addCoefficient(builder, overageVariableKey, capConstraintKey, -1);
          addCoefficient(builder, overageVariableKey, "capOverflow", 1);
          hasCapOverflowVariables = true;
        }
      }

      if (targetMinutes > 0) {
        const shortfallVariableKey = `afp:shortfall:${respondent.id}`;
        const shortfallConstraintKey = `afpShortfall:${respondent.id}`;
        const maxShortfallConstraintKey = `afpMaxShortfall:${respondent.id}`;
        builder.constraints.set(shortfallConstraintKey, { min: targetMinutes });
        builder.constraints.set(maxShortfallConstraintKey, { max: 0 });
        for (const candidate of [...manualCandidates, ...normalCandidates]) {
          addCoefficient(
            builder,
            candidate.variableKey,
            shortfallConstraintKey,
            hoursToMinutes(candidate.shift.durationHours),
          );
        }
        addCoefficient(
          builder,
          shortfallVariableKey,
          shortfallConstraintKey,
          1,
        );
        addCoefficient(
          builder,
          shortfallVariableKey,
          maxShortfallConstraintKey,
          1,
        );
        addCoefficient(
          builder,
          afpMaxShortfallVariableKey,
          maxShortfallConstraintKey,
          -1,
        );
        addCoefficient(builder, shortfallVariableKey, "afpTotalShortfall", 1);
        hasAfpShortfallVariables = true;
      }
    }
    if (hasAfpShortfallVariables) {
      addCoefficient(builder, afpMaxShortfallVariableKey, "afpMaxShortfall", 1);
    }

    const coverageSolution = await solveStage(builder, "coverage", "maximize");
    const bestCoverageResult = optimalResult(coverageSolution);
    if (bestCoverageResult === null) {
      return {
        ok: false,
        reason: `coverage_${coverageSolution.status}`,
      };
    }
    const bestCoverage = Math.round(bestCoverageResult);
    builder.constraints.set("coverage", { equal: bestCoverage });

    const staffedMinutesSolution = await solveStage(
      builder,
      "staffedMinutes",
      "maximize",
    );
    const bestStaffedMinutesResult = optimalResult(staffedMinutesSolution);
    if (bestStaffedMinutesResult === null) {
      return {
        ok: false,
        reason: `staffed_minutes_${staffedMinutesSolution.status}`,
      };
    }
    const bestStaffedMinutes = Math.round(bestStaffedMinutesResult);
    builder.constraints.set("staffedMinutes", { equal: bestStaffedMinutes });

    let prioritySolution = staffedMinutesSolution;
    if (hasCapOverflowVariables) {
      const capOverflowSolution = await solveStage(
        builder,
        "capOverflow",
        "minimize",
      );
      const bestCapOverflow = optimalResult(capOverflowSolution);
      if (bestCapOverflow === null) {
        return {
          ok: false,
          reason: `cap_overflow_${capOverflowSolution.status}`,
        };
      }
      builder.constraints.set("capOverflow", {
        max: Math.max(0, bestCapOverflow) + 1e-6,
      });
      prioritySolution = capOverflowSolution;
    }

    if (hasAfpShortfallVariables) {
      const maxShortfallSolution = await solveStage(
        builder,
        "afpMaxShortfall",
        "minimize",
      );
      const bestMaxShortfall = feasibleResult(maxShortfallSolution);
      if (bestMaxShortfall === null) {
        return {
          ok: false,
          reason: `afp_max_shortfall_${maxShortfallSolution.status}`,
        };
      }
      if (maxShortfallSolution.status !== "optimal") {
        boundedStages.push(`afp_max_shortfall_${maxShortfallSolution.status}`);
      }
      builder.constraints.set("afpMaxShortfall", {
        max: Math.max(0, bestMaxShortfall) + 1e-6,
      });
      prioritySolution = maxShortfallSolution;

      const totalShortfallSolution = await solveStage(
        builder,
        "afpTotalShortfall",
        "minimize",
      );
      const bestTotalShortfall = feasibleResult(totalShortfallSolution);
      if (bestTotalShortfall === null) {
        return {
          ok: false,
          reason: `afp_total_shortfall_${totalShortfallSolution.status}`,
        };
      }
      if (totalShortfallSolution.status !== "optimal") {
        boundedStages.push(
          `afp_total_shortfall_${totalShortfallSolution.status}`,
        );
      }
      builder.constraints.set("afpTotalShortfall", {
        max: Math.max(0, bestTotalShortfall) + 1e-6,
      });
      prioritySolution = totalShortfallSolution;
    }

    const prioritySelectedKeys = selectedVariableKeys(prioritySolution);
    const actualCappedAfpMinutes = candidates.reduce(
      (sum, candidate) =>
        candidate.respondent.hasAfpCap &&
        prioritySelectedKeys.has(candidate.variableKey)
          ? sum + hoursToMinutes(candidate.shift.durationHours)
          : sum,
      0,
    );
    const equalPoolRespondents = respondents.filter(
      (respondent) => !respondent.hasAfpCap,
    );
    const targetResult = solveNonAfpPenaltyTargets(
      equalPoolRespondents.map((respondent) => ({
        respondentId: respondent.id,
        penaltyMinutes: hoursToMinutes(
          respondent.hasPenalty ? respondent.penaltyHours : 0,
        ),
        capacityMinutes: maxFeasibleCapacityMinutes(
          candidates.filter(
            (candidate) =>
              candidate.respondent.id === respondent.id &&
              !candidate.isNoAvailabilityPlaceholder,
          ),
        ),
        minimumMinutes: candidates
          .filter(
            (candidate) =>
              candidate.respondent.id === respondent.id && candidate.isManual,
          )
          .reduce(
            (minutes, candidate) =>
              minutes + hoursToMinutes(candidate.shift.durationHours),
            0,
          ),
      })),
      Math.max(0, bestStaffedMinutes - actualCappedAfpMinutes),
    );
    const targetMinutesByRespondentId = new Map<number, number>(
      targetResult.targets.map((target) => [
        target.respondentId,
        target.targetMinutes,
      ]),
    );
    for (const respondent of respondents.filter(
      (candidateRespondent) => candidateRespondent.hasAfpCap,
    )) {
      targetMinutesByRespondentId.set(
        respondent.id,
        afpTargetMinutesByRespondentId.get(respondent.id) ?? 0,
      );
    }

    let finalSolution = prioritySolution;
    let hasStrikeOverageVariables = false;
    const capacityLimitedRespondentIds = new Set(
      targetResult.targets
        .filter((target) => target.capacityLimited)
        .map((target) => target.respondentId),
    );
    const availabilityLimitedRespondentIds = new Set(
      targetResult.targets
        .filter((target) => target.availabilityLimited)
        .map((target) => target.respondentId),
    );
    const comparablePoolRespondents = equalPoolRespondents.filter(
      (respondent) =>
        (!respondent.hasPenalty || respondent.penaltyHours <= 0) &&
        !capacityLimitedRespondentIds.has(respondent.id),
    );
    const availabilityLimitedPoolRespondents = equalPoolRespondents.filter(
      (respondent) =>
        (!respondent.hasPenalty || respondent.penaltyHours <= 0) &&
        availabilityLimitedRespondentIds.has(respondent.id) &&
        (targetMinutesByRespondentId.get(respondent.id) ?? 0) > 0,
    );
    const absoluteDeviationVariableKeyByRespondentId = new Map<
      number,
      string
    >();
    const availabilityLimitedMaxShortfallRatioVariableKey =
      "limited:maxShortfallRatio";
    const comparableMaxDeviationVariableKey = "fairness:comparableMaxDeviation";
    const comparableMaxShortfallVariableKey = "fairness:comparableMaxShortfall";
    const comparableMaxOverageVariableKey = "fairness:comparableMaxOverage";
    const comparableRangeVariableKey = "fairness:comparableRange";
    let hasComparableFairnessVariables = false;
    const hasComparableRangeVariables = comparablePoolRespondents.length > 1;
    if (equalPoolRespondents.length > 0) {
      const maxDeviationVariableKey = "fairness:maxDeviation";
      addCoefficient(builder, maxDeviationVariableKey, "maxDeviation", 1);
      for (const respondent of equalPoolRespondents) {
        const targetMinutes =
          targetMinutesByRespondentId.get(respondent.id) ?? 0;
        const upperConstraintKey = `targetUpper:${respondent.id}`;
        const lowerConstraintKey = `targetLower:${respondent.id}`;
        const absoluteUpperConstraintKey = `absoluteUpper:${respondent.id}`;
        const absoluteLowerConstraintKey = `absoluteLower:${respondent.id}`;
        const absoluteDeviationVariableKey = `fairness:absolute:${respondent.id}`;
        absoluteDeviationVariableKeyByRespondentId.set(
          respondent.id,
          absoluteDeviationVariableKey,
        );
        builder.constraints.set(upperConstraintKey, { max: targetMinutes });
        builder.constraints.set(lowerConstraintKey, { min: targetMinutes });
        builder.constraints.set(absoluteUpperConstraintKey, {
          max: targetMinutes,
        });
        builder.constraints.set(absoluteLowerConstraintKey, {
          min: targetMinutes,
        });
        for (const candidate of candidates.filter(
          (entry) => entry.respondent.id === respondent.id,
        )) {
          const durationMinutes = hoursToMinutes(candidate.shift.durationHours);
          addCoefficient(
            builder,
            candidate.variableKey,
            upperConstraintKey,
            durationMinutes,
          );
          addCoefficient(
            builder,
            candidate.variableKey,
            lowerConstraintKey,
            durationMinutes,
          );
          addCoefficient(
            builder,
            candidate.variableKey,
            absoluteUpperConstraintKey,
            durationMinutes,
          );
          addCoefficient(
            builder,
            candidate.variableKey,
            absoluteLowerConstraintKey,
            durationMinutes,
          );
        }
        addCoefficient(
          builder,
          maxDeviationVariableKey,
          upperConstraintKey,
          -1,
        );
        addCoefficient(builder, maxDeviationVariableKey, lowerConstraintKey, 1);
        addCoefficient(
          builder,
          absoluteDeviationVariableKey,
          absoluteUpperConstraintKey,
          -1,
        );
        addCoefficient(
          builder,
          absoluteDeviationVariableKey,
          absoluteLowerConstraintKey,
          1,
        );
        addCoefficient(
          builder,
          absoluteDeviationVariableKey,
          "totalDeviation",
          1,
        );
      }

      for (const respondent of comparablePoolRespondents) {
        const comparableConstraintKey = `comparableMax:${respondent.id}`;
        const comparableShortfallConstraintKey = `comparableShortfall:${respondent.id}`;
        const comparableOverageConstraintKey = `comparableOverage:${respondent.id}`;
        const targetMinutes =
          targetMinutesByRespondentId.get(respondent.id) ?? 0;
        builder.constraints.set(comparableConstraintKey, { max: 0 });
        builder.constraints.set(comparableShortfallConstraintKey, {
          min: targetMinutes,
        });
        builder.constraints.set(comparableOverageConstraintKey, {
          max: targetMinutes,
        });
        addCoefficient(
          builder,
          absoluteDeviationVariableKeyByRespondentId.get(respondent.id)!,
          comparableConstraintKey,
          1,
        );
        addCoefficient(
          builder,
          absoluteDeviationVariableKeyByRespondentId.get(respondent.id)!,
          "comparableTotalDeviation",
          1,
        );
        addCoefficient(
          builder,
          comparableMaxDeviationVariableKey,
          comparableConstraintKey,
          -1,
        );
        for (const candidate of candidates.filter(
          (entry) => entry.respondent.id === respondent.id,
        )) {
          const durationMinutes = hoursToMinutes(candidate.shift.durationHours);
          addCoefficient(
            builder,
            candidate.variableKey,
            comparableShortfallConstraintKey,
            durationMinutes,
          );
          addCoefficient(
            builder,
            candidate.variableKey,
            comparableOverageConstraintKey,
            durationMinutes,
          );
        }
        addCoefficient(
          builder,
          comparableMaxShortfallVariableKey,
          comparableShortfallConstraintKey,
          1,
        );
        addCoefficient(
          builder,
          comparableMaxOverageVariableKey,
          comparableOverageConstraintKey,
          -1,
        );
        hasComparableFairnessVariables = true;
      }
      if (hasComparableFairnessVariables) {
        addCoefficient(
          builder,
          comparableMaxDeviationVariableKey,
          "comparableMaxDeviation",
          1,
        );
        addCoefficient(
          builder,
          comparableMaxShortfallVariableKey,
          "comparableMaxShortfall",
          1,
        );
        addCoefficient(
          builder,
          comparableMaxOverageVariableKey,
          "comparableMaxOverage",
          1,
        );
      }
      if (hasComparableRangeVariables) {
        // Target deviations can be indifferent to transfers when every
        // comparable respondent is below an elevated redistributed target.
        // These ordered pair constraints make the next objective the actual
        // max-minus-min assigned-hour range within the comparable pool.
        for (const higher of comparablePoolRespondents) {
          for (const lower of comparablePoolRespondents) {
            if (higher.id === lower.id) continue;
            const rangeConstraintKey = `comparableRange:${higher.id}:${lower.id}`;
            builder.constraints.set(rangeConstraintKey, { max: 0 });
            for (const candidate of candidates.filter(
              (entry) => entry.respondent.id === higher.id,
            )) {
              addCoefficient(
                builder,
                candidate.variableKey,
                rangeConstraintKey,
                hoursToMinutes(candidate.shift.durationHours),
              );
            }
            for (const candidate of candidates.filter(
              (entry) => entry.respondent.id === lower.id,
            )) {
              addCoefficient(
                builder,
                candidate.variableKey,
                rangeConstraintKey,
                -hoursToMinutes(candidate.shift.durationHours),
              );
            }
            addCoefficient(
              builder,
              comparableRangeVariableKey,
              rangeConstraintKey,
              -1,
            );
          }
        }
        addCoefficient(
          builder,
          comparableRangeVariableKey,
          "comparableRange",
          1,
        );
      }

      const maxStrikeOverageVariableKey = "strike:maxOverage";
      for (const penalizedRespondent of equalPoolRespondents.filter(
        (respondent) => respondent.hasPenalty && respondent.penaltyHours > 0,
      )) {
        const penalizedTargetMinutes =
          targetMinutesByRespondentId.get(penalizedRespondent.id) ?? 0;
        const overageVariableKey = `strike:overage:${penalizedRespondent.id}`;
        const overageConstraintKey = `strikeOverage:${penalizedRespondent.id}`;
        const maxOverageConstraintKey = `strikeMaxOverage:${penalizedRespondent.id}`;
        builder.constraints.set(overageConstraintKey, {
          max: penalizedTargetMinutes,
        });
        builder.constraints.set(maxOverageConstraintKey, { max: 0 });
        for (const candidate of candidates.filter(
          (entry) => entry.respondent.id === penalizedRespondent.id,
        )) {
          addCoefficient(
            builder,
            candidate.variableKey,
            overageConstraintKey,
            hoursToMinutes(candidate.shift.durationHours),
          );
        }
        addCoefficient(builder, overageVariableKey, overageConstraintKey, -1);
        addCoefficient(builder, overageVariableKey, maxOverageConstraintKey, 1);
        addCoefficient(
          builder,
          maxStrikeOverageVariableKey,
          maxOverageConstraintKey,
          -1,
        );
        addCoefficient(builder, overageVariableKey, "strikeTotalOverage", 1);
        hasStrikeOverageVariables = true;
      }
      if (hasStrikeOverageVariables) {
        addCoefficient(
          builder,
          maxStrikeOverageVariableKey,
          "strikeMaxOverage",
          1,
        );
      }

      // A pre-strike availability-limited respondent's target is their feasible signup
      // capacity. Reward reaching it before balancing the ordinary pool, but
      // model only shortfall: an absolute-deviation term could incorrectly
      // punish a legal over-allocation if a future capacity estimate is
      // conservative or manual assignments push the total past the target.
      // Normalizing each shortfall by its target gives the scarcest signup the
      // strongest protection: missing one shift is a much larger fraction of
      // a 12-hour target than of a 36-hour target.
      for (const respondent of availabilityLimitedPoolRespondents) {
        const targetMinutes =
          targetMinutesByRespondentId.get(respondent.id) ?? 0;
        const shortfallVariableKey = `limited:shortfall:${respondent.id}`;
        const shortfallConstraintKey = `limitedShortfall:${respondent.id}`;
        const maxShortfallConstraintKey = `limitedMaxShortfall:${respondent.id}`;
        builder.constraints.set(shortfallConstraintKey, {
          min: targetMinutes,
        });
        builder.constraints.set(maxShortfallConstraintKey, { max: 0 });
        for (const candidate of candidates.filter(
          (entry) => entry.respondent.id === respondent.id,
        )) {
          addCoefficient(
            builder,
            candidate.variableKey,
            shortfallConstraintKey,
            hoursToMinutes(candidate.shift.durationHours),
          );
        }
        addCoefficient(
          builder,
          shortfallVariableKey,
          shortfallConstraintKey,
          1,
        );
        addCoefficient(
          builder,
          shortfallVariableKey,
          maxShortfallConstraintKey,
          1 / targetMinutes,
        );
        addCoefficient(
          builder,
          availabilityLimitedMaxShortfallRatioVariableKey,
          maxShortfallConstraintKey,
          -1,
        );
        addCoefficient(
          builder,
          shortfallVariableKey,
          "limitedTotalShortfallRatio",
          1 / targetMinutes,
        );
        addCoefficient(
          builder,
          shortfallVariableKey,
          "limitedTotalShortfallMinutes",
          1,
        );
      }
      if (availabilityLimitedPoolRespondents.length > 0) {
        addCoefficient(
          builder,
          availabilityLimitedMaxShortfallRatioVariableKey,
          "limitedMaxShortfallRatio",
          1,
        );
      }
    }

    if (equalPoolRespondents.length > 0) {
      const bestProvenMaxDeviationSolution = await solveStage(
        builder,
        "maxDeviation",
        "minimize",
      );
      const bestProvenMaxDeviation = optimalResult(
        bestProvenMaxDeviationSolution,
      );
      if (bestProvenMaxDeviation === null) {
        return {
          ok: false,
          reason: `fairness_envelope_${bestProvenMaxDeviationSolution.status}`,
        };
      }
      builder.constraints.set("maxDeviation", {
        max:
          Math.max(
            0,
            bestProvenMaxDeviation,
            hoursToMinutes(GENERAL_FAIRNESS_BAND_HOURS),
          ) + 1e-6,
      });
      finalSolution = bestProvenMaxDeviationSolution;
    }

    // Protect the strike reduction inside the best attainable all-General
    // fairness envelope. This prevents either policy from being satisfied by
    // making an ordinary respondent arbitrarily worse.
    if (hasStrikeOverageVariables) {
      const strikeMaxOverageSolution = await solveStage(
        builder,
        "strikeMaxOverage",
        "minimize",
      );
      const bestStrikeMaxOverage = optimalResult(strikeMaxOverageSolution);
      if (bestStrikeMaxOverage === null) {
        return {
          ok: false,
          reason: `strike_max_overage_${strikeMaxOverageSolution.status}`,
        };
      }
      builder.constraints.set("strikeMaxOverage", {
        max: Math.max(0, bestStrikeMaxOverage) + 1e-6,
      });
      finalSolution = strikeMaxOverageSolution;

      const strikeTotalOverageSolution = await solveStage(
        builder,
        "strikeTotalOverage",
        "minimize",
      );
      const bestStrikeTotalOverage = optimalResult(strikeTotalOverageSolution);
      if (bestStrikeTotalOverage === null) {
        return {
          ok: false,
          reason: `strike_total_overage_${strikeTotalOverageSolution.status}`,
        };
      }
      builder.constraints.set("strikeTotalOverage", {
        max: Math.max(0, bestStrikeTotalOverage) + 1e-6,
      });
      finalSolution = strikeTotalOverageSolution;
    }

    if (availabilityLimitedPoolRespondents.length > 0) {
      const limitedMaxShortfallRatioSolution = await solveStage(
        builder,
        "limitedMaxShortfallRatio",
        "minimize",
      );
      const bestLimitedMaxShortfallRatio = optimalResult(
        limitedMaxShortfallRatioSolution,
      );
      if (bestLimitedMaxShortfallRatio === null) {
        return {
          ok: false,
          reason: `limited_max_shortfall_ratio_${limitedMaxShortfallRatioSolution.status}`,
        };
      }
      builder.constraints.set("limitedMaxShortfallRatio", {
        max: Math.max(0, bestLimitedMaxShortfallRatio) + 1e-6,
      });
      finalSolution = limitedMaxShortfallRatioSolution;

      const limitedTotalShortfallRatioSolution = await solveStage(
        builder,
        "limitedTotalShortfallRatio",
        "minimize",
      );
      const bestLimitedTotalShortfallRatio = optimalResult(
        limitedTotalShortfallRatioSolution,
      );
      if (bestLimitedTotalShortfallRatio === null) {
        return {
          ok: false,
          reason: `limited_total_shortfall_ratio_${limitedTotalShortfallRatioSolution.status}`,
        };
      }
      builder.constraints.set("limitedTotalShortfallRatio", {
        max: Math.max(0, bestLimitedTotalShortfallRatio) + 1e-6,
      });
      finalSolution = limitedTotalShortfallRatioSolution;

      const limitedTotalShortfallMinutesSolution = await solveStage(
        builder,
        "limitedTotalShortfallMinutes",
        "minimize",
      );
      const bestLimitedTotalShortfallMinutes = optimalResult(
        limitedTotalShortfallMinutesSolution,
      );
      if (bestLimitedTotalShortfallMinutes === null) {
        return {
          ok: false,
          reason: `limited_total_shortfall_minutes_${limitedTotalShortfallMinutesSolution.status}`,
        };
      }
      builder.constraints.set("limitedTotalShortfallMinutes", {
        max: Math.max(0, bestLimitedTotalShortfallMinutes) + 1e-6,
      });
      finalSolution = limitedTotalShortfallMinutesSolution;
    }

    if (hasComparableFairnessVariables) {
      const comparableEnvelopeSolution = await solveStage(
        builder,
        "comparableMaxDeviation",
        "minimize",
      );
      const bestComparableMaxDeviation = optimalResult(
        comparableEnvelopeSolution,
      );
      if (bestComparableMaxDeviation === null) {
        return {
          ok: false,
          reason: `comparable_fairness_envelope_${comparableEnvelopeSolution.status}`,
        };
      }
      builder.constraints.set("comparableMaxDeviation", {
        max:
          Math.max(
            0,
            bestComparableMaxDeviation,
            hoursToMinutes(GENERAL_FAIRNESS_BAND_HOURS),
          ) + 1e-6,
      });
      finalSolution = comparableEnvelopeSolution;

      // A forced high outlier can determine the absolute envelope. Minimize
      // ordinary-person under-allocation and over-allocation separately so
      // that outlier cannot license a second, opposite-direction outlier.
      const comparableShortfallSolution = await solveStage(
        builder,
        "comparableMaxShortfall",
        "minimize",
      );
      const bestComparableShortfall = optimalResult(
        comparableShortfallSolution,
      );
      if (bestComparableShortfall === null) {
        return {
          ok: false,
          reason: `comparable_shortfall_${comparableShortfallSolution.status}`,
        };
      }
      builder.constraints.set("comparableMaxShortfall", {
        max:
          Math.max(
            0,
            bestComparableShortfall,
            hoursToMinutes(GENERAL_FAIRNESS_BAND_HOURS),
          ) + 1e-6,
      });
      finalSolution = comparableShortfallSolution;

      const comparableOverageSolution = await solveStage(
        builder,
        "comparableMaxOverage",
        "minimize",
      );
      const bestComparableOverage = optimalResult(comparableOverageSolution);
      if (bestComparableOverage === null) {
        return {
          ok: false,
          reason: `comparable_overage_${comparableOverageSolution.status}`,
        };
      }
      builder.constraints.set("comparableMaxOverage", {
        max:
          Math.max(
            0,
            bestComparableOverage,
            hoursToMinutes(GENERAL_FAIRNESS_BAND_HOURS),
          ) + 1e-6,
      });
      finalSolution = comparableOverageSolution;
    }

    if (hasComparableRangeVariables) {
      const comparableRangeSolution = await solveStage(
        builder,
        "comparableRange",
        "minimize",
      );
      const bestComparableRange = optimalResult(comparableRangeSolution);
      if (bestComparableRange === null) {
        return {
          ok: false,
          reason: `comparable_range_${comparableRangeSolution.status}`,
        };
      }
      builder.constraints.set("comparableRange", {
        max: Math.max(0, bestComparableRange) + 1e-6,
      });
      finalSolution = comparableRangeSolution;
    }

    if (hasComparableFairnessVariables) {
      const comparableTotalDeviationSolution = await solveStage(
        builder,
        "comparableTotalDeviation",
        "minimize",
      );
      const bestComparableTotalDeviation = feasibleResult(
        comparableTotalDeviationSolution,
      );
      if (bestComparableTotalDeviation !== null) {
        if (comparableTotalDeviationSolution.status !== "optimal") {
          boundedStages.push(
            `comparable_total_deviation_${comparableTotalDeviationSolution.status}`,
          );
        }
        builder.constraints.set("comparableTotalDeviation", {
          max: Math.max(0, bestComparableTotalDeviation) + 1e-6,
        });
        finalSolution = comparableTotalDeviationSolution;
      } else {
        boundedStages.push(
          `comparable_total_deviation_${comparableTotalDeviationSolution.status}_no_incumbent`,
        );
      }
    }

    if (backToBackVariableKeys.length > 0) {
      const backToBackSolution = await solveStage(
        builder,
        "backToBack",
        "minimize",
      );
      const bestBackToBack = feasibleResult(backToBackSolution);
      if (bestBackToBack === null) {
        return {
          ok: false,
          reason: `back_to_back_${backToBackSolution.status}`,
        };
      }
      if (backToBackSolution.status !== "optimal") {
        boundedStages.push(`back_to_back_${backToBackSolution.status}`);
      }
      builder.constraints.set("backToBack", {
        max: Math.max(0, bestBackToBack) + 1e-6,
      });
      finalSolution = backToBackSolution;
    }

    if (equalPoolRespondents.length > 0) {
      const totalDeviationSolution = await solveStage(
        builder,
        "totalDeviation",
        "minimize",
      );
      const bestTotalDeviation = feasibleResult(totalDeviationSolution);
      if (bestTotalDeviation !== null) {
        if (totalDeviationSolution.status !== "optimal") {
          boundedStages.push(
            `total_deviation_${totalDeviationSolution.status}`,
          );
        }
        builder.constraints.set("totalDeviation", {
          max: Math.max(0, bestTotalDeviation) + 1e-6,
        });
        finalSolution = totalDeviationSolution;
      } else {
        boundedStages.push(
          `total_deviation_${totalDeviationSolution.status}_no_incumbent`,
        );
      }
    }

    const selectedKeys = selectedVariableKeys(finalSolution);
    const selectedCandidates = candidates.filter((candidate) =>
      selectedKeys.has(candidate.variableKey),
    );
    if (selectedCandidates.length !== bestCoverage) {
      return {
        ok: false,
        reason: "solution_coverage_mismatch",
      };
    }
    const selectedShiftIds = new Set(
      selectedCandidates.map((candidate) => candidate.shift.id),
    );
    if (selectedShiftIds.size !== selectedCandidates.length) {
      return {
        ok: false,
        reason: "solution_duplicate_shift",
      };
    }

    return {
      ok: true,
      output: buildOutput({
        respondents,
        shifts,
        selectedCandidates,
        targetMinutesByRespondentId,
        capacityLimitedRespondentIds: new Set(
          targetResult.targets
            .filter((target) => target.capacityLimited)
            .map((target) => target.respondentId),
        ),
        targetCapacityShortfallMinutes: targetResult.capacityShortfallMinutes,
        allowAfpOverCapForAvailableShifts:
          input.allowAfpOverCapForAvailableShifts ?? false,
        optimizerStatus:
          boundedStages.length === 0
            ? "optimal"
            : `bounded:${boundedStages.join(",")}`,
      }),
    };
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof Error
          ? `optimizer_error:${error.message}`
          : "optimizer_error:unknown",
    };
  }
}
