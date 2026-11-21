import { expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Cause, Effect, Exit, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Global } from "@opencode-ai/core/global"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { ConfigDocument } from "@opencode-ai/core/config/document"
import { Config } from "../../src/config/config"
import { Auth } from "../../src/auth"
import { Account } from "../../src/account/account"
import { Npm } from "@opencode-ai/core/npm"
import { AuthTest } from "../fake/auth"
import { AccountTest } from "../fake/account"
import { NpmTest } from "../fake/npm"
import { provideInstanceEffect, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(CrossSpawnSpawner.node))
const services = LayerNode.compile(LayerNode.group([Config.node, EffectFlock.node]), [
  [Auth.node, AuthTest.empty], [Account.node, AccountTest.empty], [Npm.node, NpmTest.noop],
])

function isolated<A, E, R>(use: (directory: string) => Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const previous = Global.Path.config
    const keys = ["OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_CONTENT"]
    const env = keys.map((key) => process.env[key])
    ;(Global.Path as { config: string }).config = dir
    for (const key of keys) delete process.env[key]
    yield* Effect.addFinalizer(() => Effect.sync(() => {
      ;(Global.Path as { config: string }).config = previous
      keys.forEach((key, index) => { if (env[index] === undefined) delete process.env[key]; else process.env[key] = env[index] })
    }))
    return yield* use(dir).pipe(provideInstanceEffect(dir), Effect.provide(testInstanceStoreLayer), Effect.provide(services))
  })
}

it.live("I52/I65 first project save creates a document, and schema-free updates never wait on themselves", () => isolated((dir) => Effect.gen(function* () {
  const config = yield* Config.Service
  yield* config.update({ username: "first" }).pipe(Effect.timeout("10 seconds"))
  const file = path.join(dir, "opencode.jsonc")
  expect(JSON.parse(yield* Effect.promise(() => fs.readFile(file, "utf8"))).username).toBe("first")
  yield* Effect.promise(() => fs.writeFile(file, '{"username":"schema-free"}'))
  yield* config.update({ model: "local/chat" }).pipe(provideInstanceEffect(dir), Effect.timeout("10 seconds"))
  expect(JSON.parse(yield* Effect.promise(() => fs.readFile(file, "utf8")))).toMatchObject({ username: "schema-free", model: "local/chat" })
})))

it.live("I60 full global load initializes a missing document through the real publication path", () => isolated((dir) => Effect.gen(function* () {
  const config = yield* Config.Service
  yield* config.getGlobal()
  expect(JSON.parse(yield* Effect.promise(() => fs.readFile(path.join(dir, "opencode.jsonc"), "utf8")))).toEqual({ $schema: "https://opencode.ai/config.json" })
})))

for (const key of ["OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_CONTENT"]) {
  it.live(`I61 ${key} suppresses default initialization`, () => isolated((dir) => Effect.gen(function* () {
    process.env[key] = key === "OPENCODE_CONFIG_CONTENT" ? "{}" : path.join(dir, "explicit")
    const config = yield* Config.Service
    yield* config.getGlobal()
    expect(yield* Effect.promise(() => fs.readdir(dir))).toEqual([])
  })))
}

for (const existing of [false, true]) {
  it.live(`I62 legacy migration ${existing ? "preserves existing JSON values" : "creates JSON"} before retiring TOML`, () => isolated((dir) => Effect.gen(function* () {
    const config = yield* Config.Service
    yield* Effect.promise(() => fs.writeFile(path.join(dir, "config"), 'username = "legacy"\nprovider = "local"\nmodel = "chat"\n'))
    if (existing) yield* Effect.promise(() => fs.writeFile(path.join(dir, "config.json"), '{"username":"current"}'))
    yield* config.getGlobal()
    expect(JSON.parse(yield* Effect.promise(() => fs.readFile(path.join(dir, "config.json"), "utf8")))) .toMatchObject({ username: existing ? "current" : "legacy", model: "local/chat" })
    expect(yield* Effect.promise(() => fs.stat(path.join(dir, "config")).then(() => true, () => false))).toBe(false)
  })))
}

for (const kind of ["default", "schema", "legacy"]) {
  it.live(`I66 ${kind} loader write skips an independently held document lock`, () => isolated((dir) => Effect.gen(function* () {
    const file = path.join(dir, kind === "default" ? "opencode.jsonc" : "config.json")
    if (kind === "schema") yield* Effect.promise(() => fs.writeFile(file, '{"username":"unchanged"}'))
    if (kind === "legacy") yield* Effect.promise(() => fs.writeFile(path.join(dir, "config"), 'username = "legacy"\n'))
    const flock = yield* EffectFlock.Service
    const config = yield* Config.Service
    yield* flock.acquire(ConfigDocument.key(file))
    yield* config.getGlobal().pipe(Effect.timeout("10 seconds"))
    if (kind === "schema") expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe('{"username":"unchanged"}')
    else expect(yield* Effect.promise(() => fs.stat(file).then(() => true, () => false))).toBe(false)
    if (kind === "legacy") expect(yield* Effect.promise(() => fs.readFile(path.join(dir, "config"), "utf8"))).toBe('username = "legacy"\n')
  })))
}

it.live("F29 global and MCP writers reject legacy aliases before changing documents", () => isolated((dir) => Effect.gen(function* () {
  const config = yield* Config.Service
  const alias = path.join(dir, "alias"), file = path.join(dir, "opencode.jsonc")
  const before = '{"mcp":{"sample":{"type":"local","command":["node","kept.js"]}}}'
  yield* Effect.promise(async () => { await fs.writeFile(file, before); await fs.symlink(dir, alias, process.platform === "win32" ? "junction" : "dir") })
  const source = yield* config.mcpSource("sample")
  expect(source).toBeDefined()
  const mcp = yield* config.updateMcp({ name: "sample", source: path.join(alias, "opencode.jsonc"), version: source!.version, patch: { command: ["bad"] } }).pipe(Effect.exit)
  expect(Exit.isFailure(mcp)).toBe(true)
  if (Exit.isFailure(mcp)) expect(Cause.squash(mcp.cause)).toMatchObject({ code: "MCP_SOURCE_ALIAS_UNSUPPORTED" })
  const canonical = Global.Path.config
  ;(Global.Path as { config: string }).config = alias
  const global = yield* config.updateGlobal({ username: "bad" }).pipe(Effect.exit)
  ;(Global.Path as { config: string }).config = canonical
  expect(Exit.isFailure(global)).toBe(true)
  if (Exit.isFailure(global)) expect(Cause.squash(global.cause)).toMatchObject({ code: "CONFIG_PATH_ALIAS_UNSUPPORTED" })
  expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe(before)
  expect((yield* Effect.promise(() => fs.readdir(dir))).filter((name) => name.endsWith(".tmp"))).toEqual([])
})))
