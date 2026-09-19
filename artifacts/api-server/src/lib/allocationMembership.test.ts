import test from "node:test";
import assert from "node:assert/strict";
import { resolveAllocationRespondentIds } from "./allocationMembership.js";

test("legacy allocations exclude a response with no saved assignments", () => {
  const included = resolveAllocationRespondentIds({
    responseRespondentIds: [1, 2, 3],
    persistedIncludedRespondentIds: null,
    allocatedRespondentIds: [1, 2],
  });

  assert.deepEqual(included, [1, 2]);
});

test("persisted membership keeps an included respondent with zero assigned hours", () => {
  const included = resolveAllocationRespondentIds({
    responseRespondentIds: [1, 2, 3],
    persistedIncludedRespondentIds: [1, 2, 3],
    allocatedRespondentIds: [1, 2],
  });

  assert.deepEqual(included, [1, 2, 3]);
});

test("surveys without an allocation include every active response", () => {
  const included = resolveAllocationRespondentIds({
    responseRespondentIds: [3, 1, 2, 2],
    persistedIncludedRespondentIds: null,
    allocatedRespondentIds: [],
  });

  assert.deepEqual(included, [1, 2, 3]);
});
