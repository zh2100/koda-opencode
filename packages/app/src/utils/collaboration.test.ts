import { describe, expect, test } from "bun:test"
import path from "node:path"
import {
  collaborationRoute,
  collaborationModels,
  collaborationUnsupported,
  collaborationWorkspaceKey,
  startCollaboration,
  waitForCollaboration,
} from "./collaboration"

const createdTask = JSON.stringify({ id: "task", status: "pending" })

describe("collaboration request", () => {
  test("routes only explicit disjoint work to parallel collaboration", () => {
    expect(collaborationRoute("fix this error in src/a.ts")).toBe("single")
    expect(collaborationRoute("update src/a.ts and src/b.ts")).toBe("single")
    expect(collaborationRoute("refactor src/api/a.ts and src/web/b.ts in parallel")).toBe("parallel")
    expect(collaborationRoute("直接改 src/api/a.ts and src/web/b.ts in parallel")).toBe("single")
  })

  test("requires a worker and omits default roles for server fallback", () => {
    expect(collaborationModels({ reviewer: "p/r" })).toBeUndefined()
    expect(collaborationModels({ worker: " p/w ", planner: "", reviewer: "p/r" })).toEqual({
      worker: "p/w",
      reviewer: "p/r",
    })
  })

  test("rejects every attachment and context kind", () => {
    expect(collaborationUnsupported([{ type: "text" }], [])).toBe(false)
    for (const type of ["image", "file", "agent"]) expect(collaborationUnsupported([{ type }], [])).toBe(true)
    expect(collaborationUnsupported([{ type: "text" }], [{ type: "file" }])).toBe(true)
  })

  test("uses server path semantics rather than browser OS", () => {
    expect(collaborationWorkspaceKey({ directory: "C:\\Repo\\" })).toBe("directory:c:/repo")
    expect(collaborationWorkspaceKey({ directory: "/Repo/" })).toBe("directory:/Repo")
    expect(collaborationWorkspaceKey({ directory: "/", workspaceID: "ws" })).toBe("workspace:ws")
  })

  test.each(["C:\\", "C:/", "C:\\Repo\\", "\\\\Server\\Share", "\\\\Server\\Share\\", "\\\\Server\\Share\\Repo\\"])(
    "matches backend Windows normalization for %s",
    (directory) => {
      expect(collaborationWorkspaceKey({ directory })).toBe(
        `directory:${path.win32.resolve(directory).replaceAll("\\", "/").toLowerCase()}`,
      )
    },
  )

  test.each(["", undefined])("handles password %j consistently with the SDK", async (password) => {
    const requests: Request[] = []
    await startCollaboration({
      server: { url: "https://example.test", username: "user", password },
      fetch: (async (url, init) => {
        requests.push(new Request(url, init))
        return new Response(createdTask)
      }) as typeof fetch,
      session: { id: "session", projectID: "project", directory: "/" },
      prompt: "task",
      models: { worker: "p/w" },
      failure: "failed",
    })
    expect(requests[0].headers.get("authorization")).toBe(password === undefined ? null : `Basic ${btoa("user:")}`)
    expect(collaborationWorkspaceKey({ directory: "/" })).toBe("directory:/")
  })

  test("uses authenticated directory-scoped create once, which starts the run", async () => {
    const requests: Request[] = []
    await startCollaboration({
      server: { url: "https://example.test/base", username: "user", password: "secret" },
      fetch: (async (url, init) => {
        requests.push(new Request(url, init))
        return new Response(createdTask)
      }) as typeof fetch,
      session: { id: "session", projectID: "project", directory: "/repo with space" },
      prompt: "current message",
      models: { worker: "p/w" },
      failure: "failed",
    })
    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe("https://example.test/base/experimental/orchestrator")
    expect(requests[0].headers.get("authorization")).toBe(`Basic ${btoa("user:secret")}`)
    expect(requests[0].headers.get("x-opencode-directory")).toBe(encodeURIComponent("/repo with space"))
    expect(await requests[0].json()).toMatchObject({
      prompt: "current message",
      sessionID: "session",
      models: { worker: "p/w", mode: "sequential", timeoutMs: 900_000 },
    })
  })

  test("logs the response status and body before reporting a failed request", async () => {
    const warnings: unknown[][] = []
    const originalWarn = console.warn
    console.warn = (...args) => warnings.push(args)
    try {
      await expect(
        startCollaboration({
          server: { url: "https://example.test", username: "user" },
          fetch: (async () =>
            new Response("server failure", {
              status: 503,
              statusText: "Service Unavailable",
            })) as unknown as typeof fetch,
          session: { id: "session", projectID: "project", directory: "/repo" },
          prompt: "task",
          models: { worker: "p/w" },
          failure: "failed",
        }),
      ).rejects.toThrow("failed")
    } finally {
      console.warn = originalWarn
    }

    expect(warnings).toEqual([
      [
        "[collaboration] orchestrator request failed",
        JSON.stringify({
          url: "",
          status: 503,
          statusText: "Service Unavailable",
          body: "server failure",
        }),
      ],
    ])
  })

  test("polls until the orchestration reaches a terminal status", async () => {
    const requests: Request[] = []
    const statuses = ["running", "completed"]
    const task = await waitForCollaboration({
      server: { url: "https://example.test", username: "user", password: "secret" },
      fetch: (async (url, init) => {
        requests.push(new Request(url, init))
        return new Response(JSON.stringify({ id: "task", status: statuses.shift() }), {
          headers: { "content-type": "application/json" },
        })
      }) as typeof fetch,
      directory: "/repo",
      taskID: "task",
      failure: "failed",
    })
    expect(task.status).toBe("completed")
    expect(requests).toHaveLength(2)
    expect(requests[0].url).toBe("https://example.test/experimental/orchestrator/task")
    expect(requests[0].headers.get("x-opencode-directory")).toBe(encodeURIComponent("/repo"))
  })

  test("reports progress changes while polling", async () => {
    const progress: number[] = []
    const statuses = [
      { id: "task", status: "running", currentStep: 0 },
      { id: "task", status: "running", currentStep: 2 },
      { id: "task", status: "completed", currentStep: 5 },
    ]
    const task = await waitForCollaboration({
      server: { url: "https://example.test" },
      fetch: (async () =>
        new Response(JSON.stringify(statuses.shift()), {
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
      directory: "/repo",
      taskID: "task",
      failure: "failed",
      onProgress: (task) => progress.push(task.currentStep ?? 0),
    })
    expect(task.status).toBe("completed")
    expect(progress).toEqual([0, 2, 5])
  })

  test("reports parallel worker progress while polling", async () => {
    const progress: string[] = []
    const statuses = [
      {
        id: "task",
        status: "running",
        currentStep: 1,
        workers: [
          { id: "t1", title: "Frontend", status: "running" },
          { id: "t2", title: "Backend", status: "pending" },
        ],
      },
      {
        id: "task",
        status: "running",
        currentStep: 1,
        workers: [
          { id: "t1", title: "Frontend", status: "completed" },
          { id: "t2", title: "Backend", status: "running" },
        ],
      },
      { id: "task", status: "completed", currentStep: 5 },
    ]
    await waitForCollaboration({
      server: { url: "https://example.test" },
      fetch: (async () =>
        new Response(JSON.stringify(statuses.shift()), {
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
      directory: "/repo",
      taskID: "task",
      failure: "failed",
      onProgress: (task) => progress.push((task.workers ?? []).map((worker) => worker.status).join(",")),
    })
    expect(progress.slice(0, 2)).toEqual(["running,pending", "completed,running"])
  })

  test("returns the failure reason for a failed orchestration", async () => {
    const task = await waitForCollaboration({
      server: { url: "https://example.test" },
      fetch: (async () =>
        new Response(JSON.stringify({ id: "task", status: "failed", failureReason: "Worker t1 exceeded timeout" }), {
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
      directory: "/repo",
      taskID: "task",
      failure: "failed",
    })
    expect(task).toEqual({ id: "task", status: "failed", failureReason: "Worker t1 exceeded timeout" })
  })
})
