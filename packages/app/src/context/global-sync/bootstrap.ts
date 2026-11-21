import type {
  Config,
  OpencodeClient,
  Path,
  PermissionRequest,
  Project,
  ProviderAuthResponse,
  QuestionRequest,
  ReferenceInfo,
  Session,
} from "@opencode-ai/sdk/v2/client"
import type { AgentsListInput, AgentsListOutput, CommandsListInput, CommandsListOutput, ModelsListOutput, ReferencesListInput, ReferencesListOutput } from "@opencode-ai/client"
import type { CommandInfo } from "./types"
import { showToast } from "@/utils/toast"
import { getFilename } from "@opencode-ai/core/util/path"
import { retry } from "@opencode-ai/core/util/retry"
import { batch } from "solid-js"
import { produce, reconcile, type SetStoreFunction, type Store } from "solid-js/store"
import type { State, VcsCache } from "./types"
import type { ServerSession } from "../server-session"
import {
  cmp,
  normalizeAgentList,
  normalizePermissionRequest,
  normalizeProjectInfo,
  normalizeProviderList,
} from "./utils"
import { formatServerError } from "@/utils/server-errors"
import { CancelledError, QueryClient, queryOptions, type SolidQueryOptions } from "@tanstack/solid-query"
import { loadMcpQuery, loadMcpResourcesQuery } from "../server-sync"
import type { NormalizedProviderListResponse } from "@opencode-ai/session-ui/context"
import { ScopedKey, type ServerScope } from "@/utils/server-scope"
import { normalizeSessionInfo } from "@/utils/session"
import type { ServerProtocol } from "@/utils/server-protocol"
import type { ServerApi } from "@/utils/server"

type GlobalStore = {
  ready: boolean
  path: Path
  project: Project[]
  provider: NormalizedProviderListResponse
  provider_auth: ProviderAuthResponse
  config: Config
  reload: undefined | "pending" | "complete"
}

function waitForPaint() {
  return new Promise<void>((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      resolve()
    }
    const timer = setTimeout(finish, 50)
    if (typeof requestAnimationFrame !== "function") return
    requestAnimationFrame(() => {
      setTimeout(() => {
        clearTimeout(timer)
        finish()
      }, 0)
    })
  })
}

function isQueryCancelled(error: unknown) {
  if (error instanceof CancelledError) return true
  if (error === null || typeof error !== "object") return false
  const name = "name" in error ? error.name : undefined
  return name === "CancelledError" || name === "AbortError"
}

function errors(list: PromiseSettledResult<unknown>[]) {
  return list
    .filter((item): item is PromiseRejectedResult => item.status === "rejected")
    .map((item) => item.reason)
    .filter((reason) => !isQueryCancelled(reason))
}

const providerRev = new Map<string, number>()
const promptScopes = new Map<string, { issued: number; applied: number; generation: number }>()
const promptVersions = new Map<string, number>()
const promptGenerations = new Map<string, number>()
let promptEpoch = 0

const promptKey = (scope: string, kind: "permission" | "question", directory: string) => `${scope}\0${kind}:${directory}`

export function notePrompt(input: {
  scope: string
  kind: "permission" | "question"
  directory: string
  id: string
}) {
  const pending = input.directory ? promptVersions.get(versionKey(input.scope, input.kind, "", input.id)) : undefined
  promptVersions.set(
    versionKey(input.scope, input.kind, input.directory, input.id),
    Math.max(pending ?? 0, ++promptEpoch),
  )
}

export function createPromptVersions(scope: string) {
  return {
    note(kind: "permission" | "question", directory: string, id: string) {
      notePrompt({ scope, kind, directory, id })
    },
  }
}

const versionKey = (scope: string, kind: "permission" | "question", directory: string, id: string) =>
  `${scope}\0${kind}\0${directory}\0${id}`

