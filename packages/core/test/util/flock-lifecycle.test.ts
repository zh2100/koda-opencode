import { afterAll, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { Effect, Fiber } from "effect"
import { Flock } from "@opencode-ai/core/util/flock"
const base = fs.mkdtempSync(path.join(os.tmpdir(), "flock-lifecycle-"))
afterAll(() => fs.rmSync(base, { recursive: true, force: true }))
const environment = (name: string) => {
  const root = path.join(base, name)
  const context = {
    data: path.join(root, "data"),
    config: path.join(root, "config"),
    state: path.join(root, "state"),
    cache: path.join(root, "cache"),
  }
  return { root, context }
}
test("RA-01 a live paused directory owner must not be evicted by heartbeat age", async () => {
  const env = environment("live-owner")
  const child = Bun.spawn(
    [process.execPath, path.join(import.meta.dir, "../fixture/flock-paused-worker.ts"), env.root],
    { stdout: "pipe", stderr: "pipe" },
  )
  let second: Awaited<ReturnType<typeof Flock.acquire>> | undefined
  try {
    const line = await child.stdout.getReader().read()
    expect(new TextDecoder().decode(line.value)).toContain("HOLDING")
    await Bun.sleep(350)
    process.kill(child.pid, 0)
    let result: unknown
    try {
      second = await Flock.acquire("review-live", {
        context: env.context,
        staleMs: 150,
        timeoutMs: 250,
        baseDelayMs: 10,
        maxDelayMs: 20,
      })
      result = "acquired-while-owner-alive"
    } catch (error) {
      result = error instanceof Error ? error.message : String(error)
    }
    expect(String(result)).toContain("Timed out waiting for lock")
    expect(second).toBeUndefined()
  } finally {
    await second?.release()
    child.kill()
    await child.exited
  }
}, 6000)
test("RA-02 Flock.effect cancellation completes before the held directory lock is released", async () => {
  const env = environment("effect-cancel")
  const held = await Flock.acquire("review-cancel", { context: env.context })
  let signalReady: () => void = () => undefined
  const ready = new Promise<void>((resolve) => {
    signalReady = resolve
  })
  const waiter = Effect.runFork(
    Effect.scoped(
      Flock.effect("review-cancel", {
        context: env.context,
        timeoutMs: 3000,
        baseDelayMs: 10,
        maxDelayMs: 20,
        onWait: () => signalReady(),
      }),
    ),
  )
  await ready
  const interrupted = Effect.runPromise(Fiber.interrupt(waiter))
  let completed = false
  void interrupted.then(() => {
    completed = true
  })
  try {
    await Bun.sleep(1000)
    expect(completed).toBe(true)
    await expect(
      Flock.acquire("review-cancel", { context: env.context, timeoutMs: 50, baseDelayMs: 10 }),
    ).rejects.toThrow("Timed out")
  } finally {
    await held.release()
    await interrupted
  }
  const next = await Flock.acquire("review-cancel", { context: env.context, timeoutMs: 100 })
  await next.release()
}, 6000)

test("RA-C01 healthy directory ownership still excludes a contender", async () => {
  const env = environment("healthy")
  const held = await Flock.acquire("review-healthy", { context: env.context })
  let second: Awaited<ReturnType<typeof Flock.acquire>> | undefined
  try {
    try {
      second = await Flock.acquire("review-healthy", {
        context: env.context,
        timeoutMs: 100,
        baseDelayMs: 10,
        maxDelayMs: 20,
      })
    } catch {}
    expect(second).toBeUndefined()
  } finally {
    await second?.release()
    await held.release()
  }
})

test("RA-02 an acquired Effect lease stays owned until its scope closes", async () => {
  const env = environment("effect-owned")
  let entered!: () => void
  const ready = new Promise<void>((resolve) => {
    entered = resolve
  })
  const holder = Effect.runFork(
    Effect.scoped(
      Effect.gen(function* () {
        yield* Flock.effect("owned", { context: env.context })
        entered()
        yield* Effect.never
      }),
    ),
  )
  await ready
  try {
    await expect(Flock.acquire("owned", { context: env.context, timeoutMs: 50, baseDelayMs: 10 })).rejects.toThrow(
      "Timed out",
    )
  } finally {
    await Effect.runPromise(Fiber.interrupt(holder))
  }
  const next = await Flock.acquire("owned", { context: env.context, timeoutMs: 100 })
  await next.release()
})

test("RA-02 cancelling while acquisition finishes leaves no late directory lease", async () => {
  const env = environment("effect-late")
  for (let index = 0; index < 8; index++) {
    const waiter = Effect.runFork(Effect.scoped(Flock.effect("late", { context: env.context })))
    await Effect.runPromise(Fiber.interrupt(waiter))
    const next = await Flock.acquire("late", { context: env.context, timeoutMs: 500, baseDelayMs: 10 })
    await next.release()
  }
})
