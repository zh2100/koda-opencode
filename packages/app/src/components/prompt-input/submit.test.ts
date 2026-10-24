import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { createStore } from "solid-js/store"
import type { Prompt, PromptStore } from "@/context/prompt"
import type { ModelSelection } from "@/context/local"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { Worktree } from "@/utils/worktree"
import { ServerScope } from "@/utils/server-scope"

let createPromptSubmit: typeof import("./submit").createPromptSubmit
let resetCollaborationState: typeof import("./submit").resetCollaborationState

const createdClients: string[] = []
const createdSessions: string[] = []
const sessionCreateInputs: Array<{
  agent?: string
  model?: { id: string; providerID: string; variant?: string }
  location?: { directory: string }
}> = []
const enabledAutoAccept: Array<{ server: string; sessionID: string; directory: string }> = []
const optimistic: Array<{
  directory?: string
  sessionID?: string
  message: {
    agent: string
    model: { providerID: string; modelID: string }
    variant?: string
  }
}> = []
const optimisticSeeded: boolean[] = []
const storedSessions: Record<string, Array<{ id: string; title?: string }>> = {}
const promoted: Array<{ directory: string; sessionID: string }> = []
const sentShell: Array<{ sessionID: string; id?: string; command: string }> = []
const syncedDirectories: string[] = []
const promotedDrafts: Array<{ draftID: string; server: string; sessionId: string }> = []
const sentPrompts: string[] = []
const promptInputs: unknown[] = []
const sentCommands: unknown[] = []
const interrupted: string[] = []
const commands: Array<{ name: string }> = []
let serverSessionSyncs = 0

let params: { id?: string } = {}
let search: { draftId?: string } = {}
let selected = "/repo/worktree-a"
let variant: string | undefined
let permissionServer = "server-a"
let createSessionGate: Promise<void> | undefined
let worker = "provider/worker"
let collaborationEnabled = false
let launchStatus = 200
let launchGate: Promise<void> | undefined
const launches: Array<{ url: string; body: Record<string, unknown> }> = []
const sessions = new Map<string, Session>()

let promptValue: Prompt = [{ type: "text", content: "ls", start: 0, end: 2 }]
const [promptStore, setPromptStore] = createStore<PromptStore>({
  prompt: promptValue,
  cursor: 0,
  context: { items: [] },
})
const prompt = {
  store: [() => promptStore, setPromptStore] as [() => PromptStore, typeof setPromptStore],
  ready: Object.assign(() => true, { promise: Promise.resolve(true) }),
  current: () => promptValue,
  cursor: () => 0,
  dirty: () => true,
  model: {
    current: () => undefined,
    set: () => undefined,
  },
  reset: () => {
    promptValue = [{ type: "text", content: "", start: 0, end: 0 }]
  },
  set: (value: Prompt) => {
    promptValue = value
  },
  context: {
    add: () => undefined,
    remove: () => undefined,
    removeComment: () => undefined,
    updateComment: () => undefined,
    replaceComments: () => undefined,
    items: () => [],
  },
  capture: () => prompt,
}

