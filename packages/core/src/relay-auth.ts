export * as RelayAuth from "./relay-auth"

import { DateTime, Effect, Layer, Result, Schema, Context, Semaphore } from "effect"
import { makeGlobalNode } from "./effect/app-node"
import { Relay } from "@opencode-ai/schema/relay"
import { RelayError } from "@opencode-ai/schema/relay-error"
import { NonNegativeInt } from "./schema"
import type { DeepMutable } from "./schema"
import { FSUtil } from "./fs-util"
import { Global } from "./global"
import { RelaySecretStore } from "./relay-secret-store"
import { EffectFlock } from "./util/effect-flock"
import { Hash } from "./util/hash"
import { SettledIO } from "./util/settled-io"
import path from "path"
import { createHmac, randomBytes, randomUUID } from "crypto"

export class AuthError extends Schema.TaggedErrorClass<AuthError>()("Relay.AuthError", {
  info: RelayError.Info,
}) {}

const EntityID = Schema.String.check(Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/))
const CreationReceipt = Schema.Struct({
  ...Relay.OperationReceipt.fields,
  entityId: EntityID,
  fingerprint: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
})
const ReceiptKey = Schema.Struct({
  version: Schema.Literal(1),
  key: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
})

export interface VendorExpectation {
  readonly expectedEntityId?: string
  readonly expectedVendorRevision?: number
}

const StoredVendor = Schema.Struct({
  id: Relay.VendorID,
  entityId: Schema.optional(EntityID),
  name: Schema.String,
  builtin: Schema.Boolean,
  keyRef: Schema.optional(Schema.String),
  baseURL: Schema.optional(Relay.VendorBaseURL),
  updatedAt: Schema.Finite,
  revision: NonNegativeInt,
})

const PendingCleanup = Schema.Struct({
  operationId: Schema.String,
  refs: Schema.Array(Schema.String),
  revision: NonNegativeInt,
})

const Stored = Schema.Struct({
  // Decode retired fields only to retire their references transactionally.
  unified: Schema.optional(Schema.Boolean),
  unifiedKeyRef: Schema.optional(Schema.String),
  vendors: Schema.Record(Schema.String, StoredVendor),
  revision: NonNegativeInt,
  migrationVersion: NonNegativeInt.pipe(Schema.optional),
  pendingCleanup: Schema.Array(PendingCleanup).pipe(Schema.optional),
  creationReceipts: Schema.optional(Schema.Array(CreationReceipt)),
})

type DraftVendor = DeepMutable<typeof StoredVendor.Type>
type Draft = DeepMutable<typeof Stored.Type>

const empty = (): Draft => ({ vendors: {}, revision: 0, migrationVersion: 2 })

const MIGRATION_VERSION = 2

export interface CredentialSnapshot {
  readonly vendorId: Relay.VendorID
  readonly entityId: string
  readonly vendorRevision: number
  readonly baseURL: string
  readonly key: string
}

export interface CommitResult extends Relay.AuthState {
  readonly cleanupPending: boolean
}

