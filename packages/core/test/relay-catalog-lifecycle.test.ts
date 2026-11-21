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

for (const replaced of [false, true])
  test(`R201/R202 startup catalog entity binding, replaced=${replaced}`, async () => {
    await using tmp = await tmpdir()
    await Effect.gen(function* () {
      const auth = yield* RelayAuth.Service
      const catalog = yield* RelayCatalog.Service
      const saved = yield* auth.setVendor({
        id,
        name: "Before",
        baseURL: "https://before.invalid/v1",
        key: "fake-before",
        revision: 0,
      })
      yield* catalog.setVisibility({ vendorId: id, modelId: Model.ID.make("retired-model"), visible: true })
      if (replaced) {
        const removed = yield* auth.deleteVendor({ id, revision: saved.revision })
        yield* auth.setVendor({
          id,
          name: "After",
          baseURL: "https://after.invalid/v1",
          key: "fake-after",
          revision: removed.revision,
        })
      }
      // Represents termination after auth commit but before the handler's catalog sync.
    }).pipe(Effect.scoped, Effect.provide(open(tmp.path, "seed")), Effect.runPromise)
    const models = await Effect.gen(function* () {
      const catalog = yield* RelayCatalog.Service
      return (yield* catalog.managed()).map((item) => String(item.modelId))
    }).pipe(Effect.scoped, Effect.provide(open(tmp.path, "restart")), Effect.runPromise)
    expect(models).toEqual(replaced ? [] : ["retired-model"])
  })

test("R101 two instances: a stale reader sync must not cancel another instance's current refresh reservation", async () => {
  await using tmp = await tmpdir()
  const entered = Deferred.makeUnsafe<void>()
  const release = Deferred.makeUnsafe<void>()
  const http = client(() =>
    Effect.gen(function* () {
      yield* Deferred.succeed(entered, undefined)
      yield* Deferred.await(release)
      return { data: [{ id: "fresh-model" }] }
    }),
  )
  const models = await Effect.gen(function* () {
    const oldAuth = yield* RelayAuth.Service
    const oldCatalog = yield* RelayCatalog.Service
    const initial = yield* oldAuth.setVendor({
      id,
      name: "Review",
      baseURL: "https://review.invalid/v1",
      key: "fake-old",
      revision: 0,
    })
    yield* oldCatalog.syncVendors()
    return yield* Effect.gen(function* () {
      const auth = yield* RelayAuth.Service
      const catalog = yield* RelayCatalog.Service
      expect(catalog).not.toBe(oldCatalog)
      yield* auth.setVendor({ id, key: "fake-new", revision: initial.revision })
      yield* catalog.syncVendors()
      const running = yield* catalog.refresh(id).pipe(Effect.forkChild)
      yield* Deferred.await(entered).pipe(Effect.timeout("5 seconds"))
      yield* oldCatalog.synchronize()
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(running).pipe(Effect.timeout("5 seconds"))
      return (yield* catalog.candidates(id)).map((item) => String(item.modelId))
    }).pipe(Effect.scoped, Effect.provide(Layer.fresh(open(tmp.path, "writer", http))))
  }).pipe(
    Effect.scoped,
    Effect.provide(open(tmp.path, "reader")),
    Effect.ensuring(Deferred.succeed(release, undefined)),
    Effect.runPromise,
  )
  expect(models).toEqual(["fresh-model"])
})

const failures = (cause: Cause.Cause<unknown>) =>
  cause.reasons.flatMap((reason) =>
    reason._tag === "Fail" &&
    (reason.error instanceof RelayCatalog.CatalogError || reason.error instanceof RelayAuth.AuthError)
      ? [reason.error.info]
      : [],
  )

type Disk = {
  catalogRevision: number
  candidates: Array<{ vendorId?: string; sourceVendorId?: string; modelId: string; fingerprint: string }>
  managed: Array<{ vendorId: string; modelId: string; visible: boolean }>
  refreshRequests: Record<string, string>
  vendorEntities: Record<string, string>
  quarantine?: {
    version: number
    entries: Array<{
      vendorId?: string
      sourceVendorId?: string
      modelId: string
      reason: string
      kinds: string[]
      visible?: boolean
      knownEntities: Record<string, string>
    }>
  }
}
const disk = (root: string) => Bun.file(path.join(root, "relay-catalog.json")).json() as Promise<Disk>
const writeDisk = (root: string, value: Disk) => Bun.write(path.join(root, "relay-catalog.json"), JSON.stringify(value))
const seed = (baseURL = "https://review.invalid/v1") =>
  Effect.gen(function* () {
    const auth = yield* RelayAuth.Service
    return yield* auth.setVendor({
      id,
      name: "Review",
      baseURL,
      key: "fake-original",
      revision: (yield* auth.get()).revision,
    })
  })