const clientFor = (directory: string) => {
  createdClients.push(directory)
  return {
    api: {
      sessions: {
        switchAgent: async () => undefined,
        switchModel: async () => undefined,
        prompt: async (input: unknown) => {
          sentPrompts.push(directory)
          promptInputs.push(input)
          return { data: undefined }
        },
      },
      session: {
        interrupt: async (input: { sessionID: string }) => {
          interrupted.push(input.sessionID)
        },
        create: async (input: (typeof sessionCreateInputs)[number]) => {
          await createSessionGate
          const location = input.location?.directory ?? directory
          createdSessions.push(location)
          sessionCreateInputs.push(input)
          return {
            id: `session-${createdSessions.length}`,
            projectID: "project",
            agent: input.agent,
            model: input.model,
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 1, updated: 1 },
            title: `New session ${createdSessions.length}`,
            location: { directory: location },
          }
        },
        prompt: async (input: unknown) => {
          sentPrompts.push(directory)
          promptInputs.push(input)
          return { data: undefined }
        },
        command: async (input: unknown) => {
          sentCommands.push(input)
        },
        shell: async (input: { sessionID: string; id?: string; command: string }) => {
          sentShell.push(input)
        },
      },
    },
    v2: {
      session: {
        interrupt: async (input: { sessionID: string }) => {
          interrupted.push(input.sessionID)
        },
        create: async (input: (typeof sessionCreateInputs)[number]) => {
          await createSessionGate
          const location = input.location?.directory ?? directory
          createdSessions.push(location)
          sessionCreateInputs.push(input)
          return {
            data: {
              data: {
                id: `session-${createdSessions.length}`,
                projectID: "project",
                agent: input.agent,
                model: input.model,
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                time: { created: 1, updated: 1 },
                title: `New session ${createdSessions.length}`,
                location: { directory: location },
              },
            },
          }
        },
      },
    },
    session: {
      prompt: async (input: unknown) => {
        sentPrompts.push(directory)
        promptInputs.push(input)
        return { data: undefined }
      },
      command: async (input: unknown) => {
        sentCommands.push(input)
        return { data: undefined }
      },
      shell: async (input: { sessionID: string; messageID?: string; command: string }) => {
        sentShell.push(input)
      },
      abort: async () => ({ data: undefined }),
    },
    worktree: {
      create: async () => ({ data: { directory: `${directory}/new` } }),
    },
  }
}

