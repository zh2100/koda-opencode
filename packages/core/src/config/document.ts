export * as ConfigDocument from "./document"

import path from "path"
import fs from "node:fs"
import { Effect, Schema } from "effect"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { EffectFlock } from "../util/effect-flock"
import { LockProtocol } from "../util/lock-protocol"

export class AliasUnsupported extends Schema.TaggedErrorClass<AliasUnsupported>()("ConfigDocumentAliasUnsupported", {}) {}

export function key(file: string) {
  const normalized = FSUtil.windowsPath(file)
  return `config-document:${path.isAbsolute(normalized) ? path.resolve(normalized) : normalized}`
}

/** Preserve realpath's case for the legacy raw-key comparison. */
export function canonical(file: string): string {
  const target = path.resolve(FSUtil.windowsPath(file))
  const remaining: string[] = []
  let current = target
  while (true) {
    try { return path.join(fs.realpathSync.native(current), ...remaining) }
    catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error
      const parent = path.dirname(current)
      if (parent === current) throw error
      remaining.unshift(path.basename(current))
      current = parent
    }
  }
}

/** Describe the complete coordination identity before acquiring any document lease. */
export function describe(file: string) {
  return Effect.gen(function* () {
    const global = yield* Global.Service
    const decision = yield* Effect.try({
      try: () => LockProtocol.resolve(key(file), global.lockContext),
      catch: () => new EffectFlock.LockCompromisedError({ detail: "Configuration lock identity is unavailable" }),
    })
    const target = yield* Effect.try({
      try: () => canonical(file),
      catch: () => new EffectFlock.LockCompromisedError({ detail: "Configuration document identity is unavailable" }),
    })
    if (decision.protocol === "legacy" && key(file) !== key(target)) return yield* new AliasUnsupported({})
    return { decision, target, identity: JSON.stringify([decision.backend, decision.directory, decision.epoch, decision.rootId, decision.key]) }
  })
}

// Every writer must pass the same alias gate before reading or creating a lock.
export function withLock<A, E, R>(flock: EffectFlock.Interface, file: string, body: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    yield* describe(file)
    return yield* flock.withLock(key(file))(body)
  })
}

// Loader annotations are optional: an incompatible alias skips the write, not the read.
export function tryWithLock<A, E, R>(flock: EffectFlock.Interface, file: string, body: Effect.Effect<A, E, R>) {
  return Effect.scoped(Effect.gen(function* () {
    const allowed = yield* describe(file).pipe(Effect.map(() => true), Effect.catchTag("ConfigDocumentAliasUnsupported", () => Effect.succeed(false)))
    if (!allowed || !(yield* flock.tryAcquire(key(file)))) return
    return yield* body
  }))
}
