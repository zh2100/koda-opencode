import { expect, test } from "bun:test"
import { Effect, Layer, PlatformError } from "effect"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { RelayGroup } from "@opencode-ai/protocol/groups/relay"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { RelayAuth } from "@opencode-ai/core/relay-auth"
import { RelayCatalog } from "@opencode-ai/core/relay-catalog"
import { RelaySecretStore } from "@opencode-ai/core/relay-secret-store"
import { Relay } from "../../schema/src/relay"
import { RelayHandler } from "../src/handlers/relay"
import { LocationMiddleware } from "../src/location"
import { Authorization } from "../src/middleware/authorization"
import { schemaErrorLayer } from "../src/middleware/schema-error"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import path from "node:path"

const files = AppNodeBuilder.build(FSUtil.node)
const withServer = (
  root: string,
  run: (request: (route: string, method?: string, body?: object) => Promise<Response>) => Promise<void>,
  filesystem = files,
  limit = 1024,
) => {
  const global = Global.layerWith({ data: root, state: path.join(root, "state") })
  const services = AppNodeBuilder.build(LayerNode.group([RelayAuth.node, RelayCatalog.node]), [
    [Global.node, global],
    [FSUtil.node, filesystem],
    [
      RelaySecretStore.node,
      RelaySecretStore.makeLayer(undefined).pipe(Layer.provide(filesystem), Layer.provide(global)),
    ],
  ]).pipe(Layer.provide(Layer.succeed(RelayAuth.ReplayLimit, limit)))
  return Effect.gen(function* () {
    const auth = yield* RelayAuth.Service
    const catalog = yield* RelayCatalog.Service
    const app = HttpRouter.toWebHandler(
      HttpApiBuilder.layer(HttpApi.make("server").add(RelayGroup)).pipe(
        Layer.provide(RelayHandler),
        Layer.provide(
          Layer.succeed(
            LocationMiddleware,
            LocationMiddleware.of((effect) => effect as never),
          ),
        ),
        Layer.provide(
          Layer.succeed(
            Authorization,
            Authorization.of((effect) => effect),
          ),
        ),
        Layer.provide(schemaErrorLayer),
        Layer.provide(HttpServer.layerServices),
        Layer.provide(Layer.succeed(RelayAuth.Service, auth)),
        Layer.provide(Layer.succeed(RelayCatalog.Service, catalog)),
      ),
      { disableLogger: true },
    )
    yield* Effect.promise(async () => {
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => app.handler(request) })
      try {
        await run((route, method = "GET", body) =>
          fetch(new URL(`/api/relay/${route}`, server.url), {
            method,
            ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
          }),
        )
      } finally {
        await server.stop(true)
        await app.dispose()
      }
    })
  }).pipe(Effect.scoped, Effect.provide(services), Effect.runPromise)
}
const state = async (response: Response) => {
  expect(response.status).toBe(200)
  const text = await response.text()
  for (const privateField of ["fake-before", "fake-next", "keyRef", "fingerprint", "cleanupPending"])
    expect(text).not.toContain(privateField)
  const body = JSON.parse(text)
  return (body.data ?? body) as typeof Relay.AuthState.Type
}
const seed = { name: "Before", baseURL: "https://baseline.invalid/v1", key: "fake-before", revision: 0 }
const disk = (root: string) => Bun.file(path.join(root, "relay-auth.json")).text()

test("S03 real TCP returns a safe declared error for corrupted credential shapes without replacing bytes", async () => {
  await using tmp = await tmpdir()
  await withServer(tmp.path, async (request) => {
    await state(await request("auth/vendors/baseline", "PUT", seed))
    const file = path.join(tmp.path, "relay-secrets.json")
    const original = await Bun.file(file).json() as Record<string, string>
    const ref = Object.keys(original)[0]
    const marker = "FAKE_SECRET_HTTP_SENTINEL"
    for (const content of [
      "{", JSON.stringify({ [ref]: { secret: marker } }), JSON.stringify({ [ref]: [marker] }),
      JSON.stringify({ [ref]: 123 }), JSON.stringify({ [ref]: null }), JSON.stringify([marker]), "null",
    ]) {
      await Bun.write(file, content)
      const response = await request("models/probe", "POST", { vendorId: "baseline" })
      expect(response.status).toBe(503)
      const body = await response.text()
      expect(body).toContain("SECRET_STORE_UNAVAILABLE")
      for (const privateValue of [marker, "fake-before", ref, "relay-secrets.json", tmp.path]) expect(body).not.toContain(privateValue)
      expect(await Bun.file(file).text()).toBe(content)
    }
  })
})

