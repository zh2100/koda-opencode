export * as ImageGenerationTool from "./image-generation"

import { ToolFailure } from "@opencode-ai/llm"
import { Relay } from "@opencode-ai/schema/relay"
import { Effect, Layer, Schema } from "effect"
import { Headers, HttpClient } from "effect/unstable/http"
import { Catalog } from "../catalog"
import { Config } from "../config"
import { ImageGeneration } from "../image-generation"
import { ImageGenerationSettings } from "../image-generation-settings"
import { Integration } from "../integration"
import { ModelV2 } from "../model"
import { PermissionV2 } from "../permission"
import { ProviderV2 } from "../provider"
import { RelayAuth } from "../relay-auth"
import { RelayCatalog } from "../relay-catalog"
import { makeLocationNode } from "../effect/app-node"
import { LayerNodePlatform } from "../effect/app-node-platform"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

const layer = Layer.effectDiscard(Effect.gen(function* () {
  const tools = yield* Tools.Service
  const config = yield* Config.Service
  const settings = yield* ImageGenerationSettings.Service
  const catalog = yield* Catalog.Service
  const integrations = yield* Integration.Service
  const relay = yield* RelayAuth.Service
  const relayCatalog = yield* RelayCatalog.Service
  const permission = yield* PermissionV2.Service
  const http = yield* HttpClient.HttpClient

  yield* tools.register({
    [ImageGeneration.name]: Tool.make({
      description: ImageGeneration.description,
      input: ImageGeneration.Input,
      output: ImageGeneration.Output,
      structured: Schema.Struct({ model: Schema.String, images: Schema.Array(Schema.Struct({ mime: Schema.String })) }),
      toStructuredOutput: ({ output }) => ({ model: output.model, images: output.images.map((image) => ({ mime: image.mime })) }),
      toModelOutput: ({ output }) => [
        { type: "text", text: `Generated an image using ${output.model}.` },
        ...output.images.map((image) => ({ type: "file" as const, ...image, name: `generated-image.${image.mime === "image/jpeg" ? "jpg" : image.mime.slice(6)}` })),
      ],
      execute: (input, context) => Effect.gen(function* () {
        const selected = Config.latest(yield* config.entries(), "image_generation") ?? (yield* settings.get())
        if (!selected?.model || selected.enabled !== true)
          return yield* new ImageGeneration.Error({ message: "No image model configured. Choose an independent image model in Settings > Models." })
        if (!selected.api)
          return yield* new ImageGeneration.Error({ message: "No image API selected. Choose the provider protocol for this model in Settings > Models." })
        const ref = ModelV2.parse(selected.model)
        const model = (yield* catalog.model.available()).find((item) => item.providerID === ref.providerID && item.id === ref.modelID)
        if (!model) return yield* new ImageGeneration.Error({ message: "The configured image model is unavailable or its provider is not connected. No fallback was attempted." })
        yield* permission.assert({
          action: ImageGeneration.name,
          resources: [selected.model],
          save: [selected.model],
          metadata: { model: selected.model, prompt: input.prompt },
          sessionID: context.sessionID,
          agent: context.agent,
          source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
        })
        const target = yield* Effect.gen(function* () {
          if (model.providerID === ProviderV2.ID.leidiandonghua && model.family && relayCatalog.visible(model.id)) {
            const credential = yield* relay.resolve(Relay.VendorID.make(model.family)).pipe(Effect.mapError(() => new ImageGeneration.Error({ message: "The image provider is not connected." })))
            return { model: model.api.id, baseURL: credential.baseURL, headers: { Authorization: `Bearer ${credential.key}` }, api: selected.api }
          }
          const provider = yield* catalog.provider.get(model.providerID)
          const connection = yield* integrations.connection.active(provider?.integrationID ?? Integration.ID.make(model.providerID))
          const credential = connection ? yield* integrations.connection.resolve(connection).pipe(Effect.mapError(() => new ImageGeneration.Error({ message: "Could not resolve image provider credentials." }))) : undefined
          if (credential?.type === "oauth")
            return yield* new ImageGeneration.Error({ message: "This image API requires an API-key connection; chat OAuth credentials are not supported." })
          const key = credential?.type === "key" ? credential.key : model.request.body.apiKey ?? model.api.settings?.apiKey
          const baseURL = model.api.url ?? (model.providerID === "openai" ? "https://api.openai.com/v1" : undefined)
          if (!baseURL) return yield* new ImageGeneration.Error({ message: "The image provider has no API base URL." })
          const headers: Record<string, string> = { ...model.request.headers }
          if (typeof key === "string" && key.trim() && !headers.authorization && !headers["x-goog-api-key"]) {
            if (selected.api === "google-gemini") headers["x-goog-api-key"] = key
            if (selected.api !== "google-gemini") headers.authorization = `Bearer ${key}`
          }
          if (!Object.entries(Headers.fromInput(headers)).some(([name, value]) => ["authorization", "api-key", "x-api-key", "x-goog-api-key"].includes(name) && value.trim()))
            return yield* new ImageGeneration.Error({ message: "The image provider has no API-key credentials. Connect it before generating images." })
          return { model: model.api.id, baseURL, headers, api: selected.api }
        })
        return yield* ImageGeneration.generate(target, input).pipe(Effect.provideService(HttpClient.HttpClient, http))
      }).pipe(Effect.mapError((error) => new ToolFailure({ message: error instanceof ImageGeneration.Error ? error.message : "Image generation was denied or failed. No fallback was attempted." }))),
    }),
  }).pipe(Effect.orDie)
}))

export const node = makeLocationNode({
  name: "tool/image-generation",
  layer,
  deps: [ToolRegistry.node, Config.node, ImageGenerationSettings.node, Catalog.node, Integration.node, RelayAuth.node, RelayCatalog.node, PermissionV2.node, LayerNodePlatform.httpClient],
})
