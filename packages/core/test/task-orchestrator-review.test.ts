import { describe, expect, test } from "bun:test"
import { TaskOrchestratorReview } from "@opencode-ai/core/task-orchestrator/review"

describe("TaskOrchestratorReview", () => {
  test("parses an approved structured result", () => {
    expect(TaskOrchestratorReview.parse('{"approved":true,"findings":[]}')).toEqual({ approved: true, findings: [] })
  })

  test("normalizes prose and embedded reviewer JSON", () => {
    expect(TaskOrchestratorReview.parse("Missing a regression test")).toEqual({
      approved: true,
      findings: [{ message: "Missing a regression test" }],
    })
    expect(TaskOrchestratorReview.parse("```json\n{\"approved\":true,\"findings\":[]}\n```")).toEqual({
      approved: true,
      findings: [],
    })
    expect(TaskOrchestratorReview.parse('{"approved":false}')).toEqual({
      approved: true,
      findings: [{ message: '{"approved":false}' }],
    })
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

  test("keeps prose moving and records it as a finding", () => {
    expect(TaskOrchestratorReview.plan("not-json", 0, 3)).toEqual({
      action: "continue",
      retryCount: 0,
      findings: [{ message: "not-json" }],
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
