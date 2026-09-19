import test from "node:test";
import assert from "node:assert/strict";
import { validateAllocationSnapshotEntries } from "./allocationSnapshots.js";

test("accepts a valid restorable allocation snapshot", () => {
  const result = validateAllocationSnapshotEntries([
    {
      respondentId: 7,
      shiftId: 42,
      isManuallyAdjusted: true,
      penaltyNote: "manual",
    },
  ]);

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.entries, [
      {
        respondentId: 7,
        shiftId: 42,
        isManuallyAdjusted: true,
        penaltyNote: "manual",
      },
    ]);
  }
});

test("rejects duplicate shift assignments in a snapshot", () => {
  const result = validateAllocationSnapshotEntries([
    {
      respondentId: 7,
      shiftId: 42,
      isManuallyAdjusted: false,
      penaltyNote: null,
    },
    {
      respondentId: 8,
      shiftId: 42,
      isManuallyAdjusted: false,
      penaltyNote: null,
    },
  ]);

  assert.deepEqual(result, {
    ok: false,
    reason: "Snapshot assigns the same shift more than once.",
  });
});

test("rejects malformed snapshot rows before database restoration", () => {
  const result = validateAllocationSnapshotEntries([
    {
      respondentId: 7,
      shiftId: "42",
      isManuallyAdjusted: false,
      penaltyNote: null,
    },
  ]);

  assert.deepEqual(result, {
    ok: false,
    reason: "Snapshot contains an invalid allocation row.",
  });
});
