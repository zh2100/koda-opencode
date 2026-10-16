import { describe, expect, test } from "bun:test"
import path from "node:path"
import {
  collaborationModels,
  collaborationUnsupported,
  collaborationWorkspaceKey,
  startCollaboration,
} from "./collaboration"

describe("collaboration request", () => {
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
        return new Response(null)
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
        return new Response(null)
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
      models: { worker: "p/w" },
    })
  })
})
