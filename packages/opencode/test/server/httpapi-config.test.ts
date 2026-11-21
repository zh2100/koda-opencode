import { afterAll, afterEach, beforeAll, describe, expect, spyOn } from "bun:test"
import { request } from "node:http"
import { AtomicDocument } from "@opencode-ai/core/config/atomic-document"
import { ProjectConfig } from "../../src/config/project-write"
import { InstanceWork } from "../../src/effect/instance-work"
import { Flock } from "@opencode-ai/core/util/flock"
import { ConfigDocument } from "@opencode-ai/core/config/document"
import { Config } from "../../src/config/config"
import fsPromises from "node:fs/promises"
import { windowsIdentity, windowsOps, posixOps, withConfigReadDenied } from "../fixture/config-read-permission"

import path from "path"
import { Server } from "../../src/server/server"
import { Effect, Fiber } from "effect"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { it } from "../lib/effect"
import { waitGlobalBusEvent } from "./global-bus"
import { Global } from "@opencode-ai/core/global"
import { AppRuntime } from "../../src/effect/app-runtime"
import { InstanceRef } from "../../src/effect/instance-ref"
import { InstanceRuntime } from "../../src/project/instance-runtime"
import type { ProjectV2 } from "@opencode-ai/core/project"
import { registerAdapter } from "../../src/control-plane/adapters"

import { installedPlugin } from "./installed-plugin"

// Config HTTP contracts must not depend on registry availability. Real installs
// still run, using cache or reporting an observed offline failure.
const previousOffline = process.env.npm_config_offline
const previousRetries = process.env.npm_config_fetch_retries
beforeAll(async () => {
  process.env.npm_config_offline = "true"
  process.env.npm_config_fetch_retries = "0"
  await installedPlugin(Global.Path.config)
})
afterAll(() => {
  if (previousOffline === undefined) delete process.env.npm_config_offline
  else process.env.npm_config_offline = previousOffline
  if (previousRetries === undefined) delete process.env.npm_config_fetch_retries
  else process.env.npm_config_fetch_retries = previousRetries
})

function app() {
  return Server.Default().app
}

function waitDisposed(directory: string) {
  return waitGlobalBusEvent({
    message: "timed out waiting for instance disposal",
    predicate: (event) => event.payload.type === "server.instance.disposed" && event.directory === directory,
  })
}

