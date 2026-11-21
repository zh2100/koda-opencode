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

for (const protect of [true, false])
  test(`RV-05 identical delete retry, expectedEntityId=${protect}`, async () => {
    await using tmp = await tmpdir()
    await Effect.gen(function* () {
      const auth = yield* RelayAuth.Service
      const created = yield* auth.setVendor({
        id,
        name: "Delete retry",
        baseURL: "https://retry.invalid/v1",
        key: "fake-retry",
        revision: 0,
      })
      const input = {
        id,
        revision: created.revision,
        operationId: `delete-retry-${protect}`,
        ...(protect ? { expectedEntityId: created.vendors[0]!.entityId } : {}),
      }
      const deleted = yield* auth.deleteVendor(input)
      const retried = yield* auth.deleteVendor(input).pipe(Effect.exit)
      const latest = yield* auth.get()
      console.info("RV-05", {
        protect,
        exit: retried._tag,
        deletedRevision: deleted.revision,
        currentRevision: latest.revision,
        vendorAbsent: !latest.vendors.some((vendor) => vendor.id === id),
        codes: Exit.isFailure(retried)
          ? retried.cause.reasons.flatMap((reason) =>
              reason._tag === "Fail" && reason.error instanceof RelayAuth.AuthError ? [reason.error.info.code] : [],
            )
          : [],
      })
      expect(latest.revision).toBe(deleted.revision)
      expect(Exit.isSuccess(retried)).toBe(true)
    }).pipe(Effect.scoped, Effect.provide(open(tmp.path, "retry")), Effect.runPromise)
  })

test("RV-05 exact confirmation cannot delete a same-ID successor or accept a changed command", async () => {
  await using tmp = await tmpdir()
  await Effect.gen(function* () {
    const auth = yield* RelayAuth.Service
    const created = yield* auth.setVendor({
      id,
      name: "Original",
      baseURL: "https://original.invalid/v1",
      key: "fake-original",
      revision: 0,
    })
    const input = {
      id,
      expectedEntityId: created.vendors[0]!.entityId!,
      revision: created.revision,
      operationId: "exact-delete",
    }
    const deleted = yield* auth.deleteVendor(input)
    const successor = yield* auth.setVendor({
      id,
      name: "Successor",
      baseURL: "https://successor.invalid/v1",
      key: "fake-successor",
      revision: deleted.revision,
    })
    const acknowledged = yield* auth.deleteVendor(input)
    expect(acknowledged.revision).toBe(successor.revision)
    expect(acknowledged.vendors[0]!.entityId).toBe(successor.vendors[0]!.entityId)
    expect((yield* auth.resolve(id)).key).toBe("fake-successor")
    for (const changed of [
      { ...input, id: Relay.VendorID.make("different") },
      { ...input, expectedEntityId: successor.vendors[0]!.entityId },
      { ...input, revision: successor.revision },
      { ...input, expectedEntityId: undefined },
    ])
      expect(Exit.isFailure(yield* auth.deleteVendor(changed).pipe(Effect.exit))).toBe(true)
    expect(
      Exit.isFailure(
        yield* auth
          .clearVendorKey({ ...input, expectedEntityId: successor.vendors[0]!.entityId, revision: successor.revision })
          .pipe(Effect.exit),
      ),
    ).toBe(true)
    expect(
      Exit.isFailure(
        yield* auth
          .setVendor({
            ...input,
            expectedEntityId: successor.vendors[0]!.entityId,
            revision: successor.revision,
            name: "Collision",
          })
          .pipe(Effect.exit),
      ),
    ).toBe(true)
    expect((yield* auth.get()).revision).toBe(successor.revision)
    expect((yield* auth.resolve(id)).key).toBe("fake-successor")
  }).pipe(Effect.scoped, Effect.provide(open(tmp.path, "successor")), Effect.runPromise)
})

test("RV-05 a failed first delete does not create a confirmation", async () => {
  await using tmp = await tmpdir()
  await Effect.gen(function* () {
    const auth = yield* RelayAuth.Service
    const saved = yield* auth.setVendor({
      id,
      name: "Retry",
      baseURL: "https://retry.invalid/v1",
      key: "fake-retry",
      revision: 0,
    })
    const input = { id, expectedEntityId: saved.vendors[0]!.entityId, revision: 0, operationId: "failed-delete" }
    expect(Exit.isFailure(yield* auth.deleteVendor(input).pipe(Effect.exit))).toBe(true)
    expect((yield* auth.get()).revision).toBe(saved.revision)
    const deleted = yield* auth.deleteVendor({ ...input, revision: saved.revision })
    expect(deleted.vendors).toEqual([])
    expect(deleted.revision).toBe(saved.revision + 1)
  }).pipe(Effect.scoped, Effect.provide(open(tmp.path, "failed")), Effect.runPromise)
})

