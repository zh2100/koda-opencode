import type { Session } from "@opencode-ai/sdk/v2/client"
import type { ServerConnection } from "@/context/server"
import { authTokenFromCredentials } from "./server"

export const collaborationRoles = ["planner", "worker", "reviewer", "tester", "finalizer"] as const
export type CollaborationModels = Partial<Record<(typeof collaborationRoles)[number], string>>
export type CollaborationStatus = "pending" | "running" | "completed" | "failed" | "paused" | "aborted"
export type CollaborationStep = {
  role: (typeof collaborationRoles)[number]
  status: "pending" | "running" | "needs_revision" | "failed" | "completed"
  startedAt?: number
  finishedAt?: number
}
export type CollaborationWorker = {
  id: string
  title: string
  status: "pending" | "running" | "completed" | "failed"
  startedAt?: number
  finishedAt?: number
  failureReason?: string
}
export type CollaborationTask = {
  id: string
  status: CollaborationStatus
  currentStep?: number
  failureReason?: string
  steps?: CollaborationStep[]
  workers?: CollaborationWorker[]
}

export const collaborationProgressKey = (task: CollaborationTask) =>
  JSON.stringify({
    status: task.status,
    currentStep: task.currentStep,
    steps: task.steps?.map((step) => `${step.role}:${step.status}`),
    workers: task.workers?.map((worker) => `${worker.id}:${worker.status}`),
  })

const filesIn = (prompt: string) =>
  Array.from(prompt.matchAll(/(?:^|[\s"'`(])((?:[A-Za-z]:)?(?:[.]{0,2}\/)?[\w.-]+(?:\/[\w.-]+)+\.[A-Za-z0-9]+)/g), (match) =>
    match[1]!.replaceAll("\\", "/"),
  )
const directoryOf = (file: string) => file.split("/").slice(0, -1).join("/")

export function collaborationRoute(prompt: string): "single" | "parallel" {
  const text = prompt.toLowerCase()
  if (/(?:^|\s)(?:直接改|不要协作|single agent|do not collaborate)(?:\s|$)/i.test(prompt)) return "single"
  const files = filesIn(prompt)
  const directories = new Set(files.map(directoryOf))
  const broad = /重构|拆分|多个模块|并行|refactor|split into|parallel/i.test(text)
  if (files.length <= 1 || /修(?:这个)?(?:报错|错误)|改(?:一句)?文案|补(?:一个)?测试|fix (?:this )?(?:error|bug)|typo|add (?:a )?test/i.test(text))
    return "single"
  return files.length >= 2 && directories.size >= 2 && broad ? "parallel" : "single"
}

export function collaborationModels(
  selected: CollaborationModels,
): (CollaborationModels & { worker: string }) | undefined {
  const worker = selected.worker?.trim()
  if (!worker) return
  return {
    worker,
    ...Object.fromEntries(
      collaborationRoles.flatMap((role) => (selected[role]?.trim() ? [[role, selected[role]!.trim()]] : [])),
    ),
  }
}

export function collaborationUnsupported(parts: readonly { type: string }[], context: readonly unknown[]) {
  return parts.some((part) => part.type !== "text") || context.length > 0
}

export function collaborationWorkspaceKey(session: Pick<Session, "directory" | "workspaceID">) {
  if (session.workspaceID !== undefined) return `workspace:${session.workspaceID}`
  const trimmed = session.directory.replaceAll("\\", "/").replace(/\/+$/, "")
  const directory = /^[a-z]:$/i.test(trimmed) || /^\/\/[^/]+\/[^/]+$/.test(trimmed) ? `${trimmed}/` : trimmed || "/"
  // Session paths come from the server. The browser OS may be different.
  return `directory:${/^[a-z]:\//i.test(directory) || directory.startsWith("//") ? directory.toLowerCase() : directory}`
}

export async function startCollaboration(input: {
  server: ServerConnection.HttpBase
  fetch: typeof globalThis.fetch
  session: Pick<Session, "id" | "projectID" | "directory" | "workspaceID">
  prompt: string
  models: NonNullable<ReturnType<typeof collaborationModels>>
  mode?: "sequential" | "parallel"
  failure: string
}) {
  const response = await input.fetch(new URL(`${input.server.url.replace(/\/$/, "")}/experimental/orchestrator`), {
    method: "POST",
    signal: AbortSignal.timeout(60_000),
    headers: {
      "content-type": "application/json",
      "x-opencode-directory": encodeURIComponent(input.session.directory),
      ...(input.server.password !== undefined
        ? {
            Authorization: `Basic ${authTokenFromCredentials({ username: input.server.username, password: input.server.password })}`,
          }
        : {}),
    },
    body: JSON.stringify({
      sessionID: input.session.id,
      projectID: input.session.projectID,
      workspaceKey: collaborationWorkspaceKey(input.session),
      prompt: input.prompt,
      models: { ...input.models, mode: input.mode ?? "sequential", timeoutMs: 900_000 },
    }),
  })
  const responseBody = await response.clone().text()
  const responseLog = {
    url: response.url,
    status: response.status,
    statusText: response.statusText,
    body: responseBody.slice(0, 4096),
  }
  if (response.ok) {
    console.debug("[collaboration] orchestrator response", JSON.stringify(responseLog))
  } else {
    console.warn("[collaboration] orchestrator request failed", JSON.stringify(responseLog))
  }
  // The create endpoint schedules run itself. Never also submit an ordinary prompt.
  if (!response.ok) throw new Error(input.failure)
  const body = JSON.parse(responseBody) as Partial<CollaborationTask>
  if (!body.id || !body.status) throw new Error(input.failure)
  return { id: body.id, status: body.status }
}

export async function waitForCollaboration(input: {
  server: ServerConnection.HttpBase
  fetch: typeof globalThis.fetch
  directory: string
  taskID: string
  failure: string
  onProgress?: (task: CollaborationTask) => void
}) {
  let last = ""
  for (let attempt = 0; attempt < 1800; attempt++) {
    const response = await input.fetch(
      new URL(`${input.server.url.replace(/\/$/, "")}/experimental/orchestrator/${input.taskID}`),
      {
        signal: AbortSignal.timeout(10_000),
        headers: {
          "x-opencode-directory": encodeURIComponent(input.directory),
          ...(input.server.password !== undefined
            ? {
                Authorization: `Basic ${authTokenFromCredentials({ username: input.server.username, password: input.server.password })}`,
              }
            : {}),
        },
      },
    )
    if (!response.ok) throw new Error(input.failure)
    const body = (await response.json()) as Partial<CollaborationTask>
    if (!body.status) throw new Error(input.failure)
    const task = body as CollaborationTask
    const progress = collaborationProgressKey(task)
    if (progress !== last) {
      last = progress
      input.onProgress?.(task)
    }
    if (task.status === "completed" || task.status === "failed" || task.status === "aborted") return task
    await new Promise((resolve) => setTimeout(resolve, 2_000))
  }
  throw new Error(input.failure)
}
