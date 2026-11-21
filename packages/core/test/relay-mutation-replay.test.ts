import { expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Layer, PlatformError } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { RelayAuth } from "@opencode-ai/core/relay-auth"
import { RelaySecretStore } from "@opencode-ai/core/relay-secret-store"
import { Relay } from "@opencode-ai/schema/relay"
import { tmpdir } from "./fixture/tmpdir"
import path from "node:path"

const id = Relay.VendorID.make("baseline")
const seed = { id, name: "Before", baseURL: "https://baseline.invalid/v1", key: "fake-before", revision: 0 }
const denied = () =>
  new PlatformError.PlatformError(
    new PlatformError.SystemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "readJson",
    }),
  )
const files = AppNodeBuilder.build(FSUtil.node)
const open = <A, E>(
  root: string,
  body: (auth: RelayAuth.Interface) => Effect.Effect<A, E>,
  options?: {
    limit?: number
    files?: Layer.Layer<FSUtil.Service>
    secrets?: Layer.Layer<RelaySecretStore.Service>
  },
) => {
  const global = Global.layerWith({ data: root, state: path.join(root, "state") })
  const secrets =
    options?.secrets ?? RelaySecretStore.makeLayer(undefined).pipe(Layer.provide(files), Layer.provide(global))
  return Effect.scoped(
    Effect.gen(function* () {
      return yield* body(yield* RelayAuth.Service)
    }),
  ).pipe(
    Effect.provide(
      AppNodeBuilder.build(RelayAuth.node, [
        [Global.node, global],
        [FSUtil.node, options?.files ?? files],
        [RelaySecretStore.node, secrets],
      ]).pipe(Layer.provide(Layer.succeed(RelayAuth.ReplayLimit, options?.limit ?? 1024))),
    ),
    Effect.runPromise,
  )
}
const bytes = (root: string) => Bun.file(path.join(root, "relay-auth.json")).text()

test("O24/O27 ordinary, empty and clear commits advance the vendor exactly once; replay reads latest state", async () => {
  await using tmp = await tmpdir()
  await open(tmp.path, (auth) =>
    Effect.gen(function* () {
      const initial = yield* auth.setVendor(seed)
      const vendor = initial.vendors[0]!
      const command = {
        id,
        expectedEntityId: vendor.entityId,
        key: "fake-next",
        revision: initial.revision,
        operationId: "step",
      }
      const saved = yield* auth.setVendor(command)
      expect(saved.revision).toBe(initial.revision + 1)
      expect(saved.vendors[0]!.revision).toBe(vendor.revision + 1)
      const empty = yield* auth.setVendor({
        id,
        expectedEntityId: vendor.entityId,
        revision: saved.revision,
        operationId: "empty",
      })
      expect(empty.vendors[0]!.revision).toBe(vendor.revision + 2)
      const clear = { id, expectedEntityId: vendor.entityId, revision: empty.revision, operationId: "clear" }
      const cleared = yield* auth.clearVendorKey(clear)
      expect(cleared.vendors[0]!.revision).toBe(vendor.revision + 3)
      const restored = yield* auth.setVendor({
        id,
        key: "fake-restored",
        revision: cleared.revision,
        operationId: "restore",
      })
      const before = yield* Effect.promise(() => bytes(tmp.path))
      const replay = yield* auth.clearVendorKey(clear)
      expect(replay.revision).toBe(restored.revision)
      expect(replay.vendors[0]!.hasKey).toBe(true)
      expect(yield* Effect.promise(() => bytes(tmp.path))).toBe(before)
    }),
  )
})

