import { Router, type IRouter } from "express";
import crypto from "node:crypto";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  db,
  surveysTable,
  shiftsTable,
  respondentsTable,
  responsesTable,
  allocationsTable,
  deletedResponsesTable,
} from "@workspace/db";
import { generateShiftsForMonth } from "../lib/shiftGenerator.js";
import {
  CreateSurveyBody,
  UpdateSurveyBody,
  ListSurveysResponse,
  GetSurveyResponse,
  UpdateSurveyResponse,
  GetSurveyStatsResponse,
  GetSurveyResponsesResponse,
} from "@workspace/api-zod";
import {
  dedupePositiveIntegerIds,
  FIELD_LIMITS,
  normalizeRequiredText,
} from "../lib/inputValidation.js";
import { getEffectiveAllocationRespondentIds } from "../lib/allocationMembership.js";

const router: IRouter = Router();

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const TOKEN_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

function shortToken(length = 12): string {
  return Array.from({ length })
    .map(() => TOKEN_ALPHABET[crypto.randomInt(0, TOKEN_ALPHABET.length)])
    .join("");
}

function formatTime12(time: string): string {
  const [h, m] = time.split(":").map(Number);
  const suffix = h >= 12 ? "PM" : "AM";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, "0")} ${suffix}`;
}

function isPgUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  );
}

async function createSurveyWithUniqueToken(values: {
  month: number;
  year: number;
  title: string;
  closesAt: Date | null;
}) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const [survey] = await db
        .insert(surveysTable)
        .values({ ...values, status: "open", token: shortToken(12) })
        .returning();
      return survey;
    } catch (error) {
      if (!isPgUniqueViolation(error)) {
        throw error;
      }
    }
  }

  throw new Error("Unable to create a unique survey link right now. Please try again.");
}

router.get("/surveys", async (_req, res): Promise<void> => {
  const now = new Date();
  await db
    .update(surveysTable)
    .set({ status: "closed" })
    .where(and(eq(surveysTable.status, "open"), sql`${surveysTable.closesAt} <= ${now}`));
  const surveys = await db.select().from(surveysTable).orderBy(surveysTable.createdAt);
  res.json(ListSurveysResponse.parse(surveys));
});

router.post("/surveys", async (req, res): Promise<void> => {
  const parsed = CreateSurveyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { month, year, title, closesAt: closesAtValue } = parsed.data;
  const titleResult = title
    ? normalizeRequiredText(title, "Survey title", FIELD_LIMITS.surveyTitle)
    : {
        ok: true as const,
        value: `${MONTH_NAMES[month - 1]} ${year} Shift Survey`,
      };
  if (!titleResult.ok) {
    res.status(400).json({ error: titleResult.error });
    return;
  }

  const surveyTitle = titleResult.value;
  const closesAt = closesAtValue ? new Date(closesAtValue) : null;
  let survey;

  try {
    survey = await createSurveyWithUniqueToken({
      month,
      year,
      title: surveyTitle,
      closesAt,
    });
  } catch (error) {
    res.status(500).json({
      error:
        error instanceof Error
          ? error.message
          : "Unable to create the survey right now.",
    });
    return;
  }

  const shiftTemplates = generateShiftsForMonth(year, month);
  if (shiftTemplates.length > 0) {
    await db.insert(shiftsTable).values(
      shiftTemplates.map((s) => ({
        surveyId: survey.id,
        date: s.date,
        dayType: s.dayType,
        startTime: s.startTime,
        endTime: s.endTime,
        durationHours: s.durationHours,
        label: s.label,
      }))
    );
  }

  res.status(201).json(survey);
});

router.get("/surveys/:id", async (req, res): Promise<void> => {
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
  if (survey.status === "open" && survey.closesAt && new Date(survey.closesAt) <= new Date()) {
    await db.update(surveysTable).set({ status: "closed" }).where(eq(surveysTable.id, id));
    survey.status = "closed";
  }

  const shifts = await db.select().from(shiftsTable).where(eq(shiftsTable.surveyId, id));

  const [{ count }] = await db
    .select({ count: sql<number>`count(distinct ${responsesTable.respondentId})` })
    .from(responsesTable)
    .where(eq(responsesTable.surveyId, id));

  res.json({
    ...survey,
    shifts,
    responseCount: Number(count),
  });
});

router.patch("/surveys/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const parsed = UpdateSurveyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const updateData: Partial<typeof surveysTable.$inferInsert> = {};
  if (parsed.data.status !== undefined) updateData.status = parsed.data.status;
  if (parsed.data.title !== undefined && parsed.data.title !== null) {
    const titleResult = normalizeRequiredText(
      parsed.data.title,
      "Survey title",
      FIELD_LIMITS.surveyTitle,
    );
    if (!titleResult.ok) {
      res.status(400).json({ error: titleResult.error });
      return;
    }
    updateData.title = titleResult.value;
  }
  if (parsed.data.closesAt !== undefined) {
    updateData.closesAt = parsed.data.closesAt ? new Date(parsed.data.closesAt) : null;
  }
  if (parsed.data.status === "open" && parsed.data.closesAt === undefined) {
    const [existingSurvey] = await db.select().from(surveysTable).where(eq(surveysTable.id, id));
    if (existingSurvey?.closesAt && new Date(existingSurvey.closesAt) <= new Date()) {
      updateData.closesAt = null;
    }
  }

  const [survey] = await db
    .update(surveysTable)
    .set(updateData)
    .where(eq(surveysTable.id, id))
    .returning();

  if (!survey) {
    res.status(404).json({ error: "Survey not found" });
    return;
  }

  res.json(UpdateSurveyResponse.parse(survey));
});

router.delete("/surveys/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const [survey] = await db.delete(surveysTable).where(eq(surveysTable.id, id)).returning();
  if (!survey) {
    res.status(404).json({ error: "Survey not found" });
    return;
  }
  res.sendStatus(204);
});

router.get("/surveys/:id/responses", async (req, res): Promise<void> => {
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

  const responses = await db
    .select({
      respondentId: responsesTable.respondentId,
      shiftId: responsesTable.shiftId,
      respondentName: respondentsTable.name,
      preferredName: respondentsTable.preferredName,
      respondentEmail: respondentsTable.email,
      respondentCategory: respondentsTable.category,
      hasPenalty: responsesTable.hasPenalty,
      penaltyHours: responsesTable.penaltyHours,
      hasAfpCap: responsesTable.hasAfpCap,
      afpHoursCap: responsesTable.afpHoursCap,
    })
    .from(responsesTable)
    .innerJoin(respondentsTable, eq(responsesTable.respondentId, respondentsTable.id))
    .where(eq(responsesTable.surveyId, id));
  const includedRespondentIds = new Set(
    await getEffectiveAllocationRespondentIds(id),
  );

  // Group by respondent
  const respondentMap = new Map<
    number,
    {
      respondentId: number;
      name: string;
      preferredName: string;
      email: string | null;
      category: string;
      selectedShiftIds: number[];
      hasPenalty: boolean;
      penaltyHours: number;
      hasAfpCap: boolean;
      afpHoursCap: number;
      includedInLatestAllocation: boolean;
    }
  >();

  for (const r of responses) {
    if (!respondentMap.has(r.respondentId)) {
        respondentMap.set(r.respondentId, {
          respondentId: r.respondentId,
          name: r.respondentName,
          preferredName: r.preferredName,
          email: r.respondentEmail,
          category: r.respondentCategory,
          selectedShiftIds: [],
          hasPenalty: r.hasPenalty,
          penaltyHours: r.penaltyHours,
          hasAfpCap: r.hasAfpCap,
          afpHoursCap: r.afpHoursCap,
          includedInLatestAllocation: includedRespondentIds.has(r.respondentId),
        });
    }
    respondentMap.get(r.respondentId)!.selectedShiftIds.push(r.shiftId);
  }

  const shifts = await db.select().from(shiftsTable).where(eq(shiftsTable.surveyId, id));
  const shiftMap = new Map(shifts.map((s) => [s.id, s]));

  const result = Array.from(respondentMap.values()).map((r) => ({
    ...r,
    totalAvailableHours: r.selectedShiftIds.reduce((sum, id) => sum + (shiftMap.get(id)?.durationHours ?? 0), 0),
  }));

  res.json(result);
});

router.get("/surveys/:id/deleted-responses", async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const deletedResponses = await db
    .select()
    .from(deletedResponsesTable)
    .where(
      and(
        eq(deletedResponsesTable.surveyId, id),
        isNull(deletedResponsesTable.restoredAt),
      ),
    )
    .orderBy(desc(deletedResponsesTable.deletedAt));

  res.json(
    deletedResponses.map((response) => ({
      id: response.id,
      surveyId: response.surveyId,
      respondentId: response.respondentId,
      name: response.respondentName,
      preferredName: response.preferredName,
      email: response.respondentEmail,
      category: response.respondentCategory,
      selectedShiftIds: response.shiftIds,
      hasPenalty: response.hasPenalty,
      penaltyHours: response.penaltyHours,
      hasAfpCap: response.hasAfpCap,
      afpHoursCap: response.afpHoursCap,
      allocationCount: response.allocations.length,
      deletedAt: response.deletedAt,
    })),
  );
});

router.delete("/surveys/:id/responses/:respondentId", async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const respondentId = parseInt(
    Array.isArray(req.params.respondentId) ? req.params.respondentId[0] : req.params.respondentId,
    10,
  );
  if (isNaN(id) || isNaN(respondentId)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const archivedResponseId = await db.transaction(async (tx) => {
    const existingResponses = await tx
      .select()
      .from(responsesTable)
      .where(
        and(
          eq(responsesTable.surveyId, id),
          eq(responsesTable.respondentId, respondentId),
        ),
      )
      .orderBy(responsesTable.shiftId);

    if (existingResponses.length === 0) {
      return null;
    }

    const [respondent] = await tx
      .select()
      .from(respondentsTable)
      .where(eq(respondentsTable.id, respondentId))
      .limit(1);
    if (!respondent) {
      return null;
    }

    const existingAllocations = await tx
      .select()
      .from(allocationsTable)
      .where(
        and(
          eq(allocationsTable.surveyId, id),
          eq(allocationsTable.respondentId, respondentId),
        ),
      )
      .orderBy(allocationsTable.shiftId);

    const firstResponse = existingResponses[0];
    const responseCreatedAt = new Date(
      Math.min(...existingResponses.map((response) => response.createdAt.getTime())),
    );
    const [archivedResponse] = await tx
      .insert(deletedResponsesTable)
      .values({
        surveyId: id,
        respondentId,
        respondentName: respondent.name,
        preferredName: respondent.preferredName,
        respondentEmail: respondent.email,
        respondentCategory: respondent.category,
        shiftIds: existingResponses.map((response) => response.shiftId),
        hasPenalty: firstResponse.hasPenalty,
        penaltyHours: firstResponse.penaltyHours,
        hasAfpCap: firstResponse.hasAfpCap,
        afpHoursCap: firstResponse.afpHoursCap,
        responseCreatedAt,
        allocations: existingAllocations.map((allocation) => ({
          shiftId: allocation.shiftId,
          isManuallyAdjusted: allocation.isManuallyAdjusted,
          penaltyNote: allocation.penaltyNote,
          createdAt: allocation.createdAt.toISOString(),
        })),
      })
      .returning({ id: deletedResponsesTable.id });

    await tx
      .delete(allocationsTable)
      .where(
        and(
          eq(allocationsTable.surveyId, id),
          eq(allocationsTable.respondentId, respondentId),
        ),
      );
    await tx
      .delete(responsesTable)
      .where(
        and(
          eq(responsesTable.surveyId, id),
          eq(responsesTable.respondentId, respondentId),
        ),
      );

    return archivedResponse.id;
  });

  if (archivedResponseId === null) {
    res.status(404).json({ error: "Response not found" });
    return;
  }

  res.status(200).json({ archivedResponseId });
});

router.post("/surveys/:id/deleted-responses/:deletedResponseId/restore", async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const deletedResponseId = parseInt(
    Array.isArray(req.params.deletedResponseId)
      ? req.params.deletedResponseId[0]
      : req.params.deletedResponseId,
    10,
  );
  if (isNaN(id) || isNaN(deletedResponseId)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const restoreResult = await db.transaction(async (tx) => {
    const [archivedResponse] = await tx
      .select()
      .from(deletedResponsesTable)
      .where(
        and(
          eq(deletedResponsesTable.id, deletedResponseId),
          eq(deletedResponsesTable.surveyId, id),
          isNull(deletedResponsesTable.restoredAt),
        ),
      )
      .limit(1);

    if (!archivedResponse) {
      return { status: "not-found" as const };
    }

    const [activeResponse] = await tx
      .select({ id: responsesTable.id })
      .from(responsesTable)
      .where(
        and(
          eq(responsesTable.surveyId, id),
          eq(responsesTable.respondentId, archivedResponse.respondentId),
        ),
      )
      .limit(1);
    if (activeResponse) {
      return { status: "already-active" as const };
    }

    const surveyShifts = await tx
      .select({ id: shiftsTable.id })
      .from(shiftsTable)
      .where(eq(shiftsTable.surveyId, id));
    const validShiftIds = new Set(surveyShifts.map((shift) => shift.id));
    if (
      archivedResponse.shiftIds.length === 0 ||
      archivedResponse.shiftIds.some((shiftId) => !validShiftIds.has(shiftId))
    ) {
      return { status: "invalid-shifts" as const };
    }

    await tx.insert(responsesTable).values(
      archivedResponse.shiftIds.map((shiftId) => ({
        surveyId: id,
        respondentId: archivedResponse.respondentId,
        shiftId,
        hasPenalty: archivedResponse.hasPenalty,
        penaltyHours: archivedResponse.penaltyHours,
        hasAfpCap: archivedResponse.hasAfpCap,
        afpHoursCap: archivedResponse.afpHoursCap,
        createdAt: archivedResponse.responseCreatedAt,
      })),
    );

    const allocationShiftIds = archivedResponse.allocations.map(
      (allocation) => allocation.shiftId,
    );
    const occupiedAllocationRows = allocationShiftIds.length > 0
      ? await tx
          .select({ shiftId: allocationsTable.shiftId })
          .from(allocationsTable)
          .where(
            and(
              eq(allocationsTable.surveyId, id),
              inArray(allocationsTable.shiftId, allocationShiftIds),
            ),
          )
      : [];
    const occupiedAllocationIds = new Set(
      occupiedAllocationRows.map((allocation) => allocation.shiftId),
    );
    const allocationsToRestore = archivedResponse.allocations.filter(
      (allocation) => !occupiedAllocationIds.has(allocation.shiftId),
    );

    if (allocationsToRestore.length > 0) {
      await tx.insert(allocationsTable).values(
        allocationsToRestore.map((allocation) => ({
          surveyId: id,
          respondentId: archivedResponse.respondentId,
          shiftId: allocation.shiftId,
          isManuallyAdjusted: allocation.isManuallyAdjusted,
          penaltyNote: allocation.penaltyNote,
          createdAt: new Date(allocation.createdAt),
        })),
      );
    }

    await tx
      .update(deletedResponsesTable)
      .set({ restoredAt: new Date() })
      .where(eq(deletedResponsesTable.id, archivedResponse.id));

    return {
      status: "restored" as const,
      respondentId: archivedResponse.respondentId,
      restoredShiftCount: archivedResponse.shiftIds.length,
      restoredAllocationCount: allocationsToRestore.length,
      skippedAllocationCount:
        archivedResponse.allocations.length - allocationsToRestore.length,
    };
  });

  if (restoreResult.status === "not-found") {
    res.status(404).json({ error: "Deleted response not found" });
    return;
  }
  if (restoreResult.status === "already-active") {
    res.status(409).json({ error: "This respondent already has an active response" });
    return;
  }
  if (restoreResult.status === "invalid-shifts") {
    res.status(409).json({ error: "The archived response contains shifts that no longer exist" });
    return;
  }

  res.json(restoreResult);
});

router.put("/surveys/:id/responses/:respondentId", async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const respondentId = parseInt(
    Array.isArray(req.params.respondentId) ? req.params.respondentId[0] : req.params.respondentId,
    10,
  );
  const selectedShiftIds = dedupePositiveIntegerIds(req.body?.selectedShiftIds);
  const incomingPenaltyHours = Number(req.body?.penaltyHours);
  const incomingAfpHoursCap = Number(req.body?.afpHoursCap);
  if (isNaN(id) || isNaN(respondentId)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const shifts = await db.select().from(shiftsTable).where(eq(shiftsTable.surveyId, id));
  const validShiftIds = new Set(shifts.map((shift) => shift.id));
  const invalidShiftIds = selectedShiftIds.filter((shiftId: number) => !validShiftIds.has(shiftId));
  if (invalidShiftIds.length > 0) {
    res.status(400).json({ error: "Invalid shift IDs selected" });
    return;
  }

  const [existingResponse] = await db
    .select({
      hasPenalty: responsesTable.hasPenalty,
      penaltyHours: responsesTable.penaltyHours,
      hasAfpCap: responsesTable.hasAfpCap,
      afpHoursCap: responsesTable.afpHoursCap,
    })
    .from(responsesTable)
    .where(and(eq(responsesTable.surveyId, id), eq(responsesTable.respondentId, respondentId)))
    .limit(1);

  const hasPenalty = typeof req.body?.hasPenalty === "boolean"
    ? req.body.hasPenalty
    : existingResponse?.hasPenalty ?? false;
  const penaltyHours = Number.isFinite(incomingPenaltyHours)
    ? Math.max(0, incomingPenaltyHours)
    : existingResponse?.penaltyHours ?? 0;
  const hasAfpCap = typeof req.body?.hasAfpCap === "boolean"
    ? req.body.hasAfpCap
    : existingResponse?.hasAfpCap ?? false;
  const afpHoursCap = Number.isFinite(incomingAfpHoursCap)
    ? Math.max(0, incomingAfpHoursCap)
    : existingResponse?.afpHoursCap ?? 10;

  await db.transaction(async (tx) => {
    await tx
      .delete(responsesTable)
      .where(and(eq(responsesTable.surveyId, id), eq(responsesTable.respondentId, respondentId)));
    await tx
      .delete(allocationsTable)
      .where(and(eq(allocationsTable.surveyId, id), eq(allocationsTable.respondentId, respondentId)));

    for (const shiftId of selectedShiftIds) {
      await tx.insert(responsesTable).values({
        surveyId: id,
        respondentId,
        shiftId,
        hasPenalty,
        penaltyHours: hasPenalty ? penaltyHours : 0,
        hasAfpCap,
        afpHoursCap,
      });
    }
  });
  res.sendStatus(204);
});

router.get("/surveys/:id/stats", async (req, res): Promise<void> => {
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

  const shifts = await db.select().from(shiftsTable).where(eq(shiftsTable.surveyId, id));
  const shiftMap = new Map(shifts.map((s) => [s.id, s]));

  const responses = await db
    .select({
      respondentId: responsesTable.respondentId,
      shiftId: responsesTable.shiftId,
      respondentName: respondentsTable.name,
      respondentCategory: respondentsTable.category,
    })
    .from(responsesTable)
    .innerJoin(respondentsTable, eq(responsesTable.respondentId, respondentsTable.id))
    .where(eq(responsesTable.surveyId, id));
  const allocationRespondentIds = new Set(
    await getEffectiveAllocationRespondentIds(id),
  );
  const includedResponses = responses.filter((response) =>
    allocationRespondentIds.has(response.respondentId),
  );

  const respondentMap = new Map<
    number,
    { respondentId: number; name: string; category: string; shiftIds: number[] }
  >();

  for (const r of includedResponses) {
    if (!respondentMap.has(r.respondentId)) {
      respondentMap.set(r.respondentId, {
        respondentId: r.respondentId,
        name: r.respondentName,
        category: r.respondentCategory,
        shiftIds: [],
      });
    }
    respondentMap.get(r.respondentId)!.shiftIds.push(r.shiftId);
  }

  const allRespondents = Array.from(respondentMap.values());
  const totalRespondents = allRespondents.length;

  const hoursByRespondent = allRespondents.map((r) =>
    r.shiftIds.reduce((sum, id) => sum + (shiftMap.get(id)?.durationHours ?? 0), 0)
  );

  const avgHours = totalRespondents > 0 ? hoursByRespondent.reduce((a, b) => a + b, 0) / totalRespondents : 0;
  const variance =
    totalRespondents > 0
      ? hoursByRespondent.reduce((sum, h) => sum + Math.pow(h - avgHours, 2), 0) / totalRespondents
      : 0;
  const stdDevHours = Math.sqrt(variance);

  // Shift type stats - group by time slot label
  const shiftTypeMap = new Map<string, { label: string; dayType: string; count: number }>();
  for (const r of includedResponses) {
    const shift = shiftMap.get(r.shiftId);
    if (!shift) continue;
    const timeKey = `${shift.dayType}|${shift.startTime}-${shift.endTime}`;
    if (!shiftTypeMap.has(timeKey)) {
      const timeLabel = shift.dayType === "weekday"
        ? `Weekday ${formatTime12(shift.startTime)}-${formatTime12(shift.endTime)}`
        : `Weekend ${formatTime12(shift.startTime)}-${formatTime12(shift.endTime)}`;
      shiftTypeMap.set(timeKey, { label: timeLabel, dayType: shift.dayType, count: 0 });
    }
    shiftTypeMap.get(timeKey)!.count++;
  }

  const shiftTypeStats = Array.from(shiftTypeMap.entries()).map(([, v]) => ({
    shiftLabel: v.label,
    dayType: v.dayType as "weekday" | "weekend",
    totalSelections: v.count,
    selectionRate: totalRespondents > 0 ? v.count / totalRespondents : 0,
  }));

  const respondentStats = allRespondents.map((r) => {
    const weekdayShifts = r.shiftIds.filter((id) => shiftMap.get(id)?.dayType === "weekday").length;
    const weekendShifts = r.shiftIds.filter((id) => shiftMap.get(id)?.dayType === "weekend").length;
    const totalAvailableHours = r.shiftIds.reduce((sum, id) => sum + (shiftMap.get(id)?.durationHours ?? 0), 0);
    return {
      respondentId: r.respondentId,
      name: r.name,
      category: r.category as "AFP" | "General",
      totalAvailableHours,
      shiftsSelected: r.shiftIds.length,
      weekdayShifts,
      weekendShifts,
    };
  });

  res.json({
    totalRespondents,
    averageAvailableHours: avgHours,
    stdDevAvailableHours: stdDevHours,
    shiftTypeStats,
    respondentStats,
  });
});

export default router;
