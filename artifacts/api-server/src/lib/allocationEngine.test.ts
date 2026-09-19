import test from "node:test";
import assert from "node:assert/strict";
import {
  runPureAllocation,
  type AllocationRespondentInput,
  type AllocationShiftInput,
} from "./allocationEngine.js";

const weekday = [
  shift(1, "09:00", "11:00", 2),
  shift(2, "11:00", "14:00", 3),
  shift(3, "14:00", "17:00", 3),
  shift(4, "17:00", "20:00", 3),
];

function shift(
  id: number,
  startTime: string,
  endTime: string,
  durationHours: number,
): AllocationShiftInput {
  return {
    id,
    date: "2026-05-04",
    dayType: "weekday",
    startTime,
    endTime,
    durationHours,
    label: `${startTime}-${endTime}`,
  };
}

function respondent(
  id: number,
  name: string,
  availableShiftIds: number[],
  overrides: Partial<AllocationRespondentInput> = {},
): AllocationRespondentInput {
  const category = overrides.category ?? "General";
  return {
    id,
    name,
    category,
    availableShiftIds: new Set(availableShiftIds),
    hasPenalty: overrides.hasPenalty ?? false,
    penaltyHours: overrides.penaltyHours ?? 0,
    hasAfpCap: overrides.hasAfpCap ?? category === "AFP",
    afpHoursCap: overrides.afpHoursCap ?? 10,
    allowNoAvailabilityFallback: overrides.allowNoAvailabilityFallback ?? false,
  };
}

function assignmentFor(
  output: Awaited<ReturnType<typeof runPureAllocation>>,
  shiftId: number,
) {
  return output.assignments.find(
    (assignment) => assignment.shiftId === shiftId,
  );
}

test("blank_shift_despite_availability_regression assigns a shift with a legal available candidate", async () => {
  const output = await runPureAllocation({
    shifts: [weekday[0]],
    respondents: [respondent(1, "Alice", [1])],
  });

  assert.equal(output.unallocatedShiftIds.length, 0);
  assert.equal(assignmentFor(output, 1)?.respondentId, 1);
  assert.equal(assignmentFor(output, 1)?.source, "engine_normal");
});

test("strike_ignored_regression keeps penalized respondents eligible when coverage needs them", async () => {
  const output = await runPureAllocation({
    shifts: [weekday[0]],
    respondents: [
      respondent(1, "Penalized", [1], { hasPenalty: true, penaltyHours: 100 }),
    ],
  });

  assert.equal(output.unallocatedShiftIds.length, 0);
  assert.equal(assignmentFor(output, 1)?.respondentId, 1);
});

test("three_shifts_same_day_regression never assigns three shifts in one day", async () => {
  const output = await runPureAllocation({
    shifts: weekday,
    respondents: [respondent(1, "Alice", [1, 2, 3, 4])],
  });

  const assigned = output.assignments.filter(
    (assignment) => assignment.respondentId === 1,
  );
  assert.equal(assigned.length, 2);
  assert.equal(assigned[1].shiftId - assigned[0].shiftId, 1);
});

test("morning_evening_same_day_regression forbids non-adjacent same-day doubles", async () => {
  const output = await runPureAllocation({
    shifts: [weekday[0], weekday[3]],
    respondents: [respondent(1, "Alice", [1, 4])],
  });

  assert.equal(output.assignments.length, 1);
  assert.equal(output.unallocatedShiftIds.length, 1);
});

test("adjacent double can be used as a back-to-back emergency", async () => {
  const output = await runPureAllocation({
    shifts: [weekday[0], weekday[1]],
    respondents: [respondent(1, "Alice", [1, 2])],
  });

  assert.equal(output.unallocatedShiftIds.length, 0);
  assert.equal(
    output.assignments.some(
      (assignment) => assignment.source === "engine_back_to_back_emergency",
    ),
    true,
  );
});

test("non-adjacent double remains blank when no legal repair exists", async () => {
  const output = await runPureAllocation({
    shifts: [weekday[0], weekday[2]],
    respondents: [respondent(1, "Alice", [1, 3])],
  });

  assert.equal(output.assignments.length, 1);
  assert.equal(output.unallocatedShiftIds.length, 1);
});

test("no unavailable assignment leaves a no-availability shift blank", async () => {
  const output = await runPureAllocation({
    shifts: [weekday[0]],
    respondents: [respondent(1, "Alice", [])],
  });

  assert.deepEqual(output.unallocatedShiftIds, [1]);
  assert.equal(assignmentFor(output, 1), undefined);
});

test("no_availability_afp_placeholder_off_by_default leaves no-availability shifts blank", async () => {
  const output = await runPureAllocation({
    shifts: [weekday[0]],
    respondents: [
      respondent(1, "Fallback AFP", [], {
        category: "AFP",
        afpHoursCap: 0,
        allowNoAvailabilityFallback: true,
      }),
    ],
  });

  assert.deepEqual(output.unallocatedShiftIds, [1]);
  assert.equal(assignmentFor(output, 1), undefined);
});

test("no_availability_afp_placeholder assigns zero-availability shift only when enabled", async () => {
  const output = await runPureAllocation({
    shifts: [weekday[0]],
    allowNoAvailabilityAfpPlaceholders: true,
    respondents: [
      respondent(1, "Fallback AFP", [], {
        category: "AFP",
        afpHoursCap: 0,
        allowNoAvailabilityFallback: true,
      }),
    ],
  });

  assert.deepEqual(output.unallocatedShiftIds, []);
  assert.equal(assignmentFor(output, 1)?.respondentId, 1);
  assert.equal(
    assignmentFor(output, 1)?.source,
    "admin_no_availability_afp_placeholder",
  );
});