test("O29 identical DTO succeeds; kind, vendor, entity, revision, optional fields and payload collisions never write", async () => {
  await using tmp = await tmpdir()
  await open(tmp.path, (auth) =>
    Effect.gen(function* () {
      const initial = yield* auth.setVendor(seed)
      const command = {
        id,
        expectedEntityId: initial.vendors[0]!.entityId,
        key: "fake-next",
        revision: initial.revision,
        operationId: "exact",
      }
      const saved = yield* auth.setVendor(command)
      const before = yield* Effect.promise(() => bytes(tmp.path))
      expect((yield* auth.setVendor(command)).revision).toBe(saved.revision)
      for (const patch of [
        { key: "fake-other" },
        { revision: saved.revision },
        { id: Relay.VendorID.make("other") },
        { expectedEntityId: undefined },
        { expectedEntityId: "00000000-0000-0000-0000-000000000000" },
        { name: "Before" },
        { baseURL: seed.baseURL },
        { createOnly: false },
      ]) {
        expect((yield* auth.setVendor({ ...command, ...patch }).pipe(Effect.flip)).info.code).toBe("REQUEST_CONFLICT")
        expect(yield* Effect.promise(() => bytes(tmp.path))).toBe(before)
      }
      expect((yield* auth.clearVendorKey(command).pipe(Effect.flip)).info.code).toBe("REQUEST_CONFLICT")
      expect((yield* auth.deleteVendor({ ...command, expectedEntityId: undefined }).pipe(Effect.flip)).info.code).toBe(
        "REQUEST_CONFLICT",
      )
      expect((yield* auth.setVendor({ ...command, createOnly: true }).pipe(Effect.flip)).info.code).toBe(
        "REQUEST_CONFLICT",
      )
      expect((yield* auth.resolve(id)).key).toBe(command.key)
      expect(yield* Effect.promise(() => bytes(tmp.path))).toBe(before)
    }),
  )
})

test("O26/O28 actual replacement followed by cleanup read failure retains exact committed evidence", async () => {
  await using tmp = await tmpdir()
  let phase: "ready" | "arm" | "committed" = "ready"
  const wrapped = Layer.effect(
    FSUtil.Service,
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      return FSUtil.Service.of({
        ...fs,
        rename: (from, to) =>
          fs.rename(from, to).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                if (phase === "arm" && path.resolve(to) === path.join(tmp.path, "relay-auth.json")) phase = "committed"
              }),
            ),
          ),
        readJson: (file) =>
          phase === "committed" && path.resolve(file) === path.join(tmp.path, "relay-auth.json")
            ? Effect.fail(denied())
            : fs.readJson(file),
      })
    }),
  ).pipe(Layer.provide(files))
  await open(
    tmp.path,
    (auth) =>
      Effect.gen(function* () {
        const initial = yield* auth.setVendor(seed)
        const command = {
          id,
          expectedEntityId: initial.vendors[0]!.entityId,
          name: "Committed",
          revision: initial.revision,
          operationId: "post-publish",
        }
        phase = "arm"
        expect((yield* auth.setVendor(command).pipe(Effect.flip)).info.code).toBe("SECRET_STORE_UNAVAILABLE")
        expect(String(phase)).toBe("committed")
        const disk = JSON.parse(yield* Effect.promise(() => bytes(tmp.path)))
        expect(disk.revision).toBe(initial.revision + 1)
        expect(disk.vendors[id].revision).toBe(initial.vendors[0]!.revision + 1)
        phase = "ready"
        const next = yield* auth.setVendor({ id, name: "Later", revision: disk.revision })
        const replay = yield* auth.setVendor(command)
        expect(replay.revision).toBe(next.revision)
        expect(replay.vendors[0]!.name).toBe("Later")
        expect((yield* auth.get()).revision).toBe(next.revision)
      }),
    { files: wrapped },
  )
})

test("O26 failed actual replacement creates no commit evidence and permits the original exact retry", async () => {
  await using tmp = await tmpdir()
  let blocked = false
  const wrapped = Layer.effect(
    FSUtil.Service,
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      return FSUtil.Service.of({
        ...fs,
        rename: (from, to) =>
          blocked && path.resolve(to) === path.join(tmp.path, "relay-auth.json")
            ? Effect.fail(denied())
            : fs.rename(from, to),
      })
    }),
  ).pipe(Layer.provide(files))
  await open(
    tmp.path,
    (auth) =>
      Effect.gen(function* () {
        const initial = yield* auth.setVendor(seed)
        const command = {
          id,
          expectedEntityId: initial.vendors[0]!.entityId,
          name: "After",
          revision: initial.revision,
          operationId: "no-publish",
        }
        const before = yield* Effect.promise(() => bytes(tmp.path))
        blocked = true
        expect((yield* auth.setVendor(command).pipe(Effect.flip)).info.code).toBe("SECRET_STORE_UNAVAILABLE")
        expect(yield* Effect.promise(() => bytes(tmp.path))).toBe(before)
        blocked = false
        expect((yield* auth.setVendor(command)).revision).toBe(initial.revision + 1)
      }),
    { files: wrapped },
  )
})

