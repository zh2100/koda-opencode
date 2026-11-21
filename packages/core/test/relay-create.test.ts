import { expect, test } from "bun:test"
import { Cause, Deferred, Effect, Fiber, Layer, PlatformError } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { RelayAuth } from "@opencode-ai/core/relay-auth"
import { RelaySecretStore } from "@opencode-ai/core/relay-secret-store"
import { Relay } from "@opencode-ai/schema/relay"
import { tmpdir } from "./fixture/tmpdir"
import path from "node:path"
import fs from "node:fs/promises"

const open = <A, E>(
  root: string,
  body: (auth: RelayAuth.Interface) => Effect.Effect<A, E>,
  filesystem?: Layer.Layer<FSUtil.Service>,
) => {
  const global = Global.layerWith({ data: root, state: path.join(root, "state") })
  const files = filesystem ?? AppNodeBuilder.build(FSUtil.node)
  const secrets = RelaySecretStore.makeLayer(undefined).pipe(Layer.provide(files), Layer.provide(global))
  const layer = AppNodeBuilder.build(RelayAuth.node, [
    [Global.node, global],
    [RelaySecretStore.node, secrets],
    [FSUtil.node, files],
  ])
  return Effect.scoped(
    Effect.gen(function* () {
      return yield* body(yield* RelayAuth.Service)
    }),
  ).pipe(Effect.provide(layer), Effect.runPromise)
}
const command = {
  id: Relay.VendorID.make("create-review"),
  name: "Review",
  baseURL: "https://review.invalid/v1",
  key: "fake-create-secret",
  revision: 0,
  createOnly: true,
  operationId: "create-review-1",
}
const disk = (root: string) => Bun.file(path.join(root, "relay-auth.json")).json()

test("B001/B117 identities persist and legacy missing identities are upgraded exactly once", async () => {
  await using tmp = await tmpdir()
  const first = await open(tmp.path, (auth) => auth.get())
  expect(first.revision).toBe(0)
  expect(new Set(first.vendors.map((vendor) => vendor.entityId)).size).toBe(first.vendors.length)
  expect(first.vendors.every((vendor) => !!vendor.entityId)).toBe(true)
  await open(tmp.path, (auth) => auth.setVendor(command))
  const stored = await disk(tmp.path)
  for (const vendor of Object.values(stored.vendors) as Array<{ entityId?: string }>) delete vendor.entityId
  await Bun.write(path.join(tmp.path, "relay-auth.json"), JSON.stringify(stored))
  const upgraded = await open(tmp.path, (auth) => auth.get())
  expect(upgraded.revision).toBe(2)
  expect(await open(tmp.path, (auth) => auth.get())).toEqual(upgraded)
})

test("B103/B110 createOnly rejects occupied IDs before credential or receipt-key writes", async () => {
  await using tmp = await tmpdir()
  await open(tmp.path, (auth) =>
    Effect.gen(function* () {
      const initial = yield* auth.get()
      yield* auth.setVendor(command)
      const before = yield* Effect.promise(() => Bun.file(path.join(tmp.path, "relay-auth.json")).text())
      const error = yield* auth.setVendor({ ...command, revision: 1 }).pipe(Effect.flip)
      expect(error.info.code).toBe("REQUEST_CONFLICT")
      expect((yield* auth.get()).revision).toBe(initial.revision + 1)
      expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "relay-auth.json")).text())).toBe(before)
    }),
  )
  expect((await disk(tmp.path)).creationReceipts).toHaveLength(1)
})

