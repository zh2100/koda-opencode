export * as TaskOrchestratorWorkerSchedulerService from "./worker-scheduler-service"

import { Context, Effect, Layer } from "effect"
import { SessionV2 } from "../session"
import { makeGlobalNode } from "../effect/app-node"
import { TaskOrchestratorRetry } from "./retry"
import { TaskOrchestratorWorkerScheduler } from "./worker-scheduler"
import { TaskOrchestratorWorkerSessionScheduler } from "./worker-session-scheduler"

export interface Interface {
  readonly schedule: (input: {
    readonly sessionID: Parameters<SessionV2.Interface["prompt"]>[0]["sessionID"]
    readonly transition: TaskOrchestratorRetry.Transition
  }) => Effect.Effect<
    Effect.Success<ReturnType<SessionV2.Interface["prompt"]>>,
    Effect.Error<ReturnType<SessionV2.Interface["prompt"]>> | TaskOrchestratorWorkerScheduler.InvalidTransitionError
  >
}

export class Service extends Context.Service<Service, Interface>()("@opencode/TaskOrchestratorWorkerScheduler") {}

export const make = (session: Pick<SessionV2.Interface, "prompt">): Interface => ({
  schedule: Effect.fn("TaskOrchestratorWorkerScheduler.schedule")(function* (input) {
    const scheduler = TaskOrchestratorWorkerSessionScheduler.make({ sessionID: input.sessionID, prompt: session.prompt })
    return yield* TaskOrchestratorWorkerScheduler.schedule({ transition: input.transition, scheduler })
  }),
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const session = yield* SessionV2.Service
    return Service.of(make(session))
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [SessionV2.node] })