test("no_availability_afp_placeholder cannot be assigned to non-AFP", async () => {
  const output = await runPureAllocation({
    shifts: [weekday[0]],
    allowNoAvailabilityAfpPlaceholders: true,
    respondents: [
      respondent(1, "General Fallback", [], {
        category: "General",
        allowNoAvailabilityFallback: true,
      }),
    ],
  });

  assert.deepEqual(output.unallocatedShiftIds, [1]);
  assert.equal(assignmentFor(output, 1), undefined);
});

test("no_availability_afp_placeholder cannot be used when someone selected the shift", async () => {
  const output = await runPureAllocation({
    shifts: [weekday[0]],
    allowNoAvailabilityAfpPlaceholders: true,
    respondents: [
      respondent(1, "Available General", [1]),
      respondent(2, "Fallback AFP", [], {
        category: "AFP",
        allowNoAvailabilityFallback: true,
      }),
    ],
  });

  assert.equal(assignmentFor(output, 1)?.respondentId, 1);
  assert.equal(assignmentFor(output, 1)?.source, "engine_normal");
});

test("no_availability_afp_placeholder may exceed AFP cap without normal cap violation", async () => {
  const output = await runPureAllocation({
    shifts: [weekday[0]],
    allowNoAvailabilityAfpPlaceholders: true,
    respondents: [
      respondent(1, "Fallback AFP", [], {
        category: "AFP",
        afpHoursCap: 0,
        allowNoAvailabilityFallback: true,
      }),
    ],
  });

  assert.equal(
    assignmentFor(output, 1)?.source,
    "admin_no_availability_afp_placeholder",
  );
  assert.deepEqual(assignmentFor(output, 1)?.explanationCodes, [
    "NO_AVAILABILITY",
  ]);
});

test("no_availability_afp_placeholder respects same-day rules by default", async () => {
  const output = await runPureAllocation({
    shifts: [weekday[0], weekday[2]],
    allowNoAvailabilityAfpPlaceholders: true,
    respondents: [
      respondent(1, "Fallback AFP", [], {
        category: "AFP",
        afpHoursCap: 0,
        allowNoAvailabilityFallback: true,
      }),
    ],
  });

  assert.equal(output.assignments.length, 1);
  assert.equal(output.unallocatedShiftIds.length, 1);
});

test("available AFP cap overflow is explicit and opt-in", async () => {
  const baseInput = {
    shifts: [weekday[0]],
    respondents: [
      respondent(1, "Capped AFP", [1], {
        category: "AFP",
        afpHoursCap: 0,
      }),
    ],
  };

  const capped = await runPureAllocation(baseInput);
  const overflow = await runPureAllocation({
    ...baseInput,
    allowAfpOverCapForAvailableShifts: true,
  });

  assert.deepEqual(capped.unallocatedShiftIds, [1]);
  assert.equal(
    assignmentFor(overflow, 1)?.source,
    "engine_afp_cap_overflow_available",
  );
});

test("AFP without an enabled cap participates in normal equal allocation", async () => {
  const output = await runPureAllocation({
    shifts: [weekday[0]],
    respondents: [
      respondent(1, "Uncapped AFP", [1], {
        category: "AFP",
        hasAfpCap: false,
        afpHoursCap: 0,
      }),
    ],
  });

  assert.equal(assignmentFor(output, 1)?.respondentId, 1);
  assert.equal(assignmentFor(output, 1)?.source, "engine_normal");
  assert.deepEqual(output.unallocatedShiftIds, []);
});

test("AFP cap respected for normal and back-to-back emergency assignments", async () => {
  const output = await runPureAllocation({
    shifts: weekday.slice(0, 3),
    respondents: [
      respondent(1, "Capped AFP", [1, 2, 3], {
        category: "AFP",
        afpHoursCap: 5,
      }),
    ],
  });

  assert.deepEqual(
    output.assignments.map((assignment) => assignment.shiftId),
    [1, 2],
  );
  assert.equal(output.unallocatedShiftIds.includes(3), true);
});

test("preserve manual locks keeps manual assignments and allocates around them", async () => {
  const output = await runPureAllocation({
    shifts: [weekday[0], weekday[1]],
    respondents: [respondent(1, "Manual", []), respondent(2, "Available", [2])],
    manualAssignments: [{ respondentId: 1, shiftId: 1 }],
  });

  assert.equal(assignmentFor(output, 1)?.source, "manual");
  assert.equal(assignmentFor(output, 2)?.respondentId, 2);
  assert.equal(output.unallocatedShiftIds.length, 0);
});

test("fairness_high_sd_regression keeps balanced feasible non-penalized allocation under target threshold", async () => {
  const monday = shift(11, "09:00", "11:00", 2);
  const tuesday = { ...shift(12, "09:00", "11:00", 2), date: "2026-05-05" };
  const wednesday = { ...shift(13, "09:00", "11:00", 2), date: "2026-05-06" };
  const thursday = { ...shift(14, "09:00", "11:00", 2), date: "2026-05-07" };

  const output = await runPureAllocation({
    shifts: [monday, tuesday, wednesday, thursday],
    respondents: [
      respondent(1, "Alice", [11, 12, 13, 14]),
      respondent(2, "Bob", [11, 12, 13, 14]),
      respondent(3, "Caleb", [11, 12, 13, 14]),
      respondent(4, "Dana", [11, 12, 13, 14]),
    ],
  });

  assert.equal(output.assignments.length, 4);
  assert.equal(
    output.fairnessDiagnostics.nonPenalizedGeneralStdDevHours <= 2,
    true,
  );
});

