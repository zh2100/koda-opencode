import type { JsonValue } from "@opencode-ai/client"
import type { SessionMessageUser } from "./protocol-types"

type Mention = { start: number; end: number; text: string }
type PromptFile = {
  uri?: string
  data?: string
  mime: string
  name?: string
  source?: JsonValue
  mention?: Mention
}

// Current prompts carry URIs; older projections carry base64 data. Keep URI encoding intact.
export function normalizePromptFiles(files: readonly PromptFile[] | undefined): SessionMessageUser["files"] {
  return files?.flatMap((file) => {
    if (!file || typeof file.mime !== "string") return []
    const uri = typeof file.uri === "string" ? file.uri : undefined
    const data = uri ?? file.data
    if (typeof data !== "string") return []
    return [{
      data,
      ...(uri === undefined ? {} : { uri }),
      mime: file.mime,
      name: file.name ?? "",
      source: file.source,
      mention: file.mention ?? promptMention(file.source),
    }]
  })
}

export function normalizePromptAgents(
  agents: readonly { name: string; source?: JsonValue; mention?: Mention }[] | undefined,
): SessionMessageUser["agents"] {
  return agents?.map((agent) => ({ ...agent, mention: agent.mention ?? promptMention(agent.source) }))
}

function promptMention(source: JsonValue | undefined): Mention | undefined {
  if (!source || typeof source !== "object" || Array.isArray(source)) return
  if (!("text" in source) || !("start" in source) || !("end" in source)) return
  if (typeof source.text !== "string" || typeof source.start !== "number" || typeof source.end !== "number") return
  return { text: source.text, start: source.start, end: source.end }
}