function promptContext(scope: string, kind: "permission" | "question", directory: string) {
  const key = promptKey(scope, kind, directory)
  const generation = promptGenerations.get(scope) ?? 0
  const current = promptScopes.get(key)
  if (current && current.generation === generation) return current
  const next = { issued: 0, applied: 0, generation }
  promptScopes.set(key, next)
  return next
}

function promptRequest(scope: string, kind: "permission" | "question", directory: string) {
  const context = promptContext(scope, kind, directory)
  const issued = ++context.issued
  // Occupy this generation immediately. A later failure must not reopen the
  // write window for an older snapshot that has not merged yet.
  context.applied = Math.max(context.applied, issued)
  return { issued, started: promptEpoch, generation: context.generation }
}

function claimPromptRequest(
  scope: string,
  kind: "permission" | "question",
  directory: string,
  request: { issued: number; generation: number },
) {
  const context = promptContext(scope, kind, directory)
  if (context.generation !== request.generation || request.issued < context.applied) return false
  context.applied = request.issued
  return true
}

function promptStale(
  scope: string,
  kind: "permission" | "question",
  directory: string,
  request: { issued: number; generation: number },
) {
  const context = promptScopes.get(promptKey(scope, kind, directory))
  return !context || context.generation !== request.generation || request.issued !== context.applied
}

function promptChanged(
  scope: string,
  kind: "permission" | "question",
  directory: string,
  id: string,
  started: number,
) {
  const current = Math.max(
    promptVersions.get(versionKey(scope, kind, directory, id)) ?? 0,
    promptVersions.get(versionKey(scope, kind, "", id)) ?? 0,
  )
  return current > started
}

export function disposePromptScope(scope: string) {
  promptGenerations.set(scope, (promptGenerations.get(scope) ?? 0) + 1)
}

export function clearProviderRev(scope: ServerScope, directory: string) {
  providerRev.delete(ScopedKey.from(scope, directory))
}

function runAll(list: Array<() => Promise<unknown>>) {
  return Promise.allSettled(list.map((item) => item()))
}

function showErrors(input: {
  errors: unknown[]
  title: string
  translate: (key: string, vars?: Record<string, string | number>) => string
  formatMoreCount: (count: number) => string
}) {
  if (input.errors.length === 0) return
  const message = formatServerError(input.errors[0], input.translate)
  const more = input.errors.length > 1 ? input.formatMoreCount(input.errors.length - 1) : ""
  showToast({
    variant: "error",
    title: input.title,
    description: message + more,
  })
}

export const loadGlobalConfigQuery = (scope: ServerScope, sdk: OpencodeClient, protocol?: Promise<ServerProtocol>) =>
  queryOptions({
    queryKey: [scope, "config"],
    queryFn: async () => {
      return retry(() => sdk.global.config.get().then((x) => x.data ?? {}))
    },
  })

type ProjectApi = { readonly list: () => Promise<{ data: readonly Project[] }> }

export const loadProjectsQuery = (scope: ServerScope, api: ProjectApi) =>
  queryOptions({
    queryKey: [scope, "project"],
    queryFn: () =>
      retry(() =>
        api.list().then((result) => {
          return result.data
            .filter((p) => !!p?.id)
            .filter((p) => !!p.worktree && !p.worktree.includes("opencode-test"))
            .map(normalizeProjectInfo)
            .slice()
            .sort((a, b) => cmp(a.id, b.id))
        }),
      ),
  })

