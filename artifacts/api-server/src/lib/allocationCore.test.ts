import test from "node:test";
import assert from "node:assert/strict";
import {
  canAssignShiftToRespondent,
  deriveShiftSlotIndexes,
  hoursToMinutes,
  maxFeasibleShiftCapacityMinutes,
  minutesToHours,
  solveNonAfpPenaltyTargets,
  stableShiftKey,
  type CoreShift,
} from "./allocationCore.js";

const toHours = (minutes: number) => Number(minutesToHours(minutes).toFixed(4));

function solveHours(
  penalties: number[],
  intendedHours: number,
  capacities?: number[],
  minimums?: number[],
) {
  return solveNonAfpPenaltyTargets(
    penalties.map((penaltyHours, index) => ({
      respondentId: index + 1,
      penaltyMinutes: hoursToMinutes(penaltyHours),
      capacityMinutes: hoursToMinutes(capacities?.[index] ?? 200),
      minimumMinutes: hoursToMinutes(minimums?.[index] ?? 0),
    })),
    hoursToMinutes(intendedHours),
  );
}

test("solves equal non-AFP targets when nobody is penalized", () => {
  const result = solveHours([0, 0, 0, 0], 80);

  assert.equal(toHours(result.baselineMinutes), 20);
  assert.deepEqual(
    result.targets.map((target) => toHours(target.targetMinutes)),
    [20, 20, 20, 20],
  );
});

test("deducts a 10-hour strike from the neutral target before redistribution", () => {
  const result = solveHours([0, 0, 0, 10], 110);

  assert.equal(toHours(result.baselineMinutes), 27.5);
  assert.deepEqual(
    result.targets.map((target) => toHours(target.neutralTargetMinutes)),
    [27.5, 27.5, 27.5, 27.5],
  );
  assert.deepEqual(
    result.targets.map((target) => toHours(target.targetMinutes)),
    [30.8333, 30.8333, 30.8333, 17.5],
  );
  assert.equal(toHours(result.targets[3].effectivePenaltyMinutes), 10);
  assert.equal(toHours(result.unredistributedPenaltyMinutes), 0);
});

test("supports mixed strike penalties", () => {
  const result = solveHours([0, 0, 10, 5], 105);

  assert.equal(toHours(result.baselineMinutes), 26.25);
  assert.deepEqual(
    result.targets.map((target) => toHours(target.targetMinutes)),
    [33.75, 33.75, 16.25, 21.25],
  );
});

test("keeps lower targets when everyone is penalized and reports the unavoidable deficit", () => {
  const result = solveHours([5, 5, 5], 45);

  assert.equal(toHours(result.baselineMinutes), 15);
  assert.deepEqual(
    result.targets.map((target) => toHours(target.targetMinutes)),
    [10, 10, 10],
  );
  assert.equal(toHours(result.unredistributedPenaltyMinutes), 15);
});

test("does not silently cancel a lone respondent's strike target", () => {
  const result = solveHours([10], 20);

  assert.equal(toHours(result.baselineMinutes), 20);
  assert.deepEqual(
    result.targets.map((target) => toHours(target.targetMinutes)),
    [10],
  );
  assert.equal(toHours(result.unredistributedPenaltyMinutes), 10);
});

test("supports fractional strike penalties in minute units", () => {
  const result = solveHours([0, 7.5], 52.5);

  assert.equal(toHours(result.baselineMinutes), 26.25);
  assert.deepEqual(
    result.targets.map((target) => toHours(target.targetMinutes)),
    [33.75, 18.75],
  );
});

test("truncates targets at zero when penalty exceeds baseline", () => {
  const result = solveHours([0, 100], 30);

  assert.equal(toHours(result.baselineMinutes), 15);
  assert.deepEqual(
    result.targets.map((target) => toHours(target.targetMinutes)),
    [30, 0],
  );
  assert.equal(result.targets[1].targetTruncatedAtZero, true);
});

test("redistributes a capacity-aware strike without shrinking its effective deduction", () => {
  const result = solveHours([0, 0, 10], 70, [10, 100, 100]);

  assert.deepEqual(
    result.targets.map((target) => toHours(target.neutralTargetMinutes)),
    [10, 30, 30],
  );
  assert.deepEqual(
    result.targets.map((target) => toHours(target.targetMinutes)),
    [10, 40, 20],
  );
  assert.equal(toHours(result.targets[2].effectivePenaltyMinutes), 10);
});

test("marks a regular respondent capped by strike redistribution as capacity-limited", () => {
  const result = solveHours([0, 0, 0, 10], 100, [10, 32, 100, 100]);

  assert.deepEqual(
    result.targets.map((target) => toHours(target.neutralTargetMinutes)),
    [10, 30, 30, 30],
  );
  assert.deepEqual(
    result.targets.map((target) => toHours(target.targetMinutes)),
    [10, 32, 38, 20],
  );
  assert.equal(result.targets[1].capacityLimited, true);
  assert.equal(result.targets[1].availabilityLimited, false);
  assert.equal(result.targets[2].capacityLimited, false);

  assert.equal(toHours(result.redistributedPenaltyMinutes), 10);
  assert.equal(toHours(result.unredistributedPenaltyMinutes), 0);
});