export interface Interface {
  readonly get: () => Effect.Effect<Relay.AuthState, AuthError>
  readonly setVendor: (input: {
    readonly id: Relay.VendorID
    readonly createOnly?: boolean
    readonly expectedEntityId?: string
    readonly name?: string
    readonly baseURL?: string
    readonly key?: string
    readonly revision: number
    readonly operationId?: string
  }) => Effect.Effect<CommitResult, AuthError>
  readonly clearVendorKey: (input: {
    readonly expectedEntityId?: string
    readonly id: Relay.VendorID
    readonly revision: number
    readonly operationId?: string
  }) => Effect.Effect<CommitResult, AuthError>
  readonly deleteVendor: (input: {
    readonly expectedEntityId?: string
    readonly id: Relay.VendorID
    readonly revision: number
    readonly operationId?: string
  }) => Effect.Effect<CommitResult, AuthError>
  readonly capture: (
    vendorId: Relay.VendorID,
    expected?: VendorExpectation,
  ) => Effect.Effect<CredentialSnapshot, AuthError>
  readonly resolve: (
    vendorId: Relay.VendorID,
    expected?: VendorExpectation,
  ) => Effect.Effect<{ key: string; baseURL: string }, AuthError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/RelayAuth") {}

// Service-scoped evidence is bounded; durable creation receipts have their own limit.
export const ReplayLimit = Context.Reference<number>("@opencode/RelayAuth/ReplayLimit", { defaultValue: () => 1024 })

const fail = (code: RelayError.Code, retryable = false, details?: string) =>
  new AuthError({
    info: RelayError.Info.make({
      code,
      retryable,
      requestId: Hash.fast(`${code}:${Date.now()}`),
      ...(details === undefined ? {} : { details }),
    }),
  })

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const secrets = yield* RelaySecretStore.Service
    const data = (yield* Global.Service).data
    const file = path.join(data, "relay-auth.json")
    const preparingFile = path.join(data, "relay-auth-preparing.json")
    const receiptKeyFile = path.join(data, "relay-auth-receipt-key.json")
    const receiptLimit = Number(process.env.OPENCODE_RELAY_RECEIPT_LIMIT ?? 10_000)
    if (!Number.isSafeInteger(receiptLimit) || receiptLimit < 1)
      return yield* Effect.die(fail("SECRET_STORE_UNAVAILABLE", false))
    let initialized = false
    const flock = yield* EffectFlock.Service
    // All processes sharing data use the same physical lock directory.
    const writePermit = Semaphore.makeUnsafe(1).withPermit
    const decode = Schema.decodeUnknownSync(Stored)
    const encode = Schema.encodeSync(Stored)

