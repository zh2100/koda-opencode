export * as RelayAuth from "./relay-auth"

import { DateTime, Effect, Layer, Schema, Context } from "effect"
import { makeGlobalNode } from "./effect/app-node"
import { Relay } from "@opencode-ai/schema/relay"
import { RelayError } from "@opencode-ai/schema/relay-error"
import { NonNegativeInt } from "./schema"
import type { DeepMutable } from "./schema"
import { FSUtil } from "./fs-util"
import { Global } from "./global"
import { RelayPolicy } from "./relay-policy"
import { RelaySecretStore } from "./relay-secret-store"
import { Hash } from "./util/hash"
import path from "path"

export class AuthError extends Schema.TaggedErrorClass<AuthError>()("Relay.AuthError", {
  info: RelayError.Info,
}) {}

const StoredVendor = Schema.Struct({
  id: Relay.VendorID,
  name: Schema.String,
  builtin: Schema.Boolean,
  keyRef: Schema.optional(Schema.String),
  updatedAt: Schema.Finite,
  revision: NonNegativeInt,
})

const Stored = Schema.Struct({
  unified: Schema.Boolean,
  unifiedKeyRef: Schema.optional(Schema.String),
  vendors: Schema.Record(Schema.String, StoredVendor),
  revision: NonNegativeInt,
  migrationVersion: NonNegativeInt.pipe(Schema.optional),
})

type DraftVendor = DeepMutable<typeof StoredVendor.Type>
type Draft = DeepMutable<typeof Stored.Type>

const builtin = [
  { id: Relay.VendorID.chatgpt, name: "ChatGPT" },
  { id: Relay.VendorID.grok, name: "Grok" },
] as const

const initialVendors = (): Record<string, DraftVendor> =>
  Object.fromEntries(
    builtin.map((item) => [
      item.id,
      {
        id: item.id,
        name: item.name,
        builtin: true,
        updatedAt: 0,
        revision: 0,
      },
    ]),
  )

const empty = (): Draft => ({
  unified: false,
  vendors: initialVendors(),
  revision: 0,
})

const MIGRATION_VERSION = 1

const vendorFromProvider = (id: string) => {
  if (id === "openai" || id === "chatgpt") return Relay.VendorID.chatgpt
  if (id === "xai" || id === "grok") return Relay.VendorID.grok
}

export interface Interface {
  readonly get: () => Effect.Effect<Relay.AuthState, AuthError>
  readonly setMode: (input: {
    readonly unified: boolean
    readonly revision: number
    readonly operationId?: string
  }) => Effect.Effect<Relay.AuthState, AuthError>
  readonly setUnifiedKey: (input: {
    readonly key?: string
    readonly revision: number
    readonly operationId?: string
  }) => Effect.Effect<Relay.AuthState, AuthError>
  readonly clearUnifiedKey: (input: {
    readonly revision: number
    readonly operationId?: string
  }) => Effect.Effect<Relay.AuthState, AuthError>
  readonly setVendor: (input: {
    readonly id: Relay.VendorID
    readonly name?: string
    readonly key?: string
    readonly revision: number
    readonly operationId?: string
  }) => Effect.Effect<Relay.AuthState, AuthError>
  readonly clearVendorKey: (input: {
    readonly id: Relay.VendorID
    readonly revision: number
    readonly operationId?: string
  }) => Effect.Effect<Relay.AuthState, AuthError>
  readonly deleteVendor: (input: {
    readonly id: Relay.VendorID
    readonly revision: number
    readonly operationId?: string
  }) => Effect.Effect<Relay.AuthState, AuthError>
  readonly resolve: (vendorId: Relay.VendorID) => Effect.Effect<string, AuthError>
  readonly rollback: (input: {
    readonly revision: number
    readonly operationId?: string
  }) => Effect.Effect<Relay.AuthState, AuthError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/RelayAuth") {}

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
    const backupFile = path.join(data, "auth.relay-backup.json")
    const decode = Schema.decodeUnknownSync(Stored)
    const encode = Schema.encodeSync(Stored)

    const read = Effect.fn("RelayAuth.read")(function* () {
      const data = yield* fs.readJson(file).pipe(Effect.orElseSucceed(() => empty()))
      try {
        const stored = decode(data)
        return {
          unified: stored.unified,
          unifiedKeyRef: stored.unifiedKeyRef,
          vendors: {
            ...initialVendors(),
            ...Object.fromEntries(Object.entries(stored.vendors).map(([id, vendor]) => [id, { ...vendor }])),
          },
          revision: stored.revision,
          migrationVersion: stored.migrationVersion,
        } satisfies Draft
      } catch {
        return empty()
      }
    })

