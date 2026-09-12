import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { Relay } from "@opencode-ai/schema/relay"
import { Model } from "@opencode-ai/schema/model"
import { RelayAuth } from "@opencode-ai/core/relay-auth"
import { RelayCatalog } from "@opencode-ai/core/relay-catalog"
import { RelayCapability } from "@opencode-ai/core/relay-capability"
import { RelaySecretStore } from "@opencode-ai/core/relay-secret-store"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const httpLayer = (status: number, body: unknown) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body), { status }))),
    ),
  )

const withCatalog = <A, E>(
  body: (catalog: RelayCatalog.Interface, auth: RelayAuth.Interface) => Effect.Effect<A, E>,
  http?: Layer.Layer<HttpClient.HttpClient>,
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => {
      const layer = AppNodeBuilder.build(LayerNode.group([RelayCatalog.node, RelayAuth.node]), [
        [Global.node, Global.layerWith({ data: tmp.path })],
        [RelaySecretStore.node, RelaySecretStore.memoryLayer],
        ...(http ? [[LayerNodePlatform.httpClient, http] as const] : []),
      ])
      return Effect.gen(function* () {
        return yield* body(yield* RelayCatalog.Service, yield* RelayAuth.Service)
      }).pipe(Effect.provide(layer))
    },
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

const it = testEffect(Layer.empty)

describe("RelayCapability", () => {
  it.effect("uses vendor tables and hides unknown reasoning", () =>
    Effect.sync(() => {
      expect(RelayCapability.efforts("chatgpt", "gpt-5.2")).toEqual(["low", "medium", "high", "xhigh"])
      expect(RelayCapability.efforts("grok", "grok-4")).toEqual(["medium", "high", "xhigh"])
      expect(RelayCapability.efforts("kimi", "plain-chat")).toEqual([])
    }),
  )
})

describe("RelayCatalog.assignVendor", () => {
  it.effect("prefers manual assignment over owned_by and prefix", () =>
    Effect.sync(() => {
      const vendors = [Relay.VendorID.chatgpt, Relay.VendorID.grok]
      expect(RelayCatalog.assignVendor("gpt-5.2", "openai", vendors, Relay.VendorID.grok)).toEqual({
        vendorId: Relay.VendorID.grok,
        source: "manual",
      })
      expect(RelayCatalog.assignVendor("gpt-5.2", "openai", vendors)?.source).toBe("owned_by")
      expect(RelayCatalog.assignVendor("grok-4", undefined, vendors)?.source).toBe("prefix")
      expect(RelayCatalog.assignVendor("mystery", undefined, vendors)?.source).toBe("unassigned")
    }),
  )

  it.effect("marks overlapping prefix matches as conflict", () =>
    Effect.sync(() => {
      expect(
        RelayCatalog.assignVendor("gpt-5.2", undefined, [Relay.VendorID.chatgpt, Relay.VendorID.make("gpt")]),
      ).toEqual({
        vendorId: undefined,
        source: "conflict",
      })
    }),
  )
})

describe("RelayCatalog", () => {
  it.live("does not expose candidates until they are managed", () =>
    withCatalog((catalog) =>
      Effect.gen(function* () {
        expect(yield* catalog.candidates()).toEqual([])
        expect(yield* catalog.managed()).toEqual([])
        expect(catalog.hasManaged()).toBe(false)
        expect(catalog.visible("gpt-5.2")).toBe(false)
      }),
    ),
  )

  it.live("setVisibility writes the managed registry used by selectors", () =>
    withCatalog((catalog, auth) =>
      Effect.gen(function* () {
        yield* auth.setVendor({ id: Relay.VendorID.chatgpt, key: "sk-test", revision: 0 })
        const managed = yield* catalog.setVisibility({
          vendorId: Relay.VendorID.chatgpt,
          modelId: Model.ID.make("gpt-5.2"),
          visible: true,
        })
        expect(managed[0]?.visible).toBe(true)
        expect(catalog.visible("gpt-5.2")).toBe(true)
        expect(catalog.hasManaged()).toBe(true)
        const hidden = yield* catalog.setVisibility({
          vendorId: Relay.VendorID.chatgpt,
          modelId: Model.ID.make("gpt-5.2"),
          visible: false,
        })
        expect(hidden[0]?.visible).toBe(false)
        expect(catalog.visible("gpt-5.2")).toBe(false)
      }),
    ),
  )

  it.live("maps 401 probe failures to KEY_REJECTED", () =>
    withCatalog(
      (catalog, auth) =>
        Effect.gen(function* () {
          yield* auth.setVendor({ id: Relay.VendorID.chatgpt, key: "sk-test", revision: 0 })
          const rejected = yield* catalog.probe(Relay.VendorID.chatgpt).pipe(Effect.flip)
          expect(rejected.info.code).toBe("KEY_REJECTED")
        }),
      httpLayer(401, { error: "unauthorized" }),
    ),
  )

  it.live("maps 429 probe failures to UPSTREAM_RATE_LIMITED", () =>
    withCatalog(
      (catalog, auth) =>
        Effect.gen(function* () {
          yield* auth.setVendor({ id: Relay.VendorID.chatgpt, key: "sk-test", revision: 0 })
          const limited = yield* catalog.probe(Relay.VendorID.chatgpt).pipe(Effect.flip)
          expect(limited.info.code).toBe("UPSTREAM_RATE_LIMITED")
        }),
      httpLayer(429, { error: "rate" }),
    ),
  )

  it.live("returns zero for an empty upstream list", () =>
    withCatalog(
      (catalog, auth) =>
        Effect.gen(function* () {
          yield* auth.setVendor({ id: Relay.VendorID.chatgpt, key: "sk-test", revision: 0 })
          expect((yield* catalog.probe(Relay.VendorID.chatgpt)).count).toBe(0)
        }),
      httpLayer(200, { data: [] }),
    ),
  )

  it.live("maps invalid upstream JSON to UPSTREAM_INVALID_RESPONSE", () =>
    withCatalog(
      (catalog, auth) =>
        Effect.gen(function* () {
          yield* auth.setVendor({ id: Relay.VendorID.chatgpt, key: "sk-test", revision: 0 })
          const invalid = yield* catalog.probe(Relay.VendorID.chatgpt).pipe(Effect.flip)
          expect(invalid.info.code).toBe("UPSTREAM_INVALID_RESPONSE")
        }),
      httpLayer(200, { models: [] }),
    ),
  )

  it.live("keeps conflict candidates unmanaged until a vendor is chosen", () =>
    withCatalog(
      (catalog, auth) =>
        Effect.gen(function* () {
          const first = yield* auth.setVendor({ id: Relay.VendorID.chatgpt, key: "sk-test", revision: 0 })
          yield* auth.setVendor({
            id: Relay.VendorID.make("openai"),
            name: "OpenAI",
            key: "sk-other",
            revision: first.revision,
          })
          const candidates = yield* catalog.refresh(Relay.VendorID.chatgpt)
          const conflict = candidates.find((item) => item.modelId === "shared-model")
          expect(conflict?.assignmentSource).toBe("conflict")
          expect(conflict?.vendorId).toBeUndefined()
          expect(catalog.visible("shared-model")).toBe(false)
        }),
      httpLayer(200, { data: [{ id: "shared-model", owned_by: "openai" }] }),
    ),
  )
})
