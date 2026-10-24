import { describe, expect, test } from "bun:test"
import { normalizeReasoningDelta } from "./reasoning"

describe("AI SDK reasoning stream", () => {
  test("converts cumulative reasoning chunks to suffixes", () => {
    const state: Record<string, string> = {}

    expect(normalizeReasoningDelta(state, "reasoning-0", "D")).toBe("D")
    expect(normalizeReasoningDelta(state, "reasoning-0", "DD")).toBe("D")
    expect(normalizeReasoningDelta(state, "reasoning-0", "DDD")).toBe("D")
    expect(normalizeReasoningDelta(state, "reasoning-0", "DDD路径")).toBe("路径")
  })

  test("preserves normal reasoning deltas", () => {
    const state: Record<string, string> = {}

    expect(normalizeReasoningDelta(state, "reasoning-0", "先")).toBe("先")
    expect(normalizeReasoningDelta(state, "reasoning-0", "检查")).toBe("检查")
  })

  test("drops repeated cumulative reasoning chunks without losing repeated text", () => {
    const state: Record<string, string> = {}

    expect(normalizeReasoningDelta(state, "reasoning-0", "代码链路")).toBe("代码链路")
    expect(normalizeReasoningDelta(state, "reasoning-0", "代码链路")).toBe("")
    expect(normalizeReasoningDelta(state, "reasoning-0", "链路")).toBe("链路")
    expect(state["reasoning-0"]).toBe("代码链路链路")
  })

  test("drops consecutive duplicate incremental reasoning chunks", () => {
    const state: Record<string, string> = {}
    const repeated: Record<string, string> = {}

    expect(normalizeReasoningDelta(state, "reasoning-0", "代码", repeated)).toBe("代码")
    expect(normalizeReasoningDelta(state, "reasoning-0", "代码", repeated)).toBe("")
    expect(normalizeReasoningDelta(state, "reasoning-0", "代码", repeated)).toBe("")
    expect(normalizeReasoningDelta(state, "reasoning-0", "链路", repeated)).toBe("链路")
    expect(state["reasoning-0"]).toBe("代码链路")
  })
})
