import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { NodeFileSystem } from "@effect/platform-node"
import { Cause, Effect, Exit, Fiber, FileSystem, Layer, PlatformError } from "effect"
import { Relay } from "@opencode-ai/schema/relay"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNodePlatform } from "../src/effect/app-node-platform"
import { FSUtil } from "../src/fs-util"
import { Global } from "../src/global"
import { RelayAuth } from "../src/relay-auth"
import { RelaySecretStore } from "../src/relay-secret-store"
import { tmpdir } from "./fixture/tmpdir"
import { admit } from "../../../script/test-isolation.mjs"

const id = Relay.VendorID.make("lifecycle")
const initial = { id, name: "Initial", baseURL: "https://lifecycle.invalid/v1", key: "fake-original", revision: 0 }

function fixture(data: string, match: (method: string, file: string, destination?: string) => boolean) {
  admit(process.env.OPENCODE_TEST_ROOT!, { global: { data } })
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const values = new Map<string, string>()
  const events: string[] = []
  const control = {
    armed: false,
    blocked: false,
    settled: false,
    reject: false,
    rejectBefore: false,
    failSystem: false,
    failDelete: false,
  }
  const system: RelaySecretStore.SystemSecrets = {
    get: async ({ name }) => values.get(name) ?? null,
    set: async ({ name, value }) => {
      events.push("system-set")
      values.set(name, value)
      if (control.failSystem) throw new Error("fake system failure after write")
    },
    delete: async ({ name }) => {
      events.push("system-delete")
      if (control.failDelete) throw new Error("fake cleanup failure")
      return values.delete(name)
    },
  }
  const native = Layer.effect(
    FileSystem.FileSystem,
    Effect.gen(function* () {
      const original = yield* FileSystem.FileSystem
      const intercept = (
        method: string,
        file: string,
        io: Effect.Effect<void, PlatformError.PlatformError>,
        destination?: string,
      ) => {
        if (!control.armed || control.blocked || !match(method, file, destination)) return io
        control.blocked = true
        return Effect.tryPromise({
          try: async () => {
            events.push("io-dispatched")
            started.resolve()
            await release.promise
            if (control.rejectBefore) {
              control.settled = true
              throw new Error("fake IO failure before side effect")
            }
            await Effect.runPromise(io)
            control.settled = true
            events.push("io-settled")
            if (control.reject) throw new Error("fake IO failure after side effect")
          },
          catch: () =>
            new PlatformError.PlatformError(
              new PlatformError.SystemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method,
                syscall: method,
              }),
            ),
        })
      }
      return FileSystem.FileSystem.of({
        ...original,
        writeFileString: (file, ...args) => intercept("write", file, original.writeFileString(file, ...args)),
        chmod: (file, ...args) => intercept("chmod", file, original.chmod(file, ...args)),
        rename: (file, destination) => intercept("rename", file, original.rename(file, destination), destination),
        remove: (file, ...args) => intercept("remove", file, original.remove(file, ...args)),
      })
    }),
  ).pipe(Layer.provide(NodeFileSystem.layer))
  const filesystem = AppNodeBuilder.build(FSUtil.node, [[LayerNodePlatform.filesystem, native]])
  const global = Global.layerWith({ data })
  const layer = AppNodeBuilder.build(RelayAuth.node, [
    [Global.node, global],
    [FSUtil.node, filesystem],
    [RelaySecretStore.node, RelaySecretStore.makeLayer(system).pipe(Layer.provide(filesystem), Layer.provide(global))],
  ])
  return { started, release, values, events, control, layer }
}

const boundaries = [
  { id: "S14 journal write", method: "write", prefix: "relay-auth-preparing.json.", committed: false },
  { id: "S14 journal chmod", method: "chmod", prefix: "relay-auth-preparing.json.", committed: false },
  { id: "S14/S15 journal publication", method: "rename", destination: "relay-auth-preparing.json", committed: false },
  { id: "S16 auth write", method: "write", prefix: "relay-auth.json.", committed: false },
  { id: "S16 auth chmod", method: "chmod", prefix: "relay-auth.json.", committed: false },
  { id: "S16 auth preparation", method: "rename", suffix: ".next", committed: false },
  { id: "S10/S16 auth publication", method: "rename", destination: "relay-auth.json", committed: true },
  { id: "S15 journal removal", method: "remove", file: "relay-auth-preparing.json", committed: true },
  { id: "S09 fallback write", method: "write", prefix: "relay-secrets.json.", committed: false, fallback: true },
  { id: "S09 fallback chmod", method: "chmod", prefix: "relay-secrets.json.", committed: false, fallback: true },
  {
    id: "S09 fallback publication",
    method: "rename",
    destination: "relay-secrets.json",
    committed: false,
    fallback: true,
  },
] as const

