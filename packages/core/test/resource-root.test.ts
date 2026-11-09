import fs from "fs"
import os from "os"
import path from "path"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { ResourceRoot } from "@opencode-ai/core/resource-root"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { Flock } from "@opencode-ai/core/util/flock"
import { Hash } from "@opencode-ai/core/util/hash"
import { LockIdentity } from "@opencode-ai/core/util/lock-identity"
import { LockProtocol } from "@opencode-ai/core/util/lock-protocol"

const rootId = "11111111-1111-4111-8111-111111111111"

function paths(root: string): ResourceRoot.Paths {
  return {
    data: path.join(root, "data"),
    config: path.join(root, "config"),
    state: path.join(root, "state"),
    cache: path.join(root, "cache"),
  }
}

function registration(root: string, epoch = 1): LockProtocol.Registration {
  return {
    schemaVersion: 1,
    rootId,
    ...paths(root),
    generation: "os-lock-v1",
    requireManifest: true,
    epoch,
  }
}

function write(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value))
}

function complete(root: string, epoch = 1) {
  write(LockIdentity.marker(paths(root).state), {
    schemaVersion: 1,
    generation: "os-lock-v1",
    status: "complete",
    backend: "native-file-v1",
    keyFormat: "canonical-path-v1",
    rootId,
    epoch,
  })
}

