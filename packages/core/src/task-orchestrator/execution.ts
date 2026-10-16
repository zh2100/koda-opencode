export * as TaskOrchestratorExecution from "./execution"

import { Effect } from "effect"
import { SessionSchema } from "../session/schema"
import { TesterSessionBridge } from "../tester-session-bridge"
import { TaskOrchestratorReview } from "./review"
import { TaskOrchestratorRetry } from "./retry"

export const settleReview = <A, E>(input: {
  readonly output: string
  readonly retryCount: number
  readonly maxRetries: number
  readonly sessionID: SessionSchema.ID
  readonly persist: (transition: TaskOrchestratorRetry.Transition) => Effect.Effect<unknown, E>
  readonly scheduler: {
    readonly schedule: (value: { readonly sessionID: SessionSchema.ID; readonly transition: TaskOrchestratorRetry.Transition }) => Effect.Effect<A, E>
  }
}) => {
  const transition = TaskOrchestratorRetry.transition({
    review: TaskOrchestratorReview.store(input.output, TaskOrchestratorReview.plan(input.output, input.retryCount, input.maxRetries)),
    maxRetries: input.maxRetries,
    stepRetryCount: input.retryCount,
  })
  return input.persist(transition).pipe(
    Effect.flatMap(() =>
      transition.action === "revise"
        ? input.scheduler.schedule({ sessionID: input.sessionID, transition })
        : Effect.void,
    ),
  )
}

export const runTester = <A, E>(input: {
  readonly bridge: Pick<TesterSessionBridge.Interface, "use">
  readonly source: Parameters<TesterSessionBridge.Interface["use"]>[0]["source"]
  readonly name: string
  readonly run: (sessionID: SessionSchema.ID) => Effect.Effect<A, E>
}) => input.bridge.use<A, E, never>(input)
