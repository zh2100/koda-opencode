import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { FSUtil } from "../src/fs-util"
import { Global } from "../src/global"
import { RelayAuth } from "../src/relay-auth"
import { RelaySecretStore } from "../src/relay-secret-store"
import { Relay } from "@opencode-ai/schema/relay"
import { tmpdir } from "./fixture/tmpdir"
import { admit } from "../../../script/test-isolation.mjs"

const marker = "FAKE_SECRET_BOUNDARY_SENTINEL"
const ref = "secret:boundary"
const layerFor = (
  data: string,
  system?: RelaySecretStore.SystemSecrets,
  filesystem = AppNodeBuilder.build(FSUtil.node),
) => {
  admit(process.env.OPENCODE_TEST_ROOT!, { global: { data } })
  return RelaySecretStore.makeLayer(system).pipe(Layer.provide(filesystem), Layer.provide(Global.layerWith({ data })))
}

test("S02/S17: file read denial stays unavailable; a successful system lookup does not read it", async () => {
  await using tmp = await tmpdir()
  let reads = 0
  const filesystem = Layer.effect(
    FSUtil.Service,
    Effect.gen(function* () {
      const original = yield* FSUtil.Service
      return FSUtil.Service.of({
        ...original,
        readJson: (file) =>
          path.basename(file) === "relay-secrets.json"
            ? Effect.suspend(() => {
                reads++
                return Effect.fail(new FSUtil.FileSystemError({ method: "read", cause: new Error(marker) }))
              })
            : original.readJson(file),
      })
    }),
  ).pipe(Layer.provide(AppNodeBuilder.build(FSUtil.node)))
  for (const value of ["fake-system", null] as const) {
    const system: RelaySecretStore.SystemSecrets = {
      get: async () => value,
      set: async () => {},
      delete: async () => true,
    }
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* RelaySecretStore.Service
        return yield* Effect.exit(store.get(ref))
      }).pipe(Effect.provide(layerFor(tmp.path, system, filesystem))),
    )
    if (value) {
      expect(exit).toEqual(Exit.succeed(value))
      expect(reads).toBe(0)
    } else {
      unavailable(exit)
      expect(reads).toBe(1)
    }
  }
})

const authLayer = (data: string, system: RelaySecretStore.SystemSecrets) => {
  admit(process.env.OPENCODE_TEST_ROOT!, { global: { data } })
  return AppNodeBuilder.build(RelayAuth.node, [
    [Global.node, Global.layerWith({ data })],
    [RelaySecretStore.node, layerFor(data, system)],
  ])
}

function unavailable(exit: Exit.Exit<unknown, unknown>) {
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isSuccess(exit)) throw new Error("expected typed unavailable error")
  expect(Cause.hasDies(exit.cause)).toBe(false)
  expect(Cause.hasFails(exit.cause)).toBe(true)
  expect(Cause.pretty(exit.cause)).not.toContain(marker)
  expect(Cause.pretty(exit.cause)).not.toContain("relay-secrets.json")
}

const corrupt = [
  "{",
  JSON.stringify({ [ref]: { secret: marker } }),
  JSON.stringify({ [ref]: [marker] }),
  JSON.stringify({ [ref]: 123 }),
  JSON.stringify({ [ref]: null }),
  JSON.stringify([marker]),
  "null",
]
for (const [index, text] of corrupt.entries()) {
  for (const operation of ["get", "put", "remove"] as const) {
    test(`S01/S02: ${operation} rejects corrupt shape ${index} without leaking or replacing bytes`, async () => {
      await using tmp = await tmpdir()
      const file = path.join(tmp.path, "relay-secrets.json")
      await fs.writeFile(file, text)
      const exit = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* RelaySecretStore.Service
          return yield* Effect.exit(operation === "put" ? store.put(ref, "fake-new") : store[operation](ref))
        }).pipe(Effect.provide(layerFor(tmp.path))),
      )
      unavailable(exit)
      expect(await fs.readFile(file, "utf8")).toBe(text)
    })
  }
}

