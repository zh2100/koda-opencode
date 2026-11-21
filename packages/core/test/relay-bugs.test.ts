import { expect, test } from "bun:test"
import { Deferred, Effect, Layer, Stream } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { RelayAuth } from "@opencode-ai/core/relay-auth"
import { RelayCatalog } from "@opencode-ai/core/relay-catalog"
import { RelaySecretStore } from "@opencode-ai/core/relay-secret-store"
import { EventV2 } from "@opencode-ai/core/event"
import { Relay } from "@opencode-ai/schema/relay"
import { RelayEvent } from "@opencode-ai/schema/relay-event"
import { Model } from "@opencode-ai/schema/model"
import { tmpdir } from "./fixture/tmpdir"
import path from "node:path"

const open = (root: string) =>
  AppNodeBuilder.build(LayerNode.group([RelayCatalog.node, RelayAuth.node, EventV2.node]), [
    [Global.node, Global.layerWith({ data: root, state: path.join(root, "reader-state") })],
    [RelaySecretStore.node, RelaySecretStore.memoryLayer],
  ])

test("BF-04 explicit sync must adopt an external process catalog commit", async () => {
  await using tmp = await tmpdir()
  const result = await Effect.scoped(
    Effect.gen(function* () {
      const catalog = yield* RelayCatalog.Service
      expect(yield* catalog.managed()).toEqual([])
      yield* Effect.promise(async () => {
        const child = Bun.spawn(
          [process.execPath, path.join(import.meta.dir, "fixture/relay-catalog-writer.ts"), tmp.path, "external-model"],
          { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
        )
        try {
          child.stdin.write("go\n")
          child.stdin.end()
          const status = await child.exited
          if (status !== 0) throw new Error(await new Response(child.stderr).text())
        } finally {
          if (child.exitCode === null) child.kill()
          await child.exited
        }
      })
      yield* catalog.syncVendors()
      const disk = yield* Effect.promise(() => Bun.file(path.join(tmp.path, "relay-catalog.json")).json())
      return {
        disk: disk.managed.map((item: { modelId: string }) => item.modelId),
        memory: (yield* catalog.managed()).map((item) => item.modelId),
      }
    }),
  ).pipe(Effect.provide(open(tmp.path)), Effect.runPromise)
  expect(result.disk).toEqual(["external-model"])
  expect(result.memory).toEqual(result.disk)
}, 20000)

test("BF-05 an auth identity change must publish a catalog invalidation even without catalog file changes", async () => {
  await using tmp = await tmpdir()
  const result = await Effect.scoped(
    Effect.gen(function* () {
      const catalog = yield* RelayCatalog.Service
      const auth = yield* RelayAuth.Service
      const events = yield* EventV2.Service
      yield* auth.setVendor({
        name: "Independent",
        baseURL: "https://provider.test/v1",
        id: Relay.VendorID.chatgpt,
        key: "fake-review-key",
        revision: 0,
      })
      yield* catalog.syncVendors()
      const first = yield* Deferred.make<void>()
      let notices = 0
      yield* events.subscribe(RelayEvent.CatalogUpdated).pipe(
        Stream.runForEach(() =>
          Effect.gen(function* () {
            notices++
            yield* Deferred.succeed(first, undefined)
          }),
        ),
        Effect.forkChild({ startImmediately: true }),
      )
      yield* catalog.setVisibility({
        vendorId: Relay.VendorID.chatgpt,
        modelId: Model.ID.make("base-model"),
        visible: true,
      })
      yield* Deferred.await(first).pipe(Effect.timeout("3 seconds"))
      const before = notices
      yield* auth.clearVendorKey({ id: Relay.VendorID.chatgpt, revision: 1 })
      yield* catalog.syncVendors()
      yield* Effect.sleep(1250)
      return { before, after: notices }
    }),
  ).pipe(Effect.provide(open(tmp.path)), Effect.runPromise)
  expect(result.before).toBe(1)
  expect(result.after).toBe(2)
}, 20000)

test("BF-C03 an ordinary local catalog write publishes and updates memory", async () => {
  await using tmp = await tmpdir()
  const items = await Effect.scoped(
    Effect.gen(function* () {
      const auth = yield* RelayAuth.Service
      yield* auth.setVendor({
        id: Relay.VendorID.chatgpt,
        name: "Independent",
        baseURL: "https://provider.test/v1",
        key: "local-key",
        revision: 0,
      })
      const catalog = yield* RelayCatalog.Service
      yield* catalog.setVisibility({
        vendorId: Relay.VendorID.chatgpt,
        modelId: Model.ID.make("local-model"),
        visible: true,
      })
      return yield* catalog.managed()
    }),
  ).pipe(Effect.provide(open(tmp.path)), Effect.runPromise)
  expect(items.map((item) => String(item.modelId))).toEqual(["local-model"])
})
