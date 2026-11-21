import { describe, expect } from "bun:test"
import { spawn } from "child_process"
import fs from "fs/promises"
import path from "path"
import os from "os"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { testEffect } from "../lib/effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { Global } from "@opencode-ai/core/global"
import { Hash } from "@opencode-ai/core/util/hash"

function lock(dir: string, key: string) {
  return path.join(dir, Hash.fast(key) + ".lock")
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

async function exists(file: string) {
  return fs
    .stat(file)
    .then(() => true)
    .catch(() => false)
}

async function readJson<T>(p: string): Promise<T> {
  return JSON.parse(await fs.readFile(p, "utf8"))
}

// ---------------------------------------------------------------------------
// Worker subprocess helpers
// ---------------------------------------------------------------------------

type Msg = {
  key: string
  dir: string
  holdMs?: number
  ready?: string
  active?: string
  done?: string
}

const root = path.join(import.meta.dir, "../..")
const worker = path.join(import.meta.dir, "../fixture/effect-flock-worker.ts")

function run(msg: Msg) {
  return new Promise<{ code: number; stdout: Buffer; stderr: Buffer }>((resolve) => {
    const proc = spawn(process.execPath, [worker, JSON.stringify(msg)], { cwd: root })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    proc.stdout?.on("data", (data) => stdout.push(Buffer.from(data)))
    proc.stderr?.on("data", (data) => stderr.push(Buffer.from(data)))
    proc.on("close", (code) => {
      resolve({ code: code ?? 1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) })
    })
  })
}

function spawnWorker(msg: Msg) {
  return spawn(process.execPath, [worker, JSON.stringify(msg)], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  })
}

async function stopWorker(proc: ReturnType<typeof spawnWorker>) {
  if (proc.exitCode !== null || proc.signalCode !== null) return

  const closed = new Promise<void>((resolve) => proc.once("close", () => resolve()))

  if (process.platform !== "win32" || !proc.pid) {
    proc.kill()
    await closed
    return
  }

  await new Promise<void>((resolve) => {
    const killProc = spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"])
    killProc.on("close", () => {
      proc.kill()
      resolve()
    })
  })
  await closed
}

async function waitForFile(file: string, timeout = 3_000) {
  const stop = Date.now() + timeout
  while (Date.now() < stop) {
    if (await exists(file)) return
    await sleep(20)
  }
  throw new Error(`Timed out waiting for file: ${file}`)
}

// ---------------------------------------------------------------------------
// Test layer
// ---------------------------------------------------------------------------

const testGlobal = Global.layerWith({
  home: os.homedir(),
  data: os.tmpdir(),
  cache: os.tmpdir(),
  config: os.tmpdir(),
  state: os.tmpdir(),
  bin: os.tmpdir(),
  log: os.tmpdir(),
})

