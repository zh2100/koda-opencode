import type { Message, Session } from "@opencode-ai/sdk/v2/client"
import { showToast } from "@/utils/toast"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { Binary } from "@opencode-ai/core/util/binary"
import { useNavigate, useParams, useSearchParams } from "@solidjs/router"
import { batch, startTransition, type Accessor } from "solid-js"
import { useTabs } from "@/context/tabs"
import { useServerSync, type ServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useLocal, type ModelSelection } from "@/context/local"
import { usePermission } from "@/context/permission"
import {
  isPromptEqual,
  type ContextItem,
  type ImageAttachmentPart,
  type Prompt,
  type usePrompt,
} from "@/context/prompt"
import { useSDK, type DirectorySDK } from "@/context/sdk"
import type { GeneratedApi } from "@/utils/server"
import { useSync, type DirectorySync } from "@/context/sync"
import { Identifier } from "@/utils/id"
import { pathKey } from "@/utils/path-key"
import { Worktree as WorktreeState } from "@/utils/worktree"
import { buildRequestParts } from "./build-request-parts"
import { setCursorPosition } from "./editor-dom"
import { formatServerError } from "@/utils/server-errors"
import { ScopedKey } from "@/utils/server-scope"
import { createPromptSubmissionState } from "./submission-state"
import { normalizeSessionInfo } from "@/utils/session"
import { Event } from "@opencode-ai/schema/event"
import { blobDataUrl } from "@/utils/draft-store"
import { createStore } from "solid-js/store"
import { useSettings } from "@/context/settings"
import { useServerSDK } from "@/context/server-sdk"
import { usePlatform } from "@/context/platform"
import { collaborationModels, collaborationRoute, collaborationUnsupported, startCollaboration } from "@/utils/collaboration"

type PendingPrompt = {
  abort: AbortController
  cleanup: VoidFunction
}

const pending = new Map<string, PendingPrompt>()

export function resetCollaborationState() {}

export type FollowupDraft = {
  sessionID: string
  sessionDirectory: string
  prompt: Prompt
  context: (ContextItem & { key: string })[]
  agent: string
  model: { providerID: string; modelID: string }
  variant?: string
}

type FollowupSendInput = {
  protocol?: Promise<"v1" | "v2"> | "v1" | "v2"
  api: DirectorySDK["client"]["session"]
  sessions: GeneratedApi["sessions"]
  serverSync: ServerSync
  sync: DirectorySync
  draft: FollowupDraft
  messageID?: string
  optimisticBusy?: boolean
  before?: () => Promise<boolean> | boolean
}

const protocolKind = async (protocol: FollowupSendInput["protocol"]) => (await protocol) ?? "v2"

const toPromptInput = (
  parts: ReturnType<typeof buildRequestParts>["requestParts"],
  text: string,
): Parameters<GeneratedApi["sessions"]["prompt"]>[0]["prompt"] => {
  const files = parts.flatMap((part) => {
    if (part.type !== "file") return []
    const source = part.source && "text" in part.source && part.source.text
      ? { start: part.source.text.start, end: part.source.text.end, text: part.source.text.value }
      : undefined
    return [{ uri: part.url, name: part.filename, source }]
  })
  const agents = parts.flatMap((part) => {
    if (part.type !== "agent") return []
    return [
      {
        name: part.name,
        source: part.source ? { start: part.source.start, end: part.source.end, text: part.source.value } : undefined,
      },
    ]
  })
  const extra = parts
    .filter((part): part is Extract<(typeof parts)[number], { type: "text" }> => part.type === "text" && part.text !== text)
    .map((part) => part.text)
    .join("\n")
  return {
    text: extra ? [text, extra].filter(Boolean).join("\n") : text,
    ...(files.length ? { files } : {}),
    ...(agents.length ? { agents } : {}),
  }
}

const draftText = (prompt: Prompt) => prompt.map((part) => ("content" in part ? part.content : "")).join("")

const draftImages = (prompt: Prompt) => prompt.filter((part): part is ImageAttachmentPart => part.type === "image")