for (const protectedDelete of [false, true]) {
  test(`A08 real TCP: ${protectedDelete ? "protected" : "compatible"} delete confirms only its exact command`, async () => {
    await using tmp = await tmpdir()
    await withServer(tmp.path, async (request) => {
      const first = await state(await request("auth/vendors/baseline", "PUT", seed))
      const command = { revision: first.revision, operationId: "delete-http", ...(protectedDelete ? { expectedEntityId: first.vendors[0].entityId } : {}) }
      const removed = await state(await request("auth/vendors/baseline", "DELETE", command))
      const successor = await state(await request("auth/vendors/baseline", "PUT", { ...seed, key: "fake-next", revision: removed.revision }))
      const before = await disk(tmp.path)
      expect((await state(await request("auth/vendors/baseline", "DELETE", command))).revision).toBe(successor.revision)
      for (const patch of [
        { revision: successor.revision },
        { expectedEntityId: protectedDelete ? undefined : first.vendors[0].entityId },
      ]) {
        const rejected = await request("auth/vendors/baseline", "DELETE", { ...command, ...patch })
        expect(rejected.status).toBe(409)
        expect(await rejected.text()).not.toContain("fingerprint")
      }
      expect((await request("auth/vendors/other", "DELETE", command)).status).toBe(409)
      expect((await request("auth/vendors/baseline/key", "DELETE", command)).status).toBe(409)
      expect(await disk(tmp.path)).toBe(before)
    })
  })
}

for (const after of [false, true]) {
  test(`A07 real TCP: delete publication rejection ${after ? "after" : "before"} rename cannot invent confirmation`, async () => {
    await using tmp = await tmpdir()
    let armed = false
    const filesystem = Layer.effect(FSUtil.Service, Effect.gen(function* () {
      const original = yield* FSUtil.Service
      return FSUtil.Service.of({
        ...original,
        rename: (source, target) => {
          if (!armed || target !== path.join(tmp.path, "relay-auth.json")) return original.rename(source, target)
          armed = false
          const denied = Effect.fail(new PlatformError.PlatformError(new PlatformError.SystemError({
            _tag: "PermissionDenied", module: "FileSystem", method: "rename", syscall: "rename",
          })))
          return after ? original.rename(source, target).pipe(Effect.andThen(denied)) : denied
        },
      })
    })).pipe(Layer.provide(files))
    await withServer(tmp.path, async (request) => {
      const first = await state(await request("auth/vendors/baseline", "PUT", seed))
      const command = { revision: first.revision, operationId: "failed-delete" }
      const original = await disk(tmp.path)
      armed = true
      expect((await request("auth/vendors/baseline", "DELETE", command)).status).toBe(503)
      if (!after) {
        expect(await disk(tmp.path)).toBe(original)
        expect((await state(await request("auth/vendors/baseline", "DELETE", command))).revision).toBe(first.revision + 1)
        return
      }
      const committed = await state(await request("auth"))
      expect(committed.revision).toBe(first.revision + 1)
      expect(committed.vendors).toHaveLength(0)
      const successor = await state(await request("auth/vendors/baseline", "PUT", { ...seed, key: "fake-next", revision: committed.revision }))
      const bytes = await disk(tmp.path)
      expect((await request("auth/vendors/baseline", "DELETE", command)).status).toBe(409)
      expect((await state(await request("auth"))).revision).toBe(successor.revision)
      expect(await disk(tmp.path)).toBe(bytes)
    }, filesystem)
  })
}

