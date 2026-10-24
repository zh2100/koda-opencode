export * as TaskOrchestratorFailure from "./failure"

import { Cause, Exit } from "effect"
import { LLMError } from "@opencode-ai/llm"

const TRANSIENT = new Set(["Transport", "RateLimit", "ProviderInternal"])

const causeOf = (value: unknown) => {
  if (Exit.isExit(value) && Exit.isFailure(value)) return Cause.findErrorOption(value.cause)
  if (Cause.isCause(value)) return Cause.findErrorOption(value)
  return undefined
}

export const describe = (cause: unknown) => {
  const found = causeOf(cause)
  const error = found?._tag === "Some" ? found.value : cause
  const llm = error instanceof LLMError ? error : undefined
  const tag = llm?.reason._tag
  const kind = llm && "kind" in llm.reason && typeof llm.reason.kind === "string" ? llm.reason.kind : undefined
  const http = llm && "http" in llm.reason ? llm.reason.http : undefined
  const status = http?.response?.status
  const label =
    tag === "Transport"
      ? "the model provider transport failed"
      : tag === "RateLimit"
        ? "the model provider rate limit was reached"
        : tag === "ProviderInternal"
          ? "the model provider failed"
          : tag === "Authentication"
            ? "the model provider rejected the credentials"
            : tag === "NoRoute"
              ? "no route is configured for the model"
              : tag === "InvalidRequest"
                ? "the model provider rejected the request"
                : tag === "ContentPolicy"
                  ? "the model provider blocked the request"
                  : tag === "QuotaExceeded"
                    ? "the model provider quota was exceeded"
                    : String(cause).includes("exceeded timeout")
                      ? "a collaboration step exceeded its timeout"
                      : String(cause)
  const detail = [tag, kind, status === undefined ? undefined : `HTTP ${status}`].filter(Boolean).join(" ")
  const text = detail ? `${label} (${detail})` : label
  return {
    text: text.length > 300 ? `${text.slice(0, 300)}...` : text,
    retryable: tag ? TRANSIENT.has(tag) : String(cause).includes("exceeded timeout"),
  }
}