export async function sendFollowupDraft(input: FollowupSendInput) {
  const text = draftText(input.draft.prompt)
  const images = draftImages(input.draft.prompt)
  const setBusy = () => {
    if (!input.optimisticBusy) return
    input.serverSync.session.set("session_status", input.draft.sessionID, { type: "busy" })
  }

  const setIdle = () => {
    if (!input.optimisticBusy) return
    input.serverSync.session.set("session_status", input.draft.sessionID, { type: "idle" })
  }

  const wait = async () => {
    const ok = await input.before?.()
    if (ok === false) return false
    return true
  }

  const [head, ...tail] = text.split(" ")
  const cmd = head?.startsWith("/") ? head.slice(1) : undefined
  if (cmd && input.sync.data.command.find((item) => item.name === cmd)) {
    setBusy()
    try {
      if (!(await wait())) {
        setIdle()
        return false
      }

      const messageID = Identifier.ascending("message")
      if ((await protocolKind(input.protocol)) !== "v1") {
        await input.sessions.switchAgent({ sessionID: input.draft.sessionID, agent: input.draft.agent })
        await input.sessions.switchModel({
          sessionID: input.draft.sessionID,
          model: {
            id: input.draft.model.modelID,
            providerID: input.draft.model.providerID,
            variant: input.draft.variant,
          },
        })
        await input.sessions.prompt({
          sessionID: input.draft.sessionID,
          id: messageID,
          prompt: { text: `/${cmd}${tail.length ? ` ${tail.join(" ")}` : ""}` },
        })
        return true
      }
      await input.api.command({
        sessionID: input.draft.sessionID,
        messageID,
        command: cmd,
        arguments: tail.join(" "),
        agent: input.draft.agent,
        model: input.draft.model.modelID,
        variant: input.draft.variant,
        parts: [],
      })
      return true
    } catch (err) {
      setIdle()
      throw err
    }
  }

  const messageID = input.messageID ?? Identifier.ascending("message")
  const encodedImages = await Promise.all(
    images.map(async (attachment) => ({
      ...attachment,
      dataUrl: await blobDataUrl(attachment.blob, attachment.mime),
    })),
  )
  const { requestParts, optimisticParts } = buildRequestParts({
    prompt: input.draft.prompt,
    context: input.draft.context,
    images: encodedImages,
    text,
    sessionID: input.draft.sessionID,
    messageID,
    sessionDirectory: input.draft.sessionDirectory,
  })

  const message: Message = {
    id: messageID,
    sessionID: input.draft.sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: input.draft.agent,
    model: { ...input.draft.model, variant: input.draft.variant },
  }

  const add = () =>
    input.sync.session.optimistic.add({
      directory: input.draft.sessionDirectory,
      sessionID: input.draft.sessionID,
      message,
      parts: optimisticParts,
    })

  const remove = () =>
    input.sync.session.optimistic.remove({
      directory: input.draft.sessionDirectory,
      sessionID: input.draft.sessionID,
      messageID,
    })

  batch(() => {
    setBusy()
    add()
  })

  try {
    if (!(await wait())) {
      batch(() => {
        setIdle()
        remove()
      })
      return false
    }

    if ((await protocolKind(input.protocol)) !== "v1") {
      await input.sessions.switchAgent({ sessionID: input.draft.sessionID, agent: input.draft.agent })
      await input.sessions.switchModel({
        sessionID: input.draft.sessionID,
        model: {
          id: input.draft.model.modelID,
          providerID: input.draft.model.providerID,
          variant: input.draft.variant,
        },
      })
      await input.sessions.prompt({
        sessionID: input.draft.sessionID,
        id: messageID,
        prompt: toPromptInput(requestParts, text),
      })
      return true
    }
    await input.api.prompt({
      sessionID: input.draft.sessionID,
      messageID,
      agent: input.draft.agent,
      model: input.draft.model,
      variant: input.draft.variant,
      parts: requestParts,
    })
    return true
  } catch (err) {
    batch(() => {
      setIdle()
      remove()
    })
    throw err
  }
}

