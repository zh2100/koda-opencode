import { ProjectConfig } from "./project-write"
import { ConfigWrite } from "./write-error"
import { ConfigRefresh } from "./refresh"
import { AtomicDocument } from "@opencode-ai/core/config/atomic-document"
import { InstanceWork } from "@/effect/instance-work"
import { ConfigLoaderWrites } from "@/effect/config-loader-mode"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import path from "path"
import { LockIdentity } from "@opencode-ai/core/util/lock-identity"
import os from "os"
import { mergeDeep } from "remeda"
import { Global } from "@opencode-ai/core/global"
import fsNode from "node:fs/promises"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Auth } from "../auth"
import { Env } from "../env"
import { applyEdits, modify } from "jsonc-parser"
import { InstallationLocal, InstallationVersion } from "@opencode-ai/core/installation/version"
import { existsSync } from "fs"
import { Account } from "@/account/account"
import { isRecord } from "@/util/record"
import type { ConsoleState } from "@opencode-ai/core/v1/config/console-state"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceRef } from "@/effect/instance-ref"

import { InstanceState } from "@/effect/instance-state"
import { Cause, Context, Duration, Effect, Exit, Fiber, Layer, Option, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Hash } from "@opencode-ai/core/util/hash"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { ConfigDocument } from "@opencode-ai/core/config/document"
import { McpEditError } from "./mcp-edit"
import { createHash, randomUUID } from "crypto"
import { containsPath, type InstanceContext } from "../project/instance-context"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { RemoteAuthError } from "@opencode-ai/core/v1/config/error"
import { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"
import { ConfigPluginV1 } from "@opencode-ai/core/v1/config/plugin"
import { ConfigAgent } from "./agent"
import { ConfigCommand } from "./command"
import { ConfigManaged } from "./managed"
import { ConfigParse } from "./parse"
import { ConfigPaths } from "./paths"
import { ConfigPlugin } from "./plugin"
import { ConfigVariable } from "./variable"
import { ConfigV2Compat } from "./v2-compat"
import { Npm } from "@opencode-ai/core/npm"
import { withTransientReadRetry } from "@/util/effect-http-client"

// Custom merge function that concatenates array fields instead of replacing them
// Keep remeda's deep conditional merge type out of hot config-loading paths; TS profiling showed it dominates here.
function mergeConfig(target: Info, source: Info): Info {
  return mergeDeep(target, source) as Info
}

function mergeConfigConcatArrays(target: Info, source: Info): Info {
  const merged = mergeConfig(target, source)
  if (target.instructions && source.instructions) {
    merged.instructions = Array.from(new Set([...target.instructions, ...source.instructions]))
  }
  if (target.plugin && source.plugin) merged.plugin = ConfigPlugin.deduplicatePluginOrigins([...target.plugin, ...source.plugin].map((spec) => ({ spec, source: "snapshot", scope: "local" }))).map((item) => item.spec)
  return merged
}

function finishConfig(input: Info, quiet = false) {
  return Effect.gen(function* () {
    const result = { ...input }
    for (const [name, mode] of Object.entries(result.mode ?? {})) {
      result.agent = mergeDeep(result.agent ?? {}, {
        [name]: {
          ...mode,
          mode: "primary" as const,
        },
      })
    }

    if (Flag.OPENCODE_PERMISSION) {
      try {
        result.permission = mergeDeep(result.permission ?? {}, JSON.parse(Flag.OPENCODE_PERMISSION))
      } catch (err) {
        if (!quiet) yield* Effect.logWarning("OPENCODE_PERMISSION contains invalid JSON, skipping")
      }
    }

    if (result.tools) {
      const perms: Record<string, ConfigPermissionV1.Action> = {}
      for (const [tool, enabled] of Object.entries(result.tools)) {
        const action: ConfigPermissionV1.Action = enabled ? "allow" : "deny"
        if (tool === "write" || tool === "edit" || tool === "patch") {
          perms.edit = action
          continue
        }
        perms[tool] = action
      }
      result.permission = mergeDeep(perms, result.permission ?? {})
    }

    if (!result.username) {
      try {
        result.username = os.userInfo().username || "user"
      } catch (err) {
        if (!quiet) yield* Effect.logWarning("failed to read system username, using fallback")
        result.username = "user"
      }
    }

    if (result.autoshare === true && !result.share) {
      result.share = "auto"
    }

    if (Flag.OPENCODE_DISABLE_AUTOCOMPACT) {
      result.compaction = { ...result.compaction, auto: false }
    }
    if (Flag.OPENCODE_DISABLE_PRUNE) {
      result.compaction = { ...result.compaction, prune: false }
    }

    if (!result.mcp?.openaiDeveloperDocs) {
      result.mcp_origins = { ...result.mcp_origins, openaiDeveloperDocs: "builtin:openaiDeveloperDocs" }
      result.mcp = {
        ...result.mcp,
        openaiDeveloperDocs: {
          type: "remote",
          url: "https://developers.openai.com/mcp",
          enabled: true,
        },
      }
    }
    return result
  })
}

function projectWriteError(error: unknown, seen = new Set<unknown>()): ConfigWrite.Error | undefined {
  if (error instanceof ConfigWrite.Error) return error
  if (!error || typeof error !== "object" || seen.has(error)) return
  seen.add(error)
  for (const key of ["cause", "error", "defect", "reason"]) {
    if (!(key in error)) continue
    const found = projectWriteError(Reflect.get(error, key), seen)
    if (found) return found
  }
  if ("reasons" in error && Array.isArray(error.reasons)) {
    for (const reason of error.reasons) {
      const found = projectWriteError(reason, seen)
      if (found) return found
    }
  }
}

function nodeErrorCode(error: unknown): string | undefined {
  if (error instanceof Error && "code" in error && typeof error.code === "string") return error.code
  if (typeof error === "object" && error !== null && "cause" in error) return nodeErrorCode(error.cause)
  return
}

function isSourceReadCode(code: string | undefined) {
  return code === "EACCES" || code === "EPERM" || code === "EIO" || code === "EBUSY"
}

function configLoadError(error: unknown) {
  if (isSourceReadCode(nodeErrorCode(error))) return mcpEditError("MCP_SOURCE_READ_FAILED")
  const named = configParseName(error)
  if (named === "ConfigJsonError" || named === "ConfigInvalidError") return mcpDocumentError()
  return
}

function configParseName(error: unknown) {
  const named = (value: unknown): string | undefined => {
    if (value instanceof Error) return value.name
    if (typeof value === "object" && value !== null && "name" in value && typeof value.name === "string")
      return value.name
    return
  }
  const direct = named(error)
  if (direct === "ConfigJsonError" || direct === "ConfigInvalidError") return direct
  if (typeof error === "object" && error !== null && "cause" in error) return named(error.cause)
  return
}

function readMcpDocument(text: string, source: string) {
  try {
    const parsed = ConfigParse.jsonc(text, source)
    if (!isRecord(parsed)) return
    try {
      return ConfigParse.schema(ConfigV1.Info, parsed, source)
    } catch {
      return ConfigParse.schema(ConfigV1.Info, ConfigV2Compat.lower(parsed, source).value, source)
    }
  } catch {
    return
  }
}

function acceptMcpDocument(text: string, source: string) {
  return readMcpDocument(text, source) !== undefined
}

function configFile(file: string) {
  return file.endsWith(".json") || file.endsWith(".jsonc")
}

function writableMcpSource(source: string) {
  if (!path.isAbsolute(source) || !configFile(source)) return false
  const relative = path.relative(ConfigManaged.managedConfigDir(), source)
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
}

function isMcpEditError(error: unknown): error is McpEditError {
  return typeof error === "object" && error !== null && "_tag" in error && error._tag === "McpEditError"
}

function mcpEditError(code: McpEditError["code"]) {
  return new McpEditError({ code, ref: randomUUID() })
}

const reloadHooks = new Map<(directory?: string, owner?: InstanceContext) => void | Promise<void>, { idempotent?: boolean }>()

export function onConfigReload(hook: (directory?: string, owner?: InstanceContext) => void | Promise<void>, options: { idempotent?: boolean } = {}) {
  reloadHooks.set(hook, options)
  return () => {
    reloadHooks.delete(hook)
  }
}

function mcpDocumentError() {
  return mcpEditError("MCP_DOCUMENT_INVALID")
}

function mcpNames(config: Info, raw?: string) {
  const names = new Set(Object.keys(config.mcp ?? {}))
  if (!raw) return [...names]
  try {
    const parsed = ConfigParse.jsonc(raw, "mcp-source")
    if (isRecord(parsed) && isRecord(parsed.mcp) && isRecord(parsed.mcp.servers)) {
      for (const name of Object.keys(parsed.mcp.servers)) names.add(name)
    }
  } catch {
    return [...names]
  }
  return [...names]
}

function mcpEntry(text: string, source: string, name: string) {
  let parsed: unknown
  try {
    parsed = ConfigParse.jsonc(text, source)
  } catch {
    return { invalid: true as const }
  }
  if (!isRecord(parsed) || !isRecord(parsed.mcp)) return { missing: true as const }
  const flat = parsed.mcp[name]
  const nested = isRecord(parsed.mcp.servers) ? parsed.mcp.servers[name] : undefined
  const entry = isRecord(flat) ? flat : nested
  if (!isRecord(entry)) return { missing: true as const }
  return { entry }
}

function normalizeLoadedConfig(data: unknown) {
  if (!isRecord(data)) return data
  const copy = { ...data }
  const hadLegacy = "theme" in copy || "keybinds" in copy || "tui" in copy
  if (!hadLegacy) return copy
  delete copy.theme
  delete copy.keybinds
  delete copy.tui
  return copy
}

async function substituteWellKnownRemoteConfig(input: {
  value: unknown
  dir: string
  source: string
  env: Record<string, string>
  snapshot?: ProjectConfig.Snapshot
}) {
  if (!isRecord(input.value) || typeof input.value.url !== "string") return undefined

  const url = await ConfigVariable.substitute({
    text: input.value.url,
    type: "virtual",
    dir: input.dir,
    source: input.source,
    env: input.env,
    ...(input.snapshot ? { readText: (file: string) => { input.snapshot!.remoteFiles.add(file); return ProjectConfig.reference(input.snapshot!, file) }, onEnv: (name: string, value: string) => { if (!(name in input.env)) input.snapshot!.env.set(name, value) } } : {}),
  })
  const headers = isRecord(input.value.headers)
    ? Object.fromEntries(
        await Promise.all(
          Object.entries(input.value.headers)
            .filter((entry): entry is [string, string] => typeof entry[1] === "string")
            .map(async ([key, value]) => [
              key,
              await ConfigVariable.substitute({
                text: value,
                type: "virtual",
                dir: input.dir,
                source: input.source,
                env: input.env,
                ...(input.snapshot ? { readText: (file: string) => { input.snapshot!.remoteFiles.add(file); return ProjectConfig.reference(input.snapshot!, file) }, onEnv: (name: string, value: string) => { if (!(name in input.env)) input.snapshot!.env.set(name, value) } } : {}),
              }),
            ]),
        ),
      )
    : undefined

  return { url, headers }
}

async function resolveLoadedPlugins<T extends { plugin?: ConfigPluginV1.Spec[] }>(config: T, filepath: string) {
  if (!config.plugin) return config
  for (let i = 0; i < config.plugin.length; i++) {
    // Normalize path-like plugin specs while we still know which config file declared them.
    // This prevents `./plugin.ts` from being reinterpreted relative to some later merge location.
    config.plugin[i] = await ConfigPlugin.resolvePluginSpec(config.plugin[i], filepath)
  }
  return config
}

type Info = ConfigV1.Info & {
  // plugin_origins is derived state, not a persisted config field. It keeps each winning plugin spec together
  // with the file and scope it came from so later runtime code can make location-sensitive decisions.
  mcp_origins?: Record<string, string>
  plugin_origins?: ConfigPlugin.Origin[]
}

type State = {
  config: Info
  directories: string[]
  deps: Fiber.Fiber<void>[]
  consoleState: ConsoleState
  sources: { id: string; text?: string; contributed: string[] }[]
}

export interface Interface {
  readonly get: () => Effect.Effect<Info>
  readonly getGlobal: () => Effect.Effect<Info>
  readonly mcpSource: (
    name: string,
  ) => Effect.Effect<
    { source: string; version: string; writable: boolean; config: NonNullable<Info["mcp"]>[string] } | undefined,
    McpEditError
  >
  readonly updateMcp: (input: {
    name: string
    source: string
    version: string
    patch: { type?: "local" | "remote"; command?: readonly string[]; url?: string }
  }) => Effect.Effect<void, McpEditError>
  readonly getConsoleState: () => Effect.Effect<ConsoleState>
  readonly preflight: () => Effect.Effect<void, ConfigWrite.Error>
  readonly update: (config: Info) => Effect.Effect<void, ConfigWrite.Error>
  readonly updateGlobal: (config: Info) => Effect.Effect<{ info: Info; changed: boolean }, ConfigWrite.Error>
  readonly invalidate: () => Effect.Effect<void>
  readonly directories: () => Effect.Effect<string[]>
  readonly waitForDependencies: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Config") {}

export const use = serviceUse(Service)

function globalConfigFile() {
  const candidates = ["opencode.jsonc", "opencode.json", "config.json"].map((file) =>
    path.join(Global.Path.config, file),
  )
  for (const file of candidates) {
    if (existsSync(file)) return file
  }
  return candidates[0]
}

function patchJsonc(input: string, patch: unknown, path: string[] = []): string {
  if (isRecord(patch) && Object.keys(patch).length === 0) {
    const original = path.reduce<unknown>((value, key) => isRecord(value) ? value[key] : undefined, ConfigParse.jsonc(input, "config-patch"))
    if (isRecord(original)) return input
    return applyEdits(input, modify(input, path, {}, { formattingOptions: { insertSpaces: true, tabSize: 2 } }))
  }
  if (!isRecord(patch) || (path.length === 1 && path[0] === "image_generation")) {
    const edits = modify(input, path, patch, {
      formattingOptions: {
        insertSpaces: true,
        tabSize: 2,
      },
    })
    return applyEdits(input, edits)
  }

  return Object.entries(patch).reduce((result, [key, value]) => patchJsonc(result, value, [...path, key]), input)
}

function writable(info: Info) {
  const { plugin_origins: _plugin_origins, ...next } = info
  return next
}

function writableGlobal(info: Info) {
  const next = writable(info)
  // When a user changes config from a value back to default in the Desktop app, we don't want to leave a blank `"shell": "",` key
  if ("shell" in next && next.shell === "") return { ...next, shell: undefined }
  return next
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const flock = yield* EffectFlock.Service
    const globalSvc = yield* Global.Service
    const authSvc = yield* Auth.Service
    const accountSvc = yield* Account.Service
    const env = yield* Env.Service
    const npmSvc = yield* Npm.Service
    const http = yield* HttpClient.HttpClient

    const Mutation = Context.Reference<{ committed: boolean } | undefined>("@opencode/ConfigMutation", { defaultValue: () => undefined })
    const publish = (file: string, before: string | undefined, text: string) => Effect.gen(function* () {
      const ticket = yield* Mutation
      return yield* Effect.tryPromise({
        try: () => AtomicDocument.publish({ file, before, text, onCommitted: () => { if (ticket) ticket.committed = true } }),
        catch: (cause) => new FSUtil.FileSystemError({ method: "config.publish", cause }),
      })
    })
    const optionalWrite = <A, E, R>(file: string, body: Effect.Effect<A, E, R>) =>
      InstanceWork.run(ConfigDocument.tryWithLock(flock, file, body).pipe(Effect.provideService(Global.Service, globalSvc)), "config-loader-write")
    const withDocumentLock = <A, E, R>(lock: EffectFlock.Interface, file: string, body: Effect.Effect<A, E, R>) =>
      ConfigDocument.withLock(lock, file, body).pipe(Effect.provideService(Global.Service, globalSvc))
    const mutate = <A, E, R>(body: Effect.Effect<A, E, R>) => Effect.gen(function* () {
      const ctx = yield* InstanceRef
      const ticket = { committed: false }
      return yield* InstanceWork.run(body.pipe(
        Effect.provideService(Mutation, ticket),
        Effect.ensuring(Effect.sync(() => {
          if (!ticket.committed) return
          void InstanceWork.handoff(async () => {
            await Effect.runPromise(invalidateGlobal)
            const results = await Promise.allSettled([...reloadHooks.keys()].map((hook) => Promise.resolve().then(() => hook(ctx?.directory, ctx))))
            if (results.some((result) => result.status === "rejected")) throw new Error("Committed configuration refresh is incomplete")
          }).catch(() => undefined)
        })),
      ))
    })

    // Missing files stay empty. A denied read stays a node error so ordinary config loads keep their error channel.
    const readConfigFile = (filepath: string, snapshot?: ProjectConfig.Snapshot) =>
      snapshot ? ProjectConfig.read(filepath).pipe(Effect.tap((file) => Effect.sync(() => snapshot.files.set(filepath, file))), Effect.map((file) => file.text)) : Effect.tryPromise({
        try: () => fsNode.readFile(filepath, "utf8"),
        catch: (cause) => cause,
      }).pipe(
        Effect.catch((cause) => {
          const code = nodeErrorCode(cause)
          if (code === "ENOENT") return Effect.succeed(undefined)
          if ((code === "EACCES" || code === "EPERM") && Flag.OPENCODE_CONFIG_DIR &&
            path.dirname(filepath) === path.resolve(Flag.OPENCODE_CONFIG_DIR)) return Effect.succeed(undefined)
          return Effect.die(cause)
        }),
      )

    const decodeConfig = Effect.fnUntraced(function* (input: unknown, source: string) {
      const result = ConfigV2Compat.lower(normalizeLoadedConfig(input), source)
      yield* Effect.forEach(result.diagnostics, (diagnostic) =>
        Effect.logWarning("configuration compatibility diagnostic", {
          source,
          path: diagnostic.path,
          kind: diagnostic.kind,
          action: diagnostic.message,
        }),
      )
      return ConfigParse.schema(ConfigV1.Info, result.value, source)
    })

    const fetchRemoteJson = Effect.fnUntraced(function* <S extends Schema.Top>(
      url: string,
      headers: Record<string, string> | undefined,
      schema: S,
      loginOrigin: string,
      snapshot = false,
    ) {
      const response = yield* HttpClient.filterStatusOk(withTransientReadRetry(http))
        .execute(
          HttpClientRequest.get(url).pipe(HttpClientRequest.acceptJson, HttpClientRequest.setHeaders(headers ?? {})),
        )
        .pipe(
          Effect.catch((error) => snapshot ? Effect.fail(ConfigWrite.fail("CONFIG_SOURCE_READ_FAILED")) : Effect.die(new Error(`failed to fetch remote config from ${url}: ${String(error)}`))),
        )
      const body = yield* response.text.pipe(
        Effect.catch((error) => snapshot ? Effect.fail(ConfigWrite.fail("CONFIG_SOURCE_READ_FAILED")) : Effect.die(new Error(`failed to read remote config from ${url}: ${String(error)}`))),
      )
      // An auth proxy can answer with an HTML login page at HTTP 200 (passes filterStatusOk); treat it as a re-auth error, not a decode failure.
      const contentType = (response.headers["content-type"] ?? "").toLowerCase()
      if (contentType.includes("html") || /^\s*<!doctype|^\s*<html/i.test(body)) {
        return yield* (snapshot ? ConfigWrite.fail("CONFIG_SOURCE_READ_FAILED") : Effect.die(new RemoteAuthError({ url: loginOrigin, remote: url })))
      }
      return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(body).pipe(
        Effect.catch((error) => snapshot ? Effect.fail(ConfigWrite.fail("CONFIG_DOCUMENT_INVALID")) : Effect.die(new Error(`failed to decode remote config from ${url}: ${String(error)}`))),
      )
    })

    const loadConfig = Effect.fnUntraced(function* (
      text: string,
      options: { path: string } | { dir: string; source: string },
      env?: Record<string, string>,
      readOnly = false,
      snapshot?: ProjectConfig.Snapshot,
    ) {
      const source = "path" in options ? options.path : options.source
      if (readOnly && !snapshot) return yield* decodeConfig(ConfigParse.jsonc(text, source), source)
      const expanded = yield* Effect.promise(() =>
        ConfigVariable.substitute(
          "path" in options
            ? { text, type: "path", path: options.path, env, ...(snapshot ? { readText: (file: string) => ProjectConfig.reference(snapshot, file), onEnv: (name: string, value: string) => { if (!(name in (env ?? {}))) snapshot.env.set(name, value) } } : {}) }
            : { text, type: "virtual", ...options, env, ...(snapshot ? { readText: (file: string) => ProjectConfig.reference(snapshot, file), onEnv: (name: string, value: string) => { if (!(name in (env ?? {}))) snapshot.env.set(name, value) } } : {}) },
        ),
      )
      const parsed = ConfigParse.jsonc(expanded, source)
      const data = yield* decodeConfig(parsed, source)
      if (snapshot && "path" in options) yield* Effect.promise(() => resolveLoadedPlugins(data, options.path))
      if (snapshot) snapshot.sources.push({ id: source, text, value: data, dir: "path" in options ? path.dirname(options.path) : options.dir, env })
      if (!("path" in options) || readOnly) return data

      yield* Effect.promise(() => resolveLoadedPlugins(data, options.path))
      if (!data.$schema && (yield* ConfigLoaderWrites)) {
        data.$schema = "https://opencode.ai/config.json"
        yield* optionalWrite(
          options.path,
          Effect.gen(function* () {
            // Do not annotate a stale loader snapshot after another writer has committed.
            if ((yield* readConfigFile(options.path)) !== text) return
            const updated = text.replace(/^\s*\{/, '{\n  "$schema": "https://opencode.ai/config.json",')
            yield* publish(options.path, text, updated)
          }),
        ).pipe(Effect.catch(() => Effect.void))
      }
      return data
    })

    const loadFile = Effect.fnUntraced(function* (filepath: string, env?: Record<string, string>, readOnly = false, snapshot?: ProjectConfig.Snapshot) {
      yield* Effect.logInfo("loading", { path: filepath })
      const text = yield* readConfigFile(filepath, snapshot)
      if (text === undefined) {
        snapshot?.sources.push({ id: filepath, value: {}, dir: path.dirname(filepath), env })
        return {} as Info
      }
      return yield* loadConfig(text, { path: filepath }, env, readOnly, snapshot)
    })

    const loadGlobal = Effect.fnUntraced(function* (env?: Record<string, string>, readOnly = false, snapshot?: ProjectConfig.Snapshot) {
      let result: Info = {}
      const canWrite = !readOnly && (yield* ConfigLoaderWrites)
      // Seed the default global config with the schema for editor completion, but avoid writing when the user
      // explicitly routes config through env-provided paths or content.
      if (canWrite && !Flag.OPENCODE_CONFIG && !Flag.OPENCODE_CONFIG_DIR && !process.env.OPENCODE_CONFIG_CONTENT) {
        const file = globalConfigFile()
        if (!existsSync(file)) {
          yield* optionalWrite(
            file,
            Effect.gen(function* () {
              if (existsSync(file)) return
              yield* fs.ensureDir(path.dirname(file))
              yield* publish(file, undefined, JSON.stringify({ $schema: "https://opencode.ai/config.json" }, null, 2))
            }),
          ).pipe(Effect.catch(() => Effect.void))
        }
      }
      if (snapshot) {
        const file = path.join(Global.Path.config, "config")
        const text = yield* readConfigFile(file, snapshot)
        if (text !== undefined) {
          const parsed = Bun.TOML.parse(text) as Record<string, unknown>
          const { provider, model, ...rest } = parsed
          snapshot.sources.push({ id: file, text, dir: Global.Path.config, value: { ...rest, ...(provider && model ? { model: `${provider}/${model}` } : {}) } as Info, env })
        }
      }
      for (const name of ["config.json", "opencode.json", "opencode.jsonc"]) {
        const source = path.join(Global.Path.config, name)
        const next = yield* loadFile(source, env, readOnly, snapshot)
        result = mergeConfig(result, next)
        result.mcp_origins = {
          ...result.mcp_origins,
          ...Object.fromEntries(Object.keys(next.mcp ?? {}).map((key) => [key, source])),
        }
      }

      const legacy = path.join(Global.Path.config, "config")
      if (!canWrite && existsSync(legacy)) {
        const parsed = Bun.TOML.parse((yield* readConfigFile(legacy)) ?? "") as Record<string, unknown>
        const { provider, model, ...rest } = parsed
        result = mergeConfig({ ...rest, ...(provider && model ? { model: `${provider}/${model}` } : {}) } as Info, result)
      }
      if (canWrite && existsSync(legacy)) {
        const file = path.join(Global.Path.config, "config.json")
        yield* optionalWrite(
          file,
          Effect.gen(function* () {
            if (!existsSync(legacy)) return
            const source = yield* Effect.promise(() => fsNode.open(legacy, "r"))
            const captured = yield* Effect.promise(async () => {
              try { return { stat: await source.stat(), text: await source.readFile("utf8") } }
              finally { await source.close() }
            })
            const { provider, model, ...rest } = Bun.TOML.parse(captured.text) as Record<string, unknown>
            const defaults = {
              ...rest,
              ...(provider && model ? { model: `${provider}/${model}` } : {}),
              $schema: "https://opencode.ai/config.json",
            }
            const before = yield* readConfigFile(file)
            // Persist only raw references. A committed JSON setting wins over legacy defaults.
            const current = before ? ConfigParse.jsonc(before, file) : {}
            const document = mergeConfig(defaults, isRecord(current) ? (current as Info) : {})
            yield* publish(file, before, JSON.stringify(document, null, 2))
            result = mergeConfig(defaults, result)
            yield* Effect.tryPromise({
              try: () => AtomicDocument.retire(legacy, {
                dev: captured.stat.dev, ino: captured.stat.ino,
                digest: createHash("sha256").update(captured.text).digest("hex"),
              }),
              catch: () => new Error("Committed legacy migration cleanup remains pending"),
            }).pipe(Effect.catch(() => Effect.logWarning("committed legacy migration cleanup remains pending")))
          }),
        ).pipe(Effect.catchCause((cause) => (Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.void)))
      }

      return result
    })

    const [cachedGlobal, invalidateGlobal] = yield* Effect.cachedInvalidateWithTTL(
      loadGlobal().pipe(
        Effect.tapError((error) =>
          Effect.logError("failed to load global config, using defaults", { error: String(error) }),
        ),
        Effect.orElseSucceed((): Info => ({})),
      ),
      Duration.infinity,
    )

    const getGlobal = Effect.fn("Config.getGlobal")(function* () {
      return yield* cachedGlobal
    })

    const ensureGitignore = Effect.fn("Config.ensureGitignore")(function* (dir: string) {
      yield* fs.ensureDir(dir)
      const gitignore = path.join(dir, ".gitignore")
      const hasIgnore = yield* fs.existsSafe(gitignore)
      if (!hasIgnore) {
        yield* fs
          .writeFileString(
            gitignore,
            ["node_modules", "package.json", "package-lock.json", "bun.lock", ".gitignore"].join("\n"),
          )
          .pipe(
            Effect.catchIf(
              (e) => e.reason._tag === "PermissionDenied",
              () => Effect.void,
            ),
          )
      }
    })

    const loadedEnvironment = new WeakMap<InstanceContext, { content?: string; file?: string }>()

    const loadInstanceState = Effect.fn("Config.loadInstanceState")(
      function* (ctx: InstanceContext, readOnly = false, snapshot?: ProjectConfig.Snapshot) {
        const readSource = (text: string, options: { path: string } | { dir: string; source: string }, values?: Record<string, string>) =>
          loadConfig(text, options, values, readOnly, snapshot)
        // A source snapshot shares discovery and merge order, without runtime preparation.
        const auth = yield* authSvc.all().pipe(Effect.orDie)
        if (snapshot) {
          const before = JSON.stringify(auth)
          snapshot.checks.push(async () => JSON.stringify(await Effect.runPromise(authSvc.all())) === before)
        }

        let result: Info = {}
        const sources: { id: string; text?: string; contributed: string[] }[] = []
        const recordSource = (id: string, text?: string, contributed: string[] = []) => {
          if (text === undefined && path.isAbsolute(id) && !id.endsWith(".json") && !id.endsWith(".jsonc")) return
          const index = sources.findIndex((item) => item.id === id)
          if (index >= 0) {
            const current = sources[index]
            sources.splice(index, 1)
            sources.push({
              id,
              text: text === undefined || text.length === 0 ? current?.text : text,
              contributed: [...new Set([...(current?.contributed ?? []), ...contributed])],
            })
            return
          }
          sources.push({ id, text, contributed })
        }
        const authEnv: Record<string, string> = {}
        const consoleManagedProviders = new Set<string>()
        let activeOrgName: string | undefined

        const pluginScopeForSource = Effect.fnUntraced(function* (source: string) {
          if (source.startsWith("http://") || source.startsWith("https://")) return "global"
          if (source === "OPENCODE_CONFIG_CONTENT") return "local"
          if (containsPath(source, ctx)) return "local"
          return "global"
        })

        const mergePluginOrigins = Effect.fnUntraced(function* (
          source: string,
          // mergePluginOrigins receives raw Specs from one config source, before provenance for this merge step
          // is attached.
          list: ConfigPluginV1.Spec[] | undefined,
          // Scope can be inferred from the source path, but some callers already know whether the config should
          // behave as global or local and can pass that explicitly.
          kind?: ConfigPlugin.Scope,
        ) {
          if (!list?.length) return
          const hit = kind ?? (yield* pluginScopeForSource(source))
          // Merge newly seen plugin origins with previously collected ones, then dedupe by plugin identity while
          // keeping the winning source/scope metadata for downstream installs, writes, and diagnostics.
          const plugins = ConfigPlugin.deduplicatePluginOrigins([
            ...(result.plugin_origins ?? []),
            ...list.map((spec) => ({ spec, source, scope: hit })),
          ])
          result.plugin = plugins.map((item) => item.spec)
          result.plugin_origins = plugins
        })

        const merge = (source: string, next: Info, kind?: ConfigPlugin.Scope, raw?: string) => {
          recordSource(source, raw, mcpNames(next, raw))
          result = mergeConfigConcatArrays(result, next)
          result.mcp_origins = {
            ...result.mcp_origins,
            ...Object.fromEntries(
              Object.keys(next.mcp ?? {}).map((name) => [name, next.mcp_origins?.[name] ?? source]),
            ),
          }
          return mergePluginOrigins(source, next.plugin, kind)
        }

        for (const [key, value] of Object.entries(auth)) {
          if (value.type === "wellknown") {
            const url = key.replace(/\/+$/, "")
            authEnv[value.key] = value.token
            const wellknownURL = `${url}/.well-known/opencode`
            if (!snapshot) yield* Effect.logDebug("fetching remote config", { url: wellknownURL })
            const wellknown = yield* fetchRemoteJson(wellknownURL, undefined, ConfigV1.WellKnown, url, Boolean(snapshot))
            const remote = yield* Effect.promise(() =>
              substituteWellKnownRemoteConfig({
                value: wellknown.remote_config,
                dir: url,
                source: wellknownURL,
                env: authEnv,
                snapshot,
              }),
            )
            const fetchedConfig = remote
              ? yield* Effect.gen(function* () {
                  if (!snapshot) yield* Effect.logDebug("fetching remote config", { url: remote.url })
                  const data = yield* fetchRemoteJson(remote.url, remote.headers, Schema.Json, url, Boolean(snapshot))
                  if (isRecord(data) && isRecord(data.config)) return data.config
                  if (isRecord(data)) return data
                  return yield* (snapshot ? ConfigWrite.fail("CONFIG_DOCUMENT_INVALID") : Effect.die(
                    new Error(`failed to decode remote config from ${remote.url}: expected object`),
                  ))
                })
              : {}
            const remoteConfig = mergeConfig(isRecord(wellknown.config) ? wellknown.config : {}, fetchedConfig)
            if (!remoteConfig.$schema) remoteConfig.$schema = "https://opencode.ai/config.json"
            const source = wellknownURL
            // Keep the pre-substitution document. Runtime load still expands credentials for connections.
            const raw = JSON.stringify(remoteConfig)
            const next = yield* readSource(
              raw,
              {
                dir: path.dirname(source),
                source,
              },
              authEnv,
            )
            yield* merge(source, next, "global", raw)
            if (!snapshot) yield* Effect.logDebug("loaded remote config from well-known", { url })
          }
        }

        const globalStart = snapshot?.sources.length ?? 0
        const global = readOnly ? yield* loadGlobal(authEnv, true, snapshot) : Object.keys(authEnv).length ? yield* loadGlobal(authEnv) : yield* getGlobal()
        if (snapshot) for (const source of snapshot.sources.slice(globalStart)) source.group = "global"
        for (const name of ["config.json", "opencode.json", "opencode.jsonc"]) {
          recordSource(path.join(Global.Path.config, name))
        }
        yield* merge(Global.Path.config, global, "global")

        const customConfig = process.env.OPENCODE_CONFIG
        if (customConfig) {
          const text = yield* readConfigFile(customConfig, snapshot)
          const next = text !== undefined ? yield* readSource(text, { path: customConfig }, authEnv) : (snapshot?.sources.push({ id: customConfig, value: {}, dir: path.dirname(customConfig), env: authEnv }), {} as Info)
          yield* merge(customConfig, next, undefined, text)
          yield* Effect.logDebug("loaded custom config", { path: customConfig })
        }

        if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG) {
          for (const file of yield* ConfigPaths.files("opencode", ctx.directory, ctx.worktree, Boolean(snapshot)).pipe(Effect.orDie)) {
            const text = yield* readConfigFile(file, snapshot)
            const next = text !== undefined ? yield* readSource(text, { path: file }, authEnv) : (snapshot?.sources.push({ id: file, value: {}, dir: path.dirname(file), env: authEnv }), {} as Info)
            yield* merge(file, next, "local", text)
          }
        }

        result.agent = result.agent || {}
        result.mode = result.mode || {}
        result.plugin = result.plugin || []

        const directories = yield* ConfigPaths.directories(ctx.directory, ctx.worktree, Boolean(snapshot))

        if (Flag.OPENCODE_CONFIG_DIR) {
          yield* Effect.logDebug("loading config from OPENCODE_CONFIG_DIR", { path: Flag.OPENCODE_CONFIG_DIR })
        }

        const deps: Fiber.Fiber<void>[] = []

        for (const dir of directories) {
          let hasConfigFile = false
          const plugins = yield* Effect.promise(() => ConfigPlugin.load(dir))
          if (dir.endsWith(".opencode") || dir === Flag.OPENCODE_CONFIG_DIR) {
            for (const file of ["opencode.json", "opencode.jsonc"]) {
              const source = path.join(dir, file)
              yield* Effect.logDebug(`loading config from ${source}`)
              const text = yield* readConfigFile(source, snapshot)
              hasConfigFile ||= text !== undefined
              const next = text !== undefined ? yield* readSource(text, { path: source }, authEnv) : (snapshot?.sources.push({ id: source, value: {}, dir: path.dirname(source), env: authEnv }), {} as Info)
              yield* merge(source, next, undefined, text)
              result.agent ??= {}
              result.mode ??= {}
              result.plugin ??= []
            }
          }

          if (readOnly) {
            if (snapshot) {
              for (const list of [() => ConfigCommand.paths(dir), () => ConfigAgent.paths(dir), () => ConfigAgent.paths(dir, true)]) {
                const before = JSON.stringify(yield* Effect.promise(list))
                snapshot.checks.push(async () => JSON.stringify(await list()) === before)
              }
              const readText = (file: string) => ProjectConfig.reference(snapshot, file)
              const derived: Info = {
                command: yield* Effect.promise(() => ConfigCommand.load(dir, readText)),
                agent: mergeDeep(yield* Effect.promise(() => ConfigAgent.load(dir, readText)), yield* Effect.promise(() => ConfigAgent.loadMode(dir, readText))),
                plugin: yield* Effect.promise(() => ConfigPlugin.load(dir)),
              }
              const plugins = JSON.stringify(derived.plugin)
              snapshot.checks.push(async () => JSON.stringify(await ConfigPlugin.load(dir)) === plugins)
              snapshot.sources.push({ id: `directory:${dir}`, dir, value: derived })
            }
            continue
          }

          if (hasConfigFile || plugins.length > 0 || Flag.OPENCODE_CONFIG_DIR) {
            yield* ensureGitignore(dir).pipe(Effect.orDie)

            const dep = yield* InstanceWork.run(npmSvc
              .install(dir, {
                add: [
                  {
                    name: "@opencode-ai/plugin",
                    version: InstallationLocal ? undefined : InstallationVersion,
                  },
                ],
              }), "config-dependency-install")
              .pipe(
                Effect.exit,
                Effect.tap((exit) =>
                  Exit.isFailure(exit)
                    ? Effect.logWarning("background dependency install failed", { dir, error: String(exit.cause) })
                    : Effect.void,
                ),
                Effect.asVoid,
                Effect.forkDetach,
              )
            deps.push(dep)
          }

          result.command = mergeDeep(result.command ?? {}, yield* Effect.promise(() => ConfigCommand.load(dir)))
          result.agent = mergeDeep(result.agent ?? {}, yield* Effect.promise(() => ConfigAgent.load(dir)))
          result.agent = mergeDeep(result.agent ?? {}, yield* Effect.promise(() => ConfigAgent.loadMode(dir)))
          // Auto-discovered plugins under `.opencode/plugin(s)` are already local files, so ConfigPlugin.load
          // returns normalized Specs and we only need to attach origin metadata here.
          const list = yield* Effect.promise(() => ConfigPlugin.load(dir))
          yield* mergePluginOrigins(dir, list)
        }

        const envContent = process.env.OPENCODE_CONFIG_CONTENT
        if (envContent) {
          const source = "OPENCODE_CONFIG_CONTENT"
          const raw = envContent
          const next = yield* readSource(raw, {
            dir: ctx.directory,
            source,
          })
          yield* merge(source, next, "local", raw)
          yield* Effect.logDebug("loaded custom config from OPENCODE_CONFIG_CONTENT")
        }

        const activeAccount = Option.getOrUndefined(
          yield* accountSvc.active().pipe(Effect.catch(() => snapshot ? Effect.fail(ConfigWrite.fail("CONFIG_SOURCE_READ_FAILED")) : Effect.succeed(Option.none()))),
        )
        if (snapshot) {
          const before = JSON.stringify(activeAccount)
          snapshot.checks.push(async () => JSON.stringify(Option.getOrUndefined(await Effect.runPromise(accountSvc.active()))) === before)
        }
        if (activeAccount?.active_org_id) {
          const accountID = activeAccount.id
          const orgID = activeAccount.active_org_id
          const url = activeAccount.url
          yield* Effect.gen(function* () {
            const [configOpt, tokenOpt] = yield* Effect.all(
              [accountSvc.config(accountID, orgID), accountSvc.token(accountID)],
              { concurrency: 2 },
            )
            if (Option.isSome(tokenOpt) && !readOnly) {
              process.env["OPENCODE_CONSOLE_TOKEN"] = tokenOpt.value
              yield* env.set("OPENCODE_CONSOLE_TOKEN", tokenOpt.value)
            }

            if (Option.isSome(configOpt)) {
              const source = `${url}/api/config`
              // Account config is already the organization's document. Do not stringify it again after substitution.
              const raw = JSON.stringify(configOpt.value)
              const next = yield* readSource(raw, {
                dir: path.dirname(source),
                source,
              }, { ...authEnv, ...(Option.isSome(tokenOpt) ? { OPENCODE_CONSOLE_TOKEN: tokenOpt.value } : {}) })
              for (const providerID of Object.keys(next.provider ?? {})) {
                consoleManagedProviders.add(providerID)
              }
              yield* merge(source, next, "global", raw)
            }
          }).pipe(
            Effect.withSpan("Config.loadActiveOrgConfig"),
            Effect.catch((err) => snapshot ? Effect.fail(ConfigWrite.fail("CONFIG_SOURCE_READ_FAILED")) :
              Effect.logDebug("failed to fetch remote account config", {
                error: err instanceof Error ? err.message : String(err),
              }),
            ),
          )
        }

        const managedDir = ConfigManaged.managedConfigDir()
        if (existsSync(managedDir)) {
          for (const file of ["opencode.json", "opencode.jsonc"]) {
            const source = path.join(managedDir, file)
            const text = yield* readConfigFile(source, snapshot)
            yield* merge(source, text !== undefined ? yield* readSource(text, { path: source }) : (snapshot?.sources.push({ id: source, value: {}, dir: path.dirname(source) }), {}), "global", text)
          }
        }

        // macOS managed preferences (.mobileconfig deployed via MDM) override everything
        const managed = yield* Effect.promise(() => ConfigManaged.readManagedPreferences())
        if (snapshot) {
          const before = JSON.stringify(managed)
          snapshot.checks.push(async () => JSON.stringify(await ConfigManaged.readManagedPreferences()) === before)
        }
        if (managed) {
          yield* merge(
            managed.source,
            yield* readSource(managed.text, {
              dir: path.dirname(managed.source),
              source: managed.source,
            }),
            "global",
            managed.text,
          )
        }

        result = yield* finishConfig(result, Boolean(snapshot))

        return {
          config: result,
          directories,
          deps,
          sources,
          consoleState: {
            consoleManagedProviders: Array.from(consoleManagedProviders),
            activeOrgName,
            switchableOrgCount: 0,
          },
        }
      },
      Effect.provideService(FSUtil.Service, fs),
    )

    const state = yield* InstanceState.make<State>(
      Effect.fn("Config.state")(function* (ctx) {
        // A directory owns its attempted version, including failed loads.
        // Refreshing A must not make B's older cache appear current.
        loadedEnvironment.set(ctx, { content: process.env.OPENCODE_CONFIG_CONTENT, file: process.env.OPENCODE_CONFIG })
        return yield* loadInstanceState(ctx).pipe(Effect.orDie)
      }),
    )

    const get = Effect.fn("Config.get")(function* () {
      // A failed load records the environment document that was current when it started.
      // Drop that failure before serving a request whose environment has since changed.
      const ctx = yield* InstanceState.context
      const loaded = loadedEnvironment.get(ctx)
      if (loaded && (process.env.OPENCODE_CONFIG_CONTENT !== loaded.content || process.env.OPENCODE_CONFIG !== loaded.file)) {
        yield* InstanceState.invalidate(state)
      }
      return yield* InstanceState.use(state, (s) => s.config).pipe(
        Effect.catch((error) => (isMcpEditError(error) ? Effect.die(error) : Effect.fail(error))),
      )
    })

    const directories = Effect.fn("Config.directories")(function* () {
      return yield* InstanceState.use(state, (s) => s.directories)
    })

    const getConsoleState = Effect.fn("Config.getConsoleState")(function* () {
      return yield* InstanceState.use(state, (s) => s.consoleState)
    })

    const waitForDependencies = Effect.fn("Config.waitForDependencies")(function* () {
      yield* InstanceState.useEffect(state, (s) =>
        Effect.forEach(s.deps, Fiber.join, { concurrency: "unbounded" }).pipe(Effect.asVoid),
      )
    })

    const projectRefresh = ConfigRefresh.make()
    const preflight = Effect.fn("Config.preflight")(function* () {
      const ctx = yield* InstanceState.context
      yield* ProjectConfig.signal(ctx, "preflight")
      if (Flag.OPENCODE_DISABLE_PROJECT_CONFIG) return yield* ConfigWrite.fail("CONFIG_PROJECT_DISABLED")
      const locals = ProjectConfig.localFiles(ctx.directory)
      const root = yield* Effect.try({ try: () => ConfigDocument.canonical(ctx.directory), catch: () => ConfigWrite.fail("CONFIG_SOURCE_READ_FAILED") })
      for (const file of locals) {
        const target = yield* Effect.try({ try: () => ConfigDocument.canonical(file), catch: () => ConfigWrite.fail("CONFIG_SOURCE_READ_FAILED") })
        const relative = path.relative(root, target)
        if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return yield* ConfigWrite.fail("CONFIG_TARGET_OUTSIDE_PROJECT")
        yield* ConfigDocument.describe(file).pipe(Effect.provideService(Global.Service, globalSvc), Effect.mapError((error) => ConfigWrite.fail(error._tag === "ConfigDocumentAliasUnsupported" ? "CONFIG_PATH_ALIAS_UNSUPPORTED" : "CONFIG_SOURCE_READ_FAILED")))
      }
      const snapshot = ProjectConfig.create()
      yield* safeProjectLoad(loadInstanceState(ctx, true, snapshot))
      const selected = snapshot.sources.filter((source) => locals.includes(source.id) && source.text !== undefined).at(-1)
      const target = selected ? snapshot.files.get(selected.id) : undefined
      if (target?.mode !== undefined && !(target.mode & 0o222)) return yield* ConfigWrite.fail("CONFIG_SOURCE_READ_ONLY")
      snapshot.layout = yield* ProjectConfig.layout(ctx).pipe(Effect.provideService(FSUtil.Service, fs), Effect.mapError(() => ConfigWrite.fail("CONFIG_SOURCE_READ_FAILED")))
      return snapshot
    })
    const safeProjectLoad = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.catchCause((cause): Effect.Effect<never, ConfigWrite.Error> => {
      if (Cause.hasInterrupts(cause)) return Effect.failCause(cause as Cause.Cause<never>)
      const error = Cause.squash(cause)
      const known = projectWriteError(error)
      if (known) return Effect.fail(known)
      if (nodeErrorCode(error)) return Effect.fail(ConfigWrite.fail("CONFIG_SOURCE_READ_FAILED"))
      if (configParseName(error)) return Effect.fail(ConfigWrite.fail("CONFIG_DOCUMENT_INVALID"))
      // Unknown failures remain opaque causes; they are never advertised as a recoverable write error.
      return Effect.failCause(cause as Cause.Cause<never>)
    }))
    const decodeProjectSource = (text: string, source: ProjectConfig.Source, snapshot: ProjectConfig.Snapshot, documents?: Map<string, string | undefined>) =>
      Effect.tryPromise({
        try: () => ConfigVariable.substitute({ text, type: "virtual", source: source.id, dir: source.dir, env: source.env,
          readText: async (file) => {
            const target = ConfigDocument.canonical(file)
            if (documents?.has(target)) {
              const value = documents.get(target)
              if (value === undefined || value.includes(`{file:`) && target === ConfigDocument.canonical(source.id)) throw ConfigWrite.fail("CONFIG_PATCH_INVALID")
              return value
            }
            return ProjectConfig.reference(snapshot, file)
          },
          onEnv: (name, value) => { if (!(name in (source.env ?? {}))) snapshot.env.set(name, value) },
        }),
        catch: (error) => projectWriteError(error) ?? ConfigWrite.fail(isSourceReadCode(nodeErrorCode(error)) ? "CONFIG_SOURCE_READ_FAILED" : "CONFIG_DOCUMENT_INVALID"),
      }).pipe(Effect.flatMap((expanded) => Effect.try({
        try: () => ConfigParse.schema(ConfigV1.Info, ConfigV2Compat.lower(normalizeLoadedConfig(ConfigParse.jsonc(expanded, source.id)), source.id).value, source.id),
        catch: () => ConfigWrite.fail("CONFIG_DOCUMENT_INVALID"),
      })), Effect.flatMap((data) => path.isAbsolute(source.id) ? Effect.tryPromise({ try: () => resolveLoadedPlugins(data, source.id), catch: () => ConfigWrite.fail("CONFIG_PATCH_INVALID") }) : Effect.succeed(data)))
    const update = (config: Info) => InstanceWork.preparing((admit) => Effect.gen(function* () {
      const ctx = yield* InstanceState.context
      const snapshot = yield* preflight()
      const ticket = { committed: false, reservation: undefined as ReturnType<typeof projectRefresh.reserve> | undefined }
      const hooks = [...reloadHooks]
      const steps: ConfigRefresh.Step[] = [
        { id: invalidateGlobal, retryable: true, run: () => Effect.runPromise(invalidateGlobal) },
        { id: state, retryable: true, run: () => Effect.runPromise(InstanceState.invalidateOwned(state, ctx)) },
        ...hooks.map(([hook, options]) => ({ id: hook, retryable: options.idempotent === true, run: () => Promise.resolve().then(() => hook(ctx.directory, ctx)) })),
      ]
      yield* ProjectConfig.write({ ctx, snapshot, patch: writable(config), flock,
        admit: Effect.try({ try: () => { ticket.reservation = projectRefresh.reserve(ctx, steps, () => Effect.runPromise(ProjectConfig.signal(ctx, "handoff"))) }, catch: (error) => error instanceof ConfigWrite.Error ? error : ConfigWrite.fail("CONFIG_REFRESH_CAPACITY_EXHAUSTED") }).pipe(Effect.andThen(admit)),
        merge: (sources) => {
          const values: Info[] = []
          for (const source of sources) {
            if (source.group === "global" && values.length && sources[sources.indexOf(source) - 1]?.group === "global") values[values.length - 1] = mergeConfig(values.at(-1)!, source.value)
            else values.push(source.value)
          }
          return finishConfig(values.reduce(mergeConfigConcatArrays, {}), true)
        },
        decode: decodeProjectSource,
        edit: (text, patch) => patchJsonc(text, patch),
        onCommitted: () => { ticket.committed = true },
      }).pipe(Effect.provideService(Global.Service, globalSvc), Effect.ensuring(Effect.sync(() => {
        if (!ticket.committed) { ticket.reservation?.release(); return }
        void ticket.reservation!.start().catch(() => undefined)
      })))
    })).pipe(Effect.provideService(FSUtil.Service, fs), Effect.mapError((error) => error._tag === "InstanceWorkAdmissionClosed" ? ConfigWrite.fail("CONFIG_SOURCE_CHANGED") : error))

    const invalidate = Effect.fn("Config.invalidate")(function* () {
      yield* invalidateGlobal
      const ctx = yield* InstanceRef
      if (!ctx) return
      yield* InstanceState.invalidate(state)
    })

    const updateGlobal = Effect.fn("Config.updateGlobal")(function* (config: Info) {
      const file = globalConfigFile()
      const result = yield* withDocumentLock(
        flock,
        file,
        Effect.gen(function* () {
          const previous = yield* readConfigFile(file)
          const before = previous ?? "{}"
          const patch = writableGlobal(config)

          let next: Info
          let changed: boolean
          if (!file.endsWith(".jsonc")) {
            const existing = ConfigParse.jsonc(before, file)
            ConfigParse.schema(ConfigV1.Info, ConfigV2Compat.lower(normalizeLoadedConfig(existing), file).value, file)
            const merged = mergeDeep(isRecord(existing) ? existing : {}, patch)
            // Image API acknowledgment and model selection are one explicit setting, not a partial merge.
            if (patch.image_generation !== undefined) merged.image_generation = patch.image_generation
            const serialized = JSON.stringify(merged, null, 2)
            next = yield* decodeConfig(merged, file)
            changed = serialized !== before
            if (changed) yield* publish(file, previous, serialized).pipe(Effect.orDie)
          } else {
            const updated = patchJsonc(before, patch)
            next = yield* decodeConfig(ConfigParse.jsonc(updated, file), file)
            changed = updated !== before
            if (changed) yield* publish(file, previous, updated).pipe(Effect.orDie)
          }

          return { info: next, changed }
        }),
      ).pipe(Effect.catchCause((cause): Effect.Effect<never, ConfigWrite.Error> => {
        const error = Cause.squash(cause)
        if (error instanceof ConfigDocument.AliasUnsupported) return Effect.fail(ConfigWrite.fail("CONFIG_PATH_ALIAS_UNSUPPORTED"))
        return Effect.failCause(cause as Cause.Cause<never>)
      }))
      if (result.changed) yield* invalidate().pipe(Effect.catchCause(() => Effect.logWarning("committed global config refresh remains pending")))
      return result
    })

    const readRawText = (file: string) =>
      Effect.tryPromise({
        try: () => fsNode.readFile(file, "utf8"),
        catch: (cause) => {
          if (nodeErrorCode(cause) === "ENOENT") return mcpEditError("MCP_SOURCE_MISSING")
          return mcpEditError("MCP_SOURCE_READ_FAILED")
        },
      })

    const sourceDependencies = new Map<string, { source: string; files: string[] }>()

    const mcpSource = Effect.fn("Config.mcpSource")(function* (name: string) {
      const currentEnv = process.env.OPENCODE_CONFIG_CONTENT
      const ctx = yield* InstanceState.context
      // Flag snapshots these at module load. Compare the live process values before rebuilding a source.
      const loaded = yield* loadInstanceState(ctx, true).pipe(
        Effect.catchCause((cause) => {
          const mapped = configLoadError(Cause.squash(cause))
          return mapped ? Effect.fail(mapped) : Effect.die(cause)
        }),
      )
      const config = loaded.config
      const source = config.mcp_origins?.[name]
      const runtime = config.mcp?.[name]
      if (source === "OPENCODE_CONFIG_CONTENT" && currentEnv === undefined) return
      if (!source || !runtime) return
      const dependencyKey = JSON.stringify([ctx.directory, name])
      const previous = sourceDependencies.get(dependencyKey)
      if (previous?.source === source) {
        for (const file of previous.files) {
          yield* readRawText(file).pipe(Effect.mapError(() => mcpEditError("MCP_SOURCE_READ_FAILED")))
        }
      }
      if (source.startsWith("builtin:")) return { source, version: "", writable: false, config: runtime }
      const writable = writableMcpSource(source)
      const sameSource = (id: string) =>
        path.isAbsolute(source) && path.isAbsolute(id) ? path.resolve(id) === path.resolve(source) : id === source
      // Stop at the winner's last participation. A later ancestor must not replace the winning URL.
      const lastWinner = loaded.sources.findLastIndex((item) => sameSource(item.id))
      const chain = loaded.sources
        .slice(0, lastWinner + 1)
        .filter((item) => sameSource(item.id) || item.contributed.includes(name))
      if (!chain.some((item) => sameSource(item.id))) return yield* mcpEditError("MCP_SOURCE_READ_FAILED")
      // One read supplies both the merge and the version. A later existence check must not sample a different file.
      const winningText = writable
        ? yield* readRawText(source).pipe(
            Effect.catchIf(
              (error) => error.code === "MCP_SOURCE_MISSING",
              () => Effect.succeed(undefined),
            ),
          )
        : undefined
      if (writable && winningText === undefined) return
      if (!writable && path.isAbsolute(source) && configFile(source)) {
        const current = yield* readRawText(source).pipe(
          Effect.catchIf(
            (error) => error.code === "MCP_SOURCE_MISSING",
            () => Effect.succeed(undefined),
          ),
        )
        if (current === undefined) return
      }
      // Sample environment content once. Merge that sample at the chain position; do not replace the accumulated entry.
      const envText = chain.some((item) => item.id === "OPENCODE_CONFIG_CONTENT") ? currentEnv : undefined
      if (source === "OPENCODE_CONFIG_CONTENT" && !envText) return

      let raw: Record<string, unknown> | undefined
      let version = ""
      let missingRequired = false
      const headers: Record<string, unknown> = {}
      for (const item of chain) {
        const winning = sameSource(item.id)
        const required = item.contributed.includes(name)
        // A recorded contribution must be reread. Cached text cannot hide a file deleted after the instance loaded.
        const text =
          winning && writable
            ? winningText
            : item.id === "OPENCODE_CONFIG_CONTENT"
              ? envText
              : path.isAbsolute(item.id) && configFile(item.id)
                ? yield* readRawText(item.id).pipe(
                    Effect.catchIf(
                      (error) => error.code === "MCP_SOURCE_MISSING" && !required,
                      () => Effect.succeed(undefined),
                    ),
                    Effect.mapError((error) =>
                      error.code === "MCP_SOURCE_MISSING" ? mcpEditError("MCP_SOURCE_READ_FAILED") : error,
                    ),
                  )
                : item.text
        if (text === undefined) {
          if (required || winning) missingRequired = true
          continue
        }

        const parsed = mcpEntry(text, item.id, name)
        if ("invalid" in parsed) {
          if (path.isAbsolute(item.id) && !(yield* fs.existsSafe(item.id))) {
            return yield* mcpEditError("MCP_SOURCE_READ_FAILED")
          }
          return yield* mcpEditError("MCP_DOCUMENT_INVALID")
        }
        if (winning) version = Hash.fast(text)
        if (!("entry" in parsed) || !isRecord(parsed.entry)) {
          if (winning) return
          continue
        }
        const entry = parsed.entry
        if (isRecord(entry.headers)) Object.assign(headers, entry.headers)
        raw = mergeDeep(raw ?? {}, entry)
      }
      if (raw && Object.keys(headers).length > 0) {
        raw.headers = { ...(isRecord(raw.headers) ? raw.headers : {}), ...headers }
      }
      if (missingRequired) return yield* mcpEditError("MCP_SOURCE_READ_FAILED")
      if (!raw) return yield* mcpEditError("MCP_SOURCE_READ_FAILED")
      const decoded = ConfigParse.schema(ConfigV1.Info, { mcp: { [name]: raw } }, source).mcp?.[name]
      if (!decoded) return yield* mcpEditError("MCP_DOCUMENT_INVALID")
      sourceDependencies.set(dependencyKey, {
        source,
        files: chain.filter((item) => item.id !== source && item.contributed.includes(name) && path.isAbsolute(item.id)).map((item) => item.id),
      })
      return { source, version, writable, config: decoded }
    })

    const updateMcp = (input: {
      name: string
      source: string
      version: string
      patch: { type?: "local" | "remote"; command?: readonly string[]; url?: string }
    }) =>
      Effect.gen(function* () {
        if (!writableMcpSource(input.source)) return yield* mcpEditError("MCP_SOURCE_READ_ONLY")
        yield* withDocumentLock(
          flock,
          input.source,
          Effect.gen(function* () {
            // Existence, then writability and identity, then version. A stale cache must not look editable.
            const current = yield* mcpSource(input.name)
            if (!current) return yield* mcpEditError("MCP_SOURCE_MISSING")
            if (!current.writable) return yield* mcpEditError("MCP_SOURCE_READ_ONLY")
            if (!LockIdentity.samePath(current.source, input.source)) return yield* mcpEditError("MCP_SOURCE_CHANGED")
            const before = yield* readConfigFile(current.source)
            if (!before) return yield* mcpEditError("MCP_SOURCE_MISSING")
            if (Hash.fast(before) !== input.version) return yield* mcpEditError("MCP_VERSION_CONFLICT")
            let raw: unknown
            try {
              raw = ConfigParse.jsonc(before, current.source)
            } catch {
              return yield* mcpEditError("MCP_DOCUMENT_INVALID")
            }
            if (!readMcpDocument(before, current.source)) return yield* mcpEditError("MCP_DOCUMENT_INVALID")
            if (!isRecord(raw) || !isRecord(raw.mcp)) return yield* mcpEditError("MCP_ENTRY_MISSING")
            const flat = raw.mcp[input.name]
            const nested = isRecord(raw.mcp.servers) ? raw.mcp.servers[input.name] : undefined
            const entry = isRecord(flat) ? flat : isRecord(nested) ? nested : undefined
            if (!entry) return yield* mcpEditError("MCP_ENTRY_MISSING")
            const target = isRecord(flat) ? ["mcp", input.name] : ["mcp", "servers", input.name]
            // Only the submitted patch is written. Inherited raw fields stay in their own source file.
            const next: Record<string, unknown> = { ...entry, ...input.patch }
            if (input.patch.type === "remote") {
              delete next.command
              delete next.environment
              delete next.cwd
            }
            if (input.patch.type === "local") {
              delete next.url
              delete next.headers
              delete next.oauth
            }
            const updated = [...new Set([...Object.keys(entry), ...Object.keys(next)])].reduce(
              (text, key) =>
                Object.is(entry[key], next[key])
                  ? text
                  : applyEdits(
                      text,
                      modify(text, [...target, key], next[key], {
                        formattingOptions: { insertSpaces: true, tabSize: 2 },
                      }),
                    ),
              before,
            )
            // Validate the adapted document before touching disk, preserving the original V1/V2 representation.
            if (!acceptMcpDocument(updated, current.source)) return yield* mcpEditError("MCP_DOCUMENT_INVALID")
            yield* publish(current.source, before, updated)
              .pipe(Effect.mapError(() => mcpEditError("MCP_WRITE_FAILED")))
          }).pipe(
            Effect.catchDefect((error) =>
              configParseName(error) ? Effect.fail(mcpEditError("MCP_DOCUMENT_INVALID")) : Effect.die(error),
            ),
          ),
        ).pipe(
          Effect.catch((error: unknown) =>
            Effect.fail(
              isMcpEditError(error)
                ? error
                : mcpEditError(
                    typeof error === "object" && error !== null && "_tag" in error && error._tag === "LockTimeoutError"
                      ? "MCP_LOCK_TIMEOUT"
                      : error instanceof ConfigDocument.AliasUnsupported ? "MCP_SOURCE_ALIAS_UNSUPPORTED" : "MCP_WRITE_FAILED",
                  ),
            ),
          ),
        )
      })

    return Service.of({
      get,
      getGlobal,
      getConsoleState,
      mcpSource: (name) =>
        mcpSource(name).pipe(
          Effect.mapError((error) => (isMcpEditError(error) ? error : mcpEditError("MCP_DOCUMENT_INVALID"))),
        ),
      updateMcp: (input) => mutate(updateMcp(input)),
      preflight: () => preflight().pipe(Effect.asVoid),
      update,
      updateGlobal: (input) => mutate(updateGlobal(input)),
      invalidate,
      directories,
      waitForDependencies,
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Global.node, EffectFlock.node, FSUtil.node, Auth.node, Account.node, Env.node, Npm.node, httpClient],
})

export * as Config from "./config"
