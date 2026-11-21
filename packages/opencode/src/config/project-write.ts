export * as ProjectConfig from "./project-write"

import path from "path"
import fs from "node:fs/promises"
import { isDeepStrictEqual } from "node:util"
import { Effect } from "effect"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { ConfigDocument } from "@opencode-ai/core/config/document"
import { AtomicDocument } from "@opencode-ai/core/config/atomic-document"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { LockProtocol } from "@opencode-ai/core/util/lock-protocol"
import { Global } from "@opencode-ai/core/global"
import { Flag } from "@opencode-ai/core/flag/flag"
import { SettledIO } from "@opencode-ai/core/util/settled-io"
import { ConfigWrite } from "./write-error"
import { ConfigPaths } from "./paths"
import { ConfigVariable } from "./variable"
import { ConfigParse } from "./parse"
import { isRecord } from "@/util/record"
import type { InstanceContext } from "@/project/instance-context"

export type Phase =
  | "preflight"
  | "bootstrap"
  | "handler"
  | "selection-wait"
  | "decision"
  | "document-wait"
  | "baseline"
  | "validated"
  | "admitted"
  | "released"
  | "handoff"
const observers = new Map<string, Set<(phase: Phase) => Promise<void> | void>>()
export function observe(directory: string, observer: (phase: Phase) => Promise<void> | void) {
  const list = observers.get(directory) ?? new Set()
  observers.set(directory, list)
  list.add(observer)
  return () => {
    list.delete(observer)
    if (!list.size) observers.delete(directory)
  }
}
export function signal(ctx: InstanceContext, value: Phase) {
  return Effect.promise(async () => {
    for (const observe of observers.get(ctx.directory) ?? []) await observe(value)
  })
}

export type Source = {
  id: string
  text?: string
  value: ConfigV1.Info
  dir: string
  env?: Record<string, string>
  group?: "global"
}
export type File = { text?: string; target: string; mode?: number; dev?: number; ino?: number; parent?: string }
export type Snapshot = {
  sources: Source[]
  files: Map<string, File>
  env: Map<string, string>
  remoteFiles: Set<string>
  routing: string
  layout: string
  checks: Array<() => Promise<boolean>>
}
export function create(): Snapshot {
  return {
    sources: [],
    files: new Map(),
    env: new Map(),
    remoteFiles: new Set(),
    routing: routing(),
    layout: "",
    checks: [],
  }
}
function routing() {
  return JSON.stringify([
    process.env.OPENCODE_CONFIG,
    process.env.OPENCODE_CONFIG_CONTENT,
    Flag.OPENCODE_CONFIG_DIR,
    Flag.OPENCODE_DISABLE_PROJECT_CONFIG,
    Flag.OPENCODE_PERMISSION,
    Flag.OPENCODE_DISABLE_AUTOCOMPACT,
    Flag.OPENCODE_DISABLE_PRUNE,
  ])
}
function code(error: unknown) {
  return error && typeof error === "object" && "code" in error ? error.code : undefined
}
export function read(file: string) {
  return Effect.tryPromise({
    try: async (): Promise<File> => {
      const stat = await fs.stat(file).catch((error) => {
        if (code(error) === "ENOENT") return
        throw error
      })
      const target = ConfigDocument.canonical(file)
      let ancestor = path.dirname(file)
      while (true) {
        const parent = await fs.stat(ancestor).catch((error) => {
          if (code(error) === "ENOENT") return
          throw error
        })
        if (parent) {
          const identity = JSON.stringify([ConfigDocument.canonical(ancestor), parent.dev, parent.ino])
          if (!stat) return { target, parent: identity }
          if (!stat.isFile()) throw new Error("Unsupported document")
          return {
            text: await fs.readFile(file, "utf8"),
            target,
            mode: stat.mode,
            dev: stat.dev,
            ino: stat.ino,
            parent: identity,
          }
        }
        const next = path.dirname(ancestor)
        if (next === ancestor) throw new Error("No document ancestor")
        ancestor = next
      }
    },
    catch: () => ConfigWrite.fail("CONFIG_SOURCE_READ_FAILED"),
  }).pipe(SettledIO.drain)
}
export async function reference(snapshot: Snapshot, file: string) {
  const captured = await Effect.runPromise(read(file))
  if (captured.text === undefined) throw ConfigWrite.fail("CONFIG_DOCUMENT_INVALID")
  snapshot.files.set(file, captured)
  return captured.text
}
export function localFiles(directory: string) {
  return ["opencode.json", "opencode.jsonc", ".opencode/opencode.json", ".opencode/opencode.jsonc"].map((file) =>
    path.join(directory, file),
  )
}
export function layout(ctx: InstanceContext) {
  return Effect.gen(function* () {
    const files = yield* ConfigPaths.files("opencode", ctx.directory, ctx.worktree, true)
    const dirs = yield* ConfigPaths.directories(ctx.directory, ctx.worktree, true)
    return JSON.stringify([files, dirs])
  })
}
function fileIdentity(file: File) {
  return JSON.stringify([file.target, file.dev, file.ino, file.parent])
}
function shape(files: Array<[string, File]>) {
  return files.map(([id, file]) => [id, fileIdentity(file)])
}
function inside(parent: string, child: string) {
  const relative = path.relative(parent, child)
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}
function leavesMatch(actual: unknown, desired: unknown, patch: unknown, fields: string[] = []): boolean {
  if (!isRecord(patch) || (fields.length === 1 && fields[0] === "image_generation"))
    return isDeepStrictEqual(actual, desired)
  return Object.entries(patch).every(([key, value]) =>
    leavesMatch(isRecord(actual) ? actual[key] : undefined, isRecord(desired) ? desired[key] : undefined, value, [
      ...fields,
      key,
    ]),
  )
}

