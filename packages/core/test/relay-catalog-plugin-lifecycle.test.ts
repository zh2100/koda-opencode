import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { RelayAuth } from "@opencode-ai/core/relay-auth"
import { RelayCatalog } from "@opencode-ai/core/relay-catalog"
import { RelaySecretStore } from "@opencode-ai/core/relay-secret-store"
import { Catalog } from "@opencode-ai/core/catalog"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { PluginHost } from "@opencode-ai/core/plugin/host"
import { LeidiandonghuaPlugin } from "@opencode-ai/core/plugin/provider/leidiandonghua"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Model } from "@opencode-ai/schema/model"
import { Relay } from "@opencode-ai/schema/relay"
import { PluginTestLayer } from "./plugin/fixture"
import { tmpdir } from "./fixture/tmpdir"
import path from "node:path"

const open = (root: string) =>
  AppNodeBuilder.build(LayerNode.group([RelayAuth.node, RelayCatalog.node]), [
    [Global.node, Global.layerWith({ data: root })],
    [RelaySecretStore.node, RelaySecretStore.memoryLayer],
  ])
for (const state of ["valid", "replaced", "unbound"] as const)
  test(`R202/R206 actual plugin first install with ${state} catalog`, async () => {
    await using tmp = await tmpdir()
    const id = Relay.VendorID.make("plugin-review")
    await Effect.gen(function* () {
      const auth = yield* RelayAuth.Service
      const relay = yield* RelayCatalog.Service
      const saved = yield* auth.setVendor({
        id,
        name: "Review",
        baseURL: "https://before.invalid/v1",
        key: "fake-plugin",
        revision: 0,
      })
      yield* relay.setVisibility({ vendorId: id, modelId: Model.ID.make("first-model"), visible: true })
      if (state === "replaced") {
        const removed = yield* auth.deleteVendor({ id, revision: saved.revision })
        yield* auth.setVendor({
          id,
          name: "Next",
          baseURL: "https://after.invalid/v1",
          key: "fake-next",
          revision: removed.revision,
        })
      }
    }).pipe(Effect.scoped, Effect.provide(open(tmp.path)), Effect.runPromise)
    if (state === "unbound") {
      const stored = await Bun.file(path.join(tmp.path, "relay-catalog.json")).json()
      delete stored.vendorEntities[id]
      await Bun.write(path.join(tmp.path, "relay-catalog.json"), JSON.stringify(stored))
    }
    await Effect.gen(function* () {
      const relay = yield* RelayCatalog.Service
      yield* Effect.gen(function* () {
        const catalog = yield* Catalog.Service
        const plugin = yield* PluginV2.Service
        const host = yield* PluginHost.make(plugin)
        yield* LeidiandonghuaPlugin.effect(host).pipe(Effect.provideService(RelayCatalog.Service, relay))
        const model = yield* catalog.model.get(ProviderV2.ID.leidiandonghua, RelayCatalog.modelID(id, "first-model"))
        if (state === "valid") {
          expect(model?.enabled).toBe(true)
          expect(model?.api).toMatchObject({ url: "https://before.invalid/v1" })
        } else {
          expect(model).toBeUndefined()
          expect(yield* catalog.provider.get(ProviderV2.ID.leidiandonghua)).toBeUndefined()
        }
      }).pipe(Effect.scoped, Effect.provide(Layer.fresh(PluginTestLayer)))
    }).pipe(Effect.scoped, Effect.provide(open(tmp.path)), Effect.runPromise)
  })