for (const sync of [false, true])
  for (const change of ["key", "clear", "address"] as const)
    test(`R103 old ${change} response is rejected, explicit sync=${sync}`, async () => {
      await using tmp = await tmpdir()
      const entered = Deferred.makeUnsafe<void>()
      const release = Deferred.makeUnsafe<void>()
      const requests: Array<{ url: string; authorization: string | undefined }> = []
      const http = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.gen(function* () {
            requests.push({ url: request.url, authorization: request.headers.authorization })
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
            return HttpClientResponse.fromWeb(request, Response.json({ data: [{ id: "fresh" }] }))
          }),
        ),
      )
      await Effect.gen(function* () {
        const auth = yield* RelayAuth.Service
        const catalog = yield* RelayCatalog.Service
        const first = yield* seed()
        const running = yield* catalog.refresh(id).pipe(Effect.forkChild)
        yield* Deferred.await(entered).pipe(Effect.timeout("5 seconds"))
        if (change === "clear") yield* auth.clearVendorKey({ id, revision: first.revision })
        else
          yield* auth.setVendor({
            id,
            revision: first.revision,
            ...(change === "key" ? { key: "fake-next" } : { baseURL: "https://next.invalid/v1" }),
          })
        if (sync) yield* catalog.syncVendors()
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(running)
        expect(yield* catalog.candidates(id)).toEqual([])
        expect((yield* Effect.promise(() => disk(tmp.path))).refreshRequests[id]).toBeUndefined()
        expect(requests).toEqual([{ url: "https://review.invalid/v1/models", authorization: "Bearer fake-original" }])
        if (change === "clear") yield* auth.setVendor({ id, key: "fake-next", revision: (yield* auth.get()).revision })
        expect((yield* catalog.refresh(id)).map((item) => String(item.modelId))).toEqual(["fresh"])
        expect((yield* Effect.promise(() => disk(tmp.path))).refreshRequests[id]).toBeUndefined()
      }).pipe(
        Effect.scoped,
        Effect.provide(open(tmp.path, "change", http)),
        Effect.ensuring(Deferred.succeed(release, undefined)),
        Effect.runPromise,
      )
    })

for (const window of ["capture", "reserved"] as const)
  test(`R106 rejects a key change after ${window} before HTTP`, async () => {
    await using tmp = await tmpdir()
    let calls = 0
    await Effect.gen(function* () {
      const auth = yield* RelayAuth.Service
      const flock = yield* EffectFlock.Service
      yield* seed()
      let active = false
      let locks = 0
      const mutate = () =>
        Effect.gen(function* () {
          yield* auth.setVendor({ id, key: "fake-replacement", revision: (yield* auth.get()).revision })
        })
      const wrapped = Layer.succeed(
        RelayAuth.Service,
        RelayAuth.Service.of({
          ...auth,
          capture: (vendor, expected) =>
            auth
              .capture(vendor, expected)
              .pipe(Effect.tap(() => (window === "capture" && active ? mutate() : Effect.void))),
        }),
      )
      const locking = Layer.succeed(
        EffectFlock.Service,
        EffectFlock.Service.of({
          ...flock,
          acquire: (key, dir) =>
            Effect.gen(function* () {
              if (active && key === RelayCatalog.AUTH_LOCK_KEY && ++locks === 2 && window === "reserved")
                yield* mutate().pipe(Effect.orDie)
              yield* flock.acquire(key, dir)
            }),
        }),
      )
      yield* Effect.gen(function* () {
        const catalog = yield* RelayCatalog.Service
        active = true
        const result = yield* catalog.refresh(id).pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result))
          expect(failures(result.cause).map((info) => info.code)).toContain("REQUEST_CONFLICT")
        expect(calls).toBe(0)
        expect(locks).toBe(window === "capture" ? 1 : 3)
        if (window === "capture")
          expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "relay-catalog.json")).exists())).toBe(false)
        else expect((yield* Effect.promise(() => disk(tmp.path))).refreshRequests[id]).toBeUndefined()
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.fresh(
            open(
              tmp.path,
              "window",
              client(() => {
                calls++
                return Effect.succeed({ data: [{ id: "must-not-send" }] })
              }),
              { auth: wrapped, flock: locking },
            ),
          ),
        ),
      )
    }).pipe(Effect.scoped, Effect.provide(open(tmp.path, "seed")), Effect.runPromise)
  })

for (const sample of [
  { name: "401", status: 401, body: "{}", code: "KEY_REJECTED" },
  { name: "403", status: 403, body: "{}", code: "KEY_REJECTED" },
  { name: "bad-json", status: 200, body: "{", code: "UPSTREAM_INVALID_RESPONSE" },
  { name: "invalid-schema", status: 200, body: "{}", code: "UPSTREAM_INVALID_RESPONSE" },
  { name: "500", status: 500, body: "{}", code: "UPSTREAM_UNREACHABLE" },
])
  test(`R107 ${sample.name} keeps the error and removes only its token`, async () => {
    await using tmp = await tmpdir()
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(sample.body, { status: sample.status }),
    })
    try {
      await Effect.gen(function* () {
        const catalog = yield* RelayCatalog.Service
        yield* seed(`${server.url}v1`)
        const result = yield* catalog.refresh(id).pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result))
          expect(failures(result.cause).map((info) => String(info.code))).toContain(sample.code)
        const stored = yield* Effect.promise(() => disk(tmp.path))
        expect(stored.refreshRequests[id]).toBeUndefined()
        expect(stored.candidates).toEqual([])
      }).pipe(Effect.scoped, Effect.provide(open(tmp.path, "failure")), Effect.runPromise)
    } finally {
      server.stop(true)
    }
  })

