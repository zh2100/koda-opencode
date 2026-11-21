import { describe, expect, test } from "bun:test"

import { createStore } from "solid-js/store"
import { CancelledError, QueryClient } from "@tanstack/solid-query"
import type { Config, OpencodeClient, PermissionRequest, Project, QuestionRequest, Session } from "@opencode-ai/sdk/v2/client"
import type { AgentsListOutput, CommandsListOutput, ReferencesListOutput } from "@opencode-ai/client/promise"
import type { NormalizedProviderListResponse } from "@opencode-ai/session-ui/context"
import {
  bootstrapDirectory,
  disposePromptScope,
  notePrompt,
  loadAgentsQuery,
  loadCommands,
  loadGlobalConfigQuery,
  loadPathQuery,
  loadProjectsQuery,
  loadProvidersQuery,
  loadReferencesQuery,
} from "./bootstrap"
import type { State, VcsCache } from "./types"
import { ServerScope } from "@/utils/server-scope"
import type { ServerApi } from "@/utils/server"
import { createServerSession } from "../server-session"

type ProjectApi = { list: () => Promise<{ data: readonly Project[] }> }
type AgentApi = ServerApi["agents"]
type CatalogApi = Pick<ServerApi, "providers" | "models">
type CommandApi = ServerApi["commands"]
type ReferenceApi = ServerApi["references"]

const provider = { all: new Map(), connected: [], default: {} } satisfies NormalizedProviderListResponse
const api = {
  agent: { list: async () => ({ location: {}, data: [] }) },
  provider: { list: async () => ({ location: {}, data: [] }) },
  model: {
    list: async () => ({ location: {}, data: [] }),
    default: async () => ({ location: {}, data: null }),
  },
  permission: { request: { list: async () => ({ location: {}, data: [] }) } },
  project: {
    list: async () => [],
    current: async () => ({ id: "project", directory: "/project" }),
  },
  sessions: {
    get: async () => ({ id: "ses_1", directory: "/project", title: "Session" }),
  },
  question: { request: { list: async () => ({ location: {}, data: [] }) } },
  reference: { list: async () => ({ location: {}, data: [] }) },
  vcs: { get: async () => ({ location: {}, data: {} }) },
} as unknown as ServerApi

function directoryState() {
  return createStore<State>({
    status: "loading",
    agent: [],
    command: [],
    reference: [],
    project: "",
    projectMeta: undefined,
    icon: undefined,
    provider_ready: true,
    provider,
    config: {},
    path: { state: "", config: "", worktree: "/project", directory: "/project", home: "/home" },
    session: [],
    sessionTotal: 0,
    session_status: {},
    session_working(id: string) {
      return this.session_status[id]?.type !== "idle"
    },
    session_diff: {},
    todo: {},
    permission: {},
    question: {},
    mcp_ready: true,
    mcp: {},
    mcp_resource: {},
    lsp_ready: true,
    lsp: [],
    vcs: undefined,
    limit: 5,
    message: {},
    session_message: {},
    part: {},
    part_text_accum_delta: {},
  })
}

