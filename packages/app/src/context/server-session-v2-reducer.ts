import type { JsonValue, OpenCodeEvent } from "@opencode-ai/client"
import type { SessionMessageInfo, SessionPendingMessage } from "@/utils/protocol-types"

export type V2SessionEvent = {
  id: string
  type: string
  metadata?: Record<string, JsonValue>
  created?: number
  data: {
    sessionID: string
    timestamp: number
    messageID: string
    inputID: string
    assistantMessageID: string
    agent: string
    model: { id: string; providerID: string; variant?: string }
    snapshot?: string
    files?: string[]
    finish: string
    cost: number
    tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
    error: { type: string; message: string }
    textID: string
    delta: string
    text: string
    reasoningID: string
    providerMetadata?: Record<string, JsonValue>
    callID: string
    command: string
    output: string
    name: string
    tool: string
    input: Record<string, JsonValue>
    provider: { executed: boolean; metadata?: Record<string, JsonValue> }
    executed: boolean
    structured: Record<string, JsonValue>
    content: Array<{ type: "text" | "file"; text?: string; uri?: string; mime?: string; name?: string }>
    result?: JsonValue
    attempt: number
    at: number
    reason: "auto" | "manual"
    recent: string
    description?: string
    prompt: {
      text: string
      files?: Array<{ data: string; mime: string; name: string; source?: JsonValue }>
      agents?: Array<{ name: string; source?: JsonValue }>
    }
    delivery: "steer" | "queue"
    location: { directory: string; workspaceID?: string }
    subdirectory?: string
  }
}

export function adaptV2SessionEvent(event: OpenCodeEvent): V2SessionEvent | undefined {
  if (!("data" in event) || typeof event.data !== "object" || event.data === null) return
  const data = event.data as Record<string, unknown>
  const type = event.type
    .replace("session.input.admitted", "session.next.prompt.admitted")
    .replace("session.input.promoted", "session.next.prompted")
    .replace("session.step.started", "session.next.step.started")
    .replace("session.step.ended", "session.next.step.ended")
    .replace("session.step.failed", "session.next.step.failed")
    .replace("session.tool.", "session.next.tool.")
    .replace("session.retry.scheduled", "session.next.retried")
  const legacyInput = data.input as { type?: string; data?: Record<string, unknown> } | undefined
  const normalized = {
    ...data,
    timestamp: typeof data.timestamp === "number" ? data.timestamp : Date.now(),
    sessionID: data.sessionID,
    messageID: data.messageID ?? data.inputID,
    inputID: data.inputID ?? data.messageID,
    prompt:
      data.prompt ??
      (legacyInput?.type === "user"
        ? { text: legacyInput.data?.text, files: legacyInput.data?.files, agents: legacyInput.data?.agents }
        : undefined),
    provider: data.provider ?? { executed: data.executed === true, metadata: data.metadata },
    content: data.content ?? [],
    structured: data.structured ?? data.metadata ?? {},
    assistantMessageID: data.assistantMessageID,
  }
  if (typeof normalized.sessionID !== "string") return
  return {
    id: event.id,
    type,
    metadata: event.metadata as Record<string, JsonValue> | undefined,
    created: undefined,
    data: normalized as V2SessionEvent["data"],
  }
}

type Assistant = Extract<SessionMessageInfo, { type: "assistant" }>
type Compaction = Extract<SessionMessageInfo, { type: "compaction" }>
type Shell = Extract<SessionMessageInfo, { type: "shell" }>

export type V2SessionReduction = {
  sessionID: string
  messages: SessionMessageInfo[]
  touched: string[]
  missing?: string
}