export async function bootstrapGlobal(input: {
  serverSDK: OpencodeClient
  serverAPI: ServerApi
  protocol?: Promise<ServerProtocol>
  scope: ServerScope
  requestFailedTitle: string
  translate: (key: string, vars?: Record<string, string | number>) => string
  formatMoreCount: (count: number) => string
  setGlobalStore: SetStoreFunction<GlobalStore>
  queryClient: QueryClient
}) {
  const slow = [
    () => input.queryClient.fetchQuery(loadGlobalConfigQuery(input.scope, input.serverSDK, input.protocol)),
    () =>
      input.queryClient.fetchQuery(
        loadProvidersQuery(input.scope, null, input.serverAPI, input.serverSDK, input.protocol),
      ),
    () => input.queryClient.fetchQuery(loadPathQuery(input.scope, null, input.serverSDK, input.protocol)),
    () =>
      input.queryClient
        .fetchQuery(loadProjectsQuery(input.scope, {
          list: () => input.serverSDK.project.list().then((result) => ({ data: result.data ?? [] })),
        }))
        .then((data) => input.setGlobalStore("project", data)),
  ]
  await runAll(slow)
  // showErrors({
  //   errors: errors(),
  //   title: input.requestFailedTitle,
  //   translate: input.translate,
  //   formatMoreCount: input.formatMoreCount,
  // })
}

function groupBySession<T extends { id: string; sessionID: string }>(input: T[]) {
  return input.reduce<Record<string, T[]>>((acc, item) => {
    if (!item?.id || !item.sessionID) return acc
    const list = acc[item.sessionID]
    if (list) list.push(item)
    if (!list) acc[item.sessionID] = [item]
    return acc
  }, {})
}

function projectID(directory: string, projects: Project[]) {
  return projects.find((project) => project.worktree === directory || project.sandboxes?.includes(directory))?.id
}

function mergeSession(setStore: SetStoreFunction<State>, session: Session) {
  setStore("session", (list) => {
    const next = list.slice()
    const idx = next.findIndex((item) => item.id >= session.id)
    if (idx === -1) return [...next, session]
    if (next[idx]?.id === session.id) {
      next[idx] = session
      return next
    }
    next.splice(idx, 0, session)
    return next
  })
}

function warmSessions(input: {
  ids: string[]
  store: Store<State>
  setStore: SetStoreFunction<State>
  api: Pick<ServerApi["sessions"], "get">
}) {
  const known = new Set(input.store.session.map((item) => item.id))
  const ids = [...new Set(input.ids)].filter((id) => !!id && !known.has(id))
  if (ids.length === 0) return Promise.resolve()
  return Promise.all(
    ids.map((sessionID) =>
      retry(() => input.api.get({ sessionID })).then((session) =>
        mergeSession(input.setStore, normalizeSessionInfo(session)),
      ),
    ),
  ).then(() => undefined)
}

export const loadProvidersQuery: (
  scope: ServerScope,
  directory: string | null,
  sdk: Pick<ServerApi, "providers" | "models">,
  legacy?: OpencodeClient,
  protocol?: Promise<ServerProtocol>,
) => SolidQueryOptions<NormalizedProviderListResponse, Error, NormalizedProviderListResponse, [ServerScope, string | null, "providers"]> = (
  scope,
  directory,
  sdk,
  legacy,
  protocol,
) =>
  queryOptions<NormalizedProviderListResponse, Error, NormalizedProviderListResponse, [ServerScope, string | null, "providers"]>({
    queryKey: [scope, directory, "providers"] as [ServerScope, string | null, "providers"],
    queryFn: () =>
      retry(async () => {
        if ((await protocol) === "v1" && legacy) {
          const result = await legacy.provider.list()
          return normalizeProviderList(result.data!)
        }
        const location = directory ? { location: { directory } } : undefined
        const [providers, models, defaultModel] = await Promise.all([
          sdk.providers.list(location),
          sdk.models.list(location),
          Promise.resolve(undefined as ModelsListOutput["data"][number] | undefined),
        ])
        return normalizeProviderList(providers.data, models.data, defaultModel)
      }),
  })

type AgentListApi = {
  readonly list: (input?: AgentsListInput) => Promise<AgentsListOutput>
}

type CommandListApi = {
  readonly list: (input?: CommandsListInput) => Promise<CommandsListOutput>
}

