import { expect, test } from "bun:test"
import { relayErrorKey, vendorIdFromName } from "./use-relay-settings"

test("vendor IDs stay lowercase and drop punctuation", () => {
  expect(vendorIdFromName("ChatGPT")).toBe("chatgpt")
  expect(vendorIdFromName("  Open AI  ")).toBe("open-ai")
  expect(vendorIdFromName("---")).toMatch(/^vendor-/)
})

test("maps relay error codes onto settings copy keys", () => {
  expect(relayErrorKey({ message: "KEY_MISSING" })).toBe("settings.relay.error.KEY_MISSING")
  expect(relayErrorKey({ message: "REVISION_CONFLICT" })).toBe("settings.relay.error.REVISION_CONFLICT")
  expect(relayErrorKey(new Error("boom"))).toBe("common.requestFailed")
})