test("O24/O25/O27/O29 actual TCP enforces exact commands and preserves latest snapshot semantics", async () => {
  await using tmp = await tmpdir()
  await withServer(tmp.path, async (request) => {
    const first = await state(await request("auth/vendors/baseline", "PUT", seed))
    expect(first.capabilities).toContain("vendor-commit-baseline-v1")
    const command = {
      expectedEntityId: first.vendors[0]!.entityId,
      key: "fake-next",
      revision: first.revision,
      operationId: "exact-http",
    }
    const saved = await state(await request("auth/vendors/baseline", "PUT", command))
    expect(saved.vendors[0]!.revision).toBe(first.vendors[0]!.revision + 1)
    const before = await disk(tmp.path)
    expect((await state(await request("auth/vendors/baseline", "PUT", command))).revision).toBe(saved.revision)
    for (const patch of [
      { key: "fake-wrong" },
      { revision: saved.revision },
      { expectedEntityId: undefined },
      { name: "Before" },
    ]) {
      const response = await request("auth/vendors/baseline", "PUT", { ...command, ...patch })
      expect(response.status).toBe(409)
      expect(await response.text()).not.toContain("fake-")
      expect(await disk(tmp.path)).toBe(before)
    }
    for (const [route, method] of [
      ["auth/vendors/other", "PUT"],
      ["auth/vendors/baseline/key", "DELETE"],
      ["auth/vendors/baseline", "DELETE"],
    ]) {
      expect((await request(route!, method!, command)).status).toBe(409)
      expect(await disk(tmp.path)).toBe(before)
    }
    const empty = await state(
      await request("auth/vendors/baseline", "PUT", {
        expectedEntityId: first.vendors[0]!.entityId,
        revision: saved.revision,
      }),
    )
    expect(empty.vendors[0]!.revision).toBe(saved.vendors[0]!.revision + 1)
    const clear = { expectedEntityId: first.vendors[0]!.entityId, revision: empty.revision, operationId: "clear-http" }
    const cleared = await state(await request("auth/vendors/baseline/key", "DELETE", clear))
    expect(cleared.vendors[0]!.revision).toBe(empty.vendors[0]!.revision + 1)
    const restored = await state(
      await request("auth/vendors/baseline", "PUT", { key: "fake-next", revision: cleared.revision }),
    )
    const restoredBytes = await disk(tmp.path)
    const latestReplay = await state(await request("auth/vendors/baseline/key", "DELETE", clear))
    expect(latestReplay.vendors[0]!.hasKey).toBe(true)
    expect(latestReplay.revision).toBe(restored.revision)
    expect(await disk(tmp.path)).toBe(restoredBytes)
  })
})

for (const failure of ["before-replace", "after-replace"] as const)
  test(`O26/O28 actual TCP ${failure} failure distinguishes disk outcome and exact retry`, async () => {
    await using tmp = await tmpdir()
    let phase: "ready" | "armed" | "published" = "ready"
    const denied = () =>
      new PlatformError.PlatformError(
        new PlatformError.SystemError({ _tag: "PermissionDenied", module: "FileSystem", method: "rename" }),
      )
    const filesystem = Layer.effect(
      FSUtil.Service,
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        return FSUtil.Service.of({
          ...fs,
          rename: (from, to) =>
            phase === "armed" &&
            failure === "before-replace" &&
            path.resolve(to) === path.join(tmp.path, "relay-auth.json")
              ? Effect.fail(denied())
              : fs.rename(from, to).pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      if (phase === "armed" && path.resolve(to) === path.join(tmp.path, "relay-auth.json"))
                        phase = "published"
                    }),
                  ),
                ),
          readJson: (file) =>
            phase === "published" &&
            failure === "after-replace" &&
            path.resolve(file) === path.join(tmp.path, "relay-auth.json")
              ? Effect.fail(denied())
              : fs.readJson(file),
        })
      }),
    ).pipe(Layer.provide(files))
    await withServer(
      tmp.path,
      async (request) => {
        const first = await state(await request("auth/vendors/baseline", "PUT", seed))
        const command = {
          expectedEntityId: first.vendors[0]!.entityId,
          name: "After",
          revision: first.revision,
          operationId: `fault-${failure}`,
        }
        const before = await disk(tmp.path)
        phase = "armed"
        const response = await request("auth/vendors/baseline", "PUT", command)
        expect(response.status).toBe(503)
        expect(await response.text()).not.toContain("fake-")
        const published = JSON.parse(await disk(tmp.path))
        expect(published.revision).toBe(first.revision + (failure === "after-replace" ? 1 : 0))
        if (failure === "before-replace") expect(await disk(tmp.path)).toBe(before)
        phase = "ready"
        const read = await state(await request("auth"))
        expect(read.revision).toBe(published.revision)
        const retry = await state(await request("auth/vendors/baseline", "PUT", command))
        expect(retry.revision).toBe(first.revision + 1)
        expect(retry.vendors[0]!.revision).toBe(first.vendors[0]!.revision + 1)
      },
      filesystem,
    )
  })

