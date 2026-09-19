import {
  type AssignmentSource,
  NO_AVAILABILITY_AFP_PLACEHOLDER_SOURCE,
  canAssignShiftToRespondent,
  deriveShiftSlotIndexes,
  hoursToMinutes,
  isBackToBack,
  maxFeasibleShiftCapacityMinutes,
  minutesToHours,
  sameDayAllocationTier,
  solveNonAfpPenaltyTargets,
  stableShiftKey,
} from "./allocationCore.js";
import { safeDisplayName } from "./inputValidation.js";
import { runGlobalAllocation } from "./allocationOptimizer.js";

export interface AllocationOptions {
  surveyId: number;
  afpRespondentIds: number[];
  afpUnclaimedShiftRespondentIds?: number[];
  allowNoAvailabilityAfpPlaceholders?: boolean;
  noAvailabilityFallbackAfpIds?: number[];
  includedRespondentIds?: number[];
  allowAfpOverCapForAvailableShifts?: boolean;
  allowExtremeNoAvailabilityAfpStacking?: boolean;
  existingManualAssignments?: Array<{ respondentId: number; shiftId: number }>;
}

export interface AllocationPlan {
  respondentId: number;
  name: string;
  category: string;
  shiftIds: number[];
  totalHours: number;
  isManuallyAdjusted: boolean;
  penaltyNote: string | null;
}

export interface AllocationAssignment {
  respondentId: number;
  shiftId: number;
  source: AssignmentSource;
  explanationCodes: string[];
}

export interface AllocationShiftInput {
  id: number;
  date: string;
  dayType: string;
  startTime: string;
  endTime: string;
  durationHours: number;
  label: string;
}

export interface AllocationRespondentInput {
  id: number;
  name: string;
  category: "AFP" | "General";
  availableShiftIds: Set<number>;
  hasPenalty: boolean;
  penaltyHours: number;
  hasAfpCap: boolean;
  afpHoursCap: number;
  allowNoAvailabilityFallback: boolean;
}

interface ShiftInfo extends AllocationShiftInput {
  slotIndex: number;
  stableShiftKey: string;
}

interface RespondentInfo extends AllocationRespondentInput {
  availableCapacityMinutes: number;
}

interface Candidate {
  respondent: RespondentInfo;
  shift: ShiftInfo;
  source: AssignmentSource;
  dayTier: 0 | 1;
  currentMinutes: number;
  afterMinutes: number;
  targetMinutes: number;
  capacityMinutes: number;
  sourceRank: number;
}

export interface PureAllocationInput {
  shifts: AllocationShiftInput[];
  respondents: AllocationRespondentInput[];
  allowAfpOverCapForAvailableShifts?: boolean;
  allowNoAvailabilityAfpPlaceholders?: boolean;
  allowExtremeNoAvailabilityAfpStacking?: boolean;
  manualAssignments?: Array<{ respondentId: number; shiftId: number }>;
}

export interface PureAllocationOutput {
  plans: AllocationPlan[];
  assignments: AllocationAssignment[];
  averageHours: number;
  stdDev: number;
  unallocatedShiftIds: number[];
  fairnessDiagnostics: FairnessDiagnostics;
}

export interface FairnessDiagnostics {
  nonPenalizedGeneralMeanHours: number;
  nonPenalizedGeneralMedianHours: number;
  nonPenalizedGeneralMinHours: number;
  nonPenalizedGeneralMaxHours: number;
  nonPenalizedGeneralRangeHours: number;
  nonPenalizedGeneralStdDevHours: number;
  maxDeviationFromMeanHours: number;
  maxDeviationFromTargetHours: number;
  sumSquaredDeviationFromTargetHours: number;
  targetStdDevHours: number;
  warningStdDevHours: number;
  repairAttempted: boolean;
  successfulRepairMoves: number;
  assignedShiftCountBeforeRepair: number;
  assignedShiftCountAfterRepair: number;
  highStdDevReasonCodes: string[];
  optimizationMethod?: "global_milp" | "greedy_fallback";
  optimizerStatus?: string;
  backToBackPairDays?: number;
  optimalCoverageProven?: boolean;
}