const testLayer = AppNodeBuilder.build(EffectFlock.node, [[Global.node, testGlobal]])
const isolated = testEffect(Layer.empty)

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("util.effect-flock", () => {
  const it = testEffect(testLayer)

  it.live(
    "acquire and release via scoped Effect",
    Effect.gen(function* () {
      const flock = yield* EffectFlock.Service
      const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "eflock-test-")))
      const dir = path.join(tmp, "locks")
      const lockDir = lock(dir, "eflock:acquire")

      yield* Effect.scoped(flock.acquire("eflock:acquire", dir))

      expect(yield* Effect.promise(() => exists(lockDir))).toBe(false)
      yield* Effect.promise(() => fs.rm(tmp, { recursive: true, force: true }))
    }),
  )

  it.live(
    "withLock data-first",
    Effect.gen(function* () {
      const flock = yield* EffectFlock.Service
      const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "eflock-test-")))
      const dir = path.join(tmp, "locks")

      let hit = false
      yield* flock.withLock(
        Effect.sync(() => {
          hit = true
        }),
        "eflock:df",
        dir,
      )
      expect(hit).toBe(true)
      yield* Effect.promise(() => fs.rm(tmp, { recursive: true, force: true }))
    }),
  )

  it.live(
    "withLock pipeable",
    Effect.gen(function* () {
      const flock = yield* EffectFlock.Service
      const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "eflock-test-")))
      const dir = path.join(tmp, "locks")

      let hit = false
      yield* Effect.sync(() => {
        hit = true
      }).pipe(flock.withLock("eflock:pipe", dir))
      expect(hit).toBe(true)
      yield* Effect.promise(() => fs.rm(tmp, { recursive: true, force: true }))
    }),
  )

  it.live(
    "writes owner metadata",
    Effect.gen(function* () {
      const flock = yield* EffectFlock.Service
      const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "eflock-test-")))
      const dir = path.join(tmp, "locks")
      const key = "eflock:meta"
      const file = path.join(lock(dir, key), "meta.json")

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* flock.acquire(key, dir)
          const json = yield* Effect.promise(() =>
            readJson<{ token?: unknown; pid?: unknown; hostname?: unknown; createdAt?: unknown }>(file),
          )
          expect(typeof json.token).toBe("string")
          expect(typeof json.pid).toBe("number")
          expect(typeof json.hostname).toBe("string")
          expect(typeof json.createdAt).toBe("string")
        }),
      )
      yield* Effect.promise(() => fs.rm(tmp, { recursive: true, force: true }))
    }),
  )

  it.live(
    "breaks stale lock dirs",
    Effect.gen(function* () {
      const flock = yield* EffectFlock.Service
      const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "eflock-test-")))
      const dir = path.join(tmp, "locks")
      const key = "eflock:stale"
      const lockDir = lock(dir, key)

      yield* Effect.promise(async () => {
        await fs.mkdir(lockDir, { recursive: true })
        await fs.writeFile(
          path.join(lockDir, "meta.json"),
          JSON.stringify({
            token: "dead",
            pid: 2147483647,
            hostname: os.hostname(),
            createdAt: new Date().toISOString(),
          }),
        )
        const old = new Date(Date.now() - 120_000)
        await fs.utimes(lockDir, old, old)
      })

      let hit = false
      yield* flock.withLock(
        Effect.sync(() => {
          hit = true
        }),
        key,
        dir,
      )
      expect(hit).toBe(true)
      yield* Effect.promise(() => fs.rm(tmp, { recursive: true, force: true }))
    }),
  )

  isolated.live(
    "preserves an aged breaker instead of stealing a paused recovery",
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "eflock-test-")))
      const dir = path.join(tmp, "locks")
      const key = "eflock:stale-breaker"
      const lockDir = lock(dir, key)
      const breaker = lockDir + ".breaker"

      yield* Effect.promise(async () => {
        await fs.mkdir(lockDir, { recursive: true })
        await fs.mkdir(breaker)
        await fs.writeFile(
          path.join(lockDir, "meta.json"),
          JSON.stringify({
            token: "dead",
            pid: 2147483647,
            hostname: os.hostname(),
            createdAt: new Date().toISOString(),
          }),
        )
        const old = new Date(Date.now() - 120_000)
        await fs.utimes(lockDir, old, old)
        await fs.utimes(breaker, old, old)
      })

      const attempts = { count: 0 }
      const filesystem = Layer.effect(
        FSUtil.Service,
        Effect.gen(function* () {
          const service = yield* FSUtil.Service
          return FSUtil.Service.of({
            ...service,
            makeDirectory: (file, options) =>
              Effect.suspend(() => {
                // End the test at the second retry instead of waiting the production timeout.
                if (file === lockDir && ++attempts.count > 1) return Effect.die("retry observed")
                return service.makeDirectory(file, options)
              }),
          })
        }),
      ).pipe(Layer.provide(AppNodeBuilder.build(FSUtil.node)))
      const layer = EffectFlock.layer.pipe(Layer.provide(filesystem), Layer.provide(testGlobal))
      const result = yield* Effect.gen(function* () {
        const flock = yield* EffectFlock.Service
        return yield* flock.withLock(Effect.die("must not acquire"), key, dir)
      }).pipe(Effect.provide(layer), Effect.exit)
      expect(Exit.isFailure(result) ? Cause.pretty(result.cause) : "").toContain("retry observed")
      expect(yield* Effect.promise(() => exists(breaker))).toBe(true)
      expect(attempts.count).toBeLessThan(10)
      yield* Effect.promise(() => fs.rm(tmp, { recursive: true, force: true }))
    }),
  )

  isolated.live(
    "backs off while a breaker remains held",
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "eflock-breaker-rate-")))
      const dir = path.join(tmp, "locks")
      const key = "eflock:breaker-rate"
      const lockDir = lock(dir, key)
      const breaker = lockDir + ".breaker"
      yield* Effect.promise(async () => {
        await fs.mkdir(lockDir, { recursive: true })
        await fs.mkdir(breaker)
        await fs.writeFile(
          path.join(lockDir, "meta.json"),
          JSON.stringify({
            token: "dead",
            pid: 2147483647,
            hostname: os.hostname(),
            createdAt: new Date().toISOString(),
          }),
        )
      })
      const attempts = { count: 0 }
      const filesystem = Layer.effect(
        FSUtil.Service,
        Effect.gen(function* () {
          const service = yield* FSUtil.Service
          return FSUtil.Service.of({
            ...service,
            stat: (file) =>
              Effect.suspend(() => {
                if (file === lockDir || file === breaker) attempts.count += 1
                return service.stat(file)
              }),
          })
        }),
      ).pipe(Layer.provide(AppNodeBuilder.build(FSUtil.node)))
      const layer = EffectFlock.layer.pipe(Layer.provide(filesystem), Layer.provide(testGlobal))
      const outcome = yield* Effect.gen(function* () {
        const flock = yield* EffectFlock.Service
        const fiber = yield* flock.acquire(key, dir).pipe(Effect.forkChild)
        yield* Effect.sleep(250)
        const interrupted = yield* Fiber.interrupt(fiber).pipe(Effect.timeoutOption("2 seconds"))
        return { interrupted, attempts: attempts.count, locked: yield* flock.isLocked(key, dir) }
      }).pipe(Effect.provide(layer))
      expect(Option.isSome(outcome.interrupted)).toBe(true)
      expect(outcome.attempts).toBeLessThan(20)
      expect(outcome.locked).toBe(true)
      yield* Effect.promise(() => fs.rm(tmp, { recursive: true, force: true }))
    }),
  )

  it.live(
    "preserves a live owner despite backdated lock timestamps",
    Effect.gen(function* () {
      const flock = yield* EffectFlock.Service
      const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "eflock-live-")))
      const dir = path.join(tmp, "locks")
      const key = "eflock:paused-live"
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* flock.acquire(key, dir)
          yield* Effect.promise(async () => {
            const old = new Date(Date.now() - 120_000)
            for (const file of [
              lock(dir, key),
              path.join(lock(dir, key), "meta.json"),
              path.join(lock(dir, key), "heartbeat"),
            ]) {
              await fs.utimes(file, old, old)
            }
          })
          expect(yield* flock.isLocked(key, dir)).toBe(true)
        }),
      )
      expect(yield* flock.isLocked(key, dir)).toBe(false)
      yield* Effect.promise(() => fs.rm(tmp, { recursive: true, force: true }))
    }),
  )

  it.live(
    "detects compromise when lock dir removed",
    Effect.gen(function* () {
      const flock = yield* EffectFlock.Service
      const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "eflock-test-")))
      const dir = path.join(tmp, "locks")
      const key = "eflock:compromised"
      const lockDir = lock(dir, key)

      const result = yield* flock
        .withLock(
          Effect.promise(() => fs.rm(lockDir, { recursive: true, force: true })),
          key,
          dir,
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(result)).toBe(true)
      expect(Exit.isFailure(result) ? Cause.pretty(result.cause) : "").toContain("missing")
      yield* Effect.promise(() => fs.rm(tmp, { recursive: true, force: true }))
    }),
  )

  it.live(
    "diagnoses unknown ownership as still locked and reports a missing lock as absent",
    Effect.gen(function* () {
      const flock = yield* EffectFlock.Service
      const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "eflock-diagnose-")))
      const dir = path.join(tmp, "locks")
      const key = "eflock:diagnose"
      const lockDir = lock(dir, key)
      yield* Effect.promise(() => fs.mkdir(lockDir, { recursive: true }))
      expect((yield* flock.diagnose(key, dir)).reason).toBe("metadata-missing")
      expect(yield* flock.isLocked(key, dir)).toBe(true)
      yield* Effect.promise(() =>
        fs.writeFile(
          path.join(lockDir, "meta.json"),
          JSON.stringify({ token: "remote", pid: 1, hostname: "other-host", createdAt: new Date().toISOString() }),
        ),
      )
      expect((yield* flock.diagnose(key, dir)).reason).toBe("remote-owner")
      expect(yield* flock.isLocked(key, dir)).toBe(true)
      expect((yield* flock.diagnose("missing", dir)).reason).toBe("absent")
      expect(yield* flock.isLocked("missing", dir)).toBe(false)
      yield* Effect.promise(() => fs.rm(tmp, { recursive: true, force: true }))
    }),
  )

  isolated.live(
    "releases a failed publish once and leaves a successor lock in place",
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "eflock-successor-")))
      const dir = path.join(tmp, "locks")
      const key = "eflock:successor"
      const lockDir = lock(dir, key)
      const heartbeat = path.join(lockDir, "heartbeat")
      const meta = path.join(lockDir, "meta.json")
      const removed = yield* Deferred.make<void>()
      let removals = 0
      const filesystem = Layer.effect(
        FSUtil.Service,
        Effect.gen(function* () {
          const service = yield* FSUtil.Service
          return FSUtil.Service.of({
            ...service,
            writeFileString: (file, content, options) =>
              file === heartbeat
                ? service
                    .writeFileString(file, content, { ...options, flag: "wx" })
                    .pipe(Effect.andThen(service.writeFileString(file, content, { ...options, flag: "wx" })))
                : service.writeFileString(file, content, options),
            remove: (file, options) =>
              Effect.gen(function* () {
                if (file === lockDir) {
                  removals += 1
                  if (removals === 1) {
                    yield* Effect.promise(() => fs.mkdir(lockDir, { recursive: true }))
                    yield* Effect.promise(() =>
                      fs.writeFile(
                        meta,
                        JSON.stringify({
                          token: "successor",
                          pid: process.pid,
                          hostname: os.hostname(),
                          createdAt: new Date().toISOString(),
                        }),
                      ),
                    )
                    yield* Deferred.succeed(removed, undefined).pipe(Effect.ignore)
                    return
                  }
                }
                yield* service.remove(file, options).pipe(Effect.ignore)
              }),
          })
        }),
      ).pipe(Layer.provide(AppNodeBuilder.build(FSUtil.node)))
      const layer = EffectFlock.layer.pipe(Layer.provide(filesystem), Layer.provide(testGlobal))
      const outcome = yield* Effect.gen(function* () {
        const flock = yield* EffectFlock.Service
        const exit = yield* flock.acquire(key, dir).pipe(Effect.scoped, Effect.exit)
        yield* Deferred.await(removed)
        return { exit, diagnosis: yield* flock.diagnose(key, dir), removals }
      }).pipe(Effect.provide(layer))
      expect(Exit.isFailure(outcome.exit)).toBe(true)
      expect(outcome.removals).toBe(1)
      expect(outcome.diagnosis.reason).toBe("live-owner")
      yield* Effect.promise(() => fs.rm(tmp, { recursive: true, force: true }))
    }),
  )

  isolated.live(
    "keeps waiting inside the deadline after another process wins the race",
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "eflock-rerace-")))
      const dir = path.join(tmp, "locks")
      const key = "eflock:rerace"
      const lockDir = lock(dir, key)
      const releaseHolder = yield* Deferred.make<void>()
      let raced = false
      const filesystem = Layer.effect(
        FSUtil.Service,
        Effect.gen(function* () {
          const service = yield* FSUtil.Service
          return FSUtil.Service.of({
            ...service,
            makeDirectory: (file, options) =>
              file === lockDir && !raced
                ? Effect.gen(function* () {
                    raced = true
                    yield* Effect.promise(() => fs.mkdir(lockDir, { recursive: true }))
                    yield* Effect.promise(() =>
                      fs.writeFile(
                        path.join(lockDir, "meta.json"),
                        JSON.stringify({
                          token: "holder",
                          pid: process.pid,
                          hostname: os.hostname(),
                          createdAt: new Date().toISOString(),
                        }),
                      ),
                    )
                    yield* Effect.promise(() => fs.writeFile(path.join(lockDir, "heartbeat"), ""))
                    yield* Effect.forkChild(
                      Deferred.await(releaseHolder).pipe(
                        Effect.andThen(Effect.promise(() => fs.rm(lockDir, { recursive: true, force: true }))),
                      ),
                    )
                    return yield* service.makeDirectory(file, options)
                  })
                : service.makeDirectory(file, options),
          })
        }),
      ).pipe(Layer.provide(AppNodeBuilder.build(FSUtil.node)))
      const layer = EffectFlock.layer.pipe(Layer.provide(filesystem), Layer.provide(testGlobal))
      const elapsed = yield* Effect.gen(function* () {
        const flock = yield* EffectFlock.Service
        const started = Date.now()
        const fiber = yield* flock.acquire(key, dir).pipe(Effect.scoped, Effect.forkChild)
        yield* Effect.sleep(80)
        yield* Deferred.succeed(releaseHolder, undefined)
        const acquired = yield* Fiber.join(fiber).pipe(Effect.as(true), Effect.timeoutOption("2 seconds"))
        return { acquired, ms: Date.now() - started }
      }).pipe(Effect.provide(layer))
      expect(Option.isSome(elapsed.acquired)).toBe(true)
      expect(elapsed.ms).toBeGreaterThan(50)
      expect(elapsed.ms).toBeLessThan(2_000)
      yield* Effect.promise(() => fs.rm(tmp, { recursive: true, force: true }))
    }),
  )

  isolated.live(
    "cancels after the lock directory exists and before ownership is published",
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "eflock-cancel-created-")))
      const dir = path.join(tmp, "locks")
      const key = "eflock:cancel-created"
      const lockDir = lock(dir, key)
      const created = yield* Deferred.make<void>()
      let publish = false
      const filesystem = Layer.effect(
        FSUtil.Service,
        Effect.gen(function* () {
          const service = yield* FSUtil.Service
          return FSUtil.Service.of({
            ...service,
            makeDirectory: (file, options) =>
              service
                .makeDirectory(file, options)
                .pipe(
                  Effect.tap(() =>
                    file === lockDir ? Deferred.succeed(created, undefined).pipe(Effect.asVoid) : Effect.void,
                  ),
                ),
            writeFileString: (file, content, options) =>
              file === path.join(lockDir, "heartbeat") && !publish
                ? Effect.interrupt
                : service.writeFileString(file, content, options),
          })
        }),
      ).pipe(Layer.provide(AppNodeBuilder.build(FSUtil.node)))
      const layer = EffectFlock.layer.pipe(Layer.provide(filesystem), Layer.provide(testGlobal))
      const outcome = yield* Effect.gen(function* () {
        const flock = yield* EffectFlock.Service
        const fiber = yield* flock.acquire(key, dir).pipe(Effect.scoped, Effect.forkChild)
        yield* Deferred.await(created)
        const interrupted = yield* Fiber.interrupt(fiber).pipe(Effect.timeoutOption("2 seconds"))
        const diagnosis = yield* flock.diagnose(key, dir)
        const locked = yield* flock.isLocked(key, dir)
        publish = true
        const acquired = yield* flock
          .acquire(key, dir)
          .pipe(Effect.scoped, Effect.as(true), Effect.timeoutOption("2 seconds"))
        return { interrupted, diagnosis, locked, acquired }
      }).pipe(Effect.provide(layer))
      expect(Option.isSome(outcome.interrupted)).toBe(true)
      expect(outcome.diagnosis.reason).not.toBe("metadata-missing")
      expect(outcome.locked).toBe(false)
      expect(Option.isSome(outcome.acquired)).toBe(true)
      yield* Effect.promise(() => fs.rm(tmp, { recursive: true, force: true }))
    }),
  )

  it.live(
    "cancels while waiting and leaves no owned lock",
    Effect.gen(function* () {
      const flock = yield* EffectFlock.Service
      const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "eflock-cancel-")))
      const dir = path.join(tmp, "locks")
      const key = "eflock:cancel"
      const fiber = yield* flock.acquire(key, dir).pipe(Effect.scoped, Effect.forkChild)
      yield* Effect.sleep(20)
      yield* Fiber.interrupt(fiber)
      expect(yield* flock.isLocked(key, dir)).toBe(false)
      yield* Effect.promise(() => fs.rm(tmp, { recursive: true, force: true }))
    }),
  )

  it.live(
    "cancels a waiter while another owner holds the lock",
    Effect.gen(function* () {
      const flock = yield* EffectFlock.Service
      const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "eflock-cancel-held-")))
      const dir = path.join(tmp, "locks")
      const key = "eflock:cancel-held"
      const release = yield* Deferred.make<void>()
      const holder = yield* Effect.gen(function* () {
        yield* flock.acquire(key, dir)
        yield* Deferred.await(release)
      }).pipe(Effect.scoped, Effect.forkChild)
      yield* Effect.sleep(50)
      expect(yield* flock.isLocked(key, dir)).toBe(true)
      const waiter = yield* flock.acquire(key, dir).pipe(Effect.scoped, Effect.forkChild)
      yield* Effect.sleep(50)
      const interrupted = yield* Fiber.interrupt(waiter).pipe(Effect.timeoutOption("2 seconds"))
      expect(Option.isSome(interrupted)).toBe(true)
      expect(yield* flock.isLocked(key, dir)).toBe(true)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(holder)
      expect(yield* flock.isLocked(key, dir)).toBe(false)
      const next = yield* flock.acquire(key, dir).pipe(Effect.scoped, Effect.timeoutOption("2 seconds"))
      expect(Option.isSome(next)).toBe(true)
      yield* Effect.promise(() => fs.rm(tmp, { recursive: true, force: true }))
    }),
  )

  it.live(
    "detects token mismatch",
    Effect.gen(function* () {
      const flock = yield* EffectFlock.Service
      const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "eflock-test-")))
      const dir = path.join(tmp, "locks")
      const key = "eflock:token"
      const lockDir = lock(dir, key)
      const meta = path.join(lockDir, "meta.json")

      const result = yield* flock
        .withLock(
          Effect.promise(async () => {
            const json = await readJson<{ token?: string }>(meta)
            json.token = "tampered"
            await fs.writeFile(meta, JSON.stringify(json, null, 2))
          }),
          key,
          dir,
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(result)).toBe(true)
      expect(Exit.isFailure(result) ? Cause.pretty(result.cause) : "").toContain("token mismatch")
      expect(yield* Effect.promise(() => exists(lockDir))).toBe(true)
      yield* Effect.promise(() => fs.rm(tmp, { recursive: true, force: true }))
    }),
  )

  it.live(
    "fails on unwritable lock roots",
    Effect.gen(function* () {
      if (process.platform === "win32") return
      const flock = yield* EffectFlock.Service
      const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "eflock-test-")))
      const dir = path.join(tmp, "locks")

      yield* Effect.promise(async () => {
        await fs.mkdir(dir, { recursive: true })
        await fs.chmod(dir, 0o500)
      })

      const result = yield* flock.withLock(Effect.void, "eflock:perm", dir).pipe(Effect.exit)
      // oxlint-disable-next-line no-base-to-string -- Exit has a useful toString for test assertions
      expect(String(result)).toContain("PermissionDenied")
      yield* Effect.promise(() => fs.chmod(dir, 0o700).then(() => fs.rm(tmp, { recursive: true, force: true })))
    }),
  )

  it.live(
    "enforces mutual exclusion under process contention",
    () =>
      Effect.promise(async () => {
        const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "eflock-stress-"))
        const dir = path.join(tmp, "locks")
        const done = path.join(tmp, "done.log")
        const active = path.join(tmp, "active")
        const n = 16

        try {
          const out = await Promise.all(
            Array.from({ length: n }, () => run({ key: "eflock:stress", dir, done, active, holdMs: 30 })),
          )

          expect(out.map((x) => x.code)).toEqual(Array.from({ length: n }, () => 0))
          expect(out.map((x) => x.stderr.toString()).filter(Boolean)).toEqual([])

          const lines = (await fs.readFile(done, "utf8"))
            .split("\n")
            .map((x) => x.trim())
            .filter(Boolean)
          expect(lines.length).toBe(n)
        } finally {
          await fs.rm(tmp, { recursive: true, force: true })
        }
      }),
    60_000,
  )

  it.live(
    "recovers after a crashed lock owner",
    () =>
      Effect.promise(async () => {
        const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "eflock-crash-"))
        const dir = path.join(tmp, "locks")
        const ready = path.join(tmp, "ready")

        const proc = spawnWorker({ key: "eflock:crash", dir, ready, holdMs: 120_000 })

        try {
          await waitForFile(ready, 5_000)
          await stopWorker(proc)

          // Backdate lock files so they're past STALE_MS (60s)
          const lockDir = lock(dir, "eflock:crash")
          const old = new Date(Date.now() - 120_000)
          await fs.utimes(lockDir, old, old).catch(() => {})
          await fs.utimes(path.join(lockDir, "heartbeat"), old, old).catch(() => {})
          await fs.utimes(path.join(lockDir, "meta.json"), old, old).catch(() => {})

          const done = path.join(tmp, "done.log")
          const result = await run({ key: "eflock:crash", dir, done, holdMs: 10 })
          expect(result.code).toBe(0)
          expect(result.stderr.toString()).toBe("")
        } finally {
          await stopWorker(proc).catch(() => {})
          await fs.rm(tmp, { recursive: true, force: true })
        }
      }),
    30_000,
  )
})
