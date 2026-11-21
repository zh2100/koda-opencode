import { spawn } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { describe, expect, test } from "bun:test"
import { Effect, Fiber } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { ResourceRoot } from "@opencode-ai/core/resource-root"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { Flock } from "@opencode-ai/core/util/flock"
import { Hash } from "@opencode-ai/core/util/hash"
import { LockIdentity } from "@opencode-ai/core/util/lock-identity"
import { LockProtocol } from "@opencode-ai/core/util/lock-protocol"

const rootId = "11111111-1111-4111-8111-111111111111"

function paths(root: string) {
  return {
    data: path.join(root, "data"),
    config: path.join(root, "config"),
    state: path.join(root, "state"),
    cache: path.join(root, "cache"),
  }
}

function write(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value))
}

function nativeRoot(root: string) {
  const selected = paths(root)
  const registration: LockProtocol.Registration = {
    schemaVersion: 1,
    rootId,
    ...selected,
    generation: "os-lock-v1",
    requireManifest: true,
    epoch: 1,
  }
  ResourceRoot.remember(path.join(root, "home"), registration)
  write(LockIdentity.marker(selected.state), {
    schemaVersion: 1,
    generation: "os-lock-v1",
    status: "complete",
    backend: "native-file-v1",
    keyFormat: "canonical-path-v1",
    rootId,
    epoch: 1,
  })
  return ResourceRoot.select(selected, path.join(root, "home")).context
}

async function waitUntil(check: () => boolean) {
  const stop = Date.now() + 3_000
  while (!check() && Date.now() < stop) await Bun.sleep(20)
  expect(check()).toBe(true)
}

function holdNative(root: string, context: LockProtocol.Context, key: string) {
  const ready = path.join(root, "holder-ready")
  const release = path.join(root, "holder-release")
  const input = path.join(root, "holder.json")
  fs.writeFileSync(input, JSON.stringify({ key, context, ready, release }))
  const child = spawn(process.execPath, [path.join(import.meta.dir, "fixture/native-lock-gate-worker.ts"), input], {
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stderr = ""
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk)
  })
  return {
    ready,
    unlock: async () => {
      fs.writeFileSync(release, "1")
      const stop = Date.now() + 5_000
      while (child.exitCode === null && Date.now() < stop) await Bun.sleep(20)
      if (child.exitCode !== 0) throw new Error(`native holder exited ${child.exitCode}: ${stderr}`)
    },
    stop: async () => {
      if (child.exitCode === null) child.kill()
      const stop = Date.now() + 2_000
      while (child.exitCode === null && Date.now() < stop) await Bun.sleep(20)
    },
  }
}