test("reports a manual floor that prevents the full configured deduction", () => {
  const result = solveNonAfpPenaltyTargets(
    [
      {
        respondentId: 1,
        penaltyMinutes: hoursToMinutes(10),
        capacityMinutes: hoursToMinutes(40),
        minimumMinutes: hoursToMinutes(15),
      },
    ],
    hoursToMinutes(20),
  );
  const [target] = result.targets;

  assert.equal(toHours(target.neutralTargetMinutes), 20);
  assert.equal(toHours(target.targetMinutes), 15);
  assert.equal(toHours(target.effectivePenaltyMinutes), 5);
  assert.equal(toHours(target.unappliedPenaltyMinutes), 5);
  assert.equal(toHours(result.unredistributedPenaltyMinutes), 5);
});

test("does not label a zero-capacity respondent as truncated by a strike", () => {
  const result = solveHours([10], 0, [0]);
  const [target] = result.targets;

  assert.equal(target.neutralTargetMinutes, 0);
  assert.equal(target.targetMinutes, 0);
  assert.equal(target.effectivePenaltyMinutes, 0);
  assert.equal(target.targetTruncatedAtZero, false);
  assert.equal(result.unredistributedPenaltyMinutes, 0);
});

test("capacity-adjusts targets and redistributes feasible hours", () => {
  const result = solveHours([0, 0, 0], 75, [10, 100, 100]);

  assert.equal(toHours(result.targets[0].targetMinutes), 10);
  assert.equal(toHours(result.targets[1].targetMinutes), 32.5);
  assert.equal(toHours(result.targets[2].targetMinutes), 32.5);
  assert.equal(result.targets[0].capacityLimited, true);
  assert.equal(result.targets[0].availabilityLimited, true);
  assert.equal(result.capacityShortfallMinutes, 0);
});

test("manual minimums are absorbed into targets instead of becoming fairness outliers", () => {
  const result = solveHours([0, 0, 0], 54, [100, 100, 24], [0, 0, 24]);

  assert.deepEqual(
    result.targets.map((target) => toHours(target.targetMinutes)),
    [15, 15, 24],
  );
});

test("feasible capacity uses the best legal same-day pair instead of raw availability", () => {
  assert.equal(
    toHours(maxFeasibleShiftCapacityMinutes(Array.from(shifts.values()))),
    6,
  );
});

test("feasible capacity honors a mandatory shift when optional shifts conflict", () => {
  const mandatory = {
    id: 20,
    date: "2026-05-04",
    startTime: "09:00",
    endTime: "17:00",
    durationHours: 8,
  };
  const conflictingOptional = {
    id: 21,
    date: "2026-05-04",
    startTime: "17:30",
    endTime: "19:30",
    durationHours: 2,
  };

  assert.equal(
    toHours(
      maxFeasibleShiftCapacityMinutes(
        [mandatory, conflictingOptional],
        new Set([mandatory.id]),
      ),
    ),
    8,
  );
});

test("reports capacity shortfall when requested non-AFP hours exceed availability", () => {
  const result = solveHours([0, 0], 40, [10, 15]);

  assert.equal(toHours(result.feasibleTotalMinutes), 25);
  assert.equal(toHours(result.capacityShortfallMinutes), 15);
  assert.deepEqual(
    result.targets.map((target) => toHours(target.targetMinutes)),
    [10, 15],
  );
});

const shifts = new Map<number, CoreShift>([
  [
    1,
    {
      id: 1,
      date: "2026-05-04",
      startTime: "09:00",
      endTime: "11:00",
      durationHours: 2,
    },
  ],
  [
    2,
    {
      id: 2,
      date: "2026-05-04",
      startTime: "11:00",
      endTime: "14:00",
      durationHours: 3,
    },
  ],
  [
    3,
    {
      id: 3,
      date: "2026-05-04",
      startTime: "14:00",
      endTime: "17:00",
      durationHours: 3,
    },
  ],
  [
    4,
    {
      id: 4,
      date: "2026-05-04",
      startTime: "17:00",
      endTime: "20:00",
      durationHours: 3,
    },
  ],
]);

test("allows adjacent same-day doubles as back-to-back emergency", () => {
  const result = canAssignShiftToRespondent({
    shiftId: 2,
    existingShiftIds: [1],
    shiftMap: shifts,
    isAvailable: true,
    assignmentSource: "engine_back_to_back_emergency",
    category: "General",
  });

  assert.equal(result.ok, true);
  assert.equal(result.wouldBeBackToBackEmergency, true);
});

test("rejects non-adjacent same-day doubles", () => {
  const result = canAssignShiftToRespondent({
    shiftId: 3,
    existingShiftIds: [1],
    shiftMap: shifts,
    isAvailable: true,
    assignmentSource: "engine_normal",
    category: "General",
  });

  assert.equal(result.ok, false);
  assert.ok(result.reasonCodes.includes("BLOCKED_BY_NON_ADJACENT_SAME_DAY"));
});

