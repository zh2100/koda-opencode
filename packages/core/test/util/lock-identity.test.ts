import { spawnSync } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Fiber, Option } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { Flock } from "@opencode-ai/core/util/flock"
import { Global } from "@opencode-ai/core/global"
import { Hash } from "@opencode-ai/core/util/hash"
import { LockIdentity } from "@opencode-ai/core/util/lock-identity"
import { LockProtocol, LockProtocolError } from "@opencode-ai/core/util/lock-protocol"
import { tmpdir } from "../fixture/tmpdir"

const win = process.platform === "win32"

function directoryAlias(link: string, target: string) {
  if (process.platform === "win32") {
    const result = spawnSync("cmd", ["/c", "mklink", "/J", link, target], { encoding: "utf8" })
    if (result.status !== 0) throw new Error(result.stderr || result.stdout || "junction failed")
    return
  }
  fs.symlinkSync(target, link, "dir")
}

function enable(state: string) {
  fs.writeFileSync(LockIdentity.marker(state), JSON.stringify({ generation: LockIdentity.generation }))
}

function writeMarker(state: string, value: string) {
  fs.writeFileSync(LockIdentity.marker(state), value)
}

describe("lock identity", () => {
  test("keeps non-path identifiers and resolves existing and missing path suffixes", async () => {
    await using tmp = await tmpdir()
    const data = path.join(tmp.path, "Data")
    await fs.promises.mkdir(data)
    const link = path.join(tmp.path, "junction-data")
    directoryAlias(link, data)
    const missing = path.join(data, "missing", "config.json")
    const alias = path.join(link, "missing", "config.json")
    const deep = path.join(data, "first", "second", "file")
    const deepAlias = path.join(link, "first", "second", "file")

    expect(LockIdentity.key("scheduled-task:owner")).toBe("scheduled-task:owner")
    expect(LockIdentity.key("task:project")).toBe("task:project")
    expect(LockIdentity.same(`npm-install:${data}`, `npm-install:${link}`)).toBe(true)
    expect(LockIdentity.same(`mcp-auth:${missing}`, `mcp-auth:${alias}`)).toBe(true)
    expect(LockIdentity.same(`mcp-auth:${deep}`, `mcp-auth:${deepAlias}`)).toBe(true)
    expect(LockIdentity.pathIdentity(deep)).toBe(LockIdentity.pathIdentity(deepAlias))
    expect(LockIdentity.same(`mcp-source:${path.resolve(missing)}`, `mcp-source:${alias}`)).toBe(true)
    if (win) {
      expect(LockIdentity.same(`npm-install:${data}`, `npm-install:${data.toUpperCase()}`)).toBe(true)
    }
    expect(LockIdentity.key(`image-generation-settings:${data}`)).toBe(
      `image-generation-settings:${LockIdentity.pathIdentity(data)}`,
    )
  })

  test("a corrupt, unknown, or contradictory marker fails before a lock is created", () => {
    const state = fs.mkdtempSync(path.join(os.tmpdir(), "lock-identity-marker-"))
    const target = path.join(state, "file")
    const context = { state, data: state, config: state, cache: state }
    const cases = [
      "{",
      "[]",
      JSON.stringify({}),
      JSON.stringify({ generation: 1 }),
      JSON.stringify({ generation: "path-identity-v0" }),
      JSON.stringify({ generation: LockIdentity.generation, status: "legacy" }),
      JSON.stringify({ generation: LockIdentity.generation, status: "migrating" }),
      JSON.stringify({ status: "complete" }),
    ]
    for (const value of cases) {
      writeMarker(state, value)
      expect(() => LockProtocol.resolve(target, context)).toThrow(LockProtocolError)
    }
    for (const status of [123, true, null, { stage: "migrating" }]) {
      writeMarker(state, JSON.stringify({ generation: LockIdentity.generation, status }))
      expect(() => LockProtocol.resolve(target, context)).toThrow(LockProtocolError)
      expect(() => LockProtocol.resolve(target, context)).toThrow(/invalid type/)
    }
    writeMarker(state, JSON.stringify({ status: "migrating" }))
    expect(() => LockProtocol.resolve(target, context)).toThrow(/migration in progress blocks writes/)
    expect(fs.existsSync(path.join(state, "locks"))).toBe(false)
    fs.rmSync(state, { recursive: true, force: true })
  })

  test("EffectFlock and Flock use one identity for path aliases", async () => {
    await using tmp = await tmpdir()
    const data = path.join(tmp.path, "Data")
    const locks = path.join(tmp.path, "locks")
    await fs.promises.mkdir(data)
    const link = path.join(tmp.path, "junction-data")
    directoryAlias(link, data)
    enable(tmp.path)
    const source = path.join(data, "opencode.json")
    const alias = path.join(link, "opencode.json")
    await fs.promises.writeFile(source, "{}\n")
    Flock.setGlobal({ state: tmp.path, data, config: data, cache: tmp.path })

    const layer = AppNodeBuilder.build(EffectFlock.node, [
      [Global.node, Global.layerWith({ state: tmp.path, data, config: data, cache: tmp.path })],
    ])
    const held = await Effect.gen(function* () {
      const flock = yield* EffectFlock.Service
      return yield* Effect.scoped(
        Effect.gen(function* () {
          yield* flock.acquire(`npm-install:${data}`, locks)
          const busy = yield* flock.acquire(`npm-install:${link}`, locks).pipe(Effect.timeoutOption("300 millis"))
          return Option.isNone(busy)
        }),
      )
    }).pipe(Effect.provide(layer), Effect.runPromise)

    expect(held).toBe(true)
  })

  test("legacy Flock waits on the same identity as EffectFlock", async () => {
    await using tmp = await tmpdir()
    const data = path.join(tmp.path, "Data")
    const locks = path.join(tmp.path, "locks")
    await fs.promises.mkdir(data)
    const link = path.join(tmp.path, "junction-data")
    directoryAlias(link, data)
    enable(tmp.path)
    const source = path.join(data, "mcp-auth.json")
    await fs.promises.writeFile(source, "{}\n")
    Flock.setGlobal({ state: tmp.path, data, config: data, cache: tmp.path })
    const layer = AppNodeBuilder.build(EffectFlock.node, [[Global.node, Global.layerWith({ state: tmp.path })]])

    const held = Effect.gen(function* () {
      const flock = yield* EffectFlock.Service
      return yield* Effect.scoped(
        Effect.gen(function* () {
          yield* flock.acquire(`mcp-auth:${source}`, locks)
          yield* Effect.sleep("1 second")
        }),
      )
    }).pipe(Effect.provide(layer), Effect.runFork)

    await new Promise((resolve) => setTimeout(resolve, 150))
    const started = Date.now()
    const legacy = Flock.withLock(`mcp-auth:${path.join(link, "mcp-auth.json")}`, async () => {}, {
      dir: locks,
      timeoutMs: 300,
      staleMs: 60_000,
    })
    await expect(legacy).rejects.toThrow(/Timed out/)
    expect(Date.now() - started).toBeGreaterThan(200)
    await Effect.runPromise(Fiber.interrupt(held))
  })

  test("an identified old data root keeps the original hash and directory lock", async () => {
    await using tmp = await tmpdir()
    const data = path.join(tmp.path, "Data")
    const link = path.join(tmp.path, "junction-data")
    await fs.promises.mkdir(data)
    directoryAlias(link, data)
    // Hold the historical spelling through the link: even on POSIX its raw hash differs from the canonical hash.
    const raw = `npm-install:${link}`
    const alias = `npm-install:${data}${path.sep}.`
    const context = { state: tmp.path, data, config: data, cache: tmp.path }
    expect(LockProtocol.resolve(raw, context).key).toBe(raw)
    expect(LockProtocol.resolve(alias, context).key).toBe(alias)
    expect(LockProtocol.resolve(raw, context).key).not.toBe(LockIdentity.key(raw))
    expect(LockProtocol.resolve("scheduled-task:owner", context).key).toBe("scheduled-task:owner")

    const locks = path.join(tmp.path, "locks")
    Flock.setGlobal({ state: tmp.path, data, config: data, cache: tmp.path })
    const layer = AppNodeBuilder.build(EffectFlock.node, [[Global.node, Global.layerWith({ state: tmp.path })]])
    const held = await Effect.gen(function* () {
      const flock = yield* EffectFlock.Service
      return yield* Effect.scoped(
        Effect.gen(function* () {
          yield* flock.acquire(raw, locks)
          const busy = yield* flock.acquire(alias, locks).pipe(Effect.timeoutOption("200 millis"))
          const names = yield* Effect.promise(() => fs.promises.readdir(locks))
          return { busy: Option.isNone(busy), names }
        }),
      )
    }).pipe(Effect.provide(layer), Effect.runPromise)

    expect(held.busy).toBe(false)
    expect(held.names).toContain(`${Hash.fast(raw)}.lock`)
    expect(held.names).not.toContain(`${Hash.fast(LockIdentity.key(raw))}.lock`)
  })

  test("a blocked protocol does not acquire or fall back to the old hash", async () => {
    await using tmp = await tmpdir()
    const data = path.join(tmp.path, "Data")
    await fs.promises.mkdir(data)
    writeMarker(tmp.path, JSON.stringify({ status: "migrating" }))
    const layer = AppNodeBuilder.build(EffectFlock.node, [[Global.node, Global.layerWith({ state: tmp.path })]])
    const exit = await Effect.gen(function* () {
      const flock = yield* EffectFlock.Service
      return yield* flock.acquire(`npm-install:${data}`, path.join(tmp.path, "locks")).pipe(Effect.scoped, Effect.exit)
    }).pipe(Effect.provide(layer), Effect.runPromise)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("migration in progress blocks writes")
    await expect(fs.promises.stat(path.join(tmp.path, "locks"))).rejects.toThrow()
    expect(() =>
      LockProtocol.resolve(`npm-install:${data}`, { state: tmp.path, data, config: data, cache: tmp.path }),
    ).toThrow(/migration in progress/)
  })
})