test("global diagnostics exclude capacity-limited people from equal-pool spread", async () => {
  const generalShifts = Array.from({ length: 6 }, (_, index) => ({
    ...shift(201 + index, "09:00", "11:00", 2),
    date: `2026-05-${String(4 + index).padStart(2, "0")}`,
  }));
  const manualAfpShift = {
    ...shift(207, "09:00", "17:00", 8),
    date: "2026-05-10",
  };

  const output = await runPureAllocation({
    shifts: [...generalShifts, manualAfpShift],
    respondents: [
      respondent(1, "Low Availability", [generalShifts[0].id]),
      respondent(
        2,
        "Broad Availability",
        generalShifts.map((entry) => entry.id),
      ),
      respondent(3, "Manual AFP", [], {
        category: "AFP",
        afpHoursCap: 8,
      }),
    ],
    manualAssignments: [{ respondentId: 3, shiftId: manualAfpShift.id }],
  });

  assert.equal(output.fairnessDiagnostics.nonPenalizedGeneralMeanHours, 10);
  assert.equal(output.fairnessDiagnostics.nonPenalizedGeneralMedianHours, 10);
  assert.equal(output.fairnessDiagnostics.nonPenalizedGeneralMinHours, 10);
  assert.equal(output.fairnessDiagnostics.nonPenalizedGeneralMaxHours, 10);
  assert.equal(output.fairnessDiagnostics.nonPenalizedGeneralRangeHours, 0);
  assert.equal(output.fairnessDiagnostics.nonPenalizedGeneralStdDevHours, 0);
  assert.equal(output.fairnessDiagnostics.maxDeviationFromMeanHours, 0);
  assert.equal(output.fairnessDiagnostics.maxDeviationFromTargetHours, 0);
  assert.equal(output.fairnessDiagnostics.repairAttempted, false);
  assert.deepEqual(output.fairnessDiagnostics.highStdDevReasonCodes, []);
});

test("coverage preserved during fairness repair", async () => {
  const output = await runPureAllocation({
    shifts: [
      shift(21, "09:00", "11:00", 2),
      { ...shift(22, "09:00", "11:00", 2), date: "2026-05-05" },
      { ...shift(23, "09:00", "11:00", 2), date: "2026-05-06" },
    ],
    respondents: [
      respondent(1, "Alice", [21, 22, 23]),
      respondent(2, "Bob", [21, 22, 23]),
    ],
  });

  assert.equal(
    output.fairnessDiagnostics.assignedShiftCountBeforeRepair,
    output.assignments.length,
  );
  assert.equal(
    output.fairnessDiagnostics.assignedShiftCountAfterRepair,
    output.assignments.length,
  );
});

test("global optimizer removes avoidable back-to-back days without worsening fairness", async () => {
  const dayOneMorning = shift(31, "09:00", "11:00", 2);
  const dayOneMidday = shift(32, "11:00", "14:00", 3);
  const dayTwoMorning = {
    ...shift(33, "09:00", "11:00", 2),
    date: "2026-05-05",
  };
  const dayTwoMidday = {
    ...shift(34, "11:00", "14:00", 3),
    date: "2026-05-05",
  };

  const output = await runPureAllocation({
    shifts: [dayOneMorning, dayOneMidday, dayTwoMorning, dayTwoMidday],
    respondents: [
      respondent(1, "Alice", [31, 32, 33, 34]),
      respondent(2, "Bob", [31, 32, 33, 34]),
    ],
  });

  assert.equal(output.fairnessDiagnostics.optimizationMethod, "global_milp");
  assert.equal(output.fairnessDiagnostics.backToBackPairDays, 0);
  assert.deepEqual(
    output.plans.map((plan) => plan.totalHours).sort((a, b) => a - b),
    [5, 5],
  );
});

test("avoids an AFP back-to-back when another person can cover the adjacent shift", async () => {
  const firstShift = shift(35, "09:00", "11:00", 2);
  const secondShift = shift(36, "11:00", "13:00", 2);

  const output = await runPureAllocation({
    shifts: [firstShift, secondShift],
    respondents: [
      respondent(1, "AFP", [firstShift.id, secondShift.id], {
        category: "AFP",
        afpHoursCap: 2,
      }),
      respondent(2, "General", [secondShift.id]),
    ],
  });

  assert.deepEqual(output.unallocatedShiftIds, []);
  assert.equal(assignmentFor(output, firstShift.id)?.respondentId, 1);
  assert.equal(assignmentFor(output, secondShift.id)?.respondentId, 2);
  assert.equal(output.fairnessDiagnostics.backToBackPairDays, 0);
  assert.equal(output.fairnessDiagnostics.optimizationMethod, "global_milp");
});

test("global optimizer includes forced AFP placeholder hours in the fair monthly balance", async () => {
  const unavailable = shift(41, "09:00", "11:00", 2);
  const availableOne = {
    ...shift(42, "09:00", "11:00", 2),
    date: "2026-05-05",
  };
  const availableTwo = {
    ...shift(43, "09:00", "11:00", 2),
    date: "2026-05-06",
  };
  const availableThree = {
    ...shift(44, "09:00", "11:00", 2),
    date: "2026-05-07",
  };

  const output = await runPureAllocation({
    shifts: [unavailable, availableOne, availableTwo, availableThree],
    allowNoAvailabilityAfpPlaceholders: true,
    respondents: [
      respondent(1, "Alice", [42, 43, 44], {
        category: "AFP",
        hasAfpCap: false,
        allowNoAvailabilityFallback: true,
      }),
      respondent(2, "Bob", [42, 43, 44], {
        category: "AFP",
        hasAfpCap: false,
      }),
    ],
  });

  assert.equal(assignmentFor(output, 41)?.respondentId, 1);
  assert.equal(
    assignmentFor(output, 41)?.source,
    "admin_no_availability_afp_placeholder",
  );
  assert.deepEqual(
    output.plans.map((plan) => plan.totalHours).sort((a, b) => a - b),
    [4, 4],
  );
  assert.equal(output.fairnessDiagnostics.nonPenalizedGeneralStdDevHours, 0);
});

