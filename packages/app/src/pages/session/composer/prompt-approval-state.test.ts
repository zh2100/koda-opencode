import { describe, expect, test } from "bun:test"
import { promptApprovalAgent, promptApprovalCurrent, promptApprovalOptions } from "./prompt-approval-state"

describe("prompt approval state", () => {
  test("includes full access only when the plan agent exists", () => {
    expect(
      promptApprovalOptions({ ask: "ask", auto: "auto", plan: "plan", hasPlan: false }).map((item) => item.id),
    ).toEqual(["ask", "auto"])
    expect(
      promptApprovalOptions({ ask: "ask", auto: "auto", plan: "plan", hasPlan: true }).map((item) => item.id),
    ).toEqual(["ask", "auto", "plan"])
  })

  test("uses plan as the current full-access mode", () => {
    expect(promptApprovalCurrent({ auto: false, agent: "plan" })).toBe("plan")
    expect(promptApprovalCurrent({ auto: true, agent: "plan" })).toBe("auto")
    expect(promptApprovalCurrent({ auto: false, agent: "build" })).toBe("ask")
  })

  test("maps selections to the correct agent changes", () => {
    expect(promptApprovalAgent({ id: "plan", currentAgent: "build" })).toBe("plan")
    expect(promptApprovalAgent({ id: "auto", currentAgent: "plan" })).toBe("build")
    expect(promptApprovalAgent({ id: "ask", currentAgent: "plan" })).toBe("build")
    expect(promptApprovalAgent({ id: "ask", currentAgent: "build" })).toBeUndefined()
  })
})
