export * as ImageGenerationTool from "./image-generation"

import { ToolFailure } from "@opencode-ai/llm"
import { imageGenerationSelection, resolveImageTarget } from "../image-target"
import { Effect, Layer, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import { Catalog } from "../catalog"
import { Config } from "../config"
import { ImageGeneration } from "../image-generation"
import { ImageGenerationSettings } from "../image-generation-settings"
import { Integration } from "../integration"
import { ModelV2 } from "../model"
import { PermissionV2 } from "../permission"
import { RelayAuth } from "../relay-auth"
import { RelayCatalog } from "../relay-catalog"
import { makeLocationNode } from "../effect/app-node"
import { LayerNodePlatform } from "../effect/app-node-platform"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

import { guardedImageTools } from "./illustration-capability"

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const config = yield* Config.Service
    const settings = yield* ImageGenerationSettings.Service
    const catalog = yield* Catalog.Service
    const integrations = yield* Integration.Service
    const relay = yield* RelayAuth.Service
    const relayCatalog = yield* RelayCatalog.Service
    const permission = yield* PermissionV2.Service
    const http = yield* HttpClient.HttpClient

    const tool = Tool.make({
      description: ImageGeneration.description,
      input: ImageGeneration.Input,
      output: ImageGeneration.Output,
      structured: Schema.Struct({ model: Schema.String, images: Schema.Array(Schema.Struct({ mime: Schema.String })) }),
      toStructuredOutput: ({ output }) => ({
        model: output.model,
        images: output.images.map((image) => ({ mime: image.mime })),
      }),
      toModelOutput: ({ output }) => [
        { type: "text", text: `Generated an image using ${output.model}.` },
        ...output.images.map((image) => ({
          type: "file" as const,
          ...image,
          name: `generated-image.${image.mime === "image/jpeg" ? "jpg" : image.mime.slice(6)}`,
        })),
      ],
      execute: (input, context) =>
        Effect.gen(function* () {
          const selected = yield* imageGenerationSelection(yield* config.entries(), settings)
          if (!selected?.model || selected.enabled !== true)
            return yield* new ImageGeneration.Error({
              message: "No image model configured. Choose an independent image model in Settings > Models.",
            })
          if (!selected.api)
            return yield* new ImageGeneration.Error({
              message: "No image API selected. Choose the provider protocol for this model in Settings > Models.",
            })
          const ref = ModelV2.parse(selected.model)
          const model = (yield* catalog.model.available()).find(
            (item) => item.providerID === ref.providerID && item.id === ref.modelID,
          )
          if (!model)
            return yield* new ImageGeneration.Error({
              message:
                "The configured image model is unavailable or its provider is not connected. No fallback was attempted.",
            })
          yield* permission
            .assert({
              action: ImageGeneration.name,
              resources: [selected.model],
              save: [selected.model],
              metadata: { model: selected.model, prompt: input.prompt },
              sessionID: context.sessionID,
              agent: context.agent,
              source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
            })
            .pipe(
              Effect.catchDefect((defect) =>
                context.beforeImagePost && defect instanceof PermissionV2.DeclinedError
                  ? Effect.fail(new ToolFailure({ message: "Image request declined before dispatch." }))
                  : Effect.die(defect),
              ),
            )
          const target = yield* resolveImageTarget(model, selected.api, catalog, integrations, relay, relayCatalog)
          if (context.beforeImagePost) {
            // URL validation is the last local preflight in generate; do not charge quota for a bad URL.
            yield* Effect.try({
              try: () => ImageGeneration.endpoint(target.baseURL),
              catch: () => new ImageGeneration.Error({ message: "Invalid image provider URL." }),
            })
            // Re-read after permission prompts, not from the earlier model selection.
            const current = yield* imageGenerationSelection(yield* config.entries(), settings)
            if (!current.enabled || current.model !== selected.model || current.api !== selected.api)
              return yield* new ImageGeneration.Error({
                message: "Image settings changed before dispatch. No request was sent.",
              })
            yield* context.beforeImagePost(selected.model, selected.api)
          }
          return yield* ImageGeneration.generate(target, input).pipe(Effect.provideService(HttpClient.HttpClient, http))
        }).pipe(
          Effect.mapError(
            (error) =>
              new ToolFailure({
                message:
                  error instanceof ImageGeneration.Error || error instanceof ToolFailure
                    ? error.message
                    : "Image generation was denied or failed. No fallback was attempted.",
              }),
          ),
        ),
    })
    guardedImageTools.add(tool)
    yield* tools.register({ [ImageGeneration.name]: tool }).pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/image-generation",
  layer,
  deps: [
    ToolRegistry.node,
    Config.node,
    ImageGenerationSettings.node,
    Catalog.node,
    Integration.node,
    RelayAuth.node,
    RelayCatalog.node,
    PermissionV2.node,
    LayerNodePlatform.httpClient,
  ],
})
