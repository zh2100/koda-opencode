import { spawnSync } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { ImageGenerationSettings } from "@opencode-ai/core/image-generation-settings"
import { ResourceRoot } from "@opencode-ai/core/resource-root"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { Flock } from "@opencode-ai/core/util/flock"
import { LockIdentity } from "@opencode-ai/core/util/lock-identity"
import { LockProtocol } from "@opencode-ai/core/util/lock-protocol"
import { NativeFileLock } from "@opencode-ai/core/util/native-file-lock"

const rootId = "11111111-1111-4111-8111-111111111111"

function directoryAlias(link: string, target: string) {
  if (process.platform === "win32") {
    const result = spawnSync("cmd", ["/c", "mklink", "/J", link, target], { encoding: "utf8" })
    if (result.status !== 0) throw new Error(result.stderr || result.stdout || "junction failed")
    return
  }
  fs.symlinkSync(target, link, "dir")
}

describe("resource path resolution", () => {
  test("a service without explicit paths uses OPENCODE_CONFIG_DIR", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "config-dir-"))
    const custom = path.join(root, "Custom Config")
    const previous = process.env.OPENCODE_CONFIG_DIR
    process.env.OPENCODE_CONFIG_DIR = custom
    fs.mkdirSync(custom, { recursive: true })
    fs.writeFileSync(path.join(custom, "opencode.json"), JSON.stringify({ model: "custom/model" }))
    try {
      const made = Global.make()
      expect(made.config).toBe(custom)
      const layer = AppNodeBuilder.build(ImageGenerationSettings.node, [[Global.node, Global.layerWith({})]])
      const saved = await Effect.gen(function* () {
        const settings = yield* ImageGenerationSettings.Service
        return yield* settings.update({ enabled: true, model: "local/image", api: "openai-images" })
      }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise)
      expect(saved.enabled).toBe(true)
      expect(fs.existsSync(path.join(custom, "opencode.json"))).toBe(true)
      expect(fs.existsSync(path.join(Global.Path.config, "opencode.json"))).toBe(false)
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR
      else process.env.OPENCODE_CONFIG_DIR = previous
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("an independent flock follows XDG_STATE_HOME and stops on a migrating marker", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "xdg-state-"))
    const home = path.join(root, "home")
    const stateHome = path.join(root, "xdg-state")
    const state = path.join(stateHome, "opencode")
    fs.mkdirSync(state, { recursive: true })
    fs.writeFileSync(
      LockIdentity.marker(state),
      JSON.stringify({ generation: "path-identity-v1", status: "migrating" }),
    )
    const script = path.join(import.meta.dir, "independent-flock.ts")
    fs.writeFileSync(
      script,
      [
        "import { Flock } from '@opencode-ai/core/util/flock'",
        "let entered = false",
        "try {",
        "  await Flock.withLock('relay-auth', async () => { entered = true })",
        "  console.log(entered ? 'entered' : 'completed')",
        "} catch (error) {",
        "  console.log(entered ? 'entered' : String(error))",
        "}",
      ].join("\n"),
    )
    const ran = spawnSync(process.execPath, [script], {
      cwd: path.join(import.meta.dir, ".."),
      encoding: "utf8",
      env: { ...process.env, OPENCODE_TEST_HOME: home, XDG_STATE_HOME: stateHome },
    })
    expect(ran.status, ran.stderr).toBe(0)
    expect(ran.stdout).toContain("migration in progress")
    expect(ran.stdout).not.toContain("entered")
    expect(fs.existsSync(path.join(home, ".local", "state", "opencode", "locks"))).toBe(false)
    fs.rmSync(script, { force: true })
    fs.rmSync(root, { recursive: true, force: true })
  })

  test("native protocol accepts case and junction aliases of an inventoried file", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-alias-"))
    const data = path.join(root, "Data")
    const config = path.join(root, "config")
    const state = path.join(root, "state")
    const cache = path.join(root, "cache")
    fs.mkdirSync(data, { recursive: true })
    fs.mkdirSync(state, { recursive: true })
    const file = path.join(data, "config.json")
    fs.writeFileSync(file, "{}")
    const link = path.join(root, "junction-data")
    directoryAlias(link, data)
    const registration: LockProtocol.Registration = {
      schemaVersion: 1,
      rootId,
      data,
      config,
      state,
      cache,
      generation: "os-lock-v1",
      requireManifest: true,
      epoch: 1,
    }
    fs.writeFileSync(
      LockIdentity.marker(state),
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
    const context = LockProtocol.registered(registration, LockProtocol.readMarker(state)!)
    const direct = LockProtocol.resolve(`image-generation-settings:${file}`, context)
    const alias = LockProtocol.resolve(`image-generation-settings:${path.join(link, "config.json")}`, context)
    const cased = LockProtocol.resolve(
      `image-generation-settings:${process.platform === "win32" ? file.toUpperCase() : file}`,
      context,
    )
    expect(direct.domain).not.toBe("external")
    expect(alias.domain).toBe(direct.domain)
    expect(alias.key).toBe(direct.key)
    expect(cased.key).toBe(direct.key)
    fs.rmSync(root, { recursive: true, force: true })
  })

  test("a bundled module next to the executable loads without the source layout", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-bundle-"))
    const bundle = path.join(root, "dist")
    const built = await Bun.build({
      entrypoints: [path.join(import.meta.dir, "../src/util/native-file-lock.ts")],
      outdir: bundle,
      format: "esm",
      target: "node",
    })
    expect(built.success).toBe(true)
    const artifact = NativeFileLock.artifactName
    fs.copyFileSync(path.join(NativeFileLock.packagedDir(), artifact), path.join(bundle, artifact))
    const entry = path.join(bundle, "entry.mjs")
    fs.writeFileSync(
      entry,
      [
        "import { load } from './native-file-lock.js'",
        "delete process.env.OPENCODE_NATIVE_LOCK_DIR",
        "const held = load().tryAcquire(process.argv[2])",
        "if (held.status !== 'acquired') process.exit(2)",
        "process.stdout.write(held.release())",
      ].join("\n"),
    )
    const ran = spawnSync(process.execPath, [entry, path.join(root, "resource.lock")], {
      encoding: "utf8",
      env: { ...process.env, OPENCODE_NATIVE_LOCK_DIR: "" },
    })
    expect(ran.status, ran.stderr).toBe(0)
    expect(ran.stdout).toBe("released")
    fs.rmSync(root, { recursive: true, force: true })
  })

  test("a lease releases the binding captured at acquire after the module directory changes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-binding-"))
    const artifact = NativeFileLock.artifactName
    const source = path.join(NativeFileLock.packagedDir(), artifact)
    const moduleA = path.join(root, "module-a")
    const moduleB = path.join(root, "module-b")
    fs.mkdirSync(moduleA)
    fs.mkdirSync(moduleB)
    fs.copyFileSync(source, path.join(moduleA, artifact))
    fs.copyFileSync(source, path.join(moduleB, artifact))
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
      rootId,
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
        rootId,
        epoch: 1,
      }),
    )
    const selected = ResourceRoot.select(paths, home)
    const previous = process.env.OPENCODE_NATIVE_LOCK_DIR
    process.env.OPENCODE_NATIVE_LOCK_DIR = moduleA
    const lease = await Flock.acquire("relay-auth", { context: selected.context })
    process.env.OPENCODE_NATIVE_LOCK_DIR = moduleB
    const sibling = NativeFileLock.tryAcquire(path.join(root, "other.lock"))
    expect(sibling.status).toBe("acquired")
    await lease.release()
    const again = NativeFileLock.tryAcquire(path.join(root, "other.lock"))
    expect(again.status).toBe("busy")
    if (sibling.status === "acquired") sibling.release()
    process.env.OPENCODE_NATIVE_LOCK_DIR = moduleA
    const reacquired = NativeFileLock.tryAcquire(
      LockProtocol.file(LockProtocol.resolve("relay-auth", selected.context)),
    )
    expect(reacquired.status).toBe("acquired")
    if (reacquired.status === "acquired") reacquired.release()

    process.env.OPENCODE_NATIVE_LOCK_DIR = moduleA
    const global = Global.make({ home, ...selected.paths, lockContext: selected.context })
    const layer = AppNodeBuilder.build(EffectFlock.node, [[Global.node, Global.layerWith(global)]])
    const otherFile = path.join(root, "effect-other.lock")
    const captured: { lease: NativeFileLock.AcquireResult } = { lease: { status: "busy" } }
    await Effect.gen(function* () {
      const flock = yield* EffectFlock.Service
      yield* flock.acquire("relay-auth")
      process.env.OPENCODE_NATIVE_LOCK_DIR = moduleB
      captured.lease = NativeFileLock.tryAcquire(otherFile)
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise)
    const afterScope = NativeFileLock.tryAcquire(otherFile)
    expect(captured.lease.status).toBe("acquired")
    expect(afterScope.status).toBe("busy")
    if (captured.lease.status === "acquired") captured.lease.release()
    const after = NativeFileLock.tryAcquire(otherFile)
    expect(after.status).toBe("acquired")
    if (after.status === "acquired") after.release()
    if (previous === undefined) delete process.env.OPENCODE_NATIVE_LOCK_DIR
    else process.env.OPENCODE_NATIVE_LOCK_DIR = previous
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EPERM") throw error
    }
  })
})
