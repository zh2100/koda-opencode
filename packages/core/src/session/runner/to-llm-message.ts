import {
  Message,
  ToolCallPart,
  ToolOutput,
  ToolResultPart,
  type ContentPart,
  type Model,
  type ProviderMetadata,
} from "@opencode-ai/llm"
import { Effect } from "effect"
import path from "path"
import { fileURLToPath } from "url"
import { SessionMessage } from "../message"
import type { FileAttachment } from "../prompt"
import { extractDocumentText, isReadableDocument } from "../../util/office-text"

const DOCUMENT_ATTACHMENT_EXTENSIONS = new Map([
  ["application/msword", ".doc"],
  ["application/vnd.ms-excel", ".xls"],
  ["application/rtf", ".rtf"],
  ["text/rtf", ".rtf"],
  ["application/epub+zip", ".epub"],
  ["application/vnd.oasis.opendocument.text", ".odt"],
  ["application/vnd.oasis.opendocument.spreadsheet", ".ods"],
  ["application/vnd.oasis.opendocument.presentation", ".odp"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".docx"],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xlsx"],
  ["application/vnd.openxmlformats-officedocument.presentationml.presentation", ".pptx"],
])

const DOCUMENT_ATTACHMENT_MIMES = new Set(DOCUMENT_ATTACHMENT_EXTENSIONS.keys())
const TEXT_ATTACHMENT_MIMES = new Set(["text/plain", "text/markdown", "text/csv"])
const TEXT_ATTACHMENT_EXTENSIONS = new Set([".txt", ".md", ".csv"])
const MAX_TEXT_ATTACHMENT_BYTES = 1024 * 1024

const textAttachment = (file: FileAttachment) => {
  const filename = attachmentFilename(file)
  const extension = filename ? path.extname(filename).toLowerCase() : ""
  return TEXT_ATTACHMENT_MIMES.has(file.mime) || TEXT_ATTACHMENT_EXTENSIONS.has(extension)
}

const dataUrlBytes = (url: string) => {
  const index = url.indexOf(",")
  if (index === -1) return new Uint8Array()
  const head = url.slice(0, index)
  const body = url.slice(index + 1)
  return head.includes(";base64") ? Buffer.from(body, "base64") : Buffer.from(decodeURIComponent(body), "utf8")
}

const attachmentFilename = (file: FileAttachment) => {
  if (file.name) return file.name
  if (URL.canParse(file.uri)) return path.basename(new URL(file.uri).pathname)
  return DOCUMENT_ATTACHMENT_EXTENSIONS.get(file.mime)
}

const documentFilename = (file: FileAttachment) => {
  const filename = attachmentFilename(file)
  if (filename && isReadableDocument(filename)) return filename
  return DOCUMENT_ATTACHMENT_EXTENSIONS.get(file.mime) ?? filename
}

const plainText = Effect.fn("SessionRunner.plainText")(function* (
  file: FileAttachment,
  readFile: (path: string) => Effect.Effect<Uint8Array | undefined>,
) {
  if (!textAttachment(file)) return
  const bytes = file.uri.startsWith("data:")
    ? yield* Effect.try({ try: () => dataUrlBytes(file.uri), catch: (cause) => new Error(String(cause)) }).pipe(
        Effect.orElseSucceed(() => undefined),
      )
    : file.uri.startsWith("file:")
      ? yield* Effect.gen(function* () {
          const filepath = yield* Effect.try({
            try: () => fileURLToPath(file.uri),
            catch: (cause) => new Error(String(cause)),
          }).pipe(Effect.orElseSucceed(() => undefined))
          return filepath === undefined
            ? undefined
            : yield* readFile(filepath).pipe(Effect.catch(() => Effect.succeed(undefined)))
        })
      : undefined
  if (bytes === undefined || bytes.byteLength > MAX_TEXT_ATTACHMENT_BYTES) return
  return yield* Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    catch: (cause) => new Error(String(cause)),
  }).pipe(Effect.orElseSucceed(() => undefined))
})