export function createV2SessionReducer() {
  const pending = new Map<string, SessionPendingMessage>()

  const reduce = (source: readonly SessionMessageInfo[], event: V2SessionEvent): V2SessionReduction | undefined => {
    if (!("data" in event) || !("sessionID" in event.data) || typeof event.data.sessionID !== "string") return
    const sessionID = event.data.sessionID
    const result = (messages: SessionMessageInfo[], touched: string[] = []): V2SessionReduction => ({
      sessionID,
      messages,
      touched,
    })
    const append = (message: SessionMessageInfo) =>
      result(source.some((item) => item.id === message.id) ? [...source] : [...source, message], [message.id])

    switch (event.type) {
      case "session.next.prompt.admitted":
        pending.set(key(sessionID, event.data.messageID), {
          type: "user",
          data: {
            text: event.data.prompt.text,
            files: event.data.prompt.files,
            agents: event.data.prompt.agents,
          },
        })
        return result([...source])
      case "session.next.prompted": {
        const input = pending.get(key(sessionID, event.data.messageID))
        if (!input && !event.data.prompt) return { sessionID, messages: [...source], touched: [], missing: event.data.messageID }
        const value = input ?? {
          type: "user" as const,
          data: { text: event.data.prompt.text, files: event.data.prompt.files, agents: event.data.prompt.agents },
        }
        pending.delete(key(sessionID, event.data.messageID))
        if (value.type === "user")
          return append({
            id: event.data.messageID,
            type: "user",
             metadata: "metadata" in value.data ? value.data.metadata : undefined,
            text: value.data.text,
             files: value.data.files,
             agents: value.data.agents,
            time: { created: event.data.timestamp },
          })
        return append({
          id: event.data.messageID,
          type: "synthetic",
          metadata: value.data.metadata,
          text: value.data.text,
          description: value.data.description,
          time: { created: event.data.timestamp },
        })
      }
      case "session.next.agent.switched":
        return append({
          id: messageID(event.id),
          type: "agent-switched",
          metadata: event.metadata,
          agent: event.data.agent,
          time: { created: event.data.timestamp },
        })
      case "session.next.model.switched":
        return append({
          id: messageID(event.id),
          type: "model-switched",
          metadata: event.metadata,
          model: event.data.model,
          previous: source.findLast(
            (item): item is Extract<SessionMessageInfo, { type: "model-switched" | "assistant" }> =>
              item.type === "model-switched" || item.type === "assistant",
          )?.model,
          time: { created: event.data.timestamp },
        })
      case "session.next.synthetic":
        return append({
          id: messageID(event.id),
          type: "synthetic",
           metadata: event.metadata,
          text: event.data.text,
          time: { created: event.data.timestamp },
        })
      case "session.next.shell.started":
        return append({
          id: messageID(event.id),
          type: "shell",
          metadata: event.metadata,
          shellID: event.data.callID,
          command: event.data.command,
          status: "running",
          time: { created: event.data.timestamp },
        })
      case "session.next.shell.ended":
        return updateMessage<Shell>(
          source,
          (item): item is Shell => item.type === "shell" && item.shellID === event.data.callID,
          (item) => ({
            ...item,
            status: "completed",
            output: event.data.output,
            time: { ...item.time, completed: event.data.timestamp },
          }),
          sessionID,
        )
      case "session.next.step.started": {
        const current = source.findLast((item): item is Assistant => item.type === "assistant" && !item.time.completed)
        const completed =
          current && current.id !== event.data.assistantMessageID
            ? update(source, current.id, (item) =>
                item.type === "assistant"
                ? { ...item, retry: undefined, time: { ...item.time, completed: event.data.timestamp } }
                  : item,
              )
            : [...source]
        const existing = completed.find((item) => item.id === event.data.assistantMessageID)
        if (existing?.type === "assistant")
          return result(
            update(completed, existing.id, (item) =>
              item.type === "assistant"
                ? {
                    ...item,
                    agent: event.data.agent,
                    model: event.data.model,
                    retry: undefined,
                    error: undefined,
                    finish: undefined,
                    snapshot: event.data.snapshot ? { ...item.snapshot, start: event.data.snapshot } : item.snapshot,
                    time: { ...item.time, completed: undefined },
                  }
                : item,
            ),
            current && current.id !== existing.id ? [current.id, existing.id] : [existing.id],
          )
        return result(
          [
            ...completed,
            {
              id: event.data.assistantMessageID,
              type: "assistant",
              metadata: event.metadata,
              agent: event.data.agent,
              model: event.data.model,
              content: [],
              snapshot: event.data.snapshot ? { start: event.data.snapshot } : undefined,
                   time: { created: event.data.timestamp },
            },
          ],
          current ? [current.id, event.data.assistantMessageID] : [event.data.assistantMessageID],
        )
      }
      case "session.next.step.ended":
        return updateAssistant(source, event.data.assistantMessageID, sessionID, (item) => ({
          ...item,
          finish: event.data.finish,
          cost: event.data.cost,
          tokens: event.data.tokens,
          snapshot:
            event.data.snapshot || event.data.files
              ? { ...item.snapshot, end: event.data.snapshot, files: event.data.files }
              : item.snapshot,
          time: { ...item.time, completed: event.data.timestamp },
        }))
      case "session.next.step.failed":
        return updateAssistant(source, event.data.assistantMessageID, sessionID, (item) => ({
          ...item,
          finish: "error",
          error: event.data.error,
          retry: undefined,
          cost: event.data.cost ?? item.cost,
          tokens: event.data.tokens ?? item.tokens,
          snapshot:
            event.data.snapshot || event.data.files
              ? { ...item.snapshot, end: event.data.snapshot, files: event.data.files }
              : item.snapshot,
          time: { ...item.time, completed: event.data.timestamp },
        }))
      case "session.next.text.started":
        return updateAssistant(source, event.data.assistantMessageID, sessionID, (item) => ({
          ...item,
          content: insertByID(item.content, "text", event.data.textID, { type: "text", id: event.data.textID, text: "" }),
        }))
      case "session.next.text.delta":
        return updateContentByID(source, event.data.assistantMessageID, sessionID, "text", event.data.textID, (item) => ({
          ...item,
          text: item.text + event.data.delta,
        }))
      case "session.next.text.ended":
        return updateContentByID(source, event.data.assistantMessageID, sessionID, "text", event.data.textID, (item) => ({
          ...item,
          text: event.data.text,
        }))
      case "session.next.reasoning.started":
        return updateAssistant(source, event.data.assistantMessageID, sessionID, (item) => ({
          ...item,
          content: insertByID(item.content, "reasoning", event.data.reasoningID, {
            type: "reasoning",
            id: event.data.reasoningID,
            text: "",
            state: event.data.providerMetadata,
            time: { created: event.data.timestamp },
          }),
        }))
      case "session.next.reasoning.delta":
        return updateContentByID(
          source,
          event.data.assistantMessageID,
          sessionID,
          "reasoning",
          event.data.reasoningID,
          (item) => ({
            ...item,
            text: item.text + event.data.delta,
          }),
        )
      case "session.next.reasoning.ended":
        return updateContentByID(
          source,
          event.data.assistantMessageID,
          sessionID,
          "reasoning",
          event.data.reasoningID,
          (item) => ({
            ...item,
            text: event.data.text,
            state: event.data.providerMetadata ?? item.state,
            time: { created: item.time?.created ?? event.data.timestamp, completed: event.data.timestamp },
          }),
        )
      case "session.next.tool.input.started":
        return updateAssistant(source, event.data.assistantMessageID, sessionID, (item) => ({
          ...item,
          content: item.content.some((content) => content.type === "tool" && content.id === event.data.callID)
            ? item.content
            : [
                ...item.content,
                {
                  type: "tool",
                  id: event.data.callID,
                  name: event.data.name,
                  state: { status: "streaming", input: "" },
                   time: { created: event.data.timestamp },
                },
              ],
        }))
      case "session.next.tool.input.ended":
        return updateTool(source, event.data.assistantMessageID, event.data.callID, sessionID, (tool) =>
          tool.state.status === "streaming" ? { ...tool, state: { ...tool.state, input: event.data.text } } : tool,
        )
      case "session.next.tool.called":
        return updateTool(source, event.data.assistantMessageID, event.data.callID, sessionID, (tool) => ({
          ...tool,
          executed: event.data.provider.executed,
          providerState: event.data.provider.metadata,
          // structured: {}, content: []
          state: { status: "running", input: event.data.input, metadata: {} },
          time: { ...tool.time, ran: event.data.timestamp },
        }))
      case "session.next.tool.progress":
        return updateTool(source, event.data.assistantMessageID, event.data.callID, sessionID, (tool) =>
          tool.state.status === "running"
              ? {
                ...tool,
                state: { ...tool.state, metadata: event.data.structured },
              }
            : tool,
        )
      case "session.next.tool.success":
        return updateTool(source, event.data.assistantMessageID, event.data.callID, sessionID, (tool) => {
          if (tool.state.status !== "running") return tool
          return {
            ...tool,
            executed: event.data.provider.executed || tool.executed === true,
            providerResultState: event.data.provider.metadata,
            state: {
              status: "completed",
              input: tool.state.input,
              // structured: event.data.structured,
              metadata: event.data.structured,
              content: event.data.content,
              // result: event.data.result,
            },
            time: { ...tool.time, completed: event.data.timestamp },
          }
        })
      case "session.next.tool.failed":
        return updateTool(source, event.data.assistantMessageID, event.data.callID, sessionID, (tool) => {
          if (tool.state.status !== "streaming" && tool.state.status !== "running") return tool
          return {
            ...tool,
            executed: event.data.provider.executed || tool.executed === true,
            providerResultState: event.data.provider.metadata,
            state: {
              status: "error",
              input: typeof tool.state.input === "string" ? {} : tool.state.input,
              // structured: tool.state.status === "running" ? tool.state.structured : {},
              metadata: event.data.provider.metadata ?? (tool.state.status === "running" ? tool.state.metadata : {}),
              content: [],
              error: event.data.error,
              // result: event.data.result,
            },
            time: { ...tool.time, completed: event.data.timestamp },
          }
        })
      case "session.next.retried": {
        const current = source.findLast((item): item is Assistant => item.type === "assistant")
        if (!current) return result([...source])
        return updateAssistant(source, current.id, sessionID, (item) => ({
          ...item,
          retry: { attempt: event.data.attempt, at: event.data.timestamp, error: { type: "unknown", message: event.data.error.message } },
        }))
      }
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted": {
        const current = source.findLast((item): item is Assistant => item.type === "assistant")
        if (!current) return result([...source])
        return updateAssistant(source, current.id, sessionID, (item) => ({ ...item, retry: undefined }))
      }
      case "session.next.compaction.started":
        return append({
          id: event.data.messageID,
          type: "compaction",
          status: "running",
          metadata: event.metadata,
          reason: event.data.reason,
          summary: "",
          recent: "",
          time: { created: event.data.timestamp },
        })
      case "session.next.compaction.ended": {
        const currentID = source.findLast((item) => item.type === "compaction" && item.status === "running")?.id
        if (!currentID)
          return append({
            id: event.data.messageID,
            type: "compaction",
            status: "completed",
            metadata: event.metadata,
            reason: event.data.reason,
            summary: "",
            recent: "",
            time: { created: event.data.timestamp },
          })
        return result(
          update(source, currentID, (item) =>
            item.type === "compaction"
              ? { ...item, status: "completed", reason: event.data.reason, summary: event.data.text, recent: event.data.recent }
              : item,
          ),
          [currentID],
        )
      }
      default:
        return
    }
  }

  return {
    reduce,
    clear(sessionID: string) {
      for (const id of pending.keys()) {
        if (id.startsWith(`${sessionID}:`)) pending.delete(id)
      }
    },
  }
}

