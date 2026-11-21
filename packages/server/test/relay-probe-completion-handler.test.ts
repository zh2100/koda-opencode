import { mkdtempSync } from "node:fs"
import path from "node:path"

const root = process.env.OPENCODE_TEST_ROOT
if (!root) throw new Error("isolation: product import requires an admitted root")
const data = mkdtempSync(path.join(process.env.TEMP ?? path.join(root, "tmp"), "opencode-relay-lifecycle-http-"))
delete process.env.OPENCODE_SERVER_PASSWORD

const { loadGlobal, requireInside } = await import("../../../script/test-isolation.mjs")
requireInside(root, data)
await loadGlobal(root)

const { afterAll, afterEach, beforeEach, expect, test } = await import("bun:test")
const { rm } = await import("node:fs/promises")
const { Effect, Layer } = await import("effect")
const { RelaySecretStore } = await import("@opencode-ai/core/relay-secret-store")
const { AppNodeBuilder } = await import("@opencode-ai/core/effect/app-node-builder")
const { RelayAuth } = await import("@opencode-ai/core/relay-auth")
const { Global } = await import("@opencode-ai/core/global")
const { FSUtil } = await import("@opencode-ai/core/fs-util")
RelaySecretStore.testing.layer = RelaySecretStore.makeLayer(undefined).pipe(
  Layer.provide(AppNodeBuilder.build(FSUtil.node)),
  Layer.provide(AppNodeBuilder.build(Global.node)),
)
const { Relay } = await import("../../schema/src/relay")
const { webHandler } = await import("../src/routes")

const read = async <T extends object>(response: Response): Promise<T> => {
  expect(response.status, await response.clone().text()).toBe(200)
  const body = (await response.json()) as T | { data: T }
  return "data" in body ? body.data : body
}
const request = (app: ReturnType<typeof webHandler>, route: string, method = "GET", body?: object) =>
  (app.handler as (request: Request) => Promise<Response>)(
    new Request(`http://localhost/api/relay/${route}`, {
      method,
      headers: { "x-opencode-directory": data, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  )
const upstreams: Array<ReturnType<typeof Bun.serve>> = []
// Cold router construction belongs to setup, before a mutation owns any test data.
let prepared: ReturnType<typeof webHandler>
beforeEach(async () => {
  prepared = webHandler()
  const response = await request(prepared, "auth")
  expect(response.status, await response.text()).toBe(200)
}, 30_000)
afterEach(async () => {
  await prepared.dispose()
})

type Auth = {
  revision: number
  vendors: Array<{ id: string; entityId: string; revision: number; name: string; hasKey: boolean }>
  catalogSync?: { status: "synced" | "pending"; retryable: boolean }
}
afterAll(async () => {
  RelaySecretStore.testing.layer = undefined
  upstreams.forEach((server) => server.stop(true))
  if (!root || !path.resolve(data).startsWith(path.resolve(root) + path.sep)) throw new Error("unexpected isolated root")
  await rm(data, { recursive: true, force: true })
})

test("RV-01 HTTP rejects old probe success after clearing its current credential", async () => {
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const allowed = new Promise<void>((resolve) => {
    release = resolve
  })
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch() {
      enter()
      await allowed
      return Response.json({ data: [{ id: "old-model" }] })
    },
  })
  upstreams.push(upstream)
  const app = prepared
  try {
    const initial = await read<Auth>(await request(app, "auth"))
    const saved = await read<Auth>(
      await request(app, "auth/vendors/probe-review", "PUT", {
        name: "Review",
        baseURL: `${upstream.url}v1`,
        key: "fake-http",
        revision: initial.revision,
      }),
    )
    const vendor = saved.vendors.find((item) => item.id === "probe-review")!
    const probing = request(app, "models/probe", "POST", {
      vendorId: vendor.id,
      expectedEntityId: vendor.entityId,
      expectedVendorRevision: vendor.revision,
    })
    await Effect.promise(() => entered).pipe(Effect.timeout("10 seconds"), Effect.runPromise)
    const cleared = await read<Auth & { vendors: Array<{ id: string; hasKey: boolean }> }>(
      await request(app, "auth/vendors/probe-review/key", "DELETE", {
        revision: saved.revision,
        expectedEntityId: vendor.entityId,
      }),
    )
    release()
    const response = await probing
    const body = await response.text()
    console.info("RV-01 HTTP observed", {
      status: response.status,
      body,
      currentHasKey: cleared.vendors.find((item) => item.id === vendor.id)?.hasKey,
    })
    expect(response.status).toBe(409)
  } finally {
    release()
    await app.dispose()
    upstream.stop(true)
  }
})
