export * as TaskOrchestratorPostCommit from "./post-commit"

import { Effect } from "effect"
import { TaskOrchestratorRetry } from "./retry"
import { TaskOrchestratorRetryPersistence } from "./retry-persistence"
import { TaskOrchestratorWorkerScheduler } from "./worker-scheduler"

export const applyAndSchedule = <A, E>(input: {
  readonly persist: (transition: TaskOrchestratorRetry.Transition) => Effect.Effect<unknown, TaskOrchestratorRetryPersistence.StateConflictError>
  readonly transition: TaskOrchestratorRetry.Transition
  readonly scheduler: TaskOrchestratorWorkerScheduler.Interface<A, E>
}) : Effect.Effect<A | undefined, E | TaskOrchestratorRetryPersistence.StateConflictError | TaskOrchestratorWorkerScheduler.InvalidTransitionError> =>
  input.persist(input.transition).pipe(
    Effect.flatMap((): Effect.Effect<A | undefined, E | TaskOrchestratorWorkerScheduler.InvalidTransitionError> => {
      if (input.transition.action !== "revise") return Effect.succeed(undefined)
      return TaskOrchestratorWorkerScheduler.schedule({ transition: input.transition, scheduler: input.scheduler })
    }),
  )
