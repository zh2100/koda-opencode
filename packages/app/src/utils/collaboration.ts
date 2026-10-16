import type { Session } from "@opencode-ai/sdk/v2/client"
import type { ServerConnection } from "@/context/server"
import { authTokenFromCredentials } from "./server"

export const collaborationRoles = ["planner", "worker", "reviewer", "tester", "finalizer"] as const
export type CollaborationModels = Partial<Record<(typeof collaborationRoles)[number], string>>

export function collaborationModels(selected: CollaborationModels): (CollaborationModels & { worker: string }) | undefined {
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
      models: input.models,
    }),
  })
  // The create endpoint schedules run itself. Never also submit an ordinary prompt.
  if (!response.ok) throw new Error(input.failure)
}