test("O29 actual TCP eviction and service restart never infer mutation receipts; durable create still replays", async () => {
  await using tmp = await tmpdir()
  const create = { ...seed, createOnly: true, operationId: "durable-http" }
  let command: object = {}
  let receipt: (typeof Relay.AuthState.Type)["operationReceipt"]
  await withServer(
    tmp.path,
    async (request) => {
      const first = await state(await request("auth/vendors/baseline", "PUT", create))
      receipt = first.operationReceipt
      command = {
        expectedEntityId: first.vendors[0]!.entityId,
        name: "First",
        revision: first.revision,
        operationId: "evicted-http",
      }
      let latest = await state(await request("auth/vendors/baseline", "PUT", command))
      for (const name of ["Second", "Third"])
        latest = await state(
          await request("auth/vendors/baseline", "PUT", { name, revision: latest.revision, operationId: name }),
        )
      const before = await disk(tmp.path)
      expect((await request("auth/vendors/baseline", "PUT", command)).status).toBe(409)
      expect(await disk(tmp.path)).toBe(before)
      expect((await state(await request("auth/vendors/baseline", "PUT", create))).operationReceipt).toEqual(receipt)
    },
    files,
    2,
  )
  await withServer(
    tmp.path,
    async (request) => {
      const before = await disk(tmp.path)
      expect((await request("auth/vendors/baseline", "PUT", command)).status).toBe(409)
      expect(await disk(tmp.path)).toBe(before)
      expect((await state(await request("auth/vendors/baseline", "PUT", create))).operationReceipt).toEqual(receipt)
    },
    files,
    2,
  )
})

test("O24/O25 actual TCP pending clear returns the latest snapshot while preserving the later credential", async () => {
  await using tmp = await tmpdir()
  let blocked = false
  const filesystem = Layer.effect(
    FSUtil.Service,
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      return FSUtil.Service.of({
        ...fs,
        rename: (from, to) =>
          blocked && path.resolve(to) === path.join(tmp.path, "relay-secrets.json")
            ? Effect.fail(
                new PlatformError.PlatformError(
                  new PlatformError.SystemError({ _tag: "PermissionDenied", module: "FileSystem", method: "rename" }),
                ),
              )
            : fs.rename(from, to),
      })
    }),
  ).pipe(Layer.provide(files))
  await withServer(
    tmp.path,
    async (request) => {
      const initial = await state(await request("auth/vendors/baseline", "PUT", seed))
      const baseline = initial.vendors[0]!.revision
      const command = {
        expectedEntityId: initial.vendors[0]!.entityId,
        revision: initial.revision,
        operationId: "pending-clear-http",
      }
      blocked = true
      const cleared = await state(await request("auth/vendors/baseline/key", "DELETE", command))
      expect(cleared.vendors[0]!.revision).toBe(baseline + 1)
      expect(JSON.parse(await disk(tmp.path)).pendingCleanup).toHaveLength(1)
      blocked = false
      const restored = await state(
        await request("auth/vendors/baseline", "PUT", { key: "fake-next", revision: cleared.revision }),
      )
      const other = await state(await request("auth/vendors/other", "PUT", { ...seed, revision: restored.revision }))
      const replay = await state(await request("auth/vendors/baseline/key", "DELETE", command))
      expect(replay.revision).toBe(other.revision)
      expect(replay.vendors.find((vendor) => vendor.id === "baseline")!.revision).toBe(baseline + 2)
      expect(replay.vendors.find((vendor) => vendor.id === "baseline")!.hasKey).toBe(true)
      expect(JSON.parse(await disk(tmp.path)).pendingCleanup).toBeUndefined()
      const stored = JSON.parse(await Bun.file(path.join(tmp.path, "relay-secrets.json")).text())
      const vendor = JSON.parse(await disk(tmp.path)).vendors.baseline
      expect(stored[vendor.keyRef]).toBe("fake-next")
    },
    filesystem,
  )
})
