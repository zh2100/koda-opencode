import { sqliteTable, text, integer, uniqueIndex } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql"
import { Location } from "@opencode-ai/schema/location"
import { Model } from "@opencode-ai/schema/model"
import { Prompt } from "@opencode-ai/schema/prompt"
import { Project } from "@opencode-ai/schema/project"
import { Relay } from "@opencode-ai/schema/relay"
import { RelayError } from "@opencode-ai/schema/relay-error"
import { ScheduledTask } from "@opencode-ai/schema/scheduled-task"
import { SessionID } from "@opencode-ai/schema/session-id"
import { SessionMessage } from "@opencode-ai/schema/session-message"

export const ScheduledTaskTable = sqliteTable("scheduled_task", {
  id: text().$type<ScheduledTask.ID>().primaryKey(),
  name: text().notNull(),
  project_id: text().$type<Project.ID>().notNull(),
  location: text({ mode: "json" }).$type<Location.Ref>().notNull(),
  prompt: text({ mode: "json" }).$type<Prompt>().notNull(),
  schedule: text({ enum: ["once", "daily"] }).notNull(),
  timezone: text().notNull(),
  run_at: integer().notNull(),
  model: text({ mode: "json" }).$type<Model.Ref>().notNull(),
  effort: text({ enum: ["low", "medium", "high", "xhigh"] }).$type<Relay.Effort>(),
  approval_mode: text({ enum: ["ask", "auto", "plan"] }).notNull(),
  enabled: integer({ mode: "boolean" }).notNull(),
  revision: integer().notNull(),
  next_run: integer(),
  last_run: integer(),
  ...Timestamps,
})

export const ScheduledTaskRunTable = sqliteTable(
  "scheduled_task_run",
  {
    id: text().$type<ScheduledTask.RunID>().primaryKey(),
    task_id: text()
      .$type<ScheduledTask.ID>()
      .notNull()
      .references(() => ScheduledTaskTable.id, { onDelete: "cascade" }),
    scheduled_at: integer().notNull(),
    revision: integer().notNull(),
    status: text({ enum: ["pending", "running", "completed", "failed", "missed", "interrupted"] }).notNull(),
    session_id: text().$type<SessionID>(),
    prompt_message_id: text().$type<SessionMessage.ID>(),
    started_at: integer(),
    ended_at: integer(),
    error: text({ mode: "json" }).$type<RelayError.Info>(),
    ...Timestamps,
  },
  (table) => [uniqueIndex("scheduled_task_run_task_scheduled_idx").on(table.task_id, table.scheduled_at)],
)
