import { mkdtempSync } from "node:fs"
import path from "node:path"

const root = process.env.OPENCODE_TEST_ROOT
if (!root) throw new Error("isolation: product import requires an admitted root")
const data = mkdtempSync(path.join(process.env.TEMP ?? path.join(root, "tmp"), "opencode-relay-http-"))
delete process.env.OPENCODE_SERVER_PASSWORD

const { loadGlobal, requireInside } = await import("../../../script/test-isolation.mjs")
requireInside(root, data)
await loadGlobal(root)

const { afterAll, beforeAll, expect, test } = await import("bun:test")
const { rm } = await import("node:fs/promises")
const { Effect, Layer } = await import("effect")
const { RelaySecretStore } = await import("@opencode-ai/core/relay-secret-store")

const secrets = new Map<string, string>()
let failRemove = false
RelaySecretStore.testing.layer = Layer.succeed(
  RelaySecretStore.Service,
  RelaySecretStore.Service.of({
    get: (ref) => Effect.sync(() => secrets.get(ref)),
    put: (ref, secret) => Effect.sync(() => void secrets.set(ref, secret)),
    remove: (ref) => {
      if (failRemove) return Effect.fail(new RelaySecretStore.UnavailableError())
      secrets.delete(ref)
      return Effect.void
    },
  }),
)

const { webHandler } = await import("../src/routes")
const app = webHandler()
const handler = (request: Request) => {
  request.headers.set("x-opencode-directory", data)
  return (app.handler as (request: Request) => Promise<Response>)(request)
}

beforeAll(async () => {
  // Establish the real router/service readiness before any mutation test owns data.
  // A timed-out test otherwise keeps running while Bun starts the next mutation test.
  const ready = await handler(new Request("http://localhost/api/relay/auth", { headers: { "x-opencode-directory": data } }))
  expect(ready.status).toBe(200)
}, 30_000)

afterAll(async () => {
  RelaySecretStore.testing.layer = undefined
  await app.dispose()
  if (!root || !path.resolve(data).startsWith(path.resolve(root) + path.sep)) throw new Error("unexpected isolated root")
  await rm(data, { recursive: true, force: true })
})

const stateOf = async (response: Response) => {
  const body = (await response.json()) as {
    data?: { revision: number; vendors?: Array<{ id: string; baseURL?: string }>; mode?: string }
    revision?: number
    vendors?: Array<{ id: string; baseURL?: string }>
    mode?: string
  }
  expect(JSON.stringify(body)).not.toContain("cleanupPending")
  return body.data ?? body
}

const request = (url: string, method: string, body: unknown) =>
  handler(
    new Request(url, {
      method,
      headers: { "content-type": "application/json", "x-opencode-directory": data },
      body: JSON.stringify(body),
    }),
  )

