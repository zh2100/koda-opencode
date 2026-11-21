import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { Catalog } from "@opencode-ai/core/catalog"
import { Config } from "@opencode-ai/core/config"
import { Credential } from "@opencode-ai/core/credential"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ImageGenerationSettings } from "@opencode-ai/core/image-generation-settings"
import { Integration } from "@opencode-ai/core/integration"
import { ModelV2 } from "@opencode-ai/core/model"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { RelayAuth } from "@opencode-ai/core/relay-auth"
import { RelayCatalog } from "@opencode-ai/core/relay-catalog"
import { SessionV2 } from "@opencode-ai/core/session"
import { ImageGenerationTool } from "@opencode-ai/core/tool/image-generation"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { ImageGeneration } from "@opencode-ai/schema/image-generation"
import { testEffect } from "./lib/effect"
import { executeTool, settleTool, toolIdentity } from "./lib/tool"

const it = testEffect(Layer.empty)
const png = "iVBORw0KGgo="
const config = { enabled: true, model: "local/image", api: "openai-images" } as const
const call = {
  sessionID: SessionV2.ID.make("ses_image_generation_test"),
  ...toolIdentity,
  call: { type: "tool-call" as const, id: "call-image", name: "image_generation", input: { prompt: "a test image" } },
}

function fixture(
  options: {
    config?: ImageGeneration.Config
    settings?: ImageGeneration.Config
    project?: boolean
    missing?: boolean
    key?: string
    denied?: boolean
    oauth?: boolean
    relay?: boolean
  } = {},
) {
  const requests: string[] = []
  const assertions: PermissionV2.AssertInput[] = []
  const model = ModelV2.Info.make({
    ...ModelV2.Info.empty(
      options.relay ? ProviderV2.ID.leidiandonghua : ProviderV2.ID.make("local"),
      options.relay ? ModelV2.ID.make("custom:vendor:image") : ModelV2.ID.make("image"),
    ),
    family: options.relay ? ModelV2.Family.make("vendor") : undefined,
    api: {
      type: "aisdk",
      package: "@ai-sdk/openai-compatible",
      id: ModelV2.ID.make(options.relay ? "upstream-relay-image" : "upstream-image"),
      url: "http://image.test/v1",
      settings: {},
    },
    request: { headers: {}, body: { apiKey: options.key ?? "test-key" } },
  })
  const layer = AppNodeBuilder.build(
    LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, ImageGenerationTool.node]),
    [
      [
        Config.node,
        Layer.succeed(
          Config.Service,
          Config.Service.of({
            entries: () =>
              Effect.succeed([
                ...(options.project === false
                  ? []
                  : [
                      new Config.Document({
                        type: "document",
                        info: new Config.Info({ image_generation: options.config ?? config }),
                      }),
                    ]),
              ]),
          }),
        ),
      ],
      [
        ImageGenerationSettings.node,
        Layer.mock(ImageGenerationSettings.Service, {
          get: () =>
            options.settings ? Effect.succeed(options.settings) : Effect.die("project configuration must win"),
        }),
      ],
      [
        Catalog.node,
        Layer.mock(Catalog.Service, {
          model: {
            get: () => Effect.succeed(model),
            all: () => Effect.succeed([model]),
            available: () => Effect.succeed(options.missing ? [] : [model]),
            default: () => Effect.succeed(undefined),
            small: () => Effect.succeed(undefined),
          },
          provider: {
            get: () => Effect.succeed(undefined),
            all: () => Effect.succeed([]),
            available: () => Effect.succeed([]),
          },
        }),
      ],
      [
        Integration.node,
        Layer.mock(Integration.Service, {
          connection: {
            active: () =>
              Effect.succeed(
                options.oauth
                  ? { type: "credential", id: Credential.ID.make("cred_image_oauth"), label: "Chat OAuth" }
                  : undefined,
              ),
            resolve: () =>
              Effect.succeed(
                options.oauth
                  ? {
                      type: "oauth",
                      methodID: Integration.MethodID.make("oauth"),
                      refresh: "refresh",
                      access: "access",
                      expires: 0,
                    }
                  : undefined,
              ),
            key: () => Effect.die("unused"),
            oauth: () => Effect.die("unused"),
            update: () => Effect.die("unused"),
            remove: () => Effect.die("unused"),
          },
          attempt: {
            status: () => Effect.die("unused"),
            complete: () => Effect.die("unused"),
            cancel: () => Effect.die("unused"),
          },
        }),
      ],
      [
        RelayAuth.node,
        Layer.mock(RelayAuth.Service, {
          resolve: () => Effect.succeed({ key: "relay-key", baseURL: "http://image.test/v1" }),
        }),
      ],
      [
        RelayCatalog.node,
        Layer.mock(RelayCatalog.Service, {
          hasManaged: () => false,
          visible: (id) => options.relay === true && id === "custom:vendor:image",
          apply: () => {},
        }),
      ],
      [
        PermissionV2.node,
        Layer.mock(PermissionV2.Service, {
          assert: (input) =>
            Effect.sync(() => assertions.push(input)).pipe(
              Effect.andThen(options.denied ? Effect.fail(new PermissionV2.BlockedError({ rules: [] })) : Effect.void),
            ),
        }),
      ],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
      [
        LayerNodePlatform.httpClient,
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.sync(() => {
              requests.push(request.url)
              const selected = options.config ?? config
              if (selected.api === "google-gemini" && !options.relay)
                expect(request.headers["x-goog-api-key"]).toBe("test-key")
              if (selected.api !== "google-gemini" || options.relay)
                expect(request.headers.authorization).toBe(`Bearer ${options.relay ? "relay-key" : "test-key"}`)
              const body =
                selected.api === "google-gemini"
                  ? { candidates: [{ content: { parts: [{ inlineData: { data: png } }] } }] }
                  : selected.api === "alibaba-dashscope"
                    ? { output: { choices: [{ message: { content: [{ image: `data:image/png;base64,${png}` }] } }] } }
                    : { data: [{ b64_json: png }] }
              return HttpClientResponse.fromWeb(request, Response.json(body))
            }),
          ),
        ),
      ],
    ],
  )
  return { layer, requests, assertions }
}

