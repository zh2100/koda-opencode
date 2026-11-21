import { spawn } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { describe, expect, test } from "bun:test"
import { Cause, Effect, Fiber } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { ResourceRoot } from "@opencode-ai/core/resource-root"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { Flock } from "@opencode-ai/core/util/flock"
import { LockIdentity } from "@opencode-ai/core/util/lock-identity"
import { LockProtocol } from "@opencode-ai/core/util/lock-protocol"
import { NativeFileLock } from "@opencode-ai/core/util/native-file-lock"

const rootId = "11111111-1111-4111-8111-111111111111"

function isolated() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-lease-"))
  const home = path.join(root, "home")
  const selected = {
    data: path.join(root, "data"),
    config: path.join(root, "config"),
    state: path.join(root, "state"),
    cache: path.join(root, "cache"),
  }
  const registration: LockProtocol.Registration = {
    schemaVersion: 1,
    rootId,
    ...selected,
    generation: "os-lock-v1",
    requireManifest: true,
    epoch: 1,
  }
  ResourceRoot.remember(home, registration)
  fs.mkdirSync(selected.state, { recursive: true })
  fs.writeFileSync(
    LockIdentity.marker(selected.state),
    JSON.stringify({
      schemaVersion: 1,
      generation: "os-lock-v1",
      status: "complete",
      backend: "native-file-v1",
      keyFormat: "canonical-path-v1",
      rootId,
      epoch: 1,
    }),
  )
  const context = ResourceRoot.select(selected, home).context
  const decision = LockProtocol.resolve("relay-auth", context)
  fs.mkdirSync(decision.directory, { recursive: true })
  return {
    root,
    context,
    layer: AppNodeBuilder.build(EffectFlock.node, [
      [Global.node, Global.layerWith(Global.make({ home, ...selected, lockContext: context }))],
    ]),
    remove() {
      try {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 })
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "EBUSY") throw error
      }
    },
  }
}

function hold(root: string, context: LockProtocol.Context, key: string) {
  const ready = path.join(root, "holder-ready")
  const release = path.join(root, "holder-release")
  const input = path.join(root, "holder.json")
  fs.writeFileSync(input, JSON.stringify({ key, context, ready, release }))
  const child = spawn(process.execPath, [path.join(import.meta.dir, "../fixture/native-lock-gate-worker.ts"), input], {
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stderr = ""
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk)
  })
  return {
    ready,
    async unlock() {
      fs.writeFileSync(release, "1")
      const stop = Date.now() + 5_000
      while (child.exitCode === null && Date.now() < stop) await Bun.sleep(20)
      if (child.exitCode !== 0) throw new Error(`holder exited ${child.exitCode}: ${stderr}`)
    },
    async stop() {
      if (child.exitCode === null) child.kill()
      const stop = Date.now() + 2_000
      while (child.exitCode === null && Date.now() < stop) await Bun.sleep(20)
    },
  }
}

async function waitUntil(check: () => boolean) {
  const stop = Date.now() + 3_000
  while (!check() && Date.now() < stop) await Bun.sleep(20)
  expect(check()).toBe(true)
}