type ReferenceListApi = {
  readonly list: (input?: ReferencesListInput) => Promise<ReferencesListOutput>
}

export const loadAgentsQuery = (
  scope: ServerScope,
  directory: string,
  sdk: AgentListApi,
  legacy?: OpencodeClient,
  protocol?: Promise<ServerProtocol>,
) =>
  queryOptions({
    queryKey: [scope, directory, "agents"],
    queryFn: () =>
      retry(async () => {
        if ((await protocol) === "v1" && legacy) return normalizeAgentList((await legacy.app.agents()).data ?? [])
        return sdk.list({ location: { directory } }).then((result) => normalizeAgentList(result.data))
      }),
  })

export const loadCommands = (
  directory: string,
  api: CommandListApi,
  legacy?: OpencodeClient,
  protocol?: Promise<ServerProtocol>,
): Promise<CommandInfo[]> =>
  retry(async () => {
    if ((await protocol) === "v1" && legacy) {
      return ((await legacy.command.list()).data ?? []).map((command) => {
        const [providerID, id] = command.model?.split("/") ?? []
        return {
          name: command.name,
          template: command.template,
          description: command.description,
          agent: command.agent,
          model: providerID && id ? { providerID, id } : undefined,
          subtask: command.subtask,
          // source: command.source === "skill" ? undefined : command.source,
        }
      })
    }
    return api.list({ location: { directory } }).then((result) => [...result.data])
  })

export const loadPathQuery = (
  scope: ServerScope,
  directory: string | null,
  sdk: OpencodeClient,
  protocol?: Promise<ServerProtocol>,
) =>
  queryOptions<Path>({
    queryKey: [scope, directory, "path"],
    queryFn: async () => {
      if ((await protocol) !== "v1")
        return { state: "", config: "", worktree: "", directory: directory ?? "", home: "" }
      return retry(() => sdk.path.get({ directory: directory ?? undefined }).then((result) => result.data!))
    },
  })

export const loadReferencesQuery = (
  scope: ServerScope,
  directory: string,
  api: ReferenceListApi,
  legacy?: OpencodeClient,
  protocol?: Promise<ServerProtocol>,
) =>
  queryOptions<ReferenceInfo[]>({
    queryKey: [scope, directory, "references"] as const,
    queryFn: () =>
      retry(async () => {
        if ((await protocol) === "v1" && legacy) return (await legacy.v2.reference.list()).data?.data ?? []
        return api.list({ location: { directory } }).then((result) => [...result.data])
      }).catch(() => []),
    placeholderData: [],
  })

