import { integer, sqliteTable, text, index } from "drizzle-orm/sqlite-core"
import { ProjectV2 } from "../project"
import { SessionSchema } from "../session/schema"

export const TaskOrchestratorTaskTable = sqliteTable(
  "task_orchestrator_task",
  {
    id: text().primaryKey(),
    session_id: text().$type<SessionSchema.ID>().notNull(),
    project_id: text().$type<ProjectV2.ID>().notNull(),
    workspace_key: text().notNull(),
    prompt: text().notNull(),
    status: text({ enum: ["pending", "running", "completed", "failed", "paused", "aborted"] }).notNull(),
    current_step: integer().notNull().default(0),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
    failure_reason: text(),
    timeout_ms: integer().notNull().default(300000),
    max_retries: integer().notNull().default(1),
    fallback_model: text(),
  },
  (table) => [index("task_orchestrator_task_session_idx").on(table.session_id)],
)

export const TaskOrchestratorStepTable = sqliteTable(
  "task_orchestrator_step",
  {
    id: text().primaryKey(),
    task_id: text().notNull(),
    ordinal: integer().notNull(),
    role: text({ enum: ["planner", "worker", "reviewer", "tester", "finalizer"] }).notNull(),
    model: text().notNull(),
    status: text({ enum: ["pending", "running", "completed", "needs_revision", "failed"] }).notNull(),
    retry_count: integer().notNull().default(0),
    output: text(),
    failure_reason: text(),
    started_at: integer(),
    finished_at: integer(),
  },
  (table) => [index("task_orchestrator_step_task_idx").on(table.task_id)],
)

export const TaskOrchestratorRunTable = sqliteTable(
  "task_orchestrator_run",
  {
    id: text().primaryKey(),
    task_id: text().notNull(),
    step_id: text().notNull(),
    model: text().notNull(),
    role: text().notNull(),
    input_snapshot: text().notNull(),
    output: text(),
    status: text({ enum: ["running", "completed", "failed", "timed_out", "needs_revision"] }).notNull(),
    retry_count: integer().notNull().default(0),
    started_at: integer().notNull(),
    finished_at: integer(),
    failure_reason: text(),
  },
  (table) => [index("task_orchestrator_run_task_idx").on(table.task_id)],
)
