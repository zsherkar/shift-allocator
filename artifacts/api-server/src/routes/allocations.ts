import { Router, type IRouter } from "express";
import { eq, and, desc, inArray } from "drizzle-orm";
import {
  allocationSnapshotsTable,
  allocationsTable,
  db,
  respondentsTable,
  responsesTable,
  shiftsTable,
  surveysTable,
} from "@workspace/db";
import { runAllocation, type FairnessDiagnostics } from "../lib/allocationEngine.js";
import {
  type AssignmentSource,
  type ExplanationCode,
  NO_AVAILABILITY_AFP_PLACEHOLDER_SOURCE,
  canAssignShiftToRespondent,
  deriveShiftSlotIndexes,
  hoursToMinutes,
  isNoAvailabilityAfpPlaceholderSource,
  isBackToBack,
  maxFeasibleShiftCapacityMinutes,
  minutesToHours,
  sameDayAllocationTier,
  solveNonAfpPenaltyTargets,
  stableShiftKey,
  type CoreShift,
} from "../lib/allocationCore.js";
import { computeAverage, computeMedian, computeStdDev } from "../lib/stats.js";
import { getEffectiveAllocationRespondentIds } from "../lib/allocationMembership.js";
import { validateAllocationSnapshotEntries } from "../lib/allocationSnapshots.js";
import { RunAllocationBody, AdjustAllocationBody } from "@workspace/api-zod";
import {
  dedupePositiveIntegerIds,
  FIELD_LIMITS,
  normalizeOptionalText,
  safeDisplayName,
} from "../lib/inputValidation.js";

const router: IRouter = Router();
const latestFairnessDiagnosticsBySurveyId = new Map<number, FairnessDiagnostics>();
const latestNoAvailabilityPlaceholderSettingsBySurveyId = new Map<
  number,
  {
    allowNoAvailabilityAfpPlaceholders: boolean;
    noAvailabilityFallbackAfpIds: number[];
  }
>();

type GeneralFairnessWarningStat = {
  name: string;
  totalHours: number;
  hasPenalty: boolean;
  penaltyHours: number;
  penaltyGapHours: number;
  capacityLimited: boolean;
  deviationFromTargetHours: number;
};

export function summarizeGeneralFairnessComparison<
  T extends {
    totalHours: number;
    hasPenalty: boolean;
    capacityLimited: boolean;
  },
>(
  stats: T[],
): {
  stats: T[];
  meanHours: number;
  medianHours: number;
  minHours: number;
  maxHours: number;
  rangeHours: number;
  stdDevHours: number;
  maxDeviationFromMeanHours: number;
} {
  const comparisonStats = stats.filter((stat) => !stat.hasPenalty && !stat.capacityLimited);
  const hours = comparisonStats.map((stat) => stat.totalHours);
  const meanHours = computeAverage(hours);
  const minHours = hours.length > 0 ? Math.min(...hours) : 0;
  const maxHours = hours.length > 0 ? Math.max(...hours) : 0;
  return {
    stats: comparisonStats,
    meanHours,
    medianHours: computeMedian(hours),
    minHours,
    maxHours,
    rangeHours: maxHours - minHours,
    stdDevHours: computeStdDev(hours, meanHours),
    maxDeviationFromMeanHours: hours.length > 0 ? Math.max(...hours.map((value) => Math.abs(value - meanHours))) : 0,
  };
}

function formatSignedHours(hours: number): string {
  const normalized = Math.abs(hours) < 0.05 ? 0 : hours;
  return `${normalized >= 0 ? "+" : ""}${normalized.toFixed(1)}h`;
}

export function penaltyGapHoursFromNeutralTarget(params: {
  hasPenalty: boolean;
  neutralTargetMinutes: number;
  totalHours: number;
}): number {
  return params.hasPenalty ? minutesToHours(params.neutralTargetMinutes) - params.totalHours : 0;
}

export function buildGeneralFairnessWarning(params: {
  generalStats: GeneralFairnessWarningStat[];
  warningThresholdHours: number;
}): { warning: boolean; reason: string } {
  const { generalStats, warningThresholdHours } = params;
  const threshold = Math.max(0, warningThresholdHours);
  const reasons: string[] = [];
  const comparisonStdDevHours = summarizeGeneralFairnessComparison(generalStats).stdDevHours;
  const thresholdEpsilonHours = 1e-6;

  if (comparisonStdDevHours > threshold) {
    reasons.push(
      `Comparable General standard deviation is ${comparisonStdDevHours.toFixed(1)}h ` +
        `(warning threshold ${threshold.toFixed(1)}h).`,
    );
  }

  const targetResidualOffenders = generalStats
    .filter((stat) => {
      const residualHours = Math.abs(stat.deviationFromTargetHours);
      return threshold <= thresholdEpsilonHours
        ? residualHours > thresholdEpsilonHours
        : residualHours + thresholdEpsilonHours >= threshold;
    })
    .sort(
      (a, b) =>
        Math.abs(b.deviationFromTargetHours) - Math.abs(a.deviationFromTargetHours) || a.name.localeCompare(b.name),
    );
  if (targetResidualOffenders.length > 0) {
    reasons.push(
      `General allocation misses availability- and penalty-adjusted targets by at least ${threshold.toFixed(1)}h: ` +
        targetResidualOffenders
          .map((stat) => `${stat.name} ${formatSignedHours(stat.deviationFromTargetHours)}`)
          .join(", ") +
        ".",
    );
  }

  const strikeGapOffenders = generalStats
    .filter((stat) => {
      if (!stat.hasPenalty) return false;
      const gapErrorHours = Math.abs(stat.penaltyHours - stat.penaltyGapHours);
      return threshold <= thresholdEpsilonHours
        ? gapErrorHours > thresholdEpsilonHours
        : gapErrorHours + thresholdEpsilonHours >= threshold;
    })
    .sort(
      (a, b) =>
        Math.abs(b.penaltyHours - b.penaltyGapHours) - Math.abs(a.penaltyHours - a.penaltyGapHours) ||
        a.name.localeCompare(b.name),
    );
  if (strikeGapOffenders.length > 0) {
    reasons.push(
      "Strike-gap check: " +
        strikeGapOffenders
          .map(
            (stat) =>
              `${stat.name} has an actual ${stat.penaltyGapHours.toFixed(1)}h gap versus ` +
              `the configured ${stat.penaltyHours.toFixed(1)}h penalty`,
          )
          .join(", ") +
        ".",
    );
  }

  return {
    warning: reasons.length > 0,
    reason: reasons.join(" "),
  };
}