test("R108 cancellation clears its token and preserves interruption", async () => {
  await using tmp = await tmpdir()
  const entered = Deferred.makeUnsafe<void>()
  await Effect.gen(function* () {
    const catalog = yield* RelayCatalog.Service
    yield* seed()
    const running = yield* catalog.refresh(id).pipe(Effect.forkChild)
    yield* Deferred.await(entered).pipe(Effect.timeout("5 seconds"))
    yield* Fiber.interrupt(running)
    const result = yield* Fiber.await(running)
    expect(Exit.isFailure(result) && Cause.hasInterrupts(result.cause)).toBe(true)
    expect((yield* Effect.promise(() => disk(tmp.path))).refreshRequests[id]).toBeUndefined()
  }).pipe(
    Effect.scoped,
    Effect.provide(
      open(
        tmp.path,
        "cancel",
        client(() => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))),
      ),
    ),
    Effect.runPromise,
  )
})

for (const ending of ["failure", "interrupt"] as const)
  test(`R109 bounded cleanup keeps the primary ${ending}`, async () => {
    await using tmp = await tmpdir()
    const entered = Deferred.makeUnsafe<void>()
    const respond = Deferred.makeUnsafe<void>()
    const held = Deferred.makeUnsafe<void>()
    const unlock = Deferred.makeUnsafe<void>()
    await Effect.gen(function* () {
      const catalog = yield* RelayCatalog.Service
      const flock = yield* EffectFlock.Service
      yield* seed()
      const running = yield* catalog.refresh(id).pipe(Effect.forkChild)
      yield* Deferred.await(entered).pipe(Effect.timeout("5 seconds"))
      const holder = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* flock.acquire(RelayCatalog.AUTH_LOCK_KEY, path.join(tmp.path, "locks"))
          yield* Deferred.succeed(held, undefined)
          yield* Deferred.await(unlock)
        }),
      ).pipe(Effect.forkChild)
      yield* Deferred.await(held)
      // Fallback release prevents a broken timeout from wedging the test process.
      yield* Effect.sleep("3500 millis").pipe(Effect.andThen(Deferred.succeed(unlock, undefined)), Effect.forkChild)
      const start = Date.now()
      if (ending === "interrupt") yield* Fiber.interrupt(running)
      else yield* Deferred.succeed(respond, undefined)
      const result = yield* Fiber.await(running)
      const elapsed = Date.now() - start
      yield* Deferred.succeed(unlock, undefined)
      yield* Fiber.join(holder)
      expect(elapsed).toBeLessThan(3000)
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) {
        if (ending === "interrupt") expect(Cause.hasInterrupts(result.cause)).toBe(true)
        else expect(failures(result.cause).map((info) => info.code)).toContain("UPSTREAM_INVALID_RESPONSE")
        expect(failures(result.cause).map((info) => info.details)).toContain("refresh cleanup")
      }
      expect((yield* Effect.promise(() => disk(tmp.path))).refreshRequests[id]).toBeDefined()
    }).pipe(
      Effect.scoped,
      Effect.provide(
        open(
          tmp.path,
          "cleanup-timeout",
          client(() =>
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(respond)
              return {}
            }),
          ),
        ),
      ),
      Effect.ensuring(Deferred.succeed(unlock, undefined)),
      Effect.runPromise,
    )
  })

test("R204/R208 unbound preferences are quarantined once and preserved on restart", async () => {
  await using tmp = await tmpdir()
  await Effect.gen(function* () {
    const catalog = yield* RelayCatalog.Service
    yield* seed()
    yield* catalog.setVisibility({ vendorId: id, modelId: Model.ID.make("legacy"), visible: true })
  }).pipe(Effect.scoped, Effect.provide(open(tmp.path, "seed")), Effect.runPromise)
  const legacy = await disk(tmp.path)
  delete legacy.vendorEntities[id]
  await writeDisk(tmp.path, legacy)
  const beforeAuth = await Bun.file(path.join(tmp.path, "relay-auth.json")).text()
  await Effect.gen(function* () {
    const catalog = yield* RelayCatalog.Service
    expect(yield* catalog.managed()).toEqual([])
    expect(catalog.hasManaged()).toBe(false)
    expect(catalog.visible(RelayCatalog.modelID(id, "legacy"))).toBe(false)
    let projections = 0
    catalog.apply(() => {
      projections++
    })
    expect(projections).toBe(0)
  }).pipe(Effect.scoped, Effect.provide(open(tmp.path, "quarantine")), Effect.runPromise)
  const stored = await disk(tmp.path)
  expect(stored.quarantine?.entries).toMatchObject([
    { vendorId: id, modelId: "legacy", visible: true, kinds: ["managed"] },
  ])
  expect(stored.catalogRevision).toBe(legacy.catalogRevision + 1)
  const content = await Bun.file(path.join(tmp.path, "relay-catalog.json")).text()
  await Effect.gen(function* () {
    const catalog = yield* RelayCatalog.Service
    expect(yield* catalog.managed()).toEqual([])
    yield* catalog.syncVendors()
  }).pipe(Effect.scoped, Effect.provide(open(tmp.path, "repeat")), Effect.runPromise)
  expect(await Bun.file(path.join(tmp.path, "relay-catalog.json")).text()).toBe(content)
  expect(await Bun.file(path.join(tmp.path, "relay-auth.json")).text()).toBe(beforeAuth)
})

