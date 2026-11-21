import { expect, test } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { RelayAuth } from "@opencode-ai/core/relay-auth"
import { RelayCatalog } from "@opencode-ai/core/relay-catalog"
import { RelaySecretStore } from "@opencode-ai/core/relay-secret-store"
import { Relay } from "@opencode-ai/schema/relay"
import { EventV2 } from "@opencode-ai/core/event"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { Model } from "@opencode-ai/schema/model"
import { tmpdir } from "./fixture/tmpdir"
import path from "node:path"

const id = Relay.VendorID.make("review")
const client = (body: () => Effect.Effect<unknown>) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      body().pipe(Effect.map((json) => HttpClientResponse.fromWeb(request, Response.json(json)))),
    ),
  )

const open = (
  root: string,
  name: string,
  http?: Layer.Layer<HttpClient.HttpClient>,
  options?: {
    auth?: Layer.Layer<RelayAuth.Service>
    flock?: Layer.Layer<EffectFlock.Service>
    files?: Layer.Layer<FSUtil.Service>
    events?: Layer.Layer<EventV2.Service>
  },
) => {
  const global = Global.layerWith({ data: root, state: path.join(root, name) })
  const files = options?.files ?? AppNodeBuilder.build(FSUtil.node)
  const secrets = RelaySecretStore.makeLayer(undefined).pipe(Layer.provide(files), Layer.provide(global))
  return AppNodeBuilder.build(
    LayerNode.group([RelayAuth.node, RelayCatalog.node, EffectFlock.node, FSUtil.node, EventV2.node]),
    [
      [Global.node, global],
      [FSUtil.node, files],
      [RelaySecretStore.node, secrets],
      ...(http ? [[LayerNodePlatform.httpClient, http] as const] : []),
      ...(options?.auth ? [[RelayAuth.node, options.auth] as const] : []),
      ...(options?.flock ? [[EffectFlock.node, options.flock] as const] : []),
      ...(options?.events ? [[EventV2.node, options.events] as const] : []),
    ],
  )
}

for (const change of ["clear", "replace", "key", "url", "other"] as const)
  test(`RV-01 probe completion after vendor ${change}`, async () => {
    await using tmp = await tmpdir()
    const entered = Deferred.makeUnsafe<void>()
    const release = Deferred.makeUnsafe<void>()
    await Effect.gen(function* () {
      const auth = yield* RelayAuth.Service
      const catalog = yield* RelayCatalog.Service
      const saved = yield* auth.setVendor({
        id,
        name: "Before",
        baseURL: "https://old.invalid/v1",
        key: "fake-old",
        revision: 0,
      })
      const old = saved.vendors.find((vendor) => vendor.id === id)!
      const running = yield* catalog
        .probe(id, { expectedEntityId: old.entityId, expectedVendorRevision: old.revision })
        .pipe(Effect.forkChild)
      yield* Deferred.await(entered).pipe(Effect.timeout("5 seconds"))
      if (change === "clear") yield* auth.clearVendorKey({ id, revision: saved.revision })
      if (change === "replace") {
        const removed = yield* auth.deleteVendor({ id, revision: saved.revision })
        yield* auth.setVendor({
          id,
          name: "Replacement",
          baseURL: "https://new.invalid/v1",
          key: "fake-new",
          revision: removed.revision,
        })
      }
      if (change === "key") yield* auth.setVendor({ id, key: "fake-rotated", revision: saved.revision })
      if (change === "url") yield* auth.setVendor({ id, baseURL: "https://next.invalid/v1", revision: saved.revision })
      if (change === "other")
        yield* auth.setVendor({
          id: Relay.VendorID.make("other"),
          name: "Other",
          baseURL: "https://other.invalid/v1",
          key: "fake-other",
          revision: saved.revision,
        })
      yield* Deferred.succeed(release, undefined)
      const result = yield* Fiber.await(running).pipe(Effect.timeout("5 seconds"))
      console.info("RV-01 observed", {
        change,
        exit: result._tag,
        count: Exit.isSuccess(result) ? result.value.count : undefined,
        currentHasKey: (yield* auth.get()).vendors[0]?.hasKey,
      })
      expect(Exit.isFailure(result)).toBe(change !== "other")
      if (Exit.isFailure(result))
        expect(
          result.cause.reasons.flatMap((reason) =>
            reason._tag === "Fail" && reason.error instanceof RelayCatalog.CatalogError ? [reason.error.info.code] : [],
          ),
        ).toContain("REQUEST_CONFLICT")
    }).pipe(
      Effect.scoped,
      Effect.provide(
        open(
          tmp.path,
          "probe",
          client(() =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as({ data: [{ id: "old-model" }] }),
            ),
          ),
        ),
      ),
      Effect.ensuring(Deferred.succeed(release, undefined)),
      Effect.runPromise,
    )
  })

