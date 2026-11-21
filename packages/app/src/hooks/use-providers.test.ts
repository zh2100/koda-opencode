import { expect, test } from "bun:test"
import { popularProviders } from "./use-providers"

test("popular providers do not include the retired hosted credential entry", () => {
  expect(popularProviders).toEqual(["openai", "anthropic", "google"])
  expect(popularProviders).not.toContain("leidiandonghua")
})