export async function bootstrapDirectory(input: {
  directory: string
  scope: ServerScope
  mcp: boolean
  sdk: OpencodeClient
  api: ServerApi
  store: Store<State>
  setStore: SetStoreFunction<State>
  vcsCache: VcsCache
  loadSessions: (directory: string) => Promise<void> | void
  translate: (key: string, vars?: Record<string, string | number>) => string
  global: {
    config: Config
    path: Path
    project: Project[]
    provider: NormalizedProviderListResponse
  }
  queryClient: QueryClient
  session?: ServerSession
  protocol?: Promise<ServerProtocol>
}) {
  const loading = input.store.status !== "complete"
  const seededProject = projectID(input.directory, input.global.project)
  const seededPath = input.global.path.directory === input.directory ? input.global.path : undefined
  if (seededProject) input.setStore("project", seededProject)
  if (seededPath) input.setStore("path", seededPath)
  if (Object.keys(input.store.config).length === 0 && Object.keys(input.global.config).length > 0) {
    input.setStore("config", reconcile(input.global.config, { merge: false }))
  }
  if (loading) input.setStore("status", "partial")

  const permissionRequest = promptRequest(String(input.scope), "permission", input.directory)
  const questionRequest = promptRequest(String(input.scope), "question", input.directory)
  const revKey = ScopedKey.from(input.scope, input.directory)
  const rev = (providerRev.get(revKey) ?? 0) + 1
  providerRev.set(revKey, rev)
  return (async () => {
    const slow = [
      () => Promise.resolve(input.loadSessions(input.directory)),
      () =>
        input.queryClient
          .fetchQuery(loadAgentsQuery(input.scope, input.directory, input.api.agents, input.sdk, input.protocol))
          .then((data) => {
            if (providerRev.get(revKey) !== rev) return
            input.setStore("agent", data)
          })
          .catch(() => undefined),
      () =>
        retry(async () => {
          if ((await input.protocol) !== "v1") return
          return input.sdk.config.get().then((x) => input.setStore("config", reconcile(x.data!, { merge: false })))
        }).catch(() => undefined),
      () =>
        retry(() =>
          (async () => {
            if ((await input.protocol) !== "v1") return
            const x = await input.sdk.session.status()
            if (!input.session) {
              input.setStore("session_status", x.data!)
              return
            }
            const statuses = x.data ?? {}
            input.session.set(
              "session_status",
              produce((draft) => {
                for (const sessionID of Object.keys(draft)) {
                  if (statuses[sessionID]) continue
                  if (input.session?.get(sessionID)?.directory === input.directory) delete draft[sessionID]
                }
              }),
            )
            for (const [sessionID, status] of Object.entries(statuses)) {
              input.session.set("session_status", sessionID, reconcile(status))
            }
            await Promise.all(
              Object.keys(statuses).map((sessionID) => input.session!.resolve(sessionID).catch(() => undefined)),
            )
          })(),
        ).catch(() => undefined),
      !seededProject &&
        (() =>
          retry(() => input.sdk.project.current({ directory: input.directory }))
            .then((project) => input.setStore("project", project.data?.id ?? ""))
            .catch(() => undefined)),
      !seededPath &&
        (() =>
          input.queryClient
            .ensureQueryData(loadPathQuery(input.scope, input.directory, input.sdk, input.protocol))
            .then((data) => {
              const next = projectID(data.directory ?? input.directory, input.global.project)
              if (next) input.setStore("project", next)
            })
            .catch(() => undefined)),
      () =>
        retry(async () => {
          if ((await input.protocol) !== "v1") return
          return input.sdk.vcs.get().then((result) => {
            const next = { branch: result.data?.branch, default_branch: result.data?.default_branch }
            input.setStore("vcs", next)
            if (next) input.vcsCache.setStore("value", next)
          })
        }).catch(() => undefined),
      input.mcp &&
        (() =>
          loadCommands(input.directory, input.api.commands, input.sdk, input.protocol)
            .then((commands) => {
              if (providerRev.get(revKey) !== rev) return
              input.setStore("command", commands)
            })
            .catch(() => undefined)),
      () =>
        input.queryClient.fetchQuery(
          loadReferencesQuery(input.scope, input.directory, input.api.references, input.sdk, input.protocol),
        ),
      () => loadPromptSnapshot(input, "permission", permissionRequest),
      () => loadPromptSnapshot(input, "question", questionRequest),
      () => Promise.resolve(input.loadSessions(input.directory)),
      input.mcp &&
        (() =>
          input.queryClient
           .fetchQuery(loadMcpQuery(input.scope, input.directory, input.sdk, input.sdk, input.protocol))
            .catch(() => undefined)),
      input.mcp &&
        (() =>
          input.queryClient
           .fetchQuery(loadMcpResourcesQuery(input.scope, input.directory, input.sdk, input.sdk, input.protocol))
            .catch(() => undefined)),
      () =>
        input.queryClient
          .fetchQuery(loadProvidersQuery(input.scope, input.directory, input.api, input.sdk, input.protocol))
          .catch((err) => {
            if (isQueryCancelled(err)) return
            const project = getFilename(input.directory)
            showToast({
              variant: "error",
              title: input.translate("toast.project.reloadFailed.title", { project }),
              description: formatServerError(err, input.translate),
            })
          }),
    ].filter(Boolean) as (() => Promise<any>)[]

    await waitForPaint()
    const slowErrs = errors(await runAll(slow))
    if (slowErrs.length > 0) {
      console.error("Failed to finish bootstrap instance", slowErrs[0])
      if (!input.store.project) {
        const project = getFilename(input.directory)
        showToast({
          variant: "error",
          title: input.translate("toast.project.reloadFailed.title", { project }),
          description: formatServerError(slowErrs[0], input.translate),
        })
      }
    }

    if (providerRev.get(revKey) !== rev) return
    if (loading) input.setStore("status", "complete")
  })()
}

