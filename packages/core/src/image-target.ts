import { Relay } from "@opencode-ai/schema/relay"
import { Effect } from "effect"
import { Headers } from "effect/unstable/http"
import { Catalog } from "./catalog"
import { Config } from "./config"
import { ImageGeneration } from "./image-generation"
import { ImageGenerationSettings } from "./image-generation-settings"
import { Integration } from "./integration"
import { ModelV2 } from "./model"
import { ProviderV2 } from "./provider"
import { RelayAuth } from "./relay-auth"
import { RelayCatalog } from "./relay-catalog"

export function imageGenerationSelection(entries: readonly Config.Entry[], settings: ImageGenerationSettings.Interface) {
  const selected = Config.latest(entries, "image_generation")
  return selected ? Effect.succeed(selected) : settings.get()
}

export const resolveImageTarget = Effect.fn("ImageTarget.resolve")(function* (
  model: ModelV2.Info,
  api: ImageGeneration.Protocol,
  catalog: Catalog.Interface,
  integrations: Integration.Interface,
  relay: RelayAuth.Interface,
  relayCatalog: RelayCatalog.Interface,
) {
  if (model.providerID === ProviderV2.ID.leidiandonghua && model.family && relayCatalog.visible(model.id)) {
    const credential = yield* relay
      .resolve(Relay.VendorID.make(model.family))
      .pipe(Effect.mapError(() => new ImageGeneration.Error({ message: "The image provider is not connected." })))
    return {
      model: model.api.id,
      baseURL: credential.baseURL,
      headers: { Authorization: `Bearer ${credential.key}` },
      api: api,
    }
  }
  const provider = yield* catalog.provider.get(model.providerID)
  const connection = yield* integrations.connection.active(
    provider?.integrationID ?? Integration.ID.make(model.providerID),
  )
  const credential = connection
    ? yield* integrations.connection
        .resolve(connection, { refreshOAuth: false })
        .pipe(
          Effect.mapError(
            () => new ImageGeneration.Error({ message: "Could not resolve image provider credentials." }),
          ),
        )
    : undefined
  if (credential?.type === "oauth")
    return yield* new ImageGeneration.Error({
      message: "This image API requires an API-key connection; chat OAuth credentials are not supported.",
    })
  const key = credential?.type === "key" ? credential.key : (model.request.body.apiKey ?? model.api.settings?.apiKey)
  const baseURL = model.api.url ?? (model.providerID === "openai" ? "https://api.openai.com/v1" : undefined)
  if (!baseURL) return yield* new ImageGeneration.Error({ message: "The image provider has no API base URL." })
  const headers: Record<string, string> = { ...model.request.headers }
  if (typeof key === "string" && key.trim() && !headers.authorization && !headers["x-goog-api-key"]) {
    if (api === "google-gemini") headers["x-goog-api-key"] = key
    if (api !== "google-gemini") headers.authorization = `Bearer ${key}`
  }
  if (
    !Object.entries(Headers.fromInput(headers)).some(
      ([name, value]) => ["authorization", "api-key", "x-api-key", "x-goog-api-key"].includes(name) && value.trim(),
    )
  )
    return yield* new ImageGeneration.Error({
      message: "The image provider has no API-key credentials. Connect it before generating images.",
    })
  return { model: model.api.id, baseURL, headers, api: api }
})
