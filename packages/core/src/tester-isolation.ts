export * as TesterIsolation from "./tester-isolation"

import { Context, Effect, Layer, Schema } from "effect"
import { Location } from "./location"
import { makeLocationNode } from "./effect/app-node"

export class AcquireError extends Schema.TaggedErrorClass<AcquireError>()("TesterIsolation.AcquireError", {
  message: Schema.String,
}) {}

export class ReleaseError extends Schema.TaggedErrorClass<ReleaseError>()("TesterIsolation.ReleaseError", {
  message: Schema.String,
}) {}

export interface Lease {
  readonly location: Location.Ref
  readonly release: Effect.Effect<void, ReleaseError>
}

export interface Interface {
  readonly acquire: (input: {
    readonly source: Location.Ref
    readonly name: string
  }) => Effect.Effect<Lease, AcquireError>
}

export const withIsolation = <A, R>(
  service: Interface,
  input: Parameters<Interface["acquire"]>[0],
  effect: (lease: Lease) => Effect.Effect<A, R>,
) => Effect.acquireUseRelease(service.acquire(input), effect, (lease) => lease.release)

export class Service extends Context.Service<Service, Interface>()("@opencode/TesterIsolation") {}

export const node = makeLocationNode({
  service: Service,
  layer: Layer.succeed(
    Service,
    Service.of({
      acquire: () => Effect.fail(new AcquireError({ message: "Tester isolation is not configured" })),
    }),
  ),
  deps: [],
})
