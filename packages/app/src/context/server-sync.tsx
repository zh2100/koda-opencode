import type {
  Config,
  OpencodeClient,
  Path,
  Project,
  ProviderAuthResponse,
  SessionStatus,
} from "@opencode-ai/sdk/v2/client"
import { showToast } from "@/utils/toast"
import { getFilename } from "@opencode-ai/core/util/path"
import {
  type Accessor,
  batch,
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  getOwner,
  onCleanup,
  onMount,
  untrack,
} from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { useLanguage } from "@/context/language"
import type { InitError } from "../pages/error"
import { ServerSDK } from "./server-sdk"
import {
  bootstrapDirectory,
  bootstrapGlobal,
  clearProviderRev,
  disposePromptScope,
  loadAgentsQuery,
  loadCommands,
  loadGlobalConfigQuery,
  loadPathQuery,
  loadProjectsQuery,
  loadProvidersQuery,
  loadReferencesQuery,
} from "./global-sync/bootstrap"
import { createChildStoreManager } from "./global-sync/child-store"
import { applyDirectoryEvent, applyGlobalEvent } from "./global-sync/event-reducer"
import { estimateRootSessionTotal, loadRootSessions, loadRootSessionsV1 } from "./global-sync/session-load"
import { trimSessions } from "./global-sync/session-trim"
import type { ProjectMeta } from "./global-sync/types"
import type { McpResource, McpServer } from "./global-sync/types"
import { SESSION_RECENT_LIMIT } from "./global-sync/types"
import { formatServerError } from "@/utils/server-errors"
import { queryOptions, useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/solid-query"
import type { SolidQueryOptions } from "@tanstack/solid-query"
import { bindRefreshResume, createRefreshQueue } from "./global-sync/queue"
import { directoryKey } from "./global-sync/utils"
import { PathKey } from "@/utils/path-key"
import { createDirSyncContext } from "./directory-sync"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { NormalizedProviderListResponse } from "@opencode-ai/session-ui/context"
import { createRefCountMap } from "@/utils/refcount"
import { useGlobal } from "./global"
import { ServerConnection, useServer } from "./server"
import { retry } from "@opencode-ai/core/util/retry"
import type { ServerScope } from "@/utils/server-scope"
import { createHomeSessionIndexCache } from "./global-sync/home-session-index"
import { persisted } from "@/utils/persist"
import type { ServerApi } from "@/utils/server"
import type { SessionsActiveOutput, SkillsListOutput } from "@opencode-ai/client"
import { toggleMcp } from "./global-sync/mcp"
import { createServerSession, type ServerSession } from "./server-session"
import { createStreamRecovery } from "./server-stream-recovery"

type GlobalStore = {
  ready: boolean
  error?: InitError
  path: Path
  project: Project[]
  provider: NormalizedProviderListResponse
  provider_auth: ProviderAuthResponse
  config: Config
  reload: undefined | "pending" | "complete"
}

type McpListApi = Pick<OpencodeClient, "mcp">

type McpResourceApi = Pick<OpencodeClient, "experimental">

type ApiQueryOptions<T, K extends readonly unknown[]> = SolidQueryOptions<T, Error, T, K> & {
  initialData?: undefined
  queryKey: K
}

type SessionActiveApi = { readonly active: () => Promise<SessionsActiveOutput> }

type SkillsApi = { readonly list: (input?: { location?: { directory?: string } }) => Promise<SkillsListOutput> }

export const loadMcpQuery = (
  scope: ServerScope,
  directory: string,
  api: McpListApi,
  legacy?: OpencodeClient,
  protocol?: Promise<"v1" | "v2">,
): ApiQueryOptions<Record<string, McpServer>, readonly [ServerScope, string, "mcp"]> =>
  queryOptions<Record<string, McpServer>, Error, Record<string, McpServer>, readonly [ServerScope, string, "mcp"]>({
    queryKey: [scope, directory, "mcp"] as const,
    queryFn: async () => {
      if ((await protocol) === "v1" && legacy) {
        return Object.fromEntries(
          Object.entries((await legacy.mcp.status()).data ?? {}).map(([name, status]) => [
            name,
            typeof status === "string" ? { status } : status,
          ]),
        ) as Record<string, McpServer>
      }
      const result = await api.mcp.status({ directory })
      return Object.fromEntries(Object.entries(result.data ?? {}).map(([name, status]) => [name, status])) as Record<
        string,
        McpServer
      >
    },
  })

export const loadMcpResourcesQuery = (
  scope: ServerScope,
  directory: string,
  api: McpResourceApi,
  legacy?: OpencodeClient,
  protocol?: Promise<"v1" | "v2">,
): ApiQueryOptions<Record<string, McpResource>, readonly [ServerScope, string, "mcpResources"]> =>
  queryOptions<
    Record<string, McpResource>,
    Error,
    Record<string, McpResource>,
    readonly [ServerScope, string, "mcpResources"]
  >({
    queryKey: [scope, directory, "mcpResources"] as const,
    queryFn: async () => {
      if ((await protocol) === "v1" && legacy) {
        return Object.fromEntries(
          Object.entries((await legacy.experimental.resource.list()).data ?? {}).map(([key, resource]) => [
            key,
            { ...resource, server: resource.client },
          ]),
        )
      }
      return api.experimental.resource.list({ directory }).then((result) => {
        if (!result.data) return {}
        if (!Array.isArray(result.data)) return result.data
        return Object.fromEntries(
          result.data.map((resource: McpResource) => [`${resource.server}:${resource.uri}`, resource]),
        )
      })
    },
    placeholderData: {},
  })

export const loadLspQuery = (scope: ServerScope, directory: string, sdk: OpencodeClient) =>
  queryOptions({
    queryKey: [scope, directory, "lsp"] as const,
    queryFn: () => sdk.lsp.status().then((r) => r.data ?? []),
  })

export const loadSkillsQuery = (
  scope: ServerScope,
  directory: string,
  api: SkillsApi,
): ApiQueryOptions<SkillsListOutput["data"], readonly [ServerScope, string, "skills"]> =>
  queryOptions<SkillsListOutput["data"], Error, SkillsListOutput["data"], readonly [ServerScope, string, "skills"]>({
    queryKey: [scope, directory, "skills"] as const,
    queryFn: () => api.list({ location: { directory } }).then((result) => result.data),
    staleTime: 60_000,
  })

export const loadActiveSessionsQuery = (
  scope: ServerScope,
  api: SessionActiveApi,
): ApiQueryOptions<SessionsActiveOutput, readonly [ServerScope, "activeSessions"]> =>
  queryOptions<SessionsActiveOutput, Error, SessionsActiveOutput, readonly [ServerScope, "activeSessions"]>({
    queryKey: [scope, "activeSessions"] as const,
    queryFn: () => api.active(),
    enabled: true,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  })

export type ActiveSessionSnapshot = {
  readonly active: SessionsActiveOutput
  readonly started: ReadonlyMap<string, number>
  readonly generation: number
  readonly scope: string
  readonly before: Record<string, SessionStatus | undefined>
}

type ActiveSessionQueryClient = {
  fetchQuery: (options: {
    queryKey: readonly unknown[]
    queryFn: () => Promise<SessionsActiveOutput>
    staleTime: number
  }) => Promise<SessionsActiveOutput>
  getQueryData?: (queryKey: readonly unknown[]) => SessionsActiveOutput | undefined
  removeQueries?: (filters: { queryKey: readonly unknown[] }) => void
}

const activeSessionsKey = (scope: string) => [scope, "activeSessions"] as const

const copyStatus = (status: SessionStatus | undefined) => (status ? { ...status } : undefined)

export function createActiveSessionRefresh(input: {
  scope: string
  queryClient: ActiveSessionQueryClient
  load: () => Promise<SessionsActiveOutput>
  known: () => Iterable<string>
  statuses: () => Record<string, SessionStatus | undefined>
  begin: (known: Iterable<string>) => { readonly generation: number; readonly started: ReadonlyMap<string, number> }
  finish: (active: SessionsActiveOutput, started: ReadonlyMap<string, number>, generation: number) => boolean
  apply: (
    active: SessionsActiveOutput,
    before: Record<string, SessionStatus | undefined>,
  ) => void | Promise<void | { refreshed: readonly string[]; failed: ReadonlySet<string> }>
}) {
  let tail = Promise.resolve(false)
  let running = false
  let queued = false
  let carried: Record<string, SessionStatus | undefined> = {}
  let retry = new Set<string>()
  let disposed = false
  const nonIdle = (statuses: Record<string, SessionStatus | undefined>) =>
    Object.fromEntries(Object.entries(statuses).filter(([, status]) => status !== undefined && status.type !== "idle"))
  const remember = (before: Record<string, SessionStatus | undefined>) => {
    carried = nonIdle({ ...carried, ...before })
  }
  const retryable = () => ({ type: "busy" as const })
  const capture = () => {
    const statuses = input.statuses()
    const known = new Set([...input.known(), ...Object.keys(statuses), ...Object.keys(carried), ...retry])
    const before = { ...carried }
    for (const sessionID of retry) before[sessionID] ??= retryable()
    for (const sessionID of known) {
      const current = copyStatus(statuses[sessionID])
      const previous = before[sessionID]
      before[sessionID] = previous && previous.type !== "idle" ? previous : current
    }
    remember(before)
    return { known: [...known], before }
  }
  const key = activeSessionsKey(input.scope)
  let before: Record<string, SessionStatus | undefined> = {}
  let flight:
    | {
        promise: Promise<SessionsActiveOutput>
        started: { readonly generation: number; readonly started: ReadonlyMap<string, number> }
      }
    | undefined
  let producer: Promise<boolean> | undefined
  const loadFresh = () => {
    const current = flight
    if (current) return { ...current, owned: false as const }
    const captured = capture()
    before = { ...before, ...captured.before }
    const started = input.begin(captured.known)
    const promise = input.load()
    flight = { promise, started }
    return { promise, owned: true as const, started }
  }
  const read = async () => {
    const loaded = loadFresh()
    if (!loaded.owned) return undefined
    const seen = new Set<string>()
    try {
      await input.queryClient.fetchQuery({
        queryKey: [...key, loaded.started.generation],
        queryFn: () => loaded.promise,
        staleTime: 0,
      })
      const active = await loaded.promise
      if (flight?.promise === loaded.promise) flight = undefined
      if (disposed) return undefined
      return { active, started: loaded.started, seen }
    } catch {
      if (flight?.promise === loaded.promise) flight = undefined
      return undefined
    }
  }
  const settle = async (
    request: NonNullable<Awaited<ReturnType<typeof read>>>,
    pendingBefore: Record<string, SessionStatus | undefined>,
  ) => {
    if (disposed) return false
    const applied = input.finish(request.active, request.started.started, request.started.generation)
    if (!applied) return false
    const freshBefore = Object.fromEntries(
      Object.entries(pendingBefore).filter(([sessionID]) => !request.seen.has(sessionID)),
    )
    const freshActive = Object.fromEntries(
      Object.entries(request.active).filter(([sessionID]) => !request.seen.has(sessionID)),
    )
    for (const sessionID of [...Object.keys(freshActive), ...Object.keys(freshBefore)]) request.seen.add(sessionID)
    const result = await Promise.resolve(input.apply(freshActive, freshBefore)).catch(() => ({
      refreshed: [] as readonly string[],
      failed: new Set([...Object.keys(freshActive), ...Object.keys(freshBefore)]),
    }))
    const failed =
      result && typeof result === "object" && result.failed instanceof Set ? result.failed : new Set<string>()
    const attempted = new Set([...Object.keys(freshActive), ...Object.keys(freshBefore)])
    const succeeded = [...attempted].filter((sessionID) => !failed.has(sessionID))
    for (const sessionID of succeeded) retry.delete(sessionID)
    for (const sessionID of failed) {
      if (attempted.has(sessionID)) retry.add(sessionID)
    }
    carried = nonIdle(
      Object.fromEntries(Object.entries(carried).filter(([sessionID]) => !succeeded.includes(sessionID))),
    )
    return true
  }
  const drain = async (): Promise<boolean> => {
    const request = await read()
    if (disposed) {
      running = false
      return false
    }
    const follow = queued
    queued = false
    const applied = request ? await settle(request, { ...carried, ...before }) : false
    if (disposed) {
      running = false
      return false
    }
    if (!follow && !queued) {
      running = false
      return applied
    }
    queued = false
    const settled = await drain()
    if (disposed) return settled
    if (queued) {
      queued = false
      return drain()
    }
    running = false
    return settled
  }
  return {
    refresh() {
      if (disposed) return Promise.resolve(false)
      const captured = capture()
      if (running) {
        queued = true
        before = { ...before, ...captured.before }
        return producer ?? tail
      }
      running = true
      queued = false
      before = captured.before
      const request = drain()
      producer = request
      tail = request
        .catch(() => false)
        .finally(() => {
          if (producer === request) producer = undefined
        })
      return request
    },
    dispose() {
      disposed = true
      queued = false
    },
  }
}

export type SessionStatusVersions = {
  readonly current: (sessionID: string) => number
  readonly note: (event: { type?: string; properties?: unknown; current?: { type?: string; data?: unknown } }) => void
}

export function createSessionStatusVersions(): SessionStatusVersions {
  const versions = new Map<string, number>()
  const note = (sessionID: string | undefined) => {
    if (!sessionID) return
    versions.set(sessionID, (versions.get(sessionID) ?? 0) + 1)
  }
  return {
    current: (sessionID) => versions.get(sessionID) ?? 0,
    note: (event) => {
      if (event.type === "session.status") {
        note((event.properties as { sessionID?: string } | undefined)?.sessionID)
      }
      const current = event.current
      const sessionID =
        current?.data && typeof current.data === "object" && "sessionID" in current.data
          ? current.data.sessionID
          : undefined
      if (
        current &&
        typeof sessionID === "string" &&
        (current.type === "session.next.step.started" ||
          current.type === "session.next.step.ended" ||
          current.type === "session.next.step.failed" ||
          current.type === "session.next.retried")
      )
        note(sessionID)
    },
  }
}

function snapshotStatusVersions(versions: SessionStatusVersions, sessionIDs: Iterable<string>) {
  return new Map([...sessionIDs].map((sessionID) => [sessionID, versions.current(sessionID)] as const))
}

export function seedActiveSessionStatuses(
  session: Pick<ServerSession, "data" | "set">,
  active: SessionsActiveOutput | Record<string, SessionStatus>,
  versions?: { readonly started: ReadonlyMap<string, number>; readonly current: SessionStatusVersions },
) {
  for (const sessionID of Object.keys(active)) {
    if (versions && versions.current.current(sessionID) !== (versions.started.get(sessionID) ?? 0)) continue
    if (
      !versions &&
      session.data.session_status[sessionID] !== undefined &&
      session.data.session_status[sessionID]?.type !== "idle"
    )
      continue
    const status = active[sessionID]
    session.set("session_status", sessionID, status?.type === "running" ? { type: "busy" } : status)
  }
}

export function syncActiveSessionStatuses(
  session: Pick<ServerSession, "data" | "set">,
  active: SessionsActiveOutput | Record<string, SessionStatus>,
  versions?: { readonly started: ReadonlyMap<string, number>; readonly current: SessionStatusVersions },
) {
  const activeIDs = new Set(Object.keys(active))
  session.set(
    "session_status",
    produce((draft) => {
      for (const sessionID of Object.keys(draft)) {
        if (activeIDs.has(sessionID)) continue
        if (versions && !versions.started.has(sessionID) && versions.current.current(sessionID) !== 0) continue
        if (versions && versions.current.current(sessionID) !== (versions.started.get(sessionID) ?? 0)) continue
        delete draft[sessionID]
      }
    }),
  )
  seedActiveSessionStatuses(session, active, versions)
}

export function createActiveStatusMerge(session: Pick<ServerSession, "data" | "set">) {
  const versions = createSessionStatusVersions()
  let generation = 0
  let reconciled = false
  let initial: { generation: number; started: ReadonlyMap<string, number> } | undefined
  const finish = (
    active: SessionsActiveOutput | Record<string, SessionStatus>,
    started: ReadonlyMap<string, number>,
    requestGeneration: number,
  ) => {
    if (requestGeneration !== generation) return false
    reconciled = true
    syncActiveSessionStatuses(session, active, { started, current: versions })
    return true
  }
  return {
    versions,
    begin(known: Iterable<string>) {
      const requestGeneration = ++generation
      return { generation: requestGeneration, started: snapshotStatusVersions(versions, known) }
    },

    finish,
    beginInitial(known: Iterable<string>) {
      if (initial || generation !== 0) return
      initial = { generation: 0, started: snapshotStatusVersions(versions, known) }
      return initial
    },
    initial(active: SessionsActiveOutput | Record<string, SessionStatus>) {
      const request = initial
      initial = undefined
      if (!request || reconciled) return false
      syncActiveSessionStatuses(session, active, { started: request.started, current: versions })
      return true
    },
  }
}

export function refreshActiveSessionData(
  session: Pick<ServerSession, "sync"> & Partial<Pick<ServerSession, "todo">>,
  active: SessionsActiveOutput | Record<string, SessionStatus>,
  beforeRefresh: Record<string, SessionStatus | undefined> = {},
) {
  const sessionIDs = [
    ...new Set([
      ...Object.keys(active),
      ...Object.entries(beforeRefresh)
        .filter(([, status]) => status !== undefined && status.type !== "idle")
        .map(([sessionID]) => sessionID),
    ]),
  ]
  const failed = new Set<string>()
  return Promise.all(
    sessionIDs.map(async (sessionID) => {
      const [messages, todos] = await Promise.allSettled([
        session.sync(sessionID, { force: true }),
        session.todo?.(sessionID, { force: true }) ?? Promise.resolve(undefined),
      ])
      if (messages.status === "rejected" || todos.status === "rejected") failed.add(sessionID)
    }),
  ).then(() => ({
    refreshed: sessionIDs,
    failed,
  }))
}

export function sessionTodoRefreshID(event: {
  type: string
  properties?: unknown
  current?: { type: string; data?: unknown }
}) {
  if (event.type === "session.status") {
    const properties = event.properties
    if (
      properties &&
      typeof properties === "object" &&
      "sessionID" in properties &&
      typeof properties.sessionID === "string" &&
      "status" in properties &&
      properties.status &&
      typeof properties.status === "object" &&
      "type" in properties.status &&
      properties.status.type === "idle"
    )
      return properties.sessionID
  }

  const current = event.current
  if (
    !current ||
    (current.type !== "session.step.ended" &&
      current.type !== "session.step.failed" &&
      current.type !== "session.next.step.ended" &&
      current.type !== "session.next.step.failed")
  )
    return
  if (!current.data || typeof current.data !== "object") return
  if (!("sessionID" in current.data) || typeof current.data.sessionID !== "string") return
  return current.data.sessionID
}

export function refreshSessionTodos(
  session: Pick<ServerSession, "todo">,
  event: Parameters<typeof sessionTodoRefreshID>[0],
) {
  const sessionID = sessionTodoRefreshID(event)
  if (!sessionID) return
  return session.todo(sessionID, { force: true })
}

function makeQueryOptionsApi(
  scope: ServerScope,
  serverSDK: () => OpencodeClient,
  serverAPI: ServerApi,
  sdkFor: (dir: PathKey) => OpencodeClient,
  protocol: Promise<"v1" | "v2">,
) {
  return {
    globalConfig: () => loadGlobalConfigQuery(scope, serverSDK(), protocol),
    projects: () =>
      loadProjectsQuery(scope, {
        list: () =>
          serverSDK()
            .project.list()
            .then((result) => ({ data: result.data ?? [] })),
      }),
    providers: (directory: PathKey | null) =>
      loadProvidersQuery(scope, directory, serverAPI, directory ? sdkFor(directory) : serverSDK(), protocol),
    path: (directory: PathKey | null) =>
      loadPathQuery(scope, directory, directory ? sdkFor(directory) : serverSDK(), protocol),
    agents: (directory: PathKey) => loadAgentsQuery(scope, directory, serverAPI.agents, sdkFor(directory), protocol),
    references: (directory: PathKey) =>
      loadReferencesQuery(scope, directory, serverAPI.references, sdkFor(directory), protocol),
    mcp: (directory: PathKey) => loadMcpQuery(scope, directory, sdkFor(directory), sdkFor(directory), protocol),
    mcpResources: (directory: PathKey) =>
      loadMcpResourcesQuery(scope, directory, sdkFor(directory), sdkFor(directory), protocol),
    lsp: (directory: PathKey) => loadLspQuery(scope, directory, sdkFor(directory)),
    skills: (directory: PathKey) => loadSkillsQuery(scope, directory, serverAPI.skills),
    sessions: (directory: PathKey) => ({ queryKey: [scope, directory, "loadSessions"] as const }),
  }
}
export type QueryOptionsApi = ReturnType<typeof makeQueryOptionsApi>

export function createServerSyncContextInner(serverSDK: ServerSDK) {
  const language = useLanguage()
  const owner = getOwner()
  if (!owner) throw new Error("ServerSync must be created within owner")

  const sdkCache = new Map<string, OpencodeClient>()
  const booting = new Map<string, Promise<void>>()
  const sessionLoads = new Map<string, Promise<void>>()
  const sessionMeta = new Map<string, { limit: number }>()

  const sdkFor = (directory: string) => {
    const key = directoryKey(directory)
    const cached = sdkCache.get(key)
    if (cached) return cached
    const sdk = serverSDK.createClient({
      directory,
      throwOnError: true,
    })
    sdkCache.set(key, sdk)
    return sdk
  }

  const session = createServerSession(serverSDK.client, serverSDK.api.sessions, serverSDK.api.messages, {
    protocol: serverSDK.protocol,
    scope: String(serverSDK.scope),
  })
  const streamRecovery = createStreamRecovery(() => session.recover())
  const unsubscribeRecovery = serverSDK.event.onRecovery(() => streamRecovery.request())
  onCleanup(() => {
    unsubscribeRecovery()
    streamRecovery.dispose()
  })
  const queryOptionsApi = makeQueryOptionsApi(
    serverSDK.scope,
    () => serverSDK.client,
    serverSDK.api,
    sdkFor,
    serverSDK.protocol,
  )

  const [configQuery, providerQuery, pathQuery] = useQueries(() => ({
    queries: [queryOptionsApi.globalConfig(), queryOptionsApi.providers(null), queryOptionsApi.path(null)],
  }))
  const statusMerge = createActiveStatusMerge(session)
  const loadActive = async () => {
    if ((await serverSDK.protocol) === "v1") {
      const statuses = (await serverSDK.client.session.status()).data ?? {}
      return Object.fromEntries(
        Object.entries(statuses).flatMap(([sessionID, status]) =>
          status.type === "idle" ? [] : [[sessionID, { type: "running" as const }]],
        ),
      )
    }
    return serverSDK.api.sessions.active()
  }
  const activeSessionsQuery = useQuery(() =>
    loadActiveSessionsQuery(serverSDK.scope, {
      active: async () => {
        statusMerge.beginInitial(Object.keys(untrack(() => session.data.session_status)))
        return loadActive()
      },
    }),
  )

  const applyActiveSessions = (active: SessionsActiveOutput) => {
    for (const sessionID of Object.keys(active)) {
      void session.resolve(sessionID).catch(() => undefined)
    }
  }

  const [globalStore, setGlobalStore] = createStore<GlobalStore>({
    get ready() {
      return !bootstrap.isPending
    },
    project: [],
    provider_auth: {},
    get path() {
      const EMPTY = { state: "", config: "", worktree: "", directory: "", home: "" }
      if (pathQuery.isLoading) return EMPTY
      return pathQuery.data ?? EMPTY
    },
    get provider() {
      const EMPTY = { all: new Map(), connected: [], default: {} }
      if (providerQuery.isLoading) return EMPTY
      return providerQuery.data ?? EMPTY
    },
    get config() {
      if (configQuery.isLoading) return {}
      return configQuery.data ?? {}
    },
    get reload() {
      return updateConfigMutation.isPending ? "pending" : undefined
    },
  })

  const queryClient = useQueryClient()
  const activeRefresh = createActiveSessionRefresh({
    scope: String(serverSDK.scope),
    queryClient,
    load: loadActive,
    known: () => [
      ...Object.keys(untrack(() => session.data.session_status)),
      ...Object.keys(untrack(() => activeSessionsQuery.data) ?? {}),
    ],
    statuses: () => ({ ...untrack(() => session.data.session_status) }),
    begin: (known) => statusMerge.begin(known),
    finish: (active, started, generation) => statusMerge.finish(active, started, generation),
    apply: (active, before) => {
      applyActiveSessions(active)
      return refreshActiveSessionData(session, active, before)
    },
  })
  onCleanup(() => activeRefresh.dispose())
  const refreshActiveStatuses = () => activeRefresh.refresh().then(() => undefined)
  // A drain may stop before publishing its first assistant event. Reconcile optimistic
  // busy states even when the SSE connection stays healthy and sends no terminal event.
  onMount(() => {
    const timer = setInterval(() => {
      if (!Object.values(untrack(() => session.data.session_status)).some((status) => status?.type === "busy")) return
      void refreshActiveStatuses().catch(() => undefined)
    }, 5_000)
    onCleanup(() => clearInterval(timer))
  })
  createEffect(() => {
    const active = activeSessionsQuery.data
    if (!active || !statusMerge.initial(active)) return
    applyActiveSessions(active)
  })
  const homeSessions = createHomeSessionIndexCache(queryClient, ServerConnection.key(serverSDK.server))
  const refreshProviders = () =>
    queryClient.refetchQueries({
      predicate: (query) => query.queryKey[0] === serverSDK.scope && query.queryKey[2] === "providers",
    })

  let bootedAt = 0
  let bootingRoot = false
  let eventFrame: number | undefined
  let eventTimer: ReturnType<typeof setTimeout> | undefined

  onCleanup(() => {
    if (eventFrame !== undefined) cancelAnimationFrame(eventFrame)
    if (eventTimer !== undefined) clearTimeout(eventTimer)
  })

  const setProjects = (next: Project[] | ((draft: Project[]) => Project[])) => {
    setGlobalStore("project", next)
  }

  const setBootStore = ((...input: unknown[]) => {
    if (input[0] === "project" && Array.isArray(input[1])) {
      setProjects(input[1] as Project[])
      return input[1]
    }
    return (setGlobalStore as (...args: unknown[]) => unknown)(...input)
  }) as typeof setGlobalStore

  const bootstrap = useQuery(() => ({
    queryKey: [serverSDK.scope, "bootstrap"],
    queryFn: async () => {
      await bootstrapGlobal({
        serverSDK: serverSDK.client,
        serverAPI: serverSDK.api,
        protocol: serverSDK.protocol,
        scope: serverSDK.scope,
        requestFailedTitle: language.t("common.requestFailed"),
        translate: language.t,
        formatMoreCount: (count) => language.t("common.moreCountSuffix", { count }),
        setGlobalStore: setBootStore,
        queryClient,
      })
      bootedAt = Date.now()
      return bootedAt
    },
  }))

  const set = ((...input: unknown[]) => {
    if (input[0] === "project" && (Array.isArray(input[1]) || typeof input[1] === "function")) {
      setProjects(input[1] as Project[] | ((draft: Project[]) => Project[]))
      return input[1]
    }
    return (setGlobalStore as (...args: unknown[]) => unknown)(...input)
  }) as typeof setGlobalStore

  const [configSaves, setConfigSaves] = createSignal(0)
  const paused = () => configSaves() > 0 || untrack(() => globalStore.reload) !== undefined

  const queue = createRefreshQueue({
    paused,
    key: directoryKey,
    bootstrap: () => queryClient.fetchQuery({ queryKey: [serverSDK.scope, "bootstrap"] }),
    bootstrapInstance,
  })
  const resumeBinding = bindRefreshResume({
    saves: configSaves,
    resume: () => queue.resume(),
    observe: (run) => {
      const dispose = createRoot((stop) => {
        createEffect(run)
        onCleanup(stop)
        return stop
      })
      return dispose
    },
  })
  onCleanup(() => resumeBinding.dispose())

  const children = createChildStoreManager({
    owner,
    scope: serverSDK.scope,
    persist: persisted,
    isBooting: (directory) => booting.has(directory),
    isLoadingSessions: (directory) => sessionLoads.has(directory),
    onBootstrap: (directory) => {
      void bootstrapInstance(directory)
    },
    onMcp: (directory, setStore) => {
      void loadCommands(directory, serverSDK.api.commands, sdkFor(directory), serverSDK.protocol)
        .then((commands) => setStore("command", commands))
        .catch(() => undefined)
    },
    onDispose: (directory) => {
      const key = directoryKey(directory)
      queue.clear(key)
      sessionMeta.delete(key)
      sdkCache.delete(key)
      clearProviderRev(serverSDK.scope, key)
    },
    translate: language.t,
    queryOptions: queryOptionsApi,
    global: {
      provider: globalStore.provider,
    },
  })

  async function loadSessions(directory: string, options?: { limit?: number; force?: boolean }) {
    const key = directoryKey(directory)
    const pending = sessionLoads.get(key)
    if (pending) {
      await pending
      return loadSessions(directory, options)
    }

    children.pin(key)
    const [store, setStore] = children.child(directory, { bootstrap: false })
    const meta = sessionMeta.get(key)
    const retainedLimit = Math.max(store.limit, options?.limit ?? 0, meta?.limit ?? 0)
    if (meta && meta.limit >= retainedLimit && !options?.force) {
      const next = trimSessions(store.session, {
        limit: retainedLimit,
        permission: session.data.permission,
      })
      if (next.length !== store.session.length) {
        setStore("session", reconcile(next, { key: "id" }))
      }
      children.unpin(key)
      return
    }

    const limit = Math.max(retainedLimit + SESSION_RECENT_LIMIT, SESSION_RECENT_LIMIT)
    const promise = queryClient
      .fetchQuery({
        ...queryOptionsApi.sessions(key),
        queryFn: () =>
          serverSDK.protocol
            .then((protocol) =>
              protocol === "v1"
                ? loadRootSessionsV1({ client: sdkFor(directory), directory, limit })
                : loadRootSessions({ api: serverSDK.api.sessions, directory, limit }),
            )
            .then((x) => {
              const nonArchived = (x.data ?? [])
                .filter((s) => !!s?.id)
                .filter((s) => !s.time?.archived)
                .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
              const limit = Math.max(store.limit, options?.limit ?? 0, sessionMeta.get(key)?.limit ?? 0)
              const childSessions = store.session.filter((s) => !!s.parentID)
              const next = trimSessions([...nonArchived, ...childSessions], {
                limit,
                permission: session.data.permission,
              })
              batch(() => {
                next.forEach(session.remember)
                setStore(
                  "sessionTotal",
                  estimateRootSessionTotal({
                    count: nonArchived.length,
                    limit: x.limit,
                    limited: x.limited,
                  }),
                )
                setStore("session", reconcile(next, { key: "id" }))
              })
              sessionMeta.set(key, { limit })
            })
            .catch((err) => {
              console.error("Failed to load sessions", err)
              const project = getFilename(directory)
              showToast({
                variant: "error",
                title: language.t("toast.session.listFailed.title", { project }),
                description: formatServerError(err, language.t),
              })
            })
            .then(() => null),
      })
      .then(() => {})

    sessionLoads.set(key, promise)
    void promise.finally(() => {
      sessionLoads.delete(key)
      children.unpin(key)
    })
    return promise
  }

  async function bootstrapInstance(directory: string) {
    const key = directoryKey(directory)
    if (!key) return
    const pending = booting.get(key)
    if (pending) return pending

    children.pin(key)
    const promise = Promise.resolve().then(async () => {
      const child = children.ensureChild(directory)
      const cache = children.vcsCache.get(key)
      if (!cache) return
      const sdk = sdkFor(directory)
      await bootstrapDirectory({
        directory,
        scope: serverSDK.scope,
        mcp: children.mcp(key),
        global: {
          config: globalStore.config,
          path: globalStore.path,
          project: globalStore.project,
          provider: globalStore.provider,
        },
        sdk,
        api: serverSDK.api,
        store: child[0],
        setStore: child[1],
        vcsCache: cache,
        loadSessions,
        translate: language.t,
        queryClient,
        session,
        protocol: serverSDK.protocol,
      })
    })

    booting.set(key, promise)
    void promise.finally(() => {
      booting.delete(key)
      children.unpin(key)
    })
    return promise
  }

  const indexSession = (info: Parameters<typeof session.remember>[0]) => {
    const key = directoryKey(info.directory)
    const existing = children.children[key]
    if (!existing) return
    applyDirectoryEvent({
      event: { type: "session.created", properties: { info } },
      directory: key,
      store: existing[0],
      setStore: existing[1],
      push: queue.push,
      retainedLimit: sessionMeta.get(key)?.limit,
      sessionContent: false,
      permission: session.data.permission,
      loadLsp() {},
    })
  }

  const unsub = serverSDK.event.listen((e) => {
    const directory = e.name
    const key = directoryKey(directory)
    const event = e.details
    const eventType: string = event.type
    const recent = bootingRoot || Date.now() - bootedAt < 1500

    statusMerge.versions.note(event)
    if (event.current) session.applyV2(event.current)
    session.apply(event)
    const todoRefresh = refreshSessionTodos(session, event)
    if (todoRefresh) void todoRefresh.catch(() => {})
    if (event.type === "session.created" || event.type === "session.updated" || event.type === "session.deleted") {
      homeSessions.apply(event)
    }
    homeSessions.refresh(event.type)
    if (
      eventType === "integration.connection.updated" ||
      eventType === "catalog.updated" ||
      eventType === "relay.catalog.updated"
    )
      void refreshProviders()

    if (directory === "global") {
      if (eventType === "server.connected") void refreshActiveStatuses()
      applyGlobalEvent({
        event,
        project: globalStore.project,
        refresh: () => {
          if (recent) return
          bootstrap.refetch()
        },
        setGlobalProject: setProjects,
      })
      if (
        eventType === "config.updated" ||
        eventType === "catalog.updated" ||
        eventType === "agent.updated" ||
        eventType === "project.directories.updated"
      )
        bootstrap.refetch()
      if (eventType === "server.connected" || eventType === "global.disposed") {
        if (recent) return
        for (const directory of Object.keys(children.children)) {
          if (!children.active(directory)) continue
          void loadSessions(directory, { force: true }).catch(() => {})
          queue.push(directory)
        }
      }
      return
    }

    if (event.current?.type === "session.next.moved") {
      const info = session.get(event.current.data.sessionID)
      if (info) indexSession(info)
    }
    if (event.current?.type === "session.next.revert.committed")
      void session
        .resolve(event.current.data.sessionID, { force: true })
        .then(indexSession)
        .catch(() => {})

    const existing = children.children[key]
    if (!existing) return
    children.mark(key)
    if (
      event.current?.type === "session.next.moved" ||
      // event.current?.type === "session.archived" ||
      event.current?.type === "session.next.revert.committed" ||
      eventType === "command.updated" ||
      eventType === "config.updated" ||
      eventType === "agent.updated" ||
      eventType === "catalog.updated" ||
      eventType === "relay.catalog.updated"
    )
      queue.push(key)
    if (eventType === "mcp.status.changed") void queryClient.invalidateQueries(queryOptionsApi.mcp(key))
    if (eventType === "mcp.resources.changed") void queryClient.invalidateQueries(queryOptionsApi.mcpResources(key))
    const [store, setStore] = existing
    applyDirectoryEvent({
      event,
      directory,
      store,
      setStore,
      push: (directory) => {
        if (children.active(directory)) queue.push(directory)
      },
      retainedLimit: sessionMeta.get(key)?.limit,
      sessionContent: false,
      permission: session.data.permission,
      vcsCache: children.vcsCache.get(key),
      loadLsp: () => {
        if (!children.active(key)) return
        void queryClient.fetchQuery(queryOptionsApi.lsp(key))
      },
      loadReferences: () => {
        if (!children.active(key)) return
        void queryClient.fetchQuery(queryOptionsApi.references(key))
      },
    })
  })

  onCleanup(unsub)
  onCleanup(() => {
    queue.dispose()
    disposePromptScope(String(serverSDK.scope))
  })
  onCleanup(() => {
    for (const directory of Object.keys(children.children)) {
      children.disposeDirectory(directoryKey(directory))
    }
  })

  onMount(() => {
    if (typeof requestAnimationFrame === "function") {
      eventFrame = requestAnimationFrame(() => {
        eventFrame = undefined
        eventTimer = setTimeout(() => {
          eventTimer = undefined
          void serverSDK.event.start()
        }, 0)
      })
    } else {
      eventTimer = setTimeout(() => {
        eventTimer = undefined
        void serverSDK.event.start()
      }, 0)
    }
  })

  const projectApi = {
    loadSessions,
    meta(directory: string, patch: ProjectMeta) {
      children.projectMeta(directory, patch)
    },
    icon(directory: string, value: string | undefined) {
      children.projectIcon(directory, value)
    },
  }

  const updateConfigMutation = useMutation(() => ({
    mutationFn: (config: Config) => serverSDK.client.global.config.update({ config }),
    onMutate: () => {
      setConfigSaves((count) => count + 1)
    },
    onSuccess: () => {
      bootstrap.refetch()
      // Invalidate all provider queries so newly configured custom providers
      // appear immediately in the available provider list across all directories.
      queryClient.invalidateQueries({ queryKey: [serverSDK.scope, null, "providers"] })
      queryClient.invalidateQueries({
        predicate: (query) => query.queryKey[0] === serverSDK.scope && query.queryKey[2] === "providers",
      })
    },
  }))

  return {
    data: globalStore,
    set,
    get ready() {
      return globalStore.ready
    },
    get error() {
      return globalStore.error
    },
    child: children.child,
    peek: children.peek,
    disableMcp: children.disableMcp,
    queryOptions: queryOptionsApi,
    refreshProviders,
    // bootstrap,
    updateConfig: async (config: Config) => {
      try {
        return await updateConfigMutation.mutateAsync(config)
      } finally {
        setConfigSaves((count) => Math.max(0, count - 1))
      }
    },
    project: projectApi,
    session,
    homeSessions,
    mcp: {
      toggle: async (directory: string, name: string) => {
        const key = directoryKey(directory)
        const sdk = sdkFor(key)
        const status = children.child(key, { bootstrap: false })[0].mcp[name]
        if (!status) return
        await toggleMcp({
          status,
          connect: async () => {
            if ((await serverSDK.protocol) === "v1") {
              await sdk.mcp.connect({ name })
              return
            }
            await sdk.mcp.connect({ name })
          },
          disconnect: async () => {
            if ((await serverSDK.protocol) === "v1") {
              await sdk.mcp.disconnect({ name })
              return
            }
            await sdk.mcp.disconnect({ name })
          },
          authenticate: async () => {
            await sdk.mcp.auth.authenticate({ name })
          },
          refresh: async () => {
            await queryClient.refetchQueries(queryOptionsApi.mcp(key))
            await queryClient.refetchQueries(queryOptionsApi.mcpResources(key))
          },
        })
      },
    },
  }
}

export function createServerSyncContext(serverSDK: ServerSDK) {
  const inner = createServerSyncContextInner(serverSDK)
  return Object.assign(inner, {
    ensureDirSyncContext: createRefCountMap(
      (dir) => createDirSyncContext(dir, inner, serverSDK),
      (dir) => inner.disableMcp(dir),
      directoryKey,
    ),
  })
}

export type ServerSync = ReturnType<typeof createServerSyncContext>

export const { use: useServerSync, provider: ServerSyncProvider } = createSimpleContext({
  name: "ServerSync",
  // Returns an accessor so the resolved server can change reactively without
  // re-instantiating the subtree (mirrors useServerSDK).
  init: (props: { server?: Accessor<ServerConnection.Any | undefined> }) => {
    const global = useGlobal()
    const language = useLanguage()
    const server = useServer()

    return createMemo<ServerSync>(() => {
      const conn = props.server?.() ?? server.current
      if (!conn) throw new Error(language.t("error.serverSDK.noServerAvailable"))
      return global.ensureServerCtx(conn).sync
    })
  },
})

export function useQueryOptions() {
  const sync = useServerSync()
  return createMemo(() => sync().queryOptions)
}
