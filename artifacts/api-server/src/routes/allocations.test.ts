import assert from "node:assert/strict";
import { after, test } from "node:test";

process.env.DATABASE_URL ??= "postgresql://test:test@127.0.0.1:5432/test";

const { hoursToMinutes, maxFeasibleShiftCapacityMinutes, solveNonAfpPenaltyTargets } =
  await import("../lib/allocationCore.js");
const { buildGeneralFairnessWarning, penaltyGapHoursFromNeutralTarget, summarizeGeneralFairnessComparison } =
  await import("./allocations.js");

after(async () => {
  const { pool } = await import("@workspace/db");
  await pool.end();
});

test("warns when a penalized General respondent is far from the penalty-adjusted target", () => {
  const result = buildGeneralFairnessWarning({
    generalStats: [
      {
        name: "Taru",
        totalHours: 28,
        hasPenalty: false,
        penaltyHours: 0,
        penaltyGapHours: 0,
        capacityLimited: false,
        deviationFromTargetHours: -19,
      },
      {
        name: "Vidur",
        totalHours: 81,
        hasPenalty: true,
        penaltyHours: 10,
        penaltyGapHours: -34,
        capacityLimited: false,
        deviationFromTargetHours: 44,
      },
    ],
    warningThresholdHours: 4,
  });

  assert.equal(result.warning, true);
  assert.match(result.reason, /Taru -19\.0h/);
  assert.match(result.reason, /Vidur \+44\.0h/);
  assert.match(result.reason, /actual -34\.0h gap versus the configured 10\.0h penalty/);
  assert.doesNotMatch(result.reason, /NO_LEGAL_REPAIR/);
});

test("warns when a penalized General respondent is exactly at the residual boundary", () => {
  const result = buildGeneralFairnessWarning({
    generalStats: [
      {
        name: "Boundary strike",
        totalHours: 34,
        hasPenalty: true,
        penaltyHours: 10,
        penaltyGapHours: 6,
        capacityLimited: false,
        deviationFromTargetHours: 4,
      },
    ],
    warningThresholdHours: 4,
  });

  assert.equal(result.warning, true);
  assert.match(result.reason, /Boundary strike \+4\.0h/);
  assert.match(result.reason, /actual 6\.0h gap versus the configured 10\.0h penalty/);
});

test("does not turn a zero residual into an offender when the threshold is zero", () => {
  const result = buildGeneralFairnessWarning({
    generalStats: [
      {
        name: "On target",
        totalHours: 20,
        hasPenalty: false,
        penaltyHours: 0,
        penaltyGapHours: 0,
        capacityLimited: false,
        deviationFromTargetHours: 0,
      },
    ],
    warningThresholdHours: 0,
  });

  assert.deepEqual(result, { warning: false, reason: "" });
});

test("does not warn for high raw spread caused solely by a capacity-limited respondent", () => {
  const rawHours = [12, 40, 42];
  const rawMean = rawHours.reduce((sum, hours) => sum + hours, 0) / rawHours.length;
  const rawStdDev = Math.sqrt(rawHours.reduce((sum, hours) => sum + Math.pow(hours - rawMean, 2), 0) / rawHours.length);
  assert.equal(rawStdDev > 4, true);

  const result = buildGeneralFairnessWarning({
    generalStats: [
      {
        name: "Low availability",
        totalHours: 12,
        hasPenalty: false,
        penaltyHours: 0,
        penaltyGapHours: 0,
        capacityLimited: true,
        deviationFromTargetHours: 0,
      },
      {
        name: "Regular availability A",
        totalHours: 40,
        hasPenalty: false,
        penaltyHours: 0,
        penaltyGapHours: 0,
        capacityLimited: false,
        deviationFromTargetHours: 0,
      },
      {
        name: "Regular availability B",
        totalHours: 42,
        hasPenalty: false,
        penaltyHours: 0,
        penaltyGapHours: 0,
        capacityLimited: false,
        deviationFromTargetHours: 0,
      },
    ],
    warningThresholdHours: 4,
  });

  assert.deepEqual(result, { warning: false, reason: "" });
});

