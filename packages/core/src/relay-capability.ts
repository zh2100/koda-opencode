export * as RelayCapability from "./relay-capability"

import { Relay } from "@opencode-ai/schema/relay"

export const version = 1

const vendorEfforts: Record<string, ReadonlyArray<Relay.Effort>> = {
  chatgpt: ["low", "medium", "high", "xhigh"],
  grok: ["medium", "high", "xhigh"],
  claude: ["high", "xhigh"],
  gemini: ["low", "high"],
  kimi: ["medium", "high"],
}

export function efforts(vendorId: string, modelId: string): ReadonlyArray<Relay.Effort> {
  if (!reasoningModel(modelId)) return []
  return vendorEfforts[vendorId] ?? []
}

function reasoningModel(modelId: string) {
  const id = modelId.toLowerCase()
  return /gpt-5|o[1-4]|grok|claude|gemini|kimi|thinking|reason/.test(id)
}

export function variants(vendorId: string, modelId: string) {
  return efforts(vendorId, modelId).map((id) => ({
    id,
    headers: {},
    body: { reasoning_effort: id === "low" ? "low" : id },
  }))
}
