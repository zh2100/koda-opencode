export * as RelayCatalog from "./relay-catalog"

import { Cause, Context, DateTime, Effect, Exit, Layer, Option, Schedule, Schema, Semaphore } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { makeGlobalNode } from "./effect/app-node"
import { Relay } from "@opencode-ai/schema/relay"
import { RelayError } from "@opencode-ai/schema/relay-error"
import { RelayModel } from "@opencode-ai/schema/relay-model"
import { RelaySync } from "@opencode-ai/schema/relay-sync"
import { Model } from "@opencode-ai/schema/model"
import { EffectFlock } from "./util/effect-flock"
import { FSUtil } from "./fs-util"
import { Global } from "./global"
import { Hash } from "./util/hash"
import { ModelV2 } from "./model"
import { ProviderV2 } from "./provider"
import { RelayAuth } from "./relay-auth"
import { RelayCapability } from "./relay-capability"
import { RelayEvent } from "@opencode-ai/schema/relay-event"
import { EventV2 } from "./event"
import { httpClient } from "./effect/app-node-platform"
import path from "path"
import { randomUUID } from "node:crypto"

export const AUTH_LOCK_KEY = "relay-auth"
export const CATALOG_LOCK_KEY = "relay-catalog"
type CommitHook = (phase: "prepare" | "write" | "renamed") => Effect.Effect<void, unknown>
const commitHooks: CommitHook[] = []
export const withCommitHook = (hook: CommitHook) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      commitHooks.push(hook)
    }),
    () =>
      Effect.sync(() => {
        const index = commitHooks.indexOf(hook)
        if (index >= 0) commitHooks.splice(index, 1)
      }),
  )

export class CatalogError extends Schema.TaggedErrorClass<CatalogError>()("Relay.CatalogError", {
  info: RelayError.Info,
}) {}

const Upstream = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      owned_by: Schema.optional(Schema.String),
    }),
  ),
})

const StoredCandidate = Schema.Struct({
  vendorId: Schema.optional(Relay.VendorID),
  // Identifies the upstream refresh that produced this candidate. Legacy unresolved
  // candidates do not have this field and cannot be attributed safely.
  sourceVendorId: Schema.optional(Relay.VendorID),
  modelId: Model.ID,
  displayName: Schema.optional(Schema.String),
  ownedBy: Schema.optional(Schema.String),
  fetchedAt: Schema.Finite,
  assignmentSource: RelayModel.AssignmentSource,
  upstreamPresent: Schema.Boolean,
  fingerprint: Schema.String,
  requestVersion: Schema.Number,
})

const StoredManaged = Schema.Struct({
  vendorId: Relay.VendorID,
  modelId: Model.ID,
  visible: Schema.Boolean,
  assignmentSource: RelayModel.AssignmentSource,
  lastSeenAt: Schema.Finite,
  upstreamPresent: Schema.Boolean,
})

const Token = Schema.String.check(Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/))
const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))

const Quarantined = Schema.Struct({
  vendorId: Schema.optional(Relay.VendorID),
  sourceVendorId: Schema.optional(Relay.VendorID),
  modelId: Model.ID,
  reason: Schema.Literal("missing-entity-binding"),
  kinds: Schema.Array(Schema.Literals(["candidate", "managed"])),
  visible: Schema.optional(Schema.Boolean),
  displayName: Schema.optional(Schema.String),
  ownedBy: Schema.optional(Schema.String),
  knownEntities: Schema.Record(Schema.String, Token),
})
const Quarantine = Schema.Struct({ version: Schema.Literal(1), entries: Schema.Array(Quarantined) })
const quarantineKey = (item: typeof Quarantined.Type) =>
  JSON.stringify([item.vendorId ?? null, item.sourceVendorId ?? null, item.modelId, item.reason])

const Stored = Schema.Struct({
  candidates: Schema.Array(StoredCandidate),
  managed: Schema.Array(StoredManaged),
  requestVersion: Schema.Number,
  catalogRevision: Schema.optional(Revision),
  refreshRequests: Schema.optional(Schema.Record(Schema.String, Token)),
  vendorEntities: Schema.optional(Schema.Record(Schema.String, Token)),
  quarantine: Schema.optional(Quarantine),
})