test("RV-02 committed refresh stays successful when another writer acquires the auth lock afterwards", async () => {
  await using tmp = await tmpdir()
  const publishing = Deferred.makeUnsafe<void>()
  const allowPublish = Deferred.makeUnsafe<void>()
  const locked = Deferred.makeUnsafe<void>()
  const unlock = Deferred.makeUnsafe<void>()
  let armed = false
  const events = Layer.effect(
    EventV2.Service,
    Effect.gen(function* () {
      const original = yield* EventV2.Service
      return EventV2.Service.of({
        ...original,
        publish: (definition, data, options) =>
          (armed
            ? Deferred.succeed(publishing, undefined).pipe(Effect.andThen(Deferred.await(allowPublish)))
            : Effect.void
          ).pipe(Effect.andThen(original.publish(definition, data, options))),
      })
    }),
  ).pipe(Layer.provide(AppNodeBuilder.build(EventV2.node)))
  await Effect.gen(function* () {
    const auth = yield* RelayAuth.Service
    const catalog = yield* RelayCatalog.Service
    const flock = yield* EffectFlock.Service
    yield* auth.setVendor({
      id,
      name: "Review",
      baseURL: "https://review.invalid/v1",
      key: "fake-current",
      revision: 0,
    })
    const running = yield* catalog.refresh(id).pipe(Effect.forkChild)
    yield* Deferred.await(publishing).pipe(Effect.timeout("5 seconds"))
    const holder = yield* Effect.scoped(
      Effect.gen(function* () {
        yield* flock.acquire(RelayCatalog.AUTH_LOCK_KEY, path.join(tmp.path, "locks"))
        yield* Deferred.succeed(locked, undefined)
        yield* Deferred.await(unlock)
      }),
    ).pipe(Effect.forkChild)
    yield* Deferred.await(locked).pipe(Effect.timeout("5 seconds"))
    yield* Deferred.succeed(allowPublish, undefined)
    const result = yield* Fiber.await(running).pipe(Effect.timeout("5 seconds"))
    const stored = yield* Effect.promise(() => Bun.file(path.join(tmp.path, "relay-catalog.json")).json())
    yield* Deferred.succeed(unlock, undefined)
    yield* Fiber.join(holder)
    console.info("RV-02 observed", {
      exit: result._tag,
      diskModels: stored.candidates.map((item: { modelId: string }) => item.modelId),
      tokenExists: stored.refreshRequests[id] !== undefined,
      errors: Exit.isFailure(result)
        ? result.cause.reasons
            .filter((reason) => reason._tag === "Fail")
            .map((reason) =>
              reason._tag === "Fail" && reason.error instanceof RelayCatalog.CatalogError
                ? reason.error.info
                : undefined,
            )
        : [],
    })
    expect(stored.candidates.map((item: { modelId: string }) => item.modelId)).toEqual(["committed-model"])
    expect(stored.refreshRequests[id]).toBeUndefined()
    expect(Exit.isSuccess(result)).toBe(true)
  }).pipe(
    Effect.scoped,
    Effect.provide(
      open(
        tmp.path,
        "committed",
        client(() =>
          Effect.sync(() => {
            armed = true
            return { data: [{ id: "committed-model" }] }
          }),
        ),
        { events },
      ),
    ),
    Effect.ensuring(Deferred.succeed(allowPublish, undefined)),
    Effect.ensuring(Deferred.succeed(unlock, undefined)),
    Effect.runPromise,
  )
})

test("REVIEW controls: unchanged credentials and successful refresh without lock contention", async () => {
  await using tmp = await tmpdir()
  await Effect.gen(function* () {
    const auth = yield* RelayAuth.Service
    const catalog = yield* RelayCatalog.Service
    yield* auth.setVendor({
      id,
      name: "Review",
      baseURL: "https://review.invalid/v1",
      key: "fake-control",
      revision: 0,
    })
    expect((yield* catalog.probe(id)).count).toBe(1)
    expect((yield* catalog.refresh(id)).map((model) => String(model.modelId))).toEqual(["control"])
  }).pipe(
    Effect.scoped,
    Effect.provide(
      open(
        tmp.path,
        "control",
        client(() => Effect.succeed({ data: [{ id: "control" }] })),
      ),
    ),
    Effect.runPromise,
  )
})