type PromptSubmitInput = {
  prompt: ReturnType<typeof usePrompt>
  info: Accessor<{ id: string } | undefined>
  imageAttachments: Accessor<ImageAttachmentPart[]>
  commentCount: Accessor<number>
  autoAccept: Accessor<boolean>
  mode: Accessor<"normal" | "shell">
  working: Accessor<boolean>
  editor: () => HTMLDivElement | undefined
  queueScroll: () => void
  promptLength: (prompt: Prompt) => number
  addToHistory: (prompt: Prompt, mode: "normal" | "shell") => void
  resetHistoryNavigation: () => void
  setMode: (mode: "normal" | "shell") => void
  setPopover: (popover: "at" | "slash" | null) => void
  newSessionWorktree?: Accessor<string | undefined>
  onNewSessionWorktreeReset?: () => void
  shouldQueue?: Accessor<boolean>
  onQueue?: (draft: FollowupDraft) => void
  onAbort?: () => void
  onSubmit?: () => void
  model?: ModelSelection
}

export function createPromptSubmit(input: PromptSubmitInput) {
  const navigate = useNavigate()
  const sdk = useSDK()
  const sync = useSync()
  const serverSync = useServerSync()
  const local = useLocal()
  const permission = usePermission()
  const prompt = input.prompt
  const layout = useLayout()
  const language = useLanguage()
  const params = useParams()
  const [search] = useSearchParams<{ draftId?: string }>()
  const tabs = useTabs()
  const settings = useSettings()
  const serverSDK = useServerSDK()
  const platform = usePlatform()
  const sessionID = () => input.info()?.id ?? params.id
  const [collaboration, setCollaboration] = createStore({ busy: false })
  let promotedSession: Session | undefined
  const reason = () => {
    if (collaborationUnsupported(prompt.current(), prompt.context.items()))
      return language.t("prompt.collaboration.attachments")
    if (input.mode() !== "normal") return language.t("prompt.collaboration.shell")
    if (!settings.collaboration.ready() || !collaborationModels(settings.collaboration.models))
      return language.t("prompt.collaboration.workerRequired")
    if (input.working()) return language.t("prompt.collaboration.working")
    return ""
  }
  const pendingKey = (sessionID: string) => ScopedKey.from(sdk().scope, sessionID)

  const errorMessage = (err: unknown) => {
    if (err && typeof err === "object" && "message" in err && typeof err.message === "string") return err.message
    if (err && typeof err === "object" && "data" in err) {
      const data = (err as { data?: { message?: string } }).data
      if (data?.message) return data.message
    }
    if (err instanceof Error) return err.message
    return language.t("common.requestFailed")
  }

  const abort = async () => {
    const sessionID = params.id
    if (!sessionID) return Promise.resolve()

    input.onAbort?.()

    const key = pendingKey(sessionID)
    const queued = pending.get(key)
    if (queued) {
      queued.abort.abort()
      queued.cleanup()
      pending.delete(key)
      return Promise.resolve()
    }
    return sdk()
      .client.v2.session.interrupt({ sessionID })
      .catch(() => {})
  }

  const restoreCommentItems = (
    target: ReturnType<ReturnType<typeof usePrompt>["capture"]>,
    items: (ContextItem & { key: string })[],
  ) => {
    for (const item of items) {
      target.context.add({
        type: "file",
        path: item.path,
        selection: item.selection,
        comment: item.comment,
        commentID: item.commentID,
        commentOrigin: item.commentOrigin,
        preview: item.preview,
      })
    }
  }

  const clearContext = (target: ReturnType<ReturnType<typeof usePrompt>["capture"]>) => {
    for (const item of target.context.items()) {
      target.context.remove(item.key)
    }
  }

  const seed = (dir: string, info: Session) => {
    serverSync().session.remember(info)
    const [, setStore] = serverSync().child(dir)
    setStore("session", (list: Session[]) => {
      const result = Binary.search(list, info.id, (item) => item.id)
      const next = [...list]
      if (result.found) {
        next[result.index] = info
        return next
      }
      next.splice(result.index, 0, info)
      return next
    })
  }

  const handleSubmit = async (event: Event, models?: NonNullable<ReturnType<typeof collaborationModels>>) => {
    event.preventDefault()

    const target = prompt.capture()
    const submission = createPromptSubmissionState({
      target,
      prompt: target.current(),
      context: target.context.items().slice(),
    })
    const currentPrompt = submission.prompt
    const context = submission.context
    const text = currentPrompt.map((part) => ("content" in part ? part.content : "")).join("")
    const images = input.imageAttachments().slice()
    const mode = input.mode()

    if (text.trim().length === 0 && images.length === 0 && input.commentCount() === 0) {
      if (input.working()) void abort()
      return
    }

    const modelSelection = input.model ?? local.model
    const separator = models?.worker.indexOf("/") ?? -1
    const currentModel =
      models && separator > 0
        ? { id: models.worker.slice(separator + 1), provider: { id: models.worker.slice(0, separator) } }
        : modelSelection.current()
    const currentAgent = local.agent.current()
    const variant = models ? undefined : modelSelection.variant.current()
    const directory = sdk().directory
    const connection = serverSDK().server.http
    const registered = layout.projects
      .list()
      .some(
        (project) =>
          pathKey(project.worktree) === pathKey(directory) ||
          project.sandboxes?.some((sandbox) => pathKey(sandbox) === pathKey(directory)),
      )
    if (!registered) {
      showToast({
        title: language.t("prompt.toast.projectRequired.title"),
        description: language.t("prompt.toast.projectRequired.description"),
      })
      return
    }
    if (!currentModel || !currentAgent) {
      showToast({
        title: language.t("prompt.toast.modelAgentRequired.title"),
        description: language.t("prompt.toast.modelAgentRequired.description"),
      })
      return
    }

    input.addToHistory(currentPrompt, mode)
    input.resetHistoryNavigation()

    const projectDirectory = sdk().directory
    const permissionState = permission.currentServerState()
    const isNewSession = !params.id && (!promotedSession || !models)
    const shouldAutoAccept = isNewSession && input.autoAccept()
    const worktreeSelection = input.newSessionWorktree?.() || "main"

    let sessionDirectory = projectDirectory
    let client = sdk().client

    if (isNewSession) {
      if (worktreeSelection === "create") {
        const createdWorktree = await client.worktree
          .create({ directory: projectDirectory })
          .then((x) => x.data)
          .catch((err) => {
            showToast({
              title: language.t("prompt.toast.worktreeCreateFailed.title"),
              description: errorMessage(err),
            })
            return undefined
          })

        if (!createdWorktree?.directory) {
          showToast({
            title: language.t("prompt.toast.worktreeCreateFailed.title"),
            description: language.t("common.requestFailed"),
          })
          return
        }
        WorktreeState.pending(sdk().scope, createdWorktree.directory)
        sessionDirectory = createdWorktree.directory
      }

      if (worktreeSelection !== "main" && worktreeSelection !== "create") {
        sessionDirectory = worktreeSelection
      }

      if (sessionDirectory !== projectDirectory) {
        client = sdk().createClient({
          directory: sessionDirectory,
          throwOnError: true,
        })
        serverSync().child(sessionDirectory)
      }

      input.onNewSessionWorktreeReset?.()
    }

    let session = input.info() ?? (models ? promotedSession : undefined)
    if (!session && isNewSession) {
      const created = await sdk()
        .client.v2.session.create({
          agent: currentAgent.name,
          model: { id: currentModel.id, providerID: currentModel.provider.id, variant },
          location: { directory: sessionDirectory },
        })
        .then((result) => (result.data?.data ? normalizeSessionInfo(result.data.data) : undefined))
        .catch((err) => {
          showToast({
            title: language.t("prompt.toast.sessionCreateFailed.title"),
            description: errorMessage(err),
          })
          return undefined
        })
      if (created) {
        seed(sessionDirectory, created)
        session = created
        promotedSession = created

        await startTransition(() => {
          if (!session) return
          if (shouldAutoAccept) permissionState.enableAutoAccept(session.id, sessionDirectory)
          local.session.promote(sessionDirectory, session.id, {
            agent: currentAgent.name,
            model: { providerID: currentModel.provider.id, modelID: currentModel.id },
            variant: variant ?? null,
          })
          layout.handoff.setTabs(base64Encode(sessionDirectory), session.id)
          const draftID = search.draftId
          if (draftID) tabs.promoteDraft(draftID, { server: tabs.draft(draftID).server, sessionId: session.id })
          else navigate(`/${base64Encode(sessionDirectory)}/session/${session.id}`)
          submission.retarget(prompt.capture({ dir: base64Encode(sessionDirectory), id: session.id }))
          if (models) submission.target().set(target.current(), input.promptLength(target.current()))
        })
      }
    }
    if (!session) {
      showToast({
        title: language.t("prompt.toast.promptSendFailed.title"),
        description: language.t("prompt.toast.promptSendFailed.description"),
      })
      return
    }
    if (models && promotedSession?.id === session.id) sessionDirectory = promotedSession.directory

    const model = {
      modelID: currentModel.id,
      providerID: currentModel.provider.id,
    }
    const agent = currentAgent.name
    const draft: FollowupDraft = {
      sessionID: session.id,
      sessionDirectory,
      prompt: currentPrompt,
      context,
      agent,
      model,
      variant,
    }

    const clearInput = () => {
      submission.clear()
      input.setMode("normal")
      input.setPopover(null)
    }

    const restoreInput = () => {
      const restored = submission.restore()
      if (!restored) return false
      restored.target.set(restored.prompt, input.promptLength(restored.prompt))
      if (!submission.current(prompt.capture())) return true
      input.setMode(mode)
      input.setPopover(null)
      requestAnimationFrame(() => {
        const editor = input.editor()
        if (!editor) return
        editor.focus()
        setCursorPosition(editor, input.promptLength(currentPrompt))
        input.queueScroll()
      })
      return true
    }

    if (models) {
      const current =
        serverSync().session.get(session.id) ?? (promotedSession?.id === session.id ? promotedSession : undefined)
      if (!current) throw new Error(language.t("settings.collaboration.failed"))
      const worktree = WorktreeState.get(sdk().scope, current.directory)
      if (worktree?.status === "pending") {
        const timeout = { current: undefined as ReturnType<typeof setTimeout> | undefined }
        const result = await Promise.race([
          WorktreeState.wait(sdk().scope, current.directory),
          new Promise<never>((_, reject) => {
            const timer = setTimeout(() => reject(new Error(language.t("workspace.error.stillPreparing"))), 300_000)
            timeout.current = timer
          }),
        ]).finally(() => clearTimeout(timeout.current))
        if (result.status === "failed") throw new Error(result.message)
      }
      if (worktree?.status === "failed") throw new Error(worktree.message)
      await startCollaboration({
        server: connection,
        fetch: platform.fetch ?? globalThis.fetch,
        session: current,
        prompt: text,
        models,
        mode: "parallel",
        failure: language.t("settings.collaboration.failed"),
      })
      // Do not erase edits made while the launch request was in flight.
      if (
        isPromptEqual(submission.target().current(), currentPrompt) &&
        isPromptEqual(target.current(), currentPrompt) &&
        !submission.target().context.items().length &&
        !target.context.items().length
      )
        clearInput()
      input.onSubmit?.()
      return
    }

    if (!isNewSession && mode === "normal" && input.shouldQueue?.()) {
      input.onQueue?.(draft)
      clearContext(submission.target())
      clearInput()
      return
    }

    input.onSubmit?.()

    if (mode === "shell") {
      clearInput()
      const eventID = Event.ID.create()
      sdk()
        .client.session.shell({
          sessionID: session.id,
          messageID: eventID,
          command: text,
          agent,
          model,
        })
        .catch((err) => {
          showToast({
            title: language.t("prompt.toast.shellSendFailed.title"),
            description: errorMessage(err),
          })
          restoreInput()
        })
      return
    }

    if (text.startsWith("/") && (await sdk().protocol) === "v1") {
      const [cmdName, ...args] = text.split(" ")
      const commandName = cmdName.slice(1)
      const customCommand = sync().data.command.find((c) => c.name === commandName)
      if (customCommand) {
        clearInput()
        const messageID = Identifier.ascending("message")
        serverSync().session.set("session_status", session.id, { type: "busy" })
        sdk()
          .client.session.command({
            sessionID: session.id,
            messageID,
            command: commandName,
            arguments: args.join(" "),
            agent,
            model: model.modelID,
            parts: [],
          })
          .catch((err) => {
            serverSync().session.set("session_status", session.id, { type: "idle" })
            showToast({
              title: language.t("prompt.toast.commandSendFailed.title"),
              description: formatServerError(err, language.t, language.t("common.requestFailed")),
            })
            restoreInput()
          })
        return
      }
    }

    const commentItems = context.filter((item) => item.type === "file" && !!item.comment?.trim())
    const messageID = Identifier.ascending("message")

    const removeOptimisticMessage = () => {
      sync().session.optimistic.remove({
        directory: sessionDirectory,
        sessionID: session.id,
        messageID,
      })
    }

    for (const item of commentItems) submission.target().context.remove(item.key)
    clearInput()

    const waitForWorktree = async () => {
      const worktree = WorktreeState.get(sdk().scope, sessionDirectory)
      if (!worktree || worktree.status !== "pending") return true

      if (sessionDirectory === projectDirectory) {
        sync().set("session_status", session.id, { type: "busy" })
      }

      const controller = new AbortController()
      const cleanup = () => {
        if (sessionDirectory === projectDirectory) {
          sync().set("session_status", session.id, { type: "idle" })
        }
        removeOptimisticMessage()
        if (restoreInput()) restoreCommentItems(submission.target(), commentItems)
      }

      pending.set(pendingKey(session.id), { abort: controller, cleanup })

      const abortWait = new Promise<Awaited<ReturnType<typeof WorktreeState.wait>>>((resolve) => {
        if (controller.signal.aborted) {
          resolve({ status: "failed", message: "aborted" })
          return
        }
        controller.signal.addEventListener(
          "abort",
          () => {
            resolve({ status: "failed", message: "aborted" })
          },
          { once: true },
        )
      })

      const timeoutMs = 5 * 60 * 1000
      const timer = { id: undefined as number | undefined }
      const timeout = new Promise<Awaited<ReturnType<typeof WorktreeState.wait>>>((resolve) => {
        timer.id = window.setTimeout(() => {
          resolve({
            status: "failed",
            message: language.t("workspace.error.stillPreparing"),
          })
        }, timeoutMs)
      })

      const result = await Promise.race([
        WorktreeState.wait(sdk().scope, sessionDirectory),
        abortWait,
        timeout,
      ]).finally(() => {
        if (timer.id === undefined) return
        clearTimeout(timer.id)
      })
      pending.delete(pendingKey(session.id))
      if (controller.signal.aborted) return false
      if (result.status === "failed") throw new Error(result.message)
      return true
    }

    void sendFollowupDraft({
      protocol: sdk().protocol,
      api: sdk().client.session,
      sessions: sdk().api.sessions,
      sync: sync(),
      serverSync: serverSync(),
      draft,
      messageID,
      optimisticBusy: sessionDirectory === projectDirectory,
      before: waitForWorktree,
    }).catch((err) => {
      pending.delete(pendingKey(session.id))
      if (sessionDirectory === projectDirectory) {
        sync().set("session_status", session.id, { type: "idle" })
      }
      showToast({
        title: language.t("prompt.toast.promptSendFailed.title"),
        description: errorMessage(err),
      })
      removeOptimisticMessage()
      if (restoreInput()) restoreCommentItems(submission.target(), commentItems)
    })
  }

  return {
    abort,
    collaboration: {
      state: collaboration,
      reason,
      enabled: () => settings.collaboration.enabled(),
      blocked: () => collaboration.busy || (settings.collaboration.enabled() && !!reason()),
      toggle() {
        if (collaboration.busy) return
        settings.collaboration.setEnabled(!settings.collaboration.enabled())
      },
    },
    handleSubmit: async (event: Event) => {
      event.preventDefault()
      if (
        input.working() &&
        prompt.current().every((part) => !("content" in part) || !part.content.trim()) &&
        input.imageAttachments().length === 0 &&
        input.commentCount() === 0
      )
        return abort()
      if (collaboration.busy) return
      if (!settings.collaboration.enabled()) return handleSubmit(event)
      if (collaborationRoute(prompt.current().map((part) => ("content" in part ? part.content : "")).join("\n")) === "single")
        return handleSubmit(event)
      if (reason()) {
        showToast({ title: language.t("settings.collaboration.failed"), description: reason() })
        return
      }
      const models = collaborationModels(settings.collaboration.models)
      if (!models) return
      setCollaboration("busy", true)
      try {
        await handleSubmit(event, models)
      } catch (error) {
        showToast({
          title: language.t("settings.collaboration.failed"),
          description: errorMessage(error),
          variant: "error",
        })
      } finally {
        setCollaboration("busy", false)
      }
    },
  }
}