type Draft = {
  candidates: Array<(typeof StoredCandidate)["Type"]>
  managed: Array<(typeof StoredManaged)["Type"]>
  requestVersion: number
  catalogRevision: number
  versioned: boolean
  refreshRequests: Record<string, string>
  vendorEntities: Record<string, string>
  quarantine: { version: 1; entries: Array<typeof Quarantined.Type> }
}

const empty = (): Draft => ({
  candidates: [],
  managed: [],
  requestVersion: 0,
  catalogRevision: 0,
  versioned: true,
  refreshRequests: {},
  vendorEntities: {},
  quarantine: { version: 1, entries: [] },
})

// Every independent endpoint owns its model namespace, including names once used by hosted vendors.
export const modelID = (vendorId: string, upstreamID: string) =>
  Model.ID.make(`custom:${vendorId}:${encodeURIComponent(upstreamID)}`)

export interface Interface {
  readonly candidates: (vendorId?: Relay.VendorID) => Effect.Effect<RelayModel.Candidate[]>
  readonly managed: () => Effect.Effect<RelayModel.Managed[]>
  readonly hasManaged: () => boolean
  readonly visible: (modelId: string) => boolean
  readonly refresh: (
    vendorId: Relay.VendorID,
    expected?: RelayAuth.VendorExpectation,
  ) => Effect.Effect<RelayModel.Candidate[], RelayAuth.AuthError | CatalogError>
  readonly probe: (
    vendorId: Relay.VendorID,
    expected?: RelayAuth.VendorExpectation,
  ) => Effect.Effect<{ count: number }, RelayAuth.AuthError | CatalogError>
  readonly setVisibility: (input: {
    readonly expectedEntityId?: string
    readonly vendorId: Relay.VendorID
    readonly modelId: Model.ID
    readonly visible: boolean
  }) => Effect.Effect<RelayModel.Managed[], CatalogError>
  readonly synchronize: (options?: {
    readonly retryNotice?: boolean
  }) => Effect.Effect<RelaySync.Snapshot, CatalogError | RelayAuth.AuthError>
  readonly syncVendors: () => Effect.Effect<void, CatalogError | RelayAuth.AuthError>
  readonly apply: (
    update: (
      providerID: string,
      modelID: string,
      fn: (model: {
        name: string
        family?: string
        enabled: boolean
        status?: string
        time?: { released: number }
        capabilities?: { tools: boolean; input: string[]; output: string[] }
        limit?: { context: number; output: number }
        api: unknown
        variants: unknown
      }) => void,
    ) => void,
  ) => void
}

export class Service extends Context.Service<Service, Interface>()("@opencode/RelayCatalog") {}

