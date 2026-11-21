import { expect } from "bun:test"
import { LLM, LLMClient, type LLMRequest } from "@opencode-ai/llm"
import * as OpenAIResponses from "@opencode-ai/llm/protocols/openai-responses"
import { DateTime, Effect, Layer } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { testEffect } from "./lib/effect"

const providerID = ProviderV2.ID.make("openai")
const modelID = ModelV2.ID.make("gpt-image-host")

const catalogModel = (body: Record<string, ModelV2.Info["request"]["body"][string]> = { imageGeneration: true }) =>
  ModelV2.Info.make({
    id: modelID,
    providerID,
    name: "Hosted image model",
    api: { id: modelID, type: "aisdk", package: "@ai-sdk/openai", url: "https://api.openai.test/v1" },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    request: { headers: {}, body },
    variants: [
      {
        id: ModelV2.VariantID.make("hosted"),
        headers: {},
        body: { imageGeneration: true },
      },
    ],
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: 8000, output: 1000 },
  })

const session = (variant?: string) =>
  SessionSchema.Info.make({
    id: SessionSchema.ID.make("ses_image_permission"),
    projectID: ProjectV2.ID.make("global"),
    title: "image permission",
    agent: AgentV2.ID.make("build"),
    model: variant
      ? { providerID, id: modelID, variant: ModelV2.VariantID.make(variant) }
      : { providerID, id: modelID },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
    location: { directory: AbsolutePath.make("/project") },
  })

const productRequest = (model: LLMRequest["model"], tools: LLMRequest["tools"] = []) =>
  LLM.request({
    model,
    providerOptions: { openai: { promptCacheKey: "session-cache", imageGeneration: false } },
    tools,
  })

const hostedTools = (body: unknown) => {
  const tools = (body as { tools?: Array<{ type?: string; name?: string }> }).tools ?? []
  return tools.filter((tool) => tool.type === "image_generation" || tool.name === "image_generation")
}

const it = testEffect(Layer.empty)

it.effect("does not grant hosted image generation from an ordinary product model option", () =>
  Effect.gen(function* () {
    const resolved = yield* SessionRunnerModel.fromCatalogModel(catalogModel())
    const prepared = yield* LLMClient.prepare(productRequest(resolved))
    expect(resolved.route.defaults.providerOptions).toMatchObject({ openai: { imageGeneration: false } })
    expect(prepared.body).not.toHaveProperty("imageGeneration")
    expect(hostedTools(prepared.body)).toEqual([])
    expect(prepared.body).toMatchObject({ prompt_cache_key: "session-cache" })
  }),
)

it.effect("keeps hosted image generation disabled for a model variant and a connection default", () =>
  Effect.gen(function* () {
    const variant = yield* SessionRunnerModel.resolve(session("hosted"), catalogModel({}))
    const connection = yield* SessionRunnerModel.fromCatalogModel(catalogModel({}), {
      type: "key",
      key: "test-token",
      metadata: { imageGeneration: true },
    })
    const variantBody = yield* LLMClient.prepare(productRequest(variant))
    const connectionBody = yield* LLMClient.prepare(productRequest(connection))
    expect(hostedTools(variantBody.body)).toEqual([])
    expect(hostedTools(connectionBody.body)).toEqual([])
    expect(connectionBody.body).toMatchObject({ prompt_cache_key: "session-cache" })
  }),
)

it.effect("does not restore a hosted image tool after permission filtering removes the local tool", () =>
  Effect.gen(function* () {
    const resolved = yield* SessionRunnerModel.fromCatalogModel(catalogModel())
    const filtered = productRequest(resolved, [])
    const prepared = yield* LLMClient.prepare(filtered)
    expect(filtered.tools).toEqual([])
    expect(hostedTools(prepared.body)).toEqual([])
  }),
)

it.effect("keeps an explicit library caller able to enable hosted image generation", () =>
  Effect.gen(function* () {
    const model = OpenAIResponses.route
      .with({ endpoint: { baseURL: "https://api.openai.test/v1/" } })
      .model({ id: "gpt-4.1-mini" })
    const prepared = yield* LLMClient.prepare(
      LLM.request({
        model,
        providerOptions: { openai: { imageGeneration: true } },
        tools: [{ name: "read", description: "Read a file", inputSchema: { type: "object" } }],
      }),
    )
    expect(hostedTools(prepared.body)).toEqual([{ type: "image_generation" }])
  }),
)
