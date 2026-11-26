import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { createStore } from "solid-js/store"
import { createRoot } from "solid-js"
import type { Prompt, PromptStore } from "@/context/prompt"
import type { ModelSelection } from "@/context/local"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { Worktree } from "@/utils/worktree"
import { ServerScope } from "@/utils/server-scope"

let createPromptSubmit: typeof import("./submit").createPromptSubmit

const deliveries: Array<{ kind: string; directory: string; server: string }> = []
let activeServer = "server-a"
let protocol: "v1" | "v2" = "v2"
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
const legacyAbort = mock(async (_input: { sessionID: string }) => ({ data: true }))
const commands: Array<{ name: string }> = []
const resolvedSessions: string[] = []
const toasts: Array<{ title: string; description?: string }> = []
let serverSessionSyncs = 0

let params: { id?: string } = {}
let search: { draftId?: string } = {}
let selected = "/repo/worktree-a"
let variant: string | undefined
let localModel: { id: string; provider: { id: string } } | undefined
let localAgent: { name: string } | undefined
let permissionServer = "server-a"
let createSessionGate: Promise<void> | undefined
let resolveSessionGate: Promise<void> | undefined
let releaseResolveSession: (() => void) | undefined
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

const clientFor = (directory: string, server = activeServer) => {
  createdClients.push(directory)
  return {
    api: {
      sessions: {
        switchAgent: async () => undefined,
        switchModel: async () => undefined,
        prompt: async (input: unknown) => {
          sentPrompts.push(directory)
          deliveries.push({ kind: "prompt", directory, server })
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
          deliveries.push({ kind: "prompt", directory, server })
          promptInputs.push(input)
          return { data: undefined }
        },
        command: async (input: unknown) => {
          sentCommands.push(input)
          deliveries.push({ kind: "command", directory, server })
        },
        shell: async (input: { sessionID: string; id?: string; command: string }) => {
          sentShell.push(input)
          deliveries.push({ kind: "shell", directory, server })
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
        deliveries.push({ kind: "prompt", directory, server })
        promptInputs.push(input)
        return { data: undefined }
      },
      command: async (input: unknown) => {
        sentCommands.push(input)
        deliveries.push({ kind: "command", directory, server })
        return { data: undefined }
      },
      shell: async (input: { sessionID: string; messageID?: string; command: string }) => {
        sentShell.push(input)
        deliveries.push({ kind: "shell", directory, server })
      },
      abort: legacyAbort,
    },
    worktree: {
      create: async () => ({ data: { directory: `${directory}/new` } }),
    },
  }
}

beforeAll(async () => {
  const rootClient = clientFor("/repo/main")
  mock.module("@/utils/toast", () => ({
    showToast: (toast: (typeof toasts)[number]) => {
      toasts.push(toast)
      return 0
    },
    dismissToast: () => {},
  }))
  mock.module("@/context/server-sdk", () => ({
    useServerSDK: () => () => {
      const server = activeServer
      return {
        scope: server,
        server: { http: { url: "http://localhost:4096" } },
        ensureDirSdkContext: (directory: string) => {
          const client = clientFor(directory, server)
          return {
            directory,
            client,
            api: client.api,
            protocol: Promise.resolve(protocol),
          }
        },
      }
    },
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
        current: () => localModel,
        variant: { current: () => variant },
      },
      agent: {
        current: () => localAgent,
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
        protocol: Promise.resolve(protocol),
        url: "http://localhost:4096",
        createClient(opts: any) {
          return clientFor(opts.directory)
        },
      }
      return () =>
        activeServer === "server-a" ? sdk : { ...sdk, client: clientFor("/repo/server-b"), directory: "/repo/server-b" }
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
      ensureDirSyncContext: () => ({
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
      }),
      session: {
        remember: (session: Session) => sessions.set(session.id, session),
        get: (id: string) => sessions.get(id),
        resolve: async (id: string) => {
          resolvedSessions.push(id)
          await resolveSessionGate
          const session = sessions.get(id)
          if (!session) throw new Error("Session not found")
          return session
        },
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
})

beforeEach(() => {
  legacyAbort.mockClear()
  interrupted.length = 0
  deliveries.length = 0
  activeServer = "server-a"
  protocol = "v2"
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
  localModel = { id: "model", provider: { id: "provider" } }
  localAgent = { name: "agent" }
  permissionServer = "server-a"
  createSessionGate = undefined
  resolveSessionGate = undefined
  releaseResolveSession = undefined
  launchGate = undefined
  launchStatus = 200
  launches.length = 0
  sessions.clear()
  resolvedSessions.length = 0
  toasts.length = 0
  serverSessionSyncs = 0
  for (const key of Object.keys(storedSessions)) delete storedSessions[key]
})

describe("prompt submit worktree selection", () => {
  test("uses the existing session selection while local restoration is pending", async () => {
    const session = {
      id: "session-1",
      projectID: "project",
      directory: "/repo/main",
      title: "Existing session",
      version: "1",
      agent: "restored-agent",
      model: { id: "restored-model", providerID: "restored-provider" },
      time: { created: 1, updated: 1 },
    } as Session
    sessions.set(session.id, session)
    params = { id: session.id }
    localModel = undefined
    localAgent = undefined

    const submit = createPromptSubmit({
      prompt,
      info: () => sessions.get(session.id),
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

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await Bun.sleep(10)

    expect(toasts).toHaveLength(0)
    expect(promptInputs).toEqual([expect.objectContaining({ sessionID: session.id, prompt: { text: "ls" } })])
    expect(optimistic[0]).toMatchObject({
      message: {
        agent: session.agent,
        model: { providerID: session.model?.providerID, modelID: session.model?.id },
      },
    })
  })

  test.each(["normal", "shell", "missing"] as const)(
    "recovers a cold routed session for %s submission",
    async (mode) => {
      const recovered = {
        id: "session-recovered",
        projectID: "project",
        directory: "/repo/worktree-a",
        title: "Recovered",
        version: "1",
        time: { created: 1, updated: 1 },
      } as Session
      if (mode !== "missing") sessions.set(recovered.id, recovered)
      params = { id: recovered.id }
      promptValue = [{ type: "text", content: "ls", start: 0, end: 2 }]
      const submit = createPromptSubmit({
        prompt,
        info: () => undefined,
        imageAttachments: () => [],
        commentCount: () => 0,
        autoAccept: () => false,
        mode: () => (mode === "shell" ? "shell" : "normal"),
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

      await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
      await Bun.sleep(0)

      expect(resolvedSessions).toEqual([recovered.id])
      expect(sessionCreateInputs).toHaveLength(0)
      if (mode === "missing") {
        expect(sentShell).toHaveLength(0)
        expect(promptInputs).toHaveLength(0)
        expect(promptValue[0]).toMatchObject({ content: "ls" })
        expect(toasts).toEqual([{ title: "prompt.toast.promptSendFailed.title", description: "Session not found" }])
        return
      }
      expect(toasts).toHaveLength(0)
      if (mode === "shell") {
        expect(sentShell).toEqual([expect.objectContaining({ sessionID: recovered.id, command: "ls" })])
        return
      }
      expect(promptInputs).toEqual([expect.objectContaining({ sessionID: recovered.id, prompt: { text: "ls" } })])
      expect(optimistic).toEqual([expect.objectContaining({ directory: recovered.directory, sessionID: recovered.id })])
    },
  )

  test("keeps the routed session target while recovery is in flight", async () => {
    const recovered = {
      id: "session-recovered",
      projectID: "project",
      directory: "/repo/worktree-a",
      title: "Recovered",
      version: "1",
      time: { created: 1, updated: 1 },
    } as Session
    sessions.set(recovered.id, recovered)
    params = { id: recovered.id }
    resolveSessionGate = new Promise<void>((resolve) => {
      releaseResolveSession = resolve
    })
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
      onSubmit: () => undefined,
    })

    const result = submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await Bun.sleep(0)
    params = { id: "session-other" }
    releaseResolveSession?.()
    await result
    await Bun.sleep(0)

    expect(resolvedSessions).toEqual([recovered.id])
    expect(promptInputs).toEqual([expect.objectContaining({ sessionID: recovered.id })])
  })

  test("uses the selected worktree for each explicitly opened draft", async () => {
    search.draftId = "draft-a"
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
    search.draftId = "draft-b"
    selected = "/repo/worktree-b"
    promptValue = [{ type: "text", content: "ls", start: 0, end: 2 }]
    await submit.handleSubmit(event)

    expect(deliveries).toEqual([
      { kind: "shell", directory: "/repo/worktree-a", server: "server-a" },
      { kind: "shell", directory: "/repo/worktree-b", server: "server-a" },
    ])
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

  test.each(["shell", "prompt", "command"] as const)(
    "keeps promoted session ownership on %s followups",
    async (kind) => {
      if (kind === "command") {
        protocol = "v1"
        commands.push({ name: "test" })
      }
      const submit = createPromptSubmit({
        prompt,
        info: () => undefined,
        imageAttachments: () => [],
        commentCount: () => 0,
        autoAccept: () => false,
        mode: () => (kind === "shell" ? "shell" : "normal"),
        working: () => false,
        editor: () => undefined,
        queueScroll: () => undefined,
        promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
        addToHistory: () => undefined,
        resetHistoryNavigation: () => undefined,
        setMode: () => undefined,
        setPopover: () => undefined,
        newSessionWorktree: () => selected,
      })
      const text = kind === "command" ? "/test" : "ls"
      promptValue = [{ type: "text", content: text, start: 0, end: text.length }]
      await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
      await Bun.sleep(0)
      selected = "/repo/worktree-b"
      promptValue = [{ type: "text", content: text, start: 0, end: text.length }]
      await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
      await Bun.sleep(0)

      expect(createdSessions).toEqual(["/repo/worktree-a"])
      expect(deliveries).toEqual([
        { kind, directory: "/repo/worktree-a", server: "server-a" },
        { kind, directory: "/repo/worktree-a", server: "server-a" },
      ])
      const requests = kind === "shell" ? sentShell : kind === "command" ? sentCommands : promptInputs
      expect(requests).toEqual([
        expect.objectContaining({ sessionID: "session-1" }),
        expect.objectContaining({ sessionID: "session-1" }),
      ])
      if (kind === "prompt")
        expect(optimistic.map((item) => item.directory)).toEqual(["/repo/worktree-a", "/repo/worktree-a"])
    },
  )

  test("creates separate sessions for different drafts in the same worktree", async () => {
    search.draftId = "draft-a"
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
      promptLength: () => 2,
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
    })
    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    search.draftId = "draft-b"
    promptValue = [{ type: "text", content: "ls", start: 0, end: 2 }]
    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    expect(createdSessions).toEqual(["/repo/worktree-a", "/repo/worktree-a"])
    expect(sentShell.map((item) => item.sessionID)).toEqual(["session-1", "session-2"])
    expect(promotedDrafts.map((item) => item.draftID)).toEqual(["draft-a", "draft-b"])
  })

  test.each(["switch", "dispose"] as const)(
    "does not affect another draft after %s during creation",
    async (change) => {
      search.draftId = "draft-a"
      let release = () => {}
      createSessionGate = new Promise<void>((resolve) => {
        release = resolve
      })
      const next = {
        ...prompt,
        current: () => [{ type: "text" as const, content: "keep me", start: 0, end: 7 }],
        reset: mock(() => undefined),
      }
      let current = prompt
      const source = { ...prompt, capture: () => current }
      const onSubmit = mock(() => undefined)
      const setMode = mock(() => undefined)
      let dispose = () => {}
      const submit = createRoot((cleanup) => {
        dispose = cleanup
        return createPromptSubmit({
          prompt: source,
          info: () => undefined,
          imageAttachments: () => [],
          commentCount: () => 0,
          autoAccept: () => false,
          mode: () => "shell",
          working: () => false,
          editor: () => undefined,
          queueScroll: () => undefined,
          promptLength: () => 2,
          addToHistory: () => undefined,
          resetHistoryNavigation: () => undefined,
          setMode,
          setPopover: () => undefined,
          newSessionWorktree: () => selected,
          onSubmit,
        })
      })
      const result = submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
      await Bun.sleep(0)
      if (change === "switch") {
        search.draftId = "draft-b"
        current = next
      }
      if (change === "dispose") dispose()
      release()
      await result
      expect(promotedDrafts).toEqual([])
      expect(promoted).toEqual([])
      expect(next.reset).not.toHaveBeenCalled()
      expect(onSubmit).not.toHaveBeenCalled()
      expect(setMode).not.toHaveBeenCalled()
      expect(sentShell).toEqual([expect.objectContaining({ sessionID: "session-1" })])
      expect(deliveries).toEqual([{ kind: "shell", directory: "/repo/worktree-a", server: "server-a" }])
      dispose()
    },
  )

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
      info: () => ({ id: "session-1", directory: "/repo/main" }) as Session,
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
      info: () => ({ id: "session-1", directory: "/repo/main" }) as Session,
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
      info: () => ({ id: "session-1", directory: "/repo/main" }) as Session,
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

describe("prompt submit directory ownership", () => {
  for (const selection of ["main", "/repo/worktree-a", "create"]) {
    for (const kind of ["shell", "prompt", "command"] as const) {
      test("sends " + kind + " through the selected directory: " + selection, async () => {
        selected = selection
        const directory = selection === "create" ? "/repo/main/new" : selection === "main" ? "/repo/main" : selection
        if (kind === "command") {
          protocol = "v1"
          commands.push({ name: "test" })
          promptValue = [{ type: "text", content: "/test argument", start: 0, end: 14 }]
        }
        if (selection === "create") Worktree.ready(ServerScope.local, directory)
        const submit = createPromptSubmit({
          prompt,
          info: () => undefined,
          imageAttachments: () => [],
          commentCount: () => 0,
          autoAccept: () => true,
          mode: () => (kind === "shell" ? "shell" : "normal"),
          working: () => false,
          editor: () => undefined,
          queueScroll: () => undefined,
          promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
          addToHistory: () => undefined,
          resetHistoryNavigation: () => undefined,
          setMode: () => undefined,
          setPopover: () => undefined,
          newSessionWorktree: () => selected,
        })
        await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
        await Bun.sleep(10)
        expect(toasts).toHaveLength(0)
        expect(createdSessions).toEqual([directory])
        expect(deliveries).toEqual([{ kind, directory, server: "server-a" }])
        expect(enabledAutoAccept).toEqual([{ server: "server-a", directory, sessionID: "session-1" }])
        if (kind === "prompt") expect(optimistic[0]).toMatchObject({ directory, sessionID: "session-1" })
      })
    }
  }

  test("keeps the captured server and directory while session creation is pending", async () => {
    let release!: () => void
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
    })
    const sending = submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await Bun.sleep(0)
    activeServer = "server-b"
    permissionServer = "server-b"
    selected = "/repo/worktree-b"
    params = { id: "different-route" }
    release()
    await sending
    expect(deliveries).toEqual([{ kind: "shell", directory: "/repo/worktree-a", server: "server-a" }])
    expect(enabledAutoAccept).toEqual([{ server: "server-a", directory: "/repo/worktree-a", sessionID: "session-1" }])
  })
})
