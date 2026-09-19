import { boolean, integer, pgTable, real, serial, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { surveysTable } from "./surveys";
import { respondentsTable } from "./respondents";
import { shiftsTable } from "./shifts";

export const responsesTable = pgTable(
  "responses",
  {
    id: serial("id").primaryKey(),
    surveyId: integer("survey_id").notNull().references(() => surveysTable.id, { onDelete: "cascade" }),
    respondentId: integer("respondent_id").notNull().references(() => respondentsTable.id, { onDelete: "cascade" }),
    shiftId: integer("shift_id").notNull().references(() => shiftsTable.id, { onDelete: "cascade" }),
    hasPenalty: boolean("has_penalty").notNull().default(false),
    penaltyHours: real("penalty_hours").notNull().default(0),
    hasAfpCap: boolean("has_afp_cap").notNull().default(false),
    afpHoursCap: real("afp_hours_cap").notNull().default(10),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("responses_survey_respondent_shift_unique").on(
      table.surveyId,
      table.respondentId,
      table.shiftId,
    ),
  ],
);

export const insertResponseSchema = createInsertSchema(responsesTable).omit({ id: true, createdAt: true });
export type InsertResponse = z.infer<typeof insertResponseSchema>;
export type Response = typeof responsesTable.$inferSelect;