function loadPromptSnapshot(
  input: Parameters<typeof bootstrapDirectory>[0],
  kind: "permission" | "question",
  request: { issued: number; started: number; generation: number },
) {
  const scope = String(input.scope)
  const started = request.started
  return retry(() =>
    listPrompts(input, kind).then((items) => {
      const ids = items.map((item) => item.sessionID)
      const grouped = groupBySession(items.filter((item) => !!item.id && !!item.sessionID))
      const warm = input.session
        ? Promise.all(ids.map((sessionID) => input.session!.resolve(sessionID))).then(() => undefined)
        : warmSessions({ ids, store: input.store, setStore: input.setStore, api: input.api.sessions })
      return warm.then(() => {
        if (!claimPromptRequest(scope, kind, input.directory, request)) return
        if (promptStale(scope, kind, input.directory, request)) return
        batch(() => {
          if (promptStale(scope, kind, input.directory, request)) return
          const current =
            kind === "permission"
              ? (input.session?.data.permission ?? input.store.permission)
              : (input.session?.data.question ?? input.store.question)
          for (const sessionID of Object.keys(current)) {
            if (grouped[sessionID]) continue
            if (promptChanged(scope, kind, input.directory, sessionID, started)) continue
            const known = input.session?.get(sessionID)
            if (known && known.directory !== input.directory) continue
            writePrompt(input, kind, sessionID, [])
          }
          for (const [sessionID, prompts] of Object.entries(grouped)) {
            if (promptChanged(scope, kind, input.directory, sessionID, started)) continue
            const value = prompts.filter((item) => !!item?.id).sort((a, b) => cmp(a.id, b.id))
            writePrompt(input, kind, sessionID, reconcile(value, { key: "id" }) as unknown as PermissionRequest[] | QuestionRequest[])
          }
        })
      })
    }),
  ).catch(() => undefined)
}

function listPrompts(input: Parameters<typeof bootstrapDirectory>[0], kind: "permission" | "question") {
  if (kind === "permission") {
    return (async () => {
      if ((await input.protocol) === "v1") return (await input.sdk.permission.list()).data ?? []
      return input.api.permissions.listRequests({ location: { directory: input.directory } }).then((result) =>
        result.data.map((item) =>
          normalizePermissionRequest({
            ...item,
            resources: [...item.resources],
            save: item.save ? [...item.save] : undefined,
          }),
        ),
      )
    })()
  }
  return (async () => {
    if ((await input.protocol) === "v1") return (await input.sdk.question.list()).data ?? []
    return input.api.questions.listRequests({ location: { directory: input.directory } }).then((result) => result.data)
  })()
}

function writePrompt(
  input: Parameters<typeof bootstrapDirectory>[0],
  kind: "permission" | "question",
  sessionID: string,
  value: PermissionRequest[] | QuestionRequest[],
) {
  if (kind === "permission") {
    const permissions = value as PermissionRequest[]
    if (input.session) input.session.set("permission", sessionID, permissions)
    if (!input.session) input.setStore("permission", sessionID, permissions)
    return
  }
  const questions = value as QuestionRequest[]
  if (input.session) input.session.set("question", sessionID, questions)
  if (!input.session) input.setStore("question", sessionID, questions)
}
