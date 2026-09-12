export * as RelayCatalog from "./relay-catalog"

import { Context, DateTime, Effect, Layer, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { makeGlobalNode } from "./effect/app-node"
import { Relay } from "@opencode-ai/schema/relay"
import { RelayError } from "@opencode-ai/schema/relay-error"
import { RelayModel } from "@opencode-ai/schema/relay-model"
import { Model } from "@opencode-ai/schema/model"
import { FSUtil } from "./fs-util"
import { Global } from "./global"
import { Hash } from "./util/hash"
import { ModelV2 } from "./model"
import { ProviderV2 } from "./provider"
import { RelayAuth } from "./relay-auth"
import { RelayCapability } from "./relay-capability"
import { RelayPolicy } from "./relay-policy"
import { RelayEvent } from "@opencode-ai/schema/relay-event"
import { EventV2 } from "./event"
import { httpClient } from "./effect/app-node-platform"
import path from "path"

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

const Stored = Schema.Struct({
  candidates: Schema.Array(StoredCandidate),
  managed: Schema.Array(StoredManaged),
  requestVersion: Schema.Number,
})

type Draft = {
  candidates: Array<(typeof StoredCandidate)["Type"]>
  managed: Array<(typeof StoredManaged)["Type"]>
  requestVersion: number
}

const empty = (): Draft => ({ candidates: [], managed: [], requestVersion: 0 })

const prefixes: Record<string, RegExp> = {
  chatgpt: /^(gpt-|o[1-4]|chatgpt)/i,
  grok: /^grok/i,
  gemini: /^gemini/i,
  claude: /^claude/i,
  kimi: /^(kimi|moonshot)/i,
}

const ownedBy: Record<string, ReadonlyArray<string>> = {
  chatgpt: ["openai", "chatgpt", "system"],
  grok: ["xai", "grok"],
  gemini: ["google"],
  claude: ["anthropic"],
  kimi: ["moonshot", "kimi"],
}

export interface Interface {
  readonly candidates: (vendorId?: Relay.VendorID) => Effect.Effect<RelayModel.Candidate[]>
  readonly managed: () => Effect.Effect<RelayModel.Managed[]>
  readonly hasManaged: () => boolean
  readonly visible: (modelId: string) => boolean
  readonly refresh: (vendorId: Relay.VendorID) => Effect.Effect<RelayModel.Candidate[], RelayAuth.AuthError | CatalogError>
  readonly probe: (vendorId: Relay.VendorID) => Effect.Effect<{ count: number }, RelayAuth.AuthError | CatalogError>
  readonly setVisibility: (input: {
    readonly vendorId: Relay.VendorID
    readonly modelId: Model.ID
    readonly visible: boolean
  }) => Effect.Effect<RelayModel.Managed[], CatalogError>
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

export function assignVendor(
  modelId: string,
  owned: string | undefined,
  vendors: ReadonlyArray<Relay.VendorID>,
  manual?: Relay.VendorID,
) {
  if (manual) return { vendorId: manual, source: "manual" as const }
  const ownedHits = vendors.filter((id) => owned && (ownedBy[id] ?? [id]).includes(owned.toLowerCase()))
  if (ownedHits.length === 1) return { vendorId: ownedHits[0], source: "owned_by" as const }
  const prefixHits = vendors.filter((id) => prefixes[id]?.test(modelId) || modelId.toLowerCase().startsWith(id))
  if (prefixHits.length === 1) return { vendorId: prefixHits[0], source: "prefix" as const }
  if (ownedHits.length > 1 || prefixHits.length > 1) return { vendorId: undefined, source: "conflict" as const }
  return { vendorId: undefined, source: "unassigned" as const }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const auth = yield* RelayAuth.Service
    const events = yield* EventV2.Service
    const http = yield* HttpClient.HttpClient
    const file = path.join((yield* Global.Service).data, "relay-catalog.json")
    const decode = Schema.decodeUnknownSync(Stored)
    const encode = Schema.encodeSync(Stored)

    const read = Effect.fn("RelayCatalog.read")(function* () {
      const data = yield* fs.readJson(file).pipe(Effect.orElseSucceed(() => empty()))
      try {
        return decode(data)
      } catch {
        return empty()
      }
    })

    const fetchUpstream = Effect.fn("RelayCatalog.fetchUpstream")(function* (vendorId: Relay.VendorID) {
      const key = yield* auth.resolve(vendorId)
      const response = yield* HttpClientRequest.get(`${RelayPolicy.BaseURL}/models`).pipe(
        HttpClientRequest.setHeader("Authorization", `Bearer ${key}`),
        http.execute,
        Effect.timeout("10 seconds"),
        Effect.mapError((error) =>
          error._tag === "TimeoutError" ? fail("UPSTREAM_TIMEOUT") : fail("UPSTREAM_UNREACHABLE"),
        ),
      )
      if (response.status === 401 || response.status === 403) return yield* fail("KEY_REJECTED", false)
      if (response.status === 429) return yield* fail("UPSTREAM_RATE_LIMITED")
      if (response.status < 200 || response.status >= 300) return yield* fail("UPSTREAM_UNREACHABLE")
      const body = yield* response.json.pipe(Effect.mapError(() => fail("UPSTREAM_INVALID_RESPONSE", false)))
      const parsed = Schema.decodeUnknownOption(Upstream)(body)
      if (Option.isNone(parsed)) return yield* fail("UPSTREAM_INVALID_RESPONSE", false)
      return parsed.value
    })

    const write = Effect.fn("RelayCatalog.write")(function* (next: Draft) {
      yield* fs.writeJson(file, encode(next), 0o600).pipe(Effect.mapError(() => fail("SECRET_STORE_UNAVAILABLE")))
      yield* events.publish(RelayEvent.CatalogUpdated, {})
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

    let snapshot = yield* read()

    return Service.of({
      candidates: Effect.fn("RelayCatalog.candidates")(function* (vendorId) {
        return snapshot.candidates
          .filter((item) => vendorId === undefined || item.vendorId === vendorId || item.vendorId === undefined)
          .map(toCandidate)
      }),
      managed: Effect.fn("RelayCatalog.managed")(function* () {
        return snapshot.managed.map(toManaged)
      }),
      hasManaged: () => snapshot.managed.length > 0,
      visible: (modelId) => snapshot.managed.some((item) => item.modelId === modelId && item.visible),
      probe: Effect.fn("RelayCatalog.probe")(function* (vendorId) {
        const parsed = yield* fetchUpstream(vendorId)
        return { count: parsed.data.length }
      }),
      refresh: Effect.fn("RelayCatalog.refresh")(function* (vendorId) {
        const key = yield* auth.resolve(vendorId)
        const fingerprint = Hash.sha256(key)
        const requestVersion = snapshot.requestVersion + 1
        const parsed = yield* fetchUpstream(vendorId)
        const state = yield* auth.get()
        const vendors = state.vendors.map((item) => item.id)
        const manuals = new Map(
          snapshot.managed.filter((item) => item.assignmentSource === "manual").map((item) => [item.modelId, item.vendorId]),
        )
        const now = DateTime.toEpochMillis(yield* DateTime.now)
        const next = parsed.data.map((item) => {
          const assigned = assignVendor(item.id, item.owned_by, vendors, manuals.get(Model.ID.make(item.id)))
          return {
            vendorId: assigned.vendorId,
            modelId: Model.ID.make(item.id),
            ownedBy: item.owned_by,
            fetchedAt: now,
            assignmentSource: assigned.source,
            upstreamPresent: true,
            fingerprint,
            requestVersion,
          }
        })
        snapshot = {
          requestVersion,
          candidates: [
            ...snapshot.candidates.filter((item) => item.fingerprint !== fingerprint || item.vendorId !== vendorId),
            ...next.filter((item) => item.vendorId === vendorId || item.vendorId === undefined),
          ],
          managed: snapshot.managed.map((item) => item.vendorId !== vendorId ? item : ({
            ...item,
            upstreamPresent: next.some((candidate) => candidate.modelId === item.modelId),
            lastSeenAt: next.some((candidate) => candidate.modelId === item.modelId) ? now : item.lastSeenAt,
          })),
        }
        yield* write({
          requestVersion: snapshot.requestVersion,
          candidates: [...snapshot.candidates],
          managed: [...snapshot.managed],
        })
        return snapshot.candidates.map(toCandidate)
      }),
      setVisibility: Effect.fn("RelayCatalog.setVisibility")(function* (input) {
        const now = DateTime.toEpochMillis(yield* DateTime.now)
        const existing = snapshot.managed.find((item) => item.vendorId === input.vendorId && item.modelId === input.modelId)
        const candidate = snapshot.candidates.find((item) => item.modelId === input.modelId)
        const source = existing?.assignmentSource ?? candidate?.assignmentSource ?? "manual"
        const next = {
          vendorId: input.vendorId,
          modelId: input.modelId,
          visible: input.visible,
          assignmentSource: source === "conflict" || source === "unassigned" ? "manual" : source,
          lastSeenAt: now,
          upstreamPresent: candidate?.upstreamPresent ?? existing?.upstreamPresent ?? true,
        }
        snapshot = {
          ...snapshot,
          managed: [...snapshot.managed.filter((item) => !(item.vendorId === input.vendorId && item.modelId === input.modelId)), next],
        }
        yield* write({
          requestVersion: snapshot.requestVersion,
          candidates: [...snapshot.candidates],
          managed: [...snapshot.managed],
        })
        return snapshot.managed.map(toManaged)
      }),
      apply: (update) => {
        for (const item of snapshot.managed) {
          const candidate = snapshot.candidates.find((entry) => entry.modelId === item.modelId)
          update(ProviderV2.ID.leidiandonghua, item.modelId, (model) => {
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
              url: RelayPolicy.BaseURL,
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
  layer,
  deps: [FSUtil.node, Global.node, RelayAuth.node, EventV2.node, httpClient],
})