for (const boundary of boundaries) {
  test(`${boundary.id}: cancellation retains ownership until actual IO completion`, async () => {
    await using tmp = await tmpdir()
    const f = fixture(
      tmp.path,
      (method, file, destination) =>
        method === boundary.method &&
        ("prefix" in boundary
          ? path.basename(file).startsWith(boundary.prefix)
          : "destination" in boundary
            ? path.basename(destination ?? "") === boundary.destination
            : "suffix" in boundary
              ? (destination ?? "").endsWith(boundary.suffix)
              : path.basename(file) === boundary.file),
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const auth = yield* RelayAuth.Service
        const before = yield* auth.setVendor(initial)
        f.events.length = 0
        f.control.failSystem = "fallback" in boundary
        f.control.armed = true
        const saving = yield* Effect.forkChild(auth.setVendor({ id, key: "fake-late", revision: before.revision }))
        yield* Effect.promise(() => f.started.promise)
        saving.interruptUnsafe()
        const observed = yield* Fiber.await(saving).pipe(Effect.timeoutOption("100 millis"))
        // A separately built service competes for the real file lock, not the first service's semaphore.
        const competing = yield* Effect.forkChild(
          Effect.gen(function* () {
            const other = yield* RelayAuth.Service
            yield* other.capture(id)
            const current = yield* other.get()
            return yield* other.setVendor({ id, name: "Successor", revision: current.revision })
          }).pipe(Effect.provide(Layer.fresh(f.layer))),
        )
        const competitor = yield* Fiber.await(competing).pipe(Effect.timeoutOption("100 millis"))
        const wasSettled = f.control.settled
        const journal = yield* Effect.promise(() =>
          fs.readFile(path.join(tmp.path, "relay-auth-preparing.json"), "utf8").catch(() => undefined),
        )
        f.release.resolve()
        const ended = yield* Fiber.await(saving)
        const successor = yield* Fiber.join(competing)
        expect(observed._tag).toBe("None")
        expect(competitor._tag).toBe("None")
        expect(wasSettled).toBe(false)
        expect(Exit.isFailure(ended) && Cause.hasInterrupts(ended.cause)).toBe(true)
        if (!boundary.id.startsWith("S14")) expect(journal).toBeDefined()
        if (boundary.id.startsWith("S14") || (boundary.id.startsWith("S15") && !boundary.committed))
          expect(f.events).not.toContain("system-set")
        expect(successor.revision).toBe(before.revision + (boundary.committed ? 2 : 1))
        expect((yield* auth.resolve(id)).key).toBe(boundary.committed ? "fake-late" : "fake-original")
        expect([...f.values.values()]).toEqual([boundary.committed ? "fake-late" : "fake-original"])
        const files = yield* Effect.promise(() => fs.readdir(tmp.path))
        expect(files.filter((file) => /\.(tmp|next)$/.test(file))).toEqual([])
        expect(files).not.toContain("relay-auth-preparing.json")
        expect((yield* auth.get()).vendors[0].name).toBe("Successor")
      }).pipe(Effect.provide(f.layer), Effect.ensuring(Effect.sync(() => f.release.resolve()))),
    )
  })
}

test("S08: cancellation and cleanup failure retain both causes and recover on service reconstruction", async () => {
  await using tmp = await tmpdir()
  const f = fixture(
    tmp.path,
    (method, file) => method === "chmod" && path.basename(file).startsWith("relay-auth.json."),
  )
  await Effect.runPromise(
    Effect.gen(function* () {
      const auth = yield* RelayAuth.Service
      const before = yield* auth.setVendor(initial)
      f.control.armed = true
      const saving = yield* Effect.forkChild(auth.setVendor({ id, key: "fake-retiring", revision: before.revision }))
      yield* Effect.promise(() => f.started.promise)
      saving.interruptUnsafe()
      f.control.failDelete = true
      f.release.resolve()
      const ended = yield* Fiber.await(saving)
      expect(Exit.isFailure(ended) && Cause.hasInterrupts(ended.cause)).toBe(true)
      expect(Exit.isFailure(ended) && Cause.hasFails(ended.cause)).toBe(true)
      expect(
        yield* Effect.promise(() => fs.readFile(path.join(tmp.path, "relay-auth-preparing.json"), "utf8")),
      ).toContain("secret:")
      f.control.failDelete = false
      yield* Effect.gen(function* () {
        const recovered = yield* RelayAuth.Service
        expect((yield* recovered.resolve(id)).key).toBe("fake-original")
      }).pipe(Effect.provide(Layer.fresh(f.layer)))
      expect([...f.values.values()]).toEqual(["fake-original"])
      expect(yield* Effect.promise(() => fs.readdir(tmp.path))).not.toContain("relay-auth-preparing.json")
    }).pipe(Effect.provide(f.layer), Effect.ensuring(Effect.sync(() => f.release.resolve()))),
  )
})

