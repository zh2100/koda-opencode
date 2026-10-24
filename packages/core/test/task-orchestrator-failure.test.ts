import { describe, expect, test } from "bun:test"
import { Cause } from "effect"
import { LLMError, TransportReason, AuthenticationReason } from "@opencode-ai/llm"
import { TaskOrchestratorFailure } from "@opencode-ai/core/task-orchestrator/failure"

const error = (reason: LLMError["reason"]) => new LLMError({ module: "RequestExecutor", method: "execute", reason })

describe("TaskOrchestratorFailure", () => {
  test("keeps the provider error kind and retries only transient failures", () => {
    const transport = TaskOrchestratorFailure.describe(
      Cause.fail(error(new TransportReason({ message: "socket hang up", kind: "TransportError" }))),
    )
    const auth = TaskOrchestratorFailure.describe(
      error(new AuthenticationReason({ message: "invalid key", kind: "invalid" })),
    )

    expect(transport.retryable).toBe(true)
    expect(transport.text).toContain("Transport")
    expect(transport.text).toContain("TransportError")
    expect(auth.retryable).toBe(false)
    expect(auth.text).toContain("Authentication")
  })
})
