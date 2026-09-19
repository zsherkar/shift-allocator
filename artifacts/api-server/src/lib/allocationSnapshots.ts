export interface RestorableAllocationSnapshotEntry {
  respondentId: number;
  shiftId: number;
  isManuallyAdjusted: boolean;
  penaltyNote: string | null;
}

export type SnapshotValidationResult =
  | { ok: true; entries: RestorableAllocationSnapshotEntry[] }
  | { ok: false; reason: string };

export function validateAllocationSnapshotEntries(
  value: unknown,
): SnapshotValidationResult {
  if (!Array.isArray(value)) {
    return { ok: false, reason: "Snapshot allocation data is not an array." };
  }

  const entries: RestorableAllocationSnapshotEntry[] = [];
  const shiftIds = new Set<number>();
  for (const rawEntry of value) {
    if (!rawEntry || typeof rawEntry !== "object") {
      return {
        ok: false,
        reason: "Snapshot contains an invalid allocation row.",
      };
    }
    const entry = rawEntry as Record<string, unknown>;
    if (
      !Number.isInteger(entry.respondentId) ||
      Number(entry.respondentId) <= 0 ||
      !Number.isInteger(entry.shiftId) ||
      Number(entry.shiftId) <= 0 ||
      typeof entry.isManuallyAdjusted !== "boolean" ||
      !(
        entry.penaltyNote === null ||
        entry.penaltyNote === undefined ||
        typeof entry.penaltyNote === "string"
      )
    ) {
      return {
        ok: false,
        reason: "Snapshot contains an invalid allocation row.",
      };
    }
    const shiftId = Number(entry.shiftId);
    if (shiftIds.has(shiftId)) {
      return {
        ok: false,
        reason: "Snapshot assigns the same shift more than once.",
      };
    }
    shiftIds.add(shiftId);
    entries.push({
      respondentId: Number(entry.respondentId),
      shiftId,
      isManuallyAdjusted: entry.isManuallyAdjusted,
      penaltyNote:
        typeof entry.penaltyNote === "string" ? entry.penaltyNote : null,
    });
  }

  return { ok: true, entries };
}
