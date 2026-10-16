import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
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
            let state = yield* auth.setUnifiedKey({ key: "shared-secret", revision: 0 })
            state = yield* auth.setMode({ unified: true, revision: state.revision })
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
                catalog.apply((provider, id, update) => editor.model.update(ProviderV2.ID.make(provider), ModelV2.ID.make(id), update))
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
        expect(catalog.visible("gpt-5.2")).toBe(false)
      }),
    ),
  )

  it.live("removes stale candidates from the refreshed vendor without affecting other vendors", () => {
    let chatgptRefresh = false
    const http = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        const key = request.headers.authorization
        const data =
          key?.startsWith("Bearer chatgpt")
            ? chatgptRefresh
              ? [{ id: "gpt-new", owned_by: "openai" }]
              : [
                  { id: "gpt-old", owned_by: "openai" },
                  { id: "mystery-old" },
                ]
            : [{ id: "grok-kept", owned_by: "xai" }]
        return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(JSON.stringify({ data }), { status: 200 })))
      }),
    )

    return withCatalog(
      (catalog, auth) =>
        Effect.gen(function* () {
          let state = yield* auth.setVendor({
            id: Relay.VendorID.chatgpt,
            key: "chatgpt-key",
            revision: 0,
          })
          state = yield* auth.setVendor({ id: Relay.VendorID.grok, key: "grok-key", revision: state.revision })
          yield* catalog.refresh(Relay.VendorID.chatgpt)
          yield* catalog.refresh(Relay.VendorID.grok)
          yield* catalog.setVisibility({
            vendorId: Relay.VendorID.chatgpt,
            modelId: Model.ID.make("gpt-old"),
            visible: true,
          })

          chatgptRefresh = true
          state = yield* auth.setVendor({
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
