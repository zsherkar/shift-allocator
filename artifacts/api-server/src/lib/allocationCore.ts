export type AssignmentSource =
  | "engine_normal"
  | "engine_back_to_back_emergency"
  | "engine_no_availability_afp_fallback"
  | "admin_no_availability_afp_placeholder"
  | "engine_afp_cap_overflow_available"
  | "manual"
  | "blank";

export type ExplanationCode =
  | "NO_AVAILABILITY"
  | "NO_FALLBACK_AFP_SELECTED"
  | "FALLBACK_AFP_BLOCKED_BY_SAME_DAY_RULE"
  | "BLOCKED_BY_NON_ADJACENT_SAME_DAY"
  | "BLOCKED_BY_MAX_TWO_SHIFTS_DAY"
  | "BLOCKED_BY_AFP_CAP"
  | "BLOCKED_BY_SAME_DAY_RULE"
  | "BLOCKED_ONLY_BY_AFP_CAP"
  | "BLOCKED_BY_FAIRNESS_REPAIR_NOT_LEGAL"
  | "BLOCKED_BY_MANUAL_LOCK"
  | "BLOCKED_BY_NO_BACK_TO_BACK_OPTION"
  | "HIGH_STD_DEV_NO_LEGAL_REPAIR"
  | "HIGH_STD_DEV_LEGAL_REPAIR_EXISTS"
  | "EXTREME_NO_AVAILABILITY_PLACEHOLDER_STACKING"
  | "EXTREME_STACKING_DISABLED"
  | "NON_AFP_CAPACITY_SHORTFALL"
  | "INSUFFICIENT_AVAILABILITY"
  | "INSUFFICIENT_OVERLAPPING_AVAILABILITY"
  | "SHIFT_GRANULARITY"
  | "SHIFT_GRANULARITY_LIMIT"
  | "SAME_DAY_CONSTRAINT"
  | "AFP_CAP_INTERACTION"
  | "MANUAL_OVERRIDE"
  | "MANUAL_LOCK_CONSTRAINT"
  | "NO_AVAILABLE_ALTERNATIVE"
  | "ALL_RESPONDENTS_PENALIZED"
  | "ONLY_ONE_NON_AFP"
  | "TARGET_TRUNCATED_AT_ZERO"
  | "ENGINE_REPAIR_LIMIT_REACHED"
  | "RENDERING_ASSIGNMENT_MISMATCH"
  | "AVAILABILITY_SHIFT_KEY_MISMATCH"
  | "UNKNOWN";

export const NO_AVAILABILITY_AFP_PLACEHOLDER_SOURCE: AssignmentSource = "admin_no_availability_afp_placeholder";

export function isNoAvailabilityAfpPlaceholderSource(source: AssignmentSource): boolean {
  return source === "admin_no_availability_afp_placeholder" || source === "engine_no_availability_afp_fallback";
}

export interface ShiftTimeWindow {
  date: string;
  startTime: string;
  endTime: string;
}

export interface CoreShift extends ShiftTimeWindow {
  id: number;
  durationHours: number;
  slotIndex?: number;
}

export interface PenaltyTargetInput {
  respondentId: number;
  penaltyMinutes: number;
  capacityMinutes: number;
  minimumMinutes?: number;
}

export interface PenaltyTargetOutput extends PenaltyTargetInput {
  neutralTargetMinutes: number;
  targetMinutes: number;
  effectivePenaltyMinutes: number;
  unappliedPenaltyMinutes: number;
  targetTruncatedAtZero: boolean;
  availabilityLimited: boolean;
  capacityLimited: boolean;
}

export interface PenaltyTargetResult {
  baselineMinutes: number;
  targets: PenaltyTargetOutput[];
  requestedTotalMinutes: number;
  feasibleTotalMinutes: number;
  capacityShortfallMinutes: number;
  redistributedPenaltyMinutes: number;
  unredistributedPenaltyMinutes: number;
}

export interface AssignmentValidationResult {
  ok: boolean;
  reasonCodes: ExplanationCode[];
  wouldBeBackToBackEmergency: boolean;
  wouldExceedAfpCap: boolean;
  wouldViolateAvailability: boolean;
  wouldCreateNonAdjacentSameDayDouble: boolean;
  wouldCreateTripleShiftDay: boolean;
}

export function hoursToMinutes(hours: number): number {
  return Math.max(0, Math.round(hours * 60));
}