test("rejects three shifts in one day", () => {
  const result = canAssignShiftToRespondent({
    shiftId: 3,
    existingShiftIds: [1, 2],
    shiftMap: shifts,
    isAvailable: true,
    assignmentSource: "engine_normal",
    category: "General",
  });

  assert.equal(result.ok, false);
  assert.ok(result.reasonCodes.includes("BLOCKED_BY_MAX_TWO_SHIFTS_DAY"));
});

test("manual assignment unavailable block rejects manual shifts without selected availability", () => {
  const result = canAssignShiftToRespondent({
    shiftId: 1,
    existingShiftIds: [],
    shiftMap: shifts,
    isAvailable: false,
    assignmentSource: "manual",
    category: "General",
  });

  assert.equal(result.ok, false);
  assert.ok(result.reasonCodes.includes("NO_AVAILABILITY"));
});

test("enforces AFP normal cap and rejects no-availability fallback overage", () => {
  const normal = canAssignShiftToRespondent({
    shiftId: 3,
    existingShiftIds: [],
    shiftMap: shifts,
    isAvailable: true,
    assignmentSource: "engine_normal",
    category: "AFP",
    currentNormalMinutes: hoursToMinutes(8),
    afpCapMinutes: hoursToMinutes(10),
  });
  const fallback = canAssignShiftToRespondent({
    shiftId: 3,
    existingShiftIds: [],
    shiftMap: shifts,
    isAvailable: false,
    assignmentSource: "engine_no_availability_afp_fallback",
    category: "AFP",
    currentNormalMinutes: hoursToMinutes(10),
    afpCapMinutes: hoursToMinutes(10),
    availabilityCount: 0,
  });

  assert.equal(normal.ok, false);
  assert.ok(normal.reasonCodes.includes("BLOCKED_BY_AFP_CAP"));
  assert.equal(fallback.ok, false);
  assert.ok(fallback.reasonCodes.includes("NO_AVAILABILITY"));
});

test("allows explicit zero-availability AFP placeholder", () => {
  const result = canAssignShiftToRespondent({
    shiftId: 3,
    existingShiftIds: [],
    shiftMap: shifts,
    isAvailable: false,
    availabilityCount: 0,
    assignmentSource: "admin_no_availability_afp_placeholder",
    category: "AFP",
    currentNormalMinutes: hoursToMinutes(10),
    afpCapMinutes: hoursToMinutes(10),
    allowNoAvailabilityAfpPlaceholder: true,
    isEligibleNoAvailabilityAfpPlaceholder: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.wouldViolateAvailability, false);
});

test("blocks AFP placeholder when shift had availability or respondent is not AFP", () => {
  const hadAvailability = canAssignShiftToRespondent({
    shiftId: 3,
    existingShiftIds: [],
    shiftMap: shifts,
    isAvailable: false,
    availabilityCount: 1,
    assignmentSource: "admin_no_availability_afp_placeholder",
    category: "AFP",
    allowNoAvailabilityAfpPlaceholder: true,
    isEligibleNoAvailabilityAfpPlaceholder: true,
  });
  const notAfp = canAssignShiftToRespondent({
    shiftId: 3,
    existingShiftIds: [],
    shiftMap: shifts,
    isAvailable: false,
    availabilityCount: 0,
    assignmentSource: "admin_no_availability_afp_placeholder",
    category: "General",
    allowNoAvailabilityAfpPlaceholder: true,
    isEligibleNoAvailabilityAfpPlaceholder: true,
  });

  assert.equal(hadAvailability.ok, false);
  assert.ok(hadAvailability.reasonCodes.includes("NO_AVAILABILITY"));
  assert.equal(notAfp.ok, false);
  assert.ok(notAfp.reasonCodes.includes("NO_FALLBACK_AFP_SELECTED"));
});

test("unstable_shift_key_response_mapping_regression keeps date-time-slot identity stable across regenerated IDs", () => {
  const original = [
    {
      id: 10,
      date: "2026-05-04",
      startTime: "09:00",
      endTime: "11:00",
      durationHours: 2,
    },
    {
      id: 11,
      date: "2026-05-04",
      startTime: "11:00",
      endTime: "14:00",
      durationHours: 3,
    },
  ];
  const regenerated = [
    {
      id: 910,
      date: "2026-05-04",
      startTime: "09:00",
      endTime: "11:00",
      durationHours: 2,
    },
    {
      id: 911,
      date: "2026-05-04",
      startTime: "11:00",
      endTime: "14:00",
      durationHours: 3,
    },
  ];

  const originalSlots = deriveShiftSlotIndexes(original);
  const regeneratedSlots = deriveShiftSlotIndexes(regenerated);

  const originalKey = stableShiftKey({
    ...original[1],
    slotIndex: originalSlots.get(original[1].id),
  });
  const regeneratedKey = stableShiftKey({
    ...regenerated[1],
    slotIndex: regeneratedSlots.get(regenerated[1].id),
  });

  assert.equal(originalKey, "2026-05-04|11:00|14:00|1");
  assert.equal(regeneratedKey, originalKey);
});
