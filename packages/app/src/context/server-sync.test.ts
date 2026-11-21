import { describe, expect, test } from "bun:test"
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"
type McpListInput = Parameters<OpencodeClient["mcp"]["status"]>[0]
type McpResourceListInput = Parameters<OpencodeClient["experimental"]["resource"]["list"]>[0]
import { QueryClient } from "@tanstack/solid-query"
import { canDisposeDirectory, pickDirectoriesToEvict } from "./global-sync/eviction"
import { estimateRootSessionTotal, loadRootSessions } from "./global-sync/session-load"
import {
  loadActiveSessionsQuery,
  loadMcpQuery,
  loadMcpResourcesQuery,
  refreshActiveSessionData,
  refreshSessionTodos,
  sessionTodoRefreshID,
  createActiveSessionRefresh,
  createActiveStatusMerge,
  seedActiveSessionStatuses,
  syncActiveSessionStatuses,
} from "./server-sync"
import { ServerScope } from "@/utils/server-scope"
import { createServerSession } from "./server-session"
import type { ServerApi } from "@/utils/server"
import type { SessionInfo as AppSessionInfo } from "@/utils/protocol-types"

type McpApi = Pick<OpencodeClient, "mcp" | "experimental">
type SessionApi = ServerApi["sessions"]
type SessionListInput = Parameters<SessionApi["list"]>[0]
type SessionInfo = AppSessionInfo

describe("MCP queries", () => {
  test("loads current servers for the requested location", async () => {
    const calls: unknown[] = []
    const queryClient = new QueryClient()
    const result = await queryClient.fetchQuery(
      loadMcpQuery(ServerScope.local, "/project", {
        mcp: {
          status: async (input: McpListInput = {}) => {
            calls.push(input)
            return {
              data: { docs: { status: "connected" }, search: { status: "pending" } },
            }
          },
        },
      } as unknown as McpApi),
    )

    expect(calls).toEqual([{ directory: "/project" }])
    expect(result).toEqual({ docs: { status: "connected" }, search: { status: "pending" } })
  })

  test("loads and keys the current resource catalog", async () => {
    const calls: unknown[] = []
    const queryClient = new QueryClient()
    const result = await queryClient.fetchQuery(
      loadMcpResourcesQuery(ServerScope.local, "/project", {
        experimental: {
          resource: {
            list: async (input: McpResourceListInput = {}) => {
              calls.push(input)
              return {
                data: { "docs:docs://guide": { server: "docs", name: "Guide", uri: "docs://guide" } },
              }
            },
          },
        },
      } as unknown as McpApi),
    )

    expect(calls).toEqual([{ directory: "/project" }])
    expect(result).toEqual({ "docs:docs://guide": { server: "docs", name: "Guide", uri: "docs://guide" } })
  })
})