function key(sessionID: string, inputID: string) {
  return `${sessionID}:${inputID}`
}

function messageID(eventID: string) {
  return eventID.replace(/^evt_/, "msg_")
}

function update(
  source: readonly SessionMessageInfo[],
  id: string,
  apply: (item: SessionMessageInfo) => SessionMessageInfo,
) {
  return source.map((item) => (item.id === id ? apply(item) : item))
}

function updateMessage<T extends SessionMessageInfo>(
  source: readonly SessionMessageInfo[],
  matches: (item: SessionMessageInfo) => item is T,
  apply: (item: T) => T,
  sessionID: string,
): V2SessionReduction {
  const current = source.findLast(matches)
  if (!current) return { sessionID, messages: [...source], touched: [] }
  return {
    sessionID,
    messages: update(source, current.id, (item) => (matches(item) ? apply(item) : item)),
    touched: [current.id],
  }
}

function updateAssistant(
  source: readonly SessionMessageInfo[],
  id: string,
  sessionID: string,
  apply: (item: Assistant) => Assistant,
): V2SessionReduction {
  return {
    sessionID,
    messages: update(source, id, (item) => (item.type === "assistant" ? apply(item) : item)),
    touched: source.some((item) => item.id === id && item.type === "assistant") ? [id] : [],
  }
}

