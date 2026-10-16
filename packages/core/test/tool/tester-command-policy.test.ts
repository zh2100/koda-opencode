import { describe, expect, test } from "bun:test"
import { TesterCommandPolicy } from "@opencode-ai/core/tool/tester-command-policy"

describe("TesterCommandPolicy", () => {
  test("allows common verification commands", () => {
    expect(TesterCommandPolicy.isAllowed("bun test test/example.test.ts")).toBe(true)
    expect(TesterCommandPolicy.isAllowed("bun run typecheck")).toBe(true)
    expect(TesterCommandPolicy.isAllowed("git diff --check")).toBe(true)
  })

  test("rejects shell composition and mutation commands", () => {
    expect(TesterCommandPolicy.isAllowed("bun test; rm -rf .")).toBe(false)
    expect(TesterCommandPolicy.isAllowed("bun test > output.txt")).toBe(false)
    expect(TesterCommandPolicy.isAllowed("npm install")).toBe(false)
    expect(TesterCommandPolicy.isAllowed("git checkout -- file.ts")).toBe(false)
  })
})
