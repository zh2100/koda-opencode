export * as ToolErrorProjection from "./tool-error-projection"

import { LLMError } from "./schema/errors"
import type { ProviderMetadata } from "./schema/ids"
import type { ToolResultValue } from "./schema/messages"
import { isRecord } from "./utils/record"

export const toolMessage = "Tool execution failed"
export const providerMessage = "Provider request failed"
const unavailable = { _opencode: "hosted-error-unavailable-v1" } as const

// Protocol evidence: @anthropic-ai/sdk 0.71.2 messages and beta/messages contracts.
const anthropic = {
  web_search: {
    type: "web_search_tool_result_error",
    codes: ["invalid_tool_input", "unavailable", "max_uses_exceeded", "too_many_requests", "query_too_long"],
  },
  web_fetch: {
    type: "web_fetch_tool_result_error",
    codes: [
      "invalid_tool_input",
      "url_too_long",
      "url_not_allowed",
      "url_not_accessible",
      "unsupported_content_type",
      "too_many_requests",
      "max_uses_exceeded",
      "unavailable",
    ],
  },
  code_execution: {
    type: "code_execution_tool_result_error",
    codes: ["invalid_tool_input", "unavailable", "too_many_requests", "execution_time_exceeded"],
  },
} as const

export function anthropicValue(name: string, result: ToolResultValue) {
  if (result.type !== "error" || !Object.hasOwn(anthropic, name)) return
  const rule = anthropic[name as keyof typeof anthropic]
  if (
    !isRecord(result.value) ||
    result.value.type !== rule.type ||
    typeof result.value.error_code !== "string" ||
    !(rule.codes as readonly string[]).includes(result.value.error_code)
  )
    return
  return { type: rule.type, error_code: result.value.error_code }
}

export function openaiItem(id: string, call?: ProviderMetadata, result?: ProviderMetadata) {
  const ref = (metadata?: ProviderMetadata) => {
    if (metadata?.openai === undefined) return undefined
    if (!isRecord(metadata.openai) || typeof metadata.openai.itemId !== "string") return null
    const item = metadata.openai.itemId
    return /^[a-zA-Z][a-zA-Z0-9_-]{0,255}$/.test(item) && item === id ? item : null
  }
  const left = ref(call)
  const right = ref(result)
  if (left === null || right === null || (left !== undefined && right !== undefined && left !== right)) return
  return right ?? left
}

export function blocked(result: ToolResultValue) {
  return result.type === "error" && isRecord(result.value) && result.value._opencode === unavailable._opencode
}

export function project(input: {
  readonly id: string
  readonly name: string
  readonly executed: boolean
  readonly result?: ToolResultValue
  readonly callMetadata?: ProviderMetadata
  readonly resultMetadata?: ProviderMetadata
}) {
  const error = { type: "unknown" as const, message: toolMessage }
  if (!input.executed) return { error, result: { type: "error" as const, value: toolMessage }, metadata: undefined }
  const value = input.result ? anthropicValue(input.name, input.result) : undefined
  if (value && input.resultMetadata?.openai === undefined && input.callMetadata?.openai === undefined)
    return { error, result: { type: "error" as const, value }, metadata: undefined }
  const itemId = openaiItem(input.id, input.callMetadata, input.resultMetadata)
  if (itemId) return { error, result: { type: "error" as const, value: toolMessage }, metadata: { openai: { itemId } } }
  return { error, result: { type: "error" as const, value: unavailable }, metadata: undefined }
}

export function assistant(error: LLMError) {
  switch (error.reason._tag) {
    case "RateLimit":
      return "Provider rate limit reached"
    case "Authentication":
      return "Provider authentication failed"
    case "InvalidProviderOutput":
      return "Provider returned an invalid response"
    case "Transport":
      return "Provider unavailable"
    default:
      return providerMessage
  }
}
