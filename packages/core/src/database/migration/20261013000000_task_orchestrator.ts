import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261013000000_task_orchestrator",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`CREATE TABLE task_orchestrator_task (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, project_id TEXT NOT NULL, workspace_key TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL, current_step INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, failure_reason TEXT, timeout_ms INTEGER NOT NULL DEFAULT 300000, max_retries INTEGER NOT NULL DEFAULT 1, fallback_model TEXT);`)
      yield* tx.run(`CREATE TABLE task_orchestrator_step (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, ordinal INTEGER NOT NULL, role TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL, retry_count INTEGER NOT NULL DEFAULT 0, output TEXT, failure_reason TEXT, started_at INTEGER, finished_at INTEGER);`)
      yield* tx.run(`CREATE TABLE task_orchestrator_run (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, step_id TEXT NOT NULL, model TEXT NOT NULL, role TEXT NOT NULL, input_snapshot TEXT NOT NULL, output TEXT, status TEXT NOT NULL, retry_count INTEGER NOT NULL DEFAULT 0, started_at INTEGER NOT NULL, finished_at INTEGER, failure_reason TEXT);`)
      yield* tx.run(`CREATE INDEX task_orchestrator_task_session_idx ON task_orchestrator_task(session_id);`)
      yield* tx.run(`CREATE INDEX task_orchestrator_step_task_idx ON task_orchestrator_step(task_id);`)
      yield* tx.run(`CREATE INDEX task_orchestrator_run_task_idx ON task_orchestrator_run(task_id);`)
    })
  },
} satisfies DatabaseMigration.Migration
