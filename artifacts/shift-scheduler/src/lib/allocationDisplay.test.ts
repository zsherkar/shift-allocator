import test from "node:test";
import assert from "node:assert/strict";
import { formatAllocationDisplayName, isNoAvailabilityPlaceholderSource } from "./allocationDisplay.js";

test("marks AFP no-availability placeholder assignments with an asterisk", () => {
  assert.equal(formatAllocationDisplayName("Abdullah", "admin_no_availability_afp_placeholder"), "Abdullah*");
  assert.equal(formatAllocationDisplayName("Abdullah", "engine_no_availability_afp_fallback"), "Abdullah*");
});

test("leaves normal and manual assignment names unchanged", () => {
  assert.equal(formatAllocationDisplayName("Abdullah", "engine_normal"), "Abdullah");
  assert.equal(formatAllocationDisplayName("Abdullah", "manual"), "Abdullah");
  assert.equal(isNoAvailabilityPlaceholderSource("engine_normal"), false);
});
