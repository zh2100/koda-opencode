import { describe, expect, test } from "bun:test"
import { QueryClient } from "@tanstack/solid-query"
import { applyLoadedConfig, canSaveMcp, draftFromConfig, emptyMcpDraft, formatCommand, mcpErrorCode, mcpLoadState, mcpReloadSucceeded, mergeMcpConfig, parseCommand, reconcileMcpReload } from "./mcp-form"

describe("mcp form draft", () => {
  test("keeps an edited command when a slow config arrives", () => {
    const draft = { ...emptyMcpDraft("docs"), command: "node edited.js", touched: { ...emptyMcpDraft().touched, command: true } }
    const next = applyLoadedConfig(draft, "docs", {
      type: "local",
      command: ["npx", "original"],
      environment: { TOKEN: "keep" },
    })

    expect(next.command).toBe("node edited.js")
    expect(next.kind).toBe("local")
    expect(canSaveMcp({ mode: "edit", state: "success", busy: false })).toBe(true)
  })

  test("fills untouched fields and preserves headers when saving", () => {
    const loaded = draftFromConfig("docs", { type: "remote", url: "https://old.invalid", headers: { Authorization: "keep" } })
    const next = applyLoadedConfig(loaded, "docs", { type: "remote", url: "https://old.invalid", headers: { Authorization: "keep" } })
    const saved = mergeMcpConfig(
      { type: "remote", url: "https://old.invalid", headers: { Authorization: "keep" } },
      { ...next, url: "https://new.invalid", touched: { ...next.touched, url: true } },
    )

    expect(saved.url).toBe("https://new.invalid")
    expect(saved.headers).toEqual({ Authorization: "keep" })
  })

  test("blocks save while loading or failed and allows retry success", () => {
    expect(mcpLoadState({ mode: "edit", pending: true, error: false, config: undefined })).toBe("pending")
    expect(canSaveMcp({ mode: "edit", state: "pending", busy: false })).toBe(false)
    expect(mcpLoadState({ mode: "edit", pending: false, error: true, config: undefined })).toBe("error")
    expect(canSaveMcp({ mode: "edit", state: "error", busy: false, writable: true })).toBe(false)
    expect(canSaveMcp({ mode: "edit", state: "error", busy: false, writable: false })).toBe(false)
    expect(
      canSaveMcp({
        mode: "edit",
        state: mcpLoadState({ mode: "edit", pending: false, error: false, config: { type: "local", command: ["node"] } }),
        busy: false,
      }),
    ).toBe(true)
  })

  test("reports a deleted server without treating it as an empty local draft", () => {
    expect(mcpLoadState({ mode: "edit", pending: false, error: false, config: undefined })).toBe("missing")
    expect(canSaveMcp({ mode: "edit", state: "missing", busy: false })).toBe(false)
  })

  test("keeps an untouched command array intact when arguments contain spaces", () => {
    const args = ["C:\\Program Files\\server.js", "hello world"]
    const draft = draftFromConfig("docs", { type: "local", command: args, environment: { TOKEN: "keep" } })
    const saved = mergeMcpConfig({ type: "local", command: args, environment: { TOKEN: "keep" } }, draft)

    expect(saved.command).toEqual(args)
    expect(saved.environment).toEqual({ TOKEN: "keep" })
  })

  test("round-trips an edited command that contains spaces", () => {
    const edited = formatCommand(["C:\\tools\\server.js", "C:\\Program Files\\server.js", "hello world", ""])
    expect(parseCommand(edited)).toEqual(["C:\\tools\\server.js", "C:\\Program Files\\server.js", "hello world", ""])
    expect(parseCommand("\"C:\\Program Files\\server.js\"")).toEqual(["C:\\Program Files\\server.js"])
    const saved = mergeMcpConfig(undefined, {
      ...emptyMcpDraft("docs"),
      command: edited,
      touched: { ...emptyMcpDraft().touched, command: true },
    })
    expect(saved.command).toEqual(["C:\\tools\\server.js", "C:\\Program Files\\server.js", "hello world", ""])
  })

  test("keeps an untouched field from the latest reload and blocks a field both sides changed", () => {
    const original = { type: "local", command: ["node", "old.js"], url: "" }
    const latest = { type: "local", command: ["node", "remote.js"], url: "" }
    const draft = {
      ...draftFromConfig("docs", original),
      command: "node local.js",
      touched: { ...emptyMcpDraft().touched, command: true },
    }
    const reconciled = reconcileMcpReload({ original, latest, draft })

    expect(reconciled.fields).toEqual(["command"])
    expect(reconciled.draft.command).toBe("node local.js")
    expect(reconciled.original).toEqual(original)
    const repeated = reconcileMcpReload({
      original: reconciled.original,
      latest,
      draft: reconciled.draft,
      pending: reconciled.fields,
    })
    expect(repeated.fields).toEqual(["command"])
    expect(repeated.original).toEqual(original)
    expect(repeated.draft.command).toBe("node local.js")
    expect(canSaveMcp({ mode: "edit", state: "success", busy: false, conflict: { code: "MCP_FIELD_CONFLICT", fields: reconciled.fields } })).toBe(false)
    expect(
      canSaveMcp({ mode: "edit", state: "success", busy: false, writable: true, conflict: { code: "MCP_VERSION_CONFLICT", fields: [] } }),
    ).toBe(false)
    expect(
      canSaveMcp({ mode: "edit", state: "success", busy: false, writable: true, conflict: { code: "MCP_SOURCE_CHANGED", fields: [] } }),
    ).toBe(false)
  })

  test("reads a stable MCP error code from a nested response body", () => {
    expect(mcpErrorCode({ cause: { body: { code: "MCP_VERSION_CONFLICT", ref: "abc" } } })).toBe("MCP_VERSION_CONFLICT")
  })

  test("keeps add mode available before any config request", () => {
    expect(mcpLoadState({ mode: "add", pending: true, error: true, config: undefined })).toBe("success")
    expect(canSaveMcp({ mode: "add", state: "success", busy: false })).toBe(true)
  })

  test("keeps a submitted draft from being saved again while refresh can be retried", () => {
    expect(canSaveMcp({ mode: "edit", state: "success", busy: false, writable: true, saved: true })).toBe(false)
    expect(canSaveMcp({ mode: "add", state: "success", busy: false, saved: true })).toBe(false)
    expect(canSaveMcp({ mode: "edit", state: "success", busy: false, writable: true, saved: false })).toBe(true)
  })

  test("keeps an unresolved conflict when a real query refetch fails with cached data", async () => {
    const original = { type: "remote" as const, url: "https://old.example.com/mcp" }
    const cached = { type: "remote" as const, url: "https://old.example.com/mcp" }
    const draft = {
      ...draftFromConfig("docs", original),
      url: "https://draft.example.com/mcp",
      touched: { ...emptyMcpDraft().touched, url: true },
    }
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const key = ["scope", "/project", "mcp-config", "docs"]
    let fail = false
    const query = queryClient.getQueryCache().build(queryClient, {
      queryKey: key,
      queryFn: async () => {
        if (fail) throw new Error("reload failed")
        return { config: cached, source: "/project/opencode.jsonc", version: "1", writable: true }
      },
    })
    await query.fetch()
    fail = true
    const failed = await query.fetch().then(
      (data) => ({ data, isSuccess: true, isError: false, error: null }),
      (error: unknown) => ({
        data: query.state.data as { config: typeof cached } | undefined,
        isSuccess: false,
        isError: true,
        error,
      }),
    )
    expect(mcpReloadSucceeded(failed)).toBe(false)
    expect(failed.data?.config.url).toBe(cached.url)
    const stale = reconcileMcpReload({ original, latest: failed.data?.config, draft })
    expect(stale.fields).toEqual([])
    expect(canSaveMcp({ mode: "edit", state: "success", busy: false, conflict: { code: "MCP_VERSION_CONFLICT", fields: [] } })).toBe(false)
    expect(
      canSaveMcp({
        mode: "edit",
        state: mcpLoadState({ mode: "edit", pending: false, error: true, config: cached }),
        busy: false,
        writable: true,
        conflict: { code: "MCP_VERSION_CONFLICT", fields: ["url"] },
      }),
    ).toBe(false)
  })
})
