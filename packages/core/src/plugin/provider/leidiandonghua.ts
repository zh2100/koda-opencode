import { Cause, Effect, Exit, Stream } from "effect"
import { define } from "../internal"
import { EventV2 } from "../../event"
import { ProviderV2 } from "../../provider"
import { RelayCatalog } from "../../relay-catalog"
import { RelayEvent } from "@opencode-ai/schema/relay-event"

export const LeidiandonghuaPlugin = define({
  id: "leidiandonghua",
  effect: Effect.fn(function* (ctx) {
    const relay = yield* RelayCatalog.Service
    const events = yield* EventV2.Service
    yield* ctx.catalog.transform((catalog) => {
      if (!relay.hasManaged()) {
        catalog.provider.remove(ProviderV2.ID.leidiandonghua)
        return
      }
      catalog.provider.update(ProviderV2.ID.leidiandonghua, (provider) => {
        provider.name = "Custom providers"
        provider.api = {
          type: "aisdk",
          package: "@ai-sdk/openai-compatible",
        }
      })
      relay.apply((providerID, modelID, fn) => catalog.model.update(providerID, modelID, fn))
    })
    let sequence = 0
    let pending = 0
    yield* events.subscribe(RelayEvent.CatalogUpdated).pipe(
      Stream.runForEach(() =>
        Effect.gen(function* () {
          const captured = ++sequence
          pending = captured
          for (let attempt = 0; attempt < 3; attempt += 1) {
            const result = yield* relay.syncVendors().pipe(Effect.andThen(ctx.catalog.reload()), Effect.exit)
            if (Exit.isSuccess(result)) {
              if (pending === captured) pending = 0
              return
            }
            if (Cause.hasInterrupts(result.cause)) return yield* Effect.failCause(result.cause)
            if (attempt < 2) {
              yield* Effect.sleep(100 * 2 ** attempt)
              continue
            }
            yield* Effect.logWarning("Relay catalog consumer awaits recovery", {
              sequence: pending,
              attempts: 3,
              reasons: result.cause.reasons.map((reason) => reason._tag),
            })
          }
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
})
