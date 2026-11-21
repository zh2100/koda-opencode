import { expect, test } from "bun:test"
import { Deferred, Effect, Exit, Layer } from "effect"
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
  AppNodeBuilder.build(LayerNode.group([RelayAuth.node, RelayCatalog.node, EventV2.node]), [
    [Global.node, Global.layerWith({ data: root })],
    [RelaySecretStore.node, RelaySecretStore.memoryLayer],
  ])
import { EventV2 } from "@opencode-ai/core/event"
import { RelayEvent } from "@opencode-ai/schema/relay-event"

for (const breakFirst of [false, true])
  test(`RV-06 actual plugin survives one transient catalog read failure, fault=${breakFirst}`, async () => {
    await using tmp = await tmpdir()
    const id = Relay.VendorID.make("plugin-recovery")
    await Effect.gen(function* () {
      const auth = yield* RelayAuth.Service
      const relay = yield* RelayCatalog.Service
      const events = yield* EventV2.Service
      yield* auth.setVendor({
        id,
        name: "Plugin recovery",
        baseURL: "https://plugin.invalid/v1",
        key: "fake-plugin",
        revision: 0,
      })
      yield* relay.setVisibility({ vendorId: id, modelId: Model.ID.make("first"), visible: true })
      const firstHandled = Deferred.makeUnsafe<void>()
      let attempts = 0
      const observed = RelayCatalog.Service.of({
        ...relay,
        syncVendors: () =>
          Effect.gen(function* () {
            attempts += 1
            if (breakFirst && attempts === 1) {
              const file = path.join(tmp.path, "relay-catalog.json")
              const original = yield* Effect.promise(() => Bun.file(file).text())
              yield* Effect.promise(() => Bun.write(file, "{ transient-test-corruption"))
              return yield* relay
                .syncVendors()
                .pipe(
                  Effect.ensuring(Effect.promise(() => Bun.write(file, original))),
                  Effect.ensuring(Deferred.succeed(firstHandled, undefined)),
                )
            }
            yield* relay.syncVendors()
            yield* Deferred.succeed(firstHandled, undefined)
          }),
      })
      yield* Effect.gen(function* () {
        const catalog = yield* Catalog.Service
        const plugin = yield* PluginV2.Service
        const host = yield* PluginHost.make(plugin)
        yield* LeidiandonghuaPlugin.effect(host).pipe(
          Effect.provideService(RelayCatalog.Service, observed),
          Effect.provideService(EventV2.Service, events),
        )
        expect(yield* catalog.model.get(ProviderV2.ID.leidiandonghua, RelayCatalog.modelID(id, "first"))).toBeDefined()
        yield* relay.setVisibility({ vendorId: id, modelId: Model.ID.make("first"), visible: false })
        yield* Deferred.await(firstHandled).pipe(Effect.timeout("3 seconds"))
        yield* relay.setVisibility({ vendorId: id, modelId: Model.ID.make("second"), visible: true })
        const recovered = yield* Effect.gen(function* () {
          for (;;) {
            const model = yield* catalog.model.get(ProviderV2.ID.leidiandonghua, RelayCatalog.modelID(id, "second"))
            if (model) return model
            yield* Effect.sleep("10 millis")
          }
        }).pipe(Effect.timeout("1 second"), Effect.exit)
        console.info("RV-06", { breakFirst, attempts, recovered: recovered._tag })
        expect(Exit.isSuccess(recovered)).toBe(true)
      }).pipe(Effect.scoped, Effect.provide(Layer.fresh(PluginTestLayer)))
    }).pipe(Effect.scoped, Effect.provide(open(tmp.path)), Effect.runPromise)
  })

test("RV-06 ending the plugin scope interrupts an in-flight consumer without restarting it", async () => {
  await using tmp = await tmpdir()
  await Effect.gen(function* () {
    const auth = yield* RelayAuth.Service
    const relay = yield* RelayCatalog.Service
    const events = yield* EventV2.Service
    const id = Relay.VendorID.make("cancel-consumer")
    yield* auth.setVendor({ id, name: "Cancel", baseURL: "https://cancel.invalid/v1", key: "fake-cancel", revision: 0 })
    const entered = Deferred.makeUnsafe<void>()
    const stopped = Deferred.makeUnsafe<void>()
    let attempts = 0
    const observed = RelayCatalog.Service.of({
      ...relay,
      syncVendors: () =>
        Effect.gen(function* () {
          attempts += 1
          yield* Deferred.succeed(entered, undefined)
          yield* Effect.never
        }).pipe(Effect.ensuring(Deferred.succeed(stopped, undefined))),
    })
    yield* Effect.gen(function* () {
      const plugin = yield* PluginV2.Service
      const host = yield* PluginHost.make(plugin)
      yield* LeidiandonghuaPlugin.effect(host).pipe(
        Effect.provideService(RelayCatalog.Service, observed),
        Effect.provideService(EventV2.Service, events),
      )
      yield* relay.setVisibility({ vendorId: id, modelId: Model.ID.make("cancel-model"), visible: true })
      yield* Deferred.await(entered).pipe(Effect.timeout("3 seconds"))
    }).pipe(Effect.scoped, Effect.provide(Layer.fresh(PluginTestLayer)))
    yield* Deferred.await(stopped).pipe(Effect.timeout("3 seconds"))
    yield* events.publish(RelayEvent.CatalogUpdated, {})
    yield* Effect.yieldNow
    expect(attempts).toBe(1)
  }).pipe(Effect.scoped, Effect.provide(open(tmp.path)), Effect.runPromise)
})