test("B108/B111 exact creates survive service reconstruction with a shared credential backend", async () => {
  await using tmp = await tmpdir()
  const saved = await open(tmp.path, (auth) => auth.setVendor(command))
  const replayed = await open(tmp.path, (auth) =>
    Effect.gen(function* () {
      const result = yield* auth.setVendor(command)
      expect((yield* auth.resolve(command.id)).key).toBe(command.key)
      return result
    }),
  )
  expect(replayed.operationReceipt).toEqual(saved.operationReceipt)
  expect(replayed.revision).toBe(saved.revision)
  expect(replayed.vendors).toHaveLength(1)
  const persisted = await disk(tmp.path)
  expect(persisted.creationReceipts).toHaveLength(1)
  expect(JSON.stringify(persisted)).not.toContain(command.key)
  expect(JSON.stringify(replayed)).not.toContain("fingerprint")
  expect(JSON.stringify(replayed)).not.toContain("keyRef")
})

test("B112 command fingerprints reject changed keys, targets, revisions and operation kinds", async () => {
  await using tmp = await tmpdir()
  await open(tmp.path, (auth) =>
    Effect.gen(function* () {
      const first = yield* auth.setVendor(command)
      for (const patch of [
        { key: "different" },
        { revision: 1 },
        { name: "Different" },
        { id: Relay.VendorID.make("different") },
      ]) {
        const error = yield* auth.setVendor({ ...command, ...patch }).pipe(Effect.flip)
        expect(error.info.code).toBe("REQUEST_CONFLICT")
      }
      expect(
        (yield* auth
          .clearVendorKey({ id: command.id, revision: first.revision, operationId: command.operationId })
          .pipe(Effect.flip)).info.code,
      ).toBe("REQUEST_CONFLICT")
      expect((yield* auth.resolve(command.id)).key).toBe(command.key)
    }),
  )
})

test("B115/B116 every independent auth write retains the durable receipt without resurrecting deleted vendors", async () => {
  await using tmp = await tmpdir()
  await Bun.write(path.join(tmp.path, "auth.relay-backup.json"), "{}")
  const original = await open(tmp.path, (auth) =>
    Effect.gen(function* () {
      let state = yield* auth.setVendor(command)
      const receipt = state.operationReceipt!
      const builtin = state.vendors.filter((vendor) => vendor.builtin)
      const check = () =>
        Effect.promise(async () => {
          const stored = await disk(tmp.path)
          expect(stored.creationReceipts[0].entityId).toBe(receipt.entityId)
          expect(stored.creationReceipts).toHaveLength(1)
        })
      state = yield* auth.setVendor({ id: command.id, name: "Renamed", key: "fake-rotated", revision: state.revision })
      yield* check()
      state = yield* auth.clearVendorKey({ id: command.id, revision: state.revision })
      yield* check()
      state = yield* auth.deleteVendor({ id: command.id, revision: state.revision })
      yield* check()
      expect(state.vendors.map((vendor) => vendor.entityId)).toEqual(builtin.map((vendor) => vendor.entityId))
      return { state, receipt }
    }),
  )
  const retried = await open(tmp.path, (auth) => auth.setVendor(command))
  expect(retried.revision).toBe(original.state.revision)
  expect(retried.operationReceipt).toEqual(original.receipt)
  expect(retried.vendors.some((vendor) => vendor.id === command.id)).toBe(false)
})

test("B003/B113 stale entity writes cannot touch a same-ID replacement", async () => {
  await using tmp = await tmpdir()
  await open(tmp.path, (auth) =>
    Effect.gen(function* () {
      const first = yield* auth.setVendor(command)
      const expectedEntityId = first.operationReceipt!.entityId
      const deleted = yield* auth.deleteVendor({ id: command.id, revision: first.revision, expectedEntityId })
      const replacement = yield* auth.setVendor({
        ...command,
        operationId: "replacement",
        revision: deleted.revision,
        key: "fake-replacement",
      })
      expect(replacement.operationReceipt!.entityId).not.toBe(expectedEntityId)
      for (const operation of [
        auth
          .setVendor({ id: command.id, key: "wrong", revision: replacement.revision, expectedEntityId })
          .pipe(Effect.asVoid),
        auth.clearVendorKey({ id: command.id, revision: replacement.revision, expectedEntityId }).pipe(Effect.asVoid),
        auth.deleteVendor({ id: command.id, revision: replacement.revision, expectedEntityId }).pipe(Effect.asVoid),
        auth.resolve(command.id, { expectedEntityId }).pipe(Effect.asVoid),
      ]) {
        expect((yield* operation.pipe(Effect.flip)).info.code).toBe("REQUEST_CONFLICT")
      }
      const replayed = yield* auth.setVendor(command)
      expect(replayed.operationReceipt!.entityId).toBe(expectedEntityId)
      expect((yield* auth.resolve(command.id)).key).toBe("fake-replacement")
    }),
  )
})