function stdDev(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / values.length;
  return Math.sqrt(variance);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function calcMinutes(shiftIds: number[], shiftMap: Map<number, ShiftInfo>): number {
  return shiftIds.reduce((sum, id) => sum + hoursToMinutes(shiftMap.get(id)?.durationHours ?? 0), 0);
}

function normalizeShifts(shifts: AllocationShiftInput[]): ShiftInfo[] {
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

function assignmentSourceRank(source: AssignmentSource): number {
  switch (source) {
    case "engine_normal":
      return 0;
    case "engine_back_to_back_emergency":
      return 1;
    case "engine_afp_cap_overflow_available":
      return 2;
    case "admin_no_availability_afp_placeholder":
      return 3;
    case "engine_no_availability_afp_fallback":
      return 4;
    case "manual":
      return 5;
    case "blank":
      return 6;
  }
}

function compareCandidates(a: Candidate, b: Candidate): number {
  if (a.sourceRank !== b.sourceRank) return a.sourceRank - b.sourceRank;
  if (a.dayTier !== b.dayTier) return a.dayTier - b.dayTier;

  const aDeficit = a.targetMinutes - a.currentMinutes;
  const bDeficit = b.targetMinutes - b.currentMinutes;
  if (Math.abs(aDeficit - bDeficit) > 0.5) return bDeficit - aDeficit;

  const aOverage = Math.max(0, a.afterMinutes - a.targetMinutes);
  const bOverage = Math.max(0, b.afterMinutes - b.targetMinutes);
  if (Math.abs(aOverage - bOverage) > 0.5) return aOverage - bOverage;

  if (a.currentMinutes !== b.currentMinutes) return a.currentMinutes - b.currentMinutes;
  if (a.capacityMinutes !== b.capacityMinutes) return a.capacityMinutes - b.capacityMinutes;
  return a.respondent.name.localeCompare(b.respondent.name) || a.respondent.id - b.respondent.id;
}

function runGreedyAllocation(input: PureAllocationInput): PureAllocationOutput {
  const shifts = normalizeShifts(input.shifts);
  const shiftMap = new Map(shifts.map((shift) => [shift.id, shift]));
  const availabilityByShiftId = new Map<number, Set<number>>();
  for (const shift of shifts) availabilityByShiftId.set(shift.id, new Set());
  for (const respondent of input.respondents) {
    for (const shiftId of respondent.availableShiftIds) {
      availabilityByShiftId.get(shiftId)?.add(respondent.id);
    }
  }

  const inputRespondentIds = new Set(input.respondents.map((respondent) => respondent.id));
  const manualRespondentIdByShiftId = new Map<number, number>();
  for (const manual of input.manualAssignments ?? []) {
    if (
      manualRespondentIdByShiftId.has(manual.shiftId) ||
      !shiftMap.has(manual.shiftId) ||
      !inputRespondentIds.has(manual.respondentId)
    ) {
      continue;
    }
    manualRespondentIdByShiftId.set(manual.shiftId, manual.respondentId);
  }
  const manualMinutesByRespondentId = new Map<number, number>();
  for (const [shiftId, respondentId] of manualRespondentIdByShiftId) {
    manualMinutesByRespondentId.set(
      respondentId,
      (manualMinutesByRespondentId.get(respondentId) ?? 0) + hoursToMinutes(shiftMap.get(shiftId)?.durationHours ?? 0),
    );
  }

  const respondents: RespondentInfo[] = input.respondents
    .map((respondent) => {
      const mandatoryShiftIds = new Set(
        Array.from(manualRespondentIdByShiftId.entries())
          .filter(([, respondentId]) => respondentId === respondent.id)
          .map(([shiftId]) => shiftId),
      );
      const capacityShifts = shifts.filter((shift) => {
        const manualRespondentId = manualRespondentIdByShiftId.get(shift.id);
        return manualRespondentId === undefined
          ? respondent.availableShiftIds.has(shift.id)
          : manualRespondentId === respondent.id;
      });
      return {
        ...respondent,
        availableCapacityMinutes: maxFeasibleShiftCapacityMinutes(capacityShifts, mandatoryShiftIds),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);

  const respondentById = new Map(respondents.map((respondent) => [respondent.id, respondent]));
  const assignmentsByRespondentId = new Map<number, AllocationAssignment[]>();
  for (const respondent of respondents) assignmentsByRespondentId.set(respondent.id, []);
  const assignmentByShiftId = new Map<number, AllocationAssignment>();

  const allocatedShiftIdsFor = (respondentId: number) =>
    (assignmentsByRespondentId.get(respondentId) ?? []).map((assignment) => assignment.shiftId);

  const normalAfpMinutesFor = (respondentId: number) =>
    (assignmentsByRespondentId.get(respondentId) ?? [])
      .filter(
        (assignment) =>
          assignment.source === "manual" ||
          assignment.source === "engine_normal" ||
          assignment.source === "engine_back_to_back_emergency",
      )
      .reduce((sum, assignment) => sum + hoursToMinutes(shiftMap.get(assignment.shiftId)?.durationHours ?? 0), 0);

  const noAvailabilityPlaceholderMinutesFor = (respondentId: number) =>
    (assignmentsByRespondentId.get(respondentId) ?? [])
      .filter((assignment) => assignment.source === NO_AVAILABILITY_AFP_PLACEHOLDER_SOURCE)
      .reduce((sum, assignment) => sum + hoursToMinutes(shiftMap.get(assignment.shiftId)?.durationHours ?? 0), 0);

  const addAssignment = (assignment: AllocationAssignment) => {
    const current = assignmentsByRespondentId.get(assignment.respondentId) ?? [];
    assignmentsByRespondentId.set(assignment.respondentId, [...current, assignment]);
    assignmentByShiftId.set(assignment.shiftId, assignment);
  };

  const removeAssignment = (shiftId: number) => {
    const existing = assignmentByShiftId.get(shiftId);
    if (!existing) return;
    assignmentsByRespondentId.set(
      existing.respondentId,
      (assignmentsByRespondentId.get(existing.respondentId) ?? []).filter(
        (assignment) => assignment.shiftId !== shiftId,
      ),
    );
    assignmentByShiftId.delete(shiftId);
  };

  for (const manual of input.manualAssignments ?? []) {
    const respondent = respondentById.get(manual.respondentId);
    const shift = shiftMap.get(manual.shiftId);
    if (!respondent || !shift || assignmentByShiftId.has(shift.id)) continue;
    addAssignment({
      respondentId: respondent.id,
      shiftId: shift.id,
      source: "manual",
      explanationCodes: ["MANUAL_OVERRIDE"],
    });
  }

  const staffableShifts = shifts.filter(
    (shift) => (availabilityByShiftId.get(shift.id)?.size ?? 0) > 0 || manualRespondentIdByShiftId.has(shift.id),
  );
  const intendedCappedAfpMinutes = respondents
    .filter((respondent) => respondent.hasAfpCap)
    .reduce(
      (sum, respondent) =>
        sum +
        Math.max(
          manualMinutesByRespondentId.get(respondent.id) ?? 0,
          Math.min(hoursToMinutes(respondent.afpHoursCap), respondent.availableCapacityMinutes),
        ),
      0,
    );
  const intendedNonAfpMinutes = Math.max(
    0,
    staffableShifts.reduce((sum, shift) => sum + hoursToMinutes(shift.durationHours), 0) - intendedCappedAfpMinutes,
  );
  const generalRespondents = respondents.filter((respondent) => !respondent.hasAfpCap);
  const generalTargetInputs = generalRespondents.map((respondent) => ({
    respondentId: respondent.id,
    penaltyMinutes: hoursToMinutes(respondent.hasPenalty ? respondent.penaltyHours : 0),
    capacityMinutes: respondent.availableCapacityMinutes,
    minimumMinutes: manualMinutesByRespondentId.get(respondent.id) ?? 0,
  }));
  let targetResult = solveNonAfpPenaltyTargets(generalTargetInputs, intendedNonAfpMinutes);
  const targetMinutesByRespondentId = new Map<number, number>();
  for (const target of targetResult.targets) {
    targetMinutesByRespondentId.set(target.respondentId, target.targetMinutes);
  }
  for (const respondent of respondents) {
    if (respondent.hasAfpCap) {
      targetMinutesByRespondentId.set(
        respondent.id,
        Math.min(hoursToMinutes(respondent.afpHoursCap), respondent.availableCapacityMinutes),
      );
    }
  }

  const candidateFor = (
    shift: ShiftInfo,
    respondent: RespondentInfo,
    allowAfpCapOverflowAvailable: boolean,
  ): Candidate | null => {
    if (assignmentByShiftId.has(shift.id)) return null;
    const isAvailable = respondent.availableShiftIds.has(shift.id);
    if (!isAvailable) return null;

    const existingShiftIds = allocatedShiftIdsFor(respondent.id);
    const dayTier = sameDayAllocationTier(shift.id, existingShiftIds, shiftMap);
    if (dayTier >= 2) return null;
    const safeDayTier: 0 | 1 = dayTier === 1 ? 1 : 0;

    let source: AssignmentSource = safeDayTier === 1 ? "engine_back_to_back_emergency" : "engine_normal";

    const validation = canAssignShiftToRespondent({
      shiftId: shift.id,
      existingShiftIds,
      shiftMap,
      isAvailable,
      assignmentSource: source,
      category: respondent.hasAfpCap ? "AFP" : "General",
      currentNormalMinutes: normalAfpMinutesFor(respondent.id),
      afpCapMinutes: hoursToMinutes(respondent.afpHoursCap),
      availabilityCount: availabilityByShiftId.get(shift.id)?.size ?? 0,
    });

    if (!validation.ok) {
      const capOnly =
        respondent.hasAfpCap &&
        allowAfpCapOverflowAvailable &&
        validation.reasonCodes.length === 1 &&
        validation.reasonCodes[0] === "BLOCKED_BY_AFP_CAP";
      if (!capOnly) return null;
      source = "engine_afp_cap_overflow_available";
    }

    const currentMinutes = calcMinutes(existingShiftIds, shiftMap);
    return {
      respondent,
      shift,
      source,
      dayTier: safeDayTier,
      currentMinutes,
      afterMinutes: currentMinutes + hoursToMinutes(shift.durationHours),
      targetMinutes: targetMinutesByRespondentId.get(respondent.id) ?? 0,
      capacityMinutes: respondent.availableCapacityMinutes,
      sourceRank: assignmentSourceRank(source),
    };
  };

  const assignBest = (
    shift: ShiftInfo,
    candidateRespondents: RespondentInfo[],
    allowAfpCapOverflowAvailable: boolean,
  ): boolean => {
    const candidates = candidateRespondents
      .map((respondent) => candidateFor(shift, respondent, allowAfpCapOverflowAvailable))
      .filter((candidate): candidate is Candidate => candidate !== null)
      .sort(compareCandidates);
    const best = candidates[0];
    if (!best) return false;
    addAssignment({
      respondentId: best.respondent.id,
      shiftId: shift.id,
      source: best.source,
      explanationCodes: best.source === "engine_afp_cap_overflow_available" ? ["BLOCKED_BY_AFP_CAP"] : [],
    });
    return true;
  };

  const availableShiftOrder = shifts
    .filter((shift) => (availabilityByShiftId.get(shift.id)?.size ?? 0) > 0)
    .sort((a, b) => {
      const aAvailable = availabilityByShiftId.get(a.id)?.size ?? 0;
      const bAvailable = availabilityByShiftId.get(b.id)?.size ?? 0;
      const aGeneral = respondents.filter(
        (respondent) => !respondent.hasAfpCap && respondent.availableShiftIds.has(a.id),
      ).length;
      const bGeneral = respondents.filter(
        (respondent) => !respondent.hasAfpCap && respondent.availableShiftIds.has(b.id),
      ).length;
      return (
        aAvailable - bAvailable ||
        aGeneral - bGeneral ||
        hoursToMinutes(b.durationHours) - hoursToMinutes(a.durationHours) ||
        a.date.localeCompare(b.date) ||
        a.slotIndex - b.slotIndex ||
        a.id - b.id
      );
    });

  for (const shift of availableShiftOrder) {
    if (assignmentByShiftId.has(shift.id)) continue;
    if (assignBest(shift, respondents, false)) continue;
    if (input.allowAfpOverCapForAvailableShifts) {
      assignBest(
        shift,
        respondents.filter((respondent) => respondent.hasAfpCap),
        true,
      );
    }
  }

  const repairBlankWithAvailability = (shift: ShiftInfo): boolean => {
    if (assignBest(shift, respondents, false)) return true;
    if (
      input.allowAfpOverCapForAvailableShifts &&
      assignBest(
        shift,
        respondents.filter((respondent) => respondent.hasAfpCap),
        true,
      )
    ) {
      return true;
    }

    const availableRespondents = respondents
      .filter((respondent) => respondent.availableShiftIds.has(shift.id))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);

    for (const respondent of availableRespondents) {
      const sameDayAssignments = (assignmentsByRespondentId.get(respondent.id) ?? []).filter(
        (assignment) => shiftMap.get(assignment.shiftId)?.date === shift.date && assignment.source !== "manual",
      );
      if (sameDayAssignments.length !== 1) continue;

      const conflictingAssignment = sameDayAssignments[0];
      const conflictingShift = shiftMap.get(conflictingAssignment.shiftId);
      if (!conflictingShift) continue;

      const originalAssignment = conflictingAssignment;
      removeAssignment(conflictingShift.id);

      const candidateForBlank =
        candidateFor(shift, respondent, false) ??
        (input.allowAfpOverCapForAvailableShifts ? candidateFor(shift, respondent, true) : null);

      if (candidateForBlank) {
        addAssignment({
          respondentId: respondent.id,
          shiftId: shift.id,
          source: candidateForBlank.source,
          explanationCodes:
            candidateForBlank.source === "engine_afp_cap_overflow_available" ? ["BLOCKED_BY_AFP_CAP"] : [],
        });

        const moved =
          assignBest(
            conflictingShift,
            respondents.filter((candidate) => candidate.id !== respondent.id),
            false,
          ) ||
          (input.allowAfpOverCapForAvailableShifts &&
            assignBest(
              conflictingShift,
              respondents.filter((candidate) => candidate.id !== respondent.id && candidate.hasAfpCap),
              true,
            ));

        if (moved) return true;
        removeAssignment(shift.id);
      }

      addAssignment(originalAssignment);
    }

    return false;
  };

  for (const shift of availableShiftOrder) {
    if (!assignmentByShiftId.has(shift.id)) repairBlankWithAvailability(shift);
  }

  const provisionalStaffedMinutes = Array.from(assignmentByShiftId.values()).reduce(
    (sum, assignment) => sum + hoursToMinutes(shiftMap.get(assignment.shiftId)?.durationHours ?? 0),
    0,
  );
  const provisionalCappedAfpMinutes = respondents
    .filter((respondent) => respondent.hasAfpCap)
    .reduce((sum, respondent) => sum + calcMinutes(allocatedShiftIdsFor(respondent.id), shiftMap), 0);
  targetResult = solveNonAfpPenaltyTargets(
    generalTargetInputs,
    Math.max(0, provisionalStaffedMinutes - provisionalCappedAfpMinutes),
  );
  for (const target of targetResult.targets) {
    targetMinutesByRespondentId.set(target.respondentId, target.targetMinutes);
  }

  type FairnessScore = {
    backToBackPairDays: number;
    maxAbsTargetDeviationMinutes: number;
    maxStrikeOverageMinutes: number;
    totalStrikeOverageMinutes: number;
    availabilityLimitedMaxShortfallRatio: number;
    availabilityLimitedTotalShortfallRatio: number;
    availabilityLimitedTotalShortfallMinutes: number;
    comparableMaxAbsTargetDeviationMinutes: number;
    comparableMaxShortfallMinutes: number;
    comparableMaxOverageMinutes: number;
    comparableTotalAbsDeviationMinutes: number;
    totalAbsTargetDeviationMinutes: number;
    nonPenalizedStdDevMinutes: number;
    sumSquaredDeviationMinutes: number;
    nonPenalizedRangeMinutes: number;
    diagnostics: FairnessDiagnostics;
  };

  const actualMinutesByRespondentId = () => {
    const actual = new Map<number, number>();
    for (const respondent of respondents) {
      actual.set(respondent.id, calcMinutes(allocatedShiftIdsFor(respondent.id), shiftMap));
    }
    return actual;
  };

  const currentFairnessScore = (
    repairAttempted: boolean,
    successfulRepairMoves: number,
    assignedShiftCountBeforeRepair: number,
  ): FairnessScore => {
    const actual = actualMinutesByRespondentId();
    const general = respondents.filter((respondent) => !respondent.hasAfpCap);
    const capacityLimitedRespondentIds = new Set(
      targetResult.targets.filter((target) => target.capacityLimited).map((target) => target.respondentId),
    );
    const availabilityLimitedRespondentIds = new Set(
      targetResult.targets.filter((target) => target.availabilityLimited).map((target) => target.respondentId),
    );
    const availabilityLimitedNonPenalized = general.filter(
      (respondent) =>
        (!respondent.hasPenalty || respondent.penaltyHours <= 0) &&
        availabilityLimitedRespondentIds.has(respondent.id) &&
        (targetMinutesByRespondentId.get(respondent.id) ?? 0) > 0,
    );
    const nonPenalized = general.filter(
      (respondent) =>
        (!respondent.hasPenalty || respondent.penaltyHours <= 0) && !capacityLimitedRespondentIds.has(respondent.id),
    );
    const nonPenalizedActual = nonPenalized.map((respondent) => actual.get(respondent.id) ?? 0);
    const nonPenalizedMean =
      nonPenalizedActual.length > 0
        ? nonPenalizedActual.reduce((sum, minutes) => sum + minutes, 0) / nonPenalizedActual.length
        : 0;
    const nonPenalizedMin = nonPenalizedActual.length > 0 ? Math.min(...nonPenalizedActual) : 0;
    const nonPenalizedMax = nonPenalizedActual.length > 0 ? Math.max(...nonPenalizedActual) : 0;
    const targetDeviations = general.map((respondent) => {
      const target = targetMinutesByRespondentId.get(respondent.id) ?? 0;
      return (actual.get(respondent.id) ?? 0) - target;
    });
    const comparableTargetDeviations = nonPenalized.map((respondent) => {
      const target = targetMinutesByRespondentId.get(respondent.id) ?? 0;
      return (actual.get(respondent.id) ?? 0) - target;
    });
    const strikeOverages = general
      .filter((respondent) => respondent.hasPenalty && respondent.penaltyHours > 0)
      .map((respondent) =>
        Math.max(0, (actual.get(respondent.id) ?? 0) - (targetMinutesByRespondentId.get(respondent.id) ?? 0)),
      );
    const availabilityLimitedShortfalls = availabilityLimitedNonPenalized.map((respondent) => {
      const targetMinutes = targetMinutesByRespondentId.get(respondent.id) ?? 0;
      const shortfallMinutes = Math.max(0, targetMinutes - (actual.get(respondent.id) ?? 0));
      return {
        shortfallMinutes,
        shortfallRatio: shortfallMinutes / targetMinutes,
      };
    });
    const maxAbsTargetDeviationMinutes =
      targetDeviations.length > 0 ? Math.max(...targetDeviations.map((value) => Math.abs(value))) : 0;
    const maxDeviationFromMeanMinutes =
      nonPenalizedActual.length > 0
        ? Math.max(...nonPenalizedActual.map((minutes) => Math.abs(minutes - nonPenalizedMean)))
        : 0;
    const nonPenalizedStdDevMinutes = stdDev(nonPenalizedActual);
    const backToBackPairDays = Array.from(
      Array.from(assignmentByShiftId.values()).reduce((groups, assignment) => {
        const shift = shiftMap.get(assignment.shiftId);
        if (!shift) return groups;
        const key = `${assignment.respondentId}:${shift.date}`;
        groups.set(key, [...(groups.get(key) ?? []), shift]);
        return groups;
      }, new Map<string, ShiftInfo[]>()),
    ).filter(([, dayShifts]) => dayShifts.length === 2 && isBackToBack(dayShifts[0], dayShifts[1])).length;
    const targetStdDevHours = 2;
    const warningStdDevHours = 4;
    const highStdDevReasonCodes =
      nonPenalizedStdDevMinutes > hoursToMinutes(targetStdDevHours)
        ? [...(targetResult.capacityShortfallMinutes > 0 ? ["NON_AFP_CAPACITY_SHORTFALL"] : [])]
        : [];

    return {
      backToBackPairDays,
      maxAbsTargetDeviationMinutes,
      maxStrikeOverageMinutes: strikeOverages.length > 0 ? Math.max(...strikeOverages) : 0,
      totalStrikeOverageMinutes: strikeOverages.reduce((sum, value) => sum + value, 0),
      availabilityLimitedMaxShortfallRatio:
        availabilityLimitedShortfalls.length > 0
          ? Math.max(...availabilityLimitedShortfalls.map((shortfall) => shortfall.shortfallRatio))
          : 0,
      availabilityLimitedTotalShortfallRatio: availabilityLimitedShortfalls.reduce(
        (sum, shortfall) => sum + shortfall.shortfallRatio,
        0,
      ),
      availabilityLimitedTotalShortfallMinutes: availabilityLimitedShortfalls.reduce(
        (sum, shortfall) => sum + shortfall.shortfallMinutes,
        0,
      ),
      comparableMaxAbsTargetDeviationMinutes:
        comparableTargetDeviations.length > 0
          ? Math.max(...comparableTargetDeviations.map((value) => Math.abs(value)))
          : 0,
      comparableMaxShortfallMinutes:
        comparableTargetDeviations.length > 0
          ? Math.max(...comparableTargetDeviations.map((value) => Math.max(0, -value)))
          : 0,
      comparableMaxOverageMinutes:
        comparableTargetDeviations.length > 0
          ? Math.max(...comparableTargetDeviations.map((value) => Math.max(0, value)))
          : 0,
      comparableTotalAbsDeviationMinutes: comparableTargetDeviations.reduce((sum, value) => sum + Math.abs(value), 0),
      totalAbsTargetDeviationMinutes: targetDeviations.reduce((sum, value) => sum + Math.abs(value), 0),
      nonPenalizedStdDevMinutes,
      sumSquaredDeviationMinutes: targetDeviations.reduce((sum, value) => sum + value * value, 0),
      nonPenalizedRangeMinutes: nonPenalizedMax - nonPenalizedMin,
      diagnostics: {
        nonPenalizedGeneralMeanHours: minutesToHours(nonPenalizedMean),
        nonPenalizedGeneralMedianHours: minutesToHours(median(nonPenalizedActual)),
        nonPenalizedGeneralMinHours: minutesToHours(nonPenalizedMin),
        nonPenalizedGeneralMaxHours: minutesToHours(nonPenalizedMax),
        nonPenalizedGeneralRangeHours: minutesToHours(nonPenalizedMax - nonPenalizedMin),
        nonPenalizedGeneralStdDevHours: minutesToHours(nonPenalizedStdDevMinutes),
        maxDeviationFromMeanHours: minutesToHours(maxDeviationFromMeanMinutes),
        maxDeviationFromTargetHours: minutesToHours(maxAbsTargetDeviationMinutes),
        sumSquaredDeviationFromTargetHours: targetDeviations.reduce(
          (sum, value) => sum + Math.pow(minutesToHours(value), 2),
          0,
        ),
        targetStdDevHours,
        warningStdDevHours,
        repairAttempted,
        successfulRepairMoves,
        assignedShiftCountBeforeRepair,
        assignedShiftCountAfterRepair: assignmentByShiftId.size,
        highStdDevReasonCodes,
        backToBackPairDays,
      },
    };
  };

  const scoreIsBetter = (next: FairnessScore, current: FairnessScore): boolean => {
    const minuteEpsilon = 0.5;
    const ratioEpsilon = 1e-9;
    const comparisons: Array<[number, number, number]> = [
      [next.maxAbsTargetDeviationMinutes, current.maxAbsTargetDeviationMinutes, minuteEpsilon],
      [next.maxStrikeOverageMinutes, current.maxStrikeOverageMinutes, minuteEpsilon],
      [next.totalStrikeOverageMinutes, current.totalStrikeOverageMinutes, minuteEpsilon],
      [next.availabilityLimitedMaxShortfallRatio, current.availabilityLimitedMaxShortfallRatio, ratioEpsilon],
      [next.availabilityLimitedTotalShortfallRatio, current.availabilityLimitedTotalShortfallRatio, ratioEpsilon],
      [next.availabilityLimitedTotalShortfallMinutes, current.availabilityLimitedTotalShortfallMinutes, minuteEpsilon],
      [next.comparableMaxAbsTargetDeviationMinutes, current.comparableMaxAbsTargetDeviationMinutes, minuteEpsilon],
      [next.comparableMaxShortfallMinutes, current.comparableMaxShortfallMinutes, minuteEpsilon],
      [next.comparableMaxOverageMinutes, current.comparableMaxOverageMinutes, minuteEpsilon],
      [next.nonPenalizedRangeMinutes, current.nonPenalizedRangeMinutes, minuteEpsilon],
      [next.comparableTotalAbsDeviationMinutes, current.comparableTotalAbsDeviationMinutes, minuteEpsilon],
      [next.backToBackPairDays, current.backToBackPairDays, 0],
      [next.totalAbsTargetDeviationMinutes, current.totalAbsTargetDeviationMinutes, minuteEpsilon],
      [next.nonPenalizedStdDevMinutes, current.nonPenalizedStdDevMinutes, minuteEpsilon],
      [next.sumSquaredDeviationMinutes, current.sumSquaredDeviationMinutes, minuteEpsilon],
    ];
    for (const [a, b, epsilon] of comparisons) {
      if (Math.abs(a - b) <= epsilon) continue;
      return a < b;
    }
    return false;
  };

  const assignmentCodesFor = (source: AssignmentSource): string[] =>
    source === "engine_afp_cap_overflow_available"
      ? ["BLOCKED_BY_AFP_CAP"]
      : source === NO_AVAILABILITY_AFP_PLACEHOLDER_SOURCE
        ? ["NO_AVAILABILITY"]
        : [];

  const trySingleFairnessMove = (
    repairAttempted: boolean,
    successfulRepairMoves: number,
    assignedShiftCountBeforeRepair: number,
  ): boolean => {
    const baseScore = currentFairnessScore(repairAttempted, successfulRepairMoves, assignedShiftCountBeforeRepair);
    const actual = actualMinutesByRespondentId();
    const movableAssignments = Array.from(assignmentByShiftId.values())
      .filter((assignment) => assignment.source !== "manual")
      .sort((a, b) => {
        const donorA = respondentById.get(a.respondentId);
        const donorB = respondentById.get(b.respondentId);
        const overA =
          donorA && !donorA.hasAfpCap
            ? (actual.get(a.respondentId) ?? 0) - (targetMinutesByRespondentId.get(a.respondentId) ?? 0)
            : 0;
        const overB =
          donorB && !donorB.hasAfpCap
            ? (actual.get(b.respondentId) ?? 0) - (targetMinutesByRespondentId.get(b.respondentId) ?? 0)
            : 0;
        const shiftA = shiftMap.get(a.shiftId)!;
        const shiftB = shiftMap.get(b.shiftId)!;
        return (
          overB - overA ||
          hoursToMinutes(shiftB.durationHours) - hoursToMinutes(shiftA.durationHours) ||
          shiftA.date.localeCompare(shiftB.date) ||
          shiftA.slotIndex - shiftB.slotIndex ||
          shiftA.id - shiftB.id
        );
      });

    for (const originalAssignment of movableAssignments) {
      const shift = shiftMap.get(originalAssignment.shiftId);
      const originalRespondent = respondentById.get(originalAssignment.respondentId);
      if (!shift || !originalRespondent) continue;

      removeAssignment(shift.id);
      const recipients = respondents
        .filter(
          (respondent) =>
            respondent.id !== originalAssignment.respondentId &&
            respondent.hasAfpCap === originalRespondent.hasAfpCap &&
            respondent.availableShiftIds.has(shift.id),
        )
        .sort((a, b) => {
          const deficitA = (targetMinutesByRespondentId.get(a.id) ?? 0) - (actual.get(a.id) ?? 0);
          const deficitB = (targetMinutesByRespondentId.get(b.id) ?? 0) - (actual.get(b.id) ?? 0);
          return deficitB - deficitA || a.name.localeCompare(b.name) || a.id - b.id;
        });

      for (const recipient of recipients) {
        const candidate =
          candidateFor(shift, recipient, false) ??
          (input.allowAfpOverCapForAvailableShifts ? candidateFor(shift, recipient, true) : null);
        if (!candidate) continue;
        addAssignment({
          respondentId: recipient.id,
          shiftId: shift.id,
          source: candidate.source,
          explanationCodes: assignmentCodesFor(candidate.source),
        });
        const nextScore = currentFairnessScore(repairAttempted, successfulRepairMoves, assignedShiftCountBeforeRepair);
        if (scoreIsBetter(nextScore, baseScore)) return true;
        removeAssignment(shift.id);
      }

      addAssignment(originalAssignment);
    }

    return false;
  };

  const tryPairwiseFairnessSwap = (
    repairAttempted: boolean,
    successfulRepairMoves: number,
    assignedShiftCountBeforeRepair: number,
  ): boolean => {
    const baseScore = currentFairnessScore(repairAttempted, successfulRepairMoves, assignedShiftCountBeforeRepair);
    const movableAssignments = Array.from(assignmentByShiftId.values())
      .filter((assignment) => assignment.source !== "manual")
      .sort((a, b) => {
        const shiftA = shiftMap.get(a.shiftId)!;
        const shiftB = shiftMap.get(b.shiftId)!;
        return shiftA.date.localeCompare(shiftB.date) || shiftA.slotIndex - shiftB.slotIndex || shiftA.id - shiftB.id;
      });

    for (let i = 0; i < movableAssignments.length; i++) {
      for (let j = i + 1; j < movableAssignments.length; j++) {
        const first = movableAssignments[i];
        const second = movableAssignments[j];
        if (first.respondentId === second.respondentId) continue;
        const firstRespondent = respondentById.get(first.respondentId);
        const secondRespondent = respondentById.get(second.respondentId);
        const firstShift = shiftMap.get(first.shiftId);
        const secondShift = shiftMap.get(second.shiftId);
        if (!firstRespondent || !secondRespondent || !firstShift || !secondShift) continue;
        if (firstRespondent.hasAfpCap !== secondRespondent.hasAfpCap) continue;
        if (!firstRespondent.availableShiftIds.has(secondShift.id)) continue;
        if (!secondRespondent.availableShiftIds.has(firstShift.id)) continue;

        removeAssignment(firstShift.id);
        removeAssignment(secondShift.id);

        const secondTakesFirst =
          candidateFor(firstShift, secondRespondent, false) ??
          (input.allowAfpOverCapForAvailableShifts ? candidateFor(firstShift, secondRespondent, true) : null);
        if (secondTakesFirst) {
          addAssignment({
            respondentId: secondRespondent.id,
            shiftId: firstShift.id,
            source: secondTakesFirst.source,
            explanationCodes: assignmentCodesFor(secondTakesFirst.source),
          });
        }

        const firstTakesSecond = secondTakesFirst
          ? (candidateFor(secondShift, firstRespondent, false) ??
            (input.allowAfpOverCapForAvailableShifts ? candidateFor(secondShift, firstRespondent, true) : null))
          : null;
        if (firstTakesSecond) {
          addAssignment({
            respondentId: firstRespondent.id,
            shiftId: secondShift.id,
            source: firstTakesSecond.source,
            explanationCodes: assignmentCodesFor(firstTakesSecond.source),
          });
          const nextScore = currentFairnessScore(
            repairAttempted,
            successfulRepairMoves,
            assignedShiftCountBeforeRepair,
          );
          if (scoreIsBetter(nextScore, baseScore)) return true;
          removeAssignment(secondShift.id);
        }
        if (secondTakesFirst) removeAssignment(firstShift.id);

        addAssignment(first);
        addAssignment(second);
      }
    }

    return false;
  };

  const assignedShiftCountBeforeFairnessRepair = assignmentByShiftId.size;
  let fairnessRepairMoves = 0;
  let fairnessRepairAttempted =
    currentFairnessScore(false, 0, assignedShiftCountBeforeFairnessRepair).nonPenalizedStdDevMinutes >
    hoursToMinutes(2);

  for (let iteration = 0; iteration < 200; iteration++) {
    const moved =
      trySingleFairnessMove(fairnessRepairAttempted, fairnessRepairMoves, assignedShiftCountBeforeFairnessRepair) ||
      tryPairwiseFairnessSwap(fairnessRepairAttempted, fairnessRepairMoves, assignedShiftCountBeforeFairnessRepair);
    if (!moved) break;
    fairnessRepairAttempted = true;
    fairnessRepairMoves += 1;
  }

  const assignNoAvailabilityAfpPlaceholders = () => {
    if (!input.allowNoAvailabilityAfpPlaceholders) return;
    const fallbackAfps = respondents
      .filter((respondent) => respondent.category === "AFP" && respondent.allowNoAvailabilityFallback)
      .sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
    if (fallbackAfps.length === 0) return;

    const noAvailabilityShifts = shifts
      .filter((shift) => !assignmentByShiftId.has(shift.id) && (availabilityByShiftId.get(shift.id)?.size ?? 0) === 0)
      .sort(
        (a, b) =>
          a.date.localeCompare(b.date) ||
          a.slotIndex - b.slotIndex ||
          hoursToMinutes(b.durationHours) - hoursToMinutes(a.durationHours) ||
          a.id - b.id,
      );

    for (const shift of noAvailabilityShifts) {
      const candidates = fallbackAfps
        .map((respondent) => {
          const existingShiftIds = allocatedShiftIdsFor(respondent.id);
          const validation = canAssignShiftToRespondent({
            shiftId: shift.id,
            existingShiftIds,
            shiftMap,
            isAvailable: false,
            availabilityCount: 0,
            assignmentSource: NO_AVAILABILITY_AFP_PLACEHOLDER_SOURCE,
            category: "AFP",
            allowNoAvailabilityAfpPlaceholder: true,
            isEligibleNoAvailabilityAfpPlaceholder: true,
            allowExtremeNoAvailabilityAfpStacking: Boolean(input.allowExtremeNoAvailabilityAfpStacking),
            currentNormalMinutes: normalAfpMinutesFor(respondent.id),
            afpCapMinutes: hoursToMinutes(respondent.afpHoursCap),
          });
          if (!validation.ok) return null;
          return {
            respondent,
            validation,
            dayTier: sameDayAllocationTier(shift.id, existingShiftIds, shiftMap),
            placeholderMinutes: noAvailabilityPlaceholderMinutesFor(respondent.id),
            totalMinutes: calcMinutes(existingShiftIds, shiftMap),
          };
        })
        .filter(
          (
            candidate,
          ): candidate is {
            respondent: RespondentInfo;
            validation: ReturnType<typeof canAssignShiftToRespondent>;
            dayTier: 0 | 1 | 2;
            placeholderMinutes: number;
            totalMinutes: number;
          } => candidate !== null,
        )
        .sort(
          (a, b) =>
            a.placeholderMinutes - b.placeholderMinutes ||
            a.totalMinutes - b.totalMinutes ||
            a.dayTier - b.dayTier ||
            a.respondent.name.localeCompare(b.respondent.name) ||
            a.respondent.id - b.respondent.id,
        );

      const best = candidates[0];
      if (!best) continue;
      addAssignment({
        respondentId: best.respondent.id,
        shiftId: shift.id,
        source: NO_AVAILABILITY_AFP_PLACEHOLDER_SOURCE,
        explanationCodes: [
          "NO_AVAILABILITY",
          ...best.validation.reasonCodes.filter((code) => code === "EXTREME_NO_AVAILABILITY_PLACEHOLDER_STACKING"),
        ],
      });
    }
  };

  assignNoAvailabilityAfpPlaceholders();

  const finalStaffedMinutes = Array.from(assignmentByShiftId.values()).reduce(
    (sum, assignment) => sum + hoursToMinutes(shiftMap.get(assignment.shiftId)?.durationHours ?? 0),
    0,
  );
  const finalCappedAfpMinutes = respondents
    .filter((respondent) => respondent.hasAfpCap)
    .reduce((sum, respondent) => sum + calcMinutes(allocatedShiftIdsFor(respondent.id), shiftMap), 0);
  targetResult = solveNonAfpPenaltyTargets(
    generalTargetInputs,
    Math.max(0, finalStaffedMinutes - finalCappedAfpMinutes),
  );
  for (const target of targetResult.targets) {
    targetMinutesByRespondentId.set(target.respondentId, target.targetMinutes);
  }

  for (let iteration = 0; iteration < 200; iteration++) {
    const moved =
      trySingleFairnessMove(fairnessRepairAttempted, fairnessRepairMoves, assignedShiftCountBeforeFairnessRepair) ||
      tryPairwiseFairnessSwap(fairnessRepairAttempted, fairnessRepairMoves, assignedShiftCountBeforeFairnessRepair);
    if (!moved) break;
    fairnessRepairAttempted = true;
    fairnessRepairMoves += 1;
  }

  const fairnessDiagnostics = currentFairnessScore(
    fairnessRepairAttempted,
    fairnessRepairMoves,
    assignedShiftCountBeforeFairnessRepair,
  ).diagnostics;

  const plans = respondents.map((respondent) => {
    const assignments = (assignmentsByRespondentId.get(respondent.id) ?? []).sort((a, b) => {
      const shiftA = shiftMap.get(a.shiftId)!;
      const shiftB = shiftMap.get(b.shiftId)!;
      return shiftA.date.localeCompare(shiftB.date) || shiftA.slotIndex - shiftB.slotIndex || shiftA.id - shiftB.id;
    });
    const shiftIds = assignments.map((assignment) => assignment.shiftId);
    return {
      respondentId: respondent.id,
      name: respondent.name,
      category: respondent.category,
      shiftIds,
      totalHours: minutesToHours(calcMinutes(shiftIds, shiftMap)),
      isManuallyAdjusted: assignments.some((assignment) => assignment.source === "manual"),
      penaltyNote: null,
    };
  });

  const allHours = plans.map((plan) => plan.totalHours);
  return {
    plans,
    assignments: Array.from(assignmentByShiftId.values()).sort((a, b) => {
      const shiftA = shiftMap.get(a.shiftId)!;
      const shiftB = shiftMap.get(b.shiftId)!;
      return shiftA.date.localeCompare(shiftB.date) || shiftA.slotIndex - shiftB.slotIndex || shiftA.id - shiftB.id;
    }),
    averageHours: allHours.length > 0 ? allHours.reduce((a, b) => a + b, 0) / allHours.length : 0,
    stdDev: stdDev(allHours),
    unallocatedShiftIds: shifts.map((shift) => shift.id).filter((shiftId) => !assignmentByShiftId.has(shiftId)),
    fairnessDiagnostics,
  };
}

export async function runPureAllocation(input: PureAllocationInput): Promise<PureAllocationOutput> {
  const globalAttempt = await runGlobalAllocation(input);
  if (globalAttempt.ok) return globalAttempt.output;

  const fallback = runGreedyAllocation(input);
  fallback.fairnessDiagnostics.optimizationMethod = "greedy_fallback";
  fallback.fairnessDiagnostics.optimizerStatus = globalAttempt.reason;
  fallback.fairnessDiagnostics.optimalCoverageProven = false;
  return fallback;
}

export async function runAllocation(options: AllocationOptions): Promise<PureAllocationOutput> {
  const [{ db, shiftsTable, respondentsTable, responsesTable }, { eq }] = await Promise.all([
    import("@workspace/db"),
    import("drizzle-orm"),
  ]);
  const {
    surveyId,
    afpRespondentIds,
    afpUnclaimedShiftRespondentIds,
    allowNoAvailabilityAfpPlaceholders,
    noAvailabilityFallbackAfpIds,
    includedRespondentIds,
    allowAfpOverCapForAvailableShifts,
    allowExtremeNoAvailabilityAfpStacking,
    existingManualAssignments,
  } = options;
  const afpIdSet = new Set(afpRespondentIds);
  const afpUnclaimedShiftIdSet = new Set(noAvailabilityFallbackAfpIds ?? afpUnclaimedShiftRespondentIds ?? []);
  const includedIdSet = includedRespondentIds?.length ? new Set(includedRespondentIds) : null;

  const shifts = await db.select().from(shiftsTable).where(eq(shiftsTable.surveyId, surveyId));

  const responses = await db
    .select({
      respondentId: responsesTable.respondentId,
      shiftId: responsesTable.shiftId,
      respondentName: respondentsTable.preferredName,
      respondentFullName: respondentsTable.name,
      respondentCategory: respondentsTable.category,
      hasPenalty: responsesTable.hasPenalty,
      penaltyHours: responsesTable.penaltyHours,
      hasAfpCap: responsesTable.hasAfpCap,
      afpHoursCap: responsesTable.afpHoursCap,
    })
    .from(responsesTable)
    .innerJoin(respondentsTable, eq(responsesTable.respondentId, respondentsTable.id))
    .where(eq(responsesTable.surveyId, surveyId));

  const respondentMap = new Map<number, AllocationRespondentInput>();
  for (const response of responses) {
    if (includedIdSet && !includedIdSet.has(response.respondentId)) continue;
    const category = response.respondentCategory === "AFP" ? "AFP" : "General";
    const hasPenalty = Boolean(response.hasPenalty);
    const penaltyHours = hasPenalty ? Math.max(0, response.penaltyHours ?? 0) : 0;
    const hasAfpCap = afpIdSet.has(response.respondentId) || Boolean(response.hasAfpCap);
    const afpHoursCap = Math.max(0, response.afpHoursCap ?? 10);
    if (!respondentMap.has(response.respondentId)) {
      respondentMap.set(response.respondentId, {
        id: response.respondentId,
        name: safeDisplayName(response.respondentName, response.respondentFullName),
        category,
        availableShiftIds: new Set(),
        hasPenalty,
        penaltyHours,
        hasAfpCap,
        afpHoursCap,
        allowNoAvailabilityFallback: afpUnclaimedShiftIdSet.has(response.respondentId),
      });
    }

    const respondent = respondentMap.get(response.respondentId)!;
    respondent.category = category;
    respondent.hasPenalty = respondent.hasPenalty || hasPenalty;
    respondent.penaltyHours = Math.max(respondent.penaltyHours, penaltyHours);
    respondent.hasAfpCap = hasAfpCap;
    respondent.afpHoursCap = afpHoursCap;
    respondent.allowNoAvailabilityFallback = afpUnclaimedShiftIdSet.has(response.respondentId);
    respondent.availableShiftIds.add(response.shiftId);
  }

  return runPureAllocation({
    shifts,
    respondents: Array.from(respondentMap.values()),
    allowAfpOverCapForAvailableShifts,
    allowNoAvailabilityAfpPlaceholders,
    allowExtremeNoAvailabilityAfpStacking,
    manualAssignments: existingManualAssignments,
  });
}
