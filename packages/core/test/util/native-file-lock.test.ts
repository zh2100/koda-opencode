import { spawn } from "child_process"
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
import { LockIdentity } from "@opencode-ai/core/util/lock-identity"
import { LockProtocol } from "@opencode-ai/core/util/lock-protocol"
import { NativeFileLock, NativeLockError } from "@opencode-ai/core/util/native-file-lock"

describe("native file lock", () => {
  test("does not load a module for an unmarked root and reports a missing artifact", () => {
    const previous = process.env.OPENCODE_NATIVE_LOCK_DIR
    delete process.env.OPENCODE_NATIVE_LOCK_DIR
    expect(() => NativeFileLock.load("/missing/native-lock-dir")).toThrow(NativeLockError)
    if (previous !== undefined) process.env.OPENCODE_NATIVE_LOCK_DIR = previous
    expect(() => NativeFileLock.load(import.meta.dir)).toThrow(/native lock module is missing/)
  })

  test("business locks from two processes share one native lease", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-lock-"))
    const home = path.join(root, "home")
    const registered = path.join(root, "registered")
    const paths = {
      data: path.join(registered, "data"),
      config: path.join(registered, "config"),
      state: path.join(registered, "state"),
      cache: path.join(registered, "cache"),
    }
    const registration: LockProtocol.Registration = {
      schemaVersion: 1,
      rootId: "11111111-1111-4111-8111-111111111111",
      ...paths,
      generation: "os-lock-v1",
      requireManifest: true,
      epoch: 1,
    }
    ResourceRoot.remember(home, registration)
    fs.mkdirSync(paths.state, { recursive: true })
    fs.writeFileSync(
      LockIdentity.marker(paths.state),
      JSON.stringify({
        schemaVersion: 1,
        generation: "os-lock-v1",
        status: "complete",
        backend: "native-file-v1",
        keyFormat: "canonical-path-v1",
        rootId: registration.rootId,
        epoch: 1,
      }),
    )
    const selected = ResourceRoot.select(paths, home)
    const hold = async (name: string) => {
      const active = path.join(root, `${name}-active`)
      const done = path.join(root, `${name}-done`)
      const input = path.join(root, `${name}-input.json`)
      fs.writeFileSync(
        input,
        JSON.stringify({
          key: "relay-auth",
          context: selected.context,
          holdMs: 700,
          ready: path.join(root, `${name}-ready`),
          active,
          done,
        }),
      )
      const child = spawn(process.execPath, [path.join(import.meta.dir, "../fixture/native-lock-worker.ts"), input], {
        stdio: ["ignore", "pipe", "pipe"],
      })
      let stderr = ""
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk)
      })
      for (let attempt = 0; attempt < 50 && !fs.existsSync(active) && child.exitCode === null; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      if (!fs.existsSync(active)) {
        child.kill()
        throw new Error(`native holder did not enter: code=${child.exitCode} stderr=${stderr}`)
      }
      return { active, done, child, stderr: () => stderr }
    }
    const promiseHolder = await hold("promise")
    const overlap = await Flock.withLock(
      "relay-auth",
      async () => fs.existsSync(promiseHolder.active),
      { context: selected.context, timeoutMs: 10_000, baseDelayMs: 20, maxDelayMs: 80 },
    )
    for (let attempt = 0; attempt < 100 && promiseHolder.child.exitCode === null; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const promiseCode = promiseHolder.child.exitCode ?? 1
    expect(promiseCode).toBe(0)
    expect(promiseHolder.stderr()).toBe("")
    expect(overlap).toBe(false)
    expect(fs.readFileSync(promiseHolder.done, "utf8").trim()).toBe("1")

    const effectHolder = await hold("effect")
    const global = Global.make({ home, ...selected.paths, lockContext: selected.context })
    const layer = AppNodeBuilder.build(EffectFlock.node, [[Global.node, Global.layerWith(global)]])
    const effectOverlap = await Effect.gen(function* () {
      const flock = yield* EffectFlock.Service
      return yield* flock.withLock(
        Effect.sync(() => fs.existsSync(effectHolder.active)),
        "relay-auth",
      )
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise)
    for (let attempt = 0; attempt < 100 && effectHolder.child.exitCode === null; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const effectCode = effectHolder.child.exitCode ?? 1
    expect(effectCode).toBe(0)
    expect(effectHolder.stderr()).toBe("")
    expect(effectOverlap).toBe(false)
    expect(fs.readFileSync(effectHolder.done, "utf8").trim()).toBe("1")
    fs.rmSync(root, { recursive: true, force: true })
  })
})
