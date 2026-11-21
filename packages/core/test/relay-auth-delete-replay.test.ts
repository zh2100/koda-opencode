import { expect, test } from "bun:test"
import path from "node:path"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import { Relay } from "@opencode-ai/schema/relay"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { Global } from "../src/global"
import { FSUtil } from "../src/fs-util"
import { RelayAuth } from "../src/relay-auth"
import { RelaySecretStore } from "../src/relay-secret-store"
import { tmpdir } from "./fixture/tmpdir"
import { admit } from "../../../script/test-isolation.mjs"

const id = Relay.VendorID.make("replay-delete")
const seed = { id, name: "Replay", baseURL: "https://replay.invalid/v1", key: "fake-original", revision: 0 }
function fixture(data: string, limit = 1024) {
  admit(process.env.OPENCODE_TEST_ROOT!, { global: { data } })
  const values = new Map<string, string>()
  const control = { failDelete: false, holdDelete: false }
  const deleteStarted = Promise.withResolvers<void>()
  const releaseDelete = Promise.withResolvers<void>()
  const global = Global.layerWith({ data })
  const files = AppNodeBuilder.build(FSUtil.node)
  const system: RelaySecretStore.SystemSecrets = {
    get: async ({ name }) => values.get(name) ?? null,
    set: async ({ name, value }) => {
      values.set(name, value)
    },
    delete: async ({ name }) => {
      if (control.holdDelete) {
        deleteStarted.resolve()
        await releaseDelete.promise
      }
      if (control.failDelete) throw new Error("fake cleanup failure")
      return values.delete(name)
    },
  }
  const layer = AppNodeBuilder.build(RelayAuth.node, [
    [Global.node, global],
    [RelaySecretStore.node, RelaySecretStore.makeLayer(system).pipe(Layer.provide(files), Layer.provide(global))],
  ]).pipe(Layer.provide(Layer.succeed(RelayAuth.ReplayLimit, limit)))
  return { layer, values, control, deleteStarted, releaseDelete }
}

for (const cleanupFails of [false, true]) {
  test(`A01/A06: restarted cleanup (${cleanupFails ? "pending" : "completed"}) is not a compatible delete receipt`, async () => {
    await using tmp = await tmpdir()
    const f = fixture(tmp.path)
    const revision = await Effect.runPromise(
      Effect.gen(function* () {
        const auth = yield* RelayAuth.Service
        const first = yield* auth.setVendor(seed)
        f.control.failDelete = true
        yield* auth.setVendor({ id, key: "fake-next", revision: first.revision, operationId: "rotation" })
        return first.revision
      }).pipe(Effect.provide(f.layer)),
    )
    f.control.failDelete = cleanupFails
    await Effect.runPromise(
      Effect.gen(function* () {
        const auth = yield* RelayAuth.Service
        const before = yield* auth.get()
        const file = path.join(tmp.path, "relay-auth.json")
        const bytes = yield* Effect.promise(() => Bun.file(file).text())
        const result = yield* auth.deleteVendor({ id, revision, operationId: "rotation" }).pipe(Effect.result)
        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure")
          expect(["REQUEST_CONFLICT", "REVISION_CONFLICT"]).toContain(result.failure.info.code)
        expect(yield* auth.get()).toEqual(before)
        expect(yield* Effect.promise(() => Bun.file(file).text())).toBe(bytes)
        expect((yield* auth.resolve(id)).key).toBe("fake-next")
      }).pipe(Effect.provide(Layer.fresh(f.layer))),
    )
  })
}

for (const protectedDelete of [false, true]) {
  test(`A02/A03/A05: ${protectedDelete ? "protected" : "compatible"} deletion replays only its exact command after same-name recreation`, async () => {
    await using tmp = await tmpdir()
    const f = fixture(tmp.path)
    await Effect.runPromise(
      Effect.gen(function* () {
        const auth = yield* RelayAuth.Service
        const first = yield* auth.setVendor(seed)
        const command = {
          id,
          revision: first.revision,
          operationId: "delete-exact",
          ...(protectedDelete ? { expectedEntityId: first.vendors[0].entityId } : {}),
        }
        const removed = yield* auth.deleteVendor(command)
        expect((yield* auth.deleteVendor(command)).revision).toBe(removed.revision)
        const recreated = yield* auth.setVendor({ ...seed, key: "fake-successor", revision: removed.revision })
        expect(recreated.vendors[0].entityId).not.toBe(first.vendors[0].entityId)
        const bytes = yield* Effect.promise(() => Bun.file(path.join(tmp.path, "relay-auth.json")).text())
        expect((yield* auth.deleteVendor(command)).revision).toBe(recreated.revision)
        for (const changed of [
          { ...command, id: Relay.VendorID.make("other") },
          { ...command, revision: recreated.revision },
          { ...command, expectedEntityId: protectedDelete ? undefined : first.vendors[0].entityId },
        ]) {
          expect((yield* auth.deleteVendor(changed).pipe(Effect.flip)).info.code).toBe("REQUEST_CONFLICT")
        }
        expect(
          (yield* auth
            .clearVendorKey({ id, revision: recreated.revision, operationId: command.operationId })
            .pipe(Effect.flip)).info.code,
        ).toBe("REQUEST_CONFLICT")
        expect(
          (yield* auth
            .setVendor({ id, name: "Wrong", revision: recreated.revision, operationId: command.operationId })
            .pipe(Effect.flip)).info.code,
        ).toBe("REQUEST_CONFLICT")
        expect((yield* auth.resolve(id)).key).toBe("fake-successor")
        expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "relay-auth.json")).text())).toBe(bytes)
      }).pipe(Effect.provide(f.layer)),
    )
  })
}

