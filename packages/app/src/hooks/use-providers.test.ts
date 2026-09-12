import { expect, test } from "bun:test"
import { popularProviders } from "./use-providers"

test("popular providers stay on the relay catalog", () => {
  expect(popularProviders).toEqual(["leidiandonghua", "chatgpt", "grok"])
  expect(popularProviders).not.toContain("openai")
  expect(popularProviders).not.toContain("anthropic")
  expect(popularProviders).not.toContain("google")
})
