import { describe, expect, test } from "bun:test"
import { TaskOrchestratorReview } from "@opencode-ai/core/task-orchestrator/review"

describe("TaskOrchestratorReview", () => {
  test("parses an approved structured result", () => {
    expect(TaskOrchestratorReview.parse('{"approved":true,"findings":[]}')).toEqual({ approved: true, findings: [] })
  })

  test("rejects malformed or incomplete output", () => {
    expect(TaskOrchestratorReview.parse("approved")).toBeUndefined()
    expect(TaskOrchestratorReview.parse('{"approved":false}')).toBeUndefined()
  })

  test("requests revision until the retry limit, then fails", () => {
    const result = { approved: false, findings: [{ message: "Fix validation" }] }
    expect(TaskOrchestratorReview.decision(result, 0, 2)).toEqual({ action: "revise", retryCount: 1 })
    expect(TaskOrchestratorReview.decision(result, 2, 2)).toEqual({ action: "fail", retryCount: 2 })
  })

  test("approved review continues without changing retry count", () => {
    expect(TaskOrchestratorReview.decision({ approved: true, findings: [] }, 1, 2)).toEqual({ action: "continue", retryCount: 1 })
  })

  test("creates an auditable worker revision plan", () => {
    const output = '{"approved":false,"findings":[{"message":"Add a test","path":"src/a.ts","line":4}]}'
    expect(TaskOrchestratorReview.plan(output, 0, 1)).toEqual({
      action: "revise",
      retryCount: 1,
      findings: [{ message: "Add a test", path: "src/a.ts", line: 4 }],
      reviewerOutput: output,
      workerPrompt: "Revise the implementation to address these reviewer findings:\n- Add a test (src/a.ts:4)",
    })
  })

  test("fails malformed output without creating a worker retry", () => {
    expect(TaskOrchestratorReview.plan("not-json", 0, 3)).toEqual({
      action: "fail",
      retryCount: 0,
      findings: [],
      reviewerOutput: "not-json",
    })
  })

  test("encodes and decodes the review record stored in a run", () => {
    const output = '{"approved":false,"findings":[{"message":"Fix it"}]}'
    const record = TaskOrchestratorReview.store(output, TaskOrchestratorReview.plan(output, 0, 1))
    expect(TaskOrchestratorReview.decode(TaskOrchestratorReview.encode(record))).toEqual(record)
    expect(TaskOrchestratorReview.decode('{"kind":"other"}')).toBeUndefined()
  })
})