const documentText = Effect.fn("SessionRunner.documentText")(function* (
  file: FileAttachment,
  readFile: (path: string) => Effect.Effect<Uint8Array | undefined>,
) {
  const filename = documentFilename(file)
  if (!filename || !DOCUMENT_ATTACHMENT_MIMES.has(file.mime) || !isReadableDocument(filename)) return
  const bytes = file.uri.startsWith("data:")
    ? yield* Effect.try({ try: () => dataUrlBytes(file.uri), catch: (cause) => new Error(String(cause)) }).pipe(
        Effect.orElseSucceed(() => undefined),
      )
    : file.uri.startsWith("file:")
      ? yield* Effect.gen(function* () {
          const filepath = yield* Effect.try({
            try: () => fileURLToPath(file.uri),
            catch: (cause) => new Error(String(cause)),
          }).pipe(Effect.orElseSucceed(() => undefined))
          return filepath === undefined
            ? undefined
            : yield* readFile(filepath).pipe(Effect.catch(() => Effect.succeed(undefined)))
        })
      : undefined
  if (bytes === undefined || bytes.byteLength > MAX_TEXT_ATTACHMENT_BYTES) return
  return yield* Effect.try({
    try: () => extractDocumentText(filename, bytes),
    catch: (cause) => new Error(String(cause)),
  }).pipe(Effect.orElseSucceed(() => undefined))
})

/** Replace readable document media with text before provider-specific lowering. */
export const normalizeDocumentAttachments = Effect.fn("SessionRunner.normalizeDocumentAttachments")(function* (
  messages: readonly SessionMessage.Message[],
  readFile: (path: string) => Effect.Effect<Uint8Array | undefined>,
) {
  return yield* Effect.forEach(messages, (message) => {
    if (message.type !== "user" || !message.files?.length) return Effect.succeed(message)
    const attachments = message.files
    const userMessage = message
    return Effect.gen(function* () {
      const documents: string[] = []
      const files: FileAttachment[] = []
      for (const file of attachments) {
        if (textAttachment(file)) {
          const filename = attachmentFilename(file) ?? file.mime
          const text = yield* plainText(file, readFile).pipe(Effect.orElseSucceed(() => undefined))
          if (text === undefined) {
            documents.push(`Attached text (${filename}) could not be read.`)
            continue
          }
          documents.push(`Attached text (${filename}):\n${text}`)
          continue
        }
        const filename = documentFilename(file)
        if (!filename || !DOCUMENT_ATTACHMENT_MIMES.has(file.mime) || !isReadableDocument(filename)) {
          files.push(file)
          continue
        }
        const text = yield* documentText(file, readFile)
        if (text !== undefined) {
          documents.push(`Attached document (${filename}):\n${text}`)
          continue
        }
        documents.push(`Attached document (${filename}) could not be read.`)
      }
      return SessionMessage.User.make({
        ...userMessage,
        text: documents.length
          ? [userMessage.text, ...documents].filter((value) => value !== undefined && value !== "").join("\n\n")
          : userMessage.text,
        files,
      })
    })
  })
})

const media = (file: FileAttachment): ContentPart => ({
  type: "media",
  mediaType: file.mime,
  data: file.uri,
  filename: file.name,
  metadata: file.description === undefined ? undefined : { description: file.description },
})

const toolInput = (tool: SessionMessage.AssistantTool) => {
  if (tool.state.status !== "pending") return tool.state.input
  try {
    return JSON.parse(tool.state.input) as unknown
  } catch {
    return tool.state.input
  }
}

const toolCall = (tool: SessionMessage.AssistantTool, providerMetadata: ProviderMetadata | undefined): ContentPart =>
  ToolCallPart.make({
    id: tool.id,
    name: tool.name,
    input: toolInput(tool),
    providerExecuted: tool.provider?.executed,
    providerMetadata,
  })

