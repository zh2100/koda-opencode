import { ImageGeneration } from "@opencode-ai/core/image-generation"
import { Effect } from "effect"
import { HttpClient } from "effect/unstable/http"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { define, type Context } from "./tool"

export const ImageGenerationTool = define(
  ImageGeneration.name,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const provider = yield* Provider.Service
    const http = yield* HttpClient.HttpClient

    return {
      description: ImageGeneration.description,
      parameters: ImageGeneration.Input,
      execute: (input: typeof ImageGeneration.Input.Type, context: Context) => Effect.gen(function* () {
        const selected = (yield* config.get()).image_generation
        if (!selected?.model || selected.enabled !== true)
          return yield* new ImageGeneration.Error({ message: "No image model configured. Choose an independent image model in Settings > Models." })
        if (!selected.api)
          return yield* new ImageGeneration.Error({ message: "No image API selected. Choose the provider protocol for this model in Settings > Models." })
        yield* context.ask({
          permission: ImageGeneration.name,
          patterns: [selected.model],
          always: [selected.model],
          metadata: { model: selected.model, prompt: input.prompt },
        })
        const ref = Provider.parseModel(selected.model)
        const resolved = yield* provider.getImageTarget(ref.providerID, ref.modelID).pipe(
          Effect.mapError((error) => error instanceof ImageGeneration.Error ? error : new ImageGeneration.Error({ message: "The configured image model is unavailable or its provider is not connected. No fallback was attempted." })),
        )
        const target = { ...resolved, api: selected.api }
        const result = yield* ImageGeneration.generate(target, input).pipe(Effect.provideService(HttpClient.HttpClient, http))
        return {
          title: selected.model,
          output: `Generated an image using ${selected.model}.`,
          metadata: { model: selected.model },
          attachments: result.images.map((image) => ({
            type: "file" as const,
            mime: image.mime,
            url: `data:${image.mime};base64,${image.data}`,
            filename: `generated-image.${image.mime === "image/jpeg" ? "jpg" : image.mime.slice(6)}`,
          })),
        }
      }).pipe(Effect.orDie),
    }
  }),
)