function withoutOverrides(value: unknown, patch: unknown, fields: string[] = []): unknown {
  if (fields.length === 1 && (fields[0] === "instructions" || fields[0] === "plugin")) return value
  if (!isRecord(value) || !isRecord(patch) || (fields.length === 1 && fields[0] === "image_generation"))
    return undefined
  const next = { ...value }
  for (const [key, entry] of Object.entries(patch)) {
    const retained = withoutOverrides(next[key], entry, [...fields, key])
    if (retained === undefined) delete next[key]
    else next[key] = retained
  }
  return next
}

/** P is only a read-only observation; D and L establish the local write baseline. */
export function write(input: {
  ctx: InstanceContext
  snapshot: Snapshot
  patch: ConfigV1.Info
  flock: EffectFlock.Interface
  admit: Effect.Effect<void, import("@/effect/instance-work").AdmissionClosed | ConfigWrite.Error>
  merge: (values: Array<Pick<Source, "value" | "group">>) => Effect.Effect<ConfigV1.Info>
  decode: (
    text: string,
    source: Source,
    snapshot: Snapshot,
    documents?: Map<string, string | undefined>,
  ) => Effect.Effect<ConfigV1.Info, ConfigWrite.Error>
  edit: (text: string, patch: ConfigV1.Info) => string
  onCommitted: () => void
}) {
  return Effect.scoped(
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const global = yield* Global.Service
        const locals = localFiles(input.ctx.directory)
        const canonicalRoot = yield* Effect.try({
          try: () => ConfigDocument.canonical(input.ctx.directory),
          catch: () => ConfigWrite.fail("CONFIG_TARGET_OUTSIDE_PROJECT"),
        })
        // A distinct selection namespace precedes all document leases. No writer takes these in reverse.
        yield* restore(signal(input.ctx, "selection-wait"))
        yield* restore(input.flock.acquire(`config-project-selection:${input.ctx.directory}`))
        const decision = yield* restore(
          Effect.forEach(locals, (id) => read(id).pipe(Effect.map((file) => [id, file] as [string, File]))),
        )
        yield* restore(signal(input.ctx, "decision"))
        for (const [, file] of decision)
          if (!inside(canonicalRoot, file.target)) return yield* ConfigWrite.fail("CONFIG_TARGET_OUTSIDE_PROJECT")
        const leases = yield* restore(
          Effect.forEach(locals, (file) =>
            ConfigDocument.describe(file).pipe(
              Effect.map((description) => ({ file, ...description })),
              Effect.mapError((error) =>
                ConfigWrite.fail(
                  error._tag === "ConfigDocumentAliasUnsupported"
                    ? "CONFIG_PATH_ALIAS_UNSUPPORTED"
                    : "CONFIG_SOURCE_READ_FAILED",
                ),
              ),
            ),
          ),
        )
        const unique = [...new Map(leases.map((lease) => [lease.identity, lease])).values()].sort((a, b) =>
          a.identity.localeCompare(b.identity),
        )
        for (const lease of unique) {
          yield* restore(signal(input.ctx, "document-wait"))
          yield* restore(input.flock.acquire(ConfigDocument.key(lease.file)))
        }
        const baseline = yield* restore(
          Effect.forEach(locals, (id) => read(id).pipe(Effect.map((file) => [id, file] as [string, File]))),
        )
        if (!isDeepStrictEqual(shape(decision), shape(baseline)))
          return yield* ConfigWrite.fail("CONFIG_SOURCE_CHANGED")
        yield* restore(signal(input.ctx, "baseline"))
        const byPath = new Map(baseline)
        if (routing() !== input.snapshot.routing || (yield* restore(layout(input.ctx))) !== input.snapshot.layout)
          return yield* ConfigWrite.fail("CONFIG_SOURCE_CHANGED")
        const localIdentities = new Set(baseline.map(([, file]) => file.target))
        // Files outside the local lock set remain the P observation; local content may legitimately advance before L.
        for (const [id, previous] of input.snapshot.files) {
          if (localIdentities.has(ConfigDocument.canonical(id)) && !input.snapshot.remoteFiles.has(id)) continue
          if (!isDeepStrictEqual(yield* restore(read(id)), previous))
            return yield* ConfigWrite.fail("CONFIG_SOURCE_CHANGED")
        }
        const protectedRaw = new Map(baseline.map(([, file]) => [file.target, file.text]))
        const baselineDependencies = create()
        const currentSources: Source[] = []
        for (const source of input.snapshot.sources) {
          const id = path.isAbsolute(source.id) ? ConfigDocument.canonical(source.id) : undefined
          const file = id && localIdentities.has(id) ? baseline.find(([, file]) => file.target === id)?.[1] : undefined
          const text = file ? file.text : source.text
          const value = !file
            ? source.value
            : text === undefined
              ? {}
              : yield* restore(input.decode(text, source, baselineDependencies, protectedRaw))
          currentSources.push({ ...source, text, value })
        }
        const existing = currentSources
          .filter(
            (source) =>
              path.isAbsolute(source.id) &&
              baseline.some(
                ([, file]) => file.target === ConfigDocument.canonical(source.id) && file.text !== undefined,
              ),
          )
          .at(-1)
        const target = existing
          ? baseline.find(([, file]) => file.target === ConfigDocument.canonical(existing.id))![0]
          : path.join(input.ctx.directory, "opencode.jsonc")
        const before = byPath.get(target)!
        if (before.mode !== undefined && !(before.mode & 0o222))
          return yield* ConfigWrite.fail("CONFIG_SOURCE_READ_ONLY")
        const selected = currentSources.find((source) => source.id === target)
        if (!selected) return yield* ConfigWrite.fail("CONFIG_SOURCE_CHANGED")
        const candidateDependencies = create()
        const decodedPatch = yield* restore(
          input.decode(JSON.stringify(input.patch), selected, candidateDependencies, protectedRaw),
        )
        const current = yield* restore(input.merge(currentSources))
        const verify = Effect.gen(function* () {
          for (const check of input.snapshot.checks) {
            const unchanged = yield* Effect.tryPromise({
              try: check,
              catch: () => ConfigWrite.fail("CONFIG_SOURCE_READ_FAILED"),
            })
            if (!unchanged) return yield* ConfigWrite.fail("CONFIG_SOURCE_CHANGED")
          }
          // Recheck L and all private reference inputs immediately before transferring responsibility.
          for (const [id, file] of baseline)
            if (!isDeepStrictEqual(yield* read(id), file)) return yield* ConfigWrite.fail("CONFIG_SOURCE_CHANGED")
          for (const [id, previous] of [
            ...input.snapshot.files,
            ...baselineDependencies.files,
            ...candidateDependencies.files,
          ]) {
            if (localIdentities.has(ConfigDocument.canonical(id))) continue
            if (!isDeepStrictEqual(yield* read(id), previous)) return yield* ConfigWrite.fail("CONFIG_SOURCE_CHANGED")
          }
          for (const [name, value] of [
            ...input.snapshot.env,
            ...baselineDependencies.env,
            ...candidateDependencies.env,
          ]) {
            if ((process.env[name] || "") !== value) return yield* ConfigWrite.fail("CONFIG_SOURCE_CHANGED")
          }
          if (routing() !== input.snapshot.routing || (yield* layout(input.ctx)) !== input.snapshot.layout)
            return yield* ConfigWrite.fail("CONFIG_SOURCE_CHANGED")
          for (const lease of leases)
            yield* Effect.try({
              try: () =>
                LockProtocol.confirmCurrent(
                  ConfigDocument.key(lease.file),
                  global.lockContext,
                  undefined,
                  lease.decision,
                ),
              catch: () => ConfigWrite.fail("CONFIG_SOURCE_CHANGED"),
            })
        })
        const raw = before.text ?? '{"$schema":"https://opencode.ai/config.json"}'
        const editable = yield* Effect.try({
          try: () => {
            ConfigParse.jsonc(raw, target)
            return true
          },
          catch: () => false,
        }).pipe(Effect.catch(() => Effect.succeed(false)))
        if (!editable) {
          if (leavesMatch(current, decodedPatch, input.patch)) {
            yield* restore(verify)
            return
          }
          return yield* ConfigWrite.fail("CONFIG_TEMPLATE_EDIT_UNSUPPORTED")
        }
        const updated = yield* Effect.try({
          try: () => input.edit(raw, input.patch),
          catch: () => ConfigWrite.fail("CONFIG_PATCH_INVALID"),
        })
        // Changing a locally protected discovery/auth input would require new HTTP outside these leases.
        for (const id of input.snapshot.remoteFiles) {
          if (ConfigDocument.canonical(id) === before.target && input.snapshot.files.get(id)?.text !== updated)
            return yield* ConfigWrite.fail("CONFIG_SOURCE_CHANGED")
        }
        const documents = new Map(protectedRaw).set(before.target, updated)
        const projected: Source[] = []
        for (const source of currentSources) {
          if (path.isAbsolute(source.id) && ConfigDocument.canonical(source.id) === before.target) {
            projected.push({
              ...source,
              value: yield* restore(input.decode(updated, source, candidateDependencies, documents)),
            })
          } else projected.push(source)
        }
        const lastTarget = projected.findLastIndex(
          (source) => path.isAbsolute(source.id) && ConfigDocument.canonical(source.id) === before.target,
        )
        // Compare against the same candidate with only overriding leaves removed from
        // higher sources. Additive instructions/plugins retain their inherited semantics.
        const intended = projected.map((source, index) =>
          index <= lastTarget
            ? source
            : { ...source, value: withoutOverrides(source.value, input.patch) as ConfigV1.Info },
        )
        const actual = yield* restore(input.merge(projected))
        const desired = yield* restore(input.merge(intended))
        if (!leavesMatch(actual, desired, input.patch)) return yield* ConfigWrite.fail("CONFIG_SOURCE_OVERRIDDEN")
        // A successful ACK can be a no-op, but only after simulating the local patch.
        // This permits clearing owned instructions while retaining inherited entries.
        if (leavesMatch(actual, current, input.patch)) {
          yield* restore(verify)
          return
        }
        yield* restore(signal(input.ctx, "validated"))
        yield* restore(verify)
        yield* input.admit
        yield* signal(input.ctx, "admitted")
        // After admission cancellation no longer revokes publish or its cleanup.
        yield* Effect.tryPromise({
          try: () =>
            AtomicDocument.publish({
              file: target,
              before: before.text,
              text: updated,
              onCommitted: input.onCommitted,
            }),
          catch: (error) =>
            ConfigWrite.fail(
              error instanceof AtomicDocument.CommitError && error.stage === "unknown"
                ? "CONFIG_COMMIT_UNKNOWN"
                : "CONFIG_WRITE_FAILED",
            ),
        })
      }),
    ),
  ).pipe(
    SettledIO.ensuring(signal(input.ctx, "released")),
    Effect.mapError((error) => {
      if (error._tag === "ConfigWriteError") return error
      if (error._tag === "InstanceWorkAdmissionClosed") return ConfigWrite.fail("CONFIG_SOURCE_CHANGED")
      return ConfigWrite.fail(error._tag === "LockTimeoutError" ? "CONFIG_LOCK_TIMEOUT" : "CONFIG_SOURCE_CHANGED")
    }),
  )
}
