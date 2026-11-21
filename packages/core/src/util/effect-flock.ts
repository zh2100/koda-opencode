import path from "path"
import os from "os"
import { randomUUID } from "crypto"
import { Context, Effect, Function, Layer, Option, Schedule, Schema } from "effect"
import type { Scope } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { makeGlobalNode } from "../effect/app-node"
import { Flock } from "./flock"
import { Hash } from "./hash"
import { LockProtocol } from "./lock-protocol"
import { LockOwner } from "./lock-owner"
import { NativeFileLock, NativeLockError } from "./native-file-lock"

export namespace EffectFlock {
  // ---------------------------------------------------------------------------
  // Errors
  // ---------------------------------------------------------------------------

  export const LockDiagnosisReason = Schema.Literals([
    "live-owner",
    "exited-owner",
    "permission-denied",
    "remote-owner",
    "metadata-missing",
    "metadata-corrupt",
    "breaker-held",
    "filesystem-unavailable",
    "absent",
  ])

  export class LockDiagnosis extends Schema.Class<LockDiagnosis>("LockDiagnosis")({
    reason: LockDiagnosisReason,
    hostname: Schema.optional(Schema.String),
    pid: Schema.optional(Schema.Number),
  }) {}

  export class LockTimeoutError extends Schema.TaggedErrorClass<LockTimeoutError>()("LockTimeoutError", {
    key: Schema.String,
    diagnosis: Schema.optional(LockDiagnosis),
  }) {}

  export class LockCompromisedError extends Schema.TaggedErrorClass<LockCompromisedError>()("LockCompromisedError", {
    detail: Schema.String,
  }) {
    override get message() {
      return this.detail
    }
  }

  class ReleaseError extends Schema.TaggedErrorClass<ReleaseError>()("ReleaseError", {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  }) {
    override get message() {
      return this.detail
    }
  }

  /** Internal: signals "lock is held, retry later". Never leaks to callers. */
  class NotAcquired extends Schema.TaggedErrorClass<NotAcquired>()("NotAcquired", {
    diagnosis: LockDiagnosis,
  }) {}

  export type LockError = LockTimeoutError | LockCompromisedError
  export type Probe = { readonly status: "busy" } | { readonly status: "acquired" }

  // ---------------------------------------------------------------------------
  // Timing (baked in — no caller ever overrides these)
  // ---------------------------------------------------------------------------

  const STALE_MS = 60_000
  const TIMEOUT_MS = 5 * 60_000
  const BASE_DELAY_MS = 100
  const MAX_DELAY_MS = 2_000
  const HEARTBEAT_MS = Math.max(100, Math.floor(STALE_MS / 3))

  const retrySchedule = Schedule.exponential(BASE_DELAY_MS, 1.7).pipe(
    Schedule.either(Schedule.spaced(MAX_DELAY_MS)),
    Schedule.jittered,
    Schedule.while((meta) => meta.elapsed < TIMEOUT_MS),
  )

  // ---------------------------------------------------------------------------
  // Lock metadata schema
  // ---------------------------------------------------------------------------

  const LockMetaJson = Schema.fromJsonString(
    Schema.Struct({
      token: Schema.String,
      pid: Schema.Number,
      hostname: Schema.String,
      createdAt: Schema.String,
    }),
  )

  const decodeMeta = Schema.decodeUnknownSync(LockMetaJson)
  const encodeMeta = Schema.encodeSync(LockMetaJson)

  // ---------------------------------------------------------------------------
  // Service
  // ---------------------------------------------------------------------------

