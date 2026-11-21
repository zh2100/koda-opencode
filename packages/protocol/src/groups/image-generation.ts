import { ImageGeneration } from "@opencode-ai/schema/image-generation"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { InvalidRequestError } from "../errors"

export const ImageGenerationGroup = HttpApiGroup.make("server.imageGeneration")
  .add(HttpApiEndpoint.get("imageGeneration.get", "/api/settings/image-generation", {
    success: ImageGeneration.Config,
    error: InvalidRequestError,
  }).annotate(OpenApi.Summary, "Read this server's independent image generation settings"))
  .add(HttpApiEndpoint.put("imageGeneration.update", "/api/settings/image-generation", {
    payload: ImageGeneration.Config,
    success: ImageGeneration.Config,
    error: InvalidRequestError,
  }).annotate(OpenApi.Summary, "Save this server's independent image generation settings"))
