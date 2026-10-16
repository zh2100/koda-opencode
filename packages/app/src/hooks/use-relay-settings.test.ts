import { expect, test } from "bun:test"
import { relayErrorKey, vendorIdFromName, vendorURLValid } from "./relay-settings"

test("vendor IDs stay lowercase and drop punctuation", () => {
  expect(vendorIdFromName("ChatGPT")).toBe("chatgpt")
  expect(vendorIdFromName("  Open AI  ")).toBe("open-ai")
  expect(vendorIdFromName("---")).toMatch(/^vendor-/)
})

test("vendor IDs cannot overwrite builtin or custom vendors with the same slug", () => {
  expect(vendorIdFromName("ChatGPT", ["chatgpt", "chatgpt-2"])).toBe("chatgpt-3")
  expect(vendorIdFromName("Open AI", ["open-ai", "open-ai-3"])).toBe("open-ai-2")
  expect(vendorIdFromName("New", ["chatgpt"])).toBe("new")
})

test("vendor URLs accept HTTP endpoints and paths", () => {
  for (const url of ["https://api.example.com/v1", " http://localhost:8080/v1/ ", "https://[::1]:443/v1"])
    expect(vendorURLValid(url)).toBe(true)
})

test("vendor URLs reject credentials, query strings, fragments and malformed URLs", () => {
  for (const url of [
    "",
    "example.com",
    "ftp://example.com",
    "https://",
    "https:////example.com",
    "https://example.com:99999",
    "https://user@example.com",
    "https://user:pass@example.com",
    "https://@example.com",
    "https://example.com?",
    "https://example.com?key=secret",
    "https://example.com#",
    "https://example.com#fragment",
    "https://example.com/a b",
    "https://example.com\\path",
  ])
    expect(vendorURLValid(url)).toBe(false)
})

test("maps relay error codes onto settings copy keys", () => {
  expect(relayErrorKey({ message: "KEY_MISSING" })).toBe("settings.relay.error.KEY_MISSING")
  expect(relayErrorKey({ message: "REVISION_CONFLICT" })).toBe("settings.relay.error.REVISION_CONFLICT")
  expect(relayErrorKey(new Error("boom"))).toBe("common.requestFailed")
  expect(relayErrorKey(new Error("provider.custom.error.baseURL.format"))).toBe("provider.custom.error.baseURL.format")
})