test("RV-05 protected delete retry finishes its pending credential cleanup only", async () => {
  await using tmp = await tmpdir()
  const values = new Map<string, string>()
  let blocked = true
  const global = Global.layerWith({ data: tmp.path })
  const secrets = RelaySecretStore.makeLayer({
    get: async ({ name }) => values.get(name) ?? null,
    set: async ({ name, value }) => {
      values.set(name, value)
    },
    delete: async ({ name }) => {
      if (blocked) throw new Error("controlled system failure")
      values.delete(name)
    },
  }).pipe(Layer.provide(AppNodeBuilder.build(FSUtil.node)), Layer.provide(global))
  const layer = AppNodeBuilder.build(RelayAuth.node, [
    [Global.node, global],
    [RelaySecretStore.node, secrets],
  ])
  await Effect.gen(function* () {
    const auth = yield* RelayAuth.Service
    const saved = yield* auth.setVendor({
      id,
      name: "Cleanup",
      baseURL: "https://cleanup.invalid/v1",
      key: "fake-cleanup",
      revision: 0,
    })
    const input = {
      id,
      expectedEntityId: saved.vendors[0]!.entityId,
      revision: saved.revision,
      operationId: "cleanup-delete",
    }
    const deleted = yield* auth.deleteVendor(input)
    expect(deleted.cleanupPending).toBe(true)
    blocked = false
    const retried = yield* auth.deleteVendor(input)
    expect(retried.cleanupPending).toBe(false)
    expect(retried.revision).toBe(deleted.revision)
    expect(values.size).toBe(0)
  }).pipe(Effect.scoped, Effect.provide(layer), Effect.runPromise)
})

test("RV-05 cancellation after rename retains exact-delete confirmation", async () => {
  await using tmp = await tmpdir()
  const renamed = Deferred.makeUnsafe<void>()
  const release = Deferred.makeUnsafe<void>()
  let armed = false
  const files = Layer.effect(
    FSUtil.Service,
    Effect.gen(function* () {
      const original = yield* FSUtil.Service
      return FSUtil.Service.of({
        ...original,
        rename: (from, to) =>
          original
            .rename(from, to)
            .pipe(
              Effect.andThen(() =>
                armed && to === path.join(tmp.path, "relay-auth.json")
                  ? Deferred.succeed(renamed, undefined).pipe(Effect.andThen(Deferred.await(release)))
                  : Effect.void,
              ),
            ),
      })
    }),
  ).pipe(Layer.provide(AppNodeBuilder.build(FSUtil.node)))
  await Effect.gen(function* () {
    const auth = yield* RelayAuth.Service
    const saved = yield* auth.setVendor({
      id,
      name: "Cancel",
      baseURL: "https://cancel.invalid/v1",
      key: "fake-cancel",
      revision: 0,
    })
    const input = {
      id,
      expectedEntityId: saved.vendors[0]!.entityId,
      revision: saved.revision,
      operationId: "cancel-delete",
    }
    armed = true
    const running = yield* auth.deleteVendor(input).pipe(Effect.forkChild)
    yield* Deferred.await(renamed).pipe(Effect.timeout("3 seconds"))
    const cancelling = yield* Fiber.interrupt(running).pipe(Effect.forkChild)
    yield* Effect.yieldNow
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(cancelling)
    armed = false
    expect(Exit.isFailure(yield* Fiber.await(running))).toBe(true)
    const confirmed = yield* auth.deleteVendor(input)
    expect(confirmed.vendors).toEqual([])
    expect(confirmed.revision).toBe(saved.revision + 1)
  }).pipe(
    Effect.scoped,
    Effect.provide(open(tmp.path, "cancel", undefined, { files })),
    Effect.ensuring(Deferred.succeed(release, undefined)),
    Effect.runPromise,
  )
})

