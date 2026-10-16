export * as TesterSessionBridge from "./tester-session-bridge"

import { Context, Effect, Layer } from "effect"
import { LocationServiceMap } from "./location-service-map"
import { SessionV2 } from "./session"
import { SessionSchema } from "./session/schema"
import { TesterIsolation } from "./tester-isolation"
import { makeGlobalNode } from "./effect/app-node"
import { AgentV2 } from "./agent"

export interface Interface {
  readonly use: <A, E, R>(input: {
    readonly source: Parameters<SessionV2.Interface["create"]>[0]
    readonly name: string
    readonly run: (sessionID: SessionSchema.ID) => Effect.Effect<A, E, R>
  }) => Effect.Effect<A, E | TesterIsolation.AcquireError | TesterIsolation.ReleaseError, R>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/TesterSessionBridge") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    const session = yield* SessionV2.Service

    const use: Interface["use"] = (input) => Effect.gen(function* () {
      const isolation = yield* TesterIsolation.Service.pipe(
        Effect.provide(locations.get(input.source.location)),
      )
      return yield* Effect.acquireUseRelease(
        isolation.acquire({ source: input.source.location, name: input.name }),
        (lease) => Effect.gen(function* () {
          const created = yield* session.create({
            location: lease.location,
            model: input.source.model,
            agent: AgentV2.ID.make("orchestrator-tester"),
          })
          return yield* input.run(created.id).pipe(
            Effect.ensuring(session.interrupt(created.id)),
          )
        }),
        (lease) => lease.release,
      )
    })

    return Service.of({ use })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [LocationServiceMap.node, SessionV2.node],
})