test("O29 restart cannot use a pending cleanup ID as evidence for a different mutation", async () => {
  await using tmp = await tmpdir()
  const values = new Map<string, string>()
  let blocked = true
  const secrets = Layer.succeed(
    RelaySecretStore.Service,
    RelaySecretStore.Service.of({
      get: (ref) => Effect.sync(() => values.get(ref)),
      put: (ref, value) => Effect.sync(() => void values.set(ref, value)),
      remove: (ref) =>
        blocked ? Effect.fail(new RelaySecretStore.UnavailableError()) : Effect.sync(() => void values.delete(ref)),
    }),
  )
  const command = await open(
    tmp.path,
    (auth) =>
      Effect.gen(function* () {
        const initial = yield* auth.setVendor(seed)
        const command = {
          id,
          expectedEntityId: initial.vendors[0]!.entityId,
          key: "fake-next",
          revision: initial.revision,
          operationId: "restart",
        }
        expect((yield* auth.setVendor(command)).cleanupPending).toBe(true)
        return command
      }),
    { secrets },
  )
  await open(
    tmp.path,
    (auth) =>
      Effect.gen(function* () {
        const before = yield* Effect.promise(() => bytes(tmp.path))
        expect((yield* auth.setVendor(command).pipe(Effect.flip)).info.code).toBe("REQUEST_CONFLICT")
        expect(yield* Effect.promise(() => bytes(tmp.path))).toBe(before)
        blocked = false
      }),
    { secrets },
  )
  await open(
    tmp.path,
    (auth) =>
      Effect.gen(function* () {
        // After initialization finishes cleanup, only the original revision condition remains.
        expect((yield* auth.setVendor(command).pipe(Effect.flip)).info.code).toBe("REVISION_CONFLICT")
        expect((yield* auth.resolve(id)).key).toBe(command.key)
      }),
    { secrets },
  )
  expect([...values.values()]).toEqual([command.key])
})

test("O29 bounded mutation eviction also removes the result; durable creates survive eviction and deletion", async () => {
  expect(Effect.runSync(RelayAuth.ReplayLimit)).toBe(1024)
  await using tmp = await tmpdir()
  const create = { ...seed, createOnly: true, operationId: "durable" }
  await open(
    tmp.path,
    (auth) =>
      Effect.gen(function* () {
        const initial = yield* auth.setVendor(create)
        const command = {
          id,
          expectedEntityId: initial.vendors[0]!.entityId,
          name: "First",
          revision: initial.revision,
          operationId: "evict",
        }
        const first = yield* auth.setVendor(command)
        const second = yield* auth.setVendor({
          id,
          name: "Second",
          revision: first.revision,
          operationId: "pressure-1",
        })
        const third = yield* auth.setVendor({ id, name: "Third", revision: second.revision, operationId: "pressure-2" })
        const before = yield* Effect.promise(() => bytes(tmp.path))
        expect((yield* auth.setVendor(command).pipe(Effect.flip)).info.code).toBe("REVISION_CONFLICT")
        expect(yield* Effect.promise(() => bytes(tmp.path))).toBe(before)
        expect((yield* auth.setVendor(create)).operationReceipt).toEqual(initial.operationReceipt)
        const deleted = yield* auth.deleteVendor({
          id,
          expectedEntityId: initial.vendors[0]!.entityId,
          revision: third.revision,
          operationId: "remove",
        })
        const replay = yield* auth.setVendor(create)
        expect(replay.operationReceipt).toEqual(initial.operationReceipt)
        expect(replay.revision).toBe(deleted.revision)
        expect(replay.vendors).toEqual([])
      }),
    { limit: 2 },
  )
  const replay = await open(tmp.path, (auth) => auth.setVendor(create), { limit: 2 })
  expect(replay.vendors).toEqual([])
})