beforeAll(async () => {
  const rootClient = clientFor("/repo/main")
  mock.module("@/utils/toast", () => ({ showToast: () => 0, dismissToast: () => {} }))
  mock.module("@/context/settings", () => ({
    useSettings: () => ({
      collaboration: {
        models: {
          get worker() {
            return worker
          },
        },
        enabled: () => collaborationEnabled,
        ready: () => true,
      },
    }),
  }))
  mock.module("@/context/server-sdk", () => ({
    useServerSDK: () => () => ({ server: { http: { url: "http://localhost:4096" } } }),
  }))

  mock.module("@solidjs/router", () => ({
    useNavigate: () => () => undefined,
    useParams: () => params,
    useLocation: () => ({}),
    useSearchParams: () => [search, () => undefined],
  }))

  mock.module("@opencode-ai/sdk/v2/client", () => ({
    createOpencodeClient: (input: { directory: string }) => {
      createdClients.push(input.directory)
      return clientFor(input.directory)
    },
  }))

  mock.module("@opencode-ai/ui/toast", () => ({
    Toast: { Region: () => null },
    showToast: () => 0,
  }))

  const encode = await import("@opencode-ai/core/util/encode")
  mock.module("@opencode-ai/core/util/encode", () => ({
    ...encode,
    base64Encode: (value: string) => value,
  }))

  mock.module("@/context/local", () => ({
    useLocal: () => ({
      model: {
        current: () => ({ id: "model", provider: { id: "provider" } }),
        variant: { current: () => variant },
      },
      agent: {
        current: () => ({ name: "agent" }),
      },
      session: {
        promote(directory: string, sessionID: string) {
          promoted.push({ directory, sessionID })
        },
      },
    }),
  }))

  mock.module("@/context/permission", () => {
    const state = (server: string) => ({
      enableAutoAccept(sessionID: string, directory: string) {
        enabledAutoAccept.push({ server, sessionID, directory })
      },
    })
    return { usePermission: () => ({ currentServerState: () => state(permissionServer) }) }
  })

  mock.module("@/context/server", () => ({
    useServer: () => ({ key: "server-key" }),
  }))

  mock.module("@/context/tabs", () => ({
    useTabs: () => ({
      draft: () => ({ server: "project-server" }),
      promoteDraft: (draftID: string, session: { server: string; sessionId: string }) => {
        promotedDrafts.push({ draftID, ...session })
      },
    }),
  }))

  mock.module("@/context/layout", () => ({
    useLayout: () => ({
      projects: { list: () => [{ worktree: "/repo/main" }, { worktree: selected }] },
      handoff: {
        setTabs: () => undefined,
      },
    }),
  }))

  mock.module("@/context/sdk", () => ({
    useSDK: () => {
      const sdk = {
        scope: "local",
        directory: "/repo/main",
        client: rootClient,
        api: rootClient.api,
        protocol: Promise.resolve("v2"),
        url: "http://localhost:4096",
        createClient(opts: any) {
          return clientFor(opts.directory)
        },
      }
      return () => sdk
    },
  }))

  mock.module("@/context/sync", () => ({
    useSync: () => () => ({
      data: { command: commands },
      session: {
        optimistic: {
          add: (value: {
            directory?: string
            sessionID?: string
            message: { agent: string; model: { providerID: string; modelID: string; variant?: string } }
          }) => {
            optimistic.push(value)
            optimisticSeeded.push(
              !!value.directory &&
                !!value.sessionID &&
                !!storedSessions[value.directory]?.find((item) => item.id === value.sessionID)?.title,
            )
          },
          remove: () => undefined,
        },
      },
      set: () => undefined,
    }),
  }))

  mock.module("@/context/server-sync", () => ({
    useServerSync: () => () => ({
      session: {
        remember: (session: Session) => sessions.set(session.id, session),
        get: (id: string) => sessions.get(id),
        set: () => undefined,
        sync: async () => {
          serverSessionSyncs++
        },
      },
      child: (directory: string) => {
        syncedDirectories.push(directory)
        storedSessions[directory] ??= []
        return [
          { session: storedSessions[directory] },
          (...args: unknown[]) => {
            if (args[0] !== "session") return
            const next = args[1]
            if (typeof next === "function") {
              storedSessions[directory] = next(storedSessions[directory]) as Array<{ id: string; title?: string }>
              return
            }
            if (Array.isArray(next)) {
              storedSessions[directory] = next as Array<{ id: string; title?: string }>
            }
          },
        ]
      },
    }),
  }))

  mock.module("@/context/platform", () => ({
    usePlatform: () => ({
      fetch: async (url: URL, init: RequestInit) => {
        if (init.method !== "POST")
          return new Response(JSON.stringify({ id: "task", status: "completed" }), {
            headers: { "content-type": "application/json" },
          })
        launches.push({ url: String(url), body: JSON.parse(String(init.body)) })
        await launchGate
        if (launchStatus === 0) throw new Error("offline")
        if (launchStatus !== 200) return new Response(null, { status: launchStatus })
        return new Response(JSON.stringify({ id: "task", status: "pending" }), {
          headers: { "content-type": "application/json" },
        })
      },
    }),
  }))

  mock.module("@/context/language", () => ({
    useLanguage: () => ({
      t: (key: string) => key,
    }),
  }))

  const { isPromptEqual } = await import("@/context/prompt-state")
  mock.module("@/context/prompt", () => ({ usePrompt: () => prompt, isPromptEqual }))
  const mod = await import("./submit")
  createPromptSubmit = mod.createPromptSubmit
  resetCollaborationState = mod.resetCollaborationState
})

beforeEach(() => {
  resetCollaborationState()
  createdClients.length = 0
  createdSessions.length = 0
  sessionCreateInputs.length = 0
  enabledAutoAccept.length = 0
  optimistic.length = 0
  optimisticSeeded.length = 0
  promoted.length = 0
  promotedDrafts.length = 0
  sentPrompts.length = 0
  promptInputs.length = 0
  sentCommands.length = 0
  commands.length = 0
  promptValue = [{ type: "text", content: "ls", start: 0, end: 2 }]
  params = {}
  search = {}
  sentShell.length = 0
  syncedDirectories.length = 0
  selected = "/repo/worktree-a"
  variant = undefined
  permissionServer = "server-a"
  createSessionGate = undefined
  launchGate = undefined
  launchStatus = 200
  worker = "provider/worker"
  launches.length = 0
  sessions.clear()
  serverSessionSyncs = 0
  for (const key of Object.keys(storedSessions)) delete storedSessions[key]
})

