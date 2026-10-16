export * as TesterSession from "./tester-session"

import { Effect } from "effect"
import { SessionV2 } from "./session"
import { TesterIsolation } from "./tester-isolation"

export const withTesterSession = <A, R>(input: {
  readonly isolation: TesterIsolation.Interface
  readonly create: SessionV2.Interface["create"]
  readonly source: Parameters<SessionV2.Interface["create"]>[0]
  readonly name: string
  readonly run: (sessionID: ReturnType<SessionV2.Interface["create"]> extends Effect.Effect<infer S, never, never> ? S extends { id: infer ID } ? ID : never : never) => Effect.Effect<A, R>
}) =>
  TesterIsolation.withIsolation(
    input.isolation,
    { source: input.source.location, name: input.name },
    (lease) =>
      input.create({ ...input.source, location: lease.location }).pipe(
        Effect.flatMap((session) => input.run(session.id)),
      ),
  )