test("R207 only unbound rows and unused bindings change, valid vendors stay intact", async () => {
  await using tmp = await tmpdir()
  const other = Relay.VendorID.make("other")
  await Effect.gen(function* () {
    const auth = yield* RelayAuth.Service
    const catalog = yield* RelayCatalog.Service
    const state = yield* seed()
    yield* auth.setVendor({
      id: other,
      name: "Other",
      baseURL: "https://other.invalid/v1",
      key: "other-key",
      revision: state.revision,
    })
    for (const vendorId of [id, other])
      yield* catalog.setVisibility({ vendorId, modelId: Model.ID.make("model"), visible: true })
  }).pipe(Effect.scoped, Effect.provide(open(tmp.path, "seed")), Effect.runPromise)
  const legacy = await disk(tmp.path)
  delete legacy.vendorEntities[id]
  legacy.vendorEntities.unused = "00000000-0000-4000-8000-000000000001"
  await writeDisk(tmp.path, legacy)
  await Effect.gen(function* () {
    const catalog = yield* RelayCatalog.Service
    expect((yield* catalog.managed()).map((item) => String(item.vendorId))).toEqual(["other"])
  }).pipe(Effect.scoped, Effect.provide(open(tmp.path, "partial")), Effect.runPromise)
  const stored = await disk(tmp.path)
  expect(stored.vendorEntities.unused).toBeUndefined()
  expect(stored.vendorEntities[other]).toBe(legacy.vendorEntities[other])
  expect(stored.quarantine?.entries).toHaveLength(1)
  expect(stored.catalogRevision).toBe(legacy.catalogRevision + 1)
  stored.vendorEntities.unused = "00000000-0000-4000-8000-000000000002"
  await writeDisk(tmp.path, stored)
  await Effect.gen(function* () {
    yield* RelayCatalog.Service
  }).pipe(Effect.scoped, Effect.provide(open(tmp.path, "metadata-only")), Effect.runPromise)
  const cleaned = await disk(tmp.path)
  expect(cleaned.vendorEntities.unused).toBeUndefined()
  expect(cleaned.catalogRevision).toBe(stored.catalogRevision + 1)
})

for (const damaged of ["version", "uuid", "empty-kind", "duplicate"])
  test(`R209 rejects damaged quarantine ${damaged} without writing`, async () => {
    await using tmp = await tmpdir()
    await Effect.gen(function* () {
      const catalog = yield* RelayCatalog.Service
      yield* seed()
      yield* catalog.setVisibility({ vendorId: id, modelId: Model.ID.make("legacy"), visible: true })
    }).pipe(Effect.scoped, Effect.provide(open(tmp.path, "seed")), Effect.runPromise)
    const stored = await disk(tmp.path)
    stored.quarantine = {
      version: damaged === "version" ? 2 : 1,
      entries: [
        {
          vendorId: id,
          modelId: "legacy",
          reason: "missing-entity-binding",
          kinds: damaged === "empty-kind" ? [] : ["managed"],
          visible: true,
          knownEntities: damaged === "uuid" ? { review: "bad-id" } : {},
        },
      ],
    }
    if (damaged === "duplicate") stored.quarantine.entries.push(stored.quarantine.entries[0]!)
    await writeDisk(tmp.path, stored)
    const content = await Bun.file(path.join(tmp.path, "relay-catalog.json")).text()
    const result = await Effect.gen(function* () {
      yield* RelayCatalog.Service
    }).pipe(Effect.scoped, Effect.provide(open(tmp.path, "damaged")), Effect.exit, Effect.runPromise)
    expect(Exit.isFailure(result)).toBe(true)
    expect(await Bun.file(path.join(tmp.path, "relay-catalog.json")).text()).toBe(content)
  })

