import fs from "fs/promises"
import { symlinkSync } from "fs"
import path from "path"
import { describe, expect, spyOn, test } from "bun:test"
import { Effect, Fiber, ManagedRuntime, Option } from "effect"
import { Flock } from "@opencode-ai/core/util/flock"
import { spawnSync } from "child_process"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { LockIdentity } from "@opencode-ai/core/util/lock-identity"
import { Global } from "@opencode-ai/core/global"
import { Hash } from "@opencode-ai/core/util/hash"
import { Npm } from "@opencode-ai/core/npm"
import { tmpdir } from "./fixture/tmpdir"

const win = process.platform === "win32"

const writePackage = (dir: string, pkg: Record<string, unknown>) =>
  Bun.write(
    path.join(dir, "package.json"),
    JSON.stringify({
      version: "1.0.0",
      ...pkg,
    }),
  )

async function enabledState(dir: string) {
  const state = path.join(dir, "state")
  await fs.mkdir(state, { recursive: true })
  await fs.writeFile(LockIdentity.marker(state), JSON.stringify({ generation: LockIdentity.generation }))
  return state
}

const npmLayer = (cache: string, state: string) =>
  AppNodeBuilder.build(Npm.node, [[Global.node, Global.layerWith({ cache, state })]])

describe("Npm.sanitize", () => {
  test("keeps normal scoped package specs unchanged", () => {
    expect(Npm.sanitize("@opencode/acme")).toBe("@opencode/acme")
    expect(Npm.sanitize("@opencode/acme@1.0.0")).toBe("@opencode/acme@1.0.0")
    expect(Npm.sanitize("prettier")).toBe("prettier")
  })

  test("handles git https specs", () => {
    const spec = "acme@git+https://github.com/opencode/acme.git"
    const expected = win ? "acme@git+https_//github.com/opencode/acme.git" : spec
    expect(Npm.sanitize(spec)).toBe(expected)
  })
})

describe("Npm.add", () => {
  test("reifies when package cache directory exists without the package installed", async () => {
    await using tmp = await tmpdir()
    await fs.mkdir(path.join(tmp.path, "fixture-provider"))
    await writePackage(path.join(tmp.path, "fixture-provider"), {
      name: "fixture-provider",
      main: "index.js",
    })
    await Bun.write(path.join(tmp.path, "fixture-provider", "index.js"), "export const fixture = true\n")

    const spec = `fixture-provider@file:${path.join(tmp.path, "fixture-provider")}`
    const cache = path.join(tmp.path, "cache")
    await fs.mkdir(path.join(cache, "packages", Npm.sanitize(spec)), { recursive: true })
    const state = await enabledState(cache)

    const entry = await Effect.gen(function* () {
      const npm = yield* Npm.Service
      return yield* npm.add(spec)
    }).pipe(Effect.scoped, Effect.provide(npmLayer(cache, state)), Effect.runPromise)

    expect(entry.entrypoint).toBeDefined()
  })
})

