import { describe, expect, test } from "bun:test"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { TaskOrchestrator } from "@opencode-ai/core/task-orchestrator"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { WorkspaceOwnership } from "@opencode-ai/core/workspace-ownership"
import { TaskOrchestratorReview } from "@opencode-ai/core/task-orchestrator/review"

describe("TaskOrchestrator", () => {
  test("defines the fixed role pipeline", () => {
    expect(TaskOrchestrator.Roles).toEqual(["planner", "worker", "reviewer", "tester", "finalizer"])
  })

  test("uses a read-only agent for non-worker roles", () => {
    expect(TaskOrchestrator.RoleAgents).toEqual({
      planner: "orchestrator-readonly",
      worker: "build",
      reviewer: "orchestrator-readonly",
      tester: "orchestrator-tester",
      finalizer: "orchestrator-readonly",
    })
  })

  test("parses configured provider/model references", () => {
    expect(ModelV2.parse("openai/gpt-6-astra")).toEqual({ providerID: ProviderV2.ID.make("openai"), modelID: ModelV2.ID.make("gpt-6-astra") })
  })

  test("uses the canonical workspace key for a session location", () => {
    const location = Location.Ref.make({ directory: AbsolutePath.make("C:/repo") })
    expect(TaskOrchestrator.RoleAgents.worker).toBe("build")
    expect(WorkspaceOwnership.workspaceKey(location)).toContain("directory:")
  })

  test("turns structured reviewer output into a bounded revision decision", () => {
    const decision = TaskOrchestrator.review('{"approved":false,"findings":[{"message":"Add a test","path":"src/a.ts","line":4}]}', 0, 1)
    expect(decision.action).toBe("revise")
    expect(TaskOrchestrator.revisionPrompt(decision.findings)).toContain("src/a.ts:4")
    expect(TaskOrchestrator.review('{"approved":false,"findings":[{"message":"Still broken"}]}', 1, 1).action).toBe("fail")
  })

  test("exposes safe retry state transitions", () => {
    const output = '{"approved":false,"findings":[{"message":"Fix it"}]}'
    const review = TaskOrchestratorReview.store(output, TaskOrchestratorReview.plan(output, 0, 1))
    expect(TaskOrchestrator.retryTransition({ review, maxRetries: 1, stepRetryCount: 0 }).action).toBe("revise")
  })
})
