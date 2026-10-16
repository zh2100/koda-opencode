import { describe, expect, test } from "bun:test"
import { TaskOrchestratorReview } from "@opencode-ai/core/task-orchestrator/review"
import { TaskOrchestratorRetry } from "@opencode-ai/core/task-orchestrator/retry"
import { TaskOrchestratorRetryPersistence } from "@opencode-ai/core/task-orchestrator/retry-persistence"

describe("TaskOrchestratorRetry", () => {
  test("completes an approved review", () => {
    expect(
      TaskOrchestratorRetry.transition({
        review: TaskOrchestratorReview.store('{"approved":true,"findings":[]}', TaskOrchestratorReview.plan('{"approved":true,"findings":[]}', 0, 1)),
        maxRetries: 1,
        stepRetryCount: 0,
      }),
    ).toMatchObject({ action: "continue", stepStatus: "completed", runStatus: "completed" })
  })

  test("moves a rejected review into a bounded revision", () => {
    const output = '{"approved":false,"findings":[{"message":"Fix it"}]}'
    expect(
      TaskOrchestratorRetry.transition({
        review: TaskOrchestratorReview.store(output, TaskOrchestratorReview.plan(output, 0, 2)),
        maxRetries: 2,
        stepRetryCount: 0,
      }),
    ).toMatchObject({ action: "revise", stepStatus: "needs_revision", retryCount: 1 })
  })

  test("fails instead of exceeding the retry limit", () => {
    const output = '{"approved":false,"findings":[{"message":"Still broken"}]}'
    expect(
      TaskOrchestratorRetry.transition({
        review: TaskOrchestratorReview.store(output, TaskOrchestratorReview.plan(output, 2, 2)),
        maxRetries: 2,
        stepRetryCount: 2,
      }),
    ).toMatchObject({ action: "fail", taskStatus: "failed", failureReason: "Reviewer retry limit reached" })
  })

  test("does not retry a revision without a worker prompt", () => {
    const review = { kind: "review", reviewerOutput: "x", approved: false, findings: [], action: "revise", retryCount: 0 } as const
    expect(TaskOrchestratorRetry.transition({ review, maxRetries: 2, stepRetryCount: 0 })).toMatchObject({ action: "fail" })
  })

  test("defines a typed conflict for stale or terminal database state", () => {
    const error = new TaskOrchestratorRetryPersistence.StateConflictError({
      taskID: "task",
      stepID: "step",
      runID: "run",
      message: "already completed",
    })
    expect(error._tag).toBe("TaskOrchestrator.StateConflictError")
    expect(error.message).toBe("already completed")
  })
})