function updateContentByID<T extends "text" | "reasoning">(
  source: readonly SessionMessageInfo[],
  messageID: string,
  sessionID: string,
  type: T,
  id: string,
  apply: (
    item: Extract<Assistant["content"][number], { type: T }>,
  ) => Extract<Assistant["content"][number], { type: T }>,
) {
  return updateAssistant(source, messageID, sessionID, (assistant) => {
    return {
      ...assistant,
      content: assistant.content.map((item) => {
        if (item.type !== type || item.id !== id) return item
        return apply(item as Extract<Assistant["content"][number], { type: T }>)
      }),
    }
  })
}

function updateTool(
  source: readonly SessionMessageInfo[],
  messageID: string,
  callID: string,
  sessionID: string,
  apply: (
    item: Extract<Assistant["content"][number], { type: "tool" }>,
  ) => Extract<Assistant["content"][number], { type: "tool" }>,
) {
  return updateAssistant(source, messageID, sessionID, (assistant) => ({
    ...assistant,
    content: assistant.content.map((item) => (item.type === "tool" && item.id === callID ? apply(item) : item)),
  }))
}

function insertByID<T extends "text" | "reasoning">(
  source: Assistant["content"],
  type: T,
  id: string,
  item: Extract<Assistant["content"][number], { type: T }>,
) {
  if (source.some((content) => content.type === type && content.id === id)) return source
  return [...source, item]
}