    const read = Effect.fn("RelayAuth.read")(function* () {
      const data = yield* fs.readJson(file).pipe(
        Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(empty())),
        Effect.mapError(() => fail("SECRET_STORE_UNAVAILABLE", true)),
      )
      try {
        const stored = decode(data)
        const vendors = {
          ...Object.fromEntries(Object.entries(stored.vendors).map(([id, vendor]) => [id, { ...vendor }])),
        }
        const identities = Object.values(vendors).flatMap((vendor) => (vendor.entityId ? [vendor.entityId] : []))
        if (new Set(identities).size !== identities.length) return yield* fail("SECRET_STORE_UNAVAILABLE", false)
        const receipts = stored.creationReceipts ?? []
        if (
          new Set(receipts.map((item) => item.operationId)).size !== receipts.length ||
          receipts.some((item) => !item.operationId || item.committedRevision > stored.revision)
        )
          return yield* fail("SECRET_STORE_UNAVAILABLE", false)
        if (initialized && Object.values(vendors).some((vendor) => !vendor.entityId))
          return yield* fail("SECRET_STORE_UNAVAILABLE", false)
        if (initialized && receipts.length) yield* receiptKey(true)
        return {
          unified: stored.unified,
          unifiedKeyRef: stored.unifiedKeyRef,
          vendors,
          revision: stored.revision,
          migrationVersion: stored.migrationVersion,
          pendingCleanup: stored.pendingCleanup?.map((item) => ({ ...item, refs: [...item.refs] })),
          creationReceipts: stored.creationReceipts?.map((item) => ({ ...item })),
        } satisfies Draft
      } catch {
        return yield* fail("SECRET_STORE_UNAVAILABLE", true)
      }
    })

    const write = Effect.fn("RelayAuth.write")(function* (next: Draft, onCommit?: () => void) {
      const stamp = Hash.fast(`${Date.now()}:${Math.random()}`)
      const temporary = `${file}.${stamp}.tmp`
      const staged = `${file}.${stamp}.next`
      const content = JSON.stringify(encode(next), null, 2)
      yield* Effect.gen(function* () {
        yield* fs.writeWithDirs(temporary, content, 0o600).pipe(SettledIO.drain)
        // Stage beside the live file before replacing it, so a failed replacement leaves the previous config.
        const source = yield* fs.existsSafe(file)
          ? fs.rename(temporary, staged).pipe(SettledIO.drain, Effect.as(staged))
          : Effect.succeed(temporary)
        const replace = fs.rename(source, file)
        // Install command evidence at the successful replacement boundary before
        // cancellation or cleanup can lose it. Each preparation I/O drains before
        // observing cancellation; publication itself has one completion boundary.
        yield* replace.pipe(
          Effect.tap(() => Effect.sync(() => onCommit?.())),
          SettledIO.drain,
        )
      }).pipe(
        SettledIO.ensuring(fs.remove(temporary, { force: true }).pipe(SettledIO.drain)),
        SettledIO.ensuring(fs.remove(staged, { force: true }).pipe(SettledIO.drain)),
        Effect.mapError(() => fail("SECRET_STORE_UNAVAILABLE", true)),
      )
    })

    const toState = (stored: Draft): Relay.AuthState =>
      Relay.AuthState.make({
        vendors: Object.values(stored.vendors).map((vendor) =>
          Relay.Vendor.make({
            id: vendor.id,
            entityId: vendor.entityId,
            name: vendor.name,
            baseURL: vendor.baseURL,
            builtin: vendor.builtin,
            hasKey: vendor.keyRef !== undefined,
            updatedAt: DateTime.makeUnsafe(vendor.updatedAt),
            revision: vendor.revision,
          }),
        ),
        revision: stored.revision,
        capabilities: [
          "independent-vendors-v1",
          "vendor-entity-v1",
          "vendor-create-receipt-v1",
          "catalog-sync-v1",
          "notice-retry-v1",
          "auth-commit-outcome-v1",
          "vendor-commit-baseline-v1",
        ],
      })

    const requireRevision = (stored: Draft, revision: number) => {
      if (revision !== stored.revision) return Effect.fail(fail("REVISION_CONFLICT"))
      return Effect.void
    }

    const requireEntity = (vendor: DraftVendor | undefined, expected?: VendorExpectation) => {
      if (expected?.expectedEntityId !== undefined && vendor?.entityId !== expected.expectedEntityId)
        return Effect.fail(fail("REQUEST_CONFLICT"))
      if (expected?.expectedVendorRevision !== undefined && vendor?.revision !== expected.expectedVendorRevision)
        return Effect.fail(fail("REQUEST_CONFLICT"))
      return Effect.void
    }

    const receiptKey = Effect.fn("RelayAuth.receiptKey")(function* (required: boolean) {
      const raw = yield* fs.readJson(receiptKeyFile).pipe(
        Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)),
        Effect.mapError(() => fail("SECRET_STORE_UNAVAILABLE", true)),
      )
      if (raw !== undefined) {
        return (yield* Schema.decodeUnknownEffect(ReceiptKey)(raw).pipe(
          Effect.mapError(() => fail("SECRET_STORE_UNAVAILABLE", false)),
        )).key
      }
      if (required) return yield* fail("SECRET_STORE_UNAVAILABLE", false)
      const key = randomBytes(32).toString("hex")
      const temporary = `${receiptKeyFile}.${randomUUID()}.tmp`
      yield* fs.writeWithDirs(temporary, JSON.stringify({ version: 1, key }, null, 2), 0o600).pipe(
        SettledIO.drain,
        Effect.andThen(fs.rename(temporary, receiptKeyFile).pipe(SettledIO.drain)),
        SettledIO.ensuring(fs.remove(temporary, { force: true }).pipe(SettledIO.drain)),
        Effect.mapError(() => fail("SECRET_STORE_UNAVAILABLE", true)),
      )
      return key
    })

    const bump = (stored: Draft) => {
      stored.revision += 1
      return stored
    }

    const putSecret = Effect.fn("RelayAuth.putSecret")(function* (ref: string, key: string) {
      yield* secrets.put(ref, key).pipe(Effect.mapError(() => fail("SECRET_STORE_UNAVAILABLE", true)))
    })

    const removeSecret = Effect.fn("RelayAuth.removeSecret")(function* (ref: string | undefined) {
      if (!ref) return
      yield* secrets.remove(ref).pipe(Effect.mapError(() => fail("SECRET_STORE_UNAVAILABLE", true)))
    })

    const getSecret = Effect.fn("RelayAuth.getSecret")(function* (ref: string | undefined) {
      if (!ref) return
      return yield* secrets.get(ref).pipe(Effect.mapError(() => fail("SECRET_STORE_UNAVAILABLE", true)))
    })

    const replayLimit = yield* ReplayLimit
    if (!Number.isSafeInteger(replayLimit) || replayLimit < 1)
      return yield* Effect.die(fail("SECRET_STORE_UNAVAILABLE", false))
    const replayKey = randomBytes(32)
    const commandOf = (kind: "set" | "clear" | "delete", input: Parameters<Interface["setVendor"]>[0]) => ({
      kind,
      id: input.id,
      entityId: input.expectedEntityId,
      revision: input.revision,
      fingerprint: createHmac("sha256", replayKey)
        .update(
          JSON.stringify([
            kind,
            input.id,
            input.revision,
            input.expectedEntityId === undefined ? null : [input.expectedEntityId],
            input.createOnly === undefined ? null : [input.createOnly],
            input.name === undefined ? null : [input.name],
            input.baseURL === undefined ? null : [input.baseURL],
            input.key === undefined ? null : [input.key],
          ]),
        )
        .digest("hex"),
    })
    const cached = new Map<string, ReturnType<typeof commandOf>>()
    const remember = (id: string, command: ReturnType<typeof commandOf>) => {
      cached.set(id, command)
      if (cached.size > replayLimit) cached.delete(cached.keys().next().value!)
    }
    // Exact protected-delete confirmations live for this service's lifetime.
    // They acknowledge a committed command; they never authorize deleting its successor.
    const deletedCommands = new Map<string, ReturnType<typeof commandOf>>()

    const stateOf = (stored: Draft) => Effect.succeed(toState(stored))

    const usedRefs = (stored: Draft) => {
      const refs = new Set<string>()
      if (stored.unifiedKeyRef) refs.add(stored.unifiedKeyRef)
      for (const vendor of Object.values(stored.vendors)) {
        if (vendor.keyRef) refs.add(vendor.keyRef)
      }
      return refs
    }

    const rememberCleanup = (stored: Draft, operationId: string | undefined, refs: Array<string | undefined>) => {
      const pending = [...new Set(refs.filter((ref): ref is string => ref !== undefined && !usedRefs(stored).has(ref)))]
      const id = operationId ?? `cleanup:${stored.revision}:${pending.join(",")}`
      stored.pendingCleanup = [
        ...(stored.pendingCleanup ?? []).filter((item) => item.operationId !== id),
        ...(pending.length === 0 ? [] : [{ operationId: id, refs: pending, revision: stored.revision }]),
      ]
      if (stored.pendingCleanup.length === 0) stored.pendingCleanup = undefined
      return id
    }

    const committed = (state: Relay.AuthState, cleanupPending = false): CommitResult => ({ ...state, cleanupPending })

    const settleCleanup = Effect.fn("RelayAuth.settleCleanup")(function* (operationId: string) {
      const stored = yield* read()
      const pending = (stored.pendingCleanup ?? []).filter((item) => item.operationId === operationId)
      const active = usedRefs(stored)
      const failed = []
      for (const item of pending) {
        for (const ref of item.refs) {
          if (active.has(ref)) continue
          const removed = yield* Effect.result(removeSecret(ref))
          if (Result.isFailure(removed)) failed.push(ref)
        }
      }
      if (failed.length > 0) {
        const state = yield* stateOf(stored)
        const result = committed(state, true)
        return result
      }
      const remaining = (stored.pendingCleanup ?? []).filter((item) => item.operationId !== operationId)
      stored.pendingCleanup = remaining.length === 0 ? undefined : remaining
      if (pending.length > 0) {
        const written = yield* Effect.result(write(stored))
        if (Result.isFailure(written)) {
          const current = yield* read()
          current.pendingCleanup = stored.pendingCleanup
          const state = yield* stateOf(current)
          const result = committed(state, true)
          return result
        }
      }
      const state = yield* stateOf(stored)
      const result = committed(state)
      return result
    })

    const commit = Effect.fn("RelayAuth.commit")(function* (
      operationId: string | undefined,
      next: Draft,
      retiring: Array<string | undefined> = [],
      onCommit?: () => void,
    ): Effect.fn.Return<CommitResult, AuthError> {
      const id = rememberCleanup(next, operationId, retiring)
      yield* write(next, onCommit)
      return yield* settleCleanup(id)
    })

    const replay = (
      operationId: string | undefined,
      command: ReturnType<typeof commandOf>,
    ): Effect.Effect<CommitResult | undefined, AuthError> =>
      Effect.gen(function* () {
        if (!operationId) return
        if (deletedCommands.has(operationId)) return yield* fail("REQUEST_CONFLICT")
        const stored = yield* read()
        if (stored.creationReceipts?.some((item) => item.operationId === operationId))
          return yield* fail("REQUEST_CONFLICT")
        const entry = cached.get(operationId)
        const pending = stored.pendingCleanup?.some((item) => item.operationId === operationId)
        if (!entry && !pending) return
        // A cleanup number or cached result proves neither command ownership nor payload.
        if (entry?.fingerprint !== command.fingerprint) return yield* fail("REQUEST_CONFLICT")
        return yield* settleCleanup(operationId)
      })

    const readPreparing = Effect.gen(function* () {
      const raw = yield* fs.readJson(preparingFile).pipe(
        Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])),
        Effect.mapError(() => fail("SECRET_STORE_UNAVAILABLE", true)),
      )
      return yield* Schema.decodeUnknownEffect(Schema.Array(Schema.String))(raw).pipe(
        Effect.mapError(() => fail("SECRET_STORE_UNAVAILABLE", true)),
      )
    })
    const recoverPreparing = Effect.gen(function* () {
      const refs = yield* readPreparing
      if (!refs.length) return
      const active = usedRefs(yield* read())
      for (const ref of refs) if (!active.has(ref)) yield* removeSecret(ref)
      yield* fs.remove(preparingFile).pipe(SettledIO.drain, Effect.mapError(() => fail("SECRET_STORE_UNAVAILABLE", true)))
    })

    const replaceSecret = Effect.fn("RelayAuth.replaceSecret")(function* (previous: string | undefined, key: string) {
      const ref = `secret:${randomUUID()}`
      // Journal the owned reference before putting a secret, so a crash before
      // config commit can recover it without scanning/deleting another writer's keys.
      const temporary = `${preparingFile}.${Hash.fast(ref)}.tmp`
      yield* fs.writeWithDirs(temporary, JSON.stringify([...(yield* readPreparing), ref], null, 2), 0o600).pipe(
        SettledIO.drain,
        Effect.andThen(fs.rename(temporary, preparingFile).pipe(SettledIO.drain)),
        SettledIO.ensuring(fs.remove(temporary, { force: true }).pipe(SettledIO.drain)),
        Effect.mapError(() => fail("SECRET_STORE_UNAVAILABLE", true)),
      )
      yield* putSecret(ref, key)
      return { ref, previous: previous === ref ? undefined : previous }
    })

    const mutate = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | AuthError, R> =>
      writePermit(
        Effect.scoped(
          Effect.gen(function* () {
            yield* flock
              .acquire("relay-auth", path.join(data, "locks"))
              .pipe(
                Effect.mapError((error) =>
                  fail(
                    "SECRET_STORE_UNAVAILABLE",
                    true,
                    error._tag === "LockTimeoutError" ? error.diagnosis?.reason : undefined,
                  ),
                ),
              )
            // Staging names belong to the writer protected by this lock.
            const files = yield* fs
              .readDirectory(data)
              .pipe(Effect.mapError(() => fail("SECRET_STORE_UNAVAILABLE", true)))
            for (const name of files.filter((name) =>
              /^relay-auth(?:-preparing)?\.json\.[0-9a-f]{40}\.(?:tmp|next)$/.test(name),
            )) {
              yield* fs
                .remove(path.join(data, name))
                .pipe(SettledIO.drain, Effect.mapError(() => fail("SECRET_STORE_UNAVAILABLE", true)))
            }
            yield* recoverPreparing
            return yield* effect.pipe(SettledIO.ensuring(recoverPreparing))
          }),
        ),
      )

    const migrate = Effect.gen(function* () {
      const stored = yield* read()
      const retired = Object.values(stored.vendors).filter((vendor) => vendor.builtin || !vendor.baseURL)
      if (
        (stored.migrationVersion ?? 0) >= MIGRATION_VERSION &&
        stored.unified === undefined &&
        stored.unifiedKeyRef === undefined &&
        !retired.length
      )
        return
      const retiring = [stored.unifiedKeyRef, ...retired.map((vendor) => vendor.keyRef)]
      for (const vendor of retired) delete stored.vendors[vendor.id]
      delete stored.unified
      delete stored.unifiedKeyRef
      stored.migrationVersion = MIGRATION_VERSION
      bump(stored)
      // Commit retirement before deleting credentials; failed cleanup stays retryable.
      yield* commit(undefined, stored, retiring)
    })

    yield* mutate(
      Effect.gen(function* () {
        const existed = yield* fs.existsSafe(file)
        const stored = yield* read()
        const missing = Object.values(stored.vendors).filter((vendor) => !vendor.entityId)
        for (const vendor of missing) vendor.entityId = randomUUID()
        if (stored.creationReceipts?.length) yield* receiptKey(true)
        if (missing.length || !existed) {
          if (existed) bump(stored)
          yield* write(stored)
        }
        initialized = true
      }),
    ).pipe(Effect.orDie)
    yield* mutate(migrate).pipe(Effect.orDie)
    yield* mutate(
      Effect.gen(function* () {
        const pending = (yield* read()).pendingCleanup ?? []
        for (const item of pending) yield* settleCleanup(item.operationId).pipe(Effect.ignore)
      }),
    ).pipe(Effect.orDie)

    const capture = Effect.fn("RelayAuth.capture")((vendorId: Relay.VendorID, expected?: VendorExpectation) =>
      mutate(
        Effect.gen(function* () {
          const vendor = (yield* read()).vendors[vendorId]
          yield* requireEntity(vendor, expected)
          if (!vendor || vendor.builtin || !vendor.baseURL) return yield* fail("KEY_MISSING")
          if (!vendor.entityId) return yield* fail("SECRET_STORE_UNAVAILABLE")
          const key = yield* getSecret(vendor.keyRef)
          if (!key) return yield* fail("KEY_MISSING")
          return Object.freeze({
            vendorId,
            entityId: vendor.entityId,
            vendorRevision: vendor.revision,
            baseURL: vendor.baseURL,
            key,
          })
        }),
      ),
    )

    return Service.of({
      get: Effect.fn("RelayAuth.get")(function* () {
        return yield* stateOf(yield* read())
      }),
      setVendor: Effect.fn("RelayAuth.setVendor")((input) =>
        mutate(
          Effect.gen(function* () {
            const stored = yield* read()
            if (input.createOnly && !input.operationId) return yield* fail("REQUEST_CONFLICT")
            // A committed delete owns its ID even if cancellation prevented result caching.
            if (input.createOnly && input.operationId && deletedCommands.has(input.operationId))
              return yield* fail("REQUEST_CONFLICT")
            if (!input.createOnly) {
              yield* requireEntity(stored.vendors[input.id], input)
              const replayed = yield* replay(input.operationId, commandOf("set", input))
              if (replayed) return replayed
            }
            const prior = stored.creationReceipts?.find((item) => item.operationId === input.operationId)
            if (input.createOnly && !prior) {
              if (
                cached.has(input.operationId!) ||
                stored.pendingCleanup?.some((item) => item.operationId === input.operationId)
              )
                return yield* fail("REQUEST_CONFLICT")
              yield* requireRevision(stored, input.revision)
              yield* requireEntity(stored.vendors[input.id], input)
              if (stored.vendors[input.id] || (stored.creationReceipts?.length ?? 0) >= receiptLimit)
                return yield* fail("REQUEST_CONFLICT", false, "vendor exists or creation receipt capacity reached")
            }
            const signingKey = input.createOnly ? yield* receiptKey(!!stored.creationReceipts?.length) : undefined
            const fingerprint =
              signingKey === undefined
                ? undefined
                : createHmac("sha256", Buffer.from(signingKey, "hex"))
                    .update(
                      JSON.stringify([
                        "vendor-create",
                        input.id,
                        input.revision,
                        true,
                        input.name === undefined ? null : [input.name.trim()],
                        input.baseURL === undefined ? null : [input.baseURL.replace(/\/+$/, "")],
                        input.key === undefined ? null : [input.key],
                        input.expectedEntityId === undefined ? null : [input.expectedEntityId],
                      ]),
                    )
                    .digest("hex")
            const receipt = stored.creationReceipts?.find((item) => item.operationId === input.operationId)
            if (input.createOnly && receipt) {
              if (receipt.fingerprint !== fingerprint) return yield* fail("REQUEST_CONFLICT")
              const state = yield* settleCleanup(receipt.operationId)
              const { fingerprint: _fingerprint, ...operationReceipt } = receipt
              return { ...state, operationReceipt }
            }
            if (input.createOnly && cached.has(input.operationId!)) return yield* fail("REQUEST_CONFLICT")
            yield* requireRevision(stored, input.revision)
            yield* requireEntity(stored.vendors[input.id], input)
            if (
              input.createOnly &&
              (stored.vendors[input.id] || (stored.creationReceipts?.length ?? 0) >= receiptLimit)
            )
              return yield* fail("REQUEST_CONFLICT", false, "vendor exists or creation receipt capacity reached")
            const now = DateTime.toEpochMillis(yield* DateTime.now)
            const existing = stored.vendors[input.id]
            const vendor: DraftVendor = existing ?? {
              id: input.id,
              entityId: randomUUID(),
              name: input.name ?? input.id,
              builtin: false,
              updatedAt: now,
              revision: 0,
            }
            if (!existing && !input.name) return yield* Effect.fail(fail("REQUEST_CONFLICT", false, "name required"))
            if (input.baseURL !== undefined) {
              if (vendor.builtin || !Schema.is(Relay.VendorBaseURL)(input.baseURL) || !URL.canParse(input.baseURL)) {
                return yield* Effect.fail(fail("REQUEST_CONFLICT", false, "invalid vendor baseURL"))
              }
              vendor.baseURL = input.baseURL.replace(/\/+$/, "")
            }
            if (!vendor.baseURL) return yield* fail("REQUEST_CONFLICT", false, "independent baseURL required")
            if (input.key !== undefined && !input.key.trim()) return yield* fail("KEY_MISSING")
            if (input.name !== undefined) vendor.name = input.createOnly ? input.name.trim() : input.name
            const created = input.key === undefined ? undefined : yield* replaceSecret(vendor.keyRef, input.key)
            if (created) vendor.keyRef = created.ref
            vendor.updatedAt = now
            vendor.revision += 1
            stored.vendors[input.id] = vendor
            bump(stored)
            const operationReceipt = input.createOnly
              ? {
                  operationId: input.operationId!,
                  kind: "vendor-create" as const,
                  vendorId: input.id,
                  entityId: vendor.entityId!,
                  committedRevision: stored.revision,
                }
              : undefined
            if (operationReceipt)
              stored.creationReceipts = [
                ...(stored.creationReceipts ?? []),
                { ...operationReceipt, fingerprint: fingerprint! },
              ]
            const command = input.createOnly ? undefined : commandOf("set", input)
            return yield* commit(
              input.operationId,
              stored,
              created ? [created.previous] : [],
              command && input.operationId ? () => remember(input.operationId!, command) : undefined,
            ).pipe(
              Effect.map((state) => (operationReceipt ? { ...state, operationReceipt } : state)),
            )
          }),
        ),
      ),
      clearVendorKey: Effect.fn("RelayAuth.clearVendorKey")((input) =>
        mutate(
          Effect.gen(function* () {
            yield* requireEntity((yield* read()).vendors[input.id], input)
            const command = commandOf("clear", input)
            const replayed = yield* replay(input.operationId, command)
            if (replayed) return replayed
            const stored = yield* read()
            yield* requireRevision(stored, input.revision)
            const current = stored.vendors[input.id]
            if (!current) return yield* Effect.fail(fail("REQUEST_CONFLICT", false, "vendor not found"))
            const previous = current.keyRef
            const vendor: DraftVendor = { ...current, keyRef: undefined }
            vendor.updatedAt = DateTime.toEpochMillis(yield* DateTime.now)
            vendor.revision += 1
            stored.vendors[input.id] = vendor
            bump(stored)
            return yield* commit(
              input.operationId,
              stored,
              [previous],
              input.operationId ? () => remember(input.operationId!, command) : undefined,
            )
          }),
        ),
      ),
      deleteVendor: Effect.fn("RelayAuth.deleteVendor")((input) =>
        mutate(
          Effect.gen(function* () {
            const command = commandOf("delete", input)
            const confirmed = input.operationId ? deletedCommands.get(input.operationId) : undefined
            if (confirmed) {
              if (confirmed.fingerprint !== command.fingerprint) return yield* fail("REQUEST_CONFLICT")
              return yield* settleCleanup(input.operationId!)
            }
            const replayed = yield* replay(input.operationId, command)
            if (replayed) return replayed
            const stored = yield* read()
            yield* requireRevision(stored, input.revision)
            yield* requireEntity(stored.vendors[input.id], input)
            const vendor = stored.vendors[input.id]
            if (!vendor) return yield* Effect.fail(fail("REQUEST_CONFLICT", false, "vendor not found"))
            if (vendor.builtin) return yield* Effect.fail(fail("REQUEST_CONFLICT", false, "builtin vendor"))
            const previous = vendor.keyRef
            delete stored.vendors[input.id]
            bump(stored)
            const operationId = input.operationId
            const entityId = input.expectedEntityId
            return yield* commit(
              input.operationId,
              stored,
              [previous],
              operationId
                ? () => entityId !== undefined
                  ? void deletedCommands.set(operationId, command)
                  : remember(operationId, command)
                : undefined,
            )
          }),
        ),
      ),
      capture,
      resolve: Effect.fn("RelayAuth.resolve")((vendorId, expected) =>
        capture(vendorId, expected).pipe(Effect.map((snapshot) => ({ key: snapshot.key, baseURL: snapshot.baseURL }))),
      ),
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [FSUtil.node, Global.node, RelaySecretStore.node, EffectFlock.node],
})