describe("bootstrapDirectory", () => {
  test("uses legacy MCP endpoints while refreshing a v1 directory", async () => {
    const legacyConfigReads: string[] = []
    const mcpReads: string[] = []
    const [store, setStore] = directoryState()

    await bootstrapDirectory({
      directory: "/project",
      scope: ServerScope.local,
      mcp: true,
      global: {
        config: {} satisfies Config,
        path: { state: "", config: "", worktree: "/project", directory: "/project", home: "/home" },
        project: [{ id: "project", worktree: "/project" } as Project],
        provider,
      },
      sdk: {
        app: { agents: async () => ({ data: [{ name: "build", mode: "primary" }] }) },
        config: {
          get: async () => {
            legacyConfigReads.push("directory")
            return { data: {} }
          },
        },
        session: { status: async () => ({ data: {} }) },
        vcs: { get: async () => ({ data: undefined }) },
        command: {
          list: async () => {
            mcpReads.push("command")
            return { data: [] }
          },
        },
        permission: { list: async () => ({ data: [] }) },
        question: { list: async () => ({ data: [] }) },
        v2: { reference: { list: async () => ({ data: { data: [] } }) } },
        mcp: {
          status: async () => {
            mcpReads.push("status")
            return { data: {} }
          },
        },
        experimental: {
          resource: {
            list: async () => {
              mcpReads.push("resource")
              return { data: {} }
            },
          },
        },
        provider: { list: async () => ({ data: { all: [], connected: [], default: {} } }) },
      } as unknown as OpencodeClient,
      api,
      store,
      setStore,
      vcsCache: { setStore() {} } as unknown as VcsCache,
      loadSessions() {},
      translate: (key) => key,
      queryClient: new QueryClient(),
      protocol: Promise.resolve("v1"),
    })

    expect(store.status).toBe("complete")
    expect(legacyConfigReads).toEqual(["directory"])
    expect(mcpReads.sort()).toEqual(["command", "resource", "status"])
  })

  test("completes a v1 directory when vcs and commands fail", async () => {
    const [store, setStore] = directoryState()

    await bootstrapDirectory({
      directory: "/project",
      scope: ServerScope.local,
      mcp: true,
      global: {
        config: {} satisfies Config,
        path: { state: "", config: "", worktree: "/project", directory: "/project", home: "/home" },
        project: [{ id: "project", worktree: "/project" } as Project],
        provider,
      },
      sdk: {
        app: { agents: async () => ({ data: [{ name: "build", mode: "primary" }] }) },
        config: { get: async () => ({ data: {} }) },
        session: { status: async () => ({ data: {} }) },
        vcs: {
          get: async () => {
            throw new Error("git failed")
          },
        },
        command: {
          list: async () => {
            throw new Error("commands failed")
          },
        },
        permission: { list: async () => ({ data: [] }) },
        question: { list: async () => ({ data: [] }) },
        v2: { reference: { list: async () => ({ data: { data: [] } }) } },
        mcp: { status: async () => ({ data: {} }) },
        experimental: { resource: { list: async () => ({ data: {} }) } },
        provider: { list: async () => ({ data: { all: [], connected: [], default: {} } }) },
      } as unknown as OpencodeClient,
      api,
      store,
      setStore,
      vcsCache: { setStore() {} } as unknown as VcsCache,
      loadSessions() {},
      translate: (key) => key,
      queryClient: new QueryClient(),
      protocol: Promise.resolve("v1"),
    })

    await new Promise((resolve) => setTimeout(resolve, 80))

    expect(store.status).toBe("complete")
  })

  test("completes when provider fetch is cancelled", async () => {
    const [store, setStore] = directoryState()
    const cancelled = new CancelledError({ silent: true })

    await bootstrapDirectory({
      directory: "/opencode",
      scope: ServerScope.local,
      mcp: false,
      global: {
        config: {} satisfies Config,
        path: { state: "", config: "", worktree: "/opencode", directory: "/opencode", home: "/home" },
        project: [{ id: "project", worktree: "/opencode" } as Project],
        provider,
      },
      sdk: {} as unknown as OpencodeClient,
      api: {
        ...api,
        provider: {
          list: async () => {
            throw cancelled
          },
        },
      } as unknown as ServerApi,
      store,
      setStore,
      vcsCache: { setStore() {} } as unknown as VcsCache,
      loadSessions() {},
      translate: (key) => key,
      queryClient: new QueryClient(),
      protocol: Promise.resolve("v2"),
    })

    await new Promise((resolve) => setTimeout(resolve, 80))

    expect(store.status).toBe("complete")
  })

  test("completes when optional bootstrap requests fail after the project is seeded", async () => {
    const [store, setStore] = directoryState()

    await bootstrapDirectory({
      directory: "/project",
      scope: ServerScope.local,
      mcp: true,
      global: {
        config: {} satisfies Config,
        path: { state: "", config: "", worktree: "/project", directory: "/project", home: "/home" },
        project: [{ id: "project", worktree: "/project" } as Project],
        provider,
      },
      sdk: {
        app: {
          agents: async () => {
            throw new Error("agents failed")
          },
        },
        config: {
          get: async () => {
            throw new Error("config failed")
          },
        },
        session: {
          status: async () => {
            throw new Error("status failed")
          },
        },
        vcs: {
          get: async () => {
            throw new Error("git failed")
          },
        },
        command: {
          list: async () => {
            throw new Error("commands failed")
          },
        },
        permission: {
          list: async () => {
            throw new Error("permission failed")
          },
        },
        question: {
          list: async () => {
            throw new Error("question failed")
          },
        },
        v2: { reference: { list: async () => ({ data: { data: [] } }) } },
        mcp: { status: async () => ({ data: {} }) },
        experimental: { resource: { list: async () => ({ data: {} }) } },
        provider: { list: async () => ({ data: { all: [], connected: [], default: {} } }) },
      } as unknown as OpencodeClient,
      api,
      store,
      setStore,
      vcsCache: { setStore() {} } as unknown as VcsCache,
      loadSessions() {},
      translate: (key) => key,
      queryClient: new QueryClient(),
      protocol: Promise.resolve("v1"),
    })

    await new Promise((resolve) => setTimeout(resolve, 80))

    expect(store.status).toBe("complete")
    expect(store.project).toBe("project")
  })

  test("skips legacy config while refreshing a v2 directory", async () => {
    const [store, setStore] = directoryState()

    await bootstrapDirectory({
      directory: "/project",
      scope: ServerScope.local,
      mcp: false,
      global: {
        config: {} satisfies Config,
        path: { state: "", config: "", worktree: "/project", directory: "/project", home: "/home" },
        project: [{ id: "project", worktree: "/project" } as Project],
        provider,
      },
      sdk: {
        config: {
          get: async () => {
            throw new Error("legacy directory config should not be called")
          },
        },
      } as unknown as OpencodeClient,
      api,
      store,
      setStore,
      vcsCache: { setStore() {} } as unknown as VcsCache,
      loadSessions() {},
      translate: (key) => key,
      queryClient: new QueryClient(),
      protocol: Promise.resolve("v2"),
    })

    expect(store.status).toBe("complete")
  })

  test("keeps a permission that arrived while an older empty snapshot was in flight", async () => {
    const session = createServerSession({} as OpencodeClient, { scope: String(ServerScope.local) })
    session.set("info", "ses_1", { id: "ses_1", directory: "/project" } as Session)
    let releaseOlder: (value: PermissionRequest[]) => void = () => undefined
    const older = new Promise<PermissionRequest[]>((resolve) => {
      releaseOlder = resolve
    })
    let calls = 0
    const sdk = permissionSdk(() => {
      calls += 1
      return calls === 1 ? older : Promise.resolve([permission("per_1")])
    })
    const input = directoryInput(session, sdk)

    const first = bootstrapDirectory(input)
    session.apply({
      type: "permission.asked",
      properties: permission("per_1"),
    })
    const second = bootstrapDirectory(input)
    await second
    releaseOlder([])
    await first

    expect(session.data.permission.ses_1).toEqual([permission("per_1")])
  })

  test("does not restore a replied permission from an older snapshot", async () => {
    const session = createServerSession({} as OpencodeClient, { scope: String(ServerScope.local) })
    session.set("info", "ses_1", { id: "ses_1", directory: "/project" } as Session)
    session.set("permission", "ses_1", [permission("per_1")])
    let releaseOlder: (value: PermissionRequest[]) => void = () => undefined
    const older = new Promise<PermissionRequest[]>((resolve) => {
      releaseOlder = resolve
    })
    let calls = 0
    const sdk = permissionSdk(() => {
      calls += 1
      return calls === 1 ? older : Promise.resolve([])
    })
    const input = directoryInput(session, sdk)

    const first = bootstrapDirectory(input)
    session.apply({
      type: "permission.replied",
      properties: { sessionID: "ses_1", requestID: "per_1" },
    })
    const second = bootstrapDirectory(input)
    await second
    releaseOlder([permission("per_1")])
    await first

    expect(session.data.permission.ses_1).toEqual([])
  })

  test("keeps a question that arrived while an older empty snapshot was in flight", async () => {
    const session = createServerSession({} as OpencodeClient, { scope: String(ServerScope.local) })
    session.set("info", "ses_1", { id: "ses_1", directory: "/project" } as Session)
    let releaseOlder: (value: QuestionRequest[]) => void = () => undefined
    const older = new Promise<QuestionRequest[]>((resolve) => {
      releaseOlder = resolve
    })
    let calls = 0
    const sdk = questionSdk(() => {
      calls += 1
      return calls === 1 ? older : Promise.resolve([question("que_1")])
    })
    const input = directoryInput(session, sdk)

    const first = bootstrapDirectory(input)
    session.apply({ type: "question.asked", properties: question("que_1") })
    const second = bootstrapDirectory(input)
    await second
    releaseOlder([])
    await first

    expect(session.data.question.ses_1).toEqual([question("que_1")])
  })

  test("drops an older prompt snapshot when no live event arrived", async () => {
    const [store, setStore] = directoryState()
    let releaseOlder: (value: PermissionRequest[]) => void = () => undefined
    const older = new Promise<PermissionRequest[]>((resolve) => {
      releaseOlder = resolve
    })
    let calls = 0
    const sdk = permissionSdk(() => {
      calls += 1
      return calls === 1 ? older : Promise.resolve([permission("per_new")])
    })

    const first = bootstrapDirectory({ ...directoryInput(undefined, sdk), store, setStore })
    const second = bootstrapDirectory({ ...directoryInput(undefined, sdk), store, setStore })
    await second
    releaseOlder([permission("per_old")])
    await first

    expect(store.permission.ses_1?.map((item) => item.id)).toEqual(["per_new"])
  })

  test("keeps a prompt marked before the session directory is known", async () => {
    const session = createServerSession({} as OpencodeClient, { scope: String(ServerScope.local) })
    let releaseOlder: (value: PermissionRequest[]) => void = () => undefined
    const older = new Promise<PermissionRequest[]>((resolve) => {
      releaseOlder = resolve
    })
    let calls = 0
    const sdk = permissionSdk(() => {
      calls += 1
      return calls === 1 ? older : Promise.resolve([])
    })
    const input = directoryInput(session, sdk)
    const first = bootstrapDirectory(input)
    session.apply({
      type: "session.created",
      properties: { info: { id: "ses_1", directory: "", title: "Session" } },
    })
    session.apply({ type: "permission.asked", properties: permission("per_early") })
    session.apply({
      type: "session.updated",
      properties: { info: { id: "ses_1", directory: "/project", title: "Session", time: {} } },
    })
    releaseOlder([])
    await first

    expect(session.data.permission.ses_1).toEqual([permission("per_early")])
  })

  test("keeps prompts isolated between servers that share a directory and session", async () => {
    const local = createServerSession({} as OpencodeClient, { scope: String(ServerScope.local) })
    const remote = createServerSession({} as OpencodeClient, { scope: "server-b" })
    local.set("info", "ses_1", { id: "ses_1", directory: "/project", title: "Local" } as Session)
    remote.set("info", "ses_1", { id: "ses_1", directory: "/project", title: "Remote" } as Session)
    let releaseLocal: (value: PermissionRequest[]) => void = () => undefined
    const localPending = new Promise<PermissionRequest[]>((resolve) => {
      releaseLocal = resolve
    })
    const localSdk = permissionSdk(() => localPending)
    const remoteSdk = permissionSdk(async () => [])
    const localInput = directoryInput(local, localSdk)
    const remoteInput = {
      ...directoryInput(remote, remoteSdk),
      scope: "server-b" as unknown as ServerScope,
    }

    const first = bootstrapDirectory(localInput)
    local.apply({ type: "permission.asked", properties: permission("per_local") })
    await bootstrapDirectory(remoteInput)
    releaseLocal([])
    await first

    expect(local.data.permission.ses_1).toEqual([permission("per_local")])
    expect(remote.data.permission.ses_1 ?? []).toEqual([])
  })

  test("keeps a question that was replied while an older snapshot was in flight", async () => {
    const session = createServerSession({} as OpencodeClient, { scope: String(ServerScope.local) })
    session.set("info", "ses_1", { id: "ses_1", directory: "/project" } as Session)
    session.set("question", "ses_1", [question("que_1")])
    let releaseOlder: (value: QuestionRequest[]) => void = () => undefined
    const older = new Promise<QuestionRequest[]>((resolve) => {
      releaseOlder = resolve
    })
    let calls = 0
    const sdk = questionSdk(() => {
      calls += 1
      return calls === 1 ? older : Promise.resolve([])
    })
    const input = directoryInput(session, sdk)

    const first = bootstrapDirectory(input)
    session.apply({
      type: "question.replied",
      properties: { sessionID: "ses_1", requestID: "que_1" },
    })
    const second = bootstrapDirectory(input)
    await second
    releaseOlder([question("que_1")])
    await first

    expect(session.data.question.ses_1).toEqual([])
  })

  test("keeps a rejected question from being restored by an older snapshot", async () => {
    const session = createServerSession({} as OpencodeClient, { scope: String(ServerScope.local) })
    session.set("info", "ses_1", { id: "ses_1", directory: "/project" } as Session)
    session.set("question", "ses_1", [question("que_1")])
    let releaseOlder: (value: QuestionRequest[]) => void = () => undefined
    const older = new Promise<QuestionRequest[]>((resolve) => {
      releaseOlder = resolve
    })
    const sdk = questionSdk(() => older)
    const input = directoryInput(session, sdk)

    const first = bootstrapDirectory(input)
    session.apply({
      type: "question.rejected",
      properties: { sessionID: "ses_1", requestID: "que_1" },
    })
    releaseOlder([question("que_1")])
    await first

    expect(session.data.question.ses_1).toEqual([])
  })

  test("does not let a failed newer request reopen an older empty snapshot", async () => {
    const session = createServerSession({} as OpencodeClient, { scope: String(ServerScope.local) })
    session.set("info", "ses_1", { id: "ses_1", directory: "/project" } as Session)
    session.set("permission", "ses_1", [permission("per_live")])
    let releaseOlder: (value: PermissionRequest[]) => void = () => undefined
    const older = new Promise<PermissionRequest[]>((resolve) => {
      releaseOlder = resolve
    })
    let calls = 0
    const sdk = permissionSdk(() => {
      calls += 1
      if (calls === 1) return older
      return Promise.reject(new Error("permission list failed"))
    })
    const input = directoryInput(session, sdk)

    const first = bootstrapDirectory(input)
    const second = bootstrapDirectory(input)
    await second
    releaseOlder([])
    await first

    expect(session.data.permission.ses_1).toEqual([permission("per_live")])
  })

  test("keeps a store prompt marked before the session directory is known", async () => {
    const [store, setStore] = directoryState()
    let releaseOlder: (value: PermissionRequest[]) => void = () => undefined
    const older = new Promise<PermissionRequest[]>((resolve) => {
      releaseOlder = resolve
    })
    const sdk = permissionSdk(() => older)
    const input = { ...directoryInput(undefined, sdk), store, setStore }
    const first = bootstrapDirectory(input)
    setStore("permission", "ses_1", [permission("per_early")])
    notePrompt({
      scope: String(ServerScope.local),
      kind: "permission",
      directory: "",
      id: "ses_1",
    })
    notePrompt({
      scope: String(ServerScope.local),
      kind: "permission",
      directory: "/project",
      id: "ses_1",
    })
    releaseOlder([])
    await first

    expect(store.permission.ses_1).toEqual([permission("per_early")])
  })

  test("applies a snapshot from a recreated server context after the old context is disposed", async () => {
    const session = createServerSession({} as OpencodeClient, { scope: String(ServerScope.local) })
    session.set("info", "ses_1", { id: "ses_1", directory: "/project" } as Session)
    session.set("permission", "ses_1", [permission("per_live")])
    let releaseOlder: (value: PermissionRequest[]) => void = () => undefined
    const older = new Promise<PermissionRequest[]>((resolve) => {
      releaseOlder = resolve
    })
    let calls = 0
    const sdk = permissionSdk(() => {
      calls += 1
      if (calls === 1) return older
      return Promise.resolve([permission("per_new")])
    })
    const input = directoryInput(session, sdk)
    const first = bootstrapDirectory(input)
    disposePromptScope(String(ServerScope.local))
    const second = bootstrapDirectory(input)
    await second
    releaseOlder([])
    await first

    expect(session.data.permission.ses_1).toEqual([permission("per_new")])
  })

  test("ignores an older snapshot after the server context is disposed", async () => {
    const session = createServerSession({} as OpencodeClient, { scope: String(ServerScope.local) })
    session.set("info", "ses_1", { id: "ses_1", directory: "/project" } as Session)
    session.set("permission", "ses_1", [permission("per_live")])
    let releaseOlder: (value: PermissionRequest[]) => void = () => undefined
    const older = new Promise<PermissionRequest[]>((resolve) => {
      releaseOlder = resolve
    })
    const sdk = permissionSdk(() => older)
    const input = directoryInput(session, sdk)
    const first = bootstrapDirectory(input)
    disposePromptScope(String(ServerScope.local))
    releaseOlder([])
    await first

    expect(session.data.permission.ses_1).toEqual([permission("per_live")])
  })
})