test("S12: system write-then-reject with successful fallback commits once and retains active copies", async () => {
  await using tmp = await tmpdir()
  const f = fixture(tmp.path, () => false)
  await Effect.runPromise(
    Effect.gen(function* () {
      const auth = yield* RelayAuth.Service
      const before = yield* auth.setVendor(initial)
      f.control.failSystem = true
      const saved = yield* auth.setVendor({
        id,
        key: "fake-fallback",
        revision: before.revision,
        operationId: "fallback",
      })
      expect(saved.revision).toBe(before.revision + 1)
      expect((yield* auth.resolve(id)).key).toBe("fake-fallback")
      expect([...f.values.values()]).toEqual(["fake-fallback"])
      const fallback = yield* Effect.promise(() => fs.readFile(path.join(tmp.path, "relay-secrets.json"), "utf8"))
      expect(Object.values(JSON.parse(fallback))).toEqual(["fake-fallback"])
    }).pipe(Effect.provide(f.layer)),
  )
})

test("S13: failure of both writes does not commit; write-then-reject side effects are retired", async () => {
  await using tmp = await tmpdir()
  const f = fixture(
    tmp.path,
    (method, file) => method === "chmod" && path.basename(file).startsWith("relay-secrets.json."),
  )
  await Effect.runPromise(
    Effect.gen(function* () {
      const auth = yield* RelayAuth.Service
      const before = yield* auth.setVendor(initial)
      f.control.failSystem = true
      f.control.reject = true
      f.control.armed = true
      const saving = yield* Effect.forkChild(auth.setVendor({ id, key: "fake-rejected", revision: before.revision }))
      yield* Effect.promise(() => f.started.promise)
      f.release.resolve()
      const failed = yield* Fiber.await(saving)
      expect(Exit.isFailure(failed) && Cause.hasFails(failed.cause) && !Cause.hasDies(failed.cause)).toBe(true)
      expect((yield* auth.get()).revision).toBe(before.revision)
      expect((yield* auth.resolve(id)).key).toBe("fake-original")
      expect([...f.values.values()]).toEqual(["fake-original"])
      expect((yield* Effect.promise(() => fs.readdir(tmp.path))).filter((name) => /\.(tmp|next)$/.test(name))).toEqual(
        [],
      )
    }).pipe(Effect.provide(f.layer), Effect.ensuring(Effect.sync(() => f.release.resolve()))),
  )
})

test("S04: cancelling a save waiting for admission never dispatches its secret", async () => {
  await using tmp = await tmpdir()
  const f = fixture(
    tmp.path,
    (method, file) => method === "write" && path.basename(file).startsWith("relay-auth.json."),
  )
  await Effect.runPromise(
    Effect.gen(function* () {
      const auth = yield* RelayAuth.Service
      const before = yield* auth.setVendor(initial)
      f.events.length = 0
      f.control.armed = true
      const holding = yield* Effect.forkChild(auth.setVendor({ id, name: "Holding", revision: before.revision }))
      yield* Effect.promise(() => f.started.promise)
      const waiting = yield* Effect.forkChild(
        auth.setVendor({ id, key: "fake-never-dispatched", revision: before.revision }),
      )
      waiting.interruptUnsafe()
      const exit = yield* Fiber.await(waiting)
      f.release.resolve()
      yield* Fiber.join(holding)
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(f.events).not.toContain("system-set")
      expect([...f.values.values()]).toEqual(["fake-original"])
      expect((yield* auth.resolve(id)).key).toBe("fake-original")
    }).pipe(Effect.provide(f.layer), Effect.ensuring(Effect.sync(() => f.release.resolve()))),
  )
})