describe("collaboration submission", () => {
  const parallel = "refactor src/api/a.ts and src/web/b.ts in parallel"
  const make = (working = () => false) =>
    createPromptSubmit({
      prompt,
      info: () => (params.id ? sessions.get(params.id) : undefined),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: () => 2,
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      shouldQueue: () => true,
      onQueue: () => {
        throw new Error("must not queue collaboration")
      },
    })

  test("promotes a fresh draft and launches only the current task in the selected workspace", async () => {
    promptValue = [{ type: "text", content: parallel, start: 0, end: parallel.length }]
    search = { draftId: "draft" }
    const submit = make()
    collaborationEnabled = true
    await submit.handleSubmit(new Event("submit"))
    expect(launches).toHaveLength(1)
    expect(launches[0].body).toMatchObject({
      sessionID: "session-1",
      projectID: "project",
      prompt: parallel,
      workspaceKey: "directory:/repo/worktree-a",
      models: { worker: "provider/worker" },
    })
    expect(sessionCreateInputs[0].model).toMatchObject({ id: "worker", providerID: "provider" })
    expect(promotedDrafts).toHaveLength(1)
    expect(sentPrompts).toHaveLength(0)
    expect(sentCommands).toHaveLength(0)
    expect(promptValue[0]).toMatchObject({ content: "" })
    expect(submit.collaboration.state.busy).toBe(false)
  })

  test("keeps collaboration enabled when the composer remounts for the promoted session", async () => {
    search = { draftId: "draft" }
    collaborationEnabled = true
    const draft = make()
    await draft.handleSubmit(new Event("submit"))

    params = { id: "session-1" }
    const session = make()
    expect(collaborationEnabled).toBe(true)
  })

  test("keeps collaboration enabled when an existing session composer remounts", () => {
    params = { id: "session-1" }
    collaborationEnabled = true
    const first = make()
    const second = make()
    expect(collaborationEnabled).toBe(true)
  })

  test("keeps interrupt available with collaboration enabled without launching another task", async () => {
    interrupted.length = 0
    params = { id: "running-session" }
    const submit = make(() => true)
    collaborationEnabled = true
    expect(submit.collaboration.blocked()).toBe(true)
    await submit.handleSubmit(new Event("submit"))
    expect(interrupted).toHaveLength(0)
    promptValue = [{ type: "text", content: "", start: 0, end: 0 }]
    worker = ""
    await submit.handleSubmit(new Event("submit"))
    expect(interrupted).toEqual(["running-session"])
    expect(launches).toHaveLength(0)
    expect(createdSessions).toHaveLength(0)
    expect(sentPrompts).toHaveLength(0)
  })

  test.each([400, 500, 0])("preserves task and releases busy on launch failure %s", async (status) => {
    promptValue = [{ type: "text", content: parallel, start: 0, end: parallel.length }]
    launchStatus = status
    const submit = make()
    collaborationEnabled = true
    await submit.handleSubmit(new Event("submit"))
    expect(promptValue[0]).toMatchObject({ content: parallel })
    expect(submit.collaboration.state.busy).toBe(false)
    expect(sentPrompts).toHaveLength(0)
  })

  test("blocks double submission during session creation and preserves concurrent edits", async () => {
    promptValue = [{ type: "text", content: parallel, start: 0, end: parallel.length }]
    let release!: () => void
    createSessionGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const submit = make()
    collaborationEnabled = true
    const first = submit.handleSubmit(new Event("submit"))
    await submit.handleSubmit(new Event("submit"))
    promptValue = [{ type: "text", content: "next", start: 0, end: 4 }]
    release()
    await first
    expect(createdSessions).toHaveLength(1)
    expect(launches).toHaveLength(1)
    expect(launches[0].body.prompt).toBe(parallel)
    expect(promptValue[0]).toMatchObject({ content: "next" })
  })

  test("requires worker and rejects non-text inputs before creating a session", async () => {
    promptValue = [{ type: "text", content: parallel, start: 0, end: parallel.length }]
    const submit = make()
    collaborationEnabled = true
    worker = ""
    await submit.handleSubmit(new Event("submit"))
    worker = "provider/worker"
    promptValue = [{ type: "agent", name: "build", content: `@build ${parallel}`, start: 0, end: parallel.length + 7 }]
    await submit.handleSubmit(new Event("submit"))
    expect(createdSessions).toHaveLength(0)
    expect(launches).toHaveLength(0)
  })

  test("uses the existing session directory and does not interpret slash commands", async () => {
    promptValue = [{ type: "text", content: parallel, start: 0, end: parallel.length }]
    collaborationEnabled = true
    const initial = make()
    await initial.handleSubmit(new Event("submit"))
    params = { id: "session-1" }
    promptValue = [{ type: "text", content: `/review ${parallel}`, start: 0, end: parallel.length + 8 }]
    commands.push({ name: "review" })
    const submit = make()
    expect(collaborationEnabled).toBe(true)
    await submit.handleSubmit(new Event("submit"))
    expect(createdSessions).toHaveLength(1)
    expect(launches[1].body).toMatchObject({
      sessionID: "session-1",
      workspaceKey: "directory:/repo/worktree-a",
      prompt: `/review ${parallel}`,
    })
    expect(sentCommands).toHaveLength(0)
    expect(sentPrompts).toHaveLength(0)
  })

  test("preserves edits and blocks duplicate sends while the launch is pending", async () => {
    promptValue = [{ type: "text", content: parallel, start: 0, end: parallel.length }]
    let release!: () => void
    launchGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const submit = make()
    collaborationEnabled = true
    const first = submit.handleSubmit(new Event("submit"))
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    await submit.handleSubmit(new Event("submit"))
    promptValue = [{ type: "text", content: "next", start: 0, end: 4 }]
    release()
    await first
    expect(launches).toHaveLength(1)
    expect(promptValue[0]).toMatchObject({ content: "next" })
    expect(submit.collaboration.state.busy).toBe(false)
  })

  test("allows interrupt while a collaboration launch is pending but still blocks duplicate launch", async () => {
    promptValue = [{ type: "text", content: parallel, start: 0, end: parallel.length }]
    interrupted.length = 0
    let working = false
    let release!: () => void
    launchGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const submit = make(() => working)
    collaborationEnabled = true
    const first = submit.handleSubmit(new Event("submit"))
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    params.id = "session-1"
    working = true
    await submit.handleSubmit(new Event("submit"))
    promptValue = [{ type: "text", content: "", start: 0, end: 0 }]
    await submit.handleSubmit(new Event("submit"))
    expect(interrupted).toEqual(["session-1"])
    expect(submit.collaboration.state.busy).toBe(true)
    release()
    await first
    expect(launches).toHaveLength(1)
    expect(submit.collaboration.state.busy).toBe(false)
  })

  test("waits for a newly created worktree before launch", async () => {
    promptValue = [{ type: "text", content: parallel, start: 0, end: parallel.length }]
    selected = "create"
    const submit = make()
    collaborationEnabled = true
    const result = submit.handleSubmit(new Event("submit"))
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    expect(launches).toHaveLength(0)
    Worktree.ready(ServerScope.local, "/repo/main/new")
    await result
    expect(launches[0].body.workspaceKey).toBe("directory:/repo/main/new")
    expect(submit.collaboration.state.busy).toBe(false)
  })
})

