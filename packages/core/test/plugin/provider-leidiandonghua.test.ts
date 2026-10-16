import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Catalog } from "@opencode-ai/core/catalog"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { PluginHost } from "@opencode-ai/core/plugin/host"
import { ProviderPlugins } from "@opencode-ai/core/plugin/provider"
import { LeidiandonghuaPlugin } from "@opencode-ai/core/plugin/provider/leidiandonghua"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { RelayPolicy } from "@opencode-ai/core/relay-policy"
import { RelayCatalog } from "@opencode-ai/core/relay-catalog"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

const addPlugin = Effect.fn(function* () {
  const plugin = yield* PluginV2.Service
  const host = yield* PluginHost.make(plugin)
  yield* LeidiandonghuaPlugin.effect(host)
})

describe("LeidiandonghuaPlugin", () => {
  it.effect("is registered before openai-compatible", () =>
    Effect.sync(() => {
      const ids = ProviderPlugins.map((plugin) => plugin.id)
      expect(ids.indexOf("leidiandonghua")).toBeGreaterThan(-1)
      expect(ids.indexOf("leidiandonghua")).toBeLessThan(ids.indexOf("openai-compatible"))
    }),
  )

  it.effect("does not register the relay provider without config or managed models", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      yield* addPlugin().pipe(Effect.provide(Layer.mock(RelayCatalog.Service, {
        hasManaged: () => false,
        visible: () => false,
        apply: () => undefined,
      })))
      expect(yield* catalog.provider.get(ProviderV2.ID.leidiandonghua)).toBeUndefined()
      expect(yield* catalog.provider.all()).toEqual([])
    }),
  )

  it.effect("registers the relay provider for managed models without provider config", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      yield* addPlugin().pipe(Effect.provide(Layer.mock(RelayCatalog.Service, {
        hasManaged: () => true,
        visible: () => false,
        apply: () => undefined,
      })))
      expect((yield* catalog.provider.get(ProviderV2.ID.leidiandonghua))?.api).toMatchObject({
        package: "@ai-sdk/openai-compatible",
      })
    }),
  )

  it.effect("overlays relay settings onto a configured provider", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      yield* catalog.transform((draft) => {
        draft.provider.update(ProviderV2.ID.leidiandonghua, () => {})
      })
      yield* addPlugin()
      const provider = yield* catalog.provider.get(ProviderV2.ID.leidiandonghua)
      expect(provider?.name).toBe("智联AI")
      expect(provider?.api).toEqual({
        type: "aisdk",
        package: "@ai-sdk/openai-compatible",
        url: RelayPolicy.BaseURL,
      })
      expect((yield* catalog.provider.all()).map((item) => item.id)).toEqual([ProviderV2.ID.leidiandonghua])
    }),
  )
})