const tmpdirEffect = (options: Parameters<typeof tmpdir>[0]) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const tmp = await tmpdir(options)
      await installedPlugin(path.join(tmp.path, ".opencode"))
      return tmp
    }),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("config HttpApi", () => {
  for (const mode of ["file", "env", "missing", "invalid", "denied", "changed"] as const) {
    ;(mode === "denied" && process.platform !== "win32" && process.getuid?.() === 0 ? it.live.skip : it.live)(`F35 real TCP new reference ${mode}`, () => Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({ git: true, config: { username: "before", formatter: false, lsp: false } })
      const file = path.join(tmp.path, "opencode.json"), token = path.join(tmp.path, "reference.txt")
      const before = yield* Effect.promise(() => fsPromises.readFile(file, "utf8"))
      const privateValue = "PRIVATE-REFERENCE-CONTENT"
      yield* Effect.promise(() => fsPromises.writeFile(token, privateValue))
      const previous = process.env.PROJECT_HTTP_REF
      process.env.PROJECT_HTTP_REF = mode === "invalid" ? `${privateValue}"` : privateValue
      yield* Effect.addFinalizer(() => Effect.sync(() => { if (previous === undefined) delete process.env.PROJECT_HTTP_REF; else process.env.PROJECT_HTTP_REF = previous }))
      const off = ProjectConfig.observe(tmp.path, async (phase) => { if (mode === "changed" && phase === "validated") await fsPromises.writeFile(token, "PRIVATE-CHANGED") })
      yield* Effect.addFinalizer(() => Effect.sync(off))
      const listener = yield* Effect.acquireRelease(Effect.promise(() => Server.listen({ hostname: "127.0.0.1", port: 0 })), (server) => Effect.promise(() => server.stop(true)))
      const headers = { "content-type": "application/json", "x-opencode-directory": tmp.path }
      const reference = mode === "env" || mode === "invalid" ? "{env:PROJECT_HTTP_REF}" : mode === "missing" ? "{file:./missing.txt}" : "{file:./reference.txt}"
      const send = Effect.gen(function* () {
        const response = yield* Effect.promise(() => fetch(new URL("config", listener.url), { method: "PATCH", headers, body: JSON.stringify({ username: reference }) }))
        const body = yield* Effect.promise(() => response.text())
        const status = mode === "file" || mode === "env" ? 200 : mode === "denied" ? 503 : mode === "changed" ? 409 : 400
        expect(response.status).toBe(status)
        expect(body).not.toContain(privateValue)
        expect(body).not.toContain(tmp.path)
        if (status !== 200) expect(JSON.parse(body)).toMatchObject({ code: mode === "denied" ? "CONFIG_SOURCE_READ_FAILED" : mode === "changed" ? "CONFIG_SOURCE_CHANGED" : "CONFIG_DOCUMENT_INVALID", ref: expect.any(String) })
      })
      if (mode === "denied") yield* withConfigReadDenied({ file: token, document: privateValue, ops: process.platform === "win32" ? windowsOps(windowsIdentity()) : posixOps(), use: () => send })
      else yield* send
      yield* Effect.promise(() => InstanceWork.waitHandoffs())
      const written = yield* Effect.promise(() => fsPromises.readFile(file, "utf8"))
      expect(written).not.toContain("PRIVATE-")
      if (mode === "file" || mode === "env") {
        expect(written).toContain(reference)
        const current = yield* Effect.promise(() => fetch(new URL("config", listener.url), { headers }))
        expect(yield* Effect.promise(() => current.json())).toMatchObject({ username: privateValue })
        yield* Effect.promise(() => disposeAllInstances())
        const rebuilt = yield* Effect.promise(() => fetch(new URL("config", listener.url), { headers }))
        expect(yield* Effect.promise(() => rebuilt.json())).toMatchObject({ username: privateValue })
      } else expect(written).toBe(before)
    }), 120000)
  }

  for (const stage of ["prepare", "unknown"] as const) {
    it.live(`F19 TCP maps publication-entry ${stage} failure without retry`, () => Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({ git: true, config: { username: "before", formatter: false, lsp: false } })
      const file = path.join(tmp.path, "opencode.json"), before = yield* Effect.promise(() => fsPromises.readFile(file, "utf8"))
      const original = AtomicDocument.publish
      let calls = 0
      const spy = spyOn(AtomicDocument, "publish").mockImplementation((input) => {
        if (input.file !== file) return original(input)
        calls++
        return Promise.reject(new AtomicDocument.CommitError(stage, new Error("PRIVATE-PUBLISH-ERROR")))
      })
      yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()))
      const listener = yield* Effect.acquireRelease(Effect.promise(() => Server.listen({ hostname: "127.0.0.1", port: 0 })), (server) => Effect.promise(() => server.stop(true)))
      const response = yield* Effect.promise(() => fetch(new URL("config", listener.url), { method: "PATCH", headers: { "content-type": "application/json", "x-opencode-directory": tmp.path }, body: JSON.stringify({ username: "after" }) }))
      const body = yield* Effect.promise(() => response.text())
      expect(response.status).toBe(503)
      expect(JSON.parse(body)).toMatchObject({ code: stage === "unknown" ? "CONFIG_COMMIT_UNKNOWN" : "CONFIG_WRITE_FAILED", ref: expect.any(String) })
      expect(body).not.toContain("PRIVATE-")
      expect(calls).toBe(1)
      expect(yield* Effect.promise(() => fsPromises.readFile(file, "utf8"))).toBe(before)
    }), 120000)
  }

  it.live("F29 real TCP MCP and global reject legacy directory aliases", () => Effect.gen(function* () {
    const tmp = yield* tmpdirEffect({ git: true, config: { mcp: { sample: { type: "local", command: ["node", "kept.js"], enabled: false } } } })
    const alias = path.join(tmp.path, "alias"), file = path.join(tmp.path, "opencode.json")
    yield* Effect.promise(() => fsPromises.symlink(tmp.path, alias, process.platform === "win32" ? "junction" : "dir"))
    const listener = yield* Effect.acquireRelease(Effect.promise(() => Server.listen({ hostname: "127.0.0.1", port: 0 })), (server) => Effect.promise(() => server.stop(true)))
    const headers = { "content-type": "application/json", "x-opencode-directory": tmp.path }
    const read = yield* Effect.promise(() => fetch(new URL("config/mcp/sample", listener.url), { headers }))
    const source = yield* Effect.promise(() => read.json())
    const before = yield* Effect.promise(() => fsPromises.readFile(file, "utf8"))
    const mcp = yield* Effect.promise(() => fetch(new URL("config/mcp/sample", listener.url), { method: "PATCH", headers, body: JSON.stringify({ source: path.join(alias, "opencode.json"), version: source.version, patch: { command: ["bad"] } }) }))
    expect(mcp.status).toBe(409)
    expect(yield* Effect.promise(() => mcp.json())).toMatchObject({ code: "MCP_SOURCE_ALIAS_UNSUPPORTED", ref: expect.any(String) })
    expect(yield* Effect.promise(() => fsPromises.readFile(file, "utf8"))).toBe(before)
    const canonical = Global.Path.config
    yield* Effect.addFinalizer(() => Effect.sync(() => { Global.Path.config = canonical }))
    Global.Path.config = alias
    const global = yield* Effect.promise(() => fetch(new URL("global/config", listener.url), { method: "PATCH", headers, body: JSON.stringify({ username: "bad" }) }))
    Global.Path.config = canonical
    expect(global.status).toBe(409)
    expect(yield* Effect.promise(() => global.json())).toMatchObject({ code: "CONFIG_PATH_ALIAS_UNSUPPORTED", ref: expect.any(String) })
    expect(yield* Effect.promise(() => fsPromises.readFile(file, "utf8"))).toBe(before)
    expect(yield* Effect.promise(() => fsPromises.stat(path.join(tmp.path, "config.json")).then(() => true, () => false))).toBe(false)
  }), 120000)

  it.live("F21 TCP workspace selection updates B while directory header points to A", () => Effect.gen(function* () {
    const a = yield* tmpdirEffect({ git: true, config: { username: "A", formatter: false, lsp: false } })
    const b = yield* tmpdirEffect({ git: true, config: { username: "B", formatter: false, lsp: false } })
    const listener = yield* Effect.acquireRelease(Effect.promise(() => Server.listen({ hostname: "127.0.0.1", port: 0 })), (server) => Effect.promise(() => server.stop(true)))
    const headers = { "content-type": "application/json", "x-opencode-directory": a.path }
    const warm = yield* Effect.promise(() => fetch(new URL("config", listener.url), { headers }))
    expect(yield* Effect.promise(() => warm.json())).toMatchObject({ username: "A" })
    const projectResponse = yield* Effect.promise(() => fetch(new URL("project/current", listener.url), { headers }))
    const project: { id: ProjectV2.ID } = yield* Effect.promise(() => projectResponse.json())
    const type = "project-write-" + crypto.randomUUID()
    registerAdapter(project.id, type, { name: type, description: "isolated local target", configure: (info) => ({ ...info, directory: b.path }), create: async () => {}, remove: async () => {}, target: () => ({ type: "local", directory: b.path }) })
    const created = yield* Effect.promise(() => fetch(new URL("experimental/workspace", listener.url), { method: "POST", headers, body: JSON.stringify({ type, branch: null }) }))
    expect(created.status).toBe(200)
    const workspace: { id: string } = yield* Effect.promise(() => created.json())
    yield* Effect.addFinalizer(() => Effect.promise(async () => { const response = await fetch(new URL(`experimental/workspace/${workspace.id}`, listener.url), { method: "DELETE", headers }); await response.arrayBuffer() }))
    const ctx = yield* Effect.promise(() => InstanceRuntime.load({ directory: a.path }))
    const memory = yield* Effect.promise(() => AppRuntime.runPromise(Config.use.get().pipe(Effect.provideService(InstanceRef, ctx))))
    const before = yield* Effect.promise(() => fsPromises.readFile(path.join(a.path, "opencode.json"), "utf8"))
    const saved = yield* Effect.promise(() => fetch(new URL(`config?workspace=${workspace.id}`, listener.url), { method: "PATCH", headers, body: JSON.stringify({ username: "B-after" }) }))
    const savedBody = yield* Effect.promise(() => saved.text())
    expect(saved.status, savedBody).toBe(200)
    yield* Effect.promise(() => InstanceWork.waitHandoffs())
    expect(yield* Effect.promise(() => fsPromises.readFile(path.join(a.path, "opencode.json"), "utf8"))).toBe(before)
    expect(yield* Effect.promise(() => AppRuntime.runPromise(Config.use.get().pipe(Effect.provideService(InstanceRef, ctx))))).toBe(memory)
    expect(InstanceWork.owner(ctx).phase).toBe("accepting")
    expect(JSON.parse(yield* Effect.promise(() => fsPromises.readFile(path.join(b.path, "opencode.json"), "utf8"))).username).toBe("B-after")
    const next = yield* Effect.promise(() => fetch(new URL(`config?workspace=${workspace.id}`, listener.url), { headers }))
    expect(yield* Effect.promise(() => next.json())).toMatchObject({ username: "B-after" })
  }), 120000)

  for (const kind of ["invalid", "disabled", "alias", "outside", "denied"] as const) {
    ;(kind === "denied" && process.platform !== "win32" && process.getuid?.() === 0 ? it.live.skip : it.live)(`F25/F31 cold TCP preflight ${kind}`, () => Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({ git: true })
      const sibling = yield* tmpdirEffect({ git: true })
      const file = path.join(tmp.path, "opencode.json")
      const document = kind === "invalid" ? '{"username":"PRIVATE-COLD-TOKEN",' : '{"username":"PRIVATE-COLD-TOKEN"}'
      yield* Effect.promise(() => fsPromises.writeFile(file, document))
      if (kind === "alias" || kind === "outside") {
        const destination = kind === "outside" ? sibling.path : path.join(tmp.path, "physical-config")
        yield* Effect.promise(async () => {
          await fsPromises.rm(path.join(tmp.path, ".opencode"), { recursive: true, force: true })
          await fsPromises.mkdir(destination, { recursive: true })
          await fsPromises.writeFile(path.join(destination, "opencode.jsonc"), "{}")
          await fsPromises.symlink(destination, path.join(tmp.path, ".opencode"), process.platform === "win32" ? "junction" : "dir")
        })
      }
      const old = process.env.OPENCODE_DISABLE_PROJECT_CONFIG
      if (kind === "disabled") process.env.OPENCODE_DISABLE_PROJECT_CONFIG = "true"
      yield* Effect.addFinalizer(() => Effect.sync(() => { if (old === undefined) delete process.env.OPENCODE_DISABLE_PROJECT_CONFIG; else process.env.OPENCODE_DISABLE_PROJECT_CONFIG = old }))
      const phases: ProjectConfig.Phase[] = []
      const off = ProjectConfig.observe(tmp.path, (phase) => { phases.push(phase) })
      yield* Effect.addFinalizer(() => Effect.sync(off))
      const listener = yield* Effect.acquireRelease(Effect.promise(() => Server.listen({ hostname: "127.0.0.1", port: 0 })), (server) => Effect.promise(() => server.stop(true)))
      const send = Effect.gen(function* () {
        const response = yield* Effect.promise(() => fetch(new URL("config", listener.url), { method: "PATCH", headers: { "content-type": "application/json", "x-opencode-directory": tmp.path }, body: JSON.stringify({ username: "after" }) }))
        const body = yield* Effect.promise(() => response.text())
        expect(response.status).toBe(kind === "invalid" ? 400 : kind === "alias" ? 409 : kind === "denied" ? 503 : 403)
        expect(JSON.parse(body)).toMatchObject({ code: kind === "invalid" ? "CONFIG_DOCUMENT_INVALID" : kind === "disabled" ? "CONFIG_PROJECT_DISABLED" : kind === "alias" ? "CONFIG_PATH_ALIAS_UNSUPPORTED" : kind === "outside" ? "CONFIG_TARGET_OUTSIDE_PROJECT" : "CONFIG_SOURCE_READ_FAILED", ref: expect.any(String) })
        expect(body).not.toContain("PRIVATE-COLD-TOKEN")
        expect(body).not.toContain(tmp.path)
      })
      if (kind === "denied") yield* withConfigReadDenied({ file, document, ops: process.platform === "win32" ? windowsOps(windowsIdentity()) : posixOps(), use: () => send })
      else yield* send
      expect(phases).toEqual(["preflight"])
      expect(yield* Effect.promise(() => fsPromises.readFile(file, "utf8"))).toBe(document)
      expect((yield* Effect.promise(() => fsPromises.readdir(tmp.path))).some((name) => name.includes(".tmp") || name === "config.json")).toBe(false)
    }))
  }

  for (const waiting of ["selection", "third-document"] as const) {
    it.live(`F23 real TCP cancellation while waiting for ${waiting}`, () => Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({ git: true, config: { username: "before", formatter: false, lsp: false } })
      const listener = yield* Effect.acquireRelease(Effect.promise(() => Server.listen({ hostname: "127.0.0.1", port: 0 })), (server) => Effect.promise(() => server.stop(true)))
      const file = path.join(tmp.path, "opencode.json"), before = yield* Effect.promise(() => fsPromises.readFile(file, "utf8"))
      const key = waiting === "selection" ? `config-project-selection:${tmp.path}` : ConfigDocument.key(file)
      const held = yield* Effect.promise(() => Flock.acquire(key))
      yield* Effect.addFinalizer(() => Effect.promise(() => held.release()))
      const ready = Promise.withResolvers<void>(), released = Promise.withResolvers<void>()
      let documents = 0, published = 0
      const off = ProjectConfig.observe(tmp.path, (phase) => {
        if (waiting === "selection" && phase === "selection-wait" || waiting === "third-document" && phase === "document-wait" && ++documents === 3) ready.resolve()
        if (phase === "released") released.resolve()
      })
      const original = AtomicDocument.publish
      const spy = spyOn(AtomicDocument, "publish").mockImplementation((input) => { if (input.file === file) published++; return original(input) })
      yield* Effect.addFinalizer(() => Effect.sync(() => { off(); spy.mockRestore() }))
      const client = request(new URL("config", listener.url), { method: "PATCH", headers: { "content-type": "application/json", "x-opencode-directory": tmp.path } })
      client.on("error", () => {})
      yield* Effect.addFinalizer(() => Effect.sync(() => client.destroy()))
      client.end(JSON.stringify({ username: "must-not-publish" }))
      yield* Effect.promise(() => ready.promise).pipe(Effect.timeout("20 seconds"))
      client.destroy()
      // The request must release its earlier leases while the original contender still owns the blocker.
      yield* Effect.promise(() => released.promise).pipe(Effect.timeout("10 seconds"))
      expect(published).toBe(0)
      expect(yield* Effect.promise(() => fsPromises.readFile(file, "utf8"))).toBe(before)
      yield* Effect.acquireRelease(Effect.promise(() => Flock.acquire(waiting === "selection" ? ConfigDocument.key(file) : `config-project-selection:${tmp.path}`, { timeoutMs: 1000 })), (lease) => Effect.promise(() => lease.release()))
      if (waiting === "third-document") {
        for (const local of ProjectConfig.localFiles(tmp.path).filter((candidate) => candidate !== file)) {
          yield* Effect.acquireRelease(Effect.promise(() => Flock.acquire(ConfigDocument.key(local), { timeoutMs: 1000 })), (lease) => Effect.promise(() => lease.release()))
        }
      }
    }), 120000)
  }

  it.live("F26 cold TCP bootstrap revalidates a source changed after preflight", () => Effect.gen(function* () {
    const tmp = yield* tmpdirEffect({ git: true, config: { username: "before", formatter: false, lsp: false } })
    const file = path.join(tmp.path, "opencode.json"), phases: ProjectConfig.Phase[] = []
    const invalid = '{"username":"PRIVATE-BOOTSTRAP",'
    const off = ProjectConfig.observe(tmp.path, async (phase) => { phases.push(phase); if (phase === "bootstrap") await fsPromises.writeFile(file, invalid) })
    yield* Effect.addFinalizer(() => Effect.sync(off))
    const listener = yield* Effect.acquireRelease(Effect.promise(() => Server.listen({ hostname: "127.0.0.1", port: 0 })), (server) => Effect.promise(() => server.stop(true)))
    const response = yield* Effect.promise(() => fetch(new URL("config", listener.url), { method: "PATCH", headers: { "content-type": "application/json", "x-opencode-directory": tmp.path }, body: JSON.stringify({ username: "after" }) }))
    const body = yield* Effect.promise(() => response.text())
    expect(response.status).toBe(400)
    expect(JSON.parse(body)).toMatchObject({ code: "CONFIG_DOCUMENT_INVALID", ref: expect.any(String) })
    expect(body).not.toContain("PRIVATE-BOOTSTRAP")
    expect(phases).toEqual(["preflight", "bootstrap"])
    expect(yield* Effect.promise(() => fsPromises.readFile(file, "utf8"))).toBe(invalid)
  }), 120000)

  it.live("F12/F30 real TCP ACK precedes paused handoff, no-op has no new publication", () => Effect.gen(function* () {
    const tmp = yield* tmpdirEffect({ git: true, config: { username: "before", formatter: false, lsp: false } })
    const listener = yield* Effect.acquireRelease(Effect.promise(() => Server.listen({ hostname: "127.0.0.1", port: 0 })), (server) => Effect.promise(() => server.stop(true)))
    const headers = { "content-type": "application/json", "x-opencode-directory": tmp.path }, file = path.join(tmp.path, "opencode.json")
    const warm = yield* Effect.promise(() => fetch(new URL("config", listener.url), { headers }))
    expect(warm.status).toBe(200); yield* Effect.promise(() => warm.arrayBuffer())
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    let publishes = 0, handoffs = 0
    const original = AtomicDocument.publish
    const spy = spyOn(AtomicDocument, "publish").mockImplementation((input) => { if (input.file === file) publishes++; return original(input) })
    const off = ProjectConfig.observe(tmp.path, async (phase) => { if (phase === "handoff") { handoffs++; entered.resolve(); await release.promise } })
    yield* Effect.addFinalizer(() => Effect.promise(async () => { release.resolve(); off(); spy.mockRestore(); await InstanceWork.waitHandoffs() }))
    const saved = yield* Effect.promise(() => fetch(new URL("config", listener.url), { method: "PATCH", headers, body: JSON.stringify({ username: "after" }) }))
    expect(saved.status).toBe(200); yield* Effect.promise(() => saved.arrayBuffer())
    yield* Effect.promise(() => entered.promise)
    expect(JSON.parse(yield* Effect.promise(() => fsPromises.readFile(file, "utf8"))).username).toBe("after")
    const pending = yield* Effect.promise(() => fetch(new URL("config", listener.url), { headers }))
    expect(yield* Effect.promise(() => pending.json())).toMatchObject({ username: "before" })
    release.resolve(); yield* Effect.promise(() => InstanceWork.waitHandoffs())
    const refreshed = yield* Effect.promise(() => fetch(new URL("config", listener.url), { headers }))
    expect(yield* Effect.promise(() => refreshed.json())).toMatchObject({ username: "after" })
    const before = yield* Effect.promise(() => fsPromises.readFile(file, "utf8")), identity = yield* Effect.promise(() => fsPromises.stat(file))
    const noop = yield* Effect.promise(() => fetch(new URL("config", listener.url), { method: "PATCH", headers, body: JSON.stringify({ username: "after" }) }))
    expect(noop.status).toBe(200); yield* Effect.promise(() => noop.arrayBuffer())
    yield* Effect.promise(() => InstanceWork.waitHandoffs())
    expect(publishes).toBe(1); expect(handoffs).toBe(1)
    expect(yield* Effect.promise(() => fsPromises.readFile(file, "utf8"))).toBe(before)
    expect((yield* Effect.promise(() => fsPromises.stat(file))).ino).toBe(identity.ino)
  }), 120000)

  for (const outcome of ["commit", "reject", "committed-before-disconnect"] as const) {
    it.live(`I30/I31 real TCP disconnect after publication dispatch: ${outcome}`, () => Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({ git: true, config: { username: "tcp-before", formatter: false, lsp: false } })
      const listener = yield* Effect.acquireRelease(
        Effect.promise(() => Server.listen({ hostname: "127.0.0.1", port: 0 })),
        (server) => Effect.promise(() => server.stop(true)),
      )
      const headers = { "content-type": "application/json", "x-opencode-directory": tmp.path }
      const file = path.join(tmp.path, "opencode.json")
      const warm = yield* Effect.promise(() => fetch(new URL("config", listener.url), { headers }))
      expect(warm.status).toBe(200)
      expect(yield* Effect.promise(() => warm.json())).toMatchObject({ username: "tcp-before" })
      const before = yield* Effect.promise(() => fsPromises.readFile(file, "utf8"))
      const marker = "tcp-" + outcome
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const completed = Promise.withResolvers<void>()
      const refreshed = Promise.withResolvers<void>()
      let calls = 0
      let reloads = 0
      const remove = Config.onConfigReload((directory) => {
        if (directory?.toLowerCase() !== tmp.path.toLowerCase()) return
        reloads++
        refreshed.resolve()
      })
      const original = AtomicDocument.publish
      const spy = spyOn(AtomicDocument, "publish").mockImplementation(async (input) => {
        if (input.file !== file || !input.text.includes(marker)) return original(input)
        calls++
        try {
          if (outcome === "committed-before-disconnect") {
            const result = await original(input)
            entered.resolve()
            await release.promise
            return result
          }
          entered.resolve()
          await release.promise
          if (outcome === "reject") throw new Error("controlled publication failure after disconnect")
          return await original(input)
        } finally {
          completed.resolve()
        }
      })
      yield* Effect.addFinalizer(() => Effect.promise(async () => {
        release.resolve()
        if (calls) await completed.promise
        spy.mockRestore()
        remove()
      }))
      const client = request(new URL("config", listener.url), { method: "PATCH", headers })
      const closed = new Promise<void>((resolve) => client.once("close", resolve))
      client.on("error", () => undefined) // ECONNRESET is the intentional client outcome.
      yield* Effect.addFinalizer(() => Effect.promise(async () => { client.destroy(); await closed }))
      const disposed = yield* waitDisposed(tmp.path).pipe(Effect.forkScoped({ startImmediately: true }))
      client.end(JSON.stringify({ username: marker, formatter: false, lsp: false }))
      yield* Effect.promise(() => entered.promise).pipe(Effect.timeout("45 seconds"))
      client.destroy()
      yield* Effect.promise(() => closed)
      release.resolve()
      yield* Effect.promise(() => completed.promise).pipe(Effect.timeout("20 seconds"))
      if (outcome !== "reject") {
        yield* Effect.promise(() => refreshed.promise).pipe(Effect.timeout("20 seconds"))
        yield* Fiber.join(disposed).pipe(Effect.timeout("20 seconds"))
      }
      expect(calls).toBe(1)
      const text = yield* Effect.promise(() => fsPromises.readFile(file, "utf8"))
      if (outcome === "reject") {
        expect(text).toBe(before)
        expect(reloads).toBe(0)
      } else {
        expect(JSON.parse(text).username).toBe(marker)
        expect(reloads).toBe(1)
      }
      const next = yield* Effect.promise(() => fetch(new URL("config", listener.url), { headers }))
      expect(next.status).toBe(200)
      const memory = yield* Effect.promise(() => next.json())
      if (outcome === "reject") expect(memory.username).toBe("tcp-before")
      else expect(memory.username).toBe(marker)
      expect(calls).toBe(1)
    }), 120000)
  }

  it.live("I30 control: connected TCP save is read back after instance disposal", () => Effect.gen(function* () {
    const tmp = yield* tmpdirEffect({ git: true, config: { username: "tcp-connected-before", formatter: false, lsp: false } })
    const listener = yield* Effect.acquireRelease(
      Effect.promise(() => Server.listen({ hostname: "127.0.0.1", port: 0 })),
      (server) => Effect.promise(() => server.stop(true)),
    )
    const headers = { "content-type": "application/json", "x-opencode-directory": tmp.path }
    const warm = yield* Effect.promise(() => fetch(new URL("config", listener.url), { headers }))
    expect(warm.status).toBe(200)
    expect(yield* Effect.promise(() => warm.json())).toMatchObject({ username: "tcp-connected-before" })
    const source = yield* Effect.promise(() => fsPromises.readFile(path.join(tmp.path, "opencode.json"), "utf8"))
    const disposed = yield* waitDisposed(tmp.path).pipe(Effect.forkScoped({ startImmediately: true }))
    const saved = yield* Effect.promise(() => fetch(new URL("config", listener.url), {
      method: "PATCH", headers, body: JSON.stringify({ username: "tcp-connected-control", formatter: false, lsp: false }),
    }))
    expect(saved.status).toBe(200)
    expect(yield* Effect.promise(() => saved.json())).toMatchObject({ username: "tcp-connected-control" })
    yield* Fiber.join(disposed).pipe(Effect.timeout("20 seconds"))
    const written = yield* Effect.promise(() => fsPromises.readFile(path.join(tmp.path, "opencode.json"), "utf8"))
    expect(JSON.parse(written).username).toBe("tcp-connected-control")
    expect(JSON.parse(written).formatter).toEqual(JSON.parse(source).formatter)
    expect(yield* Effect.promise(() => fsPromises.stat(path.join(tmp.path, "config.json")).then(() => true, () => false))).toBe(false)
    const next = yield* Effect.promise(() => fetch(new URL("config", listener.url), { headers }))
    expect(next.status).toBe(200)
    expect(yield* Effect.promise(() => next.json())).toMatchObject({ username: "tcp-connected-control" })
  }), 120000)

  ;(process.platform === "win32" || process.getuid?.() !== 0 ? it.live : it.live.skip)("ACC-02 cold TCP full config recovers after a real denied read without disposal or restart", () => Effect.gen(function* () {
    const tmp = yield* tmpdirEffect({ git: true })
    const file = path.join(tmp.path, "opencode.json")
    const text = JSON.stringify({ $schema: "https://opencode.ai/config.json", mcp: { review: { type: "remote", url: "https://example.invalid/mcp", enabled: false } } })
    const listener = yield* Effect.acquireRelease(
      Effect.promise(() => Server.listen({ hostname: "127.0.0.1", port: 0 })),
      (server) => Effect.promise(() => server.stop(true)),
    )
    const request = () => Effect.promise(() => fetch(new URL("config", listener.url), { headers: { "x-opencode-directory": tmp.path } }))
    const denied = yield* withConfigReadDenied({ file, document: text, ops: process.platform === "win32" ? windowsOps(windowsIdentity()) : posixOps(), use: () => Effect.gen(function* () {
      const first = yield* request()
      expect(first.status).toBe(503)
      const body = yield* Effect.promise(() => first.text())
      expect(body).toContain("MCP_SOURCE_READ_FAILED")
      expect(body).toMatch(/"ref":"[^"]+"/)
    }) })
    expect(denied.seen().stage).toBe("restored")
    expect(yield* Effect.promise(() => fsPromises.readFile(file, "utf8"))).toBe(text)
    const recovered = yield* request()
    expect(recovered.status).toBe(200)
    expect(yield* Effect.promise(() => recovered.json())).toMatchObject({ mcp: { review: { enabled: false } } })
  }), 60000)

  it.live("ACC-02 source GET does not annotate, install or evaluate a project plugin", () => Effect.gen(function* () {
    const tmp = yield* tmpdirEffect({ git: true })
    const file = path.join(tmp.path, "opencode.json")
    const text = JSON.stringify({ plugin: ["./broken-plugin.ts"], mcp: { sample: { type: "local", command: ["node", "unchanged.js"] } } })
    yield* Effect.promise(() => Bun.write(path.join(tmp.path, "broken-plugin.ts"), 'throw new Error("source GET must never evaluate this")'))
    yield* Effect.promise(() => Bun.write(file, text))
    const response = yield* Effect.promise(() => Promise.resolve(app().request("/config/mcp/sample", { headers: { "x-opencode-directory": tmp.path } })))
    expect(response.status).toBe(200)
    expect(yield* Effect.promise(() => fsPromises.readFile(file, "utf8"))).toBe(text)
    expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, ".opencode", ".gitignore")).exists())).toBe(false)
  }))

  it.live(
    "returns a typed MCP version conflict without rewriting the source",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({ git: true })
      const filename = path.join(tmp.path, "opencode.jsonc")
      const text = JSON.stringify({ mcp: { sample: { type: "local", command: ["node", "old.js"] } } }, null, 2)
      yield* Effect.promise(() => Bun.write(filename, text))
      const source = yield* Effect.promise(() =>
        Promise.resolve(app().request("/config/mcp/sample", { headers: { "x-opencode-directory": tmp.path } })),
      )
      expect(source.status).toBe(200)
      const loaded = (yield* Effect.promise(() => source.json())) as {
        source: string
        version: string
        writable: boolean
      }
      expect(loaded.writable).toBe(true)
      yield* Effect.promise(() =>
        Bun.write(filename, JSON.stringify({ mcp: { sample: { type: "local", command: ["node", "remote.js"] } } }, null, 2)),
      )
      const conflict = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/config/mcp/sample", {
            method: "PATCH",
            headers: { "content-type": "application/json", "x-opencode-directory": tmp.path },
            body: JSON.stringify({
              source: loaded.source,
              version: loaded.version,
              patch: { command: ["node", "stale.js"] },
            }),
          }),
        ),
      )
      expect(conflict.status).toBe(409)
      expect(yield* Effect.promise(() => conflict.json())).toMatchObject({ code: "MCP_VERSION_CONFLICT" })
      expect(yield* Effect.promise(() => Bun.file(filename).text())).toContain("remote.js")
      expect(yield* Effect.promise(() => Bun.file(filename).text())).not.toContain("stale.js")
    }),
  )

  it.live(
    "returns typed MCP missing, read-only, and invalid responses without rewriting the source",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({ git: true })
      const filename = path.join(tmp.path, "opencode.jsonc")
      const original = JSON.stringify(
        { mcp: { sample: { type: "local", command: ["node", "kept.js"] } } },
        null,
        2,
      )
      yield* Effect.promise(() => Bun.write(filename, original))
      const headers = { "content-type": "application/json", "x-opencode-directory": tmp.path }
      const request = (input: string, init?: RequestInit) =>
        Effect.promise(() => Promise.resolve(app().request(input, init)))

      const missing = yield* request("/config/mcp/absent", { headers })
      expect(missing.status).toBe(200)
      expect(yield* Effect.promise(() => missing.json())).toBeNull()

      const source = yield* request("/config/mcp/sample", { headers })
      expect(source.status).toBe(200)
      const loaded = (yield* Effect.promise(() => source.json())) as {
        source: string
        version: string
        writable: boolean
      }
      const patch = (body: unknown) =>
        request("/config/mcp/sample", { method: "PATCH", headers, body: JSON.stringify(body) })

      const invalid = yield* patch({
        source: loaded.source,
        version: loaded.version,
        patch: { type: "remote" },
      })
      expect(invalid.status).toBe(400)
      expect(yield* Effect.promise(() => invalid.json())).toMatchObject({ code: "MCP_DOCUMENT_INVALID" })
      const afterInvalid = yield* Effect.promise(() => Bun.file(filename).text())
      expect(afterInvalid).toContain("kept.js")
      expect(afterInvalid).not.toContain('"type": "remote"')

      const removed = JSON.stringify({ mcp: {} }, null, 2)
      yield* Effect.promise(() => Bun.write(filename, removed))
      const afterDelete = yield* request("/config/mcp/sample", { headers })
      expect(afterDelete.status).toBe(200)
      expect(yield* Effect.promise(() => afterDelete.json())).toBeNull()
      const gone = yield* patch({
        source: loaded.source,
        version: loaded.version,
        patch: { command: ["node", "deleted.js"] },
      })
      expect(gone.status).toBe(404)
      expect(yield* Effect.promise(() => gone.json())).toMatchObject({ code: "MCP_SOURCE_MISSING" })
      const afterMissing = yield* Effect.promise(() => Bun.file(filename).text())
      expect(afterMissing).not.toContain("deleted.js")
      expect(afterMissing).toContain('"mcp": {}')

      const builtin = yield* request("/config/mcp/openaiDeveloperDocs", { headers })
      expect(builtin.status).toBe(200)
      const built = (yield* Effect.promise(() => builtin.json())) as { source: string; version: string; writable: boolean }
      expect(built.writable).toBe(false)
      const readonly = yield* request("/config/mcp/openaiDeveloperDocs", {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          source: built.source,
          version: built.version,
          patch: { url: "https://example.invalid/mcp" },
        }),
      })
      expect(readonly.status).toBe(403)
      expect(yield* Effect.promise(() => readonly.json())).toMatchObject({ code: "MCP_SOURCE_READ_ONLY" })
      const afterReadonly = yield* Effect.promise(() => Bun.file(filename).text())
      expect(afterReadonly).not.toContain("example.invalid")
      expect(afterReadonly).not.toContain("deleted.js")

      yield* Effect.promise(() => Bun.write(filename, "{ mcp: "))
      const corrupt = yield* patch({
        source: loaded.source,
        version: loaded.version,
        patch: { command: ["node", "corrupt.js"] },
      })
      expect(corrupt.status).toBe(400)
      expect(yield* Effect.promise(() => corrupt.json())).toMatchObject({ code: "MCP_DOCUMENT_INVALID" })
      expect(yield* Effect.promise(() => Bun.file(filename).text())).toBe("{ mcp: ")
    }),
  )

  it.live(
    "returns inherited MCP references without writing them into the winning file",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({ git: true })
      const baseFile = path.join(tmp.path, "opencode.json")
      const filename = path.join(tmp.path, "opencode.jsonc")
      const token = path.join(tmp.path, "review-token.txt")
      const headers = { "content-type": "application/json", "x-opencode-directory": tmp.path }
      const request = (input: string, init?: RequestInit) =>
        Effect.promise(() => Promise.resolve(app().request(input, init)))
      yield* Effect.promise(() => Bun.write(token, "secret-token"))
      yield* Effect.promise(() =>
        Bun.write(
          baseFile,
          JSON.stringify({
            mcp: {
              layered: {
                type: "remote",
                url: "https://base.example.com/mcp",
                headers: { "X-Base": "{file:./review-token.txt}", "X-Shared": "base" },
              },
            },
          }),
        ),
      )
      yield* Effect.promise(() =>
        Bun.write(
          filename,
          JSON.stringify({
            mcp: {
              layered: {
                type: "remote",
                url: "https://project.example.com/mcp",
                headers: { "X-Project": "project", "X-Shared": "project" },
              },
            },
          }),
        ),
      )
      const inherited = yield* request("/config/mcp/layered", { headers })
      expect(inherited.status).toBe(200)
      const inheritedBody = (yield* Effect.promise(() => inherited.json())) as {
        source: string
        version: string
        config: { headers?: Record<string, string> }
      }
      expect(inheritedBody.config.headers).toEqual({
        "X-Base": "{file:./review-token.txt}",
        "X-Project": "project",
        "X-Shared": "project",
      })
      expect(JSON.stringify(inheritedBody)).not.toContain("secret-token")
      const saved = yield* request("/config/mcp/layered", {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          source: inheritedBody.source,
          version: inheritedBody.version,
          patch: { url: "https://edited.example.com/mcp" },
        }),
      })
      expect(saved.status).toBe(200)
      const afterSave = yield* Effect.promise(() => Bun.file(filename).text())
      expect(afterSave).toContain("https://edited.example.com/mcp")
      expect(afterSave).not.toContain("secret-token")
      expect(afterSave).not.toContain("X-Base")
      expect(yield* Effect.promise(() => Bun.file(baseFile).text())).toContain("{file:./review-token.txt}")
    }),
  )

  it.live(
    "returns a safe typed error when the first MCP source load is invalid",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({ git: true })
      const filename = path.join(tmp.path, "opencode.json")
      const secret = "review-init-secret"
      yield* Effect.promise(() =>
        Bun.write(filename, `{ mcp: { review: { type: "remote", headers: { Authorization: "Bearer ${secret}" } } }`),
      )
      const response = yield* Effect.promise(() =>
        Promise.resolve(app().request("/config/mcp/review", { headers: { "x-opencode-directory": tmp.path } })),
      )
      expect(response.status).toBe(400)
      const body = JSON.stringify(yield* Effect.promise(() => response.json()))
      expect(body).toContain("MCP_DOCUMENT_INVALID")
      expect(body).toMatch(/"ref":"[^"]+"/)
      expect(body).not.toContain(secret)
      expect(body).not.toContain("JSONC Input")
      expect(body).not.toContain("ConfigJsonError")
    }),
  )

  it.live(
    "rejects a patch after the cached document is corrupted and leaves the bytes unchanged",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({ git: true })
      const filename = path.join(tmp.path, "opencode.json")
      const headers = { "content-type": "application/json", "x-opencode-directory": tmp.path }
      const original = JSON.stringify({ mcp: { review: { type: "local", command: ["node", "kept.js"] } } })
      yield* Effect.promise(() => Bun.write(filename, original))
      const loaded = yield* Effect.promise(() => Promise.resolve(app().request("/config/mcp/review", { headers })))
      expect(loaded.status).toBe(200)
      const source = (yield* Effect.promise(() => loaded.json())) as { source: string; version: string }
      const broken = '{ mcp: { review: { headers: { Authorization: "Bearer review-reload-secret" }'
      yield* Effect.promise(() => Bun.write(filename, broken))
      const patch = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/config/mcp/review", {
            method: "PATCH",
            headers,
            body: JSON.stringify({
              source: source.source,
              version: source.version,
              patch: { command: ["node", "changed.js"] },
            }),
          }),
        ),
      )
      expect(patch.status).toBe(400)
      const body = JSON.stringify(yield* Effect.promise(() => patch.json()))
      expect(body).toContain("MCP_DOCUMENT_INVALID")
      expect(body).toMatch(/"ref":"[^"]+"/)
      expect(body).not.toContain("review-reload-secret")
      expect(body).not.toContain("JSONC Input")
      expect(yield* Effect.promise(() => Bun.file(filename).text())).toBe(broken)
    }),
  )

  it.live(
    "returns an empty MCP source after the winning file is deleted",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({ git: true })
      const filename = path.join(tmp.path, "opencode.json")
      const headers = { "content-type": "application/json", "x-opencode-directory": tmp.path }
      yield* Effect.promise(() =>
        Bun.write(filename, JSON.stringify({ mcp: { review: { type: "local", command: ["node", "kept.js"] } } })),
      )
      const loaded = yield* Effect.promise(() => Promise.resolve(app().request("/config/mcp/review", { headers })))
      expect(loaded.status).toBe(200)
      const source = (yield* Effect.promise(() => loaded.json())) as { source: string; version: string }
      yield* Effect.promise(() => fsPromises.unlink(filename))
      const missing = yield* Effect.promise(() => Promise.resolve(app().request("/config/mcp/review", { headers })))
      expect(missing.status).toBe(200)
      expect(yield* Effect.promise(() => missing.json())).toBeNull()
      const patch = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/config/mcp/review", {
            method: "PATCH",
            headers,
            body: JSON.stringify({
              source: source.source,
              version: source.version,
              patch: { command: ["node", "restored.js"] },
            }),
          }),
        ),
      )
      expect(patch.status).toBe(404)
      expect(yield* Effect.promise(() => Bun.file(filename).exists())).toBe(false)
    }),
  )

  it.live(
    "keeps inherited MCP fields when environment content only disables the entry",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({ git: true })
      const filename = path.join(tmp.path, "opencode.json")
      const headers = { "x-opencode-directory": tmp.path }
      yield* Effect.promise(() =>
        Bun.write(
          filename,
          JSON.stringify({
            mcp: {
              review: {
                type: "remote",
                url: "https://project.example/mcp",
                headers: { Authorization: "Bearer {env:REVIEW_MCP_TOKEN}", "X-Shared": "project" },
              },
            },
          }),
        ),
      )
      const previous = process.env.OPENCODE_CONFIG_CONTENT
      const previousToken = process.env.REVIEW_MCP_TOKEN
      process.env.REVIEW_MCP_TOKEN = "review-token-value"
      process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
        mcp: { review: { enabled: false, headers: { "X-Shared": "env" } } },
      })
      const response = yield* Effect.promise(() => Promise.resolve(app().request("/config/mcp/review", { headers })))
      const body = JSON.stringify(yield* Effect.promise(() => response.json()))
      expect(response.status).toBe(200)
      expect(body).toContain("https://project.example/mcp")
      expect(body).toContain("{env:REVIEW_MCP_TOKEN}")
      expect(body).toContain('"X-Shared":"env"')
      expect(body).not.toContain("review-token-value")
      if (previous === undefined) delete process.env.OPENCODE_CONFIG_CONTENT
      else process.env.OPENCODE_CONFIG_CONTENT = previous
      if (previousToken === undefined) delete process.env.REVIEW_MCP_TOKEN
      else process.env.REVIEW_MCP_TOKEN = previousToken
    }),
  )

  it.live(
    "returns unavailable when a required inherited MCP file is deleted",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({ git: true })
      const ancestor = path.join(tmp.path, "opencode.json")
      const winner = path.join(tmp.path, ".opencode", "opencode.json")
      const headers = { "x-opencode-directory": tmp.path }
      yield* Effect.promise(() =>
        Bun.write(
          ancestor,
          JSON.stringify({
            mcp: { review: { type: "remote", url: "https://base.example/mcp", headers: { "X-Base": "base" } } },
          }),
        ),
      )
      yield* Effect.promise(() =>
        Bun.write(
          winner,
          JSON.stringify({ mcp: { review: { enabled: false, headers: { "X-Project": "project" } } } }),
        ),
      )
      const loaded = yield* Effect.promise(() => Promise.resolve(app().request("/config/mcp/review", { headers })))
      expect(loaded.status).toBe(200)
      const body = (yield* Effect.promise(() => loaded.json())) as { source: string; config: { url?: string } }
      expect(body.source).toBe(winner)
      expect(body.config.url).toBe("https://base.example/mcp")
      yield* Effect.promise(() => fsPromises.unlink(ancestor))
      const missing = yield* Effect.promise(() => Promise.resolve(app().request("/config/mcp/review", { headers })))
      expect(missing.status).toBe(503)
      const failed = JSON.stringify(yield* Effect.promise(() => missing.json()))
      expect(failed).toContain("MCP_SOURCE_READ_FAILED")
      expect(failed).toMatch(/"ref":"[^"]+"/)
      expect(failed).not.toContain("https://base.example/mcp")
    }),
  )

  it.live(
    "returns a safe typed error when the first MCP schema is invalid",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({ git: true })
      const filename = path.join(tmp.path, "opencode.json")
      yield* Effect.promise(() =>
        Bun.write(
          filename,
          JSON.stringify({
            mcp: { review: { type: "remote", headers: { Authorization: "Bearer review-schema-secret" } } },
          }),
        ),
      )
      const response = yield* Effect.promise(() =>
        Promise.resolve(app().request("/config/mcp/review", { headers: { "x-opencode-directory": tmp.path } })),
      )
      expect(response.status).toBe(400)
      const body = JSON.stringify(yield* Effect.promise(() => response.json()))
      expect(body).toContain("MCP_DOCUMENT_INVALID")
      expect(body).toMatch(/"ref":"[^"]+"/)
      expect(body).not.toContain("review-schema-secret")
      expect(body).not.toContain("JSONC Input")
    }),
  )

  it.live(
    "returns an empty MCP source after the winning managed file is deleted",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({ git: true })
      const managed = process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR
      if (!managed) return yield* Effect.die(new Error("managed config isolation is not set"))
      const filename = path.join(managed, "opencode.json")
      const headers = { "x-opencode-directory": tmp.path }
      yield* Effect.promise(() =>
        Bun.write(
          filename,
          JSON.stringify({ mcp: { review: { type: "remote", url: "https://managed.example/mcp", enabled: true } } }),
        ),
      )
      const loaded = yield* Effect.promise(() => Promise.resolve(app().request("/config/mcp/review", { headers })))
      expect(loaded.status).toBe(200)
      const source = (yield* Effect.promise(() => loaded.json())) as { source: string; writable: boolean }
      expect(source.source).toBe(filename)
      expect(source.writable).toBe(false)
      yield* Effect.promise(() => fsPromises.unlink(filename))
      const missing = yield* Effect.promise(() => Promise.resolve(app().request("/config/mcp/review", { headers })))
      expect(missing.status).toBe(200)
      expect(yield* Effect.promise(() => missing.json())).toBeNull()
      expect(yield* Effect.promise(() => Bun.file(filename).exists())).toBe(false)
    }),
  )

  it.live(
    "returns unexpanded environment MCP references and typed read failures",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({ git: true })
      const headers = { "content-type": "application/json", "x-opencode-directory": tmp.path }
      const request = (input: string, init?: RequestInit) =>
        Effect.promise(() => Promise.resolve(app().request(input, init)))
      const document = JSON.stringify({
        mcp: {
          review: {
            type: "remote",
            url: "https://review.example/mcp",
            enabled: false,
            headers: { Authorization: "Bearer {env:REVIEW_MCP_TOKEN}" },
          },
        },
      })
      const previous = process.env.OPENCODE_CONFIG_CONTENT
      const previousToken = process.env.REVIEW_MCP_TOKEN
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (previous === undefined) delete process.env.OPENCODE_CONFIG_CONTENT
          else process.env.OPENCODE_CONFIG_CONTENT = previous
          if (previousToken === undefined) delete process.env.REVIEW_MCP_TOKEN
          else process.env.REVIEW_MCP_TOKEN = previousToken
        }),
      )
      process.env.REVIEW_MCP_TOKEN = "review-token-value"
      process.env.OPENCODE_CONFIG_CONTENT = document
      const source = yield* request("/config/mcp/review", { headers })
      const body = JSON.stringify(yield* Effect.promise(() => source.json()))
      expect(source.status).toBe(200)
      expect(body).toContain("{env:REVIEW_MCP_TOKEN}")
      expect(body).not.toContain("review-token-value")
      const loaded = (yield* Effect.promise(() => Promise.resolve(JSON.parse(body)))) as {
        source: string
        version: string
        writable: boolean
      }
      expect(loaded.writable).toBe(false)
      const readonly = yield* request("/config/mcp/review", {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          source: loaded.source,
          version: loaded.version,
          patch: { url: "https://edited.example/mcp" },
        }),
      })
      expect(readonly.status).toBe(403)
      expect(yield* Effect.promise(() => readonly.json())).toMatchObject({ code: "MCP_SOURCE_READ_ONLY" })

      process.env.OPENCODE_CONFIG_CONTENT = "{ mcp: "
      const invalid = yield* request("/config/mcp/review", { headers: { "x-opencode-directory": tmp.path } })
      expect(invalid.status).toBe(400)
      const invalidBody = JSON.stringify(yield* Effect.promise(() => invalid.json()))
      expect(invalidBody).toContain("MCP_DOCUMENT_INVALID")
      expect(invalidBody).not.toContain("review-token-value")

      delete process.env.OPENCODE_CONFIG_CONTENT
      const missing = yield* request("/config/mcp/absent", { headers: { "x-opencode-directory": tmp.path } })
      expect(missing.status).toBe(200)
      expect(yield* Effect.promise(() => missing.json())).toBeNull()
    }),
  )

  const reviewDocument = JSON.stringify({
    mcp: {
      review: {
        type: "remote",
        url: "https://review.example/mcp",
        enabled: false,
        headers: { Authorization: "Bearer {env:REVIEW_MCP_TOKEN}" },
      },
    },
  })

  const deniedConfigRead = (name: string, ops: () => ReturnType<typeof windowsOps>) =>
    it.live(
      name,
      Effect.gen(function* () {
        const tmp = yield* tmpdirEffect({ git: true })
        const previous = process.env.OPENCODE_CONFIG_CONTENT
        const previousToken = process.env.REVIEW_MCP_TOKEN
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (previous === undefined) delete process.env.OPENCODE_CONFIG_CONTENT
            else process.env.OPENCODE_CONFIG_CONTENT = previous
            if (previousToken === undefined) delete process.env.REVIEW_MCP_TOKEN
            else process.env.REVIEW_MCP_TOKEN = previousToken
          }),
        )
        process.env.REVIEW_MCP_TOKEN = "review-token-value"
        delete process.env.OPENCODE_CONFIG_CONTENT
        const denied = path.join(tmp.path, "opencode.json")
        yield* Effect.promise(() => disposeAllInstances())
        const requested = yield* withConfigReadDenied({
          file: denied,
          document: reviewDocument,
          ops: ops(),
          use: (code) =>
            Effect.gen(function* () {
              expect(code === "EACCES" || code === "EPERM").toBe(true)
              const response = yield* Effect.promise(() =>
                Promise.resolve(app().request("/config/mcp/review", { headers: { "x-opencode-directory": tmp.path } })),
              )
              return { status: response.status, body: yield* Effect.promise(() => response.text()) }
            }),
        })
        expect(requested.value.status).toBe(503)
        expect(requested.value.body).toContain("MCP_SOURCE_READ_FAILED")
        expect(requested.value.body).toMatch(/"ref":"[^"]+"/)
        expect(requested.value.body).not.toContain("review-token-value")
        expect(requested.value.body).not.toContain(reviewDocument)
        expect(requested.value.body).not.toContain("EACCES")
        expect(requested.value.body).not.toContain("EPERM")
        const restored = yield* Effect.promise(() => fsPromises.readFile(denied, "utf8"))
        expect(restored).toBe(reviewDocument)
      }),
    )

  if (process.platform === "win32") {
    deniedConfigRead("returns a typed read failure when Windows denies the project config", () =>
      windowsOps(windowsIdentity()),
    )
  } else {
    it.live.skip("returns a typed read failure when Windows denies the project config", () => Effect.void)
  }

  const unixIdentity = process.platform !== "win32" && typeof process.getuid === "function" ? process.getuid() : undefined
  if (unixIdentity !== undefined && unixIdentity !== 0) {
    deniedConfigRead("returns a typed read failure when the project config mode denies read", () => posixOps())
  } else {
    it.live.skip("returns a typed read failure when the project config mode denies read", () => Effect.void)
  }

  it.live(
    "ignores a corrupt project file when disabled project config has a valid environment MCP",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({ git: true })
      const previousDisable = process.env.OPENCODE_DISABLE_PROJECT_CONFIG
      const previousContent = process.env.OPENCODE_CONFIG_CONTENT
      const previousToken = process.env.REVIEW_MCP_TOKEN
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (previousDisable === undefined) delete process.env.OPENCODE_DISABLE_PROJECT_CONFIG
          else process.env.OPENCODE_DISABLE_PROJECT_CONFIG = previousDisable
          if (previousContent === undefined) delete process.env.OPENCODE_CONFIG_CONTENT
          else process.env.OPENCODE_CONFIG_CONTENT = previousContent
          if (previousToken === undefined) delete process.env.REVIEW_MCP_TOKEN
          else process.env.REVIEW_MCP_TOKEN = previousToken
        }),
      )
      process.env.OPENCODE_DISABLE_PROJECT_CONFIG = "true"
      process.env.REVIEW_MCP_TOKEN = "review-token-value"
      process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
        mcp: {
          review: {
            type: "remote",
            url: "https://env.example/mcp",
            enabled: false,
            headers: { Authorization: "Bearer {env:REVIEW_MCP_TOKEN}" },
          },
        },
      })
      const headers = { "x-opencode-directory": tmp.path }
      const request = (input: string) =>
        Effect.promise(async () => {
          const response = await app().request(input, { headers })
          return { status: response.status, body: await response.text() }
        })
      yield* Effect.promise(() => Bun.write(path.join(tmp.path, "opencode.json"), "{ invalid project "))
      yield* Effect.promise(() => disposeAllInstances())
      const config = yield* request("/config")
      const source = yield* request("/config/mcp/review")
      expect(config.status).toBe(200)
      expect(source.status).toBe(200)
      expect(source.body).toContain("https://env.example/mcp")
      expect(source.body).toContain("{env:REVIEW_MCP_TOKEN}")
      expect(source.body).not.toContain("review-token-value")
      expect(source.body).not.toContain("invalid project")
    }),
  )

  it.live(
    "keeps connection details when .opencode only overrides enabled",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({ git: true })
      const root = path.join(tmp.path, "opencode.json")
      const local = path.join(tmp.path, ".opencode", "opencode.json")
      const headers = { "x-opencode-directory": tmp.path }
      yield* Effect.promise(() =>
        Bun.write(
          root,
          JSON.stringify({
            mcp: {
              sample: {
                type: "remote",
                url: "https://sample.example.com/mcp",
                enabled: false,
                headers: { "X-Base": "{file:./review-token.txt}" },
              },
            },
          }),
        ),
      )
      yield* Effect.promise(() => Bun.write(path.join(tmp.path, "review-token.txt"), "secret-token"))
      yield* Effect.promise(() => Bun.write(local, JSON.stringify({ mcp: { sample: { enabled: true } } })))
      const config = yield* Effect.promise(() =>
        Promise.resolve(app().request("/config", { headers })),
      )
      expect(config.status).toBe(200)
      const loaded = (yield* Effect.promise(() => config.json())) as { mcp?: { sample?: { url?: string } } }
      expect(loaded.mcp?.sample?.url).toBe("https://sample.example.com/mcp")
      const source = yield* Effect.promise(() =>
        Promise.resolve(app().request("/config/mcp/sample", { headers })),
      )
      expect(source.status).toBe(200)
      const body = (yield* Effect.promise(() => source.json())) as {
        source: string
        config: { type?: string; url?: string; enabled?: boolean; headers?: Record<string, string> }
      }
      expect(body.source).toBe(local)
      expect(body.config).toMatchObject({
        type: "remote",
        url: "https://sample.example.com/mcp",
        enabled: true,
        headers: { "X-Base": "{file:./review-token.txt}" },
      })
      expect(JSON.stringify(body)).not.toContain("secret-token")
    }),
  )

  it.live(
    "serves config update through the default server app",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({ config: { formatter: false, lsp: false } })
      const disposed = yield* waitDisposed(tmp.path).pipe(Effect.forkScoped({ startImmediately: true }))

      const response = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/config", {
            method: "PATCH",
            headers: {
              "content-type": "application/json",
              "x-opencode-directory": tmp.path,
            },
            body: JSON.stringify({ username: "patched-user", formatter: false, lsp: false }),
          }),
        ),
      )

      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        username: "patched-user",
        formatter: false,
        lsp: false,
      })
      yield* Fiber.join(disposed)
      expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "opencode.json")).json())).toMatchObject({
        username: "patched-user",
        formatter: false,
        lsp: false,
      })
    }),
  )

  it.live(
    "serves config with active provider model status",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({
        config: {
          formatter: false,
          lsp: false,
          provider: {
            omniroute: {
              models: {
                "gpt-4o": {
                  status: "active",
                },
              },
            },
          },
        },
      })

      const response = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/config", {
            headers: {
              "x-opencode-directory": tmp.path,
            },
          }),
        ),
      )

      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        provider: {
          omniroute: {
            models: {
              "gpt-4o": {
                status: "active",
              },
            },
          },
        },
      })
    }),
  )
})