describe("prompt submit worktree selection", () => {
  test("reads the latest worktree accessor value per submit", async () => {
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)
    selected = "/repo/worktree-b"
    promptValue = [{ type: "text", content: "ls", start: 0, end: 2 }]
    await submit.handleSubmit(event)

    expect(createdClients).toEqual(["/repo/worktree-a", "/repo/worktree-b"])
    expect(createdSessions).toEqual(["/repo/worktree-a", "/repo/worktree-b"])
    expect(sessionCreateInputs).toEqual([
      {
        agent: "agent",
        model: { id: "model", providerID: "provider", variant: undefined },
        location: { directory: "/repo/worktree-a" },
      },
      {
        agent: "agent",
        model: { id: "model", providerID: "provider", variant: undefined },
        location: { directory: "/repo/worktree-b" },
      },
    ])
    expect(sentShell).toEqual([
      expect.objectContaining({
        sessionID: "session-1",
        messageID: expect.stringMatching(/^evt_/),
        command: "ls",
        model: { providerID: "provider", modelID: "model" },
      }),
      expect.objectContaining({
        sessionID: "session-2",
        messageID: expect.stringMatching(/^evt_/),
        command: "ls",
        model: { providerID: "provider", modelID: "model" },
      }),
    ])
    expect(syncedDirectories).toEqual(["/repo/worktree-a", "/repo/worktree-a", "/repo/worktree-b", "/repo/worktree-b"])
    expect(serverSessionSyncs).toBe(0)
    expect(promoted).toEqual([
      { directory: "/repo/worktree-a", sessionID: "session-1" },
      { directory: "/repo/worktree-b", sessionID: "session-2" },
    ])
    expect(syncedDirectories).toEqual(["/repo/worktree-a", "/repo/worktree-a", "/repo/worktree-b", "/repo/worktree-b"])
  })

  test("applies auto-accept to newly created sessions", async () => {
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => true,
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)

    expect(enabledAutoAccept).toEqual([{ server: "server-a", sessionID: "session-1", directory: "/repo/worktree-a" }])
  })

  test("keeps auto-accept bound to the submission server", async () => {
    let release = () => {}
    createSessionGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => true,
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const result = submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    permissionServer = "server-b"
    release()
    await result

    expect(enabledAutoAccept).toEqual([{ server: "server-a", sessionID: "session-1", directory: "/repo/worktree-a" }])
  })

  test("promotes drafts using the selected project's server", async () => {
    search = { draftId: "draft-1" }
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(promotedDrafts).toEqual([{ draftID: "draft-1", server: "project-server", sessionId: "session-1" }])
  })

  test("includes the selected variant on optimistic prompts", async () => {
    params = { id: "session-1" }
    variant = "high"

    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)
    await Bun.sleep(0)

    expect(optimistic).toHaveLength(1)
    expect(optimistic[0]).toMatchObject({
      message: {
        agent: "agent",
        model: { providerID: "provider", modelID: "model", variant: "high" },
      },
    })
    expect(sentPrompts).toEqual(["/repo/main"])
    expect(promptInputs[0]).toMatchObject({
      sessionID: "session-1",
      id: expect.stringMatching(/^msg_/),
      prompt: { text: "ls" },
    })
  })

  test("submits slash commands through the current session API", async () => {
    params = { id: "session-1" }
    variant = "high"
    commands.push({ name: "review" })
    promptValue = [{ type: "text", content: "/review staged changes", start: 0, end: 22 }]

    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await Bun.sleep(0)

    expect(sentCommands).toEqual([])
    expect(promptInputs[0]).toMatchObject({
      sessionID: "session-1",
      id: expect.stringMatching(/^msg_/),
      prompt: { text: "/review staged changes" },
    })
    expect(serverSessionSyncs).toBe(0)
  })

  test("uses an injected model selection", async () => {
    params = { id: "session-1" }
    const model = {
      current: () => ({ id: "draft-model", provider: { id: "draft-provider" } }),
      variant: { current: () => "draft-variant" },
    } as unknown as ModelSelection
    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      model,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(optimistic[0]).toMatchObject({
      message: {
        model: { providerID: "draft-provider", modelID: "draft-model", variant: "draft-variant" },
      },
    })
  })

  test("seeds new sessions before optimistic prompts are added", async () => {
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)

    expect(storedSessions["/repo/worktree-a"]).toHaveLength(1)
    expect(storedSessions["/repo/worktree-a"]?.[0]).toMatchObject({ id: "session-1", title: "New session 1" })
    expect(optimisticSeeded).toEqual([true])
  })
})
