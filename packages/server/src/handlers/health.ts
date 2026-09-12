import { RelayGate } from "@opencode-ai/core/relay-gate"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"

export const HealthHandler = HttpApiBuilder.group(Api, "server.health", (handlers) =>
  Effect.gen(function* () {
    const gates = yield* RelayGate.Service
    return handlers.handle("health.get", () => Effect.succeed({ healthy: true as const, gates }))
  }),
)