async function buildAllocationResult(surveyId: number) {
  const includedRespondentIds = new Set(await getEffectiveAllocationRespondentIds(surveyId));
  const allocations = (
    await db
      .select({
        respondentId: allocationsTable.respondentId,
        shiftId: allocationsTable.shiftId,
        isManuallyAdjusted: allocationsTable.isManuallyAdjusted,
        penaltyNote: allocationsTable.penaltyNote,
        respondentName: respondentsTable.preferredName,
        respondentFullName: respondentsTable.name,
        respondentCategory: respondentsTable.category,
      })
      .from(allocationsTable)
      .innerJoin(respondentsTable, eq(allocationsTable.respondentId, respondentsTable.id))
      .where(eq(allocationsTable.surveyId, surveyId))
  ).filter((allocation) => includedRespondentIds.has(allocation.respondentId));

  const rawShifts = await db.select().from(shiftsTable).where(eq(shiftsTable.surveyId, surveyId));

  const slotIndexes = deriveShiftSlotIndexes(rawShifts);
  const shifts = rawShifts.map((shift) => {
    const slotIndex = slotIndexes.get(shift.id) ?? 0;
    return {
      ...shift,
      slotIndex,
      stableShiftKey: stableShiftKey({ ...shift, slotIndex }),
    };
  });
  const shiftMap = new Map(shifts.map((s) => [s.id, s]));
  const allShiftIds = new Set(shifts.map((s) => s.id));
  const responseRows = (
    await db
      .select({
        shiftId: responsesTable.shiftId,
        respondentId: responsesTable.respondentId,
        respondentName: respondentsTable.preferredName,
        respondentFullName: respondentsTable.name,
        respondentEmail: respondentsTable.email,
        respondentCategory: respondentsTable.category,
        hasPenalty: responsesTable.hasPenalty,
        penaltyHours: responsesTable.penaltyHours,
        hasAfpCap: responsesTable.hasAfpCap,
        afpHoursCap: responsesTable.afpHoursCap,
      })
      .from(responsesTable)
      .innerJoin(respondentsTable, eq(responsesTable.respondentId, respondentsTable.id))
      .where(eq(responsesTable.surveyId, surveyId))
  ).filter((response) => includedRespondentIds.has(response.respondentId));
  const availableRespondentsByShiftId = new Map<
    number,
    {
      respondentId: number;
      name: string;
      email: string | null;
      category: string;
      hasPenalty: boolean;
      penaltyHours: number;
      hasAfpCap: boolean;
      afpHoursCap: number;
    }[]
  >();
  const respondentSettingsById = new Map<
    number,
    {
      respondentId: number;
      name: string;
      email: string | null;
      category: string;
      hasPenalty: boolean;
      penaltyHours: number;
      hasAfpCap: boolean;
      afpHoursCap: number;
      availableShiftIds: Set<number>;
    }
  >();
  for (const row of responseRows) {
    const respondents = availableRespondentsByShiftId.get(row.shiftId) ?? [];
    const respondentName = safeDisplayName(row.respondentName, row.respondentFullName);
    respondents.push({
      respondentId: row.respondentId,
      name: respondentName,
      email: row.respondentEmail,
      category: row.respondentCategory,
      hasPenalty: Boolean(row.hasPenalty),
      penaltyHours: row.hasPenalty ? (row.penaltyHours ?? 0) : 0,
      hasAfpCap: Boolean(row.hasAfpCap),
      afpHoursCap: row.afpHoursCap ?? 10,
    });
    availableRespondentsByShiftId.set(row.shiftId, respondents);

    if (!respondentSettingsById.has(row.respondentId)) {
      respondentSettingsById.set(row.respondentId, {
        respondentId: row.respondentId,
        name: respondentName,
        email: row.respondentEmail,
        category: row.respondentCategory,
        hasPenalty: Boolean(row.hasPenalty),
        penaltyHours: row.hasPenalty ? (row.penaltyHours ?? 0) : 0,
        hasAfpCap: Boolean(row.hasAfpCap),
        afpHoursCap: row.afpHoursCap ?? 10,
        availableShiftIds: new Set(),
      });
    }
    const setting = respondentSettingsById.get(row.respondentId)!;
    setting.category = row.respondentCategory;
    setting.hasPenalty = setting.hasPenalty || Boolean(row.hasPenalty);
    setting.penaltyHours = Math.max(setting.penaltyHours, row.hasPenalty ? (row.penaltyHours ?? 0) : 0);
    setting.hasAfpCap = setting.hasAfpCap || Boolean(row.hasAfpCap);
    setting.afpHoursCap = Math.max(0, row.afpHoursCap ?? setting.afpHoursCap);
    setting.availableShiftIds.add(row.shiftId);
  }

  const respondentMap = new Map<
    number,
    {
      respondentId: number;
      name: string;
      category: string;
      shiftIds: number[];
      manualShiftIds: Set<number>;
      isManuallyAdjusted: boolean;
      penaltyNote: string | null;
    }
  >();

  for (const a of allocations) {
    if (!respondentMap.has(a.respondentId)) {
      respondentMap.set(a.respondentId, {
        respondentId: a.respondentId,
        name: safeDisplayName(a.respondentName, a.respondentFullName),
        category: a.respondentCategory,
        shiftIds: [],
        manualShiftIds: new Set(),
        isManuallyAdjusted: a.isManuallyAdjusted,
        penaltyNote: a.penaltyNote ?? null,
      });
    }
    respondentMap.get(a.respondentId)!.shiftIds.push(a.shiftId);
    if (a.isManuallyAdjusted) {
      respondentMap.get(a.respondentId)!.isManuallyAdjusted = true;
      respondentMap.get(a.respondentId)!.manualShiftIds.add(a.shiftId);
    }
  }
  for (const respondent of respondentSettingsById.values()) {
    if (!respondentMap.has(respondent.respondentId)) {
      respondentMap.set(respondent.respondentId, {
        respondentId: respondent.respondentId,
        name: respondent.name,
        category: respondent.category,
        shiftIds: [],
        manualShiftIds: new Set(),
        isManuallyAdjusted: false,
        penaltyNote: null,
      });
    }
  }

  const allocatedShiftIds = new Set(allocations.map((a) => a.shiftId));
  const unallocatedShiftIds = Array.from(allShiftIds).filter((id) => !allocatedShiftIds.has(id));
  const allocationShiftIdsByRespondentId = new Map<number, number[]>();
  const manualShiftIds = new Set<number>();
  for (const respondent of respondentMap.values()) {
    allocationShiftIdsByRespondentId.set(respondent.respondentId, respondent.shiftIds);
    for (const shiftId of respondent.manualShiftIds) manualShiftIds.add(shiftId);
  }

  const allocationsList = Array.from(respondentMap.values())
    .map((r) => {
      const totalHours = r.shiftIds.reduce((sum, id) => sum + (shiftMap.get(id)?.durationHours ?? 0), 0);
      const respondentSettings = respondentSettingsById.get(r.respondentId);
      const capHours = respondentSettings?.afpHoursCap ?? 10;
      const hasAfpCap = respondentSettings?.hasAfpCap ?? false;
      let afpNormalMinutes = hasAfpCap
        ? Array.from(r.manualShiftIds).reduce(
            (sum, shiftId) => sum + hoursToMinutes(shiftMap.get(shiftId)?.durationHours ?? 0),
            0,
          )
        : 0;
      const allocatedShifts = [...r.shiftIds]
        .sort((a, b) => {
          const shiftA = shiftMap.get(a)!;
          const shiftB = shiftMap.get(b)!;
          return shiftA.date.localeCompare(shiftB.date) || shiftA.slotIndex - shiftB.slotIndex || shiftA.id - shiftB.id;
        })
        .map((id) => {
          const shift = shiftMap.get(id)!;
          const availabilityCount = availableRespondentsByShiftId.get(id)?.length ?? 0;
          const hasBackToBackPair = r.shiftIds.some(
            (otherId) => otherId !== id && isBackToBack(shift, shiftMap.get(otherId)!),
          );
          let assignmentSource: AssignmentSource;
          if (r.manualShiftIds.has(id)) {
            assignmentSource = "manual";
          } else if (availabilityCount === 0 && r.category === "AFP") {
            assignmentSource = NO_AVAILABILITY_AFP_PLACEHOLDER_SOURCE;
          } else if (hasAfpCap && afpNormalMinutes + hoursToMinutes(shift.durationHours) > hoursToMinutes(capHours)) {
            assignmentSource = "engine_afp_cap_overflow_available";
          } else {
            assignmentSource = hasBackToBackPair ? "engine_back_to_back_emergency" : "engine_normal";
          }
          if (hasAfpCap && assignmentSource !== "manual" && !isNoAvailabilityAfpPlaceholderSource(assignmentSource)) {
            afpNormalMinutes += hoursToMinutes(shift.durationHours);
          }
          const explanationCodes: ExplanationCode[] =
            assignmentSource === "manual"
              ? ["MANUAL_OVERRIDE"]
              : isNoAvailabilityAfpPlaceholderSource(assignmentSource)
                ? ["NO_AVAILABILITY"]
                : assignmentSource === "engine_afp_cap_overflow_available"
                  ? ["BLOCKED_BY_AFP_CAP"]
                  : [];
          return {
            shiftId: id,
            stableShiftKey: shift.stableShiftKey,
            slotIndex: shift.slotIndex,
            date: shift.date,
            startTime: shift.startTime,
            endTime: shift.endTime,
            label: shift.label,
            durationHours: shift.durationHours,
            dayType: shift.dayType as "weekday" | "weekend",
            assignmentSource,
            isManual: assignmentSource === "manual",
            isEmergency: hasBackToBackPair,
            explanationCodes,
          };
        });
      return {
        respondentId: r.respondentId,
        name: r.name,
        category: r.category as "AFP" | "General",
        allocatedShifts,
        totalHours,
        isManuallyAdjusted: r.isManuallyAdjusted,
        penaltyNote: r.penaltyNote,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const allocatedShiftById = new Map(
    allocationsList.flatMap((allocation) =>
      allocation.allocatedShifts.map(
        (shift) =>
          [
            shift.shiftId,
            {
              ...shift,
              respondentId: allocation.respondentId,
              respondentName: allocation.name,
            },
          ] as const,
      ),
    ),
  );
  const renderedStartTimes = {
    weekday: new Set(["09:00", "11:00", "14:00", "17:00"]),
    weekend: new Set(["08:00", "12:00", "16:00"]),
  };
  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  const allocationAudit = shifts.map((shift) => {
    const assigned = allocatedShiftById.get(shift.id);
    const availableRespondents = availableRespondentsByShiftId.get(shift.id) ?? [];
    const isRenderedSlot =
      shift.dayType === "weekend"
        ? renderedStartTimes.weekend.has(shift.startTime)
        : renderedStartTimes.weekday.has(shift.startTime);
    const availableWithDiagnostics = availableRespondents.map((respondent) => {
      const existingShiftIds = (allocationShiftIdsByRespondentId.get(respondent.respondentId) ?? []).filter(
        (existingShiftId) => existingShiftId !== shift.id,
      );
      const sameDayAssignedShiftIds = existingShiftIds.filter((id) => shiftMap.get(id)?.date === shift.date);
      const alreadyAssignedMinutes = existingShiftIds.reduce(
        (sum, id) => sum + hoursToMinutes(shiftMap.get(id)?.durationHours ?? 0),
        0,
      );
      const currentNormalMinutes = existingShiftIds
        .filter((id) => !manualShiftIds.has(id) && (availableRespondentsByShiftId.get(id)?.length ?? 0) > 0)
        .reduce((sum, id) => sum + hoursToMinutes(shiftMap.get(id)?.durationHours ?? 0), 0);
      const baseSource =
        sameDayAllocationTier(shift.id, existingShiftIds, shiftMap) === 1
          ? "engine_back_to_back_emergency"
          : "engine_normal";
      const validation = canAssignShiftToRespondent({
        shiftId: shift.id,
        existingShiftIds,
        shiftMap,
        isAvailable: true,
        assignmentSource: baseSource,
        category: respondent.hasAfpCap ? "AFP" : "General",
        currentNormalMinutes,
        afpCapMinutes: hoursToMinutes(respondent.afpHoursCap),
      });
      const canTakeNormally = validation.ok && !validation.wouldBeBackToBackEmergency;
      const canTakeBackToBackEmergency = validation.ok && validation.wouldBeBackToBackEmergency;
      return {
        respondentId: respondent.respondentId,
        name: respondent.name,
        category: respondent.category as "AFP" | "General",
        penaltyHours: respondent.penaltyHours,
        afpCapHours: respondent.afpHoursCap,
        alreadyAssignedMinutes,
        sameDayAssignedShiftIds,
        canTakeNormally,
        canTakeBackToBackEmergency,
        blockers: validation.ok ? [] : validation.reasonCodes,
      };
    });

    const eligibleNormalCandidateCount = availableWithDiagnostics.filter(
      (respondent) => respondent.canTakeNormally,
    ).length;
    const eligibleBackToBackEmergencyCandidateCount = availableWithDiagnostics.filter(
      (respondent) => respondent.canTakeBackToBackEmergency,
    ).length;
    const placeholderSettings = latestNoAvailabilityPlaceholderSettingsBySurveyId.get(surveyId);
    const eligibleNoAvailabilityFallbackAfpCount =
      availableRespondents.length === 0 && placeholderSettings?.allowNoAvailabilityAfpPlaceholders
        ? Array.from(respondentSettingsById.values()).filter(
            (respondent) =>
              respondent.category === "AFP" &&
              placeholderSettings.noAvailabilityFallbackAfpIds.includes(respondent.respondentId),
          ).length
        : 0;
    const renderedCellIsBlank = assigned ? !isRenderedSlot : true;
    const assignedHasAvailability = assigned
      ? availableRespondents.some((respondent) => respondent.respondentId === assigned.respondentId)
      : false;
    const assignedIsNoAvailabilityPlaceholder =
      Boolean(assigned) &&
      isNoAvailabilityAfpPlaceholderSource(assigned!.assignmentSource) &&
      availableRespondents.length === 0;
    let reasonCategory = assigned
      ? assignedIsNoAvailabilityPlaceholder
        ? "NO_AVAILABILITY_AFP_PLACEHOLDER"
        : !assignedHasAvailability
          ? "AVAILABILITY_SHIFT_KEY_MISMATCH"
          : renderedCellIsBlank
            ? "RENDERING_ASSIGNMENT_MISMATCH"
            : "ASSIGNED"
      : availableRespondents.length === 0
        ? placeholderSettings?.allowNoAvailabilityAfpPlaceholders
          ? eligibleNoAvailabilityFallbackAfpCount > 0
            ? "FALLBACK_AFP_BLOCKED_BY_SAME_DAY_RULE"
            : "NO_FALLBACK_AFP_SELECTED"
          : "NO_AVAILABILITY"
        : eligibleNormalCandidateCount + eligibleBackToBackEmergencyCandidateCount > 0
          ? "ENGINE_REPAIR_LIMIT_REACHED"
          : availableWithDiagnostics.every((respondent) => respondent.blockers.includes("BLOCKED_BY_AFP_CAP"))
            ? "BLOCKED_ONLY_BY_AFP_CAP"
            : "ALL_AVAILABLE_BLOCKED_BY_MIXED_CONSTRAINTS";
    return {
      shiftId: shift.id,
      stableShiftKey: shift.stableShiftKey,
      date: shift.date,
      dayOfWeek: dayNames[new Date(`${shift.date}T00:00:00Z`).getUTCDay()] ?? "",
      startTime: shift.startTime,
      endTime: shift.endTime,
      slotIndex: shift.slotIndex,
      durationMinutes: hoursToMinutes(shift.durationHours),
      renderedCellIsBlank,
      allocationRecordExists: Boolean(assigned),
      assignedRespondentId: assigned ? String(assigned.respondentId) : null,
      assignedRespondentName: assigned?.respondentName ?? null,
      assignmentSource: assigned?.assignmentSource ?? null,
      availabilityCount: availableRespondents.length,
      availableRespondents: availableWithDiagnostics,
      eligibleNormalCandidateCount,
      eligibleBackToBackEmergencyCandidateCount,
      eligibleNoAvailabilityFallbackAfpCount,
      reasonCategory,
      explanationText: assigned
        ? assignedIsNoAvailabilityPlaceholder
          ? "No one selected this shift. It is assigned to an AFP as an emergency placeholder for visibility."
          : !assignedHasAvailability
            ? "An allocation record exists, but the assigned respondent did not select this shift."
            : renderedCellIsBlank
              ? "An allocation record exists, but the schedule renderer does not have a matching visible date/time cell."
              : "This shift is assigned and should render in the schedule."
        : availableRespondents.length === 0
          ? placeholderSettings?.allowNoAvailabilityAfpPlaceholders
            ? eligibleNoAvailabilityFallbackAfpCount > 0
              ? "No respondent selected availability for this shift, and selected AFP placeholders were blocked by same-day rules."
              : "No respondent selected availability for this shift, and no AFP placeholder respondent was selected."
            : "No respondent selected availability for this shift. It must remain uncovered unless placeholder mode is enabled."
          : eligibleNormalCandidateCount + eligibleBackToBackEmergencyCandidateCount > 0
            ? "This blank still has a legal available candidate and should be treated as an engine repair bug."
            : "Every available respondent is blocked by hard same-day or AFP cap constraints.",
    };
  });

  const blankShiftExplanations = unallocatedShiftIds.map((shiftId) => {
    const shift = shiftMap.get(shiftId)!;
    const auditRow = allocationAudit.find((row) => row.shiftId === shiftId)!;
    const reasonCategory =
      auditRow.reasonCategory === "NO_FALLBACK_AFP_SELECTED"
        ? "NO_FALLBACK_AFP_SELECTED"
        : auditRow.reasonCategory === "FALLBACK_AFP_BLOCKED_BY_SAME_DAY_RULE"
          ? "NO_AVAILABILITY"
          : auditRow.reasonCategory === "NO_AVAILABILITY"
            ? "NO_AVAILABILITY"
            : auditRow.reasonCategory === "BLOCKED_ONLY_BY_AFP_CAP"
              ? "ALL_AVAILABLE_BLOCKED_BY_AFP_CAP"
              : auditRow.availableRespondents.every((respondent) =>
                    respondent.blockers.some(
                      (blocker) =>
                        blocker === "BLOCKED_BY_MAX_TWO_SHIFTS_DAY" || blocker === "BLOCKED_BY_NON_ADJACENT_SAME_DAY",
                    ),
                  )
                ? "ALL_AVAILABLE_BLOCKED_BY_SAME_DAY"
                : "ALL_AVAILABLE_BLOCKED_BY_MIXED_CONSTRAINTS";

    return {
      shiftId,
      stableShiftKey: shift.stableShiftKey,
      slotIndex: shift.slotIndex,
      date: shift.date,
      label: shift.label,
      startTime: shift.startTime,
      endTime: shift.endTime,
      durationHours: shift.durationHours,
      availabilityCount: auditRow.availabilityCount,
      availableRespondents: auditRow.availableRespondents.map((respondent) => ({
        respondentId: respondent.respondentId,
        name: respondent.name,
        category: respondent.category,
        blockers: respondent.blockers.length > 0 ? respondent.blockers : ["ENGINE_REPAIR_LIMIT_REACHED"],
      })),
      reasonCategory,
      explanationCodes:
        auditRow.availabilityCount === 0
          ? (Array.from(
              new Set([
                "NO_AVAILABILITY",
                ...(auditRow.reasonCategory === "NO_FALLBACK_AFP_SELECTED" ||
                auditRow.reasonCategory === "FALLBACK_AFP_BLOCKED_BY_SAME_DAY_RULE"
                  ? [auditRow.reasonCategory as ExplanationCode]
                  : []),
              ]),
            ) as ExplanationCode[])
          : Array.from(
              new Set(
                auditRow.availableRespondents.flatMap((respondent) =>
                  respondent.blockers.length > 0 ? respondent.blockers : ["ENGINE_REPAIR_LIMIT_REACHED"],
                ),
              ),
            ),
      explanationText: auditRow.explanationText,
    };
  });

  const allHours = allocationsList.map((a) => a.totalHours);
  const avg = computeAverage(allHours);
  const std = computeStdDev(allHours, avg);

  return {
    surveyId,
    allocations: allocationsList,
    averageHours: avg,
    stdDev: std,
    unallocatedShiftIds,
    blankShiftExplanations,
    allocationAudit,
  };
}

router.post("/surveys/:id/allocate", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const [survey] = await db.select().from(surveysTable).where(eq(surveysTable.id, id));
  if (!survey) {
    res.status(404).json({ error: "Survey not found" });
    return;
  }

  if (survey.status !== "closed") {
    res.status(400).json({ error: "Survey must be closed before running allocation" });
    return;
  }

  const parsed = RunAllocationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const surveyRespondents = await db
    .select({
      respondentId: responsesTable.respondentId,
      category: respondentsTable.category,
    })
    .from(responsesTable)
    .innerJoin(respondentsTable, eq(responsesTable.respondentId, respondentsTable.id))
    .where(eq(responsesTable.surveyId, id));
  const surveyRespondentIdSet = new Set(surveyRespondents.map((entry) => entry.respondentId));
  const surveyAfpRespondentIdSet = new Set(
    surveyRespondents.filter((entry) => entry.category === "AFP").map((entry) => entry.respondentId),
  );
  const includedRespondentIds = dedupePositiveIntegerIds(parsed.data.includedRespondentIds);
  const effectiveIncludedRespondentIds =
    includedRespondentIds.length > 0 ? includedRespondentIds : Array.from(surveyRespondentIdSet);
  const afpRespondentIds = dedupePositiveIntegerIds(parsed.data.afpRespondentIds);
  const noAvailabilityFallbackAfpIds = dedupePositiveIntegerIds(
    parsed.data.noAvailabilityFallbackAfpIds ?? parsed.data.afpUnclaimedShiftRespondentIds,
  );
  const allowNoAvailabilityAfpPlaceholders = Boolean(parsed.data.allowNoAvailabilityAfpPlaceholders);

  const invalidIncludedRespondentIds = includedRespondentIds.filter(
    (respondentId) => !surveyRespondentIdSet.has(respondentId),
  );
  if (invalidIncludedRespondentIds.length > 0) {
    res.status(400).json({ error: "Included respondents must belong to this survey." });
    return;
  }

  const invalidAfpRespondentIds = afpRespondentIds.filter(
    (respondentId) => !surveyAfpRespondentIdSet.has(respondentId),
  );
  if (invalidAfpRespondentIds.length > 0) {
    res.status(400).json({
      error: "AFP cap can only be enabled for AFP respondents in this survey.",
    });
    return;
  }

  if (
    includedRespondentIds.length > 0 &&
    afpRespondentIds.some((respondentId) => !includedRespondentIds.includes(respondentId))
  ) {
    res.status(400).json({
      error: "AFP respondents must also be included in this allocation run.",
    });
    return;
  }

  if (noAvailabilityFallbackAfpIds.some((respondentId) => !surveyAfpRespondentIdSet.has(respondentId))) {
    res.status(400).json({
      error: "No-availability placeholder respondents must be AFP respondents.",
    });
    return;
  }

  if (
    includedRespondentIds.length > 0 &&
    noAvailabilityFallbackAfpIds.some((respondentId) => !includedRespondentIds.includes(respondentId))
  ) {
    res.status(400).json({
      error: "No-availability AFP respondents must also be included in this allocation run.",
    });
    return;
  }

  const preserveManualLocks = parsed.data.preserveManualLocks !== false;
  const existingManualAssignments =
    preserveManualLocks && effectiveIncludedRespondentIds.length > 0
      ? await db
          .select({
            respondentId: allocationsTable.respondentId,
            shiftId: allocationsTable.shiftId,
          })
          .from(allocationsTable)
          .where(
            and(
              eq(allocationsTable.surveyId, id),
              eq(allocationsTable.isManuallyAdjusted, true),
              inArray(allocationsTable.respondentId, effectiveIncludedRespondentIds),
            ),
          )
      : [];

  if (existingManualAssignments.length > 0) {
    const responseAvailability = await db
      .select({
        respondentId: responsesTable.respondentId,
        shiftId: responsesTable.shiftId,
      })
      .from(responsesTable)
      .where(eq(responsesTable.surveyId, id));
    const availableKeys = new Set(responseAvailability.map((row) => `${row.respondentId}:${row.shiftId}`));
    const invalidManualLocks = existingManualAssignments.filter(
      (assignment) => !availableKeys.has(`${assignment.respondentId}:${assignment.shiftId}`),
    );
    if (invalidManualLocks.length > 0) {
      res.status(400).json({
        error:
          "Existing manual assignments include shifts the respondent did not select. Turn off manual-lock preservation or remove those manual assignments before rerunning.",
      });
      return;
    }
  }

  const result = await runAllocation({
    surveyId: id,
    afpRespondentIds,
    afpUnclaimedShiftRespondentIds: noAvailabilityFallbackAfpIds,
    noAvailabilityFallbackAfpIds,
    allowNoAvailabilityAfpPlaceholders,
    includedRespondentIds: effectiveIncludedRespondentIds,
    allowAfpOverCapForAvailableShifts: parsed.data.allowAfpOverCapForAvailableShifts ?? false,
    existingManualAssignments,
  });
  let createdSnapshotId: number | null = null;
  await db.transaction(async (tx) => {
    const currentAllocations = await tx
      .select({
        respondentId: allocationsTable.respondentId,
        shiftId: allocationsTable.shiftId,
        isManuallyAdjusted: allocationsTable.isManuallyAdjusted,
        penaltyNote: allocationsTable.penaltyNote,
      })
      .from(allocationsTable)
      .where(eq(allocationsTable.surveyId, id));
    if (currentAllocations.length > 0) {
      const [snapshot] = await tx
        .insert(allocationSnapshotsTable)
        .values({
          surveyId: id,
          label: "Before allocation rerun",
          reason: "before_allocation",
          allocations: currentAllocations,
          allocationIncludedRespondentIds: survey.allocationIncludedRespondentIds ?? null,
        })
        .returning({ id: allocationSnapshotsTable.id });
      createdSnapshotId = snapshot?.id ?? null;
    }

    if (preserveManualLocks) {
      const excludedRespondentIds = Array.from(surveyRespondentIdSet).filter(
        (respondentId) => !effectiveIncludedRespondentIds.includes(respondentId),
      );
      if (excludedRespondentIds.length > 0) {
        await tx
          .delete(allocationsTable)
          .where(and(eq(allocationsTable.surveyId, id), inArray(allocationsTable.respondentId, excludedRespondentIds)));
      }
      await tx
        .delete(allocationsTable)
        .where(and(eq(allocationsTable.surveyId, id), eq(allocationsTable.isManuallyAdjusted, false)));
    } else {
      await tx.delete(allocationsTable).where(eq(allocationsTable.surveyId, id));
    }

    const generatedAssignments = result.assignments
      .filter((assignment) => assignment.source !== "manual")
      .map((assignment) => ({
        surveyId: id,
        respondentId: assignment.respondentId,
        shiftId: assignment.shiftId,
        isManuallyAdjusted: false,
        penaltyNote: null,
      }));
    if (generatedAssignments.length > 0) {
      await tx.insert(allocationsTable).values(generatedAssignments);
    }
    await tx
      .update(surveysTable)
      .set({ allocationIncludedRespondentIds: effectiveIncludedRespondentIds })
      .where(eq(surveysTable.id, id));
  });

  latestFairnessDiagnosticsBySurveyId.set(id, result.fairnessDiagnostics);
  latestNoAvailabilityPlaceholderSettingsBySurveyId.set(id, {
    allowNoAvailabilityAfpPlaceholders,
    noAvailabilityFallbackAfpIds,
  });

  const allocationResult = await buildAllocationResult(id);
  res.json({ ...allocationResult, createdSnapshotId });
});

router.post("/surveys/:id/allocations/dry-run", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const [survey] = await db.select().from(surveysTable).where(eq(surveysTable.id, id));
  if (!survey) {
    res.status(404).json({ error: "Survey not found" });
    return;
  }

  const parsed = RunAllocationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const surveyRespondents = await db
    .select({
      respondentId: responsesTable.respondentId,
      category: respondentsTable.category,
    })
    .from(responsesTable)
    .innerJoin(respondentsTable, eq(responsesTable.respondentId, respondentsTable.id))
    .where(eq(responsesTable.surveyId, id));
  const surveyRespondentIdSet = new Set(surveyRespondents.map((entry) => entry.respondentId));
  const surveyAfpRespondentIdSet = new Set(
    surveyRespondents.filter((entry) => entry.category === "AFP").map((entry) => entry.respondentId),
  );
  const includedRespondentIds = dedupePositiveIntegerIds(parsed.data.includedRespondentIds);
  const effectiveIncludedRespondentIds =
    includedRespondentIds.length > 0 ? includedRespondentIds : Array.from(surveyRespondentIdSet);
  const afpRespondentIds = dedupePositiveIntegerIds(parsed.data.afpRespondentIds);
  const noAvailabilityFallbackAfpIds = dedupePositiveIntegerIds(
    parsed.data.noAvailabilityFallbackAfpIds ?? parsed.data.afpUnclaimedShiftRespondentIds,
  );
  const allowNoAvailabilityAfpPlaceholders = Boolean(parsed.data.allowNoAvailabilityAfpPlaceholders);

  if (includedRespondentIds.some((respondentId) => !surveyRespondentIdSet.has(respondentId))) {
    res.status(400).json({ error: "Included respondents must belong to this survey." });
    return;
  }
  if (afpRespondentIds.some((respondentId) => !surveyAfpRespondentIdSet.has(respondentId))) {
    res.status(400).json({
      error: "AFP cap can only be enabled for AFP respondents in this survey.",
    });
    return;
  }
  if (noAvailabilityFallbackAfpIds.some((respondentId) => !surveyAfpRespondentIdSet.has(respondentId))) {
    res.status(400).json({
      error: "No-availability placeholder respondents must be AFP respondents.",
    });
    return;
  }
  if (
    includedRespondentIds.length > 0 &&
    afpRespondentIds.some((respondentId) => !includedRespondentIds.includes(respondentId))
  ) {
    res.status(400).json({
      error: "AFP respondents with a cap must also be included in this allocation run.",
    });
    return;
  }
  if (
    includedRespondentIds.length > 0 &&
    noAvailabilityFallbackAfpIds.some((respondentId) => !includedRespondentIds.includes(respondentId))
  ) {
    res.status(400).json({
      error: "No-availability AFP respondents must also be included in this allocation run.",
    });
    return;
  }

  const preserveManualLocks = parsed.data.preserveManualLocks !== false;
  const existingManualAssignments =
    preserveManualLocks && effectiveIncludedRespondentIds.length > 0
      ? await db
          .select({
            respondentId: allocationsTable.respondentId,
            shiftId: allocationsTable.shiftId,
          })
          .from(allocationsTable)
          .where(
            and(
              eq(allocationsTable.surveyId, id),
              eq(allocationsTable.isManuallyAdjusted, true),
              inArray(allocationsTable.respondentId, effectiveIncludedRespondentIds),
            ),
          )
      : [];

  if (existingManualAssignments.length > 0) {
    const responseAvailability = await db
      .select({
        respondentId: responsesTable.respondentId,
        shiftId: responsesTable.shiftId,
      })
      .from(responsesTable)
      .where(eq(responsesTable.surveyId, id));
    const availableKeys = new Set(responseAvailability.map((row) => `${row.respondentId}:${row.shiftId}`));
    const invalidManualLocks = existingManualAssignments.filter(
      (assignment) => !availableKeys.has(`${assignment.respondentId}:${assignment.shiftId}`),
    );
    if (invalidManualLocks.length > 0) {
      res.status(400).json({
        error:
          "Existing manual assignments include shifts the respondent did not select. Turn off manual-lock preservation or remove those manual assignments before dry-running.",
      });
      return;
    }
  }

  const [shifts, responseRows] = await Promise.all([
    db.select().from(shiftsTable).where(eq(shiftsTable.surveyId, id)),
    db
      .select({
        respondentId: responsesTable.respondentId,
        shiftId: responsesTable.shiftId,
        hasPenalty: responsesTable.hasPenalty,
        penaltyHours: responsesTable.penaltyHours,
        hasAfpCap: responsesTable.hasAfpCap,
        afpHoursCap: responsesTable.afpHoursCap,
      })
      .from(responsesTable)
      .where(eq(responsesTable.surveyId, id)),
  ]);
  const availabilityByShiftId = new Map<number, Set<number>>();
  for (const shift of shifts) availabilityByShiftId.set(shift.id, new Set());
  const effectiveIncludedIdSet = new Set(effectiveIncludedRespondentIds);
  for (const row of responseRows.filter((response) => effectiveIncludedIdSet.has(response.respondentId))) {
    availabilityByShiftId.get(row.shiftId)?.add(row.respondentId);
  }

  const result = await runAllocation({
    surveyId: id,
    afpRespondentIds,
    afpUnclaimedShiftRespondentIds: noAvailabilityFallbackAfpIds,
    noAvailabilityFallbackAfpIds,
    allowNoAvailabilityAfpPlaceholders,
    includedRespondentIds: effectiveIncludedRespondentIds,
    allowAfpOverCapForAvailableShifts: parsed.data.allowAfpOverCapForAvailableShifts ?? false,
    existingManualAssignments,
  });

  const assignmentByShiftId = new Map(result.assignments.map((assignment) => [assignment.shiftId, assignment]));
  const unallocatedShiftIds = shifts.map((shift) => shift.id).filter((shiftId) => !assignmentByShiftId.has(shiftId));
  const illegalAssignmentsWithoutAvailability = result.assignments.filter((assignment) => {
    const available = availabilityByShiftId.get(assignment.shiftId) ?? new Set<number>();
    if (available.has(assignment.respondentId)) return false;
    return !(assignment.source === NO_AVAILABILITY_AFP_PLACEHOLDER_SOURCE && available.size === 0);
  });
  const blankWithAvailabilityCount = unallocatedShiftIds.filter(
    (shiftId) => (availabilityByShiftId.get(shiftId)?.size ?? 0) > 0,
  ).length;
  const blankZeroAvailabilityShiftCount = unallocatedShiftIds.filter(
    (shiftId) => (availabilityByShiftId.get(shiftId)?.size ?? 0) === 0,
  ).length;
  const placeholderAssignments = result.assignments.filter(
    (assignment) => assignment.source === NO_AVAILABILITY_AFP_PLACEHOLDER_SOURCE,
  );
  const shiftById = new Map(shifts.map((shift) => [shift.id, shift] as const));
  const manualOwnerByShiftId = new Map(
    existingManualAssignments.map((assignment) => [assignment.shiftId, assignment.respondentId] as const),
  );
  const dryRunSettingsByRespondentId = new Map<
    number,
    {
      hasPenalty: boolean;
      penaltyHours: number;
      hasAfpCap: boolean;
      afpHoursCap: number;
      availableShiftIds: Set<number>;
    }
  >();
  for (const response of responseRows.filter((row) => effectiveIncludedIdSet.has(row.respondentId))) {
    const current = dryRunSettingsByRespondentId.get(response.respondentId) ?? {
      hasPenalty: false,
      penaltyHours: 0,
      hasAfpCap: false,
      afpHoursCap: Math.max(0, response.afpHoursCap ?? 10),
      availableShiftIds: new Set<number>(),
    };
    current.hasPenalty = current.hasPenalty || Boolean(response.hasPenalty);
    current.penaltyHours = Math.max(current.penaltyHours, response.hasPenalty ? (response.penaltyHours ?? 0) : 0);
    current.hasAfpCap =
      current.hasAfpCap || afpRespondentIds.includes(response.respondentId) || Boolean(response.hasAfpCap);
    current.afpHoursCap = Math.max(0, response.afpHoursCap ?? current.afpHoursCap);
    current.availableShiftIds.add(response.shiftId);
    dryRunSettingsByRespondentId.set(response.respondentId, current);
  }
  const dryRunCapacityMinutesByRespondentId = new Map<number, number>();
  const dryRunTargetInputs = Array.from(dryRunSettingsByRespondentId.entries())
    .filter(([, settings]) => !settings.hasAfpCap)
    .map(([respondentId, settings]) => {
      const mandatoryShiftIds = new Set(
        existingManualAssignments
          .filter((assignment) => assignment.respondentId === respondentId)
          .map((assignment) => assignment.shiftId),
      );
      const capacityShifts = shifts.filter((shift) => {
        const manualOwner = manualOwnerByShiftId.get(shift.id);
        return manualOwner === undefined ? settings.availableShiftIds.has(shift.id) : manualOwner === respondentId;
      });
      const capacityMinutes = maxFeasibleShiftCapacityMinutes(capacityShifts, mandatoryShiftIds);
      dryRunCapacityMinutesByRespondentId.set(respondentId, capacityMinutes);
      return {
        respondentId,
        penaltyMinutes: hoursToMinutes(settings.penaltyHours),
        capacityMinutes,
        minimumMinutes: Array.from(mandatoryShiftIds).reduce(
          (sum, shiftId) => sum + hoursToMinutes(shiftById.get(shiftId)?.durationHours ?? 0),
          0,
        ),
      };
    });
  for (const [respondentId, settings] of dryRunSettingsByRespondentId) {
    if (!settings.hasAfpCap) continue;
    const mandatoryShiftIds = new Set(
      existingManualAssignments
        .filter((assignment) => assignment.respondentId === respondentId)
        .map((assignment) => assignment.shiftId),
    );
    const capacityShifts = shifts.filter((shift) => {
      const manualOwner = manualOwnerByShiftId.get(shift.id);
      return manualOwner === undefined ? settings.availableShiftIds.has(shift.id) : manualOwner === respondentId;
    });
    dryRunCapacityMinutesByRespondentId.set(
      respondentId,
      maxFeasibleShiftCapacityMinutes(capacityShifts, mandatoryShiftIds),
    );
  }
  const dryRunTotalStaffedMinutes = result.assignments.reduce(
    (sum, assignment) => sum + hoursToMinutes(shiftById.get(assignment.shiftId)?.durationHours ?? 0),
    0,
  );
  const dryRunCappedAfpMinutes = result.plans.reduce((sum, plan) => {
    const settings = dryRunSettingsByRespondentId.get(plan.respondentId);
    return settings?.hasAfpCap ? sum + hoursToMinutes(plan.totalHours) : sum;
  }, 0);
  const dryRunTargetResult = solveNonAfpPenaltyTargets(
    dryRunTargetInputs,
    Math.max(0, dryRunTotalStaffedMinutes - dryRunCappedAfpMinutes),
  );
  const dryRunTargetByRespondentId = new Map(
    dryRunTargetResult.targets.map((target) => [target.respondentId, target] as const),
  );
  const dryRunComparisonSummary = summarizeGeneralFairnessComparison(
    result.plans.flatMap((plan) => {
      const settings = dryRunSettingsByRespondentId.get(plan.respondentId);
      if (!settings || settings.hasAfpCap) return [];
      return [
        {
          totalHours: plan.totalHours,
          hasPenalty: settings.hasPenalty,
          capacityLimited: dryRunTargetByRespondentId.get(plan.respondentId)?.capacityLimited ?? false,
        },
      ];
    }),
  );
  const dryRunRespondentPlans = result.plans.map((plan) => {
    const settings = dryRunSettingsByRespondentId.get(plan.respondentId);
    const generalTarget = dryRunTargetByRespondentId.get(plan.respondentId);
    const availableCapacityMinutes = dryRunCapacityMinutesByRespondentId.get(plan.respondentId) ?? 0;
    const hasAfpCap = settings?.hasAfpCap ?? false;
    const afpCapMinutes = hoursToMinutes(settings?.afpHoursCap ?? 10);
    const targetMinutes = hasAfpCap
      ? Math.min(afpCapMinutes, availableCapacityMinutes)
      : (generalTarget?.targetMinutes ?? 0);
    const neutralTargetMinutes = hasAfpCap ? targetMinutes : (generalTarget?.neutralTargetMinutes ?? 0);
    const countedAfpMinutes = hasAfpCap
      ? result.assignments
          .filter(
            (assignment) =>
              assignment.respondentId === plan.respondentId &&
              !isNoAvailabilityAfpPlaceholderSource(assignment.source),
          )
          .reduce(
            (sum, assignment) =>
              sum + hoursToMinutes(shiftById.get(assignment.shiftId)?.durationHours ?? 0),
            0,
          )
      : hoursToMinutes(plan.totalHours);
    const shiftCountsByDate = plan.shiftIds.reduce((counts, shiftId) => {
      const date = shiftById.get(shiftId)?.date;
      if (date) counts.set(date, (counts.get(date) ?? 0) + 1);
      return counts;
    }, new Map<string, number>());
    return {
      respondentId: plan.respondentId,
      name: plan.name,
      category: plan.category,
      totalHours: plan.totalHours,
      targetHours: minutesToHours(targetMinutes),
      neutralTargetHours: minutesToHours(neutralTargetMinutes),
      availableCapacityHours: minutesToHours(availableCapacityMinutes),
      deviationFromTargetHours: minutesToHours(countedAfpMinutes - targetMinutes),
      hasPenalty: settings?.hasPenalty ?? false,
      penaltyHours: settings?.penaltyHours ?? 0,
      effectivePenaltyHours: minutesToHours(generalTarget?.effectivePenaltyMinutes ?? 0),
      unappliedPenaltyHours: minutesToHours(generalTarget?.unappliedPenaltyMinutes ?? 0),
      hasAfpCap,
      capacityLimited: hasAfpCap
        ? availableCapacityMinutes + 1e-6 < afpCapMinutes
        : (generalTarget?.capacityLimited ?? false),
      sameDayDoubleCount: Array.from(shiftCountsByDate.values()).filter((count) => count === 2).length,
    };
  });

  res.json({
    surveyId: id,
    dryRun: true,
    totalShifts: shifts.length,
    assignedShifts: result.assignments.length,
    normalAssignedShifts: result.assignments.filter((assignment) => assignment.source === "engine_normal").length,
    blankShifts: unallocatedShiftIds.length,
    blankWithAvailabilityCount,
    blankZeroAvailabilityShiftCount,
    allowedNoAvailabilityAfpPlaceholderAssignments: placeholderAssignments.length,
    illegalAssignmentsWithoutAvailability: illegalAssignmentsWithoutAvailability.length,
    nonPenalizedGeneralMeanHours: dryRunComparisonSummary.meanHours,
    nonPenalizedGeneralStdDevHours: dryRunComparisonSummary.stdDevHours,
    nonPenalizedGeneralRangeHours: dryRunComparisonSummary.rangeHours,
    fairnessRepairMoveCount: result.fairnessDiagnostics.successfulRepairMoves,
    highStdDevReasonCodes: result.fairnessDiagnostics.highStdDevReasonCodes,
    optimizationMethod: result.fairnessDiagnostics.optimizationMethod ?? "greedy_fallback",
    optimizerStatus: result.fairnessDiagnostics.optimizerStatus ?? "unknown",
    optimalCoverageProven: result.fairnessDiagnostics.optimalCoverageProven ?? false,
    backToBackPairDays: result.fairnessDiagnostics.backToBackPairDays ?? 0,
    backToBackEmergencyAssignments: result.assignments.filter(
      (assignment) => assignment.source === "engine_back_to_back_emergency",
    ).length,
    afpCapOverflowAssignments: result.assignments.filter(
      (assignment) => assignment.source === "engine_afp_cap_overflow_available",
    ).length,
    noAvailabilityAfpPlaceholderAssignments: placeholderAssignments.length,
    settings: {
      allowNoAvailabilityAfpPlaceholders,
      noAvailabilityFallbackAfpIds,
      allowAfpOverCapForAvailableShifts: parsed.data.allowAfpOverCapForAvailableShifts ?? false,
      preserveManualLocks,
    },
    respondentPlans: dryRunRespondentPlans,
    assignments: result.assignments,
    unallocatedShiftIds,
  });
});

router.get("/surveys/:id/allocations", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const [survey] = await db.select().from(surveysTable).where(eq(surveysTable.id, id));
  if (!survey) {
    res.status(404).json({ error: "Survey not found" });
    return;
  }

  const allocationResult = await buildAllocationResult(id);
  res.json(allocationResult);
});