export function minutesToHours(minutes: number): number {
  return minutes / 60;
}

export function isBackToBack(a: ShiftTimeWindow, b: ShiftTimeWindow): boolean {
  return a.date === b.date && (a.endTime === b.startTime || b.endTime === a.startTime);
}

export function stableShiftKey(shift: ShiftTimeWindow & { slotIndex?: number }): string {
  return `${shift.date}|${shift.startTime}|${shift.endTime}|${shift.slotIndex ?? 0}`;
}

export function deriveShiftSlotIndexes<T extends { id: number; date: string; startTime: string; endTime: string }>(
  shifts: T[],
): Map<number, number> {
  const byDate = new Map<string, T[]>();
  for (const shift of shifts) {
    byDate.set(shift.date, [...(byDate.get(shift.date) ?? []), shift]);
  }

  const slotIndexes = new Map<number, number>();
  for (const shiftsForDate of byDate.values()) {
    shiftsForDate
      .sort((a, b) => a.startTime.localeCompare(b.startTime) || a.endTime.localeCompare(b.endTime) || a.id - b.id)
      .forEach((shift, index) => slotIndexes.set(shift.id, index));
  }
  return slotIndexes;
}

export function sameDayAllocationTier(
  newShiftId: number,
  existing: number[],
  shiftMap: Map<number, CoreShift>,
): 0 | 1 | 2 {
  const nextShift = shiftMap.get(newShiftId);
  if (!nextShift) return 2;

  const sameDayShiftIds = existing.filter((id) => shiftMap.get(id)?.date === nextShift.date);
  if (sameDayShiftIds.length === 0) return 0;

  if (sameDayShiftIds.length === 1 && isBackToBack(nextShift, shiftMap.get(sameDayShiftIds[0])!)) {
    return 1;
  }

  return 2;
}

export function maxFeasibleShiftCapacityMinutes(
  shifts: CoreShift[],
  mandatoryShiftIds: ReadonlySet<number> = new Set<number>(),
): number {
  const shiftsByDate = new Map<string, CoreShift[]>();
  for (const shift of shifts) {
    shiftsByDate.set(shift.date, [...(shiftsByDate.get(shift.date) ?? []), shift]);
  }

  return Array.from(shiftsByDate.values()).reduce((totalCapacityMinutes, dayShifts) => {
    const mandatoryShifts = dayShifts.filter((shift) => mandatoryShiftIds.has(shift.id));
    const optionalShifts = dayShifts.filter((shift) => !mandatoryShiftIds.has(shift.id));
    const mandatoryMinutes = mandatoryShifts.reduce((sum, shift) => sum + hoursToMinutes(shift.durationHours), 0);

    if (mandatoryShifts.length >= 2) return totalCapacityMinutes + mandatoryMinutes;

    if (mandatoryShifts.length === 1) {
      const mandatoryShift = mandatoryShifts[0];
      const bestAdjacentOptionalMinutes = optionalShifts.reduce(
        (bestMinutes, shift) =>
          isBackToBack(mandatoryShift, shift)
            ? Math.max(bestMinutes, hoursToMinutes(shift.durationHours))
            : bestMinutes,
        0,
      );
      return totalCapacityMinutes + mandatoryMinutes + bestAdjacentOptionalMinutes;
    }

    let bestDayMinutes = optionalShifts.reduce(
      (bestMinutes, shift) => Math.max(bestMinutes, hoursToMinutes(shift.durationHours)),
      0,
    );
    for (let firstIndex = 0; firstIndex < optionalShifts.length; firstIndex += 1) {
      for (let secondIndex = firstIndex + 1; secondIndex < optionalShifts.length; secondIndex += 1) {
        const first = optionalShifts[firstIndex];
        const second = optionalShifts[secondIndex];
        if (!isBackToBack(first, second)) continue;
        bestDayMinutes = Math.max(
          bestDayMinutes,
          hoursToMinutes(first.durationHours) + hoursToMinutes(second.durationHours),
        );
      }
    }
    return totalCapacityMinutes + bestDayMinutes;
  }, 0);
}

