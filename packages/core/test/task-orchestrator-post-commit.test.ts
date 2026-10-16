import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { TaskOrchestratorPostCommit } from "@opencode-ai/core/task-orchestrator/post-commit"
import { TaskOrchestratorRetry } from "@opencode-ai/core/task-orchestrator/retry"
import { TaskOrchestratorRetryPersistence } from "@opencode-ai/core/task-orchestrator/retry-persistence"
import { TaskOrchestratorWorkerScheduler } from "@opencode-ai/core/task-orchestrator/worker-scheduler"

const revision: TaskOrchestratorRetry.Transition = {
  action: "revise",
  stepStatus: "needs_revision",
  taskStatus: "pending",
  runStatus: "needs_revision",
  retryCount: 1,
  workerPrompt: "Fix the finding",
}

describe("TaskOrchestratorPostCommit", () => {
  test("schedules only after persistence succeeds", async () => {
    const calls: string[] = []
    await Effect.runPromise(
      TaskOrchestratorPostCommit.applyAndSchedule({
        transition: revision,
        persist: () => Effect.sync(() => calls.push("persist")),
        scheduler: { schedule: ({ prompt }) => Effect.sync(() => calls.push(`schedule:${prompt}`)) },
      }),
    )
    expect(calls).toEqual(["persist", "schedule:Fix the finding"])
  })

  test("does not schedule after a persistence failure", async () => {
    const calls: string[] = []
    const result = await Effect.runPromiseExit(
      TaskOrchestratorPostCommit.applyAndSchedule({
        transition: revision,
        persist: () => Effect.fail(new TaskOrchestratorRetryPersistence.StateConflictError({ taskID: "t", stepID: "s", runID: "r", message: "stale" })),
        scheduler: { schedule: () => Effect.sync(() => calls.push("schedule")) },
      }),
    )
    expect(result._tag).toBe("Failure")
    expect(calls).toEqual([])
  })

  test("does not schedule for an approved transition", async () => {
    const calls: string[] = []
    const transition: TaskOrchestratorRetry.Transition = {
      action: "continue",
      stepStatus: "completed",
      taskStatus: "pending",
      runStatus: "completed",
      retryCount: 0,
    }
    await Effect.runPromise(
      TaskOrchestratorPostCommit.applyAndSchedule({
        transition,
        persist: () => Effect.sync(() => calls.push("persist")),
        scheduler: { schedule: () => Effect.sync(() => calls.push("schedule")) },
      }),
    )
    expect(calls).toEqual(["persist"])
  })

  test("does not schedule when the post-commit operation is interrupted", async () => {
    const calls: string[] = []
    const result = await Effect.runPromiseExit(
      TaskOrchestratorPostCommit.applyAndSchedule({
        transition: revision,
        persist: () => Effect.never,
        scheduler: { schedule: () => Effect.sync(() => calls.push("schedule")) },
      }).pipe(Effect.timeout("10 millis")),
    )
    expect(result._tag).toBe("Failure")
    expect(calls).toEqual([])
  })

  test("rejects direct scheduling of a non-revision transition", async () => {
    const result = await Effect.runPromiseExit(
      TaskOrchestratorWorkerScheduler.schedule({
        transition: { action: "continue", stepStatus: "completed", taskStatus: "pending", runStatus: "completed", retryCount: 0 },
        scheduler: { schedule: () => Effect.succeed(undefined) },
      }),
    )
    expect(result._tag).toBe("Failure")
  })
})