router.get("/surveys/:id/allocation-snapshots", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const [survey] = await db.select().from(surveysTable).where(eq(surveysTable.id, id));
  if (!survey) {
    res.status(404).json({ error: "Survey not found" });
    return;
  }

  const snapshots = await db
    .select({
      id: allocationSnapshotsTable.id,
      surveyId: allocationSnapshotsTable.surveyId,
      label: allocationSnapshotsTable.label,
      reason: allocationSnapshotsTable.reason,
      allocations: allocationSnapshotsTable.allocations,
      createdAt: allocationSnapshotsTable.createdAt,
    })
    .from(allocationSnapshotsTable)
    .where(eq(allocationSnapshotsTable.surveyId, id))
    .orderBy(desc(allocationSnapshotsTable.createdAt), desc(allocationSnapshotsTable.id))
    .limit(20);

  res.json(
    snapshots.map((snapshot) => ({
      id: snapshot.id,
      surveyId: snapshot.surveyId,
      label: snapshot.label,
      reason: snapshot.reason,
      allocationCount: snapshot.allocations.length,
      createdAt: snapshot.createdAt,
    })),
  );
});

router.post("/surveys/:id/allocation-snapshots/:snapshotId/restore", async (req, res): Promise<void> => {
  const rawSurveyId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const rawSnapshotId = Array.isArray(req.params.snapshotId) ? req.params.snapshotId[0] : req.params.snapshotId;
  const id = parseInt(rawSurveyId, 10);
  const snapshotId = parseInt(rawSnapshotId, 10);
  if (isNaN(id) || isNaN(snapshotId)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const [survey] = await db.select().from(surveysTable).where(eq(surveysTable.id, id));
  if (!survey) {
    res.status(404).json({ error: "Survey not found" });
    return;
  }

  const [snapshot] = await db
    .select()
    .from(allocationSnapshotsTable)
    .where(and(eq(allocationSnapshotsTable.id, snapshotId), eq(allocationSnapshotsTable.surveyId, id)))
    .limit(1);
  if (!snapshot) {
    res.status(404).json({ error: "Allocation snapshot not found" });
    return;
  }

  const validatedSnapshot = validateAllocationSnapshotEntries(snapshot.allocations);
  if (!validatedSnapshot.ok) {
    res.status(409).json({ error: validatedSnapshot.reason });
    return;
  }

  const [surveyShifts, surveyResponses] = await Promise.all([
    db.select({ id: shiftsTable.id }).from(shiftsTable).where(eq(shiftsTable.surveyId, id)),
    db
      .select({ respondentId: responsesTable.respondentId })
      .from(responsesTable)
      .where(eq(responsesTable.surveyId, id)),
  ]);
  const validShiftIds = new Set(surveyShifts.map((shift) => shift.id));
  const validRespondentIds = new Set(surveyResponses.map((response) => response.respondentId));
  const invalidAllocation = validatedSnapshot.entries.some(
    (entry) => !validShiftIds.has(entry.shiftId) || !validRespondentIds.has(entry.respondentId),
  );
  const snapshotIncludedRespondentIds = snapshot.allocationIncludedRespondentIds ?? null;
  const invalidIncludedRespondentId =
    snapshotIncludedRespondentIds !== null &&
    snapshotIncludedRespondentIds.some(
      (respondentId) => !Number.isInteger(respondentId) || respondentId <= 0 || !validRespondentIds.has(respondentId),
    );
  if (invalidAllocation || invalidIncludedRespondentId) {
    res.status(409).json({
      error: "This snapshot references a shift or respondent that is no longer active in the survey.",
    });
    return;
  }

  let undoSnapshotId: number | null = null;
  await db.transaction(async (tx) => {
    const currentAllocations = await tx
      .select({
        respondentId: allocationsTable.respondentId,
        shiftId: allocationsTable.shiftId,
        isManuallyAdjusted: allocationsTable.isManuallyAdjusted,
        penaltyNote: allocationsTable.penaltyNote,
      })
      .from(allocationsTable)
      .where(eq(allocationsTable.surveyId, id));
    const [undoSnapshot] = await tx
      .insert(allocationSnapshotsTable)
      .values({
        surveyId: id,
        label: `Before restoring snapshot ${snapshot.id}`,
        reason: "before_restore",
        allocations: currentAllocations,
        allocationIncludedRespondentIds: survey.allocationIncludedRespondentIds ?? null,
      })
      .returning({ id: allocationSnapshotsTable.id });
    undoSnapshotId = undoSnapshot?.id ?? null;

    await tx.delete(allocationsTable).where(eq(allocationsTable.surveyId, id));
    if (validatedSnapshot.entries.length > 0) {
      await tx.insert(allocationsTable).values(
        validatedSnapshot.entries.map((entry) => ({
          surveyId: id,
          respondentId: entry.respondentId,
          shiftId: entry.shiftId,
          isManuallyAdjusted: entry.isManuallyAdjusted,
          penaltyNote: entry.penaltyNote,
        })),
      );
    }
    await tx
      .update(surveysTable)
      .set({
        allocationIncludedRespondentIds: snapshotIncludedRespondentIds,
      })
      .where(eq(surveysTable.id, id));
  });

  latestFairnessDiagnosticsBySurveyId.delete(id);
  latestNoAvailabilityPlaceholderSettingsBySurveyId.delete(id);
  const allocationResult = await buildAllocationResult(id);
  res.json({
    ...allocationResult,
    restoredSnapshotId: snapshot.id,
    undoSnapshotId,
  });
});

router.patch("/surveys/:id/allocations/adjust", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const [survey] = await db.select().from(surveysTable).where(eq(surveysTable.id, id));
  if (!survey) {
    res.status(404).json({ error: "Survey not found" });
    return;
  }

  const parsed = AdjustAllocationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const shiftIdsToAdd = dedupePositiveIntegerIds(parsed.data.shiftIdsToAdd);
  const shiftIdsToRemove = dedupePositiveIntegerIds(parsed.data.shiftIdsToRemove);
  const penaltyNoteResult = normalizeOptionalText(parsed.data.penaltyNote, "Penalty note", FIELD_LIMITS.penaltyNote);
  if (!penaltyNoteResult.ok) {
    res.status(400).json({ error: penaltyNoteResult.error });
    return;
  }

  const { respondentId } = parsed.data;
  const [respondent] = await db
    .select({ id: respondentsTable.id, category: respondentsTable.category })
    .from(respondentsTable)
    .where(eq(respondentsTable.id, respondentId))
    .limit(1);
  if (!respondent) {
    res.status(404).json({ error: "Respondent not found" });
    return;
  }

  const surveyShiftRows = await db.select().from(shiftsTable).where(eq(shiftsTable.surveyId, id));
  const surveyShiftIdSet = new Set(surveyShiftRows.map((shift) => shift.id));
  const invalidShiftIds = [...shiftIdsToAdd, ...shiftIdsToRemove].filter((shiftId) => !surveyShiftIdSet.has(shiftId));
  if (invalidShiftIds.length > 0) {
    res.status(400).json({ error: "Shift adjustments must belong to this survey." });
    return;
  }

  const manualSlotIndexes = deriveShiftSlotIndexes(surveyShiftRows);
  const manualShiftMap = new Map(
    surveyShiftRows.map((shift) => {
      const slotIndex = manualSlotIndexes.get(shift.id) ?? 0;
      return [shift.id, { ...shift, slotIndex }] as const;
    }),
  );
  const availabilityRows = await db
    .select({ shiftId: responsesTable.shiftId })
    .from(responsesTable)
    .where(and(eq(responsesTable.surveyId, id), eq(responsesTable.respondentId, respondentId)));
  const effectiveAllocationRespondentIds = new Set(await getEffectiveAllocationRespondentIds(id));
  const surveyAvailabilityRows = (
    await db
      .select({
        respondentId: responsesTable.respondentId,
        shiftId: responsesTable.shiftId,
      })
      .from(responsesTable)
      .where(eq(responsesTable.surveyId, id))
  ).filter((row) => effectiveAllocationRespondentIds.has(row.respondentId));
  const availabilityCountByShiftId = new Map<number, number>();
  for (const row of surveyAvailabilityRows) {
    availabilityCountByShiftId.set(row.shiftId, (availabilityCountByShiftId.get(row.shiftId) ?? 0) + 1);
  }
  const availableShiftIdSet = new Set(availabilityRows.map((row) => row.shiftId));
  const existingTargetAssignments = await db
    .select({ shiftId: allocationsTable.shiftId })
    .from(allocationsTable)
    .where(and(eq(allocationsTable.surveyId, id), eq(allocationsTable.respondentId, respondentId)));
  const plannedShiftIds = new Set(
    existingTargetAssignments
      .map((assignment) => assignment.shiftId)
      .filter((shiftId) => !shiftIdsToRemove.includes(shiftId)),
  );
  const placeholderShiftIdsToAdd = new Set<number>();
  for (const shiftId of shiftIdsToAdd) {
    const shiftAvailabilityCount = availabilityCountByShiftId.get(shiftId) ?? 0;
    const isAvailable = availableShiftIdSet.has(shiftId);
    const isPlaceholderAdjustment =
      parsed.data.noAvailabilityAfpPlaceholder === true &&
      respondent.category === "AFP" &&
      shiftAvailabilityCount === 0 &&
      !isAvailable;
    if (!isAvailable && !isPlaceholderAdjustment) {
      res.status(400).json({
        error: "Manual assignments require that the respondent selected the shift.",
      });
      return;
    }
    const validation = canAssignShiftToRespondent({
      shiftId,
      existingShiftIds: Array.from(plannedShiftIds).filter((existingShiftId) => existingShiftId !== shiftId),
      shiftMap: manualShiftMap,
      isAvailable,
      availabilityCount: shiftAvailabilityCount,
      assignmentSource: isPlaceholderAdjustment ? NO_AVAILABILITY_AFP_PLACEHOLDER_SOURCE : "manual",
      category: respondent.category as "AFP" | "General",
      allowNoAvailabilityAfpPlaceholder: isPlaceholderAdjustment,
      isEligibleNoAvailabilityAfpPlaceholder: isPlaceholderAdjustment,
    });
    if (!validation.ok) {
      res.status(400).json({
        error: `${isPlaceholderAdjustment ? "No-availability AFP placeholder" : "Manual assignment"} violates hard allocation rules: ${validation.reasonCodes.join(", ")}`,
      });
      return;
    }
    if (isPlaceholderAdjustment) placeholderShiftIdsToAdd.add(shiftId);
    plannedShiftIds.add(shiftId);
  }

  let createdSnapshotId: number | null = null;
  await db.transaction(async (tx) => {
    const currentAllocations = await tx
      .select({
        respondentId: allocationsTable.respondentId,
        shiftId: allocationsTable.shiftId,
        isManuallyAdjusted: allocationsTable.isManuallyAdjusted,
        penaltyNote: allocationsTable.penaltyNote,
      })
      .from(allocationsTable)
      .where(eq(allocationsTable.surveyId, id));
    const [snapshot] = await tx
      .insert(allocationSnapshotsTable)
      .values({
        surveyId: id,
        label: "Before manual allocation adjustment",
        reason: "before_manual_adjustment",
        allocations: currentAllocations,
        allocationIncludedRespondentIds: survey.allocationIncludedRespondentIds ?? null,
      })
      .returning({ id: allocationSnapshotsTable.id });
    createdSnapshotId = snapshot?.id ?? null;

    if (shiftIdsToRemove.length > 0) {
      await tx
        .delete(allocationsTable)
        .where(
          and(
            eq(allocationsTable.surveyId, id),
            eq(allocationsTable.respondentId, respondentId),
            inArray(allocationsTable.shiftId, shiftIdsToRemove),
          ),
        );
    }

    for (const shiftId of shiftIdsToAdd) {
      await tx
        .delete(allocationsTable)
        .where(and(eq(allocationsTable.surveyId, id), eq(allocationsTable.shiftId, shiftId)));

      const existingForTarget = await tx
        .select()
        .from(allocationsTable)
        .where(
          and(
            eq(allocationsTable.surveyId, id),
            eq(allocationsTable.respondentId, respondentId),
            eq(allocationsTable.shiftId, shiftId),
          ),
        )
        .limit(1);
      if (existingForTarget.length === 0) {
        await tx.insert(allocationsTable).values({
          surveyId: id,
          respondentId,
          shiftId,
          isManuallyAdjusted: !placeholderShiftIdsToAdd.has(shiftId),
          penaltyNote: penaltyNoteResult.value,
        });
      }
    }

    if (
      !parsed.data.noAvailabilityAfpPlaceholder &&
      (parsed.data.penaltyNote !== undefined || shiftIdsToAdd.length > 0 || shiftIdsToRemove.length > 0)
    ) {
      await tx
        .update(allocationsTable)
        .set({
          isManuallyAdjusted: true,
          penaltyNote: penaltyNoteResult.value,
        })
        .where(and(eq(allocationsTable.surveyId, id), eq(allocationsTable.respondentId, respondentId)));
    }
  });

  latestFairnessDiagnosticsBySurveyId.delete(id);
  const allocationResult = await buildAllocationResult(id);
  res.json({ ...allocationResult, createdSnapshotId });
});