for (const systemState of ["value", "missing", "not-found", "empty", "failed", "absent"] as const) {
  for (const fileState of ["value", "missing", "no-ref", "empty", "corrupt"] as const) {
    test(`S17: system=${systemState}, file=${fileState} preserves three-state lookup`, async () => {
      await using tmp = await tmpdir()
      const file = path.join(tmp.path, "relay-secrets.json")
      if (fileState !== "missing")
        await fs.writeFile(
          file,
          JSON.stringify(
            fileState === "value"
              ? { [ref]: "fake-file" }
              : fileState === "empty"
                ? { [ref]: "" }
                : fileState === "corrupt"
                  ? { [ref]: { secret: marker } }
                  : {},
          ),
        )
      const before = await fs.readFile(file, "utf8").catch(() => undefined)
      const system: RelaySecretStore.SystemSecrets = {
        get: async () => {
          if (systemState === "failed") throw new Error(marker)
          if (systemState === "not-found") throw Object.assign(new Error(marker), { code: "NotFound" })
          return systemState === "value" ? "fake-system" : systemState === "empty" ? "" : null
        },
        set: async () => {
          throw new Error("unexpected write")
        },
        delete: async () => {
          throw new Error("unexpected delete")
        },
      }
      const exit = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* RelaySecretStore.Service
          return yield* Effect.exit(store.get(ref))
        }).pipe(Effect.provide(layerFor(tmp.path, systemState === "absent" ? undefined : system))),
      )
      if (systemState === "value") expect(exit).toEqual(Exit.succeed("fake-system"))
      else if (fileState === "value") expect(exit).toEqual(Exit.succeed("fake-file"))
      else if (fileState === "corrupt" || fileState === "empty" || systemState === "failed" || systemState === "empty")
        unavailable(exit)
      else expect(exit).toEqual(Exit.succeed(undefined))
      expect(await fs.readFile(file, "utf8").catch(() => undefined)).toBe(before)
    })
  }
}

test("S03/S17: real Auth maps a running store failure to SECRET_STORE_UNAVAILABLE", async () => {
  await using tmp = await tmpdir()
  let fail = false
  const values = new Map<string, string>()
  const system: RelaySecretStore.SystemSecrets = {
    get: async ({ name }) => {
      if (fail) throw new Error(marker)
      return values.get(name) ?? null
    },
    set: async ({ name, value }) => {
      values.set(name, value)
    },
    delete: async ({ name }) => values.delete(name),
  }
  await Effect.runPromise(
    Effect.gen(function* () {
      const auth = yield* RelayAuth.Service
      const id = Relay.VendorID.make("boundaries")
      yield* auth.setVendor({
        id,
        name: "Boundaries",
        baseURL: "https://boundary.invalid/v1",
        key: "fake-original",
        revision: 0,
      })
      fail = true
      const exit = yield* Effect.exit(auth.resolve(id))
      unavailable(exit)
      if (Exit.isFailure(exit)) {
        const error = Cause.findFail(exit.cause)
        expect(error._tag === "Success" && error.success.error.info.code).toBe("SECRET_STORE_UNAVAILABLE")
      }
    }).pipe(Effect.provide(authLayer(tmp.path, system))),
  )
})