test("R210 only explicit current model selection retires its quarantine suggestion", async () => {
  await using tmp = await tmpdir()
  await Effect.gen(function* () {
    const catalog = yield* RelayCatalog.Service
    yield* seed()
    for (const name of ["legacy", "missing"])
      yield* catalog.setVisibility({ vendorId: id, modelId: Model.ID.make(name), visible: true })
  }).pipe(Effect.scoped, Effect.provide(open(tmp.path, "seed")), Effect.runPromise)
  const legacy = await disk(tmp.path)
  delete legacy.vendorEntities[id]
  await writeDisk(tmp.path, legacy)
  await Effect.gen(function* () {
    const catalog = yield* RelayCatalog.Service
    const auth = yield* RelayAuth.Service
    const state = yield* auth.get()
    const entity = state.vendors.find((item) => item.id === id)!.entityId
    const before = yield* catalog
      .setVisibility({ vendorId: id, modelId: Model.ID.make("legacy"), visible: true, expectedEntityId: entity })
      .pipe(Effect.exit)
    expect(Exit.isFailure(before)).toBe(true)
    yield* catalog.refresh(id)
    expect(yield* catalog.managed()).toEqual([])
    expect((yield* Effect.promise(() => disk(tmp.path))).quarantine?.entries).toHaveLength(2)
    yield* catalog.setVisibility({
      vendorId: id,
      modelId: Model.ID.make("legacy"),
      visible: true,
      expectedEntityId: entity,
    })
    expect((yield* Effect.promise(() => disk(tmp.path))).quarantine?.entries.map((item) => item.modelId)).toEqual([
      "missing",
    ])
    const deleted = yield* auth.deleteVendor({ id, revision: state.revision })
    yield* auth.setVendor({
      id,
      name: "Next",
      baseURL: "https://next.invalid/v1",
      key: "next-key",
      revision: deleted.revision,
    })
    const stale = yield* catalog
      .setVisibility({ vendorId: id, modelId: Model.ID.make("legacy"), visible: true, expectedEntityId: entity })
      .pipe(Effect.exit)
    expect(Exit.isFailure(stale)).toBe(true)
  }).pipe(
    Effect.scoped,
    Effect.provide(
      open(
        tmp.path,
        "recover",
        client(() => Effect.succeed({ data: [{ id: "legacy" }] })),
      ),
    ),
    Effect.runPromise,
  )
})

for (const concurrent of ["none", "sync", "startup"] as const)
  test(`R101/R102/R205 real child refresh survives parent ${concurrent}`, async () => {
    await using tmp = await tmpdir()
    let enter!: () => void
    let release!: () => void
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    const allowed = new Promise<void>((resolve) => {
      release = resolve
    })
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch() {
        enter()
        await allowed
        return Response.json({ data: [{ id: "child-model" }] })
      },
    })
    let child: ReturnType<typeof Bun.spawn> | undefined
    try {
      await Effect.gen(function* () {
        const catalog = yield* RelayCatalog.Service
        yield* seed(`${server.url}v1`)
        yield* catalog.syncVendors()
        const output = yield* Effect.promise(async () => {
          const started = Bun.spawn(
            [process.execPath, path.join(import.meta.dir, "fixture/relay-refresh-writer.ts"), tmp.path, "rotate"],
            { stdout: "pipe", stderr: "pipe" },
          )
          child = started
          return { out: new Response(started.stdout).text(), err: new Response(started.stderr).text() }
        })
        yield* Effect.promise(() => entered).pipe(Effect.timeout("10 seconds"))
        const before = yield* Effect.promise(() => disk(tmp.path))
        expect(before.refreshRequests[id]).toBeDefined()
        const content = yield* Effect.promise(() => Bun.file(path.join(tmp.path, "relay-catalog.json")).text())
        if (concurrent === "sync") yield* catalog.synchronize()
        if (concurrent === "startup")
          yield* Effect.gen(function* () {
            const started = yield* RelayCatalog.Service
            expect(yield* started.managed()).toEqual([])
          }).pipe(Effect.scoped, Effect.provide(Layer.fresh(open(tmp.path, "starting"))))
        expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "relay-catalog.json")).text())).toBe(content)
        release()
        const code = yield* Effect.promise(() => child!.exited).pipe(Effect.timeout("10 seconds"))
        const errors = yield* Effect.promise(() => output.err)
        expect(code, errors).toBe(0)
        expect(JSON.parse(yield* Effect.promise(() => output.out))).toEqual(["child-model"])
        expect((yield* Effect.promise(() => disk(tmp.path))).refreshRequests[id]).toBeUndefined()
      }).pipe(Effect.scoped, Effect.provide(open(tmp.path, "parent")), Effect.runPromise)
    } finally {
      release()
      if (child?.exitCode === null) child.kill()
      if (child) await child.exited
      server.stop(true)
    }
  }, 30000)