test("B114 missing signing key blocks initialization and never regenerates or drops receipts", async () => {
  await using tmp = await tmpdir()
  await open(tmp.path, (auth) => auth.setVendor(command))
  const before = await Bun.file(path.join(tmp.path, "relay-auth.json")).text()
  await fs.unlink(path.join(tmp.path, "relay-auth-receipt-key.json"))
  await expect(open(tmp.path, (auth) => auth.get())).rejects.toBeDefined()
  expect(await Bun.file(path.join(tmp.path, "relay-auth.json")).text()).toBe(before)
  expect(await Bun.file(path.join(tmp.path, "relay-auth-receipt-key.json")).exists()).toBe(false)
})

test("B114 capacity rejects new commands but retains exact retry capability", async () => {
  await using tmp = await tmpdir()
  const previous = process.env.OPENCODE_RELAY_RECEIPT_LIMIT
  process.env.OPENCODE_RELAY_RECEIPT_LIMIT = "1"
  try {
    await open(tmp.path, (auth) =>
      Effect.gen(function* () {
        const first = yield* auth.setVendor(command)
        const other = yield* auth
          .setVendor({ ...command, id: Relay.VendorID.make("other"), operationId: "other", revision: first.revision })
          .pipe(Effect.flip)
        expect(other.info.code).toBe("REQUEST_CONFLICT")
        expect((yield* auth.setVendor(command)).revision).toBe(first.revision)
      }),
    )
    expect((await disk(tmp.path)).creationReceipts).toHaveLength(1)
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_RELAY_RECEIPT_LIMIT
    else process.env.OPENCODE_RELAY_RECEIPT_LIMIT = previous
  }
})

test("B118 a failed config commit leaves no successful receipt and preserves the original secret", async () => {
  await using tmp = await tmpdir()
  const seed = await open(tmp.path, (auth) => auth.setVendor({ ...command, createOnly: false, operationId: "seed" }))
  let reject = true
  const filesystem = Layer.effect(
    FSUtil.Service,
    Effect.gen(function* () {
      const files = yield* FSUtil.Service
      return FSUtil.Service.of({
        ...files,
        rename: (source, target) =>
          target === path.join(tmp.path, "relay-auth.json") && reject
            ? Effect.fail(
                new PlatformError.PlatformError(
                  new PlatformError.SystemError({ _tag: "PermissionDenied", module: "FileSystem", method: "rename" }),
                ),
              )
            : files.rename(source, target),
      })
    }),
  ).pipe(Layer.provide(AppNodeBuilder.build(FSUtil.node)))
  await open(
    tmp.path,
    (auth) =>
      Effect.gen(function* () {
        const error = yield* auth
          .setVendor({ ...command, id: Relay.VendorID.make("new-vendor"), revision: seed.revision })
          .pipe(Effect.flip)
        expect(error.info.code).toBe("SECRET_STORE_UNAVAILABLE")
        reject = false
        expect((yield* auth.resolve(command.id)).key).toBe(command.key)
        expect((yield* auth.get()).vendors.some((vendor) => vendor.id === "new-vendor")).toBe(false)
      }),
    filesystem,
  )
  expect((await disk(tmp.path)).creationReceipts).toBeUndefined()
})