for (const ending of ["resolve", "reject", "write-reject"] as const) {
  test(`S05/S06: cancellation drains dispatched system set (${ending}) before retiring its ref`, async () => {
    await using tmp = await tmpdir()
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const events: string[] = []
    const values = new Map<string, string>()
    let hold = false
    const system: RelaySecretStore.SystemSecrets = {
      get: async ({ name }) => values.get(name) ?? null,
      set: async ({ name, value }) => {
        if (!hold) {
          values.set(name, value)
          return
        }
        events.push("dispatched")
        started.resolve()
        await release.promise
        if (ending !== "reject") values.set(name, value)
        events.push("settled")
        if (ending !== "resolve") throw new Error(marker)
      },
      delete: async ({ name }) => {
        events.push("delete")
        return values.delete(name)
      },
    }
    await Effect.runPromise(
      Effect.gen(function* () {
        const auth = yield* RelayAuth.Service
        const id = Relay.VendorID.make("cancel-boundary")
        const initial = yield* auth.setVendor({
          id,
          name: "Original",
          baseURL: "https://boundary.invalid/v1",
          key: "fake-original",
          revision: 0,
        })
        hold = true
        const fiber = yield* Effect.forkChild(auth.setVendor({ id, key: "fake-late", revision: initial.revision }))
        yield* Effect.promise(() => started.promise)
        fiber.interruptUnsafe()
        // Observe cancellation completion while the adapter's write barrier stays closed.
        // Timeout bounds observation only; it neither cancels set nor releases its lease.
        const cancelled = yield* Fiber.await(fiber).pipe(Effect.timeoutOption("100 millis"))
        const journal = yield* Effect.promise(() =>
          fs.readFile(path.join(tmp.path, "relay-auth-preparing.json"), "utf8").catch(() => undefined),
        )
        const early = [...events]
        release.resolve()
        const exit = yield* Fiber.await(fiber)
        expect(cancelled._tag).toBe("None")
        expect(early).not.toContain("delete")
        expect(journal).toBeDefined()
        expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
        expect(events.indexOf("delete")).toBeGreaterThan(events.indexOf("settled"))
        expect([...values.values()]).toEqual(["fake-original"])
        expect((yield* auth.get()).revision).toBe(initial.revision)
        expect((yield* auth.resolve(id)).key).toBe("fake-original")
        expect(yield* Effect.promise(() => fs.readdir(tmp.path))).not.toContain("relay-auth-preparing.json")
      }).pipe(Effect.provide(authLayer(tmp.path, system)), Effect.ensuring(Effect.sync(() => release.resolve()))),
    )
  })
}

for (const mode of ["sync-throw", "reject", "write-reject", "success"] as const) {
  test(`S06/S07: interrupt delivered by the adapter at settlement (${mode}) cannot start fallback or commit`, async () => {
    await using tmp = await tmpdir()
    let current: Fiber.Fiber<unknown, unknown> | undefined
    let cancel = false
    const values = new Map<string, string>()
    const system: RelaySecretStore.SystemSecrets = {
      get: async ({ name }) => values.get(name) ?? null,
      set: ({ name, value }) => {
        if (!cancel) {
          values.set(name, value)
          return Promise.resolve()
        }
        current!.interruptUnsafe()
        if (mode === "sync-throw") throw new Error(marker)
        if (mode !== "reject") values.set(name, value)
        return mode === "success" ? Promise.resolve() : Promise.reject(new Error(marker))
      },
      delete: async ({ name }) => values.delete(name),
    }
    await Effect.runPromise(
      Effect.gen(function* () {
        const auth = yield* RelayAuth.Service
        const id = Relay.VendorID.make("settlement")
        const before = yield* auth.setVendor({
          id,
          name: "Settlement",
          baseURL: "https://boundary.invalid/v1",
          key: "fake-original",
          revision: 0,
        })
        cancel = true
        const saving = yield* Effect.forkChild(
          Effect.withFiber((fiber) => {
            current = fiber
            return auth.setVendor({ id, key: "fake-cancelled", revision: before.revision })
          }),
        )
        const exit = yield* Fiber.await(saving)
        expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
        expect((yield* auth.get()).revision).toBe(before.revision)
        expect([...values.values()]).toEqual(["fake-original"])
        expect(yield* Effect.promise(() => fs.readdir(tmp.path))).not.toContain("relay-secrets.json")
      }).pipe(Effect.provide(authLayer(tmp.path, system))),
    )
  })
}