test("R109 a killed refresh leaves a harmless token that the next refresh replaces", async () => {
  await using tmp = await tmpdir()
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const allowed = new Promise<void>((resolve) => {
    release = resolve
  })
  let requests = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch() {
      if (++requests === 1) {
        enter()
        await allowed
      }
      return Response.json({ data: [{ id: "after-exit" }] })
    },
  })
  let child: ReturnType<typeof Bun.spawn> | undefined
  try {
    await Effect.gen(function* () {
      const catalog = yield* RelayCatalog.Service
      yield* seed(`${server.url}v1`)
      yield* catalog.syncVendors()
      yield* Effect.promise(async () => {
        child = Bun.spawn(
          [process.execPath, path.join(import.meta.dir, "fixture/relay-refresh-writer.ts"), tmp.path, "hold"],
          { stdout: "ignore", stderr: "pipe" },
        )
      })
      yield* Effect.promise(() => entered).pipe(Effect.timeout("10 seconds"))
      const old = (yield* Effect.promise(() => disk(tmp.path))).refreshRequests[id]
      expect(old).toBeDefined()
      child!.kill("SIGKILL")
      yield* Effect.promise(() => child!.exited).pipe(Effect.timeout("10 seconds"))
      expect((yield* Effect.promise(() => disk(tmp.path))).refreshRequests[id]).toBe(old)
      yield* catalog.synchronize()
      expect((yield* Effect.promise(() => disk(tmp.path))).refreshRequests[id]).toBe(old)
      const models = yield* catalog.refresh(id)
      expect(models.map((item) => String(item.modelId))).toEqual(["after-exit"])
      expect((yield* Effect.promise(() => disk(tmp.path))).refreshRequests[id]).toBeUndefined()
    }).pipe(Effect.scoped, Effect.provide(open(tmp.path, "parent")), Effect.runPromise)
  } finally {
    release()
    if (child?.exitCode === null) child.kill()
    if (child) await child.exited
    server.stop(true)
  }
}, 30000)

test("R107 stalled response bodies are covered by the request timeout", async () => {
  await using tmp = await tmpdir()
  let enter!: () => void
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch() {
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"data":['))
            enter()
          },
        }),
        { headers: { "Content-Type": "application/json" } },
      )
    },
  })
  try {
    await Effect.gen(function* () {
      const catalog = yield* RelayCatalog.Service
      yield* seed(`${server.url}v1`)
      const running = yield* catalog.refresh(id).pipe(Effect.forkChild)
      yield* Effect.promise(() => entered).pipe(Effect.timeout("5 seconds"))
      const result = yield* Fiber.await(running).pipe(Effect.timeout("15 seconds"))
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) expect(failures(result.cause).map((info) => info.code)).toContain("UPSTREAM_TIMEOUT")
      expect((yield* Effect.promise(() => disk(tmp.path))).refreshRequests[id]).toBeUndefined()
    }).pipe(Effect.scoped, Effect.provide(open(tmp.path, "body-timeout")), Effect.runPromise)
  } finally {
    server.stop(true)
  }
}, 25000)

for (const phase of ["prepare", "write"] as const)
  test(`R209 quarantine ${phase} failure preserves the complete original file`, async () => {
    await using tmp = await tmpdir()
    await Effect.gen(function* () {
      const catalog = yield* RelayCatalog.Service
      yield* seed()
      yield* catalog.setVisibility({ vendorId: id, modelId: Model.ID.make("legacy"), visible: true })
    }).pipe(Effect.scoped, Effect.provide(open(tmp.path, "seed")), Effect.runPromise)
    const legacy = await disk(tmp.path)
    delete legacy.vendorEntities[id]
    await writeDisk(tmp.path, legacy)
    const content = await Bun.file(path.join(tmp.path, "relay-catalog.json")).text()
    const result = await Effect.gen(function* () {
      yield* RelayCatalog.withCommitHook((current) =>
        current === phase ? Effect.fail(new Error("quarantine commit failed")) : Effect.void,
      )
      return yield* Effect.gen(function* () {
        yield* RelayCatalog.Service
      }).pipe(Effect.scoped, Effect.provide(Layer.fresh(open(tmp.path, "failing"))), Effect.exit)
    }).pipe(Effect.scoped, Effect.runPromise)
    expect(Exit.isFailure(result)).toBe(true)
    expect(await Bun.file(path.join(tmp.path, "relay-catalog.json")).text()).toBe(content)
    expect(await Array.fromAsync(new Bun.Glob("relay-catalog.json.*.tmp").scan({ cwd: tmp.path }))).toEqual([])
    await Effect.gen(function* () {
      const catalog = yield* RelayCatalog.Service
      expect(yield* catalog.managed()).toEqual([])
    }).pipe(Effect.scoped, Effect.provide(open(tmp.path, "recover")), Effect.runPromise)
    expect((await disk(tmp.path)).quarantine?.entries[0]?.visible).toBe(true)
  })