test("AFP placeholders count as actual workload without inflating availability capacity", async () => {
  const unavailable = shift(231, "09:00", "11:00", 2);
  const availableShifts = Array.from({ length: 3 }, (_, index) => ({
    ...shift(232 + index, "09:00", "11:00", 2),
    date: `2026-05-${String(5 + index).padStart(2, "0")}`,
  }));

  const input = {
    shifts: [unavailable, ...availableShifts],
    allowNoAvailabilityAfpPlaceholders: true,
    respondents: [
      respondent(1, "Placeholder AFP", [], {
        category: "AFP",
        hasAfpCap: false,
        allowNoAvailabilityFallback: true,
      }),
      respondent(
        2,
        "Available General",
        availableShifts.map((entry) => entry.id),
      ),
    ],
  } satisfies Parameters<typeof runPureAllocation>[0];
  const output = await runPureAllocation(input);

  assert.equal(
    assignmentFor(output, unavailable.id)?.source,
    "admin_no_availability_afp_placeholder",
  );
  assert.deepEqual(
    output.plans.map((plan) => plan.totalHours).sort((a, b) => a - b),
    [2, 6],
  );
  assert.equal(output.fairnessDiagnostics.maxDeviationFromTargetHours, 2);

  const fallbackOutput = await runPureAllocation({
    ...input,
    allowExtremeNoAvailabilityAfpStacking: true,
  });
  assert.equal(
    fallbackOutput.fairnessDiagnostics.optimizationMethod,
    "greedy_fallback",
  );
  assert.equal(
    fallbackOutput.fairnessDiagnostics.maxDeviationFromTargetHours,
    2,
  );
});

test("global optimizer distributes feasible hours among capped AFP respondents", async () => {
  const shifts = [
    shift(51, "09:00", "11:00", 2),
    { ...shift(52, "09:00", "11:00", 2), date: "2026-05-05" },
    { ...shift(53, "09:00", "11:00", 2), date: "2026-05-06" },
  ];

  const output = await runPureAllocation({
    shifts,
    respondents: [
      respondent(1, "Alpha AFP", [51, 52, 53], {
        category: "AFP",
        afpHoursCap: 6,
      }),
      respondent(2, "Beta AFP", [51, 52, 53], {
        category: "AFP",
        afpHoursCap: 6,
      }),
    ],
  });

  assert.equal(output.assignments.length, 3);
  assert.deepEqual(output.unallocatedShiftIds, []);
  assert.deepEqual(
    output.plans.map((plan) => plan.totalHours).sort((a, b) => a - b),
    [2, 4],
  );
  assert.equal(
    output.plans.every((plan) => plan.totalHours > 0 && plan.totalHours <= 6),
    true,
  );
});

test("capped AFP respondents reach their caps before General staff receive the remainder", async () => {
  const shifts = Array.from({ length: 8 }, (_, index) => ({
    ...shift(401 + index, "09:00", "11:00", 2),
    date: `2026-10-${String(index + 1).padStart(2, "0")}`,
  }));
  const shiftIds = shifts.map((entry) => entry.id);

  const output = await runPureAllocation({
    shifts,
    respondents: [
      respondent(1, "Alpha AFP", shiftIds, {
        category: "AFP",
        afpHoursCap: 6,
      }),
      respondent(2, "Beta AFP", shiftIds, {
        category: "AFP",
        afpHoursCap: 6,
      }),
      respondent(3, "General", shiftIds),
    ],
  });

  assert.deepEqual(output.unallocatedShiftIds, []);
  assert.deepEqual(
    new Map(output.plans.map((plan) => [plan.name, plan.totalHours])),
    new Map([
      ["Alpha AFP", 6],
      ["Beta AFP", 6],
      ["General", 4],
    ]),
  );
  assert.equal(output.fairnessDiagnostics.optimizationMethod, "global_milp");
});

test("global optimizer stays within the fairness band before minimizing doubles", async () => {
  const shifts = [
    shift(61, "09:00", "11:00", 2),
    shift(62, "11:00", "13:00", 2),
    { ...shift(63, "09:00", "11:00", 2), date: "2026-05-05" },
    { ...shift(64, "09:00", "11:00", 2), date: "2026-05-06" },
  ];

  const output = await runPureAllocation({
    shifts,
    respondents: [
      respondent(1, "Alice", [61, 62]),
      respondent(2, "Bob", [61, 62, 63, 64]),
    ],
  });

  assert.equal(output.assignments.length, 4);
  assert.deepEqual(output.unallocatedShiftIds, []);
  assert.equal(output.fairnessDiagnostics.optimizationMethod, "global_milp");
  assert.equal(output.fairnessDiagnostics.backToBackPairDays, 1);
  assert.deepEqual(
    output.plans.map((plan) => plan.totalHours).sort((a, b) => a - b),
    [4, 4],
  );
  assert.equal(output.fairnessDiagnostics.maxDeviationFromTargetHours, 0);
  assert.equal(
    output.fairnessDiagnostics.sumSquaredDeviationFromTargetHours,
    0,
  );
  assert.equal(output.fairnessDiagnostics.nonPenalizedGeneralStdDevHours, 0);
});