    const write = Effect.fn("RelayAuth.write")(function* (next: Draft) {
      yield* fs.writeJson(file, encode(next), 0o600).pipe(Effect.mapError(() => fail("SECRET_STORE_UNAVAILABLE", true)))
    })

    const toState = (stored: Draft, canRollback: boolean): Relay.AuthState =>
      Relay.AuthState.make({
        unified: stored.unified,
        hasUnifiedKey: stored.unifiedKeyRef !== undefined,
        vendors: Object.values(stored.vendors).map((vendor) =>
          Relay.Vendor.make({
            id: vendor.id,
            name: vendor.name,
            builtin: vendor.builtin,
            hasKey: vendor.keyRef !== undefined,
            updatedAt: DateTime.makeUnsafe(vendor.updatedAt),
            revision: vendor.revision,
          }),
        ),
        revision: stored.revision,
        canRollback,
      })

    const requireRevision = (stored: Draft, revision: number) => {
      if (revision !== stored.revision) return fail("REVISION_CONFLICT")
    }

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

    const cached = new Map<string, Relay.AuthState>()

    const stateOf = (stored: Draft) =>
      Effect.gen(function* () {
        return toState(stored, yield* fs.existsSafe(backupFile))
      })

    const commit = Effect.fn("RelayAuth.commit")(function* (operationId: string | undefined, next: Draft) {
      yield* write(next)
      const state = yield* stateOf(next)
      if (operationId) cached.set(operationId, state)
      return state
    })

    const replay = (operationId: string | undefined) => {
      if (!operationId) return
      return cached.get(operationId)
    }

    const migrate = Effect.fn("RelayAuth.migrate")(function* () {
      const stored = yield* read()
      if ((stored.migrationVersion ?? 0) >= MIGRATION_VERSION) return
      const source = path.join(data, "auth.json")
      const raw = yield* fs.readJson(source).pipe(Effect.orElseSucceed(() => undefined))
      if (!raw || typeof raw !== "object") {
        stored.migrationVersion = MIGRATION_VERSION
        yield* write(stored)
        return
      }
      const entries = Object.entries(raw as Record<string, unknown>)
      const backup = Object.fromEntries(
        entries.map(([id, value]) => {
          if (!value || typeof value !== "object") return [id, value]
          return [
            id,
            Object.fromEntries(
              Object.entries(value as Record<string, unknown>).map(([key, item]) =>
                key === "key" || key === "access" || key === "refresh" || key === "token" ? [key, "***"] : [key, item],
              ),
            ),
          ]
        }),
      )
      yield* fs
        .writeJson(path.join(data, "auth.relay-backup.json"), backup, 0o600)
        .pipe(Effect.mapError(() => fail("SECRET_STORE_UNAVAILABLE", true)))
      const now = Date.now()
      for (const [id, value] of entries) {
        if (!value || typeof value !== "object") continue
        const record = value as { type?: unknown; key?: unknown }
        if (record.type !== "api" || typeof record.key !== "string" || !record.key) continue
        if (id === RelayPolicy.ProviderID) {
          if (stored.unifiedKeyRef) continue
          const ref = `unified:${Hash.fast("unified")}`
          yield* putSecret(ref, record.key)
          stored.unifiedKeyRef = ref
          stored.unified = true
          continue
        }
        const vendorId = vendorFromProvider(id)
        if (!vendorId) continue
        const vendor = stored.vendors[vendorId]
        if (!vendor || vendor.keyRef) continue
        const ref = `vendor:${vendorId}`
        yield* putSecret(ref, record.key)
        vendor.keyRef = ref
        vendor.updatedAt = now
        vendor.revision += 1
      }
      stored.migrationVersion = MIGRATION_VERSION
      bump(stored)
      yield* write(stored)
    })

    yield* migrate().pipe(Effect.catch(() => Effect.void))