test("B114/B118 runtime signing-key loss blocks deletion without dropping committed metadata", async () => {
  await using tmp = await tmpdir()
  await Bun.write(path.join(tmp.path, "auth.relay-backup.json"), "{}")
  await open(tmp.path, (auth) =>
    Effect.gen(function* () {
      const state = yield* auth.setVendor(command)
      const before = yield* Effect.promise(() => Bun.file(path.join(tmp.path, "relay-auth.json")).text())
      yield* Effect.promise(() => fs.unlink(path.join(tmp.path, "relay-auth-receipt-key.json")))
      const error = yield* auth.deleteVendor({ id: command.id, revision: state.revision }).pipe(Effect.flip)
      expect(error.info.code).toBe("SECRET_STORE_UNAVAILABLE")
      expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "relay-auth.json")).text())).toBe(before)
    }),
  )
})

for (const corruption of [
  "duplicate-entity",
  "invalid-entity",
  "duplicate-receipt",
  "future-receipt",
  "invalid-signing-key",
] as const) {
  test(`B005/B114 corrupt durable metadata is rejected without rewriting: ${corruption}`, async () => {
    await using tmp = await tmpdir()
    await open(tmp.path, (auth) => auth.setVendor(command))
    const authFile = path.join(tmp.path, "relay-auth.json")
    const keyFile = path.join(tmp.path, "relay-auth-receipt-key.json")
    const stored = await disk(tmp.path)
    if (corruption === "duplicate-entity") stored.vendors.other = { ...stored.vendors[command.id], id: "other" }
    if (corruption === "invalid-entity") stored.vendors[command.id].entityId = "invalid"
    if (corruption === "duplicate-receipt") stored.creationReceipts.push({ ...stored.creationReceipts[0] })
    if (corruption === "future-receipt") stored.creationReceipts[0].committedRevision = stored.revision + 1
    if (corruption === "invalid-signing-key") await Bun.write(keyFile, JSON.stringify({ version: 1, key: 123 }))
    await Bun.write(authFile, JSON.stringify(stored))
    const before = await Bun.file(authFile).text()
    const signingKey = await Bun.file(keyFile).text()
    await expect(open(tmp.path, (auth) => auth.get())).rejects.toBeDefined()
    expect(await Bun.file(authFile).text()).toBe(before)
    expect(await Bun.file(keyFile).text()).toBe(signingKey)
  })
}

for (const interruption of [false, true])
  test(`B118 vendor deletion commit interruption=${interruption} preserves complete state and receipts`, async () => {
    await using tmp = await tmpdir()
    const seed = await open(tmp.path, (auth) => auth.setVendor(command))
    await Bun.write(path.join(tmp.path, "auth.relay-backup.json"), "{}")
    const initial = await Bun.file(path.join(tmp.path, "relay-auth.json")).text()
    const entered = Deferred.makeUnsafe<void>()
    const release = Deferred.makeUnsafe<void>()
    let active = false
    const filesystem = Layer.effect(
      FSUtil.Service,
      Effect.gen(function* () {
        const files = yield* FSUtil.Service
        return FSUtil.Service.of({
          ...files,
          rename: (source, target) =>
            Effect.gen(function* () {
              if (active && target === path.join(tmp.path, "relay-auth.json")) {
                yield* Deferred.succeed(entered, undefined)
                if (!interruption)
                  return yield* Effect.fail(
                    new PlatformError.PlatformError(
                      new PlatformError.SystemError({
                        _tag: "PermissionDenied",
                        module: "FileSystem",
                        method: "rename",
                      }),
                    ),
                  )
                yield* Deferred.await(release)
              }
              return yield* files.rename(source, target)
            }),
        })
      }),
    ).pipe(Layer.provide(AppNodeBuilder.build(FSUtil.node)))
    await open(
      tmp.path,
      (auth) =>
        Effect.gen(function* () {
          active = true
          if (interruption) {
            const running = yield* auth.deleteVendor({ id: command.id, revision: seed.revision }).pipe(Effect.forkChild)
            yield* Deferred.await(entered).pipe(Effect.timeout("5 seconds"))
            running.interruptUnsafe()
            const observed = yield* Fiber.await(running).pipe(Effect.timeoutOption("100 millis"))
            yield* Deferred.succeed(release, undefined)
            const interrupted = yield* Fiber.await(running)
            expect(observed._tag).toBe("None")
            expect(interrupted._tag).toBe("Failure")
            if (interrupted._tag === "Failure")
              expect(Cause.hasInterrupts(interrupted.cause), Cause.pretty(interrupted.cause)).toBe(true)
          } else {
            expect(
              (yield* auth.deleteVendor({ id: command.id, revision: seed.revision }).pipe(Effect.flip)).info.code,
            ).toBe("SECRET_STORE_UNAVAILABLE")
          }
          active = false
          if (interruption) {
            expect((yield* auth.get()).vendors.some((vendor) => vendor.id === command.id)).toBe(false)
          } else {
            expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "relay-auth.json")).text())).toBe(initial)
            expect((yield* auth.resolve(command.id)).key).toBe(command.key)
          }
        }).pipe(Effect.ensuring(Deferred.succeed(release, undefined))),
      filesystem,
    )
    const confirmed = await open(tmp.path, (auth) => auth.setVendor(command))
    expect(confirmed.operationReceipt).toEqual(seed.operationReceipt)
    expect(confirmed.revision).toBe(seed.revision + Number(interruption))
  })