describe("Npm.install", () => {
  for (const fails of [false, true]) {
    test(`cancellation retains the actual reify lock until ${fails ? "rejection" : "completion"}`, async () => {
      await using tmp = await tmpdir()
      const state = await enabledState(tmp.path)
      const cache = path.join(tmp.path, "cache")
      const context = Global.make({ cache, state }).lockContext
      const ready = Promise.withResolvers<void>()
      const finish = Promise.withResolvers<void>()
      const blocked = Promise.withResolvers<void>()
      const { Arborist } = await import("@npmcli/arborist")
      const reify = spyOn(Arborist.prototype, "reify").mockImplementation(async function (
        this: InstanceType<typeof Arborist>,
      ) {
        ready.resolve()
        await finish.promise
        if (fails) throw new Error("controlled reify failure")
        return this.loadActual()
      })
      const runtime = ManagedRuntime.make(npmLayer(cache, state))
      const fiber = runtime.runFork(Npm.Service.use((npm) => npm.install(tmp.path)))
      let interrupted: Promise<unknown> | undefined
      let contender: Promise<Flock.Lease> | undefined
      let released = false
      try {
        await ready.promise
        interrupted = Effect.runPromise(Fiber.interrupt(fiber))
        contender = Flock.acquire(`npm-install:${tmp.path}`, {
          context,
          onWait: () => blocked.resolve(),
          timeoutMs: 5000,
          baseDelayMs: 10,
          maxDelayMs: 30,
        })
        await blocked.promise
        expect(reify).toHaveBeenCalledTimes(1)
        finish.resolve()
        const lease = await contender
        await lease.release()
        released = true
        await interrupted
      } finally {
        finish.resolve()
        await interrupted
        try {
          if (contender && !released) await contender.then((lease) => lease.release())
          await runtime.dispose()
        } finally {
          reify.mockRestore()
        }
      }
    })
  }

  test("respects omit from project .npmrc", async () => {
    await using tmp = await tmpdir()

    await writePackage(tmp.path, {
      name: "fixture",
      dependencies: {
        "prod-pkg": "file:./prod-pkg",
      },
      devDependencies: {
        "dev-pkg": "file:./dev-pkg",
      },
    })
    await Bun.write(path.join(tmp.path, ".npmrc"), "omit=dev\n")
    await fs.mkdir(path.join(tmp.path, "prod-pkg"))
    await fs.mkdir(path.join(tmp.path, "dev-pkg"))
    await writePackage(path.join(tmp.path, "prod-pkg"), { name: "prod-pkg" })
    await writePackage(path.join(tmp.path, "dev-pkg"), { name: "dev-pkg" })

    const state = await enabledState(tmp.path)
    await Effect.gen(function* () {
      const npm = yield* Npm.Service
      yield* npm.install(tmp.path)
    }).pipe(Effect.scoped, Effect.provide(npmLayer(path.join(tmp.path, "cache"), state)), Effect.runPromise)

    await expect(fs.stat(path.join(tmp.path, "node_modules", "prod-pkg"))).resolves.toBeDefined()
    await expect(fs.stat(path.join(tmp.path, "node_modules", "dev-pkg"))).rejects.toThrow()
  })

  test("case and junction aliases share the npm install lock", async () => {
    await using tmp = await tmpdir()
    const data = path.join(tmp.path, "Data")
    await fs.mkdir(data)
    await writePackage(data, { name: "alias-target" })
    const link = path.join(tmp.path, "junction-data")
    if (win) {
      const linked = spawnSync("cmd", ["/c", "mklink", "/J", link, data], { encoding: "utf8" })
      expect(linked.status).toBe(0)
    } else symlinkSync(data, link, "dir")
    const state = await enabledState(tmp.path)
    const layer = LayerNode.compile(LayerNode.group([Npm.node, EffectFlock.node]), [
      [Global.node, Global.layerWith({ cache: path.join(tmp.path, "cache"), state })],
    ])
    const alias = win ? data.toUpperCase() : link
    const locks = path.join(state, "locks")
    const runtime = ManagedRuntime.make(layer)
    const held = await runtime.runPromise(
      Effect.gen(function* () {
        const npm = yield* Npm.Service
        const flock = yield* EffectFlock.Service
        const original = yield* flock.key(`npm-install:${data}`)
        const aliased = yield* flock.key(`npm-install:${alias}`)
        yield* flock.acquire(`npm-install:${data}`, locks)
        const busy = yield* npm.install(alias).pipe(Effect.timeoutOption("400 millis"))
        const names = yield* Effect.promise(() => fs.readdir(locks))
        const started = yield* Effect.promise(() =>
          fs.stat(path.join(alias, "node_modules")).then(
            () => true,
            () => false,
          ),
        )
        return { original, aliased, busy, names, started }
      }).pipe(Effect.scoped),
    )
    await runtime.dispose()

    expect(held.original).toBe(held.aliased)
    expect(Option.isNone(held.busy)).toBe(true)
    expect(held.started).toBe(false)
    expect(held.names).toContain(`${Hash.fast(held.original)}.lock`)
    expect(held.names).not.toContain(`${Hash.fast(`npm-install:${alias}`)}.lock`)
  })
})
