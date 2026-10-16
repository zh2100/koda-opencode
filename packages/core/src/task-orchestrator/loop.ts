export * as TaskOrchestratorLoop from "./loop"

import { asc, eq } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "../database/database"
import { SessionSchema } from "../session/schema"
import { TaskOrchestratorReview } from "./review"
import { TaskOrchestratorRetryPersistence } from "./retry-persistence"
import { TaskOrchestratorRunTable, TaskOrchestratorStepTable, TaskOrchestratorTaskTable } from "./sql"
import { TaskOrchestratorExecution } from "./execution"

export type Control = "pause" | "abort" | "retry"

export interface Runner {
  readonly output: (input: { readonly role: string; readonly prompt: string }) => Effect.Effect<string, unknown>
  readonly schedule: (input: { readonly sessionID: SessionSchema.ID; readonly transition: Parameters<typeof TaskOrchestratorRetryPersistence.apply>[0]["transition"] }) => Effect.Effect<unknown, unknown>
  readonly test: (input: { readonly sessionID: SessionSchema.ID; readonly prompt: string }) => Effect.Effect<string, unknown>
  readonly audit: (input: { readonly sessionID: SessionSchema.ID; readonly changes: ReadonlyArray<string> }) => Effect.Effect<void, unknown>
  readonly changes: (sessionID: SessionSchema.ID) => ReadonlyArray<string>
  readonly control: (taskID: string) => Control | undefined
}

export const run = Effect.fn("TaskOrchestratorLoop.run")(function* (input: {
  readonly db: Database.Interface["db"]
  readonly taskID: string
  readonly runner: Runner
}) {
  const task = yield* input.db.select().from(TaskOrchestratorTaskTable).where(eq(TaskOrchestratorTaskTable.id, input.taskID)).get().pipe(Effect.orDie)
  if (!task || task.status === "aborted" || task.status === "completed" || task.status === "paused") return
  yield* input.db.update(TaskOrchestratorTaskTable).set({ status: "running", updated_at: Date.now() }).where(eq(TaskOrchestratorTaskTable.id, input.taskID)).run().pipe(Effect.orDie)
  const steps = yield* input.db.select().from(TaskOrchestratorStepTable).where(eq(TaskOrchestratorStepTable.task_id, input.taskID)).orderBy(asc(TaskOrchestratorStepTable.ordinal)).all().pipe(Effect.orDie)

  for (const step of steps.filter((item) => item.status !== "completed")) {
    const control = input.runner.control(input.taskID)
    if (control === "pause" || control === "abort") {
      yield* input.db.update(TaskOrchestratorTaskTable).set({ status: control === "pause" ? "paused" : "aborted", updated_at: Date.now() }).where(eq(TaskOrchestratorTaskTable.id, input.taskID)).run().pipe(Effect.orDie)
      return
    }
    if (control === "retry") {
      yield* input.db.update(TaskOrchestratorStepTable).set({ status: "pending", failure_reason: null, finished_at: null }).where(eq(TaskOrchestratorStepTable.id, step.id)).run().pipe(Effect.orDie)
    }

    const current = yield* input.db.select().from(TaskOrchestratorTaskTable).where(eq(TaskOrchestratorTaskTable.id, input.taskID)).get().pipe(Effect.orDie)
    if (!current || current.status === "paused" || current.status === "aborted") return
    const runID = crypto.randomUUID()
    const started = Date.now()
    yield* input.db.update(TaskOrchestratorStepTable).set({ status: "running", started_at: started }).where(eq(TaskOrchestratorStepTable.id, step.id)).run().pipe(Effect.orDie)
    yield* input.db.insert(TaskOrchestratorRunTable).values({
      id: runID,
      task_id: input.taskID,
      step_id: step.id,
      model: step.model,
      role: step.role,
      input_snapshot: current.prompt,
      status: "running",
      started_at: started,
    }).run().pipe(Effect.orDie)

    if (step.role === "reviewer") {
      const output = yield* input.runner.output({ role: step.role, prompt: current.prompt })
      const transition = TaskOrchestratorExecution.settleReview({
        output,
        retryCount: step.retry_count,
        maxRetries: current.max_retries,
        sessionID: current.session_id,
        persist: (value) => TaskOrchestratorRetryPersistence.apply({ db: input.db, taskID: input.taskID, stepID: step.id, runID, transition: value }),
        scheduler: { schedule: input.runner.schedule },
      })
      yield* transition
      const stored = TaskOrchestratorReview.store(output, TaskOrchestratorReview.plan(output, step.retry_count, current.max_retries))
      if (stored.action === "fail") return
      if (stored.action === "revise") return
      continue
    }

    if (step.role === "tester") {
      const output = yield* input.runner.test({ sessionID: current.session_id, prompt: current.prompt })
      const changes = input.runner.changes(current.session_id)
      yield* input.runner.audit({ sessionID: current.session_id, changes })
      if (changes.length > 0) {
        const reason = `Tester changed files: ${changes.join(", ")}`
        yield* TaskOrchestratorRetryPersistence.apply({
          db: input.db,
          taskID: input.taskID,
          stepID: step.id,
          runID,
          transition: { action: "fail", stepStatus: "failed", taskStatus: "failed", runStatus: "failed", retryCount: step.retry_count, failureReason: reason },
        })
        return
      }
      yield* input.db.update(TaskOrchestratorRunTable).set({ status: "completed", output, finished_at: Date.now() }).where(eq(TaskOrchestratorRunTable.id, runID)).run().pipe(Effect.orDie)
      yield* input.db.update(TaskOrchestratorStepTable).set({ status: "completed", output, finished_at: Date.now() }).where(eq(TaskOrchestratorStepTable.id, step.id)).run().pipe(Effect.orDie)
      continue
    }

    const output = yield* input.runner.output({ role: step.role, prompt: current.prompt })
    yield* input.db.update(TaskOrchestratorRunTable).set({ status: "completed", output, finished_at: Date.now() }).where(eq(TaskOrchestratorRunTable.id, runID)).run().pipe(Effect.orDie)
    yield* input.db.update(TaskOrchestratorStepTable).set({ status: "completed", output, finished_at: Date.now() }).where(eq(TaskOrchestratorStepTable.id, step.id)).run().pipe(Effect.orDie)
  }

  const latest = yield* input.db.select().from(TaskOrchestratorTaskTable).where(eq(TaskOrchestratorTaskTable.id, input.taskID)).get().pipe(Effect.orDie)
  const remaining = yield* input.db.select().from(TaskOrchestratorStepTable).where(eq(TaskOrchestratorStepTable.task_id, input.taskID)).all().pipe(Effect.orDie)
  if (latest && latest.status !== "paused" && latest.status !== "aborted" && latest.status !== "failed" && remaining.every((item) => item.status === "completed")) {
    yield* input.db.update(TaskOrchestratorTaskTable).set({ status: "completed", updated_at: Date.now() }).where(eq(TaskOrchestratorTaskTable.id, input.taskID)).run().pipe(Effect.orDie)
  }
})
