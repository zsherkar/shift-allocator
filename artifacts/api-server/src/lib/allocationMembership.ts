type ResolveAllocationMembershipInput = {
  responseRespondentIds: number[];
  persistedIncludedRespondentIds: number[] | null;
  allocatedRespondentIds: number[];
};

function uniquePositiveIds(ids: number[]): number[] {
  return Array.from(
    new Set(ids.filter((id) => Number.isInteger(id) && id > 0)),
  ).sort((a, b) => a - b);
}

export function resolveAllocationRespondentIds({
  responseRespondentIds,
  persistedIncludedRespondentIds,
  allocatedRespondentIds,
}: ResolveAllocationMembershipInput): number[] {
  const responseIds = new Set(uniquePositiveIds(responseRespondentIds));
  const sourceIds =
    persistedIncludedRespondentIds !== null
      ? persistedIncludedRespondentIds
      : allocatedRespondentIds.length > 0
        ? allocatedRespondentIds
        : responseRespondentIds;

  return uniquePositiveIds(sourceIds).filter((id) => responseIds.has(id));
}

export async function getEffectiveAllocationRespondentIds(
  surveyId: number,
): Promise<number[]> {
  const [{ db, surveysTable, responsesTable, allocationsTable }, { eq }] =
    await Promise.all([import("@workspace/db"), import("drizzle-orm")]);

  const [[survey], responseRows, allocationRows] = await Promise.all([
    db
      .select({
        allocationIncludedRespondentIds:
          surveysTable.allocationIncludedRespondentIds,
      })
      .from(surveysTable)
      .where(eq(surveysTable.id, surveyId))
      .limit(1),
    db
      .select({ respondentId: responsesTable.respondentId })
      .from(responsesTable)
      .where(eq(responsesTable.surveyId, surveyId)),
    db
      .select({ respondentId: allocationsTable.respondentId })
      .from(allocationsTable)
      .where(eq(allocationsTable.surveyId, surveyId)),
  ]);

  return resolveAllocationRespondentIds({
    responseRespondentIds: responseRows.map((row) => row.respondentId),
    persistedIncludedRespondentIds:
      survey?.allocationIncludedRespondentIds ?? null,
    allocatedRespondentIds: allocationRows.map((row) => row.respondentId),
  });
}