describe("active session query", () => {
  test("loads active sessions immediately and once per server cache", async () => {
    let calls = 0
    const queryClient = new QueryClient()
    const options = loadActiveSessionsQuery(ServerScope.local, {
      active: async () => {
        calls++
        return { ses_running: { type: "running" } }
      },
    })

    expect(await queryClient.fetchQuery(options)).toEqual({ ses_running: { type: "running" } })
    expect(await queryClient.fetchQuery(options)).toEqual({ ses_running: { type: "running" } })
    expect(calls).toBe(1)
    expect(options.enabled).toBe(true)
    expect([...options.queryKey]).toEqual([ServerScope.local, "activeSessions"])
  })

  test("does not overwrite statuses already written by events", () => {
    const session = createServerSession({} as OpencodeClient)
    session.set("session_status", "ses_retry", { type: "retry", attempt: 2, message: "retrying", next: 10 })
    const versions = createActiveStatusMerge(session).versions
    versions.note({ type: "session.status", properties: { sessionID: "ses_retry" } })
    const started = new Map([["ses_retry", versions.current("ses_retry") - 1]])

    seedActiveSessionStatuses(session, {
      ses_running: { type: "running" },
      ses_retry: { type: "running" },
    }, { started, current: versions })

    expect(session.data.session_status.ses_running).toEqual({ type: "busy" })
    expect(session.data.session_status.ses_retry).toEqual({
      type: "retry",
      attempt: 2,
      message: "retrying",
      next: 10,
    })
  })

  test("clears stale busy statuses when a reconnect snapshot reports no active sessions", () => {
    const session = createServerSession({} as OpencodeClient)
    const merge = createActiveStatusMerge(session)
    session.set("session_status", "ses_done", { type: "busy" })
    session.set("session_status", "ses_running", { type: "busy" })
    const first = merge.begin(Object.keys(session.data.session_status))

    expect(merge.finish({ ses_running: { type: "running" } }, first.started, first.generation)).toBe(true)
    expect(session.data.session_status.ses_done).toBeUndefined()
    expect(session.data.session_status.ses_running).toEqual({ type: "busy" })

    const second = merge.begin(Object.keys(session.data.session_status))
    expect(merge.finish({}, second.started, second.generation)).toBe(true)
    expect(session.data.session_status).toEqual({})
  })

  test("keeps an idle event that arrived while a busy snapshot was in flight", () => {
    const session = createServerSession({} as OpencodeClient)
    const merge = createActiveStatusMerge(session)
    session.set("session_status", "ses_running", { type: "busy" })
    const request = merge.begin(["ses_running"])
    merge.versions.note({ type: "session.status", properties: { sessionID: "ses_running", status: { type: "idle" } } })
    session.set("session_status", "ses_running", { type: "idle" })

    expect(merge.finish({ ses_running: { type: "running" } }, request.started, request.generation)).toBe(true)

    expect(session.data.session_status.ses_running).toEqual({ type: "idle" })
  })

  test("preserves a status event received while reconnecting", () => {
    const session = createServerSession({} as OpencodeClient)
    const merge = createActiveStatusMerge(session)
    session.set("session_status", "ses_running", { type: "busy" })
    const request = merge.begin(["ses_running"])
    merge.versions.note({ type: "session.status", properties: { sessionID: "ses_running" } })
    session.set("session_status", "ses_running", { type: "retry", attempt: 1, message: "retrying", next: 10 })

    expect(merge.finish({}, request.started, request.generation)).toBe(true)

    expect(session.data.session_status.ses_running).toEqual({
      type: "retry",
      attempt: 1,
      message: "retrying",
      next: 10,
    })
  })

  test("merges a snapshot only when no status event arrived while it was in flight", async () => {
    const session = createServerSession({} as OpencodeClient)
    const merge = createActiveStatusMerge(session)
    let release: (value: Record<string, { type: "running" }>) => void = () => undefined
    const pending = new Promise<Record<string, { type: "running" }>>((resolve) => {
      release = resolve
    })
    const request = merge.begin(["ses_running"])
    const loading = pending.then((active) => merge.finish(active, request.started, request.generation))
    merge.versions.note({
      current: { type: "session.next.step.ended", data: { sessionID: "ses_running" } },
    })
    session.set("session_status", "ses_running", { type: "idle" })
    release({ ses_running: { type: "running" } })

    expect(await loading).toBe(true)
    expect(session.data.session_status.ses_running).toEqual({ type: "idle" })
  })

  test("keeps the latest event when busy returns to busy during a snapshot", () => {
    const session = createServerSession({} as OpencodeClient)
    const merge = createActiveStatusMerge(session)
    session.set("session_status", "ses_running", { type: "busy" })
    const request = merge.begin(["ses_running"])
    merge.versions.note({ current: { type: "session.next.step.ended", data: { sessionID: "ses_running" } } })
    session.set("session_status", "ses_running", { type: "idle" })
    merge.versions.note({ current: { type: "session.next.step.started", data: { sessionID: "ses_running" } } })
    session.set("session_status", "ses_running", { type: "busy" })

    expect(merge.finish({ ses_running: { type: "running" } }, request.started, request.generation)).toBe(true)
    expect(merge.versions.current("ses_running")).toBe(2)
    expect(session.data.session_status.ses_running).toEqual({ type: "busy" })
  })

  test("drops an older reconnect snapshot after a newer request starts", () => {
    const session = createServerSession({} as OpencodeClient)
    const merge = createActiveStatusMerge(session)
    session.set("session_status", "ses_running", { type: "busy" })
    const older = merge.begin(["ses_running"])
    const newer = merge.begin(["ses_running"])

    expect(merge.finish({}, older.started, older.generation)).toBe(false)
    expect(session.data.session_status.ses_running).toEqual({ type: "busy" })
    expect(merge.finish({ ses_next: { type: "running" } }, newer.started, newer.generation)).toBe(true)
    expect(session.data.session_status.ses_running).toBeUndefined()
    expect(session.data.session_status.ses_next).toEqual({ type: "busy" })
  })

  test("loads the first snapshot through the query and merges it once", async () => {
    const session = createServerSession({} as OpencodeClient)
    const merge = createActiveStatusMerge(session)
    let release: (value: Record<string, { type: "running" }>) => void = () => undefined
    const pending = new Promise<Record<string, { type: "running" }>>((resolve) => {
      release = resolve
    })
    const queryClient = new QueryClient()
    const loading = queryClient.fetchQuery(
      loadActiveSessionsQuery(ServerScope.local, {
        active: async () => {
          merge.beginInitial(Object.keys(session.data.session_status))
          return pending
        },
      }),
    )
    merge.versions.note({ current: { type: "session.next.step.ended", data: { sessionID: "ses_live" } } })
    session.set("session_status", "ses_live", { type: "idle" })
    release({ ses_running: { type: "running" }, ses_live: { type: "running" } })
    const active = await loading

    expect(merge.initial(active)).toBe(true)
    expect(session.data.session_status.ses_running).toEqual({ type: "busy" })
    expect(session.data.session_status.ses_live).toEqual({ type: "idle" })
    expect(merge.initial(active)).toBe(false)
  })

  test("seeds the first snapshot and ignores a repeated initial merge", () => {
    const session = createServerSession({} as OpencodeClient)
    const merge = createActiveStatusMerge(session)

    expect(merge.beginInitial([])).toBeDefined()
    expect(merge.initial({ ses_running: { type: "running" } })).toBe(true)
    expect(session.data.session_status.ses_running).toEqual({ type: "busy" })
    session.set("session_status", "ses_running", { type: "idle" })
    expect(merge.initial({ ses_running: { type: "running" } })).toBe(false)
    expect(session.data.session_status.ses_running).toEqual({ type: "idle" })
  })

  test("keeps a first-load event that arrived after the request started", async () => {
    const session = createServerSession({} as OpencodeClient)
    const merge = createActiveStatusMerge(session)
    let release: (value: Record<string, { type: "running" }>) => void = () => undefined
    const pending = new Promise<Record<string, { type: "running" }>>((resolve) => {
      release = resolve
    })
    const request = merge.beginInitial(["ses_running"])
    const loading = pending.then((active) => merge.initial(active))
    merge.versions.note({ current: { type: "session.next.step.ended", data: { sessionID: "ses_running" } } })
    session.set("session_status", "ses_running", { type: "idle" })
    release({ ses_running: { type: "running" } })

    expect(request?.generation).toBe(0)
    expect(await loading).toBe(true)
    expect(session.data.session_status.ses_running).toEqual({ type: "idle" })
  })

  test("refreshes every active session after reconnect", async () => {
    const calls: Array<{ sessionID: string; options: { force?: boolean } | undefined }> = []
    await refreshActiveSessionData(
      {
        sync: async (sessionID, options) => {
          calls.push({ sessionID, options })
        },
      },
      {
        ses_running: { type: "running" },
        ses_retrying: { type: "running" },
      },
    )

    expect(calls).toEqual([
      { sessionID: "ses_running", options: { force: true } },
      { sessionID: "ses_retrying", options: { force: true } },
    ])
  })

  test("also refreshes sessions that were active before reconnect", async () => {
    const calls: string[] = []
    await refreshActiveSessionData(
      {
        sync: async (sessionID) => {
          calls.push(sessionID)
        },
      },
      {},
      {
        ses_finished: { type: "busy" },
        ses_idle: { type: "idle" },
      },
    )

    expect(calls).toEqual(["ses_finished"])
  })

  test("reconciles an ended session against the follow-up request baseline", async () => {
    const session = createServerSession({} as OpencodeClient)
    const merge = createActiveStatusMerge(session)
    session.set("session_status", "ses_running", { type: "busy" })
    let release: (value: Record<string, { type: "running" }>) => void = () => undefined
    const pending = new Promise<Record<string, { type: "running" }>>((resolve) => {
      release = resolve
    })
    let calls = 0
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const refresh = createActiveSessionRefresh({
      scope: String(ServerScope.local),
      queryClient,
      load: () => {
        calls += 1
        return calls === 1 ? pending : Promise.resolve({})
      },
      known: () => Object.keys(session.data.session_status),
      statuses: () => ({ ...session.data.session_status }),
      begin: (known) => merge.begin(known),
      finish: (active, started, generation) => merge.finish(active, started, generation),
      apply: () => undefined,
    })
    const first = refresh.refresh()
    merge.versions.note({ type: "session.status", properties: { sessionID: "ses_running", status: { type: "idle" } } })
    session.set("session_status", "ses_running", { type: "idle" })
    const second = refresh.refresh()
    release({ ses_running: { type: "running" } })

    await Promise.all([first, second])
    expect(calls).toBe(2)
    expect(session.data.session_status.ses_running).toBeUndefined()
  })

  test("does not apply a reconnect baseline to an unfinished first load", async () => {
    const session = createServerSession({} as OpencodeClient)
    const merge = createActiveStatusMerge(session)
    let release: (value: Record<string, { type: "running" }>) => void = () => undefined
    const pending = new Promise<Record<string, { type: "running" }>>((resolve) => {
      release = resolve
    })
    let calls = 0
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const loading = queryClient.fetchQuery(
      loadActiveSessionsQuery(ServerScope.local, {
        active: async () => {
          merge.beginInitial(["ses_running"])
          calls += 1
          return pending
        },
      }),
    )
    const refresh = createActiveSessionRefresh({
      scope: String(ServerScope.local),
      queryClient,
      load: async () => {
        calls += 1
        return {}
      },
      known: () => ["ses_running"],
      statuses: () => ({ ...session.data.session_status }),
      begin: (known) => merge.begin(known),
      finish: (active, started, generation) => merge.finish(active, started, generation),
      apply: () => undefined,
    })
    const reconnect = refresh.refresh()
    merge.versions.note({ current: { type: "session.next.step.ended", data: { sessionID: "ses_running" } } })
    session.set("session_status", "ses_running", { type: "idle" })
    release({ ses_running: { type: "running" } })

    expect(merge.initial(await loading)).toBe(true)
    expect(await reconnect).toBe(true)
    expect(calls).toBe(2)
    expect(session.data.session_status.ses_running).toEqual({ type: "idle" })
  })

  test("keeps a live busy status when the reused snapshot omits that session", async () => {
    const session = createServerSession({} as OpencodeClient)
    const merge = createActiveStatusMerge(session)
    let release: (value: Record<string, never>) => void = () => undefined
    const pending = new Promise<Record<string, never>>((resolve) => {
      release = resolve
    })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const refresh = createActiveSessionRefresh({
      scope: String(ServerScope.local),
      queryClient,
      load: () => pending,
      known: () => [],
      statuses: () => ({ ...session.data.session_status }),
      begin: (known) => merge.begin(known),
      finish: (active, started, generation) => merge.finish(active, started, generation),
      apply: () => undefined,
    })
    const request = refresh.refresh()
    merge.versions.note({ type: "session.status", properties: { sessionID: "ses_live" } })
    session.set("session_status", "ses_live", { type: "busy" })
    release({})

    expect(await request).toBe(true)
    expect(session.data.session_status.ses_live).toEqual({ type: "busy" })
  })

  test("coalesces repeated reconnects and still runs the newest request", async () => {
    const session = createServerSession({} as OpencodeClient)
    const merge = createActiveStatusMerge(session)
    let release: (value: Record<string, { type: "running" }>) => void = () => undefined
    const pending = new Promise<Record<string, { type: "running" }>>((resolve) => {
      release = resolve
    })
    let calls = 0
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const refresh = createActiveSessionRefresh({
      scope: String(ServerScope.local),
      queryClient,
      load: () => {
        calls += 1
        return calls === 1 ? pending : Promise.resolve({ ses_next: { type: "running" } })
      },
      known: () => Object.keys(session.data.session_status),
      statuses: () => ({ ...session.data.session_status }),
      begin: (known) => merge.begin(known),
      finish: (active, started, generation) => merge.finish(active, started, generation),
      apply: () => undefined,
    })
    const first = refresh.refresh()
    const second = refresh.refresh()
    const third = refresh.refresh()
    release({ ses_old: { type: "running" } })

    expect(await Promise.all([first, second, third])).toEqual([true, true, true])
    expect(calls).toBe(2)
    expect(session.data.session_status.ses_next).toEqual({ type: "busy" })
    expect(session.data.session_status.ses_old).toBeUndefined()
  })

  test("keeps a follow-up requested while the follow-up itself is running", async () => {
    const merge = createActiveStatusMerge(createServerSession({} as OpencodeClient))
    let releaseFirst: (value: Record<string, never>) => void = () => undefined
    let releaseSecond: (value: Record<string, never>) => void = () => undefined
    const firstPending = new Promise<Record<string, never>>((resolve) => {
      releaseFirst = resolve
    })
    const secondPending = new Promise<Record<string, never>>((resolve) => {
      releaseSecond = resolve
    })
    let calls = 0
    let startedSecond: () => void = () => undefined
    const secondStarted = new Promise<void>((resolve) => {
      startedSecond = resolve
    })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const refresh = createActiveSessionRefresh({
      scope: String(ServerScope.local),
      queryClient,
      load: () => {
        calls += 1
        if (calls === 1) return firstPending
        if (calls === 2) {
          startedSecond()
          return secondPending
        }
        return Promise.resolve({})
      },
      known: () => [],
      statuses: () => ({}),
      begin: (known) => merge.begin(known),
      finish: () => true,
      apply: () => undefined,
    })
    const first = refresh.refresh()
    const duringFirst = refresh.refresh()
    releaseFirst({})
    await secondStarted
    const duringSecond = refresh.refresh()
    releaseSecond({})

    expect(await Promise.all([first, duringFirst, duringSecond])).toEqual([true, true, true])
    expect(calls).toBe(3)
  })

  test("recovers after a failed active-session request", async () => {
    const session = createServerSession({} as OpencodeClient)
    const merge = createActiveStatusMerge(session)
    let fail = true
    let calls = 0
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const refresh = createActiveSessionRefresh({
      scope: String(ServerScope.local),
      queryClient,
      load: () => {
        calls += 1
        if (fail) return Promise.reject(new Error("offline"))
        return Promise.resolve({ ses_next: { type: "running" } })
      },
      known: () => [],
      statuses: () => ({ ...session.data.session_status }),
      begin: (known) => merge.begin(known),
      finish: (active, started, generation) => merge.finish(active, started, generation),
      apply: () => undefined,
    })

    expect(await refresh.refresh()).toBe(false)
    fail = false
    expect(await refresh.refresh()).toBe(true)
    expect(calls).toBe(2)
    expect(session.data.session_status.ses_next).toEqual({ type: "busy" })
  })

  test("ignores a cached snapshot from another server scope", async () => {
    const session = createServerSession({} as OpencodeClient)
    const merge = createActiveStatusMerge(session)
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await queryClient.fetchQuery({
      queryKey: [String(ServerScope.local), "activeSessions"],
      queryFn: async () => ({ ses_old: { type: "running" } }),
    })
    const refresh = createActiveSessionRefresh({
      scope: "server-b",
      queryClient,
      load: async () => ({ ses_next: { type: "running" } }),
      known: () => [],
      statuses: () => ({}),
      begin: (known) => merge.begin(known),
      finish: (active, started, generation) => merge.finish(active, started, generation),
      apply: () => undefined,
    })

    expect(await refresh.refresh()).toBe(true)
    expect(session.data.session_status).toEqual({ ses_next: { type: "busy" } })
    refresh.dispose()
    session.set("session_status", "ses_next", { type: "idle" })
    expect(await refresh.refresh()).toBe(false)
    expect(session.data.session_status.ses_next).toEqual({ type: "idle" })
  })

  test("refreshes a session that finished while disconnected through the reconnect entry", async () => {
    const session = createServerSession({} as OpencodeClient)
    const merge = createActiveStatusMerge(session)
    session.set("session_status", "ses_finished", { type: "busy" })
    const calls: Array<{ kind: "message" | "todo"; sessionID: string }> = []
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const refresh = createActiveSessionRefresh({
      scope: String(ServerScope.local),
      queryClient,
      load: async () => ({}),
      known: () => Object.keys(session.data.session_status),
      statuses: () => ({ ...session.data.session_status }),
      begin: (known) => merge.begin(known),
      finish: (active, started, generation) => merge.finish(active, started, generation),
      apply: (active, before) =>
        refreshActiveSessionData(
          {
            sync: async (sessionID) => {
              calls.push({ kind: "message", sessionID })
            },
            todo: async (sessionID) => {
              calls.push({ kind: "todo", sessionID })
            },
          },
          active,
          before,
        ),
    })

    expect(await refresh.refresh()).toBe(true)
    expect(calls).toEqual([
      { kind: "message", sessionID: "ses_finished" },
      { kind: "todo", sessionID: "ses_finished" },
    ])
  })

  test("keeps an earlier finished session when reconnect requests coalesce", async () => {
    const session = createServerSession({} as OpencodeClient)
    const merge = createActiveStatusMerge(session)
    session.set("session_status", "ses_early", { type: "busy" })
    let release: (value: Record<string, never>) => void = () => undefined
    const pending = new Promise<Record<string, never>>((resolve) => {
      release = resolve
    })
    let calls = 0
    const refreshed: string[] = []
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const refresh = createActiveSessionRefresh({
      scope: String(ServerScope.local),
      queryClient,
      load: () => {
        calls += 1
        return calls === 1 ? pending : Promise.resolve({})
      },
      known: () => Object.keys(session.data.session_status),
      statuses: () => ({ ...session.data.session_status }),
      begin: (known) => merge.begin(known),
      finish: (active, started, generation) => merge.finish(active, started, generation),
      apply: (active, before) =>
        refreshActiveSessionData(
          {
            sync: async (sessionID) => {
              refreshed.push(sessionID)
            },
          },
          active,
          before,
        ),
    })
    const first = refresh.refresh()
    session.set("session_status", "ses_early", { type: "idle" })
    session.set("session_status", "ses_late", { type: "busy" })
    const second = refresh.refresh()
    release({})

    expect(await Promise.all([first, second])).toEqual([true, true])
    expect(calls).toBe(2)
    expect(refreshed).toEqual(["ses_early", "ses_late", "ses_early", "ses_late"])
  })

  test("continues other session refreshes when one refresh fails", async () => {
    const result = await refreshActiveSessionData(
      {
        sync: async (sessionID) => {
          if (sessionID === "ses_failed") throw new Error("sync failed")
        },
        todo: async (sessionID) => {
          if (sessionID === "ses_failed") throw new Error("todo failed")
        },
      },
      { ses_ok: { type: "running" } },
      { ses_failed: { type: "busy" } },
    )

    expect(result.refreshed).toEqual(["ses_ok", "ses_failed"])
    expect([...result.failed]).toEqual(["ses_failed"])
  })

  test("captures a new status baseline for each follow-up network request", async () => {
    const session = createServerSession({} as OpencodeClient)
    const merge = createActiveStatusMerge(session)
    session.set("session_status", "ses_running", { type: "busy" })
    let releaseFirst: (value: Record<string, { type: "running" }>) => void = () => undefined
    const firstPending = new Promise<Record<string, { type: "running" }>>((resolve) => {
      releaseFirst = resolve
    })
    let calls = 0
    const baselines: number[] = []
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const refresh = createActiveSessionRefresh({
      scope: String(ServerScope.local),
      queryClient,
      load: () => {
        calls += 1
        baselines.push(merge.versions.current("ses_running"))
        return calls === 1 ? firstPending : Promise.resolve({})
      },
      known: () => Object.keys(session.data.session_status),
      statuses: () => ({ ...session.data.session_status }),
      begin: (known) => merge.begin(known),
      finish: (active, started, generation) => merge.finish(active, started, generation),
      apply: () => undefined,
    })
    const first = refresh.refresh()
    const second = refresh.refresh()
    merge.versions.note({ type: "session.status", properties: { sessionID: "ses_running", status: { type: "busy" } } })
    session.set("session_status", "ses_running", { type: "busy" })
    releaseFirst({ ses_running: { type: "running" } })

    expect(await Promise.all([first, second])).toEqual([true, true])
    expect(calls).toBe(2)
    expect(baselines).toEqual([0, 1])
    expect(session.data.session_status.ses_running).toBeUndefined()
  })

  test("retries a failed message refresh after the session has ended", async () => {
    const session = createServerSession({} as OpencodeClient)
    const merge = createActiveStatusMerge(session)
    session.set("session_status", "ses_failed", { type: "busy" })
    let fail = true
    let calls = 0
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const refresh = createActiveSessionRefresh({
      scope: String(ServerScope.local),
      queryClient,
      load: async () => ({}),
      known: () => Object.keys(session.data.session_status),
      statuses: () => ({ ...session.data.session_status }),
      begin: (known) => merge.begin(known),
      finish: (active, started, generation) => merge.finish(active, started, generation),
      apply: (active, before) =>
        refreshActiveSessionData(
          {
            sync: async () => {
              calls += 1
              if (fail) throw new Error("sync failed")
            },
          },
          active,
          before,
        ),
    })

    expect(await refresh.refresh()).toBe(true)
    fail = false
    session.set("session_status", "ses_failed", { type: "idle" })
    expect(await refresh.refresh()).toBe(true)
    expect(calls).toBe(2)
  })

  test("retries when the whole content refresh rejects after the session has ended", async () => {
    const session = createServerSession({} as OpencodeClient)
    const merge = createActiveStatusMerge(session)
    session.set("session_status", "ses_failed", { type: "busy" })
    let fail = true
    let calls = 0
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const refresh = createActiveSessionRefresh({
      scope: String(ServerScope.local),
      queryClient,
      load: async () => ({}),
      known: () => Object.keys(session.data.session_status),
      statuses: () => ({ ...session.data.session_status }),
      begin: (known) => merge.begin(known),
      finish: (active, started, generation) => merge.finish(active, started, generation),
      apply: async () => {
        calls += 1
        if (fail) throw new Error("refresh failed")
      },
    })

    expect(await refresh.refresh()).toBe(true)
    fail = false
    session.set("session_status", "ses_failed", { type: "idle" })
    expect(await refresh.refresh()).toBe(true)
    expect(calls).toBe(2)
  })

  test("refreshes the same session again when a later reconnect snapshot shows it ended", async () => {
    const session = createServerSession({} as OpencodeClient)
    const merge = createActiveStatusMerge(session)
    session.set("session_status", "ses_running", { type: "busy" })
    let releaseFirst: (value: Record<string, { type: "running" }>) => void = () => undefined
    const firstPending = new Promise<Record<string, { type: "running" }>>((resolve) => {
      releaseFirst = resolve
    })
    let calls = 0
    const refreshed: string[] = []
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const refresh = createActiveSessionRefresh({
      scope: String(ServerScope.local),
      queryClient,
      load: () => {
        calls += 1
        return calls === 1 ? firstPending : Promise.resolve({})
      },
      known: () => Object.keys(session.data.session_status),
      statuses: () => ({ ...session.data.session_status }),
      begin: (known) => merge.begin(known),
      finish: (active, started, generation) => merge.finish(active, started, generation),
      apply: (active, before) =>
        refreshActiveSessionData(
          {
            sync: async (sessionID) => {
              refreshed.push(sessionID)
            },
          },
          active,
          before,
        ),
    })
    const first = refresh.refresh()
    const second = refresh.refresh()
    releaseFirst({ ses_running: { type: "running" } })

    expect(await Promise.all([first, second])).toEqual([true, true])
    expect(calls).toBe(2)
    expect(refreshed).toEqual(["ses_running", "ses_running"])
  })

  test("issues another query when a reconnect arrives while content refresh is running", async () => {
    const session = createServerSession({} as OpencodeClient)
    const merge = createActiveStatusMerge(session)
    let releaseApply: () => void = () => undefined
    const applying = new Promise<void>((resolve) => {
      releaseApply = resolve
    })
    let calls = 0
    let startedApply: () => void = () => undefined
    const applyStarted = new Promise<void>((resolve) => {
      startedApply = resolve
    })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const refresh = createActiveSessionRefresh({
      scope: String(ServerScope.local),
      queryClient,
      load: async () => {
        calls += 1
        return {}
      },
      known: () => [],
      statuses: () => ({ ...session.data.session_status }),
      begin: (known) => merge.begin(known),
      finish: (active, started, generation) => merge.finish(active, started, generation),
      apply: () => {
        startedApply()
        return applying.then(() => undefined)
      },
    })
    const first = refresh.refresh()
    await applyStarted
    const second = refresh.refresh()
    releaseApply()

    expect(await Promise.all([first, second])).toEqual([true, true])
    expect(calls).toBe(2)
  })

  test("retries a newly discovered session after its refresh fails and it becomes idle", async () => {
    const session = createServerSession({} as OpencodeClient)
    const merge = createActiveStatusMerge(session)
    let fail = true
    let calls = 0
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const refresh = createActiveSessionRefresh({
      scope: String(ServerScope.local),
      queryClient,
      load: async (): Promise<Record<string, { type: "running" }>> =>
        fail ? { ses_new: { type: "running" } } : {},
      known: () => [],
      statuses: () => ({ ...session.data.session_status }),
      begin: (known) => merge.begin(known),
      finish: (active, started, generation) => merge.finish(active, started, generation),
      apply: (active, before) =>
        refreshActiveSessionData(
          {
            sync: async () => {
              calls += 1
              if (fail) throw new Error("sync failed")
            },
          },
          active,
          before,
        ),
    })

    expect(await refresh.refresh()).toBe(true)
    fail = false
    session.set("session_status", "ses_new", { type: "idle" })
    expect(await refresh.refresh()).toBe(true)
    expect(calls).toBe(2)
  })
})

