export * as TaskOrchestratorWorkerScheduler from "./worker-scheduler"

import { Effect, Schema } from "effect"
import { TaskOrchestratorRetry } from "./retry"

export class InvalidTransitionError extends Schema.TaggedErrorClass<InvalidTransitionError>()("TaskOrchestrator.InvalidWorkerTransitionError", {
  message: Schema.String,
}) {}

export interface Interface<A, E> {
  readonly schedule: (input: { readonly prompt: string; readonly retryCount: number }) => Effect.Effect<A, E>
}

export const schedule = <A, E>(input: {
  readonly transition: TaskOrchestratorRetry.Transition
  readonly scheduler: Interface<A, E>
}): Effect.Effect<A, E | InvalidTransitionError> => {
  if (input.transition.action !== "revise") {
    return Effect.fail(new InvalidTransitionError({ message: "Worker scheduling requires a revise transition" }))
  }
  if (!input.transition.workerPrompt.trim()) {
    return Effect.fail(new InvalidTransitionError({ message: "Worker revision prompt must not be empty" }))
  }
  return input.scheduler.schedule({ prompt: input.transition.workerPrompt, retryCount: input.transition.retryCount })
}