test("strike-adjusted fairness preserves the target gap before minimizing back-to-backs", async () => {
  const sharedShifts = [
    shift(101, "09:00", "11:00", 2),
    shift(102, "11:00", "13:00", 2),
    { ...shift(103, "09:00", "11:00", 2), date: "2026-05-05" },
    { ...shift(104, "11:00", "13:00", 2), date: "2026-05-05" },
    { ...shift(105, "09:00", "11:00", 2), date: "2026-05-06" },
    { ...shift(106, "11:00", "13:00", 2), date: "2026-05-06" },
    { ...shift(107, "09:00", "11:00", 2), date: "2026-05-07" },
    { ...shift(108, "11:00", "13:00", 2), date: "2026-05-07" },
  ];
  const penalizedOnlyShifts = [
    { ...shift(109, "09:00", "11:00", 2), date: "2026-05-08" },
    { ...shift(110, "09:00", "11:00", 2), date: "2026-05-09" },
    { ...shift(111, "09:00", "11:00", 2), date: "2026-05-10" },
    { ...shift(112, "09:00", "11:00", 2), date: "2026-05-11" },
  ];
  const sharedShiftIds = sharedShifts.map((entry) => entry.id);

  const output = await runPureAllocation({
    shifts: [...sharedShifts, ...penalizedOnlyShifts],
    respondents: [
      respondent(1, "Unpenalized", sharedShiftIds),
      respondent(
        2,
        "Penalized",
        [...sharedShiftIds, ...penalizedOnlyShifts.map((entry) => entry.id)],
        {
          hasPenalty: true,
          penaltyHours: 4,
        },
      ),
    ],
  });

  assert.equal(output.assignments.length, 12);
  assert.deepEqual(output.unallocatedShiftIds, []);
  const hoursByName = new Map(
    output.plans.map((plan) => [plan.name, plan.totalHours]),
  );
  assert.equal(output.fairnessDiagnostics.backToBackPairDays, 4);
  assert.equal(hoursByName.get("Unpenalized"), 16);
  assert.equal(hoursByName.get("Penalized"), 8);
  assert.equal(output.fairnessDiagnostics.maxDeviationFromTargetHours, 0);
  assert.equal(output.fairnessDiagnostics.optimizationMethod, "global_milp");
});

test("strike hours are redistributed equally across the non-penalized General pool", async () => {
  const shifts = Array.from({ length: 12 }, (_, index) => ({
    ...shift(451 + index, "09:00", "11:00", 2),
    date: `2026-11-${String(index + 1).padStart(2, "0")}`,
  }));
  const shiftIds = shifts.map((entry) => entry.id);

  const output = await runPureAllocation({
    shifts,
    respondents: [
      respondent(1, "Ordinary A", shiftIds),
      respondent(2, "Ordinary B", shiftIds),
      respondent(3, "Penalized", shiftIds, {
        hasPenalty: true,
        penaltyHours: 4,
      }),
    ],
  });

  assert.deepEqual(output.unallocatedShiftIds, []);
  assert.deepEqual(
    new Map(output.plans.map((plan) => [plan.name, plan.totalHours])),
    new Map([
      ["Ordinary A", 10],
      ["Ordinary B", 10],
      ["Penalized", 4],
    ]),
  );
  assert.equal(output.fairnessDiagnostics.optimizationMethod, "global_milp");
});

test("a forced penalized outlier leaves the ordinary pool at its narrowest feasible range", async () => {
  const shifts = [
    { ...shift(301, "09:00", "11:00", 2), date: "2026-09-01" },
    { ...shift(302, "11:00", "13:00", 2), date: "2026-09-01" },
    { ...shift(303, "09:00", "11:00", 2), date: "2026-09-02" },
    { ...shift(304, "11:00", "13:00", 2), date: "2026-09-02" },
    { ...shift(305, "09:00", "11:00", 2), date: "2026-09-03" },
    { ...shift(306, "09:00", "11:00", 2), date: "2026-09-04" },
    { ...shift(307, "09:00", "11:00", 2), date: "2026-09-05" },
    { ...shift(308, "09:00", "11:00", 2), date: "2026-09-06" },
  ];

  const output = await runPureAllocation({
    shifts,
    respondents: [
      respondent(1, "Ordinary A", [301, 302, 303, 304, 305, 306]),
      respondent(2, "Ordinary B", [301, 302, 303, 304]),
      respondent(3, "Penalized", [307, 308], {
        hasPenalty: true,
        penaltyHours: 10,
      }),
    ],
  });

  assert.equal(output.assignments.length, 8);
  assert.deepEqual(output.unallocatedShiftIds, []);
  assert.deepEqual(
    new Map(output.plans.map((plan) => [plan.name, plan.totalHours])),
    new Map([
      ["Ordinary A", 6],
      ["Ordinary B", 6],
      ["Penalized", 4],
    ]),
  );
  assert.equal(output.fairnessDiagnostics.backToBackPairDays, 1);
  assert.equal(output.fairnessDiagnostics.nonPenalizedGeneralStdDevHours, 0);
  assert.equal(output.fairnessDiagnostics.nonPenalizedGeneralRangeHours, 0);
  assert.equal(output.fairnessDiagnostics.maxDeviationFromTargetHours, 4);
  assert.equal(
    output.fairnessDiagnostics.sumSquaredDeviationFromTargetHours,
    24,
  );
  assert.equal(output.fairnessDiagnostics.optimizationMethod, "global_milp");
});

test("a forced penalized outlier cannot starve a feasible low-availability respondent", async () => {
  const shifts = [
    { ...shift(501, "09:00", "11:00", 2), date: "2026-12-01" },
    { ...shift(502, "11:00", "13:00", 2), date: "2026-12-01" },
    { ...shift(503, "09:00", "11:00", 2), date: "2026-12-02" },
    { ...shift(504, "11:00", "13:00", 2), date: "2026-12-02" },
    { ...shift(505, "09:00", "11:00", 2), date: "2026-12-03" },
    { ...shift(506, "09:00", "11:00", 2), date: "2026-12-04" },
    { ...shift(507, "09:00", "11:00", 2), date: "2026-12-05" },
    { ...shift(508, "09:00", "11:00", 2), date: "2026-12-06" },
  ];

  const output = await runPureAllocation({
    shifts,
    respondents: [
      respondent(1, "Ordinary A", [501, 502, 503, 504, 505, 506]),
      respondent(2, "Ordinary B", [501, 502, 503, 504]),
      respondent(3, "Limited", [505]),
      respondent(4, "Penalized", [507, 508], {
        hasPenalty: true,
        penaltyHours: 10,
      }),
    ],
  });

  assert.deepEqual(output.unallocatedShiftIds, []);
  assert.equal(
    output.plans.find((plan) => plan.name === "Limited")?.totalHours,
    2,
  );
  assert.equal(
    output.plans.find((plan) => plan.name === "Penalized")?.totalHours,
    4,
  );
  assert.equal(output.fairnessDiagnostics.optimizationMethod, "global_milp");
});