describe("todo refresh events", () => {
  test("refreshes todos when a legacy session becomes idle", () => {
    expect(
      sessionTodoRefreshID({
        type: "session.status",
        properties: { sessionID: "ses_1", status: { type: "idle" } },
      }),
    ).toBe("ses_1")
  })

  test("refreshes todos when a V2 step ends", () => {
    expect(
      sessionTodoRefreshID({
        type: "session.step.ended",
        current: { type: "session.step.ended", data: { sessionID: "ses_2" } },
      }),
    ).toBe("ses_2")
  })

  test("does not refresh todos for unrelated events", () => {
    expect(sessionTodoRefreshID({ type: "session.status", properties: { sessionID: "ses_3", status: { type: "busy" } } })).toBeUndefined()
    expect(sessionTodoRefreshID({ type: "message.updated", properties: { sessionID: "ses_3" } })).toBeUndefined()
  })

  test("forces a todo reload after a completed step", async () => {
    const calls: Array<{ sessionID: string; options: { force?: boolean } | undefined }> = []
    await refreshSessionTodos(
      {
        todo: async (sessionID, options) => {
          calls.push({ sessionID, options })
        },
      },
      {
        type: "session.next.step.ended",
        current: { type: "session.next.step.ended", data: { sessionID: "ses_4" } },
      },
    )

    expect(calls).toEqual([{ sessionID: "ses_4", options: { force: true } }])
  })
})