test("returns the committed auth state when vendor cleanup is still pending", async () => {
  const currentState = await handler(new Request("http://localhost/api/relay/auth"))
  expect(currentState.status).toBe(200)
  const before = await stateOf(currentState)
  expect(before.revision).toBeNumber()
  const created = await handler(
    new Request("http://localhost/api/relay/auth/vendors/cleanup", {
      method: "PUT",
      headers: { "content-type": "application/json", "x-opencode-directory": data },
      body: JSON.stringify({
        name: "Cleanup",
        baseURL: "https://cleanup.invalid/v1",
        key: "sk-http",
        revision: before.revision,
        operationId: "save",
      }),
    }),
  )
  expect(created.status, await created.clone().text()).toBe(200)
  const saved = (await created.json()) as { data?: { revision: number }; revision?: number }
  const revision = saved.data?.revision ?? saved.revision ?? 0
  failRemove = true
  const deleted = await handler(
    new Request("http://localhost/api/relay/auth/vendors/cleanup", {
      method: "DELETE",
      headers: { "content-type": "application/json", "x-opencode-directory": data },
      body: JSON.stringify({ revision, operationId: "delete" }),
    }),
  )
  expect(deleted.status).toBe(200)
  const body = (await deleted.json()) as {
    data?: { revision: number; vendors: Array<{ id: string }> }
    revision?: number
    vendors?: Array<{ id: string }>
  }
  const state = body.data ?? body
  expect(state.vendors?.some((vendor) => vendor.id === "cleanup")).toBe(false)
  expect(JSON.stringify(body)).not.toContain("cleanupPending")
  const retried = await handler(
    new Request("http://localhost/api/relay/auth/vendors/cleanup", {
      method: "DELETE",
      headers: { "content-type": "application/json", "x-opencode-directory": data },
      body: JSON.stringify({ revision, operationId: "delete" }),
    }),
  )
  expect(retried.status).toBe(200)
  const retriedState = await stateOf(retried)
  expect(retriedState.revision).toBe(state.revision)
  expect(secrets.size).toBeGreaterThan(0)

  const savedClear = await request("http://localhost/api/relay/auth/vendors/clear", "PUT", {
    name: "Clear",
    baseURL: "https://clear.invalid/v1",
    key: "sk-clear",
    revision: retriedState.revision,
    operationId: "save-clear",
  })
  expect(savedClear.status).toBe(200)
  const savedClearState = await stateOf(savedClear)
  const cleared = await request("http://localhost/api/relay/auth/vendors/clear/key", "DELETE", {
    revision: savedClearState.revision,
    operationId: "clear",
  })
  expect(cleared.status).toBe(200)
  const clearedState = await stateOf(cleared)
  const clearedRetry = await request("http://localhost/api/relay/auth/vendors/clear/key", "DELETE", {
    revision: savedClearState.revision,
    operationId: "clear",
  })
  expect(clearedRetry.status).toBe(200)
  expect((await stateOf(clearedRetry)).revision).toBe(clearedState.revision)
  const rotated = await request("http://localhost/api/relay/auth/vendors/rotate", "PUT", {
    name: "Rotate",
    baseURL: "https://rotate.invalid/v1",
    key: "sk-old",
    revision: clearedState.revision,
    operationId: "save-rotate",
  })
  expect(rotated.status).toBe(200)
  failRemove = false
  const savedRotate = await stateOf(rotated)
  failRemove = true
  const rotatedAgain = await request("http://localhost/api/relay/auth/vendors/rotate", "PUT", {
    key: "sk-next",
    revision: savedRotate.revision,
    operationId: "rotate",
  })
  expect(rotatedAgain.status).toBe(200)
  const rotatedState = await stateOf(rotatedAgain)
  const rotatedRetry = await request("http://localhost/api/relay/auth/vendors/rotate", "PUT", {
    key: "sk-other",
    revision: 0,
    operationId: "rotate",
  })
  expect(rotatedRetry.status).toBe(409)
  const identicalRetry = await request("http://localhost/api/relay/auth/vendors/rotate", "PUT", {
    key: "sk-next",
    revision: savedRotate.revision,
    operationId: "rotate",
  })
  expect(identicalRetry.status).toBe(200)
  const rotatedRetryState = await stateOf(identicalRetry)
  expect(rotatedRetryState.revision).toBe(rotatedState.revision)
  expect(rotatedRetryState.vendors?.find((vendor) => vendor.id === "rotate")?.baseURL).toBe("https://rotate.invalid/v1")

  for (const [method, route] of [
    ["PUT", "unified"],
    ["DELETE", "unified"],
    ["PUT", "mode"],
    ["POST", "rollback"],
  ]) {
    const retired = await request(`http://localhost/api/relay/auth/${route}`, method, {
      revision: rotatedState.revision,
    })
    expect(retired.status).toBe(404)
  }

  const rejected = await request("http://localhost/api/relay/auth/vendors/rotate", "PUT", {
    baseURL: "https://rejected.invalid/v1",
    revision: 99,
    operationId: "rejected",
  })
  expect(rejected.status).toBeGreaterThanOrEqual(400)
  const current = await handler(new Request("http://localhost/api/relay/auth", { headers: { "x-opencode-directory": data } }))
  expect((await stateOf(current)).vendors?.find((vendor) => vendor.id === "rotate")?.baseURL).toBe(
    "https://rotate.invalid/v1",
  )
})

