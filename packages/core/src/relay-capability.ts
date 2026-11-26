export * as RelayCapability from "./relay-capability"

import { Relay } from "@opencode-ai/schema/relay"

export const version = 4

type Efforts = ReadonlyArray<Relay.Effort>

const chatgpt = {
  full: ["low", "medium", "high", "xhigh"] as Efforts,
  noUltra: ["low", "medium", "high"] as Efforts,
}
const grok = {
  full: ["medium", "high", "xhigh"] as Efforts,
  noUltra: ["medium", "high"] as Efforts,
}
const claude = {
  full: ["high", "xhigh"] as Efforts,
  noUltra: ["high"] as Efforts,
}
const gemini = {
  full: ["low", "high"] as Efforts,
  flash: ["low"] as Efforts,
}
const kimi = {
  full: ["medium", "high"] as Efforts,
}

const vendorEfforts: Record<string, Efforts> = {
  chatgpt: chatgpt.full,
  grok: grok.full,
  claude: claude.full,
  gemini: gemini.full,
  kimi: kimi.full,
}

const modelEfforts: Record<string, ReadonlyArray<readonly [RegExp, Efforts]>> = {
  chatgpt: [
    [/luna/, chatgpt.noUltra],
    [/sol|astra/, chatgpt.full],
    [/chat(?:-|$)/, []],
    [/mini|compact|spark|auto-review/, chatgpt.noUltra],
  ],
  grok: [
    [/non-reasoning|imagine|image|video/, []],
    [/build/, grok.noUltra],
    [/reasoning|multi-agent/, grok.full],
  ],
  claude: [[/haiku/, claude.noUltra]],
  gemini: [[/flash/, gemini.flash]],
  kimi: [[/thinking|reason/, kimi.full]],
}

// Exact upstream IDs work with user-named OpenAI-compatible relays too.
// These describe upstream capabilities, not a guarantee of relay acceptance.
const exactEfforts: Record<string, Efforts> = {
  "gpt-6.2-astra": ["low", "medium", "high", "xhigh", "max", "ultra"],
  "gpt-6.2-sol": ["low", "medium", "high", "xhigh", "max"],
  "gpt-6-astra": ["low", "medium", "high", "xhigh", "max"],
  "gpt-6.1-sol": ["low", "medium", "high", "xhigh", "max"],
  "gpt-6.1-terra": ["none", "low", "medium", "high", "xhigh", "max"],
  "grok-4.6": ["low", "medium", "high", "xhigh"],
  "grok-4.7": ["low", "medium", "high", "xhigh"],
}

export function efforts(vendorId: string, modelId: string): Efforts {
  const id = modelId.toLowerCase()
  if (Object.hasOwn(exactEfforts, id)) return exactEfforts[id]
  for (const [pattern, value] of modelEfforts[vendorId] ?? []) {
    if (pattern.test(id)) return value
  }
  if (!reasoningModel(id)) return []
  return vendorEfforts[vendorId] ?? []
}

function reasoningModel(modelId: string) {
  return /gpt-(?:[5-9]|\d{2,})|o[1-4]|grok|claude|gemini|kimi|thinking|reason/.test(modelId)
}

export function variants(vendorId: string, modelId: string) {
  return efforts(vendorId, modelId).map((id) => ({
    // Saved "ultra" selections mean xhigh. Give native Ultra a separate variant ID.
    id: id === "ultra" ? "native-ultra" : id === "xhigh" ? "ultra" : id,
    headers: {},
    body: { reasoning_effort: id },
  }))
}