describe("resource root startup validation", () => {
  test("an unregistered home keeps the fallback paths and does not load a native module", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "resource-root-"))
    const fallback = paths(path.join(root, "fallback"))
    const selected = ResourceRoot.select(fallback, path.join(root, "home"))
    expect(selected.adopted).toBe(false)
    expect(selected.paths).toEqual(fallback)
    expect(selected.context.registration).toBeUndefined()
    fs.rmSync(root, { recursive: true, force: true })
  })

  test("a registered root with a missing, empty, or migrating marker fails before creating resource directories", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "resource-root-"))
    const home = path.join(root, "home")
    const fallback = paths(path.join(root, "fallback"))
    const registered = registration(path.join(root, "registered"))
    ResourceRoot.remember(home, registered)
    expect(() => ResourceRoot.select(fallback, home)).toThrow(/missing its completed manifest/)
    for (const target of [fallback.data, fallback.config, fallback.state, fallback.cache, registered.data, registered.config]) {
      expect(fs.existsSync(target)).toBe(false)
    }

    write(LockIdentity.marker(registered.state), {})
    expect(() => ResourceRoot.select(fallback, home)).toThrow(/corrupt|unknown|contradictory|invalid/)
    write(LockIdentity.marker(registered.state), { generation: "os-lock-v1", status: "migrating" })
    expect(() => ResourceRoot.select(fallback, home)).toThrow(/migration in progress|complete/)
    write(LockIdentity.marker(registered.state), "{")
    expect(() => ResourceRoot.select(fallback, home)).toThrow(/corrupt/)
    fs.rmSync(LockIdentity.marker(registered.state))
    fs.mkdirSync(LockIdentity.marker(registered.state))
    expect(() => ResourceRoot.select(fallback, home)).toThrow(/corrupt|directory/)
    for (const target of [registered.data, registered.config, registered.cache, path.join(registered.data, "log"), path.join(registered.data, "repos"), path.join(registered.cache, "bin")]) {
      expect(fs.existsSync(target)).toBe(false)
    }
    fs.rmSync(root, { recursive: true, force: true })
  })

  test("a registered root whose root id or epoch disagrees with the marker fails at selection", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "resource-root-"))
    const home = path.join(root, "home")
    const registered = registration(path.join(root, "registered"))
    ResourceRoot.remember(home, registered)
    write(LockIdentity.marker(registered.state), {
      schemaVersion: 1,
      generation: "os-lock-v1",
      status: "complete",
      backend: "native-file-v1",
      keyFormat: "canonical-path-v1",
      rootId: "22222222-2222-4222-8222-222222222222",
      epoch: 1,
    })
    expect(() => ResourceRoot.select(paths(path.join(root, "fallback")), home)).toThrow(/does not match|missing its completed manifest/)
    complete(path.join(root, "registered"), 2)
    expect(() => ResourceRoot.select(paths(path.join(root, "fallback")), home)).toThrow(/does not match|epoch/)
    fs.rmSync(root, { recursive: true, force: true })
  })

  test("a completed selection rejects a later missing or replaced marker before creating a lock directory", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "resource-root-"))
    const home = path.join(root, "home")
    const registered = registration(path.join(root, "registered"))
    ResourceRoot.remember(home, registered)
    complete(path.join(root, "registered"))
    const selected = ResourceRoot.select(paths(path.join(root, "fallback")), home)
    expect(selected.adopted).toBe(true)
    expect(selected.context.registration?.rootId).toBe(rootId)
    fs.rmSync(LockIdentity.marker(registered.state))
    const locks = path.join(registered.state, "locks")
    await expect(Flock.acquire("relay-auth", { dir: locks, context: selected.context })).rejects.toThrow(/missing|changed|manifest/)
    expect(fs.existsSync(locks)).toBe(false)

    complete(path.join(root, "registered"))
    write(LockIdentity.marker(registered.state), { generation: "path-identity-v1", status: "complete" })
    await expect(Flock.acquire("relay-auth", { context: selected.context })).rejects.toThrow(/changed|does not match|manifest/)
    expect(fs.existsSync(path.join(registered.state, "locks"))).toBe(false)
    fs.rmSync(root, { recursive: true, force: true })
  })

  test("an Effect service built from the selected context refuses writes after the marker disappears", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "resource-root-"))
    const home = path.join(root, "home")
    const registered = registration(path.join(root, "registered"))
    ResourceRoot.remember(home, registered)
    complete(path.join(root, "registered"))
    const selected = ResourceRoot.select(paths(path.join(root, "fallback")), home)
    const global = Global.make({
      home,
      data: selected.paths.data,
      config: selected.paths.config,
      state: selected.paths.state,
      cache: selected.paths.cache,
      lockContext: selected.context,
    })
    const layer = AppNodeBuilder.build(EffectFlock.node, [[Global.node, Global.layerWith(global)]])
    fs.rmSync(LockIdentity.marker(registered.state))
    const exit = await Effect.gen(function* () {
      const flock = yield* EffectFlock.Service
      let ran = false
      const result = yield* flock
        .withLock(
          Effect.sync(() => {
            ran = true
          }),
          "relay-auth",
        )
        .pipe(Effect.exit)
      return { ran, failed: result._tag === "Failure" }
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise)
    expect(exit.ran).toBe(false)
    expect(exit.failed).toBe(true)
    expect(fs.existsSync(path.join(registered.state, "locks"))).toBe(false)
    expect(fs.existsSync(path.join(registered.data, "locks"))).toBe(false)
    fs.rmSync(root, { recursive: true, force: true })
  })

  test("a data-only override cannot inherit another root registration", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "resource-root-"))
    const registered = registration(path.join(root, "registered"))
    complete(path.join(root, "registered"))
    const selected = ResourceRoot.select(paths(path.join(root, "fallback")), path.join(root, "missing-home"))
    const other = path.join(root, "other-data")
    expect(() =>
      LockProtocol.resolve("relay-auth", {
        data: other,
        config: selected.context.config,
        state: selected.context.state,
        cache: selected.context.cache,
        registration: registered,
        snapshot: selected.context.snapshot!,
      }),
    ).toThrow(/does not match/)
    expect(selected.adopted).toBe(false)
    fs.rmSync(root, { recursive: true, force: true })
  })

  test("an unmarked historical directory lock still blocks the default entry", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "resource-root-"))
    const selected = paths(root)
    const key = `image-generation-settings:${selected.config}`
    const historical = path.join(selected.state, "locks")
    const held = await Flock.acquire(key, { dir: historical, context: selected })
    let entered = false
    const waiting = Flock.withLock(
      key,
      async () => {
        entered = true
      },
      { context: selected, timeoutMs: 2_000, baseDelayMs: 20, maxDelayMs: 40 },
    )
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(entered).toBe(false)
    expect(fs.existsSync(path.join(historical, `${Hash.fast(key)}.lock`))).toBe(true)
    await held.release()
    await waiting
    expect(entered).toBe(true)
    fs.rmSync(root, { recursive: true, force: true })
  })
})
