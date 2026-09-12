import { RelayPolicy } from "../../src/relay-policy"

export const providerID = RelayPolicy.ProviderID
export const baseURL = RelayPolicy.BaseURL

export const builtinVendors = [
  { id: "chatgpt", name: "ChatGPT", builtin: true },
  { id: "grok", name: "Grok", builtin: true },
] as const

export const candidateModels = [
  { vendorId: "chatgpt", modelId: "gpt-5.2" },
  { vendorId: "grok", modelId: "grok-4" },
] as const