describe("pickDirectoriesToEvict", () => {
  test("keeps pinned stores and evicts idle stores", () => {
    const now = 5_000
    const picks = pickDirectoriesToEvict({
      stores: ["a", "b", "c", "d"],
      state: new Map([
        ["a", { lastAccessAt: 1_000 }],
        ["b", { lastAccessAt: 4_900 }],
        ["c", { lastAccessAt: 4_800 }],
        ["d", { lastAccessAt: 3_000 }],
      ]),
      pins: new Set(["a"]),
      max: 2,
      ttl: 1_500,
      now,
    })

    expect(picks).toEqual(["d", "c"])
  })
})

describe("loadRootSessions", () => {
  test("loads and normalizes a limited page of root sessions", async () => {
    const calls: SessionListInput[] = []

    const result = await loadRootSessions({
      api: {
        list: async (query = {}) => {
          calls.push(query)
          return { data: [sessionInfo("session-1")], cursor: {} }
        },
      } as unknown as Pick<SessionApi, "list">,
      directory: "dir",
      limit: 10,
    })

    expect(result.data).toEqual([
      expect.objectContaining({ id: "session-1", directory: "dir", slug: "session-1", version: "" }),
    ])
    expect(result.limited).toBe(true)
    expect(calls).toEqual([{ directory: "dir", limit: 10, order: "desc" }])
  })

  test("propagates list failures", () => {
    expect(
      loadRootSessions({
        api: {
          list: async () => {
            throw new Error("failed")
          },
        } as unknown as Pick<SessionApi, "list">,
        directory: "dir",
        limit: 25,
      }),
    ).rejects.toThrow("failed")
  })
})