const legacyState = async (root: string) => {
  const saved = await open(root, (auth) => auth.setVendor(command))
  const stored = await disk(root)
  stored.unified = true
  stored.unifiedKeyRef = "legacy-shared"
  stored.migrationVersion = 1
  stored.vendors.chatgpt = {
    id: "chatgpt",
    entityId: crypto.randomUUID(),
    name: "Retired",
    builtin: true,
    keyRef: "legacy-builtin",
    updatedAt: 0,
    revision: 1,
  }
  stored.vendors.noaddress = {
    id: "noaddress",
    entityId: crypto.randomUUID(),
    name: "No address",
    builtin: false,
    keyRef: "legacy-noaddress",
    updatedAt: 0,
    revision: 1,
  }
  await Bun.write(path.join(root, "relay-auth.json"), JSON.stringify(stored))
  const file = path.join(root, "relay-secrets.json")
  const secrets = await Bun.file(file).json()
  Object.assign(secrets, {
    "legacy-shared": "shared-secret",
    "legacy-builtin": "hosted-secret",
    "legacy-noaddress": "unroutable-secret",
    unrelated: "keep-me",
  })
  await Bun.write(file, JSON.stringify(secrets))
  return saved
}

test("retiring shared and hosted credentials preserves independent vendors and durable create receipts", async () => {
  await using tmp = await tmpdir()
  const saved = await legacyState(tmp.path)
  const original = JSON.stringify({ leidiandonghua: { type: "api", key: "original-shared" } })
  await Bun.write(path.join(tmp.path, "auth.json"), original)
  const upgraded = await open(tmp.path, (auth) =>
    Effect.gen(function* () {
      const state = yield* auth.get()
      expect(state.vendors.map((vendor) => vendor.id)).toEqual([command.id])
      expect((yield* auth.resolve(command.id)).key).toBe(command.key)
      expect((yield* auth.resolve(Relay.VendorID.chatgpt).pipe(Effect.flip)).info.code).toBe("KEY_MISSING")
      expect((yield* auth.setVendor(command)).operationReceipt).toEqual(saved.operationReceipt)
      return state
    }),
  )
  expect(upgraded.revision).toBe(saved.revision + 1)
  expect(upgraded.vendors[0]?.entityId).toBe(saved.vendors[0]?.entityId)
  const stored = await disk(tmp.path)
  expect(stored).not.toHaveProperty("unified")
  expect(stored).not.toHaveProperty("unifiedKeyRef")
  expect(stored.migrationVersion).toBe(2)
  expect(stored.pendingCleanup).toBeUndefined()
  const secrets = await Bun.file(path.join(tmp.path, "relay-secrets.json")).json()
  expect(Object.values(secrets).sort()).toEqual([command.key, "keep-me"].sort())
  expect(await Bun.file(path.join(tmp.path, "auth.json")).text()).toBe(original)
  const before = await Bun.file(path.join(tmp.path, "relay-auth.json")).text()
  expect(await open(tmp.path, (auth) => auth.get())).toEqual(upgraded)
  expect(await Bun.file(path.join(tmp.path, "relay-auth.json")).text()).toBe(before)
})

