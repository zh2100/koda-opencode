import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { TaskOrchestratorRetry } from "@opencode-ai/core/task-orchestrator/retry"
import { TaskOrchestratorWorkerSchedulerService } from "@opencode-ai/core/task-orchestrator/worker-scheduler-service"

describe("TaskOrchestratorWorkerSchedulerService", () => {
  test("rejects invalid transitions without calling prompt", async () => {
    const calls: unknown[] = []
    const sessionID = SessionSchema.ID.make("ses_worker")
    const service = TaskOrchestratorWorkerSchedulerService.make({
      prompt: (input) => Effect.sync(() => calls.push(input)).pipe(
        Effect.andThen(Effect.fail(new SessionV2.NotFoundError({ sessionID }))),
      ),
    })
    const transitions: TaskOrchestratorRetry.Transition[] = [
      { action: "continue", stepStatus: "completed", taskStatus: "pending", runStatus: "completed", retryCount: 0 },
      { action: "fail", stepStatus: "failed", taskStatus: "failed", runStatus: "failed", retryCount: 0, failureReason: "rejected" },
      { action: "revise", stepStatus: "needs_revision", taskStatus: "pending", runStatus: "needs_revision", retryCount: 1, workerPrompt: "   " },
    ]
    for (const transition of transitions) {
      const result = await Effect.runPromise(service.schedule({ sessionID, transition }).pipe(Effect.flip))
      expect(result._tag).toBe("TaskOrchestrator.InvalidWorkerTransitionError")
    }
    expect(calls).toEqual([])
  })

  test("passes revision input and preserves Session errors", async () => {
    const calls: Parameters<SessionV2.Interface["prompt"]>[0][] = []
    const sessionID = SessionSchema.ID.make("ses_worker")
    const error = new SessionV2.NotFoundError({ sessionID })
    const service = TaskOrchestratorWorkerSchedulerService.make({
      prompt: (input) => Effect.sync(() => calls.push(input)).pipe(Effect.andThen(Effect.fail(error))),
    })
    const result = await Effect.runPromise(service.schedule({
      sessionID,
      transition: { action: "revise", stepStatus: "needs_revision", taskStatus: "pending", runStatus: "needs_revision", retryCount: 2, workerPrompt: "Fix validation" },
    }).pipe(Effect.flip))
    expect(result).toBe(error)
    expect(calls).toEqual([{ sessionID, prompt: { text: "Worker revision #2:\n\nFix validation" } }])
  })
})