describe("protocol recheck after waiting", () => {
  test("a waiting Promise directory lock refuses a marker that became migrating", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "recheck-promise-dir-"))
    const selected = paths(root)
    const key = "relay-auth"
    const held = await Flock.acquire(key, { context: selected })
    let entered = false
    let failure: unknown
    const waiting = Flock.withLock(
      key,
      async () => {
        entered = true
      },
      { context: selected, timeoutMs: 5_000, baseDelayMs: 20, maxDelayMs: 40 },
    ).catch((error) => {
      failure = error
    })
    await waitUntil(() => fs.existsSync(path.join(selected.state, "locks", `${Hash.fast(key)}.lock`)))
    write(LockIdentity.marker(selected.state), { generation: "path-identity-v1", status: "migrating" })
    await held.release()
    await waiting
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toMatch(/migration|protocol/)
    expect(entered).toBe(false)
    fs.rmSync(LockIdentity.marker(selected.state), { force: true })
    const again = await Flock.acquire(key, { context: selected, timeoutMs: 500 })
    await again.release()
    fs.rmSync(root, { recursive: true, force: true })
  })

  test("a waiting Effect directory lock refuses a marker that became migrating", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "recheck-effect-dir-"))
    const selected = paths(root)
    const global = Global.make({ ...selected, lockContext: selected })
    const layer = AppNodeBuilder.build(EffectFlock.node, [[Global.node, Global.layerWith(global)]])
    const key = "relay-auth"
    let entered = false
    const exit = await Effect.gen(function* () {
      const flock = yield* EffectFlock.Service
      yield* flock.acquire(key)
      const waiting = yield* flock
        .withLock(
          Effect.sync(() => {
            entered = true
          }),
          key,
        )
        .pipe(Effect.forkChild)
      yield* Effect.promise(() =>
        waitUntil(() => fs.existsSync(path.join(selected.state, "locks", `${Hash.fast(key)}.lock`))),
      )
      write(LockIdentity.marker(selected.state), { generation: "path-identity-v1", status: "migrating" })
      return yield* Fiber.await(waiting)
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise)
    expect(exit._tag).toBe("Failure")
    expect(entered).toBe(false)
    fs.rmSync(LockIdentity.marker(selected.state), { force: true })
    await Effect.gen(function* () {
      const flock = yield* EffectFlock.Service
      yield* flock.acquire(key)
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.timeout(500), Effect.runPromise)
    fs.rmSync(root, { recursive: true, force: true })
  })

  test("a waiting Promise native lock refuses a marker that became migrating", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "recheck-promise-native-"))
    const context = nativeRoot(root)
    const key = "relay-auth"
    const holder = holdNative(root, context, key)
    try {
      await waitUntil(() => fs.existsSync(holder.ready))
      let entered = false
      let failure: unknown
      const waiting = Flock.withLock(
        key,
        async () => {
          entered = true
        },
        { context, timeoutMs: 5_000, baseDelayMs: 20, maxDelayMs: 40 },
      ).catch((error) => {
        failure = error
      })
      await Bun.sleep(80)
      write(LockIdentity.marker(context.state), { generation: "os-lock-v1", status: "migrating" })
      await holder.unlock()
      await waiting
      expect(failure).toBeInstanceOf(Error)
      expect((failure as Error).message).toMatch(/migration|protocol/)
      expect(entered).toBe(false)
      write(LockIdentity.marker(context.state), {
        schemaVersion: 1,
        generation: "os-lock-v1",
        status: "complete",
        backend: "native-file-v1",
        keyFormat: "canonical-path-v1",
        rootId,
        epoch: 1,
      })
      const again = await Flock.acquire(key, { context, timeoutMs: 500 })
      await again.release()
    } finally {
      await holder.stop()
      try {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "EBUSY") throw error
      }
    }
  })

  test("a waiting Effect native lock refuses a marker that became migrating", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "recheck-effect-native-"))
    const context = nativeRoot(root)
    const holder = holdNative(root, context, "relay-auth")
    const global = Global.make({ ...context, lockContext: context })
    const layer = AppNodeBuilder.build(EffectFlock.node, [[Global.node, Global.layerWith(global)]])
    let entered = false
    try {
      await waitUntil(() => fs.existsSync(holder.ready))
      const exit = await Effect.gen(function* () {
        const flock = yield* EffectFlock.Service
        const waiting = yield* flock
          .withLock(
            Effect.sync(() => {
              entered = true
            }),
            "relay-auth",
          )
          .pipe(Effect.forkChild)
        yield* Effect.sleep(80)
        write(LockIdentity.marker(context.state), { generation: "os-lock-v1", status: "migrating" })
        yield* Effect.promise(async () => {
          await holder.unlock()
        })
        return yield* Fiber.await(waiting)
      }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise)
      expect(exit._tag).toBe("Failure")
      expect(String(exit)).toMatch(/migration|protocol/)
      expect(entered).toBe(false)
      write(LockIdentity.marker(context.state), {
        schemaVersion: 1,
        generation: "os-lock-v1",
        status: "complete",
        backend: "native-file-v1",
        keyFormat: "canonical-path-v1",
        rootId,
        epoch: 1,
      })
      const again = await Effect.gen(function* () {
        const flock = yield* EffectFlock.Service
        yield* flock.acquire("relay-auth")
      }).pipe(Effect.provide(layer), Effect.scoped, Effect.timeout("3 seconds"), Effect.runPromiseExit)
      expect(again._tag).toBe("Success")
    } finally {
      await holder.stop()
      try {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "EBUSY") throw error
      }
    }
  })
})