test("shortfall ratios give the smallest availability target the best chance of full allocation", async () => {
  const shifts = Array.from({ length: 10 }, (_, index) => ({
    ...shift(551 + index, "09:00", "11:00", 2),
    date: `2027-01-${String(index + 1).padStart(2, "0")}`,
  }));
  const shiftIds = shifts.map((entry) => entry.id);

  const output = await runPureAllocation({
    shifts,
    respondents: [
      respondent(1, "Broad A", shiftIds),
      respondent(2, "Broad B", shiftIds),
      respondent(3, "Tiny availability", [551]),
      respondent(4, "Small availability", [551, 552]),
    ],
  });

  assert.deepEqual(output.unallocatedShiftIds, []);
  assert.deepEqual(
    new Map(output.plans.map((plan) => [plan.name, plan.totalHours])),
    new Map([
      ["Broad A", 8],
      ["Broad B", 8],
      ["Tiny availability", 2],
      ["Small availability", 2],
    ]),
  );
  assert.equal(output.fairnessDiagnostics.nonPenalizedGeneralStdDevHours, 0);
  assert.equal(output.fairnessDiagnostics.optimizationMethod, "global_milp");
});

test("fairness capacity respects the feasible same-day maximum instead of raw availability", async () => {
  const sameDayNonAdjacent = [
    shift(121, "09:00", "11:00", 2),
    shift(122, "13:00", "15:00", 2),
    shift(123, "17:00", "19:00", 2),
  ];
  const nextDay = {
    ...shift(124, "09:00", "11:00", 2),
    date: "2026-05-05",
  };

  const output = await runPureAllocation({
    shifts: [...sameDayNonAdjacent, nextDay],
    respondents: [
      respondent(
        1,
        "Concentrated Availability",
        sameDayNonAdjacent.map((entry) => entry.id),
      ),
      respondent(2, "Broad Availability", [121, 122, 123, 124]),
    ],
  });

  assert.equal(output.assignments.length, 3);
  assert.equal(output.unallocatedShiftIds.length, 1);
  assert.deepEqual(
    output.plans.map((plan) => plan.totalHours).sort((a, b) => a - b),
    [2, 4],
  );
  assert.equal(
    output.fairnessDiagnostics.maxDeviationFromTargetHours < 1e-9,
    true,
  );
});

test("an unrelated long AFP shift does not loosen the General fairness envelope", async () => {
  const sharedShifts = [
    shift(131, "09:00", "11:00", 2),
    shift(132, "11:00", "13:00", 2),
    { ...shift(133, "09:00", "11:00", 2), date: "2026-05-05" },
    { ...shift(134, "11:00", "13:00", 2), date: "2026-05-05" },
    { ...shift(135, "09:00", "11:00", 2), date: "2026-05-06" },
    { ...shift(136, "11:00", "13:00", 2), date: "2026-05-06" },
  ];
  const broadOnlyShifts = Array.from({ length: 6 }, (_, index) => ({
    ...shift(137 + index, "09:00", "11:00", 2),
    date: `2026-05-${String(7 + index).padStart(2, "0")}`,
  }));
  const afpOnlyShift = {
    ...shift(143, "09:00", "17:00", 8),
    date: "2026-05-13",
  };
  const sharedShiftIds = sharedShifts.map((entry) => entry.id);

  const output = await runPureAllocation({
    shifts: [...sharedShifts, ...broadOnlyShifts, afpOnlyShift],
    respondents: [
      respondent(1, "Concentrated General", sharedShiftIds),
      respondent(2, "Broad General", [
        ...sharedShiftIds,
        ...broadOnlyShifts.map((entry) => entry.id),
      ]),
      respondent(3, "AFP", [afpOnlyShift.id], {
        category: "AFP",
        afpHoursCap: 8,
      }),
    ],
  });

  const hoursByName = new Map(
    output.plans.map((plan) => [plan.name, plan.totalHours]),
  );
  assert.equal(output.assignments.length, 13);
  assert.deepEqual(output.unallocatedShiftIds, []);
  assert.equal(output.fairnessDiagnostics.backToBackPairDays, 3);
  assert.equal(hoursByName.get("Concentrated General"), 12);
  assert.equal(hoursByName.get("Broad General"), 12);
  assert.equal(hoursByName.get("AFP"), 8);
  assert.equal(output.fairnessDiagnostics.maxDeviationFromTargetHours, 0);
});

test("a low-availability General with a long shift does not loosen everyone else's envelope", async () => {
  const sharedShifts = [
    shift(211, "09:00", "11:00", 2),
    shift(212, "11:00", "13:00", 2),
    { ...shift(213, "09:00", "11:00", 2), date: "2026-05-05" },
    { ...shift(214, "11:00", "13:00", 2), date: "2026-05-05" },
    { ...shift(215, "09:00", "11:00", 2), date: "2026-05-06" },
    { ...shift(216, "11:00", "13:00", 2), date: "2026-05-06" },
  ];
  const broadOnlyShifts = Array.from({ length: 6 }, (_, index) => ({
    ...shift(217 + index, "09:00", "11:00", 2),
    date: `2026-05-${String(7 + index).padStart(2, "0")}`,
  }));
  const outlierShift = {
    ...shift(223, "09:00", "17:00", 8),
    date: "2026-05-13",
  };
  const sharedShiftIds = sharedShifts.map((entry) => entry.id);

  const output = await runPureAllocation({
    shifts: [...sharedShifts, ...broadOnlyShifts, outlierShift],
    respondents: [
      respondent(1, "Concentrated", sharedShiftIds),
      respondent(2, "Broad", [
        ...sharedShiftIds,
        ...broadOnlyShifts.map((entry) => entry.id),
      ]),
      respondent(3, "Low Availability Outlier", [outlierShift.id]),
    ],
  });

  const hoursByName = new Map(
    output.plans.map((plan) => [plan.name, plan.totalHours]),
  );
  assert.equal(output.fairnessDiagnostics.backToBackPairDays, 3);
  assert.equal(hoursByName.get("Concentrated"), 12);
  assert.equal(hoursByName.get("Broad"), 12);
  assert.equal(hoursByName.get("Low Availability Outlier"), 8);
  assert.equal(output.fairnessDiagnostics.maxDeviationFromTargetHours, 0);
});

