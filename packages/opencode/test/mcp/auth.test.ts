import fs from "fs/promises"
import { symlinkSync } from "fs"
import os from "os"
import path from "path"
import { spawnSync } from "child_process"
import { expect, test } from "bun:test"
import { setTimeout as sleep } from "node:timers/promises"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer, ManagedRuntime, Option } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { Global } from "@opencode-ai/core/global"
import { Hash } from "@opencode-ai/core/util/hash"
import { LockIdentity } from "@opencode-ai/core/util/lock-identity"
import { McpAuth } from "../../src/mcp/auth"

function authFile() {
  let raw = ""
  let activeWrites = 0
  let sawOverlap = false

  const fsLayer = Layer.effect(
    FSUtil.Service,
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service

      return FSUtil.Service.of({
        ...fs,
        readJson: (file) =>
          file.endsWith("mcp-auth.json")
            ? Effect.try({
                try: () => {
                  if (!raw) throw new Error("mcp-auth.json missing")
                  return JSON.parse(raw)
                },
                catch: (cause) => new FSUtil.FileSystemError({ method: "readJson", cause }),
              })
            : fs.readJson(file),
        writeJson: (file, value, mode) =>
          file.endsWith("mcp-auth.json")
            ? Effect.promise(async () => {
                activeWrites++
                sawOverlap = sawOverlap || activeWrites > 1
                raw = ""
                await sleep(10)
                const next = JSON.stringify(value, null, 2)
                raw = sawOverlap ? `${next}\n}` : next
                activeWrites--
              })
            : fs.writeJson(file, value, mode),
      })
    }),
  ).pipe(Layer.provide(AppNodeBuilder.build(FSUtil.node)))

  return { fsLayer, raw: () => raw }
}

function authService(fsLayer: Layer.Layer<FSUtil.Service>) {
  return McpAuth.Service.use((auth) => Effect.succeed(auth)).pipe(
    Effect.provide(AppNodeBuilder.build(McpAuth.node, [[FSUtil.node, fsLayer]])),
  )
}

test("case and junction aliases share the mcp credential lock", async () => {
  const root = path.join(os.tmpdir(), `mcp-auth-alias-${process.pid}-${Date.now()}`)
  const data = path.join(root, "Data")
  const link = path.join(root, "junction-data")
  const state = path.join(root, "state")
  await fs.mkdir(data, { recursive: true })
  await fs.mkdir(state, { recursive: true })
  if (process.platform === "win32") {
    const linked = spawnSync("cmd", ["/c", "mklink", "/J", link, data], { encoding: "utf8" })
    expect(linked.status).toBe(0)
  } else symlinkSync(data, link, "dir")
  const alias = process.platform === "win32" ? data.toUpperCase() : link
  await fs.writeFile(LockIdentity.marker(state), JSON.stringify({ generation: LockIdentity.generation }))
  const layer = LayerNode.compile(LayerNode.group([McpAuth.node, EffectFlock.node, Global.node]), [
    [Global.node, Global.layerWith({ data: alias, state, config: alias, cache: root })],
  ])
  const runtime = ManagedRuntime.make(layer)
  const held = await runtime.runPromise(
    Effect.gen(function* () {
      const auth = yield* McpAuth.Service
      const flock = yield* EffectFlock.Service
      const global = yield* Global.Service
      const original = yield* flock.key(`mcp-auth:${path.join(data, "mcp-auth.json")}`)
      const aliased = yield* flock.key(`mcp-auth:${path.join(alias, "mcp-auth.json")}`)
      const locks = path.join(state, "locks")
      expect(global.data).toBe(alias)
      yield* flock.acquire(`mcp-auth:${path.join(data, "mcp-auth.json")}`, locks)
      const busy = yield* auth
        .updateTokens("sample", { accessToken: "alias-token" })
        .pipe(Effect.timeoutOption("400 millis"))
      const names = yield* Effect.promise(() => fs.readdir(locks))
      const written = yield* Effect.promise(() =>
        fs.readFile(path.join(alias, "mcp-auth.json"), "utf8").then(() => true, () => false),
      )
      return { original, aliased, busy, names, written, root: global.data }
    }).pipe(Effect.scoped),
  )
  await runtime.dispose()

  expect(held.root).toBe(alias)
  expect(held.original).toBe(held.aliased)
  expect(Option.isNone(held.busy)).toBe(true)
  expect(held.written).toBe(false)
  expect(held.names).toContain(`${Hash.fast(held.original)}.lock`)
  expect(held.names).not.toContain(`${Hash.fast(`mcp-auth:${path.join(alias, "mcp-auth.json")}`)}.lock`)
  await fs.rm(root, { recursive: true, force: true })
})

test("serializes concurrent auth file updates across service instances", async () => {
  const file = authFile()
  await expect(fs.access(LockIdentity.marker(Global.Path.state))).rejects.toThrow()

  await Effect.runPromise(
    Effect.gen(function* () {
      const first = yield* authService(file.fsLayer)
      const second = yield* authService(file.fsLayer)

      yield* Effect.all(
        [
          first.updateTokens("posthog", { accessToken: "access-token" }, "https://mcp.posthog.com/mcp"),
          second.updateClientInfo("posthog", { clientId: "client-id" }, "https://mcp.posthog.com/mcp"),
        ],
        { concurrency: "unbounded" },
      )

      const entry = yield* first.get("posthog")
      expect(entry?.tokens?.accessToken).toBe("access-token")
      expect(entry?.clientInfo?.clientId).toBe("client-id")
      expect(entry?.serverUrl).toBe("https://mcp.posthog.com/mcp")
      expect(() => JSON.parse(file.raw())).not.toThrow()
    }),
  )
})
