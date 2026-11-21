import { expect, test } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { RelayGroup } from "@opencode-ai/protocol/groups/relay"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { RelayAuth } from "@opencode-ai/core/relay-auth"
import { RelayCatalog } from "@opencode-ai/core/relay-catalog"
import { RelaySecretStore } from "@opencode-ai/core/relay-secret-store"
import { EventV2 } from "@opencode-ai/core/event"
import { Catalog } from "@opencode-ai/core/catalog"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { PluginHost } from "@opencode-ai/core/plugin/host"
import { LeidiandonghuaPlugin } from "@opencode-ai/core/plugin/provider/leidiandonghua"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Relay } from "../../schema/src/relay"
import { RelayEvent } from "../../schema/src/relay-event"
import { Model } from "../../schema/src/model"
import { RelayHandler } from "../src/handlers/relay"
import { LocationMiddleware } from "../src/location"
import { Authorization } from "../src/middleware/authorization"
import { schemaErrorLayer } from "../src/middleware/schema-error"
import { PluginTestLayer } from "../../core/test/plugin/fixture"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import path from "node:path"

for (const failure of ["sync", "reload"] as const)
  test(`RV-06 exhausted ${failure} consumer recovers through actual HTTP sync without a new change`, async () => {
    await using tmp = await tmpdir()
    const services = AppNodeBuilder.build(LayerNode.group([RelayAuth.node, RelayCatalog.node, EventV2.node]), [
      [Global.node, Global.layerWith({ data: tmp.path })],
      [RelaySecretStore.node, RelaySecretStore.memoryLayer],
    ])
    await Effect.gen(function* () {
      const auth = yield* RelayAuth.Service
      const relay = yield* RelayCatalog.Service
      const events = yield* EventV2.Service
      const id = Relay.VendorID.make("exhausted-consumer")
      yield* auth.setVendor({
        id,
        name: "Recovery",
        baseURL: "https://recovery.invalid/v1",
        key: "fake-recovery",
        revision: 0,
      })
      yield* relay.setVisibility({ vendorId: id, modelId: Model.ID.make("existing"), visible: true })
      const exhausted = Deferred.makeUnsafe<void>()
      let attempts = 0
      let failed = true
      let original = ""
      const file = path.join(tmp.path, "relay-catalog.json")
      const observed = RelayCatalog.Service.of({
        ...relay,
        syncVendors: () =>
          Effect.gen(function* () {
            attempts += 1
            if (failure === "sync" && failed && attempts === 1) {
              original = yield* Effect.promise(() => Bun.file(file).text())
              yield* Effect.promise(() => Bun.write(file, "{ controlled-unreadable"))
            }
            return yield* relay.syncVendors()
          }),
      })
      // The counter must be tested when the effect finishes, not while it is constructed.
      const monitored = RelayCatalog.Service.of({
        ...observed,
        syncVendors: () =>
          observed
            .syncVendors()
            .pipe(
              Effect.ensuring(
                Effect.suspend(() =>
                  failure === "sync" && attempts === 3 ? Deferred.succeed(exhausted, undefined) : Effect.void,
                ),
              ),
            ),
      })
      yield* Effect.gen(function* () {
        const catalog = yield* Catalog.Service
        const plugin = yield* PluginV2.Service
        const host = yield* PluginHost.make(plugin)
        let reloads = 0
        const controlledHost = {
          ...host,
          catalog: {
            ...host.catalog,
            reload: () =>
              Effect.suspend(() => {
                reloads += 1
                if (failure === "reload" && failed)
                  return Effect.die("controlled projection failure").pipe(
                    Effect.ensuring(reloads === 3 ? Deferred.succeed(exhausted, undefined) : Effect.void),
                  )
                return host.catalog.reload()
              }),
          },
        }
        yield* LeidiandonghuaPlugin.effect(controlledHost).pipe(
          Effect.provideService(RelayCatalog.Service, monitored),
          Effect.provideService(EventV2.Service, events),
        )
        expect(
          (yield* catalog.model.get(ProviderV2.ID.leidiandonghua, RelayCatalog.modelID(id, "existing")))?.enabled,
        ).toBe(true)
        yield* relay.setVisibility({ vendorId: id, modelId: Model.ID.make("existing"), visible: false })
        yield* Deferred.await(exhausted).pipe(Effect.timeout("5 seconds"))
        yield* Effect.yieldNow
        expect(attempts).toBe(3)
        expect(
          (yield* catalog.model.get(ProviderV2.ID.leidiandonghua, RelayCatalog.modelID(id, "existing")))?.enabled,
        ).toBe(true)
        if (failure === "sync") yield* Effect.promise(() => Bun.write(file, original))
        failed = false
        const before = yield* Effect.promise(() => Bun.file(file).text())
        const revision = (yield* auth.get()).revision
        const api = HttpApi.make("server").add(RelayGroup)
        const app = HttpRouter.toWebHandler(
          HttpApiBuilder.layer(api).pipe(
            Layer.provide(RelayHandler),
            // Relay endpoints use only the explicitly provided global auth/catalog services.
            // This fixture deliberately omits unrelated workspace routing and authentication.
            Layer.provide(
              Layer.succeed(
                LocationMiddleware,
                LocationMiddleware.of((effect) => effect as never),
              ),
            ),
            Layer.provide(
              Layer.succeed(
                Authorization,
                Authorization.of((effect) => effect),
              ),
            ),
            Layer.provide(schemaErrorLayer),
            Layer.provide(Layer.succeed(RelayAuth.Service, auth)),
            Layer.provide(Layer.succeed(RelayCatalog.Service, relay)),
            Layer.provide(HttpServer.layerServices),
          ),
          { disableLogger: true },
        )
        yield* Effect.tryPromise(async () => {
          try {
            const response = await app.handler(
              new Request("http://localhost/api/relay/models/sync", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ retryNotice: true }),
              }),
            )
            expect(response.status, await response.clone().text()).toBe(200)
          } finally {
            await app.dispose()
          }
        })
        yield* Effect.gen(function* () {
          for (;;) {
            if (
              (yield* catalog.model.get(ProviderV2.ID.leidiandonghua, RelayCatalog.modelID(id, "existing")))
                ?.enabled === false
            )
              return
            yield* Effect.sleep("5 millis")
          }
        }).pipe(Effect.timeout("3 seconds"))
        expect(attempts).toBe(4)
        expect((yield* auth.get()).revision).toBe(revision)
        expect(yield* Effect.promise(() => Bun.file(file).text())).toBe(before)
        yield* relay.syncVendors()
        expect(attempts).toBe(4)
      }).pipe(Effect.scoped, Effect.provide(Layer.fresh(PluginTestLayer)))
      const atExit = attempts
      yield* events.publish(RelayEvent.CatalogUpdated, {})
      yield* Effect.yieldNow
      expect(attempts).toBe(atExit)
    }).pipe(Effect.scoped, Effect.provide(services), Effect.runPromise)
  })