  export interface Interface {
    readonly diagnose: (key: string, dir?: string) => Effect.Effect<LockDiagnosis>
    readonly isLocked: (key: string, dir?: string) => Effect.Effect<boolean>
    readonly key: (key: string) => Effect.Effect<string, LockCompromisedError>
    readonly acquire: (key: string, dir?: string) => Effect.Effect<void, LockError, Scope.Scope>
    readonly tryAcquire: (key: string, dir?: string) => Effect.Effect<boolean, LockError, Scope.Scope>
    readonly probe: (key: string, dir?: string) => Effect.Effect<Probe, LockError, Scope.Scope>
    readonly withLock: {
      (key: string, dir?: string): <A, E, R>(body: Effect.Effect<A, E, R>) => Effect.Effect<A, E | LockError, R>
      <A, E, R>(body: Effect.Effect<A, E, R>, key: string, dir?: string): Effect.Effect<A, E | LockError, R>
    }
  }

  export class Service extends Context.Service<Service, Interface>()("EffectFlock") {}

  // ---------------------------------------------------------------------------
  // Layer
  // ---------------------------------------------------------------------------

  const isNotFound = (e: PlatformError) => e.reason._tag === "NotFound"

  /** @internal Test observation only; not a supported runtime configuration API. */
  export type WaitObservation = {
    readonly key: string
    readonly lockfile: string
  }