for (const phase of ["cancelled", "cleanup-failed"] as const)
  for (const target of [id, Relay.VendorID.make("another-vendor")])
    test(`RV-05-R1 ${phase} delete rejects createOnly reuse for ${target} before writes`, async () => {
      await using tmp = await tmpdir()
      const renamed = Deferred.makeUnsafe<void>()
      const release = Deferred.makeUnsafe<void>()
      const values = new Map<string, string>()
      let armed = false
      let blocked = phase === "cleanup-failed"
      const global = Global.layerWith({ data: tmp.path, state: path.join(tmp.path, "state") })
      const files = Layer.effect(
        FSUtil.Service,
        Effect.gen(function* () {
          const original = yield* FSUtil.Service
          return FSUtil.Service.of({
            ...original,
            rename: (from, to) =>
              original
                .rename(from, to)
                .pipe(
                  Effect.andThen(() =>
                    armed && to === path.join(tmp.path, "relay-auth.json")
                      ? Deferred.succeed(renamed, undefined).pipe(Effect.andThen(Deferred.await(release)))
                      : Effect.void,
                  ),
                ),
          })
        }),
      ).pipe(Layer.provide(AppNodeBuilder.build(FSUtil.node)))
      const secrets = RelaySecretStore.makeLayer({
        get: async ({ name }) => values.get(name) ?? null,
        set: async ({ name, value }) => {
          values.set(name, value)
        },
        delete: async ({ name }) => {
          if (blocked) throw new Error("controlled cleanup failure")
          values.delete(name)
        },
      }).pipe(Layer.provide(files), Layer.provide(global))
      const layer = AppNodeBuilder.build(RelayAuth.node, [
        [Global.node, global],
        [FSUtil.node, files],
        [RelaySecretStore.node, secrets],
      ])
      await Effect.gen(function* () {
        const auth = yield* RelayAuth.Service
        const saved = yield* auth.setVendor({
          id,
          name: "Original",
          baseURL: "https://original.invalid/v1",
          key: "fake-original",
          revision: 0,
        })
        const input = {
          id,
          expectedEntityId: saved.vendors[0]!.entityId,
          revision: saved.revision,
          operationId: `delete-${phase}`,
        }
        if (phase === "cancelled") {
          armed = true
          const running = yield* auth.deleteVendor(input).pipe(Effect.forkChild)
          yield* Deferred.await(renamed).pipe(Effect.timeout("3 seconds"))
          const cancelling = yield* Fiber.interrupt(running).pipe(Effect.forkChild)
          yield* Effect.yieldNow
          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(cancelling)
          armed = false
          expect(Exit.isFailure(yield* Fiber.await(running))).toBe(true)
        }
        if (phase === "cleanup-failed") expect((yield* auth.deleteVendor(input)).cleanupPending).toBe(true)

        const before = yield* auth.get()
        expect(before.vendors).toEqual([])
        expect(before.revision).toBe(saved.revision + 1)
        expect(values.size).toBe(1)
        const config = yield* Effect.promise(() => Bun.file(path.join(tmp.path, "relay-auth.json")).text())
        expect(config).toContain('"pendingCleanup"')
        const credentials = [...values.entries()]
        expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "relay-auth-receipt-key.json")).exists())).toBe(
          false,
        )
        const command = {
          id: target,
          createOnly: true,
          operationId: input.operationId,
          revision: before.revision,
          name: "Successor",
          baseURL: "https://successor.invalid/v1",
          key: "fake-successor",
        }
        const collision = yield* auth.setVendor(command).pipe(Effect.exit)
        expect(Exit.isFailure(collision)).toBe(true)
        if (Exit.isFailure(collision))
          expect(
            collision.cause.reasons.some(
              (reason) =>
                reason._tag === "Fail" &&
                reason.error instanceof RelayAuth.AuthError &&
                reason.error.info.code === "REQUEST_CONFLICT",
            ),
          ).toBe(true)
        expect(yield* auth.get()).toEqual(before)
        expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "relay-auth.json")).text())).toBe(config)
        expect([...values.entries()]).toEqual(credentials)
        expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "relay-auth-receipt-key.json")).exists())).toBe(
          false,
        )

        blocked = false
        const confirmed = yield* auth.deleteVendor(input)
        expect(confirmed.cleanupPending).toBe(false)
        expect(confirmed.revision).toBe(before.revision)
        expect(confirmed.vendors).toEqual([])
        expect(values.size).toBe(0)
        expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "relay-auth.json")).text())).not.toContain(
          '"pendingCleanup"',
        )

        const fresh = { ...command, operationId: `fresh-${phase}-${target}`, revision: confirmed.revision }
        const created = yield* auth.setVendor(fresh)
        expect(created.revision).toBe(confirmed.revision + 1)
        expect(created.operationReceipt!.entityId).not.toBe(input.expectedEntityId)
        const committed = yield* Effect.promise(() => Bun.file(path.join(tmp.path, "relay-auth.json")).text())
        const retried = yield* auth.setVendor(fresh)
        expect(retried.operationReceipt).toEqual(created.operationReceipt)
        expect(retried.revision).toBe(created.revision)
        expect((yield* auth.deleteVendor(input)).vendors).toEqual(created.vendors)
        expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "relay-auth.json")).text())).toBe(committed)
        expect((yield* auth.resolve(target)).key).toBe("fake-successor")
        expect(values.size).toBe(1)
      }).pipe(
        Effect.ensuring(Deferred.succeed(release, undefined)),
        Effect.scoped,
        Effect.provide(layer),
        Effect.runPromise,
      )
    })
