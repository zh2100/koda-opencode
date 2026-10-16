import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { TaskOrchestratorExecution } from "@opencode-ai/core/task-orchestrator/execution"
import type { TaskOrchestratorRetry } from "@opencode-ai/core/task-orchestrator/retry"

describe("TaskOrchestratorExecution", () => {
  test("persists a reviewer revision before scheduling the worker", async () => {
    const calls: string[] = []
    const scheduler = {
      schedule: ({ transition }: { readonly transition: TaskOrchestratorRetry.Transition }) =>
        Effect.sync(() => {
          calls.push(`schedule:${transition.action}`)
        }),
    }
    await Effect.runPromise(
      TaskOrchestratorExecution.settleReview({
        output: '{"approved":false,"findings":[{"message":"Fix it"}]}',
        retryCount: 0,
        maxRetries: 1,
        sessionID: SessionSchema.ID.make("ses_worker"),
        persist: (transition: TaskOrchestratorRetry.Transition) => Effect.sync(() => calls.push(`persist:${transition.action}`)),
        scheduler,
      }),
    )
    expect(calls).toEqual(["persist:revise", "schedule:revise"])
  })

  test("does not schedule when reviewer persistence fails", async () => {
    const calls: string[] = []
    const result = await Effect.runPromiseExit(
      TaskOrchestratorExecution.settleReview({
        output: '{"approved":false,"findings":[{"message":"Fix it"}]}',
        retryCount: 0,
        maxRetries: 1,
        sessionID: SessionSchema.ID.make("ses_worker"),
        persist: () => Effect.fail("conflict"),
        scheduler: {
          schedule: () =>
            Effect.sync(() => {
              calls.push("schedule")
            }),
        },
      }),
    )
    expect(result._tag).toBe("Failure")
    expect(calls).toEqual([])
  })

  test("routes tester execution through the isolation bridge", async () => {
    const calls: string[] = []
    await Effect.runPromise(
      TaskOrchestratorExecution.runTester({
        source: { location: { directory: "C:/repo" as never } },
        name: "tester",
        bridge: {
          use: <A, E, R>(input: { readonly run: (sessionID: SessionSchema.ID) => Effect.Effect<A, E, R> }) =>
            Effect.gen(function* () {
              calls.push("acquire")
              const result = yield* input.run(SessionSchema.ID.make("ses_tester"))
              calls.push("release")
              return result
            }),
        },
        run: () => Effect.sync(() => calls.push("test")),
      }),
    )
    expect(calls).toEqual(["acquire", "test", "release"])
  })
})
