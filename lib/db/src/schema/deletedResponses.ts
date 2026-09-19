import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { respondentsTable } from "./respondents";
import { surveysTable } from "./surveys";

export type DeletedResponseAllocation = {
  shiftId: number;
  isManuallyAdjusted: boolean;
  penaltyNote: string | null;
  createdAt: string;
};

export const deletedResponsesTable = pgTable(
  "deleted_responses",
  {
    id: serial("id").primaryKey(),
    surveyId: integer("survey_id")
      .notNull()
      .references(() => surveysTable.id, { onDelete: "cascade" }),
    respondentId: integer("respondent_id")
      .notNull()
      .references(() => respondentsTable.id, { onDelete: "cascade" }),
    respondentName: text("respondent_name").notNull(),
    preferredName: text("preferred_name").notNull(),
    respondentEmail: text("respondent_email"),
    respondentCategory: text("respondent_category").notNull(),
    shiftIds: integer("shift_ids").array().notNull(),
    hasPenalty: boolean("has_penalty").notNull().default(false),
    penaltyHours: real("penalty_hours").notNull().default(0),
    hasAfpCap: boolean("has_afp_cap").notNull().default(false),
    afpHoursCap: real("afp_hours_cap").notNull().default(10),
    responseCreatedAt: timestamp("response_created_at", { withTimezone: true }).notNull(),
    allocations: jsonb("allocations").$type<DeletedResponseAllocation[]>().notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }).notNull().defaultNow(),
    restoredAt: timestamp("restored_at", { withTimezone: true }),
  },
  (table) => [
    index("deleted_responses_survey_deleted_idx").on(table.surveyId, table.deletedAt),
    index("deleted_responses_respondent_idx").on(table.respondentId),
  ],
);

export type DeletedResponse = typeof deletedResponsesTable.$inferSelect;
