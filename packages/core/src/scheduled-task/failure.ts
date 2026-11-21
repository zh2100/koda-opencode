export * as ScheduledTaskFailure from "./failure"

import { LLMError } from "@opencode-ai/llm"
import { RelayError } from "@opencode-ai/schema/relay-error"
import { RelayAuth } from "../relay-auth"
import { RelayCatalog } from "../relay-catalog"
import { SessionRunnerModel } from "../session/runner/model"

export type Decision = Pick<RelayError.Info, "code" | "retryable" | "details"> & { readonly pauseTask: boolean }

export function classify(error: unknown, phase: "ready" | "execution" = "execution"): Decision {
  if (error instanceof RelayAuth.AuthError || error instanceof RelayCatalog.CatalogError)
    return {
      code: error.info.code,
      retryable: error.info.retryable,
      pauseTask: phase === "ready" && error.info.code === "KEY_MISSING",
    }
  if (
    error &&
    typeof error === "object" &&
    "_tag" in error &&
    error._tag === "ScheduledTask.Paused" &&
    "code" in error &&
    (error.code === "MODEL_UNAVAILABLE" || error.code === "PROJECT_INVALID")
  )
    return { code: error.code, retryable: false, pauseTask: true }
  if (error instanceof SessionRunnerModel.ModelUnavailableError)
    return { code: "MODEL_UNAVAILABLE", retryable: false, pauseTask: false }
  if (
    error instanceof SessionRunnerModel.ModelNotSelectedError ||
    error instanceof SessionRunnerModel.VariantUnavailableError ||
    error instanceof SessionRunnerModel.UnsupportedApiError
  )
    return { code: "MODEL_UNAVAILABLE", retryable: false, pauseTask: true }
  if (error instanceof LLMError) {
    const reason = error.reason
    const code =
      reason._tag === "RateLimit"
        ? "UPSTREAM_RATE_LIMITED"
        : reason._tag === "Transport" || reason._tag === "ProviderInternal"
          ? "UPSTREAM_UNREACHABLE"
          : reason._tag === "InvalidProviderOutput"
            ? "UPSTREAM_INVALID_RESPONSE"
            : reason._tag === "Authentication"
              ? reason.kind === "missing"
                ? "KEY_MISSING"
                : "KEY_REJECTED"
              : "TASK_EXECUTION_FAILED"
    return { code, retryable: reason.retryable, pauseTask: false }
  }
  return { code: "TASK_EXECUTION_FAILED", retryable: false, pauseTask: false }
}
