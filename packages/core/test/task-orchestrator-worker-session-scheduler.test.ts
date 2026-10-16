import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { TaskOrchestratorWorkerSessionScheduler } from "@opencode-ai/core/task-orchestrator/worker-session-scheduler"
import { TaskOrchestratorWorkerScheduler } from "@opencode-ai/core/task-orchestrator/worker-scheduler"

describe("TaskOrchestratorWorkerSessionScheduler", () => {
  test("admits a revision prompt and leaves wake-up to Session.prompt", async () => {
    let received: unknown
    const sessionID = SessionSchema.ID.make("ses_worker")
    const scheduler = TaskOrchestratorWorkerSessionScheduler.make({
      sessionID,
      prompt: (input) =>
        Effect.sync(() => {
          received = input
          return {} as never
        }),
    })
    const transition: TaskOrchestratorWorkerScheduler.Interface<never, never> extends never ? never : {
      readonly action: "revise"
      readonly stepStatus: "needs_revision"
      readonly taskStatus: "pending"
      readonly runStatus: "needs_revision"
      readonly retryCount: number
      readonly workerPrompt: string
    } = {
      action: "revise",
      stepStatus: "needs_revision",
      taskStatus: "pending",
      runStatus: "needs_revision",
      retryCount: 2,
      workerPrompt: "Fix the failing test",
    }

    const result = await Effect.runPromiseExit(TaskOrchestratorWorkerScheduler.schedule({ transition, scheduler }))
    expect(result._tag).toBe("Success")
    expect(received).toEqual({
      sessionID,
      prompt: { text: "Worker revision #2:\n\nFix the failing test" },
    })
  })
})