test("A04: committed compatible delete remains confirmable after cleanup failure", async () => {
  await using tmp = await tmpdir()
  const f = fixture(tmp.path)
  await Effect.runPromise(
    Effect.gen(function* () {
      const auth = yield* RelayAuth.Service
      const first = yield* auth.setVendor(seed)
      const command = { id, revision: first.revision, operationId: "delete-cleanup" }
      f.control.failDelete = true
      const removed = yield* auth.deleteVendor(command)
      expect(removed.cleanupPending).toBe(true)
      f.control.failDelete = false
      const retried = yield* auth.deleteVendor(command)
      expect(retried.revision).toBe(removed.revision)
      expect(retried.cleanupPending).toBe(false)
      expect(f.values.size).toBe(0)
    }).pipe(Effect.provide(f.layer)),
  )
})

for (const protectedDelete of [false, true]) {
  test(`A04: ${protectedDelete ? "protected" : "compatible"} committed deletion retains command evidence through cancelled cleanup`, async () => {
    await using tmp = await tmpdir()
    const f = fixture(tmp.path)
    await Effect.runPromise(
      Effect.gen(function* () {
        const auth = yield* RelayAuth.Service
        const first = yield* auth.setVendor(seed)
        const command = {
          id,
          revision: first.revision,
          operationId: "cancelled-delete",
          ...(protectedDelete ? { expectedEntityId: first.vendors[0].entityId } : {}),
        }
        f.control.holdDelete = true
        const deleting = yield* Effect.forkChild(auth.deleteVendor(command))
        yield* Effect.promise(() => f.deleteStarted.promise)
        deleting.interruptUnsafe()
        const observed = yield* Fiber.await(deleting).pipe(Effect.timeoutOption("100 millis"))
        f.control.holdDelete = false
        f.releaseDelete.resolve()
        const exit = yield* Fiber.await(deleting)
        expect(observed._tag).toBe("None")
        expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
        const committed = yield* auth.get()
        expect(committed.revision).toBe(first.revision + 1)
        expect(committed.vendors).toHaveLength(0)
        const replayed = yield* auth.deleteVendor(command)
        expect(replayed.revision).toBe(committed.revision)
        expect(replayed.cleanupPending).toBe(false)
        expect(f.values.size).toBe(0)
      }).pipe(Effect.provide(f.layer), Effect.ensuring(Effect.sync(() => f.releaseDelete.resolve()))),
    )
  })
}

for (const protectedDelete of [false, true]) {
  test(`A06: bounded eviction ${protectedDelete ? "retains protected" : "expires compatible"} deletion evidence`, async () => {
    await using tmp = await tmpdir()
    const f = fixture(tmp.path, 2)
    await Effect.runPromise(
      Effect.gen(function* () {
        const auth = yield* RelayAuth.Service
        const first = yield* auth.setVendor(seed)
        const command = {
          id,
          revision: first.revision,
          operationId: "evicted",
          ...(protectedDelete ? { expectedEntityId: first.vendors[0].entityId } : {}),
        }
        let state = yield* auth.deleteVendor(command)
        for (const index of [0, 1, 2]) {
          state = yield* auth.setVendor({
            ...seed,
            id: Relay.VendorID.make(`other-${index}`),
            revision: state.revision,
            operationId: `other-${index}`,
          })
        }
        const result = yield* auth.deleteVendor(command).pipe(Effect.result)
        if (protectedDelete) expect(result._tag === "Success" && result.success.revision).toBe(state.revision)
        else expect(result._tag).toBe("Failure")
        expect((yield* auth.get()).revision).toBe(state.revision)
      }).pipe(Effect.provide(f.layer)),
    )
  })
}