test("R206 bootstrap defers notification and a failed delivery is retryable without rewriting", async () => {
  await using tmp = await tmpdir()
  await Effect.gen(function* () {
    const auth = yield* RelayAuth.Service
    const catalog = yield* RelayCatalog.Service
    const state = yield* seed()
    yield* catalog.setVisibility({ vendorId: id, modelId: Model.ID.make("retired"), visible: true })
    const removed = yield* auth.deleteVendor({ id, revision: state.revision })
    yield* auth.setVendor({
      id,
      name: "Replacement",
      baseURL: "https://next.invalid/v1",
      key: "fake-new",
      revision: removed.revision,
    })
  }).pipe(Effect.scoped, Effect.provide(open(tmp.path, "seed")), Effect.runPromise)
  let failing = true
  let attempts = 0
  const events = Layer.effect(
    EventV2.Service,
    Effect.gen(function* () {
      const original = yield* EventV2.Service
      return EventV2.Service.of({
        ...original,
        publish: (definition, data, options) => {
          attempts++
          return failing ? Effect.die(new Error("notifier unavailable")) : original.publish(definition, data, options)
        },
      })
    }),
  ).pipe(Layer.provide(AppNodeBuilder.build(EventV2.node)))
  await Effect.gen(function* () {
    const catalog = yield* RelayCatalog.Service
    expect(attempts).toBe(0)
    expect(yield* catalog.managed()).toEqual([])
    const content = yield* Effect.promise(() => Bun.file(path.join(tmp.path, "relay-catalog.json")).text())
    expect((yield* catalog.synchronize()).notice.status).toBe("pending")
    expect(attempts).toBe(1)
    failing = false
    expect((yield* catalog.synchronize({ retryNotice: true })).notice.status).toBe("idle")
    expect(attempts).toBe(2)
    expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "relay-catalog.json")).text())).toBe(content)
  }).pipe(Effect.scoped, Effect.provide(open(tmp.path, "notices", undefined, { events })), Effect.runPromise)
})

test("R208 another real writer preserves quarantined preferences while editing its own vendor", async () => {
  await using tmp = await tmpdir()
  await Effect.gen(function* () {
    const catalog = yield* RelayCatalog.Service
    yield* seed()
    yield* catalog.setVisibility({ vendorId: id, modelId: Model.ID.make("legacy"), visible: true })
  }).pipe(Effect.scoped, Effect.provide(open(tmp.path, "seed")), Effect.runPromise)
  const legacy = await disk(tmp.path)
  delete legacy.vendorEntities[id]
  await writeDisk(tmp.path, legacy)
  await Effect.gen(function* () {
    yield* RelayCatalog.Service
  }).pipe(Effect.scoped, Effect.provide(open(tmp.path, "isolate")), Effect.runPromise)
  const isolated = await disk(tmp.path)
  const child = Bun.spawn(
    [process.execPath, path.join(import.meta.dir, "fixture/relay-refresh-writer.ts"), tmp.path, "other-vendor"],
    { stdout: "pipe", stderr: "pipe" },
  )
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(code, err).toBe(0)
  expect(JSON.parse(out)).toEqual(["other-model"])
  const after = await disk(tmp.path)
  expect(after.quarantine).toEqual(isolated.quarantine)
  expect(after.managed.map((item) => item.vendorId)).toEqual(["child-other"])
})

for (const phase of ["prepare", "write"] as const)
  test(`R209 cancellation at quarantine ${phase} waits for one complete atomic commit`, async () => {
    await using tmp = await tmpdir()
    await Effect.gen(function* () {
      const catalog = yield* RelayCatalog.Service
      yield* seed()
      yield* catalog.setVisibility({ vendorId: id, modelId: Model.ID.make("legacy"), visible: true })
    }).pipe(Effect.scoped, Effect.provide(open(tmp.path, "seed")), Effect.runPromise)
    const legacy = await disk(tmp.path)
    delete legacy.vendorEntities[id]
    await writeDisk(tmp.path, legacy)
    await Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      yield* RelayCatalog.withCommitHook((current) =>
        current === phase
          ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
          : Effect.void,
      )
      const running = yield* Effect.gen(function* () {
        yield* RelayCatalog.Service
      }).pipe(Effect.scoped, Effect.provide(Layer.fresh(open(tmp.path, "cancel"))), Effect.forkChild)
      yield* Effect.gen(function* () {
        yield* Deferred.await(entered).pipe(Effect.timeout("5 seconds"))
        const interrupted = yield* Fiber.interrupt(running).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        expect(interrupted.pollUnsafe()).toBeUndefined()
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(interrupted).pipe(Effect.timeout("5 seconds"))
        const result = yield* Fiber.await(running)
        expect(Exit.isFailure(result) && Cause.hasInterrupts(result.cause)).toBe(true)
      }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)))
    }).pipe(Effect.scoped, Effect.runPromise)
    const stored = await disk(tmp.path)
    expect(stored.managed).toEqual([])
    expect(stored.quarantine?.entries[0]?.visible).toBe(true)
    expect(stored.catalogRevision).toBe(legacy.catalogRevision + 1)
    expect(await Array.fromAsync(new Bun.Glob("relay-catalog.json.*.tmp").scan({ cwd: tmp.path }))).toEqual([])
    await Effect.gen(function* () {
      yield* RelayCatalog.Service
    }).pipe(Effect.scoped, Effect.provide(open(tmp.path, "recover")), Effect.runPromise)
    expect(await disk(tmp.path)).toEqual(stored)
  })

