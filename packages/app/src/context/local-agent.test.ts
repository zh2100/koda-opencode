import { describe, expect, test } from "bun:test"
import { hasCustomAgent, resolveAgent, resolveCurrentAgent } from "./local-agent"

describe("hasCustomAgent", () => {
  test("detects explicitly custom agents", () => {
    expect(hasCustomAgent([{ native: true }, { native: false }])).toBe(true)
  })

  test("ignores built-in and unclassified agents", () => {
    expect(hasCustomAgent([{ native: true }, {}])).toBe(false)
  })
})

describe("resolveAgent", () => {
  const agents = [{ name: "plan" }, { name: "build" }, { name: "custom" }]

  test("uses the requested available agent", () => {
    expect(resolveAgent(agents, "custom")?.name).toBe("custom")
  })

  test("defaults to build", () => {
    expect(resolveAgent(agents)?.name).toBe("build")
    expect(resolveAgent(agents, "missing")?.name).toBe("build")
  })

  test("uses the first agent when build is unavailable", () => {
    expect(resolveAgent([{ name: "custom" }], "missing")?.name).toBe("custom")
  })
})

describe("resolveCurrentAgent", () => {
  const agents = [{ name: "plan" }, { name: "build" }, { name: "custom" }]

  test("keeps plan mode available when the agent picker is hidden", () => {
    expect(resolveCurrentAgent(agents, "plan", false)?.name).toBe("plan")
  })

  test("falls back to build for hidden custom agents", () => {
    expect(resolveCurrentAgent(agents, "custom", false)?.name).toBe("build")
  })

  test("uses the selected agent when agents are visible", () => {
    expect(resolveCurrentAgent(agents, "custom", true)?.name).toBe("custom")
  })
})
