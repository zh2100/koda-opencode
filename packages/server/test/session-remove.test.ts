import { afterAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

process.env.OPENCODE_DB = ":memory:"
delete process.env.OPENCODE_SERVER_PASSWORD

const { webHandler } = await import("../src/routes")
const app = webHandler()
const handler = app.handler as (request: Request) => Promise<Response>

afterAll(() => app.dispose())

test("reads and deletes a session whose directory no longer exists", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "opencode-session-remove-"))
  const created = await handler(
    new Request("http://localhost/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ location: { directory } }),
    }),
  )
  expect(created.status).toBe(200)
  const body = (await created.json()) as { data: { id: string } }

  await rm(directory, { recursive: true, force: true })

  const read = await handler(new Request(`http://localhost/api/session/${body.data.id}`))
  expect(read.status).toBe(200)

  const removed = await handler(
    new Request(`http://localhost/api/session/${body.data.id}`, { method: "DELETE" }),
  )
  expect(removed.status).toBe(204)

  const missing = await handler(new Request(`http://localhost/api/session/${body.data.id}`))
  expect(missing.status).toBe(404)
})