    return Service.of({
      get: Effect.fn("RelayAuth.get")(function* () {
        return yield* stateOf(yield* read())
      }),
      setMode: Effect.fn("RelayAuth.setMode")(function* (input) {
        const replayed = replay(input.operationId)
        if (replayed) return replayed
        const stored = yield* read()
        const conflict = requireRevision(stored, input.revision)
        if (conflict) return yield* conflict
        stored.unified = input.unified
        bump(stored)
        return yield* commit(input.operationId, stored)
      }),
      setUnifiedKey: Effect.fn("RelayAuth.setUnifiedKey")(function* (input) {
        const replayed = replay(input.operationId)
        if (replayed) return replayed
        const stored = yield* read()
        const conflict = requireRevision(stored, input.revision)
        if (conflict) return yield* conflict
        if (input.key !== undefined) {
          const ref = stored.unifiedKeyRef ?? `unified:${Hash.fast("unified")}`
          yield* putSecret(ref, input.key)
          stored.unifiedKeyRef = ref
        }
        bump(stored)
        return yield* commit(input.operationId, stored)
      }),
      clearUnifiedKey: Effect.fn("RelayAuth.clearUnifiedKey")(function* (input) {
        const replayed = replay(input.operationId)
        if (replayed) return replayed
        const stored = yield* read()
        const conflict = requireRevision(stored, input.revision)
        if (conflict) return yield* conflict
        yield* removeSecret(stored.unifiedKeyRef)
        stored.unifiedKeyRef = undefined
        bump(stored)
        return yield* commit(input.operationId, stored)
      }),
      setVendor: Effect.fn("RelayAuth.setVendor")(function* (input) {
        const replayed = replay(input.operationId)
        if (replayed) return replayed
        const stored = yield* read()
        const conflict = requireRevision(stored, input.revision)
        if (conflict) return yield* conflict
        const now = DateTime.toEpochMillis(yield* DateTime.now)
        const existing = stored.vendors[input.id]
        const vendor: DraftVendor = existing ?? {
          id: input.id,
          name: input.name ?? input.id,
          builtin: false,
          updatedAt: now,
          revision: 0,
        }
        if (!existing && !input.name) return yield* fail("REQUEST_CONFLICT", false, "name required")
        if (input.name !== undefined) vendor.name = input.name
        if (input.key !== undefined) {
          const ref = vendor.keyRef ?? `vendor:${input.id}`
          yield* putSecret(ref, input.key)
          vendor.keyRef = ref
        }
        vendor.updatedAt = now
        vendor.revision += 1
        stored.vendors[input.id] = vendor
        bump(stored)
        return yield* commit(input.operationId, stored)
      }),
      clearVendorKey: Effect.fn("RelayAuth.clearVendorKey")(function* (input) {
        const replayed = replay(input.operationId)
        if (replayed) return replayed
        const stored = yield* read()
        const conflict = requireRevision(stored, input.revision)
        if (conflict) return yield* conflict
        const current = stored.vendors[input.id]
        if (!current) return yield* fail("REQUEST_CONFLICT", false, "vendor not found")
        yield* removeSecret(current.keyRef)
        const vendor: DraftVendor = { ...current, keyRef: undefined }
        vendor.updatedAt = DateTime.toEpochMillis(yield* DateTime.now)
        vendor.revision += 1
        stored.vendors[input.id] = vendor
        bump(stored)
        return yield* commit(input.operationId, stored)
      }),
      deleteVendor: Effect.fn("RelayAuth.deleteVendor")(function* (input) {
        const replayed = replay(input.operationId)
        if (replayed) return replayed
        const stored = yield* read()
        const conflict = requireRevision(stored, input.revision)
        if (conflict) return yield* conflict
        const vendor = stored.vendors[input.id]
        if (!vendor) return yield* fail("REQUEST_CONFLICT", false, "vendor not found")
        if (vendor.builtin) return yield* fail("REQUEST_CONFLICT", false, "builtin vendor")
        yield* removeSecret(vendor.keyRef)
        delete stored.vendors[input.id]
        bump(stored)
        return yield* commit(input.operationId, stored)
      }),
      resolve: Effect.fn("RelayAuth.resolve")(function* (vendorId) {
        const stored = yield* read()
        if (stored.unified) {
          const key = yield* getSecret(stored.unifiedKeyRef)
          if (!key) return yield* fail("KEY_MISSING")
          return key
        }
        const vendor = stored.vendors[vendorId]
        const key = yield* getSecret(vendor?.keyRef)
        if (!key) return yield* fail("KEY_MISSING")
        return key
      }),
      rollback: Effect.fn("RelayAuth.rollback")(function* (input) {
        const replayed = replay(input.operationId)
        if (replayed) return replayed
        const stored = yield* read()
        const conflict = requireRevision(stored, input.revision)
        if (conflict) return yield* conflict
        if (!(yield* fs.existsSafe(backupFile))) return yield* fail("REQUEST_CONFLICT", false, "backup missing")
        yield* removeSecret(stored.unifiedKeyRef)
        for (const vendor of Object.values(stored.vendors)) yield* removeSecret(vendor.keyRef)
        const next = empty()
        next.revision = stored.revision
        next.migrationVersion = MIGRATION_VERSION
        bump(next)
        return yield* commit(input.operationId, next)
      }),
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [FSUtil.node, Global.node, RelaySecretStore.node],
})