test("a fixed manual outlier does not loosen fairness for other General respondents", async () => {
  const sharedShifts = [
    shift(151, "09:00", "11:00", 2),
    shift(152, "11:00", "13:00", 2),
    { ...shift(153, "09:00", "11:00", 2), date: "2026-05-05" },
    { ...shift(154, "11:00", "13:00", 2), date: "2026-05-05" },
    { ...shift(155, "09:00", "11:00", 2), date: "2026-05-06" },
    { ...shift(156, "11:00", "13:00", 2), date: "2026-05-06" },
  ];
  const broadOnlyShifts = Array.from({ length: 6 }, (_, index) => ({
    ...shift(157 + index, "09:00", "11:00", 2),
    date: `2026-05-${String(7 + index).padStart(2, "0")}`,
  }));
  const manualShifts = Array.from({ length: 3 }, (_, index) => ({
    ...shift(163 + index, "09:00", "17:00", 8),
    date: `2026-05-${String(13 + index).padStart(2, "0")}`,
  }));
  const sharedShiftIds = sharedShifts.map((entry) => entry.id);

  const output = await runPureAllocation({
    shifts: [...sharedShifts, ...broadOnlyShifts, ...manualShifts],
    respondents: [
      respondent(1, "Concentrated", sharedShiftIds),
      respondent(2, "Broad", [
        ...sharedShiftIds,
        ...broadOnlyShifts.map((entry) => entry.id),
      ]),
      respondent(3, "Manual", []),
    ],
    manualAssignments: manualShifts.map((entry) => ({
      respondentId: 3,
      shiftId: entry.id,
    })),
  });

  const hoursByName = new Map(
    output.plans.map((plan) => [plan.name, plan.totalHours]),
  );
  assert.equal(output.assignments.length, 15);
  assert.deepEqual(output.unallocatedShiftIds, []);
  assert.equal(output.fairnessDiagnostics.backToBackPairDays, 3);
  assert.equal(hoursByName.get("Concentrated"), 12);
  assert.equal(hoursByName.get("Broad"), 12);
  assert.equal(hoursByName.get("Manual"), 24);
  assert.equal(
    Math.abs(output.fairnessDiagnostics.maxDeviationFromTargetHours) < 1e-9,
    true,
  );
});

test("greedy fallback uses per-date feasible capacity for General targets", async () => {
  const sameDayNonAdjacent = [
    shift(181, "09:00", "11:00", 2),
    shift(182, "13:00", "15:00", 2),
    shift(183, "17:00", "19:00", 2),
  ];
  const nextDay = {
    ...shift(184, "09:00", "11:00", 2),
    date: "2026-05-05",
  };

  const output = await runPureAllocation({
    shifts: [...sameDayNonAdjacent, nextDay],
    respondents: [
      respondent(
        1,
        "Concentrated Availability",
        sameDayNonAdjacent.map((entry) => entry.id),
      ),
      respondent(2, "Broad Availability", [181, 182, 183, 184]),
    ],
    allowExtremeNoAvailabilityAfpStacking: true,
  });

  assert.equal(
    output.fairnessDiagnostics.optimizationMethod,
    "greedy_fallback",
  );
  assert.equal(output.assignments.length, 3);
  assert.deepEqual(
    output.plans.map((plan) => plan.totalHours).sort((a, b) => a - b),
    [2, 4],
  );
  assert.equal(
    output.fairnessDiagnostics.maxDeviationFromTargetHours < 1e-9,
    true,
  );
});

test("greedy fallback absorbs fixed General manual hours into its targets", async () => {
  const sharedShifts = [
    shift(191, "09:00", "11:00", 2),
    { ...shift(192, "09:00", "11:00", 2), date: "2026-05-05" },
  ];
  const manualShifts = Array.from({ length: 3 }, (_, index) => ({
    ...shift(193 + index, "09:00", "17:00", 8),
    date: `2026-05-${String(6 + index).padStart(2, "0")}`,
  }));

  const output = await runPureAllocation({
    shifts: [...sharedShifts, ...manualShifts],
    respondents: [
      respondent(
        1,
        "Alice",
        sharedShifts.map((entry) => entry.id),
      ),
      respondent(
        2,
        "Bob",
        sharedShifts.map((entry) => entry.id),
      ),
      respondent(3, "Manual", []),
    ],
    manualAssignments: manualShifts.map((entry) => ({
      respondentId: 3,
      shiftId: entry.id,
    })),
    allowExtremeNoAvailabilityAfpStacking: true,
  });

  assert.equal(
    output.fairnessDiagnostics.optimizationMethod,
    "greedy_fallback",
  );
  assert.equal(output.assignments.length, 5);
  assert.deepEqual(
    output.plans.map((plan) => plan.totalHours).sort((a, b) => a - b),
    [2, 2, 24],
  );
  assert.equal(
    output.fairnessDiagnostics.maxDeviationFromTargetHours < 1e-9,
    true,
  );
});