test("B103/B108 real HTTP preserves create-only receipts and rejects stale entity commands", async () => {
  failRemove = false
  const before = await stateOf(await handler(new Request("http://localhost/api/relay/auth", { headers: { "x-opencode-directory": data } })))
  const input = {
    name: "HTTP create",
    baseURL: "https://http-create.invalid/v1",
    key: "fake-http-create",
    revision: before.revision,
    operationId: "http-create",
    createOnly: true,
  }
  const url = "http://localhost/api/relay/auth/vendors/http-create"
  const response = await request(url, "PUT", input)
  expect(response.status, await response.clone().text()).toBe(200)
  const raw = await response.json()
  const saved = raw.data ?? raw
  expect(saved.operationReceipt.operationId).toBe(input.operationId)
  expect(saved.capabilities).toContain("catalog-sync-v1")
  const entityId = saved.operationReceipt.entityId
  const replay = await request(url, "PUT", input)
  expect(replay.status).toBe(200)
  const replayBody = await replay.json()
  expect((replayBody.data ?? replayBody).operationReceipt).toEqual(saved.operationReceipt)
  expect((replayBody.data ?? replayBody).revision).toBe(saved.revision)
  const secretCount = secrets.size
  const conflict = await request(url, "PUT", { ...input, operationId: "another-create", revision: saved.revision })
  expect(conflict.status).toBe(409)
  expect(secrets.size).toBe(secretCount)
  const removed = await request(url, "DELETE", {
    revision: saved.revision,
    expectedEntityId: entityId,
    operationId: "remove-http-created",
  })
  expect(removed.status).toBe(200)
  const removedState = await stateOf(removed)
  const recreated = await request(url, "PUT", {
    ...input,
    key: "fake-http-replacement",
    revision: removedState.revision,
    operationId: "http-replacement",
  })
  expect(recreated.status).toBe(200)
  const recreatedBody = await recreated.json()
  const replacement = recreatedBody.data ?? recreatedBody
  expect(replacement.operationReceipt.entityId).not.toBe(entityId)
  for (const [route, method, body] of [
    [url, "DELETE", { revision: replacement.revision, expectedEntityId: entityId }],
    [
      "http://localhost/api/relay/models/probe",
      "POST",
      { vendorId: "http-create", expectedEntityId: entityId, expectedVendorRevision: 1 },
    ],
    ["http://localhost/api/relay/models/refresh", "POST", { vendorId: "http-create", expectedEntityId: entityId }],
    [
      "http://localhost/api/relay/models/visibility",
      "PUT",
      { vendorId: "http-create", modelId: "model", visible: true, expectedEntityId: entityId },
    ],
  ] as const) {
    expect((await request(route, method, body)).status).toBe(409)
  }
  const synced = await request("http://localhost/api/relay/models/sync", "POST", { retryNotice: true })
  expect(synced.status, await synced.clone().text()).toBe(200)
  const syncedBody = await synced.json()
  const result = syncedBody.data ?? syncedBody
  expect(result.auth.revision).toBe(replacement.revision)
  expect(result).toHaveProperty("catalogRevision")
  expect(result.notice.status).toBe("idle")
  expect(JSON.stringify(result)).not.toContain(input.key)
  expect(JSON.stringify(result)).not.toContain("keyRef")
  expect(JSON.stringify(result)).not.toContain("fingerprint")
})

const externalCatalogWrite = async (model: string) => {
  const { Global } = await import("@opencode-ai/core/global")
  const root = Global.Path.data
  expect(await Bun.file(path.join(root, "relay-auth.json")).exists()).toBe(true)
  const child = Bun.spawn(
    [process.execPath, path.join(import.meta.dir, "../../core/test/fixture/relay-catalog-writer.ts"), root, model],
    {
      cwd: path.join(import.meta.dir, "../../core"),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  try {
    child.stdin.write("go\n")
    child.stdin.end()
    const status = await child.exited
    expect(status, await new Response(child.stderr).text()).toBe(0)
  } finally {
    if (child.exitCode === null) child.kill()
    await child.exited
  }
  return path.join(root, "relay-catalog.json")
}

test("C108 real sync HTTP adopts a child-process commit without rebuilding or rewriting the parent", async () => {
  const file = await externalCatalogWrite("external-http-model")
  const before = await Bun.file(file).text()
  const response = await request("http://localhost/api/relay/models/sync", "POST", {})
  expect(response.status).toBe(200)
  const raw = await response.json()
  const result = raw.data ?? raw
  expect(result.managed.map((model: { modelId: string }) => model.modelId)).toContain("external-http-model")
  expect(result.catalogRevision).toBe(JSON.parse(before).catalogRevision)
  expect(await Bun.file(file).text()).toBe(before)
})

test("C111 real HTTP snapshots carry reading order independently of client sending and delivery order", async () => {
  const { OpenCode } = await import("../../client/src")
  const gate = () => {
    let release!: () => void
    const promise = new Promise<void>((resolve) => {
      release = resolve
    })
    return { promise, release }
  }
  const aRead = gate()
  const bCaptured = gate()
  const bReturn = gate()
  let calls = 0
  const client = OpenCode.make({
    baseUrl: "http://localhost",
    fetch: Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const call = ++calls
        if (call === 1) await aRead.promise
        const response = await handler(new Request(input, init))
        if (call === 2) {
          bCaptured.release()
          await bReturn.promise
        }
        return response
      },
      { preconnect: fetch.preconnect },
    ),
  })
  const a = client["server.relay"].sync()
  const b = client["server.relay"].sync()
  try {
    await bCaptured.promise
    const file = await externalCatalogWrite("http-read-order")
    const before = await Bun.file(file).text()
    aRead.release()
    const newer = await a
    bReturn.release()
    const older = await b
    expect(newer.auth.revision).toBe(older.auth.revision)
    expect(newer.catalogRevision!).toBeGreaterThan(older.catalogRevision!)
    expect(newer.managed.map((model) => model.modelId)).toContain("http-read-order")
    expect(older.managed.map((model) => model.modelId)).not.toContain("http-read-order")
    expect(await Bun.file(file).text()).toBe(before)
  } finally {
    aRead.release()
    bReturn.release()
    await Promise.allSettled([a, b])
  }
}, 30000)
