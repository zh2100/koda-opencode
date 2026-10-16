export * as TaskOrchestratorRetryPersistence from "./retry-persistence"

import { eq } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { Database } from "../database/database"
import { TaskOrchestratorRetry } from "./retry"
import { TaskOrchestratorRunTable, TaskOrchestratorStepTable, TaskOrchestratorTaskTable } from "./sql"

export class StateConflictError extends Schema.TaggedErrorClass<StateConflictError>()("TaskOrchestrator.StateConflictError", {
  taskID: Schema.String,
  stepID: Schema.String,
  runID: Schema.String,
  message: Schema.String,
}) {}

export const apply = Effect.fn("TaskOrchestratorRetryPersistence.apply")(function* (input: {
  readonly db: Database.Interface["db"]
  readonly taskID: string
  readonly stepID: string
  readonly runID: string
  readonly transition: TaskOrchestratorRetry.Transition
}) {
  return yield* input.db.transaction((tx) =>
    Effect.gen(function* () {
      const task = yield* tx
        .select({ status: TaskOrchestratorTaskTable.status })
        .from(TaskOrchestratorTaskTable)
        .where(eq(TaskOrchestratorTaskTable.id, input.taskID))
        .get()
      const step = yield* tx
        .select({ status: TaskOrchestratorStepTable.status })
        .from(TaskOrchestratorStepTable)
        .where(eq(TaskOrchestratorStepTable.id, input.stepID))
        .get()
      const run = yield* tx
        .select({ status: TaskOrchestratorRunTable.status })
        .from(TaskOrchestratorRunTable)
        .where(eq(TaskOrchestratorRunTable.id, input.runID))
        .get()
      if (!task || !step || !run || task.status !== "running" || step.status !== "running" || run.status !== "running") {
        return yield* new StateConflictError({
          taskID: input.taskID,
          stepID: input.stepID,
          runID: input.runID,
          message: "Retry transition requires a running task, step, and run",
        })
      }

      const now = Date.now()
      yield* tx
        .update(TaskOrchestratorRunTable)
        .set({
          status: input.transition.runStatus,
          retry_count: input.transition.retryCount,
          ...(input.transition.action === "fail" ? { failure_reason: input.transition.failureReason } : {}),
          finished_at: now,
        })
        .where(eq(TaskOrchestratorRunTable.id, input.runID))
        .run()
      yield* tx
        .update(TaskOrchestratorStepTable)
        .set({
          status: input.transition.stepStatus,
          retry_count: input.transition.retryCount,
          ...(input.transition.action === "fail" ? { failure_reason: input.transition.failureReason } : {}),
          finished_at: now,
        })
        .where(eq(TaskOrchestratorStepTable.id, input.stepID))
        .run()
      yield* tx
        .update(TaskOrchestratorTaskTable)
        .set({
          status: input.transition.taskStatus,
          ...(input.transition.action === "fail" ? { failure_reason: input.transition.failureReason } : {}),
          updated_at: now,
        })
        .where(eq(TaskOrchestratorTaskTable.id, input.taskID))
        .run()
      return input.transition
    }),
  )
})