router.get("/surveys/:id/allocation-stats", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const [survey] = await db.select().from(surveysTable).where(eq(surveysTable.id, id));
  if (!survey) {
    res.status(404).json({ error: "Survey not found" });
    return;
  }

  const allocationResult = await buildAllocationResult(id);
  const { allocations } = allocationResult;
  const allAllocatedShifts = allocations.flatMap((allocation) =>
    allocation.allocatedShifts.map((shift) => ({
      ...shift,
      respondentId: allocation.respondentId,
    })),
  );
  const assignmentsWithoutAvailability = allocationResult.allocationAudit.filter(
    (row) => row.allocationRecordExists && row.reasonCategory === "AVAILABILITY_SHIFT_KEY_MISMATCH",
  );
  const normalAssignmentsWithoutAvailability = assignmentsWithoutAvailability.filter(
    (row) =>
      row.assignmentSource === "engine_normal" ||
      row.assignmentSource === "engine_back_to_back_emergency" ||
      row.assignmentSource === "engine_afp_cap_overflow_available",
  ).length;
  const manualAssignmentsWithoutAvailability = assignmentsWithoutAvailability.filter(
    (row) => row.assignmentSource === "manual",
  ).length;
  const fallbackAssignmentsWithoutAvailability = assignmentsWithoutAvailability.filter(
    (row) =>
      row.assignmentSource !== null && isNoAvailabilityAfpPlaceholderSource(row.assignmentSource as AssignmentSource),
  ).length;
  const allowedNoAvailabilityAfpPlaceholderAssignments = allAllocatedShifts.filter((shift) =>
    isNoAvailabilityAfpPlaceholderSource(shift.assignmentSource),
  ).length;
  const illegalAssignmentsWithoutAvailability = assignmentsWithoutAvailability.length;
  const manualAssignmentCount = allAllocatedShifts.filter((shift) => shift.isManual).length;
  const manualShiftIdsForStats = new Set(
    allAllocatedShifts.filter((shift) => shift.isManual).map((shift) => shift.shiftId),
  );
  const manualMinutesByRespondentId = allAllocatedShifts.reduce((minutesByRespondentId, shift) => {
    if (!shift.isManual) return minutesByRespondentId;
    minutesByRespondentId.set(
      shift.respondentId,
      (minutesByRespondentId.get(shift.respondentId) ?? 0) + hoursToMinutes(shift.durationHours),
    );
    return minutesByRespondentId;
  }, new Map<number, number>());
  const backToBackEmergencyCount = allAllocatedShifts.filter(
    (shift) => shift.assignmentSource === "engine_back_to_back_emergency",
  ).length;
  const noAvailabilityFallbackCount = allAllocatedShifts.filter((shift) =>
    isNoAvailabilityAfpPlaceholderSource(shift.assignmentSource),
  ).length;
  const afpCapOverflowCount = allAllocatedShifts.filter(
    (shift) => shift.assignmentSource === "engine_afp_cap_overflow_available",
  ).length;
  let nonAdjacentSameDayDoubleCount = 0;
  let tripleShiftDayCount = 0;
  for (const allocation of allocations) {
    const byDate = new Map<string, typeof allocation.allocatedShifts>();
    for (const shift of allocation.allocatedShifts) {
      byDate.set(shift.date, [...(byDate.get(shift.date) ?? []), shift]);
    }
    for (const shiftsForDay of byDate.values()) {
      if (shiftsForDay.length >= 3) tripleShiftDayCount += 1;
      if (shiftsForDay.length === 2 && !isBackToBack(shiftsForDay[0], shiftsForDay[1])) {
        nonAdjacentSameDayDoubleCount += 1;
      }
    }
  }
  const statShifts = await db.select().from(shiftsTable).where(eq(shiftsTable.surveyId, id));
  const statShiftMap = new Map(statShifts.map((shift) => [shift.id, shift]));
  const effectiveStatRespondentIds = new Set(await getEffectiveAllocationRespondentIds(id));
  const responseSettings = (
    await db
      .select({
        respondentId: responsesTable.respondentId,
        shiftId: responsesTable.shiftId,
        hasPenalty: responsesTable.hasPenalty,
        penaltyHours: responsesTable.penaltyHours,
        hasAfpCap: responsesTable.hasAfpCap,
        afpHoursCap: responsesTable.afpHoursCap,
      })
      .from(responsesTable)
      .innerJoin(respondentsTable, eq(responsesTable.respondentId, respondentsTable.id))
      .where(eq(responsesTable.surveyId, id))
  ).filter((response) => effectiveStatRespondentIds.has(response.respondentId));
  const penaltyByRespondentId = new Map<number, { hasPenalty: boolean; penaltyHours: number }>();
  const capacityByRespondentId = new Map<number, number>();
  const fairnessCandidatesByRespondentId = new Map<number, Map<number, CoreShift>>();
  const hasAfpCapByRespondentId = new Map<number, boolean>();
  const afpCapByRespondentId = new Map<number, number>();
  for (const response of responseSettings) {
    const current = penaltyByRespondentId.get(response.respondentId) ?? {
      hasPenalty: false,
      penaltyHours: 0,
    };
    penaltyByRespondentId.set(response.respondentId, {
      hasPenalty: current.hasPenalty || Boolean(response.hasPenalty),
      penaltyHours: Math.max(current.penaltyHours, response.hasPenalty ? (response.penaltyHours ?? 0) : 0),
    });
    hasAfpCapByRespondentId.set(
      response.respondentId,
      (hasAfpCapByRespondentId.get(response.respondentId) ?? false) || Boolean(response.hasAfpCap),
    );
    afpCapByRespondentId.set(response.respondentId, Math.max(0, response.afpHoursCap ?? 10));
    capacityByRespondentId.set(
      response.respondentId,
      (capacityByRespondentId.get(response.respondentId) ?? 0) +
        hoursToMinutes(statShiftMap.get(response.shiftId)?.durationHours ?? 0),
    );
    if (!manualShiftIdsForStats.has(response.shiftId)) {
      const shift = statShiftMap.get(response.shiftId);
      if (shift) {
        const candidates = fairnessCandidatesByRespondentId.get(response.respondentId) ?? new Map();
        candidates.set(response.shiftId, {
          id: shift.id,
          date: shift.date,
          startTime: shift.startTime,
          endTime: shift.endTime,
          durationHours: shift.durationHours,
        });
        fairnessCandidatesByRespondentId.set(response.respondentId, candidates);
      }
    }
  }
  for (const shift of allAllocatedShifts.filter((allocatedShift) => allocatedShift.isManual)) {
    const candidates = fairnessCandidatesByRespondentId.get(shift.respondentId) ?? new Map();
    candidates.set(shift.shiftId, {
      id: shift.shiftId,
      date: shift.date,
      startTime: shift.startTime,
      endTime: shift.endTime,
      durationHours: shift.durationHours,
    });
    fairnessCandidatesByRespondentId.set(shift.respondentId, candidates);
  }
  const fairnessCapacityByRespondentId = new Map<number, number>();
  const fairnessRespondentIds = new Set([...capacityByRespondentId.keys(), ...fairnessCandidatesByRespondentId.keys()]);
  for (const respondentId of fairnessRespondentIds) {
    fairnessCapacityByRespondentId.set(
      respondentId,
      maxFeasibleShiftCapacityMinutes(
        Array.from(fairnessCandidatesByRespondentId.get(respondentId)?.values() ?? []),
        manualShiftIdsForStats,
      ),
    );
  }

  const totalStaffedMinutes = allocations.reduce((sum, allocation) => sum + hoursToMinutes(allocation.totalHours), 0);
  const actualCappedAfpMinutes = allocations.reduce(
    (sum, allocation) =>
      hasAfpCapByRespondentId.get(allocation.respondentId) ? sum + hoursToMinutes(allocation.totalHours) : sum,
    0,
  );
  const targetResult = solveNonAfpPenaltyTargets(
    Array.from(fairnessCapacityByRespondentId.entries())
      .filter(([respondentId]) => !hasAfpCapByRespondentId.get(respondentId))
      .map(([respondentId, capacityMinutes]) => ({
        respondentId,
        capacityMinutes,
        penaltyMinutes: hoursToMinutes(penaltyByRespondentId.get(respondentId)?.penaltyHours ?? 0),
        minimumMinutes: manualMinutesByRespondentId.get(respondentId) ?? 0,
      })),
    Math.max(0, totalStaffedMinutes - actualCappedAfpMinutes),
  );
  const generalTargetByRespondentId = new Map(
    targetResult.targets.map((target) => [target.respondentId, target] as const),
  );
  const targetMinutesByRespondentId = new Map(
    targetResult.targets.map((target) => [target.respondentId, target.targetMinutes] as const),
  );
  for (const [respondentId, hasAfpCap] of hasAfpCapByRespondentId) {
    if (hasAfpCap) {
      targetMinutesByRespondentId.set(
        respondentId,
        Math.min(
          hoursToMinutes(afpCapByRespondentId.get(respondentId) ?? 10),
          fairnessCapacityByRespondentId.get(respondentId) ?? 0,
        ),
      );
    }
  }

  const toStat = (a: (typeof allocations)[0]) => {
    const penalty = penaltyByRespondentId.get(a.respondentId) ?? {
      hasPenalty: false,
      penaltyHours: 0,
    };
    const hasAfpCap = hasAfpCapByRespondentId.get(a.respondentId) ?? false;
    const generalTarget = generalTargetByRespondentId.get(a.respondentId);
    const targetHours = minutesToHours(targetMinutesByRespondentId.get(a.respondentId) ?? 0);
    const neutralTargetHours = hasAfpCap ? targetHours : minutesToHours(generalTarget?.neutralTargetMinutes ?? 0);
    const effectivePenaltyHours = hasAfpCap ? 0 : minutesToHours(generalTarget?.effectivePenaltyMinutes ?? 0);
    const unappliedPenaltyHours = hasAfpCap ? 0 : minutesToHours(generalTarget?.unappliedPenaltyMinutes ?? 0);
    const weekdayHours = a.allocatedShifts
      .filter((s) => s.dayType === "weekday")
      .reduce((sum, shift) => sum + shift.durationHours, 0);
    const weekendHours = a.allocatedShifts
      .filter((s) => s.dayType === "weekend")
      .reduce((sum, shift) => sum + shift.durationHours, 0);
    const noAvailabilityPlaceholderHours = a.allocatedShifts
      .filter((s) => isNoAvailabilityAfpPlaceholderSource(s.assignmentSource))
      .reduce((sum, shift) => sum + shift.durationHours, 0);
    const normalHours = a.allocatedShifts
      .filter((s) => s.assignmentSource === "engine_normal" || s.assignmentSource === "engine_back_to_back_emergency")
      .reduce((sum, shift) => sum + shift.durationHours, 0);
    const afpCapOverflowHours = a.allocatedShifts
      .filter((s) => s.assignmentSource === "engine_afp_cap_overflow_available")
      .reduce((sum, shift) => sum + shift.durationHours, 0);
    const manualHours = a.allocatedShifts
      .filter((s) => s.assignmentSource === "manual")
      .reduce((sum, shift) => sum + shift.durationHours, 0);
    const sameDayDoubleCount = Array.from(
      a.allocatedShifts
        .reduce((map, shift) => {
          map.set(shift.date, (map.get(shift.date) ?? 0) + 1);
          return map;
        }, new Map<string, number>())
        .values(),
    ).filter((count) => count === 2).length;
    const countedAfpHours = normalHours + afpCapOverflowHours + manualHours;
    const deviationFromTargetHours = (hasAfpCap ? countedAfpHours : a.totalHours) - targetHours;
    return {
      respondentId: a.respondentId,
      name: a.name,
      category: a.category,
      totalHours: a.totalHours,
      weekdayShifts: a.allocatedShifts.filter((s) => s.dayType === "weekday").length,
      weekendShifts: a.allocatedShifts.filter((s) => s.dayType === "weekend").length,
      weekdayHours,
      weekendHours,
      shiftCount: a.allocatedShifts.length,
      isManuallyAdjusted: a.isManuallyAdjusted,
      hasPenalty: penalty.hasPenalty,
      penaltyHours: penalty.penaltyHours,
      hasAfpCap,
      penaltyGapHours: 0,
      targetHours,
      neutralTargetHours,
      effectivePenaltyHours,
      unappliedPenaltyHours,
      availableCapacityHours: minutesToHours(fairnessCapacityByRespondentId.get(a.respondentId) ?? 0),
      deviationFromTargetHours,
      sameDayDoubleCount,
      normalHours,
      afpCapOverflowHours,
      noAvailabilityPlaceholderHours,
      manualHours,
      fairnessStatus: hasAfpCap
        ? "AFP"
        : Math.abs(deviationFromTargetHours) <= 1
          ? "ON_TARGET"
          : deviationFromTargetHours > 0
            ? "OVER_TARGET"
            : "UNDER_TARGET",
    };
  };

  const baseRespondentStats = allocations.map(toStat);
  const respondentStats = baseRespondentStats.map((stat) => ({
    ...stat,
    penaltyGapHours: penaltyGapHoursFromNeutralTarget({
      hasPenalty: stat.hasPenalty,
      neutralTargetMinutes: hoursToMinutes(stat.neutralTargetHours),
      totalHours: stat.totalHours,
    }),
  }));
  const afpStats = respondentStats.filter((a) => a.category === "AFP");
  const generalStats = respondentStats.filter((a) => !a.hasAfpCap);
  const generalStatsWithFairnessMetadata = generalStats.map((stat) => ({
    ...stat,
    capacityLimited: generalTargetByRespondentId.get(stat.respondentId)?.capacityLimited ?? false,
  }));
  const comparisonSummary = summarizeGeneralFairnessComparison(generalStatsWithFairnessMetadata);
  const nonPenalizedGeneralStats = comparisonSummary.stats.map(
    ({ capacityLimited: _capacityLimited, ...stat }) => stat,
  );
  const penalizedStats = generalStats.filter((a) => a.hasPenalty);
  const maxDeviationFromTargetHours =
    generalStats.length > 0 ? Math.max(...generalStats.map((stat) => Math.abs(stat.deviationFromTargetHours))) : 0;
  const sumSquaredDeviationFromTargetHours = generalStats.reduce(
    (sum, stat) => sum + Math.pow(stat.deviationFromTargetHours, 2),
    0,
  );
  const targetStdDevHours = 2;
  const warningStdDevHours = 4;
  const latestFairnessDiagnostics = latestFairnessDiagnosticsBySurveyId.get(id);
  const fairnessWarningSummary = buildGeneralFairnessWarning({
    generalStats: generalStatsWithFairnessMetadata,
    warningThresholdHours: warningStdDevHours,
  });

  const allHours = respondentStats.map((r) => r.totalHours);
  const avg = computeAverage(allHours);
  const median = computeMedian(allHours);
  const std = computeStdDev(allHours, avg);
  const minHours = allHours.length > 0 ? Math.min(...allHours) : 0;
  const maxHours = allHours.length > 0 ? Math.max(...allHours) : 0;
  const totalAllocatedHours = allHours.reduce((sum, hours) => sum + hours, 0);

  res.json({
    meanHours: avg,
    averageHours: avg,
    medianHours: median,
    stdDev: std,
    minHours,
    maxHours,
    totalAllocatedHours,
    blankShiftCount: allocationResult.blankShiftExplanations.length,
    blankWithAvailabilityCount: allocationResult.blankShiftExplanations.filter((shift) => shift.availabilityCount > 0)
      .length,
    noAvailabilityBlankCount: allocationResult.blankShiftExplanations.filter((shift) => shift.availabilityCount === 0)
      .length,
    manualAssignmentCount,
    backToBackEmergencyCount,
    noAvailabilityFallbackCount,
    allowedNoAvailabilityAfpPlaceholderAssignments,
    illegalAssignmentsWithoutAvailability,
    noAvailabilityAfpPlaceholderCount: allowedNoAvailabilityAfpPlaceholderAssignments,
    noAvailabilityShiftsStillBlank: allocationResult.blankShiftExplanations.filter(
      (shift) => shift.availabilityCount === 0,
    ).length,
    afpNoAvailabilityPlaceholderHours: allAllocatedShifts
      .filter((shift) => isNoAvailabilityAfpPlaceholderSource(shift.assignmentSource))
      .reduce((sum, shift) => sum + shift.durationHours, 0),
    afpCapOverflowCount,
    normalAssignmentsWithoutAvailability,
    manualAssignmentsWithoutAvailability,
    fallbackAssignmentsWithoutAvailability,
    assignmentsWithoutAvailabilityCount: assignmentsWithoutAvailability.length,
    nonAdjacentSameDayDoubleCount,
    tripleShiftDayCount,
    renderedBlankButAssignedCount: allocationResult.allocationAudit.filter(
      (row) => row.allocationRecordExists && row.renderedCellIsBlank,
    ).length,
    availabilityMappingFailureCount: allocationResult.allocationAudit.filter(
      (row) => row.reasonCategory === "AVAILABILITY_SHIFT_KEY_MISMATCH",
    ).length,
    respondentStats,
    afpStats,
    generalStats,
    nonPenalizedGeneralStats,
    penalizedStats,
    nonPenalizedGeneralMeanHours: comparisonSummary.meanHours,
    nonPenalizedGeneralMedianHours: comparisonSummary.medianHours,
    nonPenalizedGeneralMinHours: comparisonSummary.minHours,
    nonPenalizedGeneralMaxHours: comparisonSummary.maxHours,
    nonPenalizedGeneralRangeHours: comparisonSummary.rangeHours,
    nonPenalizedGeneralStdDevHours: comparisonSummary.stdDevHours,
    fairnessTargetStdDevHours: targetStdDevHours,
    fairnessWarningStdDevHours: warningStdDevHours,
    fairnessWarning: fairnessWarningSummary.warning,
    fairnessRepairAttempted: latestFairnessDiagnostics?.repairAttempted ?? false,
    fairnessRepairMoveCount: latestFairnessDiagnostics?.successfulRepairMoves ?? 0,
    fairnessHighStdDevReason: fairnessWarningSummary.reason,
    maxDeviationFromMeanHours: comparisonSummary.maxDeviationFromMeanHours,
    maxDeviationFromTargetHours,
    sumSquaredDeviationFromTargetHours,
  });
});

export default router;