test("greedy fallback derives General targets from actual overlapping AFP allocation", async () => {
  const afpShift = shift(241, "09:00", "11:00", 2);
  const generalShifts = [
    { ...shift(242, "09:00", "11:00", 2), date: "2026-05-05" },
    { ...shift(243, "09:00", "11:00", 2), date: "2026-05-06" },
  ];

  const output = await runPureAllocation({
    shifts: [afpShift, ...generalShifts],
    respondents: [
      respondent(1, "AFP One", [afpShift.id], { category: "AFP" }),
      respondent(2, "AFP Two", [afpShift.id], { category: "AFP" }),
      respondent(
        3,
        "General One",
        generalShifts.map((entry) => entry.id),
      ),
      respondent(
        4,
        "General Two",
        generalShifts.map((entry) => entry.id),
      ),
    ],
    allowExtremeNoAvailabilityAfpStacking: true,
  });

  const hoursByName = new Map(
    output.plans.map((plan) => [plan.name, plan.totalHours]),
  );
  assert.equal(
    output.fairnessDiagnostics.optimizationMethod,
    "greedy_fallback",
  );
  assert.equal(hoursByName.get("General One"), 2);
  assert.equal(hoursByName.get("General Two"), 2);
  assert.equal(
    output.fairnessDiagnostics.maxDeviationFromTargetHours < 1e-9,
    true,
  );
});

test("greedy fallback repairs normal allocation after adding AFP placeholders", async () => {
  const placeholderShifts = [
    shift(261, "09:00", "11:00", 2),
    { ...shift(262, "09:00", "11:00", 2), date: "2026-05-05" },
  ];
  const normalShift = {
    ...shift(263, "09:00", "11:00", 2),
    date: "2026-05-06",
  };

  const output = await runPureAllocation({
    shifts: [...placeholderShifts, normalShift],
    respondents: [
      respondent(1, "Alice AFP", [normalShift.id], {
        category: "AFP",
        hasAfpCap: false,
        allowNoAvailabilityFallback: true,
      }),
      respondent(2, "Bob General", [normalShift.id]),
    ],
    allowNoAvailabilityAfpPlaceholders: true,
    allowExtremeNoAvailabilityAfpStacking: true,
  });

  assert.equal(
    output.fairnessDiagnostics.optimizationMethod,
    "greedy_fallback",
  );
  assert.equal(assignmentFor(output, normalShift.id)?.respondentId, 2);
  assert.deepEqual(
    output.plans.map((plan) => plan.totalHours).sort((a, b) => a - b),
    [2, 4],
  );
});

test("greedy fallback excludes capacity-limited people from equal-pool spread", async () => {
  const shifts = Array.from({ length: 6 }, (_, index) => ({
    ...shift(251 + index, "09:00", "11:00", 2),
    date: `2026-05-${String(4 + index).padStart(2, "0")}`,
  }));

  const output = await runPureAllocation({
    shifts,
    respondents: [
      respondent(1, "Low Availability", [shifts[0].id]),
      respondent(
        2,
        "Broad Availability",
        shifts.map((entry) => entry.id),
      ),
    ],
    allowExtremeNoAvailabilityAfpStacking: true,
  });

  assert.equal(
    output.fairnessDiagnostics.optimizationMethod,
    "greedy_fallback",
  );
  assert.equal(output.fairnessDiagnostics.nonPenalizedGeneralMeanHours, 10);
  assert.equal(output.fairnessDiagnostics.nonPenalizedGeneralMedianHours, 10);
  assert.equal(output.fairnessDiagnostics.nonPenalizedGeneralMinHours, 10);
  assert.equal(output.fairnessDiagnostics.nonPenalizedGeneralMaxHours, 10);
  assert.equal(output.fairnessDiagnostics.nonPenalizedGeneralRangeHours, 0);
  assert.equal(output.fairnessDiagnostics.nonPenalizedGeneralStdDevHours, 0);
  assert.equal(output.fairnessDiagnostics.maxDeviationFromMeanHours, 0);
  assert.equal(output.fairnessDiagnostics.maxDeviationFromTargetHours, 0);
  assert.deepEqual(output.fairnessDiagnostics.highStdDevReasonCodes, []);
});

test("coverage remains more important than avoiding a forced back-to-back pair", async () => {
  const output = await runPureAllocation({
    shifts: [shift(71, "09:00", "11:00", 2), shift(72, "11:00", "13:00", 2)],
    respondents: [respondent(1, "Only Candidate", [71, 72])],
  });

  assert.equal(output.assignments.length, 2);
  assert.deepEqual(output.unallocatedShiftIds, []);
  assert.equal(output.fairnessDiagnostics.backToBackPairDays, 1);
});

test("manual hours count toward a capped AFP respondent's limit", async () => {
  const shifts = [
    shift(81, "09:00", "11:00", 2),
    { ...shift(82, "09:00", "11:00", 2), date: "2026-05-05" },
    { ...shift(83, "09:00", "11:00", 2), date: "2026-05-06" },
  ];

  const output = await runPureAllocation({
    shifts,
    respondents: [
      respondent(1, "Capped AFP", [81, 82, 83], {
        category: "AFP",
        afpHoursCap: 4,
      }),
    ],
    manualAssignments: [{ respondentId: 1, shiftId: 81 }],
  });

  assert.equal(output.assignments.length, 2);
  assert.equal(assignmentFor(output, 81)?.source, "manual");
  assert.equal(output.plans[0]?.totalHours, 4);
  assert.equal(output.unallocatedShiftIds.length, 1);
});

test("manual hours are included when classifying capped AFP overflow", async () => {
  const shifts = [
    shift(91, "09:00", "11:00", 2),
    { ...shift(92, "09:00", "11:00", 2), date: "2026-05-05" },
    { ...shift(93, "09:00", "11:00", 2), date: "2026-05-06" },
  ];

  const output = await runPureAllocation({
    shifts,
    respondents: [
      respondent(1, "Capped AFP", [91, 92, 93], {
        category: "AFP",
        afpHoursCap: 4,
      }),
    ],
    manualAssignments: [{ respondentId: 1, shiftId: 91 }],
    allowAfpOverCapForAvailableShifts: true,
  });

  assert.equal(output.assignments.length, 3);
  assert.equal(assignmentFor(output, 91)?.source, "manual");
  assert.equal(assignmentFor(output, 92)?.source, "engine_normal");
  assert.equal(
    assignmentFor(output, 93)?.source,
    "engine_afp_cap_overflow_available",
  );
});
