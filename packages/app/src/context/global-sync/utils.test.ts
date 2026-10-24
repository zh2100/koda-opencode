import { describe, expect, test } from "bun:test"
import type {
  AgentsListOutput,
  ModelsListOutput,
  ProvidersListOutput,
} from "@opencode-ai/client/promise"
import { directoryKey, normalizeAgentList, normalizePermissionRequest, normalizeProviderList } from "./utils"

describe("normalizeAgentList", () => {
  test("adapts current agents to the app agent shape", () => {
    const result = normalizeAgentList([
      {
        id: "build",
        mode: "primary",
        hidden: false,
        color: "primary",
        model: { id: "gpt-5", providerID: "openai", variant: "high" },
        request: { headers: { temperature: "0.2", topP: "0.9" }, body: {} },
        system: "Build software",
        permissions: [{ action: "read", resource: "*", effect: "allow" }],
      },
    ] as AgentsListOutput["data"])

    expect(result).toEqual([
      {
        name: "build",
        description: undefined,
        mode: "primary",
        hidden: false,
        temperature: undefined,
        topP: undefined,
        color: "primary",
        permission: [{ permission: "read", pattern: "*", action: "allow" }],
        model: { providerID: "openai", modelID: "gpt-5" },
        variant: "high",
        prompt: "Build software",
        options: { headers: { temperature: "0.2", topP: "0.9" }, body: {} },
        steps: undefined,
      },
    ])
  })
})

describe("normalizePermissionRequest", () => {
  test("adapts the current permission request to app state", () => {
    expect(
      normalizePermissionRequest({
        id: "permission-1",
        sessionID: "session-1",
        action: "read",
        resources: ["README.md"],
        save: ["*.md"],
        metadata: { path: "README.md" },
        source: { type: "tool", messageID: "message-1", callID: "call-1" },
      }),
    ).toEqual({
      id: "permission-1",
      sessionID: "session-1",
      permission: "read",
      patterns: ["README.md"],
      always: ["*.md"],
      metadata: { path: "README.md" },
      tool: { messageID: "message-1", callID: "call-1" },
    })
  })
})

describe("normalizeProviderList", () => {
  test("groups current models into the app provider catalog", () => {
    const result = normalizeProviderList(
      [{ id: "openai", name: "OpenAI", api: { type: "aisdk", package: "@ai-sdk/openai" }, request: { headers: {}, body: {} } }] as ProvidersListOutput["data"],
      [
        {
          id: "gpt-5",
          providerID: "openai",
          name: "GPT-5",
          api: { id: "gpt-5", type: "aisdk", package: "@ai-sdk/openai" },
          capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
          request: { headers: {}, body: {} },
          variants: [{ id: "high", headers: {}, body: {} }],
          time: { released: 1 },
          cost: [{ input: 1, output: 2, cache: { read: 0.1, write: 0.2 } }],
          status: "active",
          enabled: true,
          limit: { context: 128_000, output: 8_192 },
        },
        {
          id: "gpt-old",
          providerID: "openai",
          name: "GPT Old",
          api: { id: "gpt-old", type: "aisdk", package: "@ai-sdk/openai" },
          capabilities: { tools: false, input: ["text"], output: ["text"] },
          request: { headers: {}, body: {} },
          variants: [],
          time: { released: 0 },
          cost: [],
          status: "deprecated",
          enabled: true,
          limit: { context: 1, output: 1 },
        },
      ] as ModelsListOutput["data"],
      { id: "gpt-5", providerID: "openai" } as ModelsListOutput["data"][number],
    )

    expect(result.connected).toEqual(["openai"])
    expect(result.defaultModel).toEqual({ providerID: "openai", modelID: "gpt-5" })
    expect(result.default).toEqual({ openai: "gpt-5" })
    expect(result.all.get("openai")?.models["gpt-old"]).toBeUndefined()
    expect(result.all.get("openai")?.models["gpt-5"]).toMatchObject({
      id: "gpt-5",
      providerID: "openai",
      capabilities: { toolcall: true, attachment: true },
      cost: { input: 1, output: 2 },
      variants: { high: {} },
    })
  })

  test("preserves an empty current default", () => {
    expect(normalizeProviderList([] as ProvidersListOutput["data"], [], undefined).defaultModel).toBeNull()
  })
})

describe("directoryKey", () => {
  test("normalizes slashes", () => {
    expect(String(directoryKey("C:\\Repos\\sst\\opencode"))).toBe("C:/Repos/sst/opencode")
    expect(String(directoryKey("C:/Repos/sst/opencode"))).toBe("C:/Repos/sst/opencode")
  })

  test("preserves backslashes in posix paths", () => {
    expect(String(directoryKey("/tmp/foo\\bar"))).toBe("/tmp/foo\\bar")
  })

  test("trims trailing slashes without breaking roots", () => {
    expect(String(directoryKey("C:/Repos/sst/opencode/"))).toBe("C:/Repos/sst/opencode")
    expect(String(directoryKey("C:/"))).toBe("C:/")
    expect(String(directoryKey("/"))).toBe("/")
  })
})