function permission(id: string): PermissionRequest {
  return { id, sessionID: "ses_1" } as PermissionRequest
}

function question(id: string): QuestionRequest {
  return { id, sessionID: "ses_1" } as QuestionRequest
}

function permissionSdk(list: () => Promise<PermissionRequest[]>) {
  return {
    permission: { list: async () => ({ data: await list() }) },
    question: { list: async () => ({ data: [] }) },
    session: {
      get: async () => ({ data: { id: "ses_1", directory: "/project", title: "Session" } }),
    },
    config: { get: async () => ({ data: {} }) },
    vcs: { get: async () => ({ data: undefined }) },
    app: { agents: async () => ({ data: [] }) },
    command: { list: async () => ({ data: [] }) },
    mcp: { status: async () => ({ data: {} }) },
    experimental: { resource: { list: async () => ({ data: {} }) } },
    provider: { list: async () => ({ data: { all: [], connected: [], default: {} } }) },
  } as unknown as OpencodeClient
}

function questionSdk(list: () => Promise<QuestionRequest[]>) {
  const sdk = permissionSdk(async () => [])
  return {
    ...sdk,
    question: { list: async () => ({ data: await list() }) },
  } as OpencodeClient
}

function directoryInput(session: ReturnType<typeof createServerSession> | undefined, sdk: OpencodeClient) {
  const [store, setStore] = directoryState()
  return {
    directory: "/project",
    scope: ServerScope.local,
    mcp: false,
    global: {
      config: {} satisfies Config,
      path: { state: "", config: "", worktree: "/project", directory: "/project", home: "/home" },
      project: [{ id: "project", worktree: "/project" } as Project],
      provider,
    },
    sdk,
    api,
    store,
    setStore,
    session,
    vcsCache: { setStore() {} } as unknown as VcsCache,
    loadSessions() {},
    translate: (key: string) => key,
    queryClient: new QueryClient(),
    protocol: Promise.resolve("v1" as const),
  }
}

