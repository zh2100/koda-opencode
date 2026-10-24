import type { JsonValue } from "@opencode-ai/client"

export type FileDiffInfo = {
  file: string
  patch: string
  additions: number
  deletions: number
  status: "added" | "deleted" | "modified"
}

export type SessionMessageAssistantText = { type: "text"; id: string; text: string }
export type SessionMessageAssistantReasoning = {
  type: "reasoning"
  id: string
  text: string
  state?: Record<string, JsonValue>
  time?: { created: number; completed?: number }
}
export type SessionMessageAssistantTool = {
  type: "tool"
  id: string
  name: string
  executed?: boolean
  providerState?: Record<string, JsonValue>
  providerResultState?: Record<string, JsonValue>
  state: {
    status: "streaming"
    input: string
  } | {
    status: "running"
    input: Record<string, JsonValue>
    metadata: Record<string, JsonValue>
  } | {
    status: "completed"
    input: Record<string, JsonValue>
    content: Array<{ type: "text" | "file"; text?: string; uri?: string; mime?: string; name?: string }>
    metadata?: Record<string, JsonValue>
  } | {
    status: "error"
    input: Record<string, JsonValue>
    content: Array<{ type: "text" | "file"; text?: string; uri?: string; mime?: string; name?: string }>
    error: { type: string; message: string }
    metadata?: Record<string, JsonValue>
  }
  time: { created: number; ran?: number; completed?: number }
}
export type SessionMessageAssistant = {
  id: string
  metadata?: Record<string, JsonValue>
  time: { created: number; completed?: number }
  type: "assistant"
  agent: string
  model: { id: string; providerID: string; variant?: string }
  content: Array<SessionMessageAssistantText | SessionMessageAssistantReasoning | SessionMessageAssistantTool>
  snapshot?: { start?: string; end?: string; files?: string[] }
  finish?: string
  cost?: number
  tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
  error?: { type: string; message: string }
  retry?: { attempt: number; at: number; error: { type: string; message: string } }
}
export type SessionMessageUser = {
  id: string
  metadata?: Record<string, JsonValue>
  time: { created: number }
  text: string
  files?: Array<{
    data: string
    mime: string
    name: string
    source?: JsonValue
    mention?: { start: number; end: number; text: string }
  }>
  agents?: Array<{ name: string; source?: JsonValue; mention?: { start: number; end: number; text: string } }>
  type: "user"
}
export type SessionMessageShell = {
  id: string
  metadata?: Record<string, JsonValue>
  time: { created: number; completed?: number }
  type: "shell"
  shellID: string
  command: string
  status: string
  exit?: number
  output?: string | { output: string; cursor: number; size: number; truncated: boolean }
}
export type SessionMessageInfo =
  | SessionMessageUser
  | SessionMessageAssistant
  | SessionMessageShell
  | { id: string; type: "agent-switched"; agent: string; time: { created: number }; metadata?: Record<string, JsonValue> }
  | { id: string; type: "model-switched"; model: { id: string; providerID: string; variant?: string }; time: { created: number }; metadata?: Record<string, JsonValue>; previous?: { id: string; providerID: string; variant?: string } }
  | { id: string; type: "synthetic"; text: string; description?: string; time: { created: number }; metadata?: Record<string, JsonValue> }
  | { id: string; type: "system"; text: string; time: { created: number }; metadata?: Record<string, JsonValue> }
  | { id: string; type: "skill"; skill: string; name: string; text: string; time: { created: number }; metadata?: Record<string, JsonValue> }
  | { id: string; type: "compaction"; status: "running" | "completed" | "failed"; reason: "auto" | "manual"; summary: string; recent: string; time: { created: number }; metadata?: Record<string, JsonValue>; error?: { type: string; message: string } }

export type SessionPendingMessage =
  | { type: "user"; data: { text: string; files?: SessionMessageUser["files"]; agents?: SessionMessageUser["agents"]; metadata?: Record<string, JsonValue> } }
  | { type: "synthetic"; data: { text: string; description?: string; metadata?: Record<string, JsonValue> } }

export type SessionInfo = {
  id: string
  parentID?: string
  projectID: string
  agent?: string
  model?: { id: string; providerID: string; variant?: string }
  cost: number
  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
  time: { created: number; updated: number; archived?: number }
  title: string
  location: { directory: string; workspaceID?: string }
  subpath?: string
  revert?: { messageID: string; partID?: string; snapshot?: string; diff?: string }
}