  /** @internal Builds the real lock layer with an optional synchronous test observer. */
  export const layerWith = (
    options: { readonly onWait?: (event: WaitObservation) => void } = {},
  ): Layer.Layer<Service, never, Global.Service | FSUtil.Service> => Layer.effect(
    Service,
    Effect.gen(function* () {
      const global = yield* Global.Service
      const fs = yield* FSUtil.Service
      const lockRoot = path.join(global.state, "locks")
      const hostname = os.hostname()
      const ensuredDirs = new Set<string>()

      // -- helpers (close over fs) --

      const forceRemove = (target: string) => fs.remove(target, { recursive: true }).pipe(Effect.ignore)

      /** Atomic mkdir — returns true if created, false if already exists, dies on other errors. */
      const atomicMkdir = (dir: string) =>
        fs.makeDirectory(dir, { mode: 0o700 }).pipe(
          Effect.as(true),
          Effect.catchIf(
            (e) => e.reason._tag === "AlreadyExists",
            () => Effect.succeed(false),
          ),
          Effect.orDie,
        )

      /** Write with exclusive create. Cleanup stays with the caller so a failed write cannot delete twice. */
      const exclusiveWrite = (filePath: string, content: string, detail: string, remove: Effect.Effect<void>) =>
        fs.writeFileString(filePath, content, { flag: "wx" }).pipe(
          Effect.catch(() =>
            Effect.gen(function* () {
              yield* remove
              return yield* new LockCompromisedError({ detail })
            }),
          ),
        )

      const ensureDir = Effect.fnUntraced(function* (dir: string) {
        if (ensuredDirs.has(dir)) return
        yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.orDie)
        ensuredDirs.add(dir)
      })

      const diagnoseMeta = Effect.fnUntraced(function* (metaPath: string) {
        const raw = yield* fs.readFileString(metaPath).pipe(
          Effect.map((text) => text as string | undefined),
          Effect.catch((error) =>
            isNotFound(error)
              ? Effect.succeed(undefined)
              : Effect.fail(new LockDiagnosis({ reason: "filesystem-unavailable" })),
          ),
        )
        return new LockDiagnosis(LockOwner.diagnose(raw, hostname))
      })

      // -- single lock attempt --

      type Handle = { token: string; metaPath: string; heartbeatPath: string; lockDir: string }

      const claimDirectory = (lockDir: string): Effect.Effect<boolean, NotAcquired> =>
        Effect.gen(function* () {
          const created = yield* atomicMkdir(lockDir)
          if (created) return true
          const diagnosis = yield* diagnoseMeta(path.join(lockDir, "meta.json")).pipe(
            Effect.catch((error) => Effect.succeed(error)),
          )
          if (diagnosis.reason !== "exited-owner") return yield* new NotAcquired({ diagnosis })
          const breakerPath = lockDir + ".breaker"
          const claimed = yield* fs.makeDirectory(breakerPath, { mode: 0o700 }).pipe(
            Effect.as(true),
            Effect.catchIf(
              (e) => e.reason._tag === "AlreadyExists",
              // A paused breaker may resume between its recheck and removal.
              // Never revoke it by age; abandoned breakers need manual recovery.
              () => Effect.succeed(false),
            ),
            Effect.catchIf(isNotFound, () => Effect.succeed(false)),
            Effect.catch(() => Effect.succeed(false)),
          )
          if (!claimed) return yield* new NotAcquired({ diagnosis: new LockDiagnosis({ reason: "breaker-held" }) })
          const recreated = yield* Effect.gen(function* () {
            const again = yield* diagnoseMeta(path.join(lockDir, "meta.json")).pipe(
              Effect.catch((error) => Effect.succeed(error)),
            )
            if (again.reason !== "exited-owner") return false
            yield* forceRemove(lockDir)
            return yield* atomicMkdir(lockDir)
          }).pipe(Effect.ensuring(forceRemove(breakerPath)))
          if (!recreated) return yield* new NotAcquired({ diagnosis: new LockDiagnosis({ reason: "exited-owner" }) })
          return true
        })

      const publishOwnership = (lockDir: string, key: string, remove: Effect.Effect<void>) =>
        Effect.gen(function* () {
          const token = randomUUID()
          const metaPath = path.join(lockDir, "meta.json")
          const heartbeatPath = path.join(lockDir, "heartbeat")
          yield* exclusiveWrite(heartbeatPath, "", "heartbeat already existed", remove)
          const metaJson = encodeMeta({ token, pid: process.pid, hostname, createdAt: new Date().toISOString() })
          yield* exclusiveWrite(metaPath, metaJson, "meta.json already existed", remove)
          return { token, metaPath, heartbeatPath, lockDir } satisfies Handle
        }).pipe(Effect.withSpan("EffectFlock.publishOwnership", { attributes: { key } }))

      // -- release --

      const release = (handle: Handle, remove: Effect.Effect<void>) =>
        Effect.gen(function* () {
          const raw = yield* fs.readFileString(handle.metaPath).pipe(
            Effect.catch((err) => {
              if (isNotFound(err)) return Effect.die(new ReleaseError({ detail: "metadata missing" }))
              return Effect.die(err)
            }),
          )

          const parsed = yield* Effect.try({
            try: () => decodeMeta(raw),
            catch: (cause) => new ReleaseError({ detail: "metadata invalid", cause }),
          }).pipe(Effect.orDie)

          if (parsed.token !== handle.token) return yield* Effect.die(new ReleaseError({ detail: "token mismatch" }))

          yield* remove
        })

      // -- build service --

      const decide = (key: string, dir?: string) =>
        Effect.try({
          try: () => LockProtocol.resolve(key, global.lockContext, dir),
          catch: (cause) => new LockCompromisedError({ detail: LockProtocol.fromIdentity(cause).message }),
        })

      const identity = (key: string) => decide(key).pipe(Effect.map((decision) => decision.key))

      const nativeError = (error: unknown) =>
        new LockCompromisedError({
          detail:
            error instanceof NativeLockError || error instanceof Error ? error.message : "native file lock failed",
        })

      const nativeLease = (file: string) =>
        Effect.acquireRelease(
          Effect.try({
            try: () => NativeFileLock.tryAcquire(file),
            catch: nativeError,
          }),
          (result) =>
            result.status === "busy"
              ? Effect.void
              : Effect.try({
                  try: () => result.release(),
                  catch: nativeError,
                }).pipe(Effect.orDie),
        ).pipe(Effect.map((result) => (result.status === "acquired" ? result.token : undefined)))

      const confirm = (key: string, dir: string | undefined, granted: LockProtocol.Decision) =>
        Effect.try({
          try: () => LockProtocol.confirmCurrent(key, global.lockContext, dir, granted),
          catch: (cause) => new LockCompromisedError({ detail: LockProtocol.fromIdentity(cause).message }),
        })

      const acquireNative = (key: string, dir?: string) =>
        Effect.acquireRelease(
          Effect.callback<Flock.Lease, LockCompromisedError>((resume, signal) => {
            const pending = Flock.acquire(key, {
              context: global.lockContext,
              dir,
              signal,
              timeoutMs: TIMEOUT_MS,
            })
            const bridge = NativeFileLock.handoff(pending, (effect) => {
              if (effect.status === "failed") {
                resume(Effect.fail(nativeError(effect.cause)))
                return
              }
              resume(Effect.succeed(effect.value))
            })
            return Effect.sync(() => {
              bridge.cancel()
            }).pipe(Effect.andThen(Effect.promise(() => bridge.late((lease) => lease.release()).then(() => undefined))))
          }),
          (lease) => Effect.promise(() => lease.release()).pipe(Effect.orDie),
          { interruptible: true },
        ).pipe(Effect.asVoid)

      const acquireDirectory = Effect.fn("EffectFlock.acquireDirectory")(function* (key: string, dir?: string) {
        const decision = yield* decide(key, dir)
        const lockDir = decision.directory
        const lockKey = decision.key
        yield* ensureDir(lockDir)

        const lockfile = path.join(lockDir, Hash.fast(lockKey) + ".lock")

        // One remover for this attempt. A second path delete can remove a successor that
        // acquired after the first removal returned.
        const removed = { done: false }
        const removeOnce = Effect.gen(function* () {
          if (removed.done) return
          removed.done = true
          yield* forceRemove(lockfile)
        })
        const cleanup = {
          run: Effect.void as Effect.Effect<void>,
        }
        yield* Effect.addFinalizer(() => cleanup.run)
        // Create, publish, and the swap to token-checked release stay uninterruptible.
        const publishCreated = Effect.uninterruptible(
          Effect.gen(function* () {
            cleanup.run = removeOnce
            const owned = yield* publishOwnership(lockfile, key, removeOnce)
            cleanup.run = release(owned, removeOnce)
            return owned
          }),
        )
        const ownCreatedDirectory = Effect.uninterruptible(
          Effect.gen(function* () {
            if (!(yield* atomicMkdir(lockfile))) return undefined
            return yield* publishCreated
          }),
        )
        // A lost race is not a timeout. Backoff runs only while another owner is held,
        // and every wait shares this attempt's original deadline.
        const deadline = Date.now() + TIMEOUT_MS
        const waitWhileHeld = Effect.gen(function* () {
          const remaining = deadline - Date.now()
          if (remaining <= 0) {
            return yield* new LockTimeoutError({
              key: path.basename(lockfile),
              diagnosis: yield* diagnoseMeta(path.join(lockfile, "meta.json")).pipe(
                Effect.catch((error) => Effect.succeed(error)),
              ),
            })
          }
          yield* fs.stat(lockfile).pipe(
            Effect.as(true),
            Effect.catchIf(isNotFound, () => Effect.succeed(false)),
            Effect.catch(() => Effect.succeed(undefined)),
            Effect.flatMap((held) =>
              held !== false
                ? Effect.gen(function* () {
                    const breaker = yield* fs.stat(lockfile + ".breaker").pipe(
                      Effect.as(true),
                      Effect.catchIf(isNotFound, () => Effect.succeed(false)),
                      Effect.catch(() => Effect.succeed(true)),
                    )
                    if (breaker)
                      return yield* new NotAcquired({ diagnosis: new LockDiagnosis({ reason: "breaker-held" }) })
                    const diagnosis = yield* diagnoseMeta(path.join(lockfile, "meta.json")).pipe(
                      Effect.catch((error) => Effect.succeed(error)),
                    )
                    if (diagnosis.reason === "exited-owner") return
                    if (held === true && diagnosis.reason === "live-owner" && options.onWait) {
                      // An observer must never alter lock errors, ownership, or retry behavior.
                      yield* Effect.sync(() => options.onWait?.({ key: lockKey, lockfile })).pipe(Effect.ignoreCause)
                    }
                    return yield* new NotAcquired({ diagnosis })
                  })
                : Effect.void,
            ),
            Effect.retry({
              while: (error) => error._tag === "NotAcquired",
              schedule: retrySchedule.pipe(Schedule.while((meta) => meta.elapsed < remaining)),
            }),
            Effect.catchTag("NotAcquired", (error) =>
              Effect.fail(new LockTimeoutError({ key: path.basename(lockfile), diagnosis: error.diagnosis })),
            ),
          )
        })
        const claimOnce = Effect.uninterruptible(
          Effect.gen(function* () {
            const created = yield* ownCreatedDirectory
            if (created) return created
            if (!(yield* claimDirectory(lockfile))) return undefined
            return yield* publishCreated
          }),
        )
        const handle = yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            while (true) {
              const owned = yield* claimOnce.pipe(Effect.catchTag("NotAcquired", () => Effect.succeed(undefined)))
              if (owned) return owned
              yield* restore(waitWhileHeld)
            }
          }),
        )

        // Heartbeat fiber — scoped, so it's interrupted before release runs
        yield* fs
          .utimes(handle.heartbeatPath, new Date(), new Date())
          .pipe(Effect.ignore, Effect.repeat(Schedule.spaced(HEARTBEAT_MS)), Effect.forkScoped)
        yield* confirm(key, dir, decision)
      })

      const acquire = (key: string, dir?: string) =>
        decide(key, dir).pipe(
          Effect.flatMap((decision) =>
            decision.backend === "directory" ? acquireDirectory(key, dir) : acquireNative(key, dir),
          ),
        )

      const withLock: Interface["withLock"] = Function.dual(
        (args) => Effect.isEffect(args[0]),
        <A, E, R>(body: Effect.Effect<A, E, R>, key: string, dir?: string): Effect.Effect<A, E | LockError, R> =>
          Effect.scoped(
            Effect.gen(function* () {
              yield* acquire(key, dir)
              return yield* body
            }),
          ),
      )

      const diagnose = (key: string, dir?: string): Effect.Effect<LockDiagnosis> =>
        Effect.gen(function* () {
          const decision = yield* decide(key, dir).pipe(Effect.option)
          if (Option.isNone(decision)) return new LockDiagnosis({ reason: "filesystem-unavailable" })
          if (decision.value.backend !== "directory") {
            const file = LockProtocol.file(decision.value)
            const probed = yield* Effect.scoped(nativeLease(file)).pipe(
              Effect.map((token) => (token ? ("free" as const) : ("busy" as const))),
              Effect.catch(() => Effect.succeed("unavailable" as const)),
            )
            if (probed === "unavailable") return new LockDiagnosis({ reason: "filesystem-unavailable" })
            if (probed === "busy") return new LockDiagnosis({ reason: "live-owner" })
            return new LockDiagnosis({ reason: "absent" })
          }
          const lockKey = decision.value.key
          const lockfile = path.join(decision.value.directory, Hash.fast(lockKey) + ".lock")
          const exists = yield* fs.stat(lockfile).pipe(
            Effect.as(true),
            Effect.catchIf(isNotFound, () => Effect.succeed(false)),
            Effect.catch(() => Effect.succeed(undefined)),
          )
          if (exists === undefined) return new LockDiagnosis({ reason: "filesystem-unavailable" })
          if (!exists) return new LockDiagnosis({ reason: "absent" })
          const breaker = yield* fs.stat(lockfile + ".breaker").pipe(
            Effect.as(true),
            Effect.catchIf(isNotFound, () => Effect.succeed(false)),
            Effect.catch(() => Effect.succeed(undefined)),
          )
          if (breaker === undefined) return new LockDiagnosis({ reason: "filesystem-unavailable" })
          if (breaker) return new LockDiagnosis({ reason: "breaker-held" })
          return yield* diagnoseMeta(path.join(lockfile, "meta.json")).pipe(
            Effect.catch((error) => Effect.succeed(error)),
          )
        })

      // Unknown ownership stays locked. Only a confirmed absent or exited owner is free.
      const isLocked = (key: string, dir?: string) =>
        diagnose(key, dir).pipe(
          Effect.map((diagnosis) => diagnosis.reason !== "absent" && diagnosis.reason !== "exited-owner"),
          Effect.catch(() => Effect.succeed(true)),
        )
      // One filesystem attempt. Waiting and backoff stay in acquire. A slow disk is not BUSY.
      const probeOnce = (key: string, dir?: string) =>
        Effect.gen(function* () {
          const decision = yield* decide(key, dir)
          if (decision.backend !== "directory") {
            const file = LockProtocol.file(decision)
            yield* ensureDir(path.dirname(file))
            const held = yield* nativeLease(file)
            if (!held) return { status: "busy" } as const
            yield* confirm(key, dir, decision)
            return { status: "acquired" } as const
          }
          const lockDir = decision.directory
          yield* ensureDir(lockDir)
          const lockfile = path.join(lockDir, Hash.fast(decision.key) + ".lock")
          const removed = { done: false }
          const removeOnce = Effect.gen(function* () {
            if (removed.done) return
            removed.done = true
            yield* forceRemove(lockfile)
          })
          const cleanup = { run: Effect.void as Effect.Effect<void> }
          const owned = yield* Effect.uninterruptible(
            Effect.gen(function* () {
              yield* Effect.addFinalizer(() => cleanup.run)
              cleanup.run = removeOnce
              const created = yield* atomicMkdir(lockfile)
              if (
                !created &&
                !(yield* claimDirectory(lockfile).pipe(Effect.catchTag("NotAcquired", () => Effect.succeed(false))))
              ) {
                cleanup.run = Effect.void
                return undefined
              }
              const handle = yield* publishOwnership(lockfile, key, removeOnce)
              cleanup.run = release(handle, removeOnce)
              return handle
            }),
          )
          if (!owned) return { status: "busy" } as const
          yield* fs
            .utimes(owned.heartbeatPath, new Date(), new Date())
            .pipe(Effect.ignore, Effect.repeat(Schedule.spaced(HEARTBEAT_MS)), Effect.forkScoped)
          return { status: "acquired" } as const
        })
      const probe = (key: string, dir?: string) => probeOnce(key, dir)
      const tryAcquire = (key: string, dir?: string) =>
        probeOnce(key, dir).pipe(Effect.map((result) => result.status === "acquired"))
      return Service.of({ acquire, withLock, diagnose, isLocked, key: identity, tryAcquire, probe })
    }),
  )

  export const layer = layerWith()

  export const node = makeGlobalNode({ service: Service, layer: layer, deps: [Global.node, FSUtil.node] })
}

// Named bindings for the public facade. Keep these aliases next to the source
// namespace so the facade can forward identity without re-exporting internals.
export const EffectFlockService = EffectFlock.Service
export type EffectFlockServiceType = EffectFlock.Service
export type EffectFlockLockDiagnosisType = EffectFlock.LockDiagnosis
export type EffectFlockLockTimeoutErrorType = EffectFlock.LockTimeoutError
export type EffectFlockLockCompromisedErrorType = EffectFlock.LockCompromisedError
export const EffectFlockLockDiagnosisReason = EffectFlock.LockDiagnosisReason
export const EffectFlockLockDiagnosis = EffectFlock.LockDiagnosis
export const EffectFlockLockTimeoutError = EffectFlock.LockTimeoutError
export const EffectFlockLockCompromisedError = EffectFlock.LockCompromisedError
export const EffectFlockLayer = EffectFlock.layer
export const EffectFlockNode = EffectFlock.node
export type EffectFlockInterface = EffectFlock.Interface
export type EffectFlockLockError = EffectFlock.LockError
export type EffectFlockProbe = EffectFlock.Probe