describe("config queries", () => {
  test("loads global config for v2 servers", async () => {
    const config = { mcp: { docs: { type: "remote", url: "https://mcp.invalid" } } } satisfies Config
    const sdk = {
      global: {
        config: {
          get: async () => ({ data: config }),
        },
      },
    } as unknown as OpencodeClient

    const result = await new QueryClient().fetchQuery(
      loadGlobalConfigQuery(ServerScope.local, sdk, Promise.resolve("v2")),
    )

    expect(result).toEqual(config)
  })

  test("loads legacy global config for v1 servers", async () => {
    const calls: string[] = []
    const config = { shell: "zsh" } satisfies Config
    const sdk = {
      global: {
        config: {
          get: async () => {
            calls.push("global")
            return { data: config }
          },
        },
      },
    } as unknown as OpencodeClient

    const result = await new QueryClient().fetchQuery(
      loadGlobalConfigQuery(ServerScope.local, sdk, Promise.resolve("v1")),
    )

    expect(result).toEqual(config)
    expect(calls).toEqual(["global"])
  })
})

describe("query keys", () => {
  test("partitions identical directories by server scope", () => {
    const client = {} as Parameters<typeof loadPathQuery>[2]
    const api = {} as CatalogApi
    const remote = "https://debian.example" as typeof ServerScope.local

    expect([...loadPathQuery(ServerScope.local, "/repo", client).queryKey]).toEqual(["local", "/repo", "path"])
    expect([...loadPathQuery(remote, "/repo", client).queryKey]).toEqual(["https://debian.example", "/repo", "path"])
    expect([...loadProvidersQuery(remote, null, api).queryKey]).toEqual(["https://debian.example", null, "providers"])
  })

  test("loads the current provider and model catalog", async () => {
    const calls: unknown[] = []
    const api = {
      providers: {
        list: async (input: unknown) => {
          calls.push(["provider", input])
          return { location: {}, data: [{ id: "openai", name: "OpenAI", api: { id: "openai", name: "OpenAI", npm: "@ai-sdk/openai", env: [], settings: {} } }] }
        },
      },
      models: {
        list: async (input: unknown) => {
          calls.push(["model", input])
          return { location: {}, data: [] }
        },
      },
    } as unknown as CatalogApi

    const result = await new QueryClient().fetchQuery(loadProvidersQuery(ServerScope.local, "/repo", api))

    expect(calls).toEqual([
      ["provider", { location: { directory: "/repo" } }],
      ["model", { location: { directory: "/repo" } }],
    ])
    expect(result.connected).toEqual(["openai"])
  })

  test("loads agents from the current location-scoped endpoint", async () => {
    const calls: unknown[] = []
    const api = {
      list: async (input: unknown) => {
        calls.push(input)
        return { location: {}, data: [] }
      },
    } as unknown as AgentApi

    const result = await new QueryClient().fetchQuery(loadAgentsQuery(ServerScope.local, "/repo", api))

    expect(calls).toEqual([{ location: { directory: "/repo" } }])
    expect(result).toEqual([])
  })

  test("loads commands from the current location-scoped endpoint", async () => {
    const calls: unknown[] = []
    const api = {
      list: async (input: unknown) => {
        calls.push(input)
        return {
          location: {},
          data: [{ name: "review", template: "Review files" /* source: "command" as const */ }],
        }
      },
    } as unknown as CommandApi

    const result = await loadCommands("/repo", api)

    expect(calls).toEqual([{ location: { directory: "/repo" } }])
    expect(result).toEqual([{ name: "review", template: "Review files" /* source: "command" */ }])
  })

  test("loads projects from the current endpoint", async () => {
    const api = {
        list: async () => ({ data: [
          { id: "b", worktree: "/b", time: { created: 1, updated: 1 }, sandboxes: [] },
          { id: "a", worktree: "/a", time: { created: 1, updated: 1 }, sandboxes: [] },
        ] }),
    } as unknown as ProjectApi

    const result = await new QueryClient().fetchQuery(loadProjectsQuery(ServerScope.local, api))

    expect(result.map((project) => project.id)).toEqual(["a", "b"])
  })

  test("loads references from the current location-scoped endpoint", async () => {
    const calls: unknown[] = []
    const api = {
      list: async (input: unknown) => {
        calls.push(input)
        return { location: {}, data: [{ name: "AGENTS.md", path: "/repo/AGENTS.md", source: "instructions" }] }
      },
    } as unknown as ReferenceApi

    const result = await new QueryClient().fetchQuery(loadReferencesQuery(ServerScope.local, "/repo", api))

    expect(calls).toEqual([{ location: { directory: "/repo" } }])
    expect(result).toHaveLength(1)
  })
})
