import { Effect, Stream } from "effect"
import { define } from "../internal"
import { EventV2 } from "../../event"
import { ProviderV2 } from "../../provider"
import { RelayCatalog } from "../../relay-catalog"
import { RelayEvent } from "@opencode-ai/schema/relay-event"
import { RelayPolicy } from "../../relay-policy"

export const LeidiandonghuaPlugin = define({
  id: "leidiandonghua",
  effect: Effect.fn(function* (ctx) {
    const relay = yield* RelayCatalog.Service
    const events = yield* EventV2.Service
    yield* ctx.catalog.transform((catalog) => {
      if (!catalog.provider.get(ProviderV2.ID.leidiandonghua)) return
      catalog.provider.update(ProviderV2.ID.leidiandonghua, (provider) => {
        provider.name = "智联AI"
        provider.api = {
          type: "aisdk",
          package: "@ai-sdk/openai-compatible",
          url: RelayPolicy.BaseURL,
        }
      })
      relay.apply((providerID, modelID, fn) => catalog.model.update(providerID, modelID, fn))
    })
    yield* events.subscribe(RelayEvent.CatalogUpdated).pipe(
      Stream.runForEach(() => ctx.catalog.reload()),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
})
