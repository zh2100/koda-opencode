export type McpKind = "local" | "remote"

export type McpDraft = {
  name: string
  kind: McpKind
  command: string
  commandArgs?: string[]
  url: string
  touched: {
    name: boolean
    kind: boolean
    command: boolean
    url: boolean
  }
}

export type McpConfigRecord = {
  type?: string
  command?: string[]
  url?: string
  environment?: Record<string, string>
  headers?: Record<string, string>
  [key: string]: unknown
}

export type McpLoadState = "pending" | "success" | "error" | "missing"

export type McpField = "kind" | "command" | "url"

export type McpConflict = {
  code: string
  ref?: string
  fields: McpField[]
}

export function emptyMcpDraft(name = ""): McpDraft {
  return {
    name,
    kind: "local",
    command: "",
    url: "",
    touched: { name: false, kind: false, command: false, url: false },
  }
}

export function draftFromConfig(name: string, config: McpConfigRecord | undefined): McpDraft {
  const remote = config?.type === "remote"
  return {
    name,
    kind: remote ? "remote" : "local",
    command: formatCommand(config?.command ?? []),
    commandArgs: config?.command,
    url: config?.url ?? "",
    touched: { name: false, kind: false, command: false, url: false },
  }
}

export function applyLoadedConfig(draft: McpDraft, name: string, config: McpConfigRecord | undefined) {
  const loaded = draftFromConfig(name, config)
  return {
    name: draft.touched.name ? draft.name : loaded.name,
    kind: draft.touched.kind ? draft.kind : loaded.kind,
    command: draft.touched.command ? draft.command : loaded.command,
    commandArgs: draft.touched.command ? draft.commandArgs : loaded.commandArgs,
    url: draft.touched.url ? draft.url : loaded.url,
    touched: draft.touched,
  }
}

export function mcpLoadState(input: {
  mode: "add" | "edit"
  pending: boolean
  error: boolean
  config: McpConfigRecord | undefined
}): McpLoadState {
  if (input.mode === "add") return "success"
  if (input.pending) return "pending"
  if (input.error) return "error"
  if (!input.config) return "missing"
  return "success"
}

export function canSaveMcp(input: {
  mode: "add" | "edit"
  state: McpLoadState
  busy: boolean
  writable?: boolean
  conflict?: McpConflict
  saved?: boolean
}) {
  if (input.busy) return false
  // A version or source conflict has no field list until the user reloads and reconciles it.
  if (input.conflict) return false
  // A successful submit must not be written again while the following refresh is retried.
  if (input.saved) return false
  if (input.mode === "add") return true
  if (input.writable === false) return false
  return input.state === "success"
}

export function mcpReloadSucceeded(result: { isSuccess: boolean; isError: boolean; error: unknown }) {
  return result.isSuccess && !result.isError && result.error == null
}

export function reconcileMcpReload(input: {
  original: McpConfigRecord | undefined
  latest: McpConfigRecord | undefined
  draft: McpDraft
  pending?: McpField[]
}) {
  const base = draftFromConfig(input.draft.name, input.original)
  const next = draftFromConfig(input.draft.name, input.latest)
  const fields: McpField[] = []
  const keep = (field: McpField, edited: boolean, draftValue: string, baseValue: string, latestValue: string) => {
    if (input.pending?.includes(field)) {
      fields.push(field)
      return draftValue
    }
    if (!edited) return latestValue
    if (baseValue === latestValue) return draftValue
    if (draftValue === latestValue) return latestValue
    fields.push(field)
    return draftValue
  }
  return {
    draft: {
      ...input.draft,
      kind: keep("kind", input.draft.touched.kind, input.draft.kind, base.kind, next.kind) as McpDraft["kind"],
      command: keep("command", input.draft.touched.command, input.draft.command, base.command, next.command),
      url: keep("url", input.draft.touched.url, input.draft.url, base.url, next.url),
      commandArgs: input.draft.touched.command ? input.draft.commandArgs : next.commandArgs,
    },
    fields,
    original: input.original,
  }
}

export function mcpErrorCode(error: unknown) {
  const body = errorBody(error)
  if (!body) return
  const code = body.code ?? body._tag
  if (typeof code !== "string") return
  return code
}

export function mcpErrorRef(error: unknown) {
  const body = errorBody(error)
  return typeof body?.ref === "string" ? body.ref : undefined
}

function errorBody(error: unknown): Record<string, unknown> | undefined {
  if (typeof error !== "object" || error === null) return
  const record = error as Record<string, unknown>
  if (typeof record.code === "string") return record
  const cause = record.cause
  if (typeof cause === "object" && cause !== null && "body" in cause) {
    const body = (cause as { body?: unknown }).body
    if (typeof body === "object" && body !== null) return body as Record<string, unknown>
  }
  if (typeof record.error === "object" && record.error !== null) return record.error as Record<string, unknown>
  return
}

export function mergeMcpConfig(existing: McpConfigRecord | undefined, draft: McpDraft) {
  if (draft.kind === "local") {
    return {
      ...existing,
      type: "local" as const,
      command: draft.touched.command ? parseCommand(draft.command) : (draft.commandArgs ?? existing?.command ?? []),
    }
  }
  return {
    ...existing,
    type: "remote" as const,
    url: draft.url.trim(),
  }
}

export function formatCommand(args: string[]) {
  return args.map(quoteCommandArg).join(" ")
}

export function parseCommand(value: string) {
  const args: string[] = []
  let current = ""
  let quote: "\"" | "'" | undefined
  let quoted = false
  const push = () => {
    if (!quoted && !current) return
    args.push(current)
    current = ""
    quoted = false
  }
  const text = value.trim()
  for (let index = 0; index < text.length; index++) {
    const char = text[index] ?? ""
    if (quote) {
      if (char === "\\" && quote === "\"") {
        const next = text[index + 1]
        if (next === "\\" || next === "\"") {
          current += next
          index += 1
          continue
        }
      }
      if (char === quote) {
        quote = undefined
        continue
      }
      current += char
      continue
    }
    if (char === "\"" || char === "'") {
      quote = char
      quoted = true
      continue
    }
    if (/\s/.test(char)) {
      push()
      continue
    }
    current += char
  }
  push()
  return args
}

function quoteCommandArg(value: string) {
  if (value && !/[\s"']/.test(value)) return value
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`
}