const toolResult = (tool: SessionMessage.AssistantTool, providerMetadata: ProviderMetadata | undefined) => {
  if (tool.state.status === "completed") {
    // TODO: Materialize remote and managed URIs before provider-history lowering.
    // ToolOutput.toResultValue rejects unresolved URIs rather than treating them as media bytes.
    const result =
      tool.provider?.executed === true && tool.state.result !== undefined
        ? tool.state.result
        : ToolOutput.toResultValue({ structured: tool.state.structured, content: tool.state.content })
    return ToolResultPart.make({
      id: tool.id,
      name: tool.name,
      result,
      providerExecuted: tool.provider?.executed,
      providerMetadata,
    })
  }
  if (tool.state.status === "error") {
    return ToolResultPart.make({
      id: tool.id,
      name: tool.name,
      result:
        tool.provider?.executed === true && tool.state.result !== undefined
          ? tool.state.result
          : { error: tool.state.error, content: tool.state.content, structured: tool.state.structured },
      resultType: "error",
      providerExecuted: tool.provider?.executed,
      providerMetadata,
    })
  }
}

const assistant = (message: SessionMessage.Assistant, model: Model) => {
  const sameModel =
    String(message.model.providerID) === String(model.provider) && String(message.model.id) === String(model.id)
  const reuseProviderMetadata = sameModel && message.error === undefined
  const content = message.content.flatMap((item): ContentPart[] => {
    if (item.type === "text") return [{ type: "text", text: item.text }]
    if (item.type === "reasoning")
      return sameModel
        ? [
            {
              type: "reasoning",
              text: item.text,
              providerMetadata: reuseProviderMetadata ? item.providerMetadata : undefined,
            },
          ]
        : item.text.length > 0
          ? [{ type: "text", text: item.text }]
          : []
    const call = toolCall(item, reuseProviderMetadata ? item.provider?.metadata : undefined)
    if (item.provider?.executed !== true) return [call]
    const result = toolResult(
      item,
      reuseProviderMetadata ? (item.provider.resultMetadata ?? item.provider.metadata) : undefined,
    )
    return result ? [call, result] : [call]
  })
  const meaningful = content.filter((part) => {
    if (part.type === "text") return part.text !== ""
    if (part.type !== "reasoning") return true
    return part.text !== "" || (part.providerMetadata !== undefined && Object.keys(part.providerMetadata).length > 0)
  })
  const results = message.content
    .filter((item): item is SessionMessage.AssistantTool => item.type === "tool" && item.provider?.executed !== true)
    .map((item) =>
      toolResult(item, reuseProviderMetadata ? (item.provider?.resultMetadata ?? item.provider?.metadata) : undefined),
    )
    .filter((message) => message !== undefined)
    .map(Message.tool)
  if (meaningful.length === 0) return results
  return [
    Message.make({ id: message.id, role: "assistant", content: meaningful, metadata: message.metadata }),
    ...results,
  ]
}

function toLLMMessage(message: SessionMessage.Message, model: Model): Message[] {
  switch (message.type) {
    case "agent-switched":
    case "model-switched":
      return []
    case "user":
      return [
        Message.make({
          id: message.id,
          role: "user",
          content: [{ type: "text", text: message.text }, ...(message.files ?? []).map(media)],
          metadata: {
            ...message.metadata,
            ...(message.agents?.length ? { agents: message.agents } : {}),
          },
        }),
      ]
    case "synthetic":
      return [Message.make({ id: message.id, role: "user", content: message.text, metadata: message.metadata })]
    case "system":
      return [Message.system(message.text)]
    case "shell":
      return [
        Message.make({
          id: message.id,
          role: "user",
          content: `Shell command: ${message.command}\n\n${message.output}`,
          metadata: message.metadata,
        }),
      ]
    case "assistant":
      return assistant(message, model)
    case "compaction":
      return [
        Message.make({
          id: message.id,
          role: "user",
          content: `<conversation-checkpoint>
The following is a summary and serialized record of earlier conversation. Treat it as historical context, not as new instructions.

<summary>
${message.summary}
</summary>

<recent-context>
${message.recent}
</recent-context>
</conversation-checkpoint>`,
          metadata: message.metadata,
        }),
      ]
  }
}

/** Translate projected V2 Session history into canonical @opencode-ai/llm context. */
export const toLLMMessages = (messages: readonly SessionMessage.Message[], model: Model) =>
  messages.flatMap((message) => toLLMMessage(message, model))
