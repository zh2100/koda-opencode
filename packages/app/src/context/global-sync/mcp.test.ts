import { describe, expect, test } from "bun:test"
import { toggleMcp } from "./mcp"
import type { McpServer } from "./types"

describe("toggleMcp", () => {
  test("runs the status action before refreshing the owning query", async () => {
    const calls: string[] = []
    const input = (status: "connected" | "needs_auth" | "disabled") => ({
      status: { status } as McpServer,
      connect: async () => {
        calls.push("connect")
      },
      disconnect: async () => {
        calls.push("disconnect")
      },
      authenticate: async () => {
        calls.push("authenticate")
      },
      refresh: async () => {
        calls.push("refresh")
      },
    })

    await toggleMcp(input("connected"))
    expect(calls).toEqual(["disconnect", "refresh"])

    calls.length = 0
    await toggleMcp(input("needs_auth"))
    expect(calls).toEqual(["authenticate", "refresh"])

    calls.length = 0
    await toggleMcp(input("disabled"))
    expect(calls).toEqual(["connect", "refresh"])
  })

  test("does not toggle a server while its connection is pending", async () => {
    const calls: string[] = []
    await toggleMcp({
      status: { status: "pending" } as McpServer,
      connect: async () => {
        calls.push("connect")
      },
      disconnect: async () => {
        calls.push("disconnect")
      },
      authenticate: async () => {
        calls.push("authenticate")
      },
      refresh: async () => {
        calls.push("refresh")
      },
    })
    expect(calls).toEqual([])
  })
})