test("uses the respondent's neutral target for strike gaps and the comparable headline pool", () => {
  const targetResult = solveNonAfpPenaltyTargets(
    [
      {
        respondentId: 1,
        penaltyMinutes: 0,
        capacityMinutes: hoursToMinutes(10),
      },
      {
        respondentId: 2,
        penaltyMinutes: 0,
        capacityMinutes: hoursToMinutes(100),
      },
      {
        respondentId: 3,
        penaltyMinutes: hoursToMinutes(10),
        capacityMinutes: hoursToMinutes(100),
      },
    ],
    hoursToMinutes(70),
  );
  const targetById = new Map(targetResult.targets.map((target) => [target.respondentId, target] as const));
  const lowCapacityHours = 10;
  const regularHours = 35;
  const penalizedHours = 25;
  const misleadingRawMean = (lowCapacityHours + regularHours) / 2;

  assert.equal(misleadingRawMean - penalizedHours, -2.5);
  assert.equal(
    Math.abs(
      penaltyGapHoursFromNeutralTarget({
        hasPenalty: true,
        neutralTargetMinutes: targetById.get(3)?.neutralTargetMinutes ?? 0,
        totalHours: penalizedHours,
      }) - 5,
    ) < 1e-9,
    true,
  );

  const comparison = summarizeGeneralFairnessComparison([
    {
      totalHours: lowCapacityHours,
      hasPenalty: false,
      capacityLimited: targetById.get(1)?.capacityLimited ?? false,
    },
    {
      totalHours: regularHours,
      hasPenalty: false,
      capacityLimited: targetById.get(2)?.capacityLimited ?? false,
    },
    {
      totalHours: penalizedHours,
      hasPenalty: true,
      capacityLimited: targetById.get(3)?.capacityLimited ?? false,
    },
  ]);
  assert.equal(comparison.stats.length, 1);
  assert.equal(comparison.meanHours, 35);
  assert.equal(comparison.stdDevHours, 0);
});

test("retains the standard-deviation warning without claiming a repair was impossible", () => {
  const result = buildGeneralFairnessWarning({
    generalStats: [
      {
        name: "Lower",
        totalHours: 20,
        hasPenalty: false,
        penaltyHours: 0,
        penaltyGapHours: 0,
        capacityLimited: false,
        deviationFromTargetHours: 0,
      },
      {
        name: "Higher",
        totalHours: 32,
        hasPenalty: false,
        penaltyHours: 0,
        penaltyGapHours: 0,
        capacityLimited: false,
        deviationFromTargetHours: 0,
      },
    ],
    warningThresholdHours: 4,
  });

  assert.equal(result.warning, true);
  assert.match(result.reason, /standard deviation is 6\.0h/);
  assert.doesNotMatch(result.reason, /NO_LEGAL_REPAIR|INSUFFICIENT_OVERLAPPING_AVAILABILITY/);
});

test("fairness capacity counts only a legal single or adjacent pair on each date", () => {
  const capacityMinutes = maxFeasibleShiftCapacityMinutes([
    {
      id: 1,
      date: "2026-09-05",
      startTime: "09:00",
      endTime: "11:00",
      durationHours: 2,
    },
    {
      id: 2,
      date: "2026-09-05",
      startTime: "13:00",
      endTime: "15:00",
      durationHours: 2,
    },
    {
      id: 3,
      date: "2026-09-05",
      startTime: "17:00",
      endTime: "19:00",
      durationHours: 2,
    },
    {
      id: 4,
      date: "2026-09-06",
      startTime: "09:00",
      endTime: "11:00",
      durationHours: 2,
    },
    {
      id: 5,
      date: "2026-09-06",
      startTime: "11:00",
      endTime: "14:00",
      durationHours: 3,
    },
  ]);

  assert.equal(capacityMinutes, 7 * 60);
});

test("fairness capacity preserves manual hours and only adds a legal adjacent optional shift", () => {
  const capacityMinutes = maxFeasibleShiftCapacityMinutes(
    [
      {
        id: 1,
        date: "2026-09-07",
        startTime: "09:00",
        endTime: "11:00",
        durationHours: 2,
      },
      {
        id: 2,
        date: "2026-09-07",
        startTime: "11:00",
        endTime: "14:00",
        durationHours: 3,
      },
      {
        id: 3,
        date: "2026-09-07",
        startTime: "17:00",
        endTime: "20:00",
        durationHours: 3,
      },
    ],
    new Set([1]),
  );

  assert.equal(capacityMinutes, 5 * 60);
});