describe("ImageGenerationTool", () => {
  it.effect("uses only the independent model and returns durable file content without duplicate base64", () => {
    const state = fixture()
    return Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const result = yield* settleTool(registry, call)
      expect(result.output?.structured).toEqual({ model: "upstream-image", images: [{ mime: "image/png" }] })
      expect(result.output?.content).toContainEqual({
        type: "file",
        uri: `data:image/png;base64,${png}`,
        mime: "image/png",
        name: "generated-image.png",
      })
      expect(state.requests).toEqual(["http://image.test/v1/images/generations"])
      expect(state.assertions).toMatchObject([
        { action: "image_generation", resources: ["local/image"], sessionID: call.sessionID },
      ])
    }).pipe(Effect.provide(state.layer))
  })

  it.effect("uses the selected Relay vendor credentials and upstream model ID", () => {
    const state = fixture({
      relay: true,
      config: { enabled: true, model: "leidiandonghua/custom:vendor:image", api: "openai-images" },
    })
    return Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const result = yield* settleTool(registry, call)
      expect(result.output?.structured).toEqual({ model: "upstream-relay-image", images: [{ mime: "image/png" }] })
      expect(state.requests).toEqual(["http://image.test/v1/images/generations"])
    }).pipe(Effect.provide(state.layer))
  })

  it.effect("sends the selected native protocol instead of OpenAI Images", () => {
    const state = fixture({ config: { enabled: true, model: "local/image", api: "google-gemini" } })
    return Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const result = yield* settleTool(registry, call)
      expect(result.output?.structured).toEqual({ model: "upstream-image", images: [{ mime: "image/png" }] })
      expect(state.requests).toEqual(["http://image.test/v1/models/upstream-image:generateContent"])
    }).pipe(Effect.provide(state.layer))
  })

  it.effect("falls back to persisted global settings when no project image config exists", () => {
    const state = fixture({ project: false, settings: config })
    return Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const result = yield* settleTool(registry, call)
      expect(result.output?.structured).toEqual({ model: "upstream-image", images: [{ mime: "image/png" }] })
      expect(state.requests).toHaveLength(1)
    }).pipe(Effect.provide(state.layer))
  })

  for (const item of [
    { name: "disabled", options: { config: { enabled: false } as const }, error: "No image model configured" },
    {
      name: "missing API selection",
      options: { config: { enabled: true, model: "local/image" } as const },
      error: "No image API selected",
    },
    { name: "unavailable selected model", options: { missing: true }, error: "unavailable" },
    { name: "missing credentials", options: { key: "" }, error: "no API-key credentials" },
    {
      name: "chat OAuth despite an explicit model key",
      options: { oauth: true },
      error: "OAuth credentials are not supported",
    },
    { name: "permission denial", options: { denied: true }, error: "denied or failed" },
  ]) {
    it.effect(`rejects ${item.name} without invoking an image API`, () => {
      const state = fixture(item.options)
      return Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        expect(yield* executeTool(registry, call)).toMatchObject({
          type: "error",
          value: expect.stringContaining(item.error),
        })
        expect(state.requests).toEqual([])
      }).pipe(Effect.provide(state.layer))
    })
  }
})