export function canAssignShiftToRespondent({
  shiftId,
  existingShiftIds,
  shiftMap,
  isAvailable,
  assignmentSource,
  category,
  currentNormalMinutes = 0,
  afpCapMinutes = Infinity,
  availabilityCount,
  allowNoAvailabilityAfpPlaceholder = false,
  isEligibleNoAvailabilityAfpPlaceholder = false,
  allowExtremeNoAvailabilityAfpStacking = false,
}: {
  shiftId: number;
  existingShiftIds: number[];
  shiftMap: Map<number, CoreShift>;
  isAvailable: boolean;
  assignmentSource: AssignmentSource;
  category: "AFP" | "General";
  currentNormalMinutes?: number;
  afpCapMinutes?: number;
  availabilityCount?: number;
  allowNoAvailabilityAfpPlaceholder?: boolean;
  isEligibleNoAvailabilityAfpPlaceholder?: boolean;
  allowExtremeNoAvailabilityAfpStacking?: boolean;
}): AssignmentValidationResult {
  const shift = shiftMap.get(shiftId);
  const reasonCodes: ExplanationCode[] = [];

  if (!shift) {
    return {
      ok: false,
      reasonCodes: ["UNKNOWN"],
      wouldBeBackToBackEmergency: false,
      wouldExceedAfpCap: false,
      wouldViolateAvailability: false,
      wouldCreateNonAdjacentSameDayDouble: false,
      wouldCreateTripleShiftDay: false,
    };
  }

  const isPlaceholderSource = isNoAvailabilityAfpPlaceholderSource(assignmentSource);
  const isAllowedNoAvailabilityPlaceholder =
    isPlaceholderSource &&
    !isAvailable &&
    availabilityCount === 0 &&
    category === "AFP" &&
    allowNoAvailabilityAfpPlaceholder &&
    isEligibleNoAvailabilityAfpPlaceholder;

  const requiresAvailability = assignmentSource !== "blank" && !isAllowedNoAvailabilityPlaceholder;
  const wouldViolateAvailability = requiresAvailability && !isAvailable;
  if (requiresAvailability && !isAvailable) {
    reasonCodes.push("NO_AVAILABILITY");
  }
  if (isPlaceholderSource && !isAllowedNoAvailabilityPlaceholder) {
    if (availabilityCount !== 0) reasonCodes.push("NO_AVAILABILITY");
    if (category !== "AFP" || !isEligibleNoAvailabilityAfpPlaceholder) {
      reasonCodes.push("NO_FALLBACK_AFP_SELECTED");
    }
  }

  const dayTier = sameDayAllocationTier(shiftId, existingShiftIds, shiftMap);
  const sameDayCount = existingShiftIds.filter((id) => shiftMap.get(id)?.date === shift.date).length;
  const wouldCreateTripleShiftDay = sameDayCount >= 2;
  const wouldCreateNonAdjacentSameDayDouble = dayTier === 2 && !wouldCreateTripleShiftDay;
  if (dayTier === 2 && !(isAllowedNoAvailabilityPlaceholder && allowExtremeNoAvailabilityAfpStacking)) {
    reasonCodes.push("BLOCKED_BY_SAME_DAY_RULE");
    reasonCodes.push(sameDayCount >= 2 ? "BLOCKED_BY_MAX_TWO_SHIFTS_DAY" : "BLOCKED_BY_NON_ADJACENT_SAME_DAY");
    if (isAllowedNoAvailabilityPlaceholder) reasonCodes.push("EXTREME_STACKING_DISABLED");
  } else if (dayTier === 2 && isAllowedNoAvailabilityPlaceholder && allowExtremeNoAvailabilityAfpStacking) {
    reasonCodes.push("EXTREME_NO_AVAILABILITY_PLACEHOLDER_STACKING");
  }

  const wouldExceedAfpCap =
    category === "AFP" && currentNormalMinutes + hoursToMinutes(shift.durationHours) > afpCapMinutes;
  if (
    category === "AFP" &&
    !isNoAvailabilityAfpPlaceholderSource(assignmentSource) &&
    assignmentSource !== "engine_afp_cap_overflow_available" &&
    assignmentSource !== "manual" &&
    wouldExceedAfpCap
  ) {
    reasonCodes.push("BLOCKED_BY_AFP_CAP");
  }

  return {
    ok:
      reasonCodes.length === 0 ||
      (isAllowedNoAvailabilityPlaceholder &&
        allowExtremeNoAvailabilityAfpStacking &&
        reasonCodes.every((code) => code === "EXTREME_NO_AVAILABILITY_PLACEHOLDER_STACKING")),
    reasonCodes,
    wouldBeBackToBackEmergency: dayTier === 1,
    wouldExceedAfpCap,
    wouldViolateAvailability,
    wouldCreateNonAdjacentSameDayDouble,
    wouldCreateTripleShiftDay,
  };
}

