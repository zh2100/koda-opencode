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

const { readFile, writeFile } = await import("node:fs/promises")
for (const broken of [false, true])
  for (const action of ["save", "clear", "delete"] as const)
    test(`RV-04 ${action} returns committed result, brokenCatalog=${broken}`, async () => {
      const app = prepared
      const id = `sync-error-${action}-${broken}`
      let original: string | undefined
      let changed = false
      const file = path.join(Global.Path.data, "relay-catalog.json")
      try {
        const initial = await read<Auth>(await request(app, "auth"))
        const saved = await read<Auth>(
          await request(app, `auth/vendors/${id}`, "PUT", {
            name: "Before",
            baseURL: "https://sync.invalid/v1",
            key: "fake-reaudit-key",
            revision: initial.revision,
          }),
        )
        const vendor = saved.vendors.find((item) => item.id === id)!
        original = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined
          throw error
        })
        if (broken) {
          changed = true
          await writeFile(file, "{ invalid-test-catalog")
        }
        const response = await request(
          app,
          `auth/vendors/${id}${action === "clear" ? "/key" : ""}`,
          action === "save" ? "PUT" : "DELETE",
          {
            revision: saved.revision,
            expectedEntityId: vendor.entityId,
            operationId: `reaudit-${action}-${broken}`,
            ...(action === "save" ? { name: "Committed" } : {}),
          },
        )
        const body = await response.text()
        const latest = await read<Auth & { vendors: Array<{ id: string; name: string; hasKey: boolean }> }>(
          await request(app, "auth"),
        )
        const current = latest.vendors.find((item) => item.id === id)
        const committed =
          action === "save"
            ? current?.name === "Committed"
            : action === "clear"
              ? current?.hasKey === false
              : current === undefined
        console.info("RV-04", {
          action,
          broken,
          status: response.status,
          committed,
          advancedOnce: latest.revision === saved.revision + 1,
          body,
        })
        expect(committed).toBe(true)
        expect(latest.revision).toBe(saved.revision + 1)
        expect(response.status).toBe(200)
        const acknowledged = JSON.parse(body)
        expect((acknowledged.data ?? acknowledged).catalogSync).toEqual({
          status: broken ? "pending" : "synced",
          retryable: broken,
        })
        expect(body).not.toContain("fake-reaudit-key")
        expect(body).not.toContain("cleanupPending")
        expect(body).not.toContain("keyRef")
        if (changed) {
          if (original === undefined) await rm(file, { force: true })
          else await writeFile(file, original)
          changed = false
          const synchronized = await read<{ auth: Auth }>(
            await request(app, "models/sync", "POST", { retryNotice: true }),
          )
          expect(synchronized.auth.revision).toBe(latest.revision)
          expect((await read<Auth>(await request(app, "auth"))).vendors).toEqual(latest.vendors)
        }
      } finally {
        if (changed && original !== undefined) await writeFile(file, original)
        if (changed && original === undefined) await rm(file, { force: true })
        await app.dispose()
      }
    })

test("RV-05 HTTP identical protected delete retry returns success without another write", async () => {
  const app = prepared
  try {
    const initial = await read<Auth>(await request(app, "auth"))
    const saved = await read<Auth>(
      await request(app, "auth/vendors/delete-retry", "PUT", {
        name: "Delete retry",
        baseURL: "https://retry.invalid/v1",
        key: "fake-retry",
        revision: initial.revision,
      }),
    )
    const vendor = saved.vendors.find((item) => item.id === "delete-retry")!
    const input = {
      revision: saved.revision,
      expectedEntityId: vendor.entityId,
      operationId: "reaudit-protected-delete",
    }
    const deleted = await read<Auth>(await request(app, "auth/vendors/delete-retry", "DELETE", input))
    const retried = await request(app, "auth/vendors/delete-retry", "DELETE", input)
    const latest = await read<Auth>(await request(app, "auth"))
    console.info("RV-05 HTTP", {
      status: retried.status,
      body: await retried.clone().text(),
      revision: latest.revision,
      committedRevision: deleted.revision,
    })
    expect(latest.revision).toBe(deleted.revision)
    expect(retried.status).toBe(200)
    const config = await Bun.file(path.join(Global.Path.data, "relay-auth.json")).text()
    const receiptFile = Bun.file(path.join(Global.Path.data, "relay-auth-receipt-key.json"))
    const receipt = (await receiptFile.exists()) ? await receiptFile.text() : undefined
    for (const target of [vendor.id, "delete-retry-other"]) {
      const collision = await request(app, `auth/vendors/${target}`, "PUT", {
        createOnly: true,
        operationId: input.operationId,
        revision: latest.revision,
        name: "Collision",
        baseURL: "https://collision.invalid/v1",
        key: "fake-collision",
      })
      expect(collision.status).toBe(409)
      const body = await collision.text()
      expect(body).toContain("REQUEST_CONFLICT")
      expect(body).not.toContain("fake-collision")
      expect(await Bun.file(path.join(Global.Path.data, "relay-auth.json")).text()).toBe(config)
      expect(await receiptFile.exists()).toBe(receipt !== undefined)
      if (receipt !== undefined) expect(await receiptFile.text()).toBe(receipt)
    }
    const command = {
      createOnly: true,
      operationId: "fresh-after-protected-delete",
      revision: latest.revision,
      name: "Successor",
      baseURL: "https://successor.invalid/v1",
      key: "fake-successor",
    }
    const successor = await read<Auth>(await request(app, `auth/vendors/${vendor.id}`, "PUT", command))
    const confirmed = await read<Auth>(await request(app, `auth/vendors/${vendor.id}`, "PUT", command))
    expect(successor.revision).toBe(deleted.revision + 1)
    expect(successor.vendors.find((item) => item.id === vendor.id)!.entityId).not.toBe(vendor.entityId)
    expect(confirmed.revision).toBe(successor.revision)
    const oldDelete = await read<Auth>(await request(app, `auth/vendors/${vendor.id}`, "DELETE", input))
    expect(oldDelete.revision).toBe(successor.revision)
    expect(oldDelete.vendors.find((item) => item.id === vendor.id)).toEqual(
      successor.vendors.find((item) => item.id === vendor.id),
    )
  } finally {
    await app.dispose()
  }
})
test("RV-04 control: auth revision conflict is still uncommitted failure", async () => {
  const app = prepared
  try {
    const initial = await read<Auth>(await request(app, "auth"))
    const saved = await read<Auth>(
      await request(app, "auth/vendors/commit-control", "PUT", {
        name: "Before",
        baseURL: "https://control.invalid/v1",
        key: "fake-control",
        revision: initial.revision,
      }),
    )
    const vendor = saved.vendors.find((item) => item.id === "commit-control")!
    const response = await request(app, "auth/vendors/commit-control", "PUT", {
      name: "Should not commit",
      revision: initial.revision,
      expectedEntityId: vendor.entityId,
    })
    const latest = await read<Auth & { vendors: Array<{ id: string; name: string }> }>(await request(app, "auth"))
    expect(response.status).toBe(409)
    expect(latest.revision).toBe(saved.revision)
    expect(latest.vendors.find((item) => item.id === vendor.id)?.name).toBe("Before")
  } finally {
    await app.dispose()
  }
})
