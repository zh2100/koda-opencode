export * as ImageGeneration from "./image-generation"

import { Schema } from "effect"

export const Api = Schema.Literals([
  "openai-images",
  "google-gemini",
  "alibaba-dashscope",
  "openai-chat",
])
export type Api = typeof Api.Type

export const Config = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  model: Schema.optional(Schema.String.check(Schema.isPattern(/^[^/\s]+\/\S+$/))),
  api: Schema.optional(Api),
}).annotate({
  identifier: "ImageGenerationConfig",
  description:
    "Independent image generation model. The selected API is the provider protocol and never changes the conversation model or enables paid probing/fallback.",
})
export type Config = typeof Config.Type

/** Discovery is informational only: it never sends a request or selects a paid model. */
export function capability(input: {
  id: string
  name?: string
  output?: readonly string[]
  override?: boolean
}) {
  if (input.override !== undefined) return { supported: input.override, source: "manual" as const }
  if (input.output?.some((value) => value === "image" || value.startsWith("image/")))
    return { supported: true, source: "metadata" as const }
  if (/^(?:gpt-image-\d[\w.-]*|dall-e-[23])$/i.test(input.id))
    return { supported: true, source: "catalog" as const }
  if (/(?:gpt-image|dall-e|imagen|flux|stable-diffusion|text-to-image|image-generation)/i.test(`${input.id} ${input.name ?? ""}`))
    return { supported: undefined, source: "name" as const }
  return { supported: undefined, source: "unknown" as const }
}

/** Map a connected provider SDK to its native image protocol. Unknown SDKs stay unselected. */
export function apiForProvider(input: { providerID?: string; npm?: string }): Api | undefined {
  const npm = input.npm ?? ""
  if (npm === "@ai-sdk/google" || npm === "@ai-sdk/google-vertex") return "google-gemini"
  if (npm === "@ai-sdk/alibaba") return "alibaba-dashscope"
  if (npm === "@ai-sdk/openai" || npm === "@ai-sdk/azure" || npm === "@ai-sdk/xai") return "openai-images"
  if (npm.includes("@ai-sdk/openai-compatible") || input.providerID === "leidiandonghua") return "openai-chat"
  return undefined
}
