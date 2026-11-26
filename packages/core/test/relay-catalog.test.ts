import { describe, expect } from "bun:test"
import { DateTime, Deferred, Effect, Fiber, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { Relay } from "@opencode-ai/schema/relay"
import { Model } from "@opencode-ai/schema/model"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { LLM } from "@opencode-ai/llm"
import { LLMClient } from "@opencode-ai/llm/route"
import { Headers } from "effect/unstable/http"
import { produce } from "immer"
import { Catalog } from "@opencode-ai/core/catalog"
import { Location } from "@opencode-ai/core/location"
import { SessionV2 } from "@opencode-ai/core/session"
import { ProjectV2 } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { location } from "./fixture/location"
import { RelayAuth } from "@opencode-ai/core/relay-auth"
import { RelayCatalog } from "@opencode-ai/core/relay-catalog"
import { RelayCapability } from "@opencode-ai/core/relay-capability"
import { RelaySecretStore } from "@opencode-ai/core/relay-secret-store"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import path from "node:path"
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

const withCatalog = <A, E, R>(
  body: (catalog: RelayCatalog.Interface, auth: RelayAuth.Interface) => Effect.Effect<A, E, R>,
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
  it.effect("resolves exact upstream models on user-named relays", () =>
    Effect.sync(() => {
      expect(RelayCapability.variants("gpt", "gpt-6.2-astra").map((variant) => [variant.id, variant.body.reasoning_effort])).toEqual([
        ["low", "low"],
        ["medium", "medium"],
        ["high", "high"],
        ["ultra", "xhigh"],
        ["max", "max"],
        ["native-ultra", "ultra"],
      ])
      for (const id of ["gpt-6.2-sol", "gpt-6-astra", "gpt-6.1-sol"]) {
        expect(RelayCapability.efforts("gpt", id)).toEqual(["low", "medium", "high", "xhigh", "max"])
        expect(RelayCapability.variants("renamed-route", id).at(-1)?.body).toEqual({ reasoning_effort: "max" })
      }
      expect(RelayCapability.variants("gpt", "gpt-6.1-terra")[0]).toEqual({
        id: "none",
        headers: {},
        body: { reasoning_effort: "none" },
      })
      for (const id of ["grok-4.6", "grok-4.7"])
        expect(RelayCapability.efforts("sub2api", id)).toEqual(["low", "medium", "high", "xhigh"])
      for (const id of [
        "gpt-image-2",
        "gpt-image-2.5-sunburst",
        "gpt-image-2.5-flare",
        "grok-imagine-image",
        "grok-imagine-image-2.0",
        "grok-imagine-image-quality",
        "unknown-model",
      ])
        expect(RelayCapability.variants("sub2api", id)).toEqual([])
    }),
  )

  it.effect("uses per-model tables instead of a single vendor set", () =>
    Effect.sync(() => {
      expect(RelayCapability.efforts("chatgpt", "gpt-6.1-sol")).toEqual(["low", "medium", "high", "xhigh", "max"])
      expect(RelayCapability.efforts("chatgpt", "gpt-6-sol")).toEqual(["low", "medium", "high", "xhigh"])
      expect(RelayCapability.efforts("chatgpt", "gpt-6-luna")).toEqual(["low", "medium", "high"])
      expect(RelayCapability.efforts("chatgpt", "gpt-5.6-luna")).toEqual(["low", "medium", "high"])
      expect(RelayCapability.efforts("chatgpt", "gpt-6-astra")).toEqual(["low", "medium", "high", "xhigh", "max"])
      expect(RelayCapability.variants("chatgpt", "gpt-6-astra").map((item) => item.id)).toEqual([
        "low",
        "medium",
        "high",
        "ultra",
        "max",
      ])
      expect(RelayCapability.variants("chatgpt", "gpt-6-astra").at(-1)?.body).toEqual({ reasoning_effort: "max" })
      expect(RelayCapability.variants("chatgpt", "gpt-6-luna").map((item) => item.id)).toEqual([
        "low",
        "medium",
        "high",
      ])
      expect(RelayCapability.efforts("chatgpt", "gpt-5.2")).toEqual(["low", "medium", "high", "xhigh"])
      expect(RelayCapability.efforts("chatgpt", "gpt-4o")).toEqual([])
      expect(RelayCapability.efforts("grok", "grok-4.7")).toEqual(["low", "medium", "high", "xhigh"])
      expect(RelayCapability.efforts("grok", "grok-4.20-0309-reasoning")).toEqual(["medium", "high", "xhigh"])
      expect(RelayCapability.efforts("grok", "grok-4.20-0309-non-reasoning")).toEqual([])
      expect(RelayCapability.efforts("grok", "grok-imagine-image")).toEqual([])
      expect(RelayCapability.efforts("grok", "grok-build-0.1")).toEqual(["medium", "high"])
      expect(RelayCapability.efforts("claude", "claude-haiku-4")).toEqual(["high"])
      expect(RelayCapability.efforts("claude", "claude-sonnet-4")).toEqual(["high", "xhigh"])
      expect(RelayCapability.efforts("gemini", "gemini-3-flash")).toEqual(["low"])
      expect(RelayCapability.efforts("gemini", "gemini-3-pro")).toEqual(["low", "high"])
      expect(RelayCapability.efforts("kimi", "kimi-thinking")).toEqual(["medium", "high"])
      expect(RelayCapability.efforts("kimi", "plain-chat")).toEqual([])
      expect(
        [
          "codex-auto-review",
          "gpt-5.3-codex-spark",
          "gpt-5.4-mini",
          "gpt-5.4-openai-compact",
          "gpt-5.5",
          "gpt-5.5-openai-compact",
          "gpt-5.6-luna",
          "gpt-5.6-sol",
          "gpt-5.6-terra",
          "gpt-6-astra",
          "gpt-6-luna",
          "gpt-6-sol",
          "gpt-6.1-sol",
        ].map((modelId) => [modelId, RelayCapability.variants("chatgpt", modelId).map((item) => item.id)]),
      ).toEqual([
        ["codex-auto-review", ["low", "medium", "high"]],
        ["gpt-5.3-codex-spark", ["low", "medium", "high"]],
        ["gpt-5.4-mini", ["low", "medium", "high"]],
        ["gpt-5.4-openai-compact", ["low", "medium", "high"]],
        ["gpt-5.5", ["low", "medium", "high", "ultra"]],
        ["gpt-5.5-openai-compact", ["low", "medium", "high"]],
        ["gpt-5.6-luna", ["low", "medium", "high"]],
        ["gpt-5.6-sol", ["low", "medium", "high", "ultra"]],
        ["gpt-5.6-terra", ["low", "medium", "high", "ultra"]],
        ["gpt-6-astra", ["low", "medium", "high", "ultra", "max"]],
        ["gpt-6-luna", ["low", "medium", "high"]],
        ["gpt-6-sol", ["low", "medium", "high", "ultra"]],
        ["gpt-6.1-sol", ["low", "medium", "high", "ultra", "max"]],
      ])
      expect(
        [
          "grok-4.20-0309-non-reasoning",
          "grok-4.20-0309-reasoning",
          "grok-4.20-multi-agent-0309",
          "grok-4.3",
          "grok-4.5",
          "grok-4.6",
          "grok-4.7",
          "grok-build-0.1",
          "grok-imagine-image",
          "grok-imagine-image-quality",
          "grok-imagine-video",
          "grok-imagine-video-1.5-preview",
        ].map((modelId) => [modelId, RelayCapability.variants("grok", modelId).map((item) => item.id)]),
      ).toEqual([
        ["grok-4.20-0309-non-reasoning", []],
        ["grok-4.20-0309-reasoning", ["medium", "high", "ultra"]],
        ["grok-4.20-multi-agent-0309", ["medium", "high", "ultra"]],
        ["grok-4.3", ["medium", "high", "ultra"]],
        ["grok-4.5", ["medium", "high", "ultra"]],
        ["grok-4.6", ["low", "medium", "high", "ultra"]],
        ["grok-4.7", ["low", "medium", "high", "ultra"]],
        ["grok-build-0.1", ["medium", "high"]],
        ["grok-imagine-image", []],
        ["grok-imagine-image-quality", []],
        ["grok-imagine-video", []],
        ["grok-imagine-video-1.5-preview", []],
      ])
    }),
  )
})