for (const kind of ["set", "clear"] as const)
  test(`O26/O29 cancellation after ${kind} replacement retains exact evidence`, async () => {
    await using tmp = await tmpdir()
    const renamed = Deferred.makeUnsafe<void>()
    const release = Deferred.makeUnsafe<void>()
    let armed = false
    const wrapped = Layer.effect(
      FSUtil.Service,
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        return FSUtil.Service.of({
          ...fs,
          rename: (from, to) =>
            fs
              .rename(from, to)
              .pipe(
                Effect.andThen(() =>
                  armed && path.resolve(to) === path.join(tmp.path, "relay-auth.json")
                    ? Deferred.succeed(renamed, undefined).pipe(Effect.andThen(Deferred.await(release)))
                    : Effect.void,
                ),
              ),
        })
      }),
    ).pipe(Layer.provide(files))
    await open(
      tmp.path,
      (auth) =>
        Effect.gen(function* () {
          const initial = yield* auth.setVendor(seed)
          const command = {
            id,
            expectedEntityId: initial.vendors[0]!.entityId,
            revision: initial.revision,
            operationId: `cancel-${kind}`,
          }
          const perform = () => (kind === "set" ? auth.setVendor(command) : auth.clearVendorKey(command))
          armed = true
          const running = yield* perform().pipe(Effect.forkChild)
          yield* Deferred.await(renamed).pipe(Effect.timeout("3 seconds"))
          const cancelling = yield* Fiber.interrupt(running).pipe(Effect.forkChild)
          yield* Effect.yieldNow
          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(cancelling)
          armed = false
          expect(Exit.isFailure(yield* Fiber.await(running))).toBe(true)
          const replay = yield* perform()
          expect(replay.revision).toBe(initial.revision + 1)
          expect(replay.vendors[0]!.revision).toBe(initial.vendors[0]!.revision + 1)
        }).pipe(Effect.ensuring(Deferred.succeed(release, undefined))),
      { files: wrapped },
    )
  })

test("O26 unknown replacement outcome is never reconstructed as a successful receipt", async () => {
  await using tmp = await tmpdir()
  let armed = false
  const wrapped = Layer.effect(
    FSUtil.Service,
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      return FSUtil.Service.of({
        ...fs,
        rename: (from, to) =>
          fs
            .rename(from, to)
            .pipe(
              Effect.andThen(() =>
                armed && path.resolve(to) === path.join(tmp.path, "relay-auth.json")
                  ? Effect.fail(denied())
                  : Effect.void,
              ),
            ),
      })
    }),
  ).pipe(Layer.provide(files))
  await open(
    tmp.path,
    (auth) =>
      Effect.gen(function* () {
        const initial = yield* auth.setVendor(seed)
        const command = {
          id,
          expectedEntityId: initial.vendors[0]!.entityId,
          name: "Unknown",
          revision: initial.revision,
          operationId: "unknown",
        }
        armed = true
        expect((yield* auth.setVendor(command).pipe(Effect.flip)).info.code).toBe("SECRET_STORE_UNAVAILABLE")
        armed = false
        const observed = yield* auth.get()
        expect(observed.revision).toBe(initial.revision + 1)
        expect(observed.vendors[0]!.revision).toBe(initial.vendors[0]!.revision + 1)
        const before = yield* Effect.promise(() => bytes(tmp.path))
        expect((yield* auth.setVendor(command).pipe(Effect.flip)).info.code).toBe("REVISION_CONFLICT")
        expect(yield* Effect.promise(() => bytes(tmp.path))).toBe(before)
      }),
    { files: wrapped },
  )
})