for (const boundary of ["config", "cleanup"] as const) {
  test(`credential retirement handles ${boundary} commit failures without losing independent credentials`, async () => {
    await using tmp = await tmpdir()
    const saved = await legacyState(tmp.path)
    const before = await Bun.file(path.join(tmp.path, "relay-auth.json")).text()
    const secretFile = path.join(tmp.path, "relay-secrets.json")
    const secretsBefore = await Bun.file(secretFile).text()
    const filesystem = Layer.effect(
      FSUtil.Service,
      Effect.gen(function* () {
        const files = yield* FSUtil.Service
        return FSUtil.Service.of({
          ...files,
          rename: (source, target) =>
            target === path.join(tmp.path, boundary === "config" ? "relay-auth.json" : "relay-secrets.json")
              ? Effect.fail(
                  new PlatformError.PlatformError(
                    new PlatformError.SystemError({
                      _tag: "PermissionDenied",
                      module: "FileSystem",
                      method: "rename",
                    }),
                  ),
                )
              : files.rename(source, target),
        })
      }),
    ).pipe(Layer.provide(AppNodeBuilder.build(FSUtil.node)))
    if (boundary === "config") {
      await expect(open(tmp.path, (auth) => auth.get(), filesystem)).rejects.toBeDefined()
      expect(await Bun.file(path.join(tmp.path, "relay-auth.json")).text()).toBe(before)
      expect(await Bun.file(secretFile).text()).toBe(secretsBefore)
    } else {
      const state = await open(
        tmp.path,
        (auth) =>
          Effect.gen(function* () {
            expect((yield* auth.resolve(command.id)).key).toBe(command.key)
            return yield* auth.get()
          }),
        filesystem,
      )
      expect(state.vendors).toHaveLength(1)
      const stored = await disk(tmp.path)
      expect(stored.pendingCleanup).toHaveLength(1)
      expect(JSON.stringify(stored.pendingCleanup)).not.toContain("shared-secret")
      expect(stored.revision).toBe(saved.revision + 1)
    }
    const recovered = await open(tmp.path, (auth) => auth.get())
    expect(recovered.revision).toBe(saved.revision + 1)
    expect((await disk(tmp.path)).pendingCleanup).toBeUndefined()
    expect(Object.values(await Bun.file(secretFile).json()).sort()).toEqual([command.key, "keep-me"].sort())
  })
}

test("new vendors require an independent address and explicit empty keys are rejected", async () => {
  await using tmp = await tmpdir()
  await open(tmp.path, (auth) =>
    Effect.gen(function* () {
      expect(
        (yield* auth.setVendor({ id: command.id, name: "No endpoint", key: "key", revision: 0 }).pipe(Effect.flip)).info
          .code,
      ).toBe("REQUEST_CONFLICT")
      expect((yield* auth.get()).revision).toBe(0)
      expect((yield* auth.setVendor({ ...command, key: " " }).pipe(Effect.flip)).info.code).toBe("KEY_MISSING")
      expect((yield* auth.get()).vendors).toEqual([])
    }),
  )
  expect(await Bun.file(path.join(tmp.path, "relay-secrets.json")).exists()).toBe(false)
})