export function solveNonAfpPenaltyTargets(
  people: PenaltyTargetInput[],
  intendedTotalMinutes: number,
): PenaltyTargetResult {
  const epsilonMinutes = 1e-6;
  const requestedTotalMinutes = Math.max(0, intendedTotalMinutes);
  const normalizedPeople = people.map((person) => ({
    respondentId: person.respondentId,
    penaltyMinutes: Math.max(0, person.penaltyMinutes),
    capacityMinutes: Math.max(0, person.capacityMinutes),
    minimumMinutes: Math.min(Math.max(0, person.capacityMinutes), Math.max(0, person.minimumMinutes ?? 0)),
  }));
  const totalCapacity = normalizedPeople.reduce((sum, person) => sum + person.capacityMinutes, 0);
  const totalMinimum = normalizedPeople.reduce((sum, person) => sum + person.minimumMinutes, 0);
  const feasibleTotalMinutes = Math.min(Math.max(requestedTotalMinutes, totalMinimum), totalCapacity);
  const capacityShortfallMinutes = Math.max(0, requestedTotalMinutes - totalCapacity);

  if (normalizedPeople.length === 0 || feasibleTotalMinutes === 0) {
    const targets = normalizedPeople.map((person) => {
      const neutralTargetMinutes = person.minimumMinutes;
      const targetMinutes = Math.max(person.minimumMinutes, neutralTargetMinutes - person.penaltyMinutes);
      return {
        ...person,
        neutralTargetMinutes,
        targetMinutes,
        effectivePenaltyMinutes: neutralTargetMinutes - targetMinutes,
        unappliedPenaltyMinutes: person.penaltyMinutes,
        targetTruncatedAtZero:
          neutralTargetMinutes > epsilonMinutes && targetMinutes <= epsilonMinutes && person.penaltyMinutes > 0,
        availabilityLimited: false,
        capacityLimited: person.capacityMinutes === 0,
      };
    });
    return {
      baselineMinutes: 0,
      targets,
      requestedTotalMinutes,
      feasibleTotalMinutes,
      capacityShortfallMinutes,
      redistributedPenaltyMinutes: 0,
      unredistributedPenaltyMinutes: targets.reduce((sum, target) => sum + target.effectivePenaltyMinutes, 0),
    };
  }

  const maxCapacity = Math.max(...normalizedPeople.map((person) => person.capacityMinutes));
  let low = 0;
  let high = feasibleTotalMinutes + maxCapacity + 1;

  const assignedAt = (baseline: number) =>
    normalizedPeople.reduce((sum, person) => {
      const rawTarget = Math.max(person.minimumMinutes, baseline);
      return sum + Math.min(person.capacityMinutes, rawTarget);
    }, 0);

  for (let i = 0; i < 80; i++) {
    const mid = (low + high) / 2;
    if (assignedAt(mid) < feasibleTotalMinutes) {
      low = mid;
    } else {
      high = mid;
    }
  }

  const baselineMinutes = high;
  const neutralTargetMinutes = normalizedPeople.map((person) =>
    Math.min(person.capacityMinutes, Math.max(person.minimumMinutes, baselineMinutes)),
  );
  const targetMinutes = neutralTargetMinutes.map((neutralTarget, index) => {
    const person = normalizedPeople[index];
    return Math.max(person.minimumMinutes, neutralTarget - person.penaltyMinutes);
  });
  const releasedPenaltyMinutes = neutralTargetMinutes.reduce(
    (sum, neutralTarget, index) => sum + neutralTarget - targetMinutes[index],
    0,
  );
  const regularIndexes = normalizedPeople.flatMap((person, index) => (person.penaltyMinutes <= 0 ? [index] : []));
  const regularHeadroomMinutes = regularIndexes.reduce(
    (sum, index) => sum + normalizedPeople[index].capacityMinutes - targetMinutes[index],
    0,
  );
  const redistributedPenaltyMinutes = Math.min(releasedPenaltyMinutes, regularHeadroomMinutes);
  let redistributionWaterlineMinutes = 0;

  if (redistributedPenaltyMinutes > 0 && regularIndexes.length > 0) {
    const regularTargetTotal =
      regularIndexes.reduce((sum, index) => sum + targetMinutes[index], 0) + redistributedPenaltyMinutes;
    let redistributionLow = 0;
    let redistributionHigh = feasibleTotalMinutes + maxCapacity + 1;
    const redistributedAt = (waterline: number) =>
      regularIndexes.reduce((sum, index) => {
        const person = normalizedPeople[index];
        return sum + Math.min(person.capacityMinutes, Math.max(targetMinutes[index], waterline));
      }, 0);
    for (let i = 0; i < 80; i += 1) {
      const mid = (redistributionLow + redistributionHigh) / 2;
      if (redistributedAt(mid) < regularTargetTotal) {
        redistributionLow = mid;
      } else {
        redistributionHigh = mid;
      }
    }
    for (const index of regularIndexes) {
      targetMinutes[index] = Math.min(
        normalizedPeople[index].capacityMinutes,
        Math.max(targetMinutes[index], redistributionHigh),
      );
    }
    redistributionWaterlineMinutes = redistributionHigh;

    // Keep the returned targets exactly aligned with the amount that should be
    // redistributed. The binary search is already extremely close; this only
    // removes floating-point dust before targets become MILP right-hand sides.
    let redistributionCorrectionMinutes =
      redistributedPenaltyMinutes -
      regularIndexes.reduce((sum, index) => sum + Math.max(0, targetMinutes[index] - neutralTargetMinutes[index]), 0);
    if (redistributionCorrectionMinutes > epsilonMinutes) {
      for (const index of regularIndexes) {
        const headroomMinutes = normalizedPeople[index].capacityMinutes - targetMinutes[index];
        const appliedMinutes = Math.min(headroomMinutes, redistributionCorrectionMinutes);
        targetMinutes[index] += appliedMinutes;
        redistributionCorrectionMinutes -= appliedMinutes;
        if (redistributionCorrectionMinutes <= epsilonMinutes) break;
      }
    } else if (redistributionCorrectionMinutes < -epsilonMinutes) {
      for (const index of [...regularIndexes].reverse()) {
        const removableMinutes = Math.max(0, targetMinutes[index] - neutralTargetMinutes[index]);
        const removedMinutes = Math.min(removableMinutes, -redistributionCorrectionMinutes);
        targetMinutes[index] -= removedMinutes;
        redistributionCorrectionMinutes += removedMinutes;
        if (redistributionCorrectionMinutes >= -epsilonMinutes) break;
      }
    }
  }

  const targets = normalizedPeople.map((person, index) => {
    const neutralTarget = neutralTargetMinutes[index];
    const adjustedTarget = Math.min(person.capacityMinutes, Math.max(person.minimumMinutes, targetMinutes[index]));
    const strikeAdjustedTarget = Math.max(person.minimumMinutes, neutralTarget - person.penaltyMinutes);
    const effectivePenaltyMinutes = neutralTarget - strikeAdjustedTarget;
    const desiredUnpenalizedTarget =
      person.penaltyMinutes <= 0
        ? Math.max(person.minimumMinutes, baselineMinutes, redistributionWaterlineMinutes)
        : Math.max(person.minimumMinutes, baselineMinutes);
    return {
      ...person,
      neutralTargetMinutes: neutralTarget,
      targetMinutes: adjustedTarget,
      effectivePenaltyMinutes,
      unappliedPenaltyMinutes: Math.max(0, person.penaltyMinutes - effectivePenaltyMinutes),
      targetTruncatedAtZero:
        neutralTarget > epsilonMinutes && adjustedTarget <= epsilonMinutes && effectivePenaltyMinutes > epsilonMinutes,
      availabilityLimited: person.capacityMinutes + epsilonMinutes < baselineMinutes,
      capacityLimited: person.capacityMinutes + epsilonMinutes < desiredUnpenalizedTarget,
    };
  });

  const actualRedistributedPenaltyMinutes = targets.reduce(
    (sum, target) =>
      target.penaltyMinutes <= 0 ? sum + Math.max(0, target.targetMinutes - target.neutralTargetMinutes) : sum,
    0,
  );

  return {
    baselineMinutes,
    targets,
    requestedTotalMinutes,
    feasibleTotalMinutes,
    capacityShortfallMinutes,
    redistributedPenaltyMinutes: actualRedistributedPenaltyMinutes,
    unredistributedPenaltyMinutes: Math.max(0, releasedPenaltyMinutes - actualRedistributedPenaltyMinutes),
  };
}
