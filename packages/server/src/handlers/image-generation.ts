import { ImageGenerationSettings } from "@opencode-ai/core/image-generation-settings"
import { InvalidRequestError } from "@opencode-ai/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"

export const ImageGenerationHandler = HttpApiBuilder.group(Api, "server.imageGeneration", (handlers) =>
  Effect.gen(function* () {
    const settings = yield* ImageGenerationSettings.Service
    const mapError = (error: ImageGenerationSettings.Error) => new InvalidRequestError({ message: error.message, kind: error.code })
    return handlers
      .handle("imageGeneration.get", () => settings.get().pipe(Effect.mapError(mapError)))
      .handle("imageGeneration.update", (ctx) => settings.update(ctx.payload).pipe(Effect.mapError(mapError)))
  }),
)