test("S11: scope close waits for dispatched IO and finishes recovery before releasing ownership", async () => {
  await using tmp = await tmpdir()
  const f = fixture(
    tmp.path,
    (method, file) => method === "chmod" && path.basename(file).startsWith("relay-auth-preparing.json."),
  )
  const closing = Effect.runFork(
    Effect.scoped(
      Effect.gen(function* () {
        const auth = yield* RelayAuth.Service
        const before = yield* auth.setVendor(initial)
        f.events.length = 0
        f.control.armed = true
        yield* Effect.forkScoped(auth.setVendor({ id, key: "fake-scope", revision: before.revision }))
        yield* Effect.promise(() => f.started.promise)
        // Returning closes the scope and cancels its child while chmod is still pending.
      }),
    ).pipe(Effect.provide(f.layer)),
  )
  try {
    await f.started.promise
    const observed = await Effect.runPromise(Fiber.await(closing).pipe(Effect.timeoutOption("100 millis")))
    expect(observed._tag).toBe("None")
    expect(f.control.settled).toBe(false)
    expect(f.events).not.toContain("system-set")
  } finally {
    f.release.resolve()
    await Effect.runPromise(Fiber.join(closing))
  }
  expect([...f.values.values()]).toEqual(["fake-original"])
  expect((await fs.readdir(tmp.path)).filter((file) => /\.(tmp|next)$/.test(file))).toEqual([])
  expect(await fs.readdir(tmp.path)).not.toContain("relay-auth-preparing.json")
})

test("S15: failed journal deletion retains recovery ownership and does not remove the committed secret", async () => {
  await using tmp = await tmpdir()
  const f = fixture(
    tmp.path,
    (method, file) => method === "remove" && path.basename(file) === "relay-auth-preparing.json",
  )
  await Effect.runPromise(
    Effect.gen(function* () {
      const auth = yield* RelayAuth.Service
      const before = yield* auth.setVendor(initial)
      f.control.armed = true
      f.control.rejectBefore = true
      const saving = yield* Effect.forkChild(auth.setVendor({ id, key: "fake-committed", revision: before.revision }))
      yield* Effect.promise(() => f.started.promise)
      f.release.resolve()
      const exit = yield* Fiber.await(saving)
      expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(true)
      expect(yield* Effect.promise(() => fs.readdir(tmp.path))).toContain("relay-auth-preparing.json")
      expect((yield* auth.get()).revision).toBe(before.revision + 1)
      expect([...f.values.values()]).toEqual(["fake-committed"])
      yield* Effect.gen(function* () {
        const recovered = yield* RelayAuth.Service
        expect((yield* recovered.resolve(id)).key).toBe("fake-committed")
      }).pipe(Effect.provide(Layer.fresh(f.layer)))
      expect(yield* Effect.promise(() => fs.readdir(tmp.path))).not.toContain("relay-auth-preparing.json")
    }).pipe(Effect.provide(f.layer), Effect.ensuring(Effect.sync(() => f.release.resolve()))),
  )
})

for (const afterPublication of [false, true]) {
  test(`S16: final rename rejection (${afterPublication ? "after" : "before"} publication) reconciles the live ref conservatively`, async () => {
    await using tmp = await tmpdir()
    const f = fixture(
      tmp.path,
      (method, _file, destination) => method === "rename" && path.basename(destination ?? "") === "relay-auth.json",
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const auth = yield* RelayAuth.Service
        const before = yield* auth.setVendor(initial)
        const bytes = yield* Effect.promise(() => fs.readFile(path.join(tmp.path, "relay-auth.json"), "utf8"))
        f.control.armed = true
        f.control.rejectBefore = !afterPublication
        f.control.reject = afterPublication
        const saving = yield* Effect.forkChild(auth.setVendor({ id, key: "fake-publish", revision: before.revision }))
        yield* Effect.promise(() => f.started.promise)
        f.release.resolve()
        const exit = yield* Fiber.await(saving)
        expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(true)
        expect((yield* auth.get()).revision).toBe(before.revision + Number(afterPublication))
        if (!afterPublication)
          expect(yield* Effect.promise(() => fs.readFile(path.join(tmp.path, "relay-auth.json"), "utf8"))).toBe(bytes)
        yield* Effect.gen(function* () {
          const recovered = yield* RelayAuth.Service
          expect((yield* recovered.resolve(id)).key).toBe(afterPublication ? "fake-publish" : "fake-original")
        }).pipe(Effect.provide(Layer.fresh(f.layer)))
        expect([...f.values.values()]).toEqual([afterPublication ? "fake-publish" : "fake-original"])
      }).pipe(Effect.provide(f.layer), Effect.ensuring(Effect.sync(() => f.release.resolve()))),
    )
  })
}