function sessionInfo(id: string) {
  return {
    id,
    projectID: "project-1",
    agent: "build",
    model: { id: "model-1", providerID: "provider-1" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
    title: id,
    location: { directory: "dir" },
  } as SessionInfo
}

describe("estimateRootSessionTotal", () => {
  test("keeps exact total for full fetches", () => {
    expect(estimateRootSessionTotal({ count: 42, limit: 10, limited: false })).toBe(42)
  })

  test("marks has-more for full-limit limited fetches", () => {
    expect(estimateRootSessionTotal({ count: 10, limit: 10, limited: true })).toBe(11)
  })

  test("keeps exact total when limited fetch is under limit", () => {
    expect(estimateRootSessionTotal({ count: 9, limit: 10, limited: true })).toBe(9)
  })
})

describe("canDisposeDirectory", () => {
  test("rejects pinned or inflight directories", () => {
    expect(
      canDisposeDirectory({
        directory: "dir",
        hasStore: true,
        pinned: true,
        booting: false,
        loadingSessions: false,
      }),
    ).toBe(false)
    expect(
      canDisposeDirectory({
        directory: "dir",
        hasStore: true,
        pinned: false,
        booting: true,
        loadingSessions: false,
      }),
    ).toBe(false)
    expect(
      canDisposeDirectory({
        directory: "dir",
        hasStore: true,
        pinned: false,
        booting: false,
        loadingSessions: true,
      }),
    ).toBe(false)
  })

  test("accepts idle unpinned directory store", () => {
    expect(
      canDisposeDirectory({
        directory: "dir",
        hasStore: true,
        pinned: false,
        booting: false,
        loadingSessions: false,
      }),
    ).toBe(true)
  })
})