test("O29 a colliding DTO cannot clean another committed command's retired credentials", async () => {
  await using tmp = await tmpdir()
  const values = new Map<string, string>()
  let blocked = true
  let removals = 0
  const secrets = Layer.succeed(
    RelaySecretStore.Service,
    RelaySecretStore.Service.of({
      get: (ref) => Effect.sync(() => values.get(ref)),
      put: (ref, value) => Effect.sync(() => void values.set(ref, value)),
      remove: (ref) =>
        Effect.suspend(() => {
          removals += 1
          return blocked
            ? Effect.fail(new RelaySecretStore.UnavailableError())
            : Effect.sync(() => void values.delete(ref))
        }),
    }),
  )
  await open(
    tmp.path,
    (auth) =>
      Effect.gen(function* () {
        const initial = yield* auth.setVendor(seed)
        const command = {
          id,
          expectedEntityId: initial.vendors[0]!.entityId,
          key: "fake-next",
          revision: initial.revision,
          operationId: "retired-owner",
        }
        const saved = yield* auth.setVendor(command)
        expect(saved.cleanupPending).toBe(true)
        const before = yield* Effect.promise(() => bytes(tmp.path))
        const attempts = removals
        blocked = false
        expect((yield* auth.setVendor({ ...command, key: "fake-other" }).pipe(Effect.flip)).info.code).toBe(
          "REQUEST_CONFLICT",
        )
        expect(removals).toBe(attempts)
        expect(yield* Effect.promise(() => bytes(tmp.path))).toBe(before)
        const next = yield* auth.setVendor({ id, name: "Later", revision: saved.revision })
        const replay = yield* auth.setVendor(command)
        expect(replay.cleanupPending).toBe(false)
        expect(replay.revision).toBe(next.revision)
        expect(replay.vendors[0]!.name).toBe("Later")
        expect([...values.values()]).toEqual([command.key])
      }),
    { secrets },
  )
})

test("O24/O25 a pending clear replays a newer snapshot without clearing the later key or advancing either revision", async () => {
  await using tmp = await tmpdir()
  const values = new Map<string, string>()
  let blocked = false
  const secrets = Layer.succeed(
    RelaySecretStore.Service,
    RelaySecretStore.Service.of({
      get: (ref) => Effect.sync(() => values.get(ref)),
      put: (ref, value) => Effect.sync(() => void values.set(ref, value)),
      remove: (ref) =>
        Effect.suspend(() =>
          blocked ? Effect.fail(new RelaySecretStore.UnavailableError()) : Effect.sync(() => void values.delete(ref)),
        ),
    }),
  )
  await open(
    tmp.path,
    (auth) =>
      Effect.gen(function* () {
        const initial = yield* auth.setVendor(seed)
        const baseline = initial.vendors[0]!.revision
        const command = {
          id,
          expectedEntityId: initial.vendors[0]!.entityId,
          revision: initial.revision,
          operationId: "clear-watermark",
        }
        blocked = true
        const cleared = yield* auth.clearVendorKey(command)
        expect(cleared.cleanupPending).toBe(true)
        expect(cleared.vendors[0]!.revision).toBe(baseline + 1)
        const restored = yield* auth.setVendor({ id, key: "fake-next", revision: cleared.revision })
        const other = yield* auth.setVendor({
          ...seed,
          id: Relay.VendorID.make("other"),
          key: "fake-other-vendor",
          revision: restored.revision,
        })
        const before = (yield* auth.get()).revision
        blocked = false
        const replay = yield* auth.clearVendorKey(command)
        expect(replay.cleanupPending).toBe(false)
        expect(replay.revision).toBe(other.revision)
        expect(replay.revision).toBe(before)
        expect(replay.vendors.find((vendor) => vendor.id === id)!.revision).toBe(baseline + 2)
        expect((yield* auth.resolve(id)).key).toBe("fake-next")
        expect([...values.values()]).not.toContain(seed.key)
        expect((yield* auth.resolve(Relay.VendorID.make("other"))).key).toBe("fake-other-vendor")
      }),
    { secrets },
  )
})