describe("native lease lifecycle", () => {
  test("RA-02 the common Flock.effect wrapper cancels a native waiter without releasing its owner", async () => {
    const env = isolated()
    const held = await Flock.acquire("relay-auth", { context: env.context })
    let ready!: () => void
    const waiting = new Promise<void>((resolve) => {
      ready = resolve
    })
    const fiber = Effect.runFork(
      Effect.scoped(
        Flock.effect("relay-auth", {
          context: env.context,
          timeoutMs: 3_000,
          baseDelayMs: 10,
          maxDelayMs: 20,
          onWait: () => ready(),
        }),
      ),
    )
    try {
      try {
        await waiting
        await Fiber.interrupt(fiber).pipe(Effect.timeout("1 second"), Effect.runPromise)
        const exit = await Effect.runPromise(Fiber.await(fiber))
        expect(exit._tag).toBe("Failure")
        if (exit._tag === "Failure") expect(Cause.hasInterrupts(exit.cause)).toBe(true)
        await expect(
          Flock.acquire("relay-auth", { context: env.context, timeoutMs: 50, baseDelayMs: 10 }),
        ).rejects.toThrow("Timed out")
      } finally {
        await Effect.runPromise(Fiber.interrupt(fiber))
        await held.release()
      }
      const next = await Flock.acquire("relay-auth", { context: env.context, timeoutMs: 500 })
      await next.release()
    } finally {
      env.remove()
    }
  })

  test("RA-02 the common native wrapper releases both scoped and late leases", async () => {
    const env = isolated()
    try {
      await Effect.scoped(
        Effect.gen(function* () {
          yield* Flock.effect("relay-auth", { context: env.context })
          const rival = NativeFileLock.tryAcquire(LockProtocol.file(LockProtocol.resolve("relay-auth", env.context)))
          if (rival.status === "acquired") rival.release()
          expect(rival.status).toBe("busy")
        }),
      ).pipe(Effect.runPromise)
      for (let index = 0; index < 8; index++) {
        const fiber = Effect.runFork(Effect.scoped(Flock.effect("relay-auth", { context: env.context })))
        await Effect.runPromise(Fiber.interrupt(fiber))
        const next = await Flock.acquire("relay-auth", { context: env.context, timeoutMs: 500 })
        await next.release()
      }
    } finally {
      env.remove()
    }
  })

  test("NL-T01 cancelling a waiting Effect native lock keeps the original holder", async () => {
    const env = isolated()
    const holder = hold(env.root, env.context, "relay-auth")
    try {
      await waitUntil(() => fs.existsSync(holder.ready))
      const exit = await Effect.gen(function* () {
        const flock = yield* EffectFlock.Service
        const waiting = yield* flock.acquire("relay-auth").pipe(Effect.forkChild)
        yield* Effect.sleep(80)
        yield* Fiber.interrupt(waiting)
        return yield* Fiber.await(waiting)
      }).pipe(Effect.provide(env.layer), Effect.scoped, Effect.timeout("3 seconds"), Effect.runPromise)
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(Cause.hasInterrupts(exit.cause)).toBe(true)
      const busy = NativeFileLock.tryAcquire(LockProtocol.file(LockProtocol.resolve("relay-auth", env.context)))
      expect(busy.status).toBe("busy")
    } finally {
      await holder.stop()
      env.remove()
    }
  })

  test("NL-T02 a cancelled Effect waiter does not keep the native lease", async () => {
    const env = isolated()
    const holder = hold(env.root, env.context, "relay-auth")
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
        yield* Fiber.interrupt(waiting)
        return yield* Fiber.await(waiting)
      }).pipe(Effect.provide(env.layer), Effect.scoped, Effect.runPromise)
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(Cause.hasInterrupts(exit.cause)).toBe(true)
      expect(entered).toBe(false)
      await holder.unlock()
      const again = await Flock.acquire("relay-auth", { context: env.context, timeoutMs: 1_000 })
      await again.release()
    } finally {
      await holder.stop()
      env.remove()
    }
  })

  test("NL-T04 repeated native diagnosis does not leave a probe lease", async () => {
    const env = isolated()
    try {
      const reasons = await Effect.gen(function* () {
        const flock = yield* EffectFlock.Service
        const first = yield* flock.diagnose("relay-auth")
        const second = yield* flock.diagnose("relay-auth")
        return [first.reason, second.reason]
      }).pipe(Effect.provide(env.layer), Effect.runPromise)
      expect(reasons).toEqual(["absent", "absent"])
      const again = await Flock.acquire("relay-auth", { context: env.context, timeoutMs: 500 })
      await again.release()
    } finally {
      env.remove()
    }
  })

  test("NL-T06 diagnosis reports another process as a live owner", async () => {
    const env = isolated()
    const holder = hold(env.root, env.context, "relay-auth")
    try {
      await waitUntil(() => fs.existsSync(holder.ready))
      const reason = await Effect.gen(function* () {
        const flock = yield* EffectFlock.Service
        return yield* flock.diagnose("relay-auth")
      }).pipe(Effect.provide(env.layer), Effect.runPromise)
      expect(reason.reason).toBe("live-owner")
      await holder.unlock()
    } finally {
      await holder.stop()
      env.remove()
    }
  })

  test("NL-T07 and NL-T08 a probed native lease lasts until the caller scope closes", async () => {
    const env = isolated()
    try {
      const held = await Effect.gen(function* () {
        const flock = yield* EffectFlock.Service
        const probed = yield* flock.probe("relay-auth")
        const rival = NativeFileLock.tryAcquire(LockProtocol.file(LockProtocol.resolve("relay-auth", env.context)))
        if (rival.status === "acquired") rival.release()
        return { status: probed.status, rival: rival.status }
      }).pipe(Effect.provide(env.layer), Effect.scoped, Effect.runPromise)
      expect(held).toEqual({ status: "acquired", rival: "busy" })
      const after = NativeFileLock.tryAcquire(LockProtocol.file(LockProtocol.resolve("relay-auth", env.context)))
      expect(after.status).toBe("acquired")
      if (after.status === "acquired") after.release()
    } finally {
      env.remove()
    }
  })

  test("NL-T09 success failure and cancellation all release the native lease", async () => {
    const env = isolated()
    try {
      await Effect.gen(function* () {
        const flock = yield* EffectFlock.Service
        yield* flock.withLock(Effect.void, "relay-auth")
        yield* flock.withLock(Effect.fail(new Error("business")), "relay-auth").pipe(Effect.ignore)
        const fiber = yield* flock.withLock(Effect.never, "relay-auth").pipe(Effect.forkChild)
        yield* Effect.sleep(40)
        yield* Fiber.interrupt(fiber)
      }).pipe(Effect.provide(env.layer), Effect.scoped, Effect.runPromise)
      const again = await Flock.acquire("relay-auth", { context: env.context, timeoutMs: 500 })
      await again.release()
    } finally {
      env.remove()
    }
  })

  test("NL-T10 a failed native release stays visible", async () => {
    const pending = Promise.resolve({
      release: async () => {
        throw new Error("native release failed")
      },
    })
    const bridge = NativeFileLock.handoff(pending, () => undefined)
    bridge.cancel()
    await expect(bridge.late((lease) => lease.release())).rejects.toThrow(/native release failed/)
  })

  test("NL-T03 handoff releases a lease that arrives after cancellation", async () => {
    let releaseCalls = 0
    let resumed = false
    const pending = new Promise<{ release: () => Promise<void> }>((resolve) => {
      setTimeout(
        () =>
          resolve({
            release: async () => {
              releaseCalls += 1
            },
          }),
        30,
      )
    })
    const bridge = NativeFileLock.handoff(pending, () => {
      resumed = true
    })
    bridge.cancel()
    const late = await bridge.late((lease) => lease.release())
    expect(resumed).toBe(false)
    expect(late).toBeUndefined()
    expect(releaseCalls).toBe(1)
  })
})