for (const phase of ["write", "renamed"] as const)
  test(`R209 real child termination at quarantine ${phase} preserves a recoverable catalog`, async () => {
    await using tmp = await tmpdir()
    await Effect.gen(function* () {
      const catalog = yield* RelayCatalog.Service
      yield* seed()
      yield* catalog.setVisibility({ vendorId: id, modelId: Model.ID.make("legacy"), visible: true })
    }).pipe(Effect.scoped, Effect.provide(open(tmp.path, "seed")), Effect.runPromise)
    const legacy = await disk(tmp.path)
    delete legacy.vendorEntities[id]
    await writeDisk(tmp.path, legacy)
    const content = await Bun.file(path.join(tmp.path, "relay-catalog.json")).text()
    const child = Bun.spawn(
      [
        process.execPath,
        path.join(import.meta.dir, "fixture/relay-refresh-writer.ts"),
        tmp.path,
        `quarantine-crash-${phase}`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    )
    const reader = child.stdout.getReader()
    const errors = new Response(child.stderr).text()
    try {
      const signal = await Effect.promise(() => reader.read()).pipe(Effect.timeout("10 seconds"), Effect.runPromise)
      expect(new TextDecoder().decode(signal.value)).toContain("QUARANTINE-READY")
      child.kill("SIGKILL")
      await child.exited
      if (phase === "write") expect(await Bun.file(path.join(tmp.path, "relay-catalog.json")).text()).toBe(content)
      if (phase === "renamed") expect((await disk(tmp.path)).quarantine?.entries[0]?.visible).toBe(true)
      await Effect.gen(function* () {
        const catalog = yield* RelayCatalog.Service
        expect(yield* catalog.managed()).toEqual([])
      }).pipe(Effect.scoped, Effect.provide(open(tmp.path, "recover")), Effect.runPromise)
      const recovered = await disk(tmp.path)
      expect(recovered.quarantine?.entries).toHaveLength(1)
      expect(recovered.quarantine?.entries[0]?.visible).toBe(true)
      expect(recovered.catalogRevision).toBe(legacy.catalogRevision + 1)
      expect(await errors).not.toContain("fake-original")
    } finally {
      reader.releaseLock()
      if (child.exitCode === null) child.kill("SIGKILL")
      await child.exited
    }
  }, 25000)

for (const binding of ["missing", "retired"] as const)
  test(`R207 managed rows check every possible historical source: ${binding}`, async () => {
    await using tmp = await tmpdir()
    const other = Relay.VendorID.make("other-source")
    const third = Relay.VendorID.make("third-source")
    await Effect.gen(function* () {
      const auth = yield* RelayAuth.Service
      const catalog = yield* RelayCatalog.Service
      yield* seed()
      for (const vendorId of [other, third]) {
        yield* auth.setVendor({
          id: vendorId,
          name: vendorId,
          baseURL: "https://source.invalid/v1",
          key: "fake-source",
          revision: (yield* auth.get()).revision,
        })
        yield* catalog.setVisibility({ vendorId, modelId: Model.ID.make("keep"), visible: true })
      }
      yield* catalog.refresh(id)
      yield* catalog.setVisibility({ vendorId: id, modelId: Model.ID.make("legacy"), visible: true })
    }).pipe(
      Effect.scoped,
      Effect.provide(
        open(
          tmp.path,
          "seed",
          client(() => Effect.succeed({ data: [{ id: "legacy" }] })),
        ),
      ),
      Effect.runPromise,
    )
    const legacy = await disk(tmp.path)
    legacy.candidates = [other, third].map((sourceVendorId) => ({ ...legacy.candidates[0]!, sourceVendorId }))
    if (binding === "missing") delete legacy.vendorEntities[third]
    if (binding === "retired") legacy.vendorEntities[third] = "00000000-0000-4000-8000-000000000001"
    await writeDisk(tmp.path, legacy)
    await Effect.gen(function* () {
      const catalog = yield* RelayCatalog.Service
      expect((yield* catalog.managed()).some((item) => item.vendorId === id)).toBe(false)
      expect((yield* catalog.managed()).some((item) => item.vendorId === other)).toBe(true)
    }).pipe(Effect.scoped, Effect.provide(open(tmp.path, "restart")), Effect.runPromise)
    const stored = await disk(tmp.path)
    if (binding === "missing") {
      const suggestion = stored.quarantine?.entries.find(
        (item) => item.vendorId === id && item.kinds.includes("managed"),
      )
      expect(suggestion?.sourceVendorId).toBeUndefined()
      expect(suggestion?.visible).toBe(true)
      expect(suggestion?.knownEntities[other]).toBe(legacy.vendorEntities[other])
    } else expect(stored.quarantine?.entries.some((item) => item.vendorId === id)).toBe(false)
  })
