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

type Auth = { revision: number; vendors: Array<{ id: string; entityId: string }> }
afterAll(async () => {
  RelaySecretStore.testing.layer = undefined
  upstreams.forEach((server) => server.stop(true))
  if (!root || !path.resolve(data).startsWith(path.resolve(root) + path.sep)) throw new Error("unexpected isolated root")
  await rm(data, { recursive: true, force: true })
})

test("R202 HTTP first managed read after reconstruction rejects a replaced entity without sync", async () => {
  const id = Relay.VendorID.make("http-retired")
  const first = prepared
  let entity = ""
  try {
    const auth = await read<Auth>(await request(first, "auth"))
    const created = await read<Auth>(
      await request(first, `auth/vendors/${id}`, "PUT", {
        name: "Before",
        baseURL: "https://before.invalid/v1",
        key: "fake-http",
        revision: auth.revision,
      }),
    )
    entity = created.vendors.find((item) => item.id === id)!.entityId
    await read<object>(
      await request(first, "models/visibility", "PUT", {
        vendorId: id,
        modelId: "retired",
        visible: true,
        expectedEntityId: entity,
      }),
    )
  } finally {
    await first.dispose()
  }
  await Effect.gen(function* () {
    const auth = yield* RelayAuth.Service
    const removed = yield* auth.deleteVendor({ id, revision: (yield* auth.get()).revision })
    yield* auth.setVendor({
      id,
      name: "After",
      baseURL: "https://after.invalid/v1",
      key: "fake-new",
      revision: removed.revision,
    })
  }).pipe(Effect.scoped, Effect.provide(AppNodeBuilder.build(RelayAuth.node)), Effect.runPromise)
  const filename = path.join(Global.Path.data, "relay-catalog.json")
  expect((await Bun.file(filename).json()).vendorEntities[id]).toBe(entity)
  const restarted = webHandler()
  try {
    const managed = await read<Array<{ vendorId: string; modelId: string }>>(await request(restarted, "models"))
    expect(managed.some((item) => item.vendorId === id)).toBe(false)
    expect((await Bun.file(filename).json()).managed.some((item: { vendorId: string }) => item.vendorId === id)).toBe(
      false,
    )
  } finally {
    await restarted.dispose()
  }
})

test("R210 HTTP quarantine stays private and requires current refresh plus explicit selection", async () => {
  const id = Relay.VendorID.make("http-quarantine")
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ data: [{ id: "legacy" }] }),
  })
  upstreams.push(upstream)
  const seeded = prepared
  let entity = ""
  try {
    const auth = await read<Auth>(await request(seeded, "auth"))
    const created = await read<Auth>(
      await request(seeded, `auth/vendors/${id}`, "PUT", {
        name: "Legacy",
        baseURL: `${upstream.url}v1`,
        key: "fake-isolated",
        revision: auth.revision,
      }),
    )
    entity = created.vendors.find((item) => item.id === id)!.entityId
    await read<object>(
      await request(seeded, "models/visibility", "PUT", {
        vendorId: id,
        modelId: "legacy",
        visible: true,
        expectedEntityId: entity,
      }),
    )
  } finally {
    await seeded.dispose()
  }
  const filename = path.join(Global.Path.data, "relay-catalog.json")
  const stored = await Bun.file(filename).json()
  delete stored.vendorEntities[id]
  await Bun.write(filename, JSON.stringify(stored))
  const app = webHandler()
  try {
    const managed = await read<Array<{ vendorId: string }>>(await request(app, "models"))
    expect(managed.some((item) => item.vendorId === id)).toBe(false)
    const sync = await read<object>(await request(app, "models/sync", "POST", {}))
    expect(sync).not.toHaveProperty("quarantine")
    expect(JSON.stringify(sync)).not.toContain("fake-isolated")
    await read<object>(await request(app, "models/refresh", "POST", { vendorId: id, expectedEntityId: entity }))
    const afterRefresh = await read<Array<{ vendorId: string }>>(await request(app, "models"))
    expect(afterRefresh.some((item) => item.vendorId === id)).toBe(false)
    await read<object>(
      await request(app, "models/visibility", "PUT", {
        vendorId: id,
        modelId: "legacy",
        visible: true,
        expectedEntityId: entity,
      }),
    )
    const after = await read<Array<{ vendorId: string; visible: boolean }>>(await request(app, "models"))
    expect(after.find((item) => item.vendorId === id)?.visible).toBe(true)
    expect(
      (await Bun.file(filename).json()).quarantine.entries.some((item: { vendorId?: string }) => item.vendorId === id),
    ).toBe(false)
  } finally {
    await app.dispose()
    upstream.stop(true)
  }
})