const fail = (code: RelayError.Code, retryable = true, details?: string) =>
  new CatalogError({
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
    const auth = yield* RelayAuth.Service
    const events = yield* EventV2.Service
    const flock = yield* EffectFlock.Service
    const http = yield* HttpClient.HttpClient
    const dataDir = (yield* Global.Service).data
    const file = path.join(dataDir, "relay-catalog.json")
    const lockDir = path.join(dataDir, "locks")
    const decode = Schema.decodeUnknownSync(Stored)
    const encode = Schema.encodeSync(Stored)

    const read = Effect.fn("RelayCatalog.read")(function* () {
      const data = yield* fs
        .readJson(file)
        .pipe(
          Effect.catch((error) =>
            error._tag === "PlatformError" && error.reason._tag === "NotFound"
              ? Effect.succeed(empty())
              : Effect.fail(fail("SECRET_STORE_UNAVAILABLE")),
          ),
        )
      const stored = yield* Effect.try({
        try: () => decode(data),
        catch: () => fail("SECRET_STORE_UNAVAILABLE", false, "catalog schema"),
      })
      const entries = stored.quarantine?.entries ?? []
      if (
        entries.some((item) => !item.kinds.length || new Set(item.kinds).size !== item.kinds.length) ||
        new Set(entries.map(quarantineKey)).size !== entries.length
      )
        return yield* fail("SECRET_STORE_UNAVAILABLE", false, "catalog quarantine")
      return {
        quarantine: { version: 1, entries: [...entries] },
        candidates: stored.candidates.map((item) =>
          item.sourceVendorId || !item.vendorId ? item : { ...item, sourceVendorId: item.vendorId },
        ),
        managed: [...stored.managed],
        requestVersion: stored.requestVersion,
        catalogRevision: stored.catalogRevision ?? 0,
        versioned: stored.catalogRevision !== undefined,
        refreshRequests: { ...(stored.refreshRequests ?? {}) },
        vendorEntities: { ...(stored.vendorEntities ?? {}) },
      } satisfies Draft
    })

    const fetchUpstream = Effect.fn("RelayCatalog.fetchUpstream")(
      function* (resolved: RelayAuth.CredentialSnapshot) {
        const response = yield* HttpClientRequest.get(`${resolved.baseURL}/models`).pipe(
          HttpClientRequest.setHeader("Authorization", `Bearer ${resolved.key}`),
          http.execute,
          Effect.mapError(() => fail("UPSTREAM_UNREACHABLE")),
        )
        if (response.status === 401 || response.status === 403) return yield* fail("KEY_REJECTED", false)
        if (response.status === 429) return yield* fail("UPSTREAM_RATE_LIMITED")
        if (response.status < 200 || response.status >= 300) return yield* fail("UPSTREAM_UNREACHABLE")
        const body = yield* response.json.pipe(Effect.mapError(() => fail("UPSTREAM_INVALID_RESPONSE", false)))
        const parsed = Schema.decodeUnknownOption(Upstream)(body)
        if (Option.isNone(parsed)) return yield* fail("UPSTREAM_INVALID_RESPONSE", false)
        return parsed.value
      },
      (effect) =>
        effect.pipe(
          Effect.timeout("10 seconds"),
          Effect.mapError((error) => (error._tag === "TimeoutError" ? fail("UPSTREAM_TIMEOUT") : error)),
        ),
    )

    const pendingNotice = { sequence: 0, pending: 0, delivered: 0, attempts: 0 }
    const noticePermit = Semaphore.makeUnsafe(1).withPermit
    const noticeStatus = () =>
      pendingNotice.pending === 0
        ? ("idle" as const)
        : pendingNotice.attempts > 8
          ? ("exhausted" as const)
          : ("pending" as const)
    const note = () => {
      pendingNotice.sequence += 1
      pendingNotice.pending = pendingNotice.sequence
      pendingNotice.attempts = 0
    }
    const flushNotice = Effect.fn("RelayCatalog.flushNotice")(function* () {
      return yield* noticePermit(
        Effect.gen(function* () {
          const sequence = pendingNotice.pending
          if (sequence === 0 || pendingNotice.attempts > 8) return noticeStatus()
          const published = yield* events.publish(RelayEvent.CatalogUpdated, {}).pipe(Effect.exit)
          if (published._tag === "Failure") {
            if (Cause.hasInterrupts(published.cause)) return yield* Effect.failCause(published.cause)
            if (pendingNotice.pending === sequence) pendingNotice.attempts += 1
            return "retry" as const
          }
          pendingNotice.delivered = Math.max(pendingNotice.delivered, sequence)
          if (pendingNotice.pending === sequence) {
            pendingNotice.pending = 0
            pendingNotice.attempts = 0
            return "published" as const
          }
          return "retry" as const
        }),
      )
    })

    const toCandidate = (item: typeof StoredCandidate.Type): RelayModel.Candidate =>
      RelayModel.Candidate.make({
        vendorId: item.vendorId,
        modelId: item.modelId,
        displayName: item.displayName,
        ownedBy: item.ownedBy,
        fetchedAt: DateTime.makeUnsafe(item.fetchedAt),
        assignmentSource: item.assignmentSource,
        upstreamPresent: item.upstreamPresent,
      })

    const toManaged = (item: typeof StoredManaged.Type): RelayModel.Managed =>
      RelayModel.Managed.make({
        vendorId: item.vendorId,
        modelId: item.modelId,
        visible: item.visible,
        reasoningCapabilities: [...RelayCapability.efforts(item.vendorId, item.modelId)],
        assignmentSource: item.assignmentSource,
        lastSeenAt: DateTime.makeUnsafe(item.lastSeenAt),
        upstreamPresent: item.upstreamPresent,
      })

    let snapshot = empty()
    const initialAuth = yield* auth.get().pipe(Effect.orDie)
    let vendors = initialAuth.vendors
    const vendorIdentity = (
      items: ReadonlyArray<{ id: string; entityId?: string; baseURL?: string; revision: number }>,
    ) =>
      items
        .map((item) => `${item.id}:${item.entityId ?? ""}:${item.baseURL ?? ""}:${item.revision}`)
        .sort()
        .join("\n")
    const authIdentity = (state: Relay.AuthState) => `${state.revision}:${vendorIdentity(state.vendors)}`
    let authStamp = authIdentity(initialAuth)
    let ready = false
    const commitPermit = Semaphore.makeUnsafe(1).withPermit
    const copy = (draft: Draft): Draft => ({
      candidates: draft.candidates.map((item) => ({ ...item })),
      managed: draft.managed.map((item) => ({ ...item })),
      requestVersion: draft.requestVersion,
      catalogRevision: draft.catalogRevision,
      versioned: draft.versioned,
      refreshRequests: { ...draft.refreshRequests },
      vendorEntities: { ...draft.vendorEntities },
      quarantine: {
        version: 1,
        entries: draft.quarantine.entries.map((item) => ({
          ...item,
          kinds: [...item.kinds],
          knownEntities: { ...item.knownEntities },
        })),
      },
    })
    const same = (left: Draft, right: Draft) =>
      left.requestVersion === right.requestVersion &&
      left.catalogRevision === right.catalogRevision &&
      left.versioned === right.versioned &&
      JSON.stringify(left.candidates) === JSON.stringify(right.candidates) &&
      JSON.stringify(left.managed) === JSON.stringify(right.managed) &&
      JSON.stringify(left.refreshRequests) === JSON.stringify(right.refreshRequests) &&
      JSON.stringify(left.vendorEntities) === JSON.stringify(right.vendorEntities) &&
      JSON.stringify(left.quarantine) === JSON.stringify(right.quarantine)
    const commitFile = (next: Draft) =>
      Effect.gen(function* () {
        const temporary = path.join(dataDir, `relay-catalog.json.${randomUUID()}.tmp`)
        // A test hook failure is a commit failure. Mapping it here keeps the defect inside
        // the transaction instead of letting the hook's scope finalizer surface it later.
        const observe = (phase: "prepare" | "write") =>
          Effect.gen(function* () {
            for (const hook of commitHooks) {
              const exit = yield* hook(phase).pipe(Effect.exit)
              if (exit._tag === "Failure") return yield* fail("SECRET_STORE_UNAVAILABLE")
            }
          })
        const removeTemporary = () => fs.remove(temporary).pipe(Effect.ignore)
        yield* observe("prepare").pipe(Effect.onError(() => removeTemporary()))
        yield* fs.writeJson(temporary, encode(next), 0o600).pipe(
          Effect.mapError(() => fail("SECRET_STORE_UNAVAILABLE")),
          Effect.onError(() => removeTemporary()),
        )
        yield* observe("write").pipe(Effect.onError(() => removeTemporary()))
        yield* fs.rename(temporary, file).pipe(
          Effect.mapError(() => fail("SECRET_STORE_UNAVAILABLE")),
          Effect.onError(() => removeTemporary()),
        )
      })
    const transact = <A, E>(
      change: (input: {
        readonly draft: Draft
        readonly vendors: Relay.AuthState["vendors"]
      }) => Effect.Effect<{ readonly draft: Draft; readonly value: A; readonly notify: boolean }, E | CatalogError>,
      capture?: (draft: Draft, auth: Relay.AuthState) => void,
      deliver = true,
    ) =>
      commitPermit(
        Effect.scoped(
          Effect.gen(function* () {
            // Read-only under the auth write lock. setVendor and other mutate calls reacquire this key.
            yield* flock.acquire(AUTH_LOCK_KEY, lockDir).pipe(Effect.mapError(() => fail("SECRET_STORE_UNAVAILABLE")))
            yield* flock
              .acquire(CATALOG_LOCK_KEY, lockDir)
              .pipe(Effect.mapError(() => fail("SECRET_STORE_UNAVAILABLE")))
            const latest = yield* read()
            const state = yield* auth.get().pipe(Effect.mapError(() => fail("SECRET_STORE_UNAVAILABLE")))
            if (latest.versioned && snapshot.versioned && latest.catalogRevision < snapshot.catalogRevision)
              return yield* fail("REQUEST_CONFLICT", false, "catalog revision regressed")
            const draft = copy(latest)
            const status = (ids: string[]) => {
              if (
                ids.some((id) => {
                  const current = state.vendors.find((vendor) => vendor.id === id)
                  return (
                    !current ||
                    (latest.vendorEntities[id] !== undefined && latest.vendorEntities[id] !== current.entityId)
                  )
                })
              )
                return "retired"
              return !ids.length || ids.some((id) => latest.vendorEntities[id] === undefined) ? "unbound" : "current"
            }
            const quarantine = (item: typeof Quarantined.Type) => {
              const key = quarantineKey(item)
              const previous = draft.quarantine.entries.find((entry) => quarantineKey(entry) === key)
              draft.quarantine.entries = [
                ...draft.quarantine.entries.filter((entry) => quarantineKey(entry) !== key),
                previous ? { ...previous, ...item, kinds: [...new Set([...previous.kinds, ...item.kinds])] } : item,
              ]
            }
            draft.candidates = latest.candidates.filter((item) => {
              const ids = [...new Set([item.vendorId, item.sourceVendorId].filter((id): id is Relay.VendorID => !!id))]
              const binding = status(ids)
              if (binding === "unbound")
                quarantine({
                  vendorId: item.vendorId,
                  sourceVendorId: item.sourceVendorId,
                  modelId: item.modelId,
                  reason: "missing-entity-binding",
                  kinds: ["candidate"],
                  displayName: item.displayName,
                  ownedBy: item.ownedBy,
                  knownEntities: Object.fromEntries(
                    ids.flatMap((id) => (latest.vendorEntities[id] ? [[id, latest.vendorEntities[id]]] : [])),
                  ),
                })
              return binding === "current"
            })
            draft.managed = latest.managed.filter((item) => {
              const sources = latest.candidates.filter(
                (candidate) => candidate.vendorId === item.vendorId && candidate.modelId === item.modelId,
              )
              const sourceIds = [
                ...new Set(
                  sources.flatMap((candidate) => (candidate.sourceVendorId ? [candidate.sourceVendorId] : [])),
                ),
              ]
              const sourceVendorId = sourceIds.length === 1 ? sourceIds[0] : undefined
              const ids = [...new Set([item.vendorId, ...sourceIds])]
              const binding = status(ids)
              if (binding === "unbound")
                quarantine({
                  vendorId: item.vendorId,
                  sourceVendorId,
                  modelId: item.modelId,
                  reason: "missing-entity-binding",
                  kinds: ["managed"],
                  visible: item.visible,
                  knownEntities: Object.fromEntries(
                    ids.flatMap((id) => (latest.vendorEntities[id] ? [[id, latest.vendorEntities[id]]] : [])),
                  ),
                })
              return binding === "current"
            })
            draft.refreshRequests = Object.fromEntries(
              Object.entries(latest.refreshRequests).filter(([id]) => status([id]) !== "retired"),
            )
            const result = yield* change({ draft, vendors: state.vendors })
            const represented = new Set([
              ...Object.keys(result.draft.refreshRequests),
              ...result.draft.managed.map((item) => item.vendorId),
              ...result.draft.candidates.flatMap((item) =>
                [item.vendorId, item.sourceVendorId].filter((id): id is Relay.VendorID => !!id),
              ),
            ])
            result.draft.vendorEntities = Object.fromEntries(
              Object.entries(result.draft.vendorEntities).filter(
                ([id, entity]) =>
                  represented.has(id) && state.vendors.some((vendor) => vendor.id === id && vendor.entityId === entity),
              ),
            )
            const contentChanged = !same({ ...latest, catalogRevision: 0 }, { ...result.draft, catalogRevision: 0 })
            if (contentChanged && latest.catalogRevision >= Number.MAX_SAFE_INTEGER)
              return yield* fail("REQUEST_CONFLICT", false, "catalog revision exhausted")
            const next: Draft = {
              ...result.draft,
              catalogRevision: latest.catalogRevision + (contentChanged ? 1 : 0),
              versioned: contentChanged || latest.versioned,
            }
            const identityChanged = authIdentity(state) !== authStamp
            const externalProjectionChanged =
              JSON.stringify(snapshot.candidates) !== JSON.stringify(next.candidates) ||
              JSON.stringify(snapshot.managed) !== JSON.stringify(next.managed) ||
              JSON.stringify(latest.candidates) !== JSON.stringify(next.candidates) ||
              JSON.stringify(latest.managed) !== JSON.stringify(next.managed)
            // Commit, install and hand off notification ownership as one short boundary.
            yield* Effect.uninterruptible(
              Effect.gen(function* () {
                if (contentChanged) yield* commitFile(next)
                if (!same(snapshot, next) || identityChanged) {
                  snapshot = copy(next)
                  vendors = state.vendors
                  authStamp = authIdentity(state)
                }
                if (identityChanged || externalProjectionChanged || (result.notify && contentChanged)) note()
                capture?.(copy(next), state)
              }),
            )
            if (contentChanged) {
              for (const hook of commitHooks) yield* hook("renamed").pipe(Effect.ignore, Effect.forkDetach)
            }
            return {
              value: result.value,
              notify: pendingNotice.pending !== 0,
              revision: next.catalogRevision,
            }
          }),
        ),
      ).pipe(
        Effect.tap((result) => (result.notify && ready && deliver ? flushNotice() : Effect.void)),
        Effect.map((result) => result.value),
      )
    const matches = (captured: RelayAuth.CredentialSnapshot, current: Relay.AuthState["vendors"]) =>
      current.some(
        (vendor) =>
          vendor.id === captured.vendorId &&
          vendor.entityId === captured.entityId &&
          vendor.revision === captured.vendorRevision &&
          vendor.baseURL === captured.baseURL &&
          vendor.hasKey,
      )

    const synchronize = Effect.fn("RelayCatalog.synchronize")(function* (options?: { readonly retryNotice?: boolean }) {
      const requestedNotice = pendingNotice.sequence
      const pendingAtStart = pendingNotice.pending !== 0
      let captured: Omit<RelaySync.Snapshot, "notice"> | undefined
      yield* transact(
        ({ draft }) => Effect.succeed({ draft, value: undefined, notify: false }),
        (draft, state) => {
          captured = {
            auth: state,
            candidates: draft.candidates.map(toCandidate),
            managed: draft.managed.map(toManaged),
            catalogRevision: draft.versioned ? draft.catalogRevision : null,
          }
        },
      )
      if (options?.retryNotice) {
        const restarted = yield* noticePermit(
          Effect.sync(() => {
            if (noticeStatus() === "idle") {
              if (pendingAtStart || pendingNotice.sequence !== requestedNotice) return false
              note()
              return true
            }
            if (noticeStatus() !== "exhausted") return false
            pendingNotice.attempts = 0
            return true
          }),
        )
        if (restarted) yield* flushNotice()
      }
      if (!captured) return yield* fail("SECRET_STORE_UNAVAILABLE")
      return { ...captured, notice: { status: noticeStatus() } }
    })

    yield* transact(({ draft }) => Effect.succeed({ draft, value: undefined, notify: false })).pipe(Effect.orDie)
    ready = true
    yield* Effect.sleep("1 second").pipe(
      Effect.andThen(flushNotice()),
      Effect.repeat({ schedule: Schedule.spaced("1 second") }),
      Effect.forkScoped,
    )

    return Service.of({
      candidates: Effect.fn("RelayCatalog.candidates")(function* (vendorId) {
        return snapshot.candidates
          .filter((item) => vendorId === undefined || item.vendorId === vendorId || item.vendorId === undefined)
          .map(toCandidate)
      }),
      managed: Effect.fn("RelayCatalog.managed")(function* () {
        return snapshot.managed.map(toManaged)
      }),
      hasManaged: () =>
        snapshot.managed.some((item) =>
          vendors.some((vendor) => vendor.id === item.vendorId && !vendor.builtin && !!vendor.baseURL && vendor.hasKey),
        ),
      visible: (id) =>
        snapshot.managed.some(
          (item) =>
            modelID(item.vendorId, item.modelId) === id &&
            item.visible &&
            vendors.some(
              (vendor) => vendor.id === item.vendorId && !vendor.builtin && !!vendor.baseURL && vendor.hasKey,
            ),
        ),
      probe: Effect.fn("RelayCatalog.probe")(function* (vendorId, expected) {
        const captured = yield* auth.capture(vendorId, expected)
        yield* transact(
          ({ draft, vendors: current }) =>
            matches(captured, current)
              ? Effect.succeed({ draft, value: undefined, notify: false })
              : Effect.fail(fail("REQUEST_CONFLICT", false)),
          undefined,
          false,
        )
        const parsed = yield* fetchUpstream(captured)
        yield* transact(
          ({ draft, vendors: current }) =>
            matches(captured, current)
              ? Effect.succeed({ draft, value: undefined, notify: false })
              : Effect.fail(fail("REQUEST_CONFLICT", false)),
          undefined,
          false,
        )
        return { count: parsed.data.length }
      }),
      refresh: Effect.fn("RelayCatalog.refresh")((vendorId, expected) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const captured = yield* restore(auth.capture(vendorId, expected))
            const token = randomUUID()
            let reserved = false
            const result = yield* restore(
              Effect.gen(function* () {
                yield* transact(
                  ({ draft, vendors: current }) => {
                    if (!matches(captured, current)) return Effect.fail(fail("REQUEST_CONFLICT", false))
                    return Effect.succeed({
                      draft: {
                        ...draft,
                        refreshRequests: { ...draft.refreshRequests, [vendorId]: token },
                        vendorEntities: { ...draft.vendorEntities, [vendorId]: captured.entityId },
                      },
                      value: undefined,
                      notify: false,
                    })
                  },
                  () => {
                    reserved = true
                  },
                )
                yield* transact(
                  ({ draft, vendors: current }) =>
                    matches(captured, current) && draft.refreshRequests[vendorId] === token
                      ? Effect.succeed({ draft, value: undefined, notify: false })
                      : Effect.fail(fail("REQUEST_CONFLICT", false)),
                  undefined,
                  false,
                )
                const parsed = yield* fetchUpstream(captured)
                return yield* transact(
                  ({ draft, vendors: current }) =>
                    Effect.gen(function* () {
                      if (!matches(captured, current) || draft.refreshRequests[vendorId] !== token)
                        return { draft, value: draft.candidates.map(toCandidate), notify: false }
                      const now = DateTime.toEpochMillis(yield* DateTime.now)
                      const incoming = parsed.data.map((item) => ({
                        vendorId,
                        sourceVendorId: vendorId,
                        modelId: Model.ID.make(item.id),
                        ownedBy: item.owned_by,
                        fetchedAt: now,
                        assignmentSource: "manual" as const,
                        upstreamPresent: true,
                        fingerprint: Hash.sha256(
                          JSON.stringify([vendorId, captured.entityId, captured.vendorRevision, captured.baseURL]),
                        ),
                        requestVersion: draft.requestVersion,
                      }))
                      const next = {
                        ...draft,
                        candidates: [
                          ...draft.candidates.filter((item) => item.sourceVendorId !== vendorId),
                          ...incoming,
                        ],
                        managed: draft.managed.map((item) =>
                          item.vendorId !== vendorId
                            ? item
                            : {
                                ...item,
                                upstreamPresent: incoming.some((candidate) => candidate.modelId === item.modelId),
                                lastSeenAt: incoming.some((candidate) => candidate.modelId === item.modelId)
                                  ? now
                                  : item.lastSeenAt,
                              },
                        ),
                        refreshRequests: Object.fromEntries(
                          Object.entries(draft.refreshRequests).filter(([id]) => id !== vendorId),
                        ),
                      }
                      return { draft: next, value: next.candidates.map(toCandidate), notify: true }
                    }),
                  (draft) => {
                    if (draft.refreshRequests[vendorId] !== token) reserved = false
                  },
                )
              }),
            ).pipe(Effect.exit)
            if (!reserved) return yield* result
            const cleaned = yield* transact(
              ({ draft }) =>
                Effect.succeed({
                  draft:
                    draft.refreshRequests[vendorId] === token
                      ? {
                          ...draft,
                          refreshRequests: Object.fromEntries(
                            Object.entries(draft.refreshRequests).filter(([id]) => id !== vendorId),
                          ),
                        }
                      : draft,
                  value: undefined,
                  notify: false,
                }),
              undefined,
              false,
            ).pipe(
              Effect.timeout("2 seconds"),
              Effect.mapError(() => fail("SECRET_STORE_UNAVAILABLE", true, "refresh cleanup")),
              Effect.exit,
            )
            if (Exit.isFailure(cleaned)) {
              const original = Exit.isFailure(result)
                ? result.cause.reasons.find((reason) => reason._tag === "Fail" && reason.error instanceof CatalogError)
                : undefined
              const requestId =
                original?._tag === "Fail" && original.error instanceof CatalogError
                  ? original.error.info.requestId
                  : Hash.fast(token)
              yield* Effect.logWarning("Relay refresh cleanup failed", { requestId })
              if (Exit.isFailure(result)) return yield* Effect.failCause(Cause.combine(result.cause, cleaned.cause))
              return yield* Effect.failCause(cleaned.cause)
            }
            return yield* result
          }),
        ),
      ),
      setVisibility: Effect.fn("RelayCatalog.setVisibility")((input) =>
        transact(({ draft, vendors: current }) =>
          Effect.gen(function* () {
            const vendor = current.find((item) => item.id === input.vendorId)
            if (!vendor || (input.expectedEntityId !== undefined && input.expectedEntityId !== vendor.entityId))
              return yield* fail("REQUEST_CONFLICT", false)
            const now = DateTime.toEpochMillis(yield* DateTime.now)
            const existing = draft.managed.find(
              (item) => item.vendorId === input.vendorId && item.modelId === input.modelId,
            )
            const candidate = draft.candidates.find(
              (item) =>
                item.modelId === input.modelId && (item.vendorId === input.vendorId || item.vendorId === undefined),
            )
            const quarantined = draft.quarantine.entries.filter(
              (item) =>
                (item.vendorId ?? item.sourceVendorId) === input.vendorId &&
                item.modelId === input.modelId &&
                (!item.sourceVendorId || item.sourceVendorId === input.vendorId),
            )
            if (quarantined.length && !candidate && !existing) return yield* fail("REQUEST_CONFLICT", false)
            const source = existing?.assignmentSource ?? candidate?.assignmentSource ?? "manual"
            const next = {
              vendorId: input.vendorId,
              modelId: input.modelId,
              visible: input.visible,
              assignmentSource: source === "conflict" || source === "unassigned" ? ("manual" as const) : source,
              lastSeenAt: now,
              upstreamPresent: candidate?.upstreamPresent ?? existing?.upstreamPresent ?? true,
            }
            const managed = [
              ...draft.managed.filter((item) => !(item.vendorId === input.vendorId && item.modelId === input.modelId)),
              next,
            ]
            return {
              draft: {
                ...draft,
                managed,
                vendorEntities: { ...draft.vendorEntities, [input.vendorId]: vendor.entityId! },
                quarantine: {
                  version: 1,
                  entries:
                    candidate && quarantined.length === 1
                      ? draft.quarantine.entries.filter((item) => item !== quarantined[0])
                      : draft.quarantine.entries,
                },
              },
              value: managed.map(toManaged),
              notify: true,
            }
          }),
        ),
      ),
      synchronize,
      syncVendors: Effect.fn("RelayCatalog.syncVendors")(() => synchronize().pipe(Effect.asVoid)),
      apply: (update) => {
        for (const item of snapshot.managed) {
          const vendor = vendors.find((vendor) => vendor.id === item.vendorId)
          if (!vendor || vendor.builtin || !vendor.baseURL || !vendor.hasKey) continue
          const candidate = snapshot.candidates.find(
            (entry) => entry.modelId === item.modelId && entry.vendorId === item.vendorId,
          )
          update(ProviderV2.ID.leidiandonghua, modelID(item.vendorId, item.modelId), (model) => {
            model.name = candidate?.displayName ?? item.modelId
            model.family = ModelV2.Family.make(item.vendorId)
            model.enabled = item.visible
            model.status = "active"
            model.time = { released: Date.now() }
            model.capabilities = { tools: true, input: ["text", "image"], output: ["text"] }
            model.limit = { context: 128_000, output: 8192 }
            model.api = {
              id: item.modelId,
              type: "aisdk",
              package: "@ai-sdk/openai-compatible",
              url: vendor.baseURL,
            }
            model.variants = RelayCapability.variants(item.vendorId, item.modelId).map((variant) => ({
              id: ModelV2.VariantID.make(variant.id),
              headers: variant.headers,
              body: variant.body,
            }))
          })
        }
      },
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer: layer.pipe(Layer.orDie),
  deps: [FSUtil.node, Global.node, RelayAuth.node, EventV2.node, EffectFlock.node, httpClient],
})
