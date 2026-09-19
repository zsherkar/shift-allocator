import {
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { surveysTable } from "./surveys";

export interface AllocationSnapshotEntry {
  respondentId: number;
  shiftId: number;
  isManuallyAdjusted: boolean;
  penaltyNote: string | null;
}

export const allocationSnapshotsTable = pgTable(
  "allocation_snapshots",
  {
    id: serial("id").primaryKey(),
    surveyId: integer("survey_id")
      .notNull()
      .references(() => surveysTable.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    reason: text("reason").notNull(),
    allocations: jsonb("allocations")
      .$type<AllocationSnapshotEntry[]>()
      .notNull(),
    allocationIncludedRespondentIds: jsonb(
      "allocation_included_respondent_ids",
    ).$type<number[]>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("allocation_snapshots_survey_created_idx").on(
      table.surveyId,
      table.createdAt,
    ),
  ],
);

export type AllocationSnapshot = typeof allocationSnapshotsTable.$inferSelect;