describe("RelayCatalog.modelID", () => {
  it.effect("keeps independent providers separate from each other and retired hosted model IDs", () =>
    Effect.sync(() => {
      expect(String(RelayCatalog.modelID("chatgpt", "gpt-5.2"))).toBe("custom:chatgpt:gpt-5.2")
      expect(String(RelayCatalog.modelID("other", "gpt-5.2"))).toBe("custom:other:gpt-5.2")
      expect(String(RelayCatalog.modelID("other", "path/model"))).toBe("custom:other:path%2Fmodel")
    }),
  )
})

describe("RelayCatalog", () => {
  it.live("discovers independent upstreams without leaking shared keys or colliding model IDs", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const requests: Array<{ path: string; key: string | null }> = []
        const server = Bun.serve({
          port: 0,
          hostname: "127.0.0.1",
          fetch(request) {
            requests.push({ path: new URL(request.url).pathname, key: request.headers.get("authorization") })
            return Response.json({ data: [{ id: "gpt-shared", owned_by: "openai" }] })
          },
        })
        return { server, requests }
      }),
      ({ server, requests }) =>
        withCatalog((catalog, auth) =>
          Effect.gen(function* () {
            const first = Relay.VendorID.make("first")
            const second = Relay.VendorID.make("second")
            let state = yield* auth.get()
            for (const id of [first, second]) {
              state = yield* auth.setVendor({
                id,
                name: id,
                key: `${id}-key`,
                baseURL: `${server.url}${id}/v1`,
                revision: state.revision,
              })
              yield* catalog.refresh(id)
              const candidates = yield* catalog.candidates(id)
              expect(candidates).toHaveLength(1)
              expect(candidates[0]?.vendorId).toBe(id)
              yield* catalog.setVisibility({ vendorId: id, modelId: Model.ID.make("gpt-shared"), visible: true })
            }
            expect(requests).toEqual([
              { path: "/first/v1/models", key: "Bearer first-key" },
              { path: "/second/v1/models", key: "Bearer second-key" },
            ])
            const models: Record<string, unknown> = {}
            catalog.apply((_provider, id, update) => {
              const model = { name: "", enabled: false, api: undefined as unknown, variants: undefined as unknown }
              update(model)
              models[id] = model.api
            })
            expect(Object.keys(models)).toEqual(["custom:first:gpt-shared", "custom:second:gpt-shared"])
            expect(models["custom:first:gpt-shared"]).toMatchObject({ id: "gpt-shared", url: `${server.url}first/v1` })
            expect(catalog.visible("custom:second:gpt-shared")).toBe(true)
            expect(catalog.visible("gpt-shared")).toBe(false)
            const projected = ModelV2.Info.empty(
              ProviderV2.ID.leidiandonghua,
              RelayCatalog.modelID(first, "gpt-shared"),
            )
            const drafts: ModelV2.Info[] = []
            catalog.apply((_provider, id, update) => {
              if (id !== projected.id) return
              drafts.push(produce(projected, (draft) => update(draft)))
            })
            const credential = yield* auth.resolve(first)
            const projectedModel = drafts[0]
            if (!projectedModel) throw new Error("missing projected model")
            const route = yield* SessionRunnerModel.fromCatalogModel(projectedModel, {
              type: "key",
              key: credential.key,
            })
            const request = LLM.request({ model: route, prompt: "Hello" })
            const prepared = yield* LLMClient.prepare(request)
            expect(prepared.body).toMatchObject({ model: "gpt-shared" })
            expect(route.route.endpoint).toMatchObject({ baseURL: `${server.url}first/v1` })
            const headers = yield* route.route.auth.apply({
              request,
              method: "POST",
              url: `${server.url}first/v1/chat/completions`,
              body: "{}",
              headers: Headers.empty,
            })
            expect(headers.authorization).toBe("Bearer first-key")
            yield* Effect.gen(function* () {
              const coreCatalog = yield* Catalog.Service
              const resolver = yield* SessionRunnerModel.Service
              yield* coreCatalog.transform((editor) => {
                editor.provider.update(ProviderV2.ID.leidiandonghua, (provider) => {
                  provider.request.headers = { Authorization: "Bearer shared-secret" }
                  provider.request.body = { apiKey: "shared-secret" }
                })
                catalog.apply((provider, id, update) =>
                  editor.model.update(ProviderV2.ID.make(provider), ModelV2.ID.make(id), update),
                )
              })
              const session = SessionV2.Info.make({
                id: SessionV2.ID.make("ses_custom_relay"),
                projectID: ProjectV2.ID.global,
                title: "test",
                model: { providerID: ProviderV2.ID.leidiandonghua, id: projected.id },
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
                location: { directory: AbsolutePath.make("D:/relay-test") },
              })
              const resolved = yield* resolver.resolve(session)
              expect(String(resolved.id)).toBe("gpt-shared")
              expect(resolved.route.endpoint).toMatchObject({ baseURL: `${server.url}first/v1` })
              expect(JSON.stringify(resolved.route.defaults)).not.toContain("shared-secret")
              state = yield* auth.setVendor({
                id: first,
                key: "rotated-key",
                baseURL: `${server.url}changed/v1`,
                revision: state.revision,
              })
              const changed = yield* resolver.resolve(session)
              expect(changed.route.endpoint).toMatchObject({ baseURL: `${server.url}changed/v1` })
              const changedRequest = LLM.request({ model: changed, prompt: "Hello" })
              const changedHeaders = yield* changed.route.auth.apply({
                request: changedRequest,
                method: "POST",
                url: `${server.url}changed/v1/chat/completions`,
                body: "{}",
                headers: Headers.empty,
              })
              expect(changedHeaders.authorization).toBe("Bearer rotated-key")
              state = yield* auth.clearVendorKey({ id: first, revision: state.revision })
              expect((yield* resolver.resolve(session).pipe(Effect.flip))._tag).toBe(
                "SessionRunnerModel.ModelUnavailableError",
              )
              state = yield* auth.setVendor({ id: first, key: "first-key", revision: state.revision })
            }).pipe(
              Effect.provide(
                AppNodeBuilder.build(LayerNode.group([SessionRunnerModel.node, Catalog.node]), [
                  [RelayAuth.node, Layer.succeed(RelayAuth.Service, auth)],
                  [RelayCatalog.node, Layer.succeed(RelayCatalog.Service, catalog)],
                  [
                    Location.node,
                    Layer.succeed(
                      Location.Service,
                      Location.Service.of(location({ directory: AbsolutePath.make("D:/relay-test") })),
                    ),
                  ],
                ]),
              ),
            )
            yield* catalog.refresh(first)
            expect(yield* catalog.candidates(first)).toHaveLength(1)
            expect(yield* catalog.candidates(second)).toHaveLength(1)
          }),
        ),
      ({ server }) => Effect.sync(() => server.stop(true)),
    ),
  )

  it.live("does not expose candidates until they are managed", () =>
    withCatalog((catalog) =>
      Effect.gen(function* () {
        expect(yield* catalog.candidates()).toEqual([])
        expect(yield* catalog.managed()).toEqual([])
        expect(catalog.hasManaged()).toBe(false)
        expect(catalog.visible(RelayCatalog.modelID("chatgpt", "gpt-5.2"))).toBe(false)
      }),
    ),
  )

  it.live("removes stale candidates from the refreshed vendor without affecting other vendors", () => {
    let chatgptRefresh = false
    const http = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        const key = request.headers.authorization
        const data = key?.startsWith("Bearer chatgpt")
          ? chatgptRefresh
            ? [{ id: "gpt-new", owned_by: "openai" }]
            : [{ id: "gpt-old", owned_by: "openai" }, { id: "mystery-old" }]
          : [{ id: "grok-kept", owned_by: "xai" }]
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response(JSON.stringify({ data }), { status: 200 })),
        )
      }),
    )

    return withCatalog(
      (catalog, auth) =>
        Effect.gen(function* () {
          let state = yield* auth.setVendor({
            name: "Independent",
            baseURL: "https://provider.test/v1",
            id: Relay.VendorID.chatgpt,
            key: "chatgpt-key",
            revision: 0,
          })
          state = yield* auth.setVendor({
            name: "Independent",
            baseURL: "https://provider.test/v1",
            id: Relay.VendorID.grok,
            key: "grok-key",
            revision: state.revision,
          })
          yield* catalog.refresh(Relay.VendorID.chatgpt)
          yield* catalog.refresh(Relay.VendorID.grok)
          yield* catalog.setVisibility({
            vendorId: Relay.VendorID.chatgpt,
            modelId: Model.ID.make("gpt-old"),
            visible: true,
          })

          chatgptRefresh = true
          state = yield* auth.setVendor({
            name: "Independent",
            baseURL: "https://provider.test/v1",
            id: Relay.VendorID.chatgpt,
            key: "chatgpt-rotated-key",
            revision: state.revision,
          })
          yield* catalog.refresh(Relay.VendorID.chatgpt)

          const candidates = yield* catalog.candidates()
          expect(candidates.map((item) => item.modelId)).toEqual(expect.arrayContaining(["gpt-new", "grok-kept"]))
          expect(candidates.some((item) => item.modelId === "gpt-old")).toBe(false)
          expect(candidates.some((item) => item.modelId === "mystery-old")).toBe(false)
          expect((yield* catalog.candidates(Relay.VendorID.grok)).map((item) => item.modelId)).toEqual([
            Model.ID.make("grok-kept"),
          ])
          expect(yield* catalog.managed()).toEqual([
            expect.objectContaining({
              vendorId: Relay.VendorID.chatgpt,
              modelId: Model.ID.make("gpt-old"),
              visible: true,
              upstreamPresent: false,
            }),
          ])
        }),
      http,
    )
  })

  it.live("setVisibility writes the managed registry used by selectors", () =>
    withCatalog((catalog, auth) =>
      Effect.gen(function* () {
        yield* auth.setVendor({
          name: "Independent",
          baseURL: "https://provider.test/v1",
          id: Relay.VendorID.chatgpt,
          key: "sk-test",
          revision: 0,
        })
        const managed = yield* catalog.setVisibility({
          vendorId: Relay.VendorID.chatgpt,
          modelId: Model.ID.make("gpt-5.2"),
          visible: true,
        })
        expect(managed[0]?.visible).toBe(true)
        expect(catalog.visible(RelayCatalog.modelID("chatgpt", "gpt-5.2"))).toBe(true)
        expect(catalog.hasManaged()).toBe(true)
        const hidden = yield* catalog.setVisibility({
          vendorId: Relay.VendorID.chatgpt,
          modelId: Model.ID.make("gpt-5.2"),
          visible: false,
        })
        expect(hidden[0]?.visible).toBe(false)
        expect(catalog.visible(RelayCatalog.modelID("chatgpt", "gpt-5.2"))).toBe(false)
      }),
    ),
  )

  it.live("maps 401 probe failures to KEY_REJECTED", () =>
    withCatalog(
      (catalog, auth) =>
        Effect.gen(function* () {
          yield* auth.setVendor({
            name: "Independent",
            baseURL: "https://provider.test/v1",
            id: Relay.VendorID.chatgpt,
            key: "sk-test",
            revision: 0,
          })
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
          yield* auth.setVendor({
            name: "Independent",
            baseURL: "https://provider.test/v1",
            id: Relay.VendorID.chatgpt,
            key: "sk-test",
            revision: 0,
          })
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
          yield* auth.setVendor({
            name: "Independent",
            baseURL: "https://provider.test/v1",
            id: Relay.VendorID.chatgpt,
            key: "sk-test",
            revision: 0,
          })
          expect((yield* catalog.probe(Relay.VendorID.chatgpt)).count).toBe(0)
        }),
      httpLayer(200, { data: [] }),
    ),
  )

  it.live("maps invalid upstream JSON to UPSTREAM_INVALID_RESPONSE", () =>
    withCatalog(
      (catalog, auth) =>
        Effect.gen(function* () {
          yield* auth.setVendor({
            name: "Independent",
            baseURL: "https://provider.test/v1",
            id: Relay.VendorID.chatgpt,
            key: "sk-test",
            revision: 0,
          })
          const invalid = yield* catalog.probe(Relay.VendorID.chatgpt).pipe(Effect.flip)
          expect(invalid.info.code).toBe("UPSTREAM_INVALID_RESPONSE")
        }),
      httpLayer(200, { models: [] }),
    ),
  )

  it.live("assigns independent upstream models to their source instead of guessing from owned_by", () =>
    withCatalog(
      (catalog, auth) =>
        Effect.gen(function* () {
          const first = yield* auth.setVendor({
            name: "Independent",
            baseURL: "https://provider.test/v1",
            id: Relay.VendorID.chatgpt,
            key: "sk-test",
            revision: 0,
          })
          yield* auth.setVendor({
            id: Relay.VendorID.make("openai"),
            name: "OpenAI",
            baseURL: "https://provider.test/v1",
            key: "sk-other",
            revision: first.revision,
          })
          const candidates = yield* catalog.refresh(Relay.VendorID.chatgpt)
          const conflict = candidates.find((item) => item.modelId === "shared-model")
          expect(conflict?.assignmentSource).toBe("manual")
          expect(conflict?.vendorId).toBe(Relay.VendorID.chatgpt)
          expect(catalog.visible("shared-model")).toBe(false)
        }),
      httpLayer(200, { data: [{ id: "shared-model", owned_by: "openai" }] }),
    ),
  )

  const outOfOrder = (sameKey: boolean) =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const oldStarted = yield* Deferred.make<void>()
          const newStarted = yield* Deferred.make<void>()
          const releaseOld = yield* Deferred.make<void>()
          const releaseNew = yield* Deferred.make<void>()
          const seen: Array<{ id: number; url: string; authorization: string; status: number }> = []
          let calls = 0
          const http = Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.gen(function* () {
                calls += 1
                const id = calls
                const authorization = request.headers.authorization ?? ""
                const body = id === 1 ? [{ id: "old-model" }] : [{ id: "new-model" }]
                if (id === 1) yield* Deferred.succeed(oldStarted, undefined)
                if (id === 2) yield* Deferred.succeed(newStarted, undefined)
                yield* Deferred.await(id === 1 ? releaseOld : releaseNew)
                seen.push({ id, url: request.url, authorization, status: 200 })
                return HttpClientResponse.fromWeb(
                  request,
                  new Response(JSON.stringify({ data: body }), { status: 200 }),
                )
              }),
            ),
          )
          const layer = AppNodeBuilder.build(LayerNode.group([RelayCatalog.node, RelayAuth.node]), [
            [Global.node, Global.layerWith({ data: tmp.path })],
            [RelaySecretStore.node, RelaySecretStore.memoryLayer],
            [LayerNodePlatform.httpClient, http],
          ])
          const ids = yield* Effect.gen(function* () {
            const auth = yield* RelayAuth.Service
            const catalog = yield* RelayCatalog.Service
            let state = yield* auth.setVendor({
              name: "Independent",
              baseURL: "https://provider.test/v1",
              id: Relay.VendorID.chatgpt,
              key: "sk-old",
              revision: 0,
            })
            const oldFiber = yield* catalog.refresh(Relay.VendorID.chatgpt).pipe(Effect.forkChild)
            yield* Deferred.await(oldStarted).pipe(Effect.timeout("3 seconds"))
            if (!sameKey) {
              state = yield* auth.setVendor({
                name: "Independent",
                baseURL: "https://provider.test/v1",
                id: Relay.VendorID.chatgpt,
                key: "sk-new",
                revision: state.revision,
              })
            }
            const newFiber = yield* catalog.refresh(Relay.VendorID.chatgpt).pipe(Effect.forkChild)
            yield* Deferred.await(newStarted).pipe(Effect.timeout("3 seconds"))
            yield* Deferred.succeed(releaseNew, undefined)
            const fresh = yield* Fiber.join(newFiber).pipe(Effect.timeout("3 seconds"))
            const afterNew = (yield* catalog.candidates(Relay.VendorID.chatgpt)).map((item) => String(item.modelId))
            yield* Deferred.succeed(releaseOld, undefined)
            yield* Fiber.join(oldFiber).pipe(Effect.timeout("3 seconds"))
            return {
              fresh: fresh.map((item) => String(item.modelId)),
              afterNew,
              final: (yield* catalog.candidates(Relay.VendorID.chatgpt)).map((item) => String(item.modelId)),
              seen,
            }
          }).pipe(
            Effect.provide(layer),
            Effect.ensuring(
              Effect.all([Deferred.succeed(releaseOld, undefined), Deferred.succeed(releaseNew, undefined)], {
                concurrency: "unbounded",
              }),
            ),
            Effect.timeout("8 seconds"),
          )
          expect(ids.seen.map((item) => item.id)).toEqual([2, 1])
          expect(ids.seen.map((item) => item.authorization)).toEqual(
            sameKey ? ["Bearer sk-old", "Bearer sk-old"] : ["Bearer sk-new", "Bearer sk-old"],
          )
          expect(ids.seen.every((item) => item.url.endsWith("/models") && item.status === 200)).toBe(true)
          expect(ids.fresh).toEqual(["new-model"])
          expect(ids.afterNew).toEqual(["new-model"])
          expect(ids.final).toEqual(["new-model"])
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    )

  it.live("keeps the newer catalog when an older refresh responds later", () =>
    Effect.forEach(
      Array.from({ length: 10 }, (_, attempt) => attempt),
      () => outOfOrder(false),
      { concurrency: 1 },
    ),
  )

  it.live("keeps the current generation when the same vendor key responds out of order", () =>
    Effect.forEach(
      Array.from({ length: 10 }, (_, attempt) => attempt),
      () => outOfOrder(true),
      { concurrency: 1 },
    ),
  )

  it.live("drops a deleted vendor from the projected catalog", () =>
    withCatalog(
      (catalog, auth) =>
        Effect.gen(function* () {
          const id = Relay.VendorID.make("gone")
          let state = yield* auth.setVendor({
            id,
            name: "Gone",
            key: "sk-gone",
            baseURL: "https://old.invalid/v1",
            revision: 0,
          })
          yield* catalog.refresh(id)
          yield* catalog.setVisibility({ vendorId: id, modelId: Model.ID.make("gone-model"), visible: true })
          const before: string[] = []
          catalog.apply((_provider, model, update) => {
            const draft = { name: "", enabled: false, api: { url: "" }, variants: [] }
            update(draft)
            before.push(`${model}:${draft.api.url}`)
          })
          expect(before.some((item) => item.includes("old.invalid"))).toBe(true)
          yield* auth.deleteVendor({ id, revision: state.revision })
          yield* catalog.syncVendors()
          const after: string[] = []
          catalog.apply((_provider, model) => {
            after.push(model)
          })
          expect(after.some((item) => item.includes("gone"))).toBe(false)
          expect(yield* catalog.managed()).toEqual([])
        }),
      httpLayer(200, { data: [{ id: "gone-model" }] }),
    ),
  )

  it.live("keeps an in-flight vendor refresh when another vendor starts refreshing", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const release = yield* Deferred.make<void>()
          const http = Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.gen(function* () {
                const key = request.headers.authorization ?? ""
                if (key.includes("chatgpt")) yield* Deferred.await(release)
                const id = key.includes("chatgpt") ? "chatgpt-model" : "grok-model"
                return HttpClientResponse.fromWeb(
                  request,
                  new Response(JSON.stringify({ data: [{ id }] }), { status: 200 }),
                )
              }),
            ),
          )
          const layer = AppNodeBuilder.build(LayerNode.group([RelayCatalog.node, RelayAuth.node]), [
            [Global.node, Global.layerWith({ data: tmp.path })],
            [RelaySecretStore.node, RelaySecretStore.memoryLayer],
            [LayerNodePlatform.httpClient, http],
          ])
          const ids = yield* Effect.gen(function* () {
            const auth = yield* RelayAuth.Service
            const catalog = yield* RelayCatalog.Service
            let state = yield* auth.setVendor({
              name: "Independent",
              baseURL: "https://provider.test/v1",
              id: Relay.VendorID.chatgpt,
              key: "chatgpt-key",
              revision: 0,
            })
            state = yield* auth.setVendor({
              name: "Independent",
              baseURL: "https://provider.test/v1",
              id: Relay.VendorID.grok,
              key: "grok-key",
              revision: state.revision,
            })
            const slow = yield* catalog.refresh(Relay.VendorID.chatgpt).pipe(Effect.forkChild)
            const fresh = yield* catalog.refresh(Relay.VendorID.grok)
            yield* Deferred.succeed(release, undefined)
            yield* Fiber.join(slow)
            return {
              chatgpt: (yield* catalog.candidates(Relay.VendorID.chatgpt)).map((item) => String(item.modelId)),
              grok: (yield* catalog.candidates(Relay.VendorID.grok)).map((item) => String(item.modelId)),
              grokFresh: fresh.map((item) => String(item.modelId)),
            }
          }).pipe(Effect.provide(layer))
          expect(ids.chatgpt).toEqual(["chatgpt-model"])
          expect(ids.grok).toEqual(["grok-model"])
          expect(ids.grokFresh).toEqual(["grok-model"])
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("C01 waits for the first catalog commit before applying the second visibility change", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const layer = AppNodeBuilder.build(LayerNode.group([RelayCatalog.node, RelayAuth.node]), [
            [Global.node, Global.layerWith({ data: tmp.path })],
            [RelaySecretStore.node, RelaySecretStore.memoryLayer],
          ])
          const result = yield* Effect.gen(function* () {
            let writes = 0
            yield* RelayCatalog.withCommitHook((phase) => {
              if (phase !== "write") return Effect.void
              writes += 1
              if (writes > 1) return Effect.void
              return Effect.gen(function* () {
                yield* Deferred.succeed(entered, undefined)
                yield* Deferred.await(release)
              })
            })
            const auth = yield* RelayAuth.Service
            const catalog = yield* RelayCatalog.Service
            yield* auth.setVendor({
              name: "Independent",
              baseURL: "https://provider.test/v1",
              id: Relay.VendorID.chatgpt,
              key: "sk-c01",
              revision: 0,
            })
            const first = yield* catalog
              .setVisibility({ vendorId: Relay.VendorID.chatgpt, modelId: Model.ID.make("gpt-first"), visible: true })
              .pipe(Effect.forkChild)
            yield* Deferred.await(entered).pipe(Effect.timeout("5 seconds"))
            const second = yield* catalog
              .setVisibility({ vendorId: Relay.VendorID.chatgpt, modelId: Model.ID.make("gpt-second"), visible: true })
              .pipe(Effect.forkChild)
            yield* Effect.yieldNow
            const waitingWrites = writes
            const memoryWhileHeld = (yield* catalog.managed()).map((item) => String(item.modelId)).sort()
            yield* Deferred.succeed(release, undefined)
            const firstResult = yield* Fiber.join(first).pipe(Effect.timeout("5 seconds"))
            const secondResult = yield* Fiber.join(second).pipe(Effect.timeout("5 seconds"))
            const disk = JSON.parse(
              yield* Effect.promise(() => Bun.file(path.join(tmp.path, "relay-catalog.json")).text()),
            ) as {
              managed: Array<{ modelId: string }>
            }
            return {
              waitingWrites,
              memoryWhileHeld,
              first: firstResult.map((item) => String(item.modelId)).sort(),
              second: secondResult.map((item) => String(item.modelId)).sort(),
              disk: disk.managed.map((item) => item.modelId).sort(),
              memory: (yield* catalog.managed()).map((item) => String(item.modelId)).sort(),
            }
          }).pipe(Effect.provide(layer), Effect.ensuring(Deferred.succeed(release, undefined)))
          expect(result.waitingWrites).toBe(1)
          expect(result.memoryWhileHeld).toEqual([])
          expect(result.first).toEqual(["gpt-first"])
          expect(result.second).toEqual(["gpt-first", "gpt-second"])
          expect(result.disk).toEqual(["gpt-first", "gpt-second"])
          expect(result.memory).toEqual(["gpt-first", "gpt-second"])
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("projects a changed vendor address after sync", () =>
    withCatalog(
      (catalog, auth) =>
        Effect.gen(function* () {
          const id = Relay.VendorID.make("moved")
          let state = yield* auth.setVendor({
            id,
            name: "Moved",
            key: "sk-moved",
            baseURL: "https://old.invalid/v1",
            revision: 0,
          })
          yield* catalog.refresh(id)
          yield* catalog.setVisibility({ vendorId: id, modelId: Model.ID.make("moved-model"), visible: true })
          state = yield* auth.setVendor({
            id,
            baseURL: "https://new.invalid/v1",
            revision: state.revision,
          })
          yield* catalog.syncVendors()
          const urls: string[] = []
          catalog.apply((_provider, _model, update) => {
            const draft = { name: "", enabled: false, api: { url: "" }, variants: [] }
            update(draft)
            urls.push(draft.api.url)
          })
          expect(urls).toEqual(["https://new.invalid/v1"])
        }),
      httpLayer(200, { data: [{ id: "moved-model" }] }),
    ),
  )
})
