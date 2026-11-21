import { describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Fiber, Layer, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { Relay } from "@opencode-ai/schema/relay"
import { Model } from "@opencode-ai/schema/model"
import { EventV2 } from "@opencode-ai/core/event"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { RelayAuth } from "@opencode-ai/core/relay-auth"
import { RelayCatalog } from "@opencode-ai/core/relay-catalog"
import { RelaySecretStore } from "@opencode-ai/core/relay-secret-store"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"
import path from "node:path"

const it = testEffect(Layer.empty)
const catalogFile = (root: string) => path.join(root, "relay-catalog.json")
const readDisk = (root: string) =>
  Effect.gen(function* () {
    const text = yield* Effect.promise(() => Bun.file(catalogFile(root)).text())
    return JSON.parse(text) as {
      managed: Array<{ vendorId: string; modelId: string; visible: boolean }>
      candidates: Array<{ vendorId?: string; modelId: string }>
      catalogRevision: number
      refreshRequests: Record<string, string>
    }
  })
const ids = (items: ReadonlyArray<{ modelId: string }>) => items.map((item) => item.modelId).sort()
const http = (body: (authorization: string) => Effect.Effect<unknown>) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
      Effect.gen(function* () {
        const authorization = request.headers.authorization ?? ""
        const value = yield* body(authorization)
        return HttpClientResponse.fromWeb(request, new Response(JSON.stringify(value), { status: 200 }))
      }),
    ),
  )
const open = (root: string, client?: Layer.Layer<HttpClient.HttpClient>, filesystem?: Layer.Layer<FSUtil.Service>) =>
  AppNodeBuilder.build(LayerNode.group([RelayCatalog.node, RelayAuth.node, EventV2.node]), [
    [Global.node, Global.layerWith({ data: root })],
    [RelaySecretStore.node, RelaySecretStore.memoryLayer],
    ...(client ? [[LayerNodePlatform.httpClient, client] as const] : []),
    ...(filesystem ? [[FSUtil.node, filesystem] as const] : []),
  ])

describe("RelayCatalog transactions", () => {
  it.live("C02 keeps a visibility change made while refresh HTTP is pending", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const layer = open(
            tmp.path,
            http((_authorization) =>
              Effect.gen(function* () {
                yield* Deferred.succeed(started, undefined)
                yield* Deferred.await(release)
                return { data: [{ id: "gpt-refresh" }] }
              }),
            ),
          )
          const result = yield* Effect.gen(function* () {
            const auth = yield* RelayAuth.Service
            const catalog = yield* RelayCatalog.Service
            yield* auth.setVendor({
              name: "Independent",
              baseURL: "https://provider.test/v1",
              id: Relay.VendorID.chatgpt,
              key: "sk-c02",
              revision: 0,
            })
            const refreshing = yield* catalog.refresh(Relay.VendorID.chatgpt).pipe(Effect.forkChild)
            yield* Deferred.await(started).pipe(Effect.timeout("5 seconds"))
            yield* catalog.setVisibility({
              vendorId: Relay.VendorID.chatgpt,
              modelId: Model.ID.make("gpt-user"),
              visible: true,
            })
            yield* Deferred.succeed(release, undefined)
            yield* Fiber.join(refreshing).pipe(Effect.timeout("5 seconds"))
            return {
              visible: catalog.visible(RelayCatalog.modelID("chatgpt", "gpt-user")),
              disk: ids((yield* readDisk(tmp.path)).managed),
            }
          }).pipe(Effect.provide(layer), Effect.ensuring(Deferred.succeed(release, undefined)))
          expect(result.visible).toBe(true)
          expect(result.disk).toEqual(["gpt-user"])
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("C03 drops a refresh after its vendor is deleted", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const id = Relay.VendorID.make("gone")
          const layer = open(
            tmp.path,
            http((_authorization) =>
              Effect.gen(function* () {
                yield* Deferred.succeed(started, undefined)
                yield* Deferred.await(release)
                return { data: [{ id: "gone-model" }] }
              }),
            ),
          )
          const result = yield* Effect.gen(function* () {
            const auth = yield* RelayAuth.Service
            const catalog = yield* RelayCatalog.Service
            const state = yield* auth.setVendor({
              id,
              name: "Gone",
              key: "sk-gone",
              baseURL: "https://gone.invalid/v1",
              revision: 0,
            })
            const refreshing = yield* catalog.refresh(id).pipe(Effect.forkChild)
            yield* Deferred.await(started).pipe(Effect.timeout("5 seconds"))
            yield* auth.deleteVendor({ id, revision: state.revision })
            yield* catalog.syncVendors()
            yield* Deferred.succeed(release, undefined)
            yield* Fiber.join(refreshing).pipe(Effect.timeout("5 seconds"))
            const disk = yield* readDisk(tmp.path)
            return {
              candidates: ids(disk.candidates),
              managed: ids(disk.managed),
              requests: disk.refreshRequests,
            }
          }).pipe(Effect.provide(layer), Effect.ensuring(Deferred.succeed(release, undefined)))
          expect(result.candidates).toEqual([])
          expect(result.managed).toEqual([])
          expect(result.requests).toEqual({})
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("C04 keeps both vendors when refreshes finish in reverse order", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const gates = {
            [Relay.VendorID.chatgpt]: yield* Deferred.make<void>(),
            [Relay.VendorID.grok]: yield* Deferred.make<void>(),
          }
          const started = {
            [Relay.VendorID.chatgpt]: yield* Deferred.make<void>(),
            [Relay.VendorID.grok]: yield* Deferred.make<void>(),
          }
          const layer = open(
            tmp.path,
            http((authorization) =>
              Effect.gen(function* () {
                const vendor = authorization.includes("chatgpt") ? Relay.VendorID.chatgpt : Relay.VendorID.grok
                yield* Deferred.succeed(started[vendor], undefined)
                yield* Deferred.await(gates[vendor])
                return { data: [{ id: vendor === Relay.VendorID.chatgpt ? "gpt-a" : "grok-b" }] }
              }),
            ),
          )
          const disk = yield* Effect.gen(function* () {
            const auth = yield* RelayAuth.Service
            const catalog = yield* RelayCatalog.Service
            let state = yield* auth.setVendor({
              name: "Independent",
              baseURL: "https://provider.test/v1",
              id: Relay.VendorID.chatgpt,
              key: "chatgpt-key",
              revision: 0,
            })
            yield* auth.setVendor({
              name: "Independent",
              baseURL: "https://provider.test/v1",
              id: Relay.VendorID.grok,
              key: "grok-key",
              revision: state.revision,
            })
            const first = yield* catalog.refresh(Relay.VendorID.chatgpt).pipe(Effect.forkChild)
            const second = yield* catalog.refresh(Relay.VendorID.grok).pipe(Effect.forkChild)
            yield* Deferred.await(started[Relay.VendorID.chatgpt]).pipe(Effect.timeout("5 seconds"))
            yield* Deferred.await(started[Relay.VendorID.grok]).pipe(Effect.timeout("5 seconds"))
            yield* Deferred.succeed(gates[Relay.VendorID.grok], undefined)
            yield* Fiber.join(second).pipe(Effect.timeout("5 seconds"))
            yield* Deferred.succeed(gates[Relay.VendorID.chatgpt], undefined)
            yield* Fiber.join(first).pipe(Effect.timeout("5 seconds"))
            return ids((yield* readDisk(tmp.path)).candidates)
          }).pipe(
            Effect.provide(layer),
            Effect.ensuring(
              Effect.all(
                [
                  Deferred.succeed(gates[Relay.VendorID.chatgpt], undefined),
                  Deferred.succeed(gates[Relay.VendorID.grok], undefined),
                ],
                { concurrency: "unbounded" },
              ),
            ),
          )
          expect(disk).toEqual(["gpt-a", "grok-b"])
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("C05 keeps the newer same-vendor refresh when it finishes first", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const release = [yield* Deferred.make<void>(), yield* Deferred.make<void>()]
          const started = [yield* Deferred.make<void>(), yield* Deferred.make<void>()]
          let calls = 0
          const layer = open(
            tmp.path,
            http((_authorization) =>
              Effect.gen(function* () {
                const index = calls
                calls += 1
                yield* Deferred.succeed(started[index]!, undefined)
                yield* Deferred.await(release[index]!)
                return { data: [{ id: index === 0 ? "old-model" : "new-model" }] }
              }),
            ),
          )
          const disk = yield* Effect.gen(function* () {
            const auth = yield* RelayAuth.Service
            const catalog = yield* RelayCatalog.Service
            yield* auth.setVendor({
              name: "Independent",
              baseURL: "https://provider.test/v1",
              id: Relay.VendorID.chatgpt,
              key: "sk-c05",
              revision: 0,
            })
            const old = yield* catalog.refresh(Relay.VendorID.chatgpt).pipe(Effect.forkChild)
            yield* Deferred.await(started[0]!).pipe(Effect.timeout("5 seconds"))
            const fresh = yield* catalog.refresh(Relay.VendorID.chatgpt).pipe(Effect.forkChild)
            yield* Deferred.await(started[1]!).pipe(Effect.timeout("5 seconds"))
            yield* Deferred.succeed(release[1]!, undefined)
            yield* Fiber.join(fresh).pipe(Effect.timeout("5 seconds"))
            yield* Deferred.succeed(release[0]!, undefined)
            yield* Fiber.join(old).pipe(Effect.timeout("5 seconds"))
            return ids((yield* readDisk(tmp.path)).candidates)
          }).pipe(
            Effect.provide(layer),
            Effect.ensuring(
              Effect.all(
                release.map((item) => Deferred.succeed(item, undefined)),
                { concurrency: "unbounded" },
              ),
            ),
          )
          expect(disk).toEqual(["new-model"])
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("C06 leaves disk, memory, and vendor stamp unchanged when write or rename fails", () =>
    Effect.gen(function* () {
      const phases = ["write", "rename"] as const
      const results = yield* Effect.forEach(
        phases,
        (phase) =>
          Effect.acquireUseRelease(
            Effect.promise(() => tmpdir()),
            (tmp) =>
              Effect.gen(function* () {
                const layer = open(tmp.path)
                yield* Effect.gen(function* () {
                  const auth = yield* RelayAuth.Service
                  const catalog = yield* RelayCatalog.Service
                  yield* auth.setVendor({
                    name: "Independent",
                    baseURL: "https://provider.test/v1",
                    id: Relay.VendorID.chatgpt,
                    key: "sk-c06",
                    revision: 0,
                  })
                  yield* catalog.setVisibility({
                    vendorId: Relay.VendorID.chatgpt,
                    modelId: Model.ID.make("gpt-kept"),
                    visible: true,
                  })
                }).pipe(Effect.provide(layer))
                const before = yield* Effect.promise(() => Bun.file(catalogFile(tmp.path)).text())
                const failed = yield* Effect.scoped(
                  Effect.gen(function* () {
                    yield* RelayCatalog.withCommitHook((current) =>
                      (phase === "write" && current === "prepare") || (phase === "rename" && current === "write")
                        ? Effect.fail(new Error(`${phase} failed`))
                        : Effect.void,
                    )
                    const catalog = yield* RelayCatalog.Service
                    const exit = yield* catalog
                      .setVisibility({
                        vendorId: Relay.VendorID.chatgpt,
                        modelId: Model.ID.make("gpt-lost"),
                        visible: true,
                      })
                      .pipe(Effect.exit)
                    const reason = exit._tag === "Failure" ? Cause.squash(exit.cause) : undefined
                    return {
                      failed: reason instanceof RelayCatalog.CatalogError,
                      memory: ids(yield* catalog.managed()),
                    }
                  }),
                ).pipe(Effect.provide(open(tmp.path)))
                const after = yield* Effect.promise(() => Bun.file(catalogFile(tmp.path)).text())
                const leftovers = yield* Effect.promise(() =>
                  Array.fromAsync(new Bun.Glob("relay-catalog.json.*.tmp").scan({ cwd: tmp.path })),
                )
                const reopened = yield* Effect.gen(function* () {
                  const catalog = yield* RelayCatalog.Service
                  return ids(yield* catalog.managed())
                }).pipe(Effect.provide(open(tmp.path)))
                return { phase, failed, after, before, leftovers, reopened }
              }),
            (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
          ),
        { concurrency: 1, discard: false },
      )
      for (const item of results) {
        expect(item.failed.failed).toBe(true)
        expect(item.failed.memory).toEqual(["gpt-kept"])
        expect(item.after).toBe(item.before)
        expect(item.leftovers).toEqual([])
        expect(item.reopened).toEqual(["gpt-kept"])
      }
    }),
  )

  it.live("C07 returns an error for a corrupt catalog and keeps the file", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => Bun.write(catalogFile(tmp.path), "{"))
          const exit = yield* Effect.gen(function* () {
            const catalog = yield* RelayCatalog.Service
            return yield* catalog.setVisibility({
              vendorId: Relay.VendorID.chatgpt,
              modelId: Model.ID.make("gpt-new"),
              visible: true,
            })
          }).pipe(Effect.provide(open(tmp.path)), Effect.exit)
          expect(exit._tag).toBe("Failure")
          if (exit._tag === "Failure") expect(Cause.squash(exit.cause)).toBeInstanceOf(RelayCatalog.CatalogError)
          expect(yield* Effect.promise(() => Bun.file(catalogFile(tmp.path)).text())).toBe("{")
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("C08 releases the commit lease when the waiter is interrupted", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const result = yield* Effect.gen(function* () {
            yield* RelayCatalog.withCommitHook((phase) =>
              phase === "write"
                ? Effect.gen(function* () {
                    yield* Deferred.succeed(entered, undefined)
                    return yield* Deferred.await(release)
                  })
                : Effect.void,
            )
            const catalog = yield* RelayCatalog.Service
            const auth = yield* RelayAuth.Service
            yield* auth.setVendor({
              name: "Independent",
              baseURL: "https://provider.test/v1",
              id: Relay.VendorID.chatgpt,
              key: "sk-c08",
              revision: 0,
            })
            const first = yield* catalog
              .setVisibility({ vendorId: Relay.VendorID.chatgpt, modelId: Model.ID.make("gpt-held"), visible: true })
              .pipe(Effect.forkChild)
            yield* Deferred.await(entered).pipe(Effect.timeout("5 seconds"))
            const second = yield* catalog
              .setVisibility({ vendorId: Relay.VendorID.chatgpt, modelId: Model.ID.make("gpt-next"), visible: true })
              .pipe(Effect.forkChild)
            yield* Deferred.succeed(release, undefined)
            yield* Fiber.interrupt(first)
            const joined = yield* Fiber.join(second).pipe(Effect.timeout("5 seconds"))
            return ids(joined)
          }).pipe(Effect.provide(open(tmp.path)), Effect.ensuring(Deferred.succeed(release, undefined)))
          expect(result).toContain("gpt-next")
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("C09 installs the renamed catalog once when cancellation arrives after rename", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const renamed = yield* Deferred.make<void>()
          const result = yield* Effect.gen(function* () {
            yield* RelayCatalog.withCommitHook((phase) =>
              phase === "renamed"
                ? Deferred.succeed(renamed, undefined).pipe(Effect.andThen(Effect.never))
                : Effect.void,
            )
            const catalog = yield* RelayCatalog.Service
            const auth = yield* RelayAuth.Service
            yield* auth.setVendor({
              name: "Independent",
              baseURL: "https://provider.test/v1",
              id: Relay.VendorID.chatgpt,
              key: "sk-c09",
              revision: 0,
            })
            const fiber = yield* catalog
              .setVisibility({ vendorId: Relay.VendorID.chatgpt, modelId: Model.ID.make("gpt-c09"), visible: true })
              .pipe(Effect.forkChild)
            yield* Deferred.await(renamed).pipe(Effect.timeout("5 seconds"))
            yield* Fiber.interrupt(fiber)
            return {
              disk: ids((yield* readDisk(tmp.path)).managed),
              memory: ids(yield* catalog.managed()),
            }
          }).pipe(Effect.provide(open(tmp.path)))
          expect(result.disk).toEqual(["gpt-c09"])
          expect(result.memory).toEqual(["gpt-c09"])
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("C10 keeps both writes from two processes sharing one data root", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const spawn = (name: string) =>
            Effect.promise(async () => {
              const child = Bun.spawn([process.execPath, "test/fixture/relay-catalog-writer.ts", tmp.path, name], {
                cwd: process.cwd(),
                stdin: "pipe",
                stdout: "pipe",
                stderr: "pipe",
              })
              let ready = ""
              const reader = child.stdout.getReader()
              const deadline = Date.now() + 10000
              while (!ready.includes("ready")) {
                if (Date.now() > deadline) throw new Error(`catalog writer ${name} did not become ready: ${ready}`)
                const chunk = await reader.read()
                if (chunk.done) break
                ready += new TextDecoder().decode(chunk.value)
              }
              if (!ready.includes("ready")) throw new Error(ready)
              child.stdin.write("go\n")
              await child.stdin.end()
              const code = await child.exited
              if (code !== 0) throw new Error(await new Response(child.stderr).text())
            })
          yield* Effect.all([spawn("gpt-left"), spawn("gpt-right")], { concurrency: "unbounded" })
          const rebuilt = yield* Effect.gen(function* () {
            const catalog = yield* RelayCatalog.Service
            return ids(yield* catalog.managed())
          }).pipe(Effect.provide(open(tmp.path)))
          expect(rebuilt).toEqual(["gpt-left", "gpt-right"])
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("C11 syncs after vendor deletion without reviving the deleted catalog", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const result = yield* Effect.gen(function* () {
            const auth = yield* RelayAuth.Service
            const catalog = yield* RelayCatalog.Service
            const id = Relay.VendorID.make("c11")
            const state = yield* auth.setVendor({
              id,
              name: "C11",
              key: "sk-c11",
              baseURL: "https://c11.invalid/v1",
              revision: 0,
            })
            yield* catalog.setVisibility({ vendorId: id, modelId: Model.ID.make("c11-model"), visible: true })
            yield* auth.deleteVendor({ id, revision: state.revision })
            yield* catalog.syncVendors()
            return ids(yield* catalog.managed())
          }).pipe(Effect.provide(open(tmp.path)))
          expect(result).toEqual([])
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  const eventsWith = (publish: () => Effect.Effect<unknown>) =>
    Layer.succeed(EventV2.Service, {
      publish: () => publish() as Effect.Effect<never>,
      subscribe: () => Stream.die("unused"),
      all: () => Stream.die("unused"),
      durable: () => Stream.die("unused"),
      listen: () => Effect.die("unused"),
      project: () => Effect.die("unused"),
      replay: () => Effect.die("unused"),
      replayAll: () => Effect.die("unused"),
      remove: () => Effect.die("unused"),
      claim: () => Effect.die("unused"),
    })

  it.live("C12 retries a failed notice and publishes once without rewriting the catalog", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          let failed = true
          let published = 0
          const layer = AppNodeBuilder.build(LayerNode.group([RelayCatalog.node, RelayAuth.node]), [
            [Global.node, Global.layerWith({ data: tmp.path })],
            [RelaySecretStore.node, RelaySecretStore.memoryLayer],
            [
              EventV2.node,
              eventsWith(() => {
                if (failed) return Effect.die("notify")
                published += 1
                return Effect.succeed({})
              }),
            ],
          ])
          const result = yield* Effect.gen(function* () {
            const auth = yield* RelayAuth.Service
            const catalog = yield* RelayCatalog.Service
            yield* auth.setVendor({
              name: "Independent",
              baseURL: "https://provider.test/v1",
              id: Relay.VendorID.chatgpt,
              key: "sk-c12",
              revision: 0,
            })
            yield* catalog.setVisibility({
              vendorId: Relay.VendorID.chatgpt,
              modelId: Model.ID.make("gpt-c12"),
              visible: true,
            })
            const first = yield* Effect.promise(() => Bun.file(catalogFile(tmp.path)).text())
            failed = false
            yield* Effect.sleep("1200 millis")
            const second = yield* Effect.promise(() => Bun.file(catalogFile(tmp.path)).text())
            return { same: first === second, memory: ids(yield* catalog.managed()), published }
          }).pipe(Effect.provide(layer))
          expect(result.memory).toEqual(["gpt-c12"])
          expect(result.same).toBe(true)
          expect(result.published).toBe(1)
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("C13 keeps an interrupted notice interrupted", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const layer = AppNodeBuilder.build(LayerNode.group([RelayCatalog.node, RelayAuth.node]), [
            [Global.node, Global.layerWith({ data: tmp.path })],
            [RelaySecretStore.node, RelaySecretStore.memoryLayer],
            [EventV2.node, eventsWith(() => Effect.interrupt)],
          ])
          const exit = yield* Effect.gen(function* () {
            const auth = yield* RelayAuth.Service
            const catalog = yield* RelayCatalog.Service
            yield* auth.setVendor({
              name: "Independent",
              baseURL: "https://provider.test/v1",
              id: Relay.VendorID.chatgpt,
              key: "sk-c13",
              revision: 0,
            })
            yield* catalog.setVisibility({
              vendorId: Relay.VendorID.chatgpt,
              modelId: Model.ID.make("gpt-c13"),
              visible: true,
            })
          }).pipe(Effect.exit, Effect.provide(layer))
          expect(exit._tag === "Failure" && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("C14 stops notice retries when the catalog service scope ends", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          let published = 0
          const layer = AppNodeBuilder.build(LayerNode.group([RelayCatalog.node, RelayAuth.node]), [
            [Global.node, Global.layerWith({ data: tmp.path })],
            [RelaySecretStore.node, RelaySecretStore.memoryLayer],
            [
              EventV2.node,
              eventsWith(() => {
                published += 1
                return Effect.die("notify")
              }),
            ],
          ])
          const counts = yield* Effect.gen(function* () {
            const auth = yield* RelayAuth.Service
            const catalog = yield* RelayCatalog.Service
            yield* auth.setVendor({
              name: "Independent",
              baseURL: "https://provider.test/v1",
              id: Relay.VendorID.chatgpt,
              key: "sk-c14",
              revision: 0,
            })
            yield* catalog.setVisibility({
              vendorId: Relay.VendorID.chatgpt,
              modelId: Model.ID.make("gpt-c14"),
              visible: true,
            })
            return published
          }).pipe(Effect.provide(layer))
          const afterScope = published
          yield* Effect.sleep("1200 millis")
          expect(counts).toBeGreaterThan(0)
          expect(published).toBe(afterScope)
          expect(published).toBeLessThanOrEqual(9)
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("C15 fails catalog construction when the stored catalog is corrupt", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => Bun.write(catalogFile(tmp.path), "{"))
          const exit = yield* Effect.gen(function* () {
            yield* RelayCatalog.Service
          }).pipe(Effect.exit, Effect.provide(open(tmp.path)), Effect.exit)
          const text = yield* Effect.promise(() => Bun.file(catalogFile(tmp.path)).text())
          expect(exit._tag).toBe("Failure")
          if (exit._tag === "Failure") expect(Cause.squash(exit.cause)).toBeInstanceOf(RelayCatalog.CatalogError)
          expect(text).toBe("{")
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("C16 returns CatalogError when a later catalog read is corrupt", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const exit = yield* Effect.gen(function* () {
            const auth = yield* RelayAuth.Service
            const catalog = yield* RelayCatalog.Service
            yield* auth.setVendor({
              name: "Independent",
              baseURL: "https://provider.test/v1",
              id: Relay.VendorID.chatgpt,
              key: "sk-c16",
              revision: 0,
            })
            yield* Effect.promise(() => Bun.write(catalogFile(tmp.path), "{"))
            return yield* catalog
              .setVisibility({
                vendorId: Relay.VendorID.chatgpt,
                modelId: Model.ID.make("gpt-c16"),
                visible: true,
              })
              .pipe(Effect.exit)
          }).pipe(Effect.provide(open(tmp.path)))
          const text = yield* Effect.promise(() => Bun.file(catalogFile(tmp.path)).text())
          expect(exit._tag).toBe("Failure")
          if (exit._tag === "Failure") expect(Cause.squash(exit.cause)).toBeInstanceOf(RelayCatalog.CatalogError)
          expect(text).toBe("{")
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("C212-C215 retains exhausted notice ownership and explicitly retries without rewriting data", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        let failed = true
        let attempts = 0
        let delivered = 0
        const layer = AppNodeBuilder.build(LayerNode.group([RelayCatalog.node, RelayAuth.node]), [
          [Global.node, Global.layerWith({ data: tmp.path })],
          [RelaySecretStore.node, RelaySecretStore.memoryLayer],
          [
            EventV2.node,
            eventsWith(() => {
              attempts += 1
              if (failed) return Effect.die("controlled notification failure")
              delivered += 1
              return Effect.succeed({})
            }),
          ],
        ])
        return Effect.gen(function* () {
          const auth = yield* RelayAuth.Service
          yield* auth.setVendor({
            id: Relay.VendorID.chatgpt,
            name: "Independent",
            baseURL: "https://provider.test/v1",
            key: "notice-key",
            revision: 0,
          })
          const catalog = yield* RelayCatalog.Service
          yield* catalog.setVisibility({
            vendorId: Relay.VendorID.chatgpt,
            modelId: Model.ID.make("notice-retry"),
            visible: true,
          })
          for (const _ of Array.from({ length: 12 })) yield* catalog.syncVendors()
          expect((yield* catalog.synchronize()).notice.status).toBe("exhausted")
          expect(attempts).toBe(9)
          const before = yield* Effect.promise(() => Bun.file(catalogFile(tmp.path)).text())
          failed = false
          yield* catalog.managed()
          yield* catalog.syncVendors()
          expect(attempts).toBe(9)
          const results = yield* Effect.all(
            [catalog.synchronize({ retryNotice: true }), catalog.synchronize({ retryNotice: true })],
            { concurrency: "unbounded" },
          )
          expect(results.map((result) => result.notice.status)).toEqual(["idle", "idle"])
          expect(delivered).toBe(1)
          expect(attempts).toBe(10)
          expect(yield* Effect.promise(() => Bun.file(catalogFile(tmp.path)).text())).toBe(before)
        }).pipe(Effect.provide(layer))
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("RV-06 concurrent explicit idle recovery coalesces and a later retry can publish again", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        let delivered = 0
        const layer = AppNodeBuilder.build(LayerNode.group([RelayCatalog.node, RelayAuth.node]), [
          [Global.node, Global.layerWith({ data: tmp.path })],
          [RelaySecretStore.node, RelaySecretStore.memoryLayer],
          [
            EventV2.node,
            eventsWith(() =>
              Effect.sync(() => {
                delivered += 1
                return {}
              }),
            ),
          ],
        ])
        return Effect.gen(function* () {
          const catalog = yield* RelayCatalog.Service
          const auth = yield* RelayAuth.Service
          const before = yield* auth.get()
          const results = yield* Effect.all(
            [catalog.synchronize({ retryNotice: true }), catalog.synchronize({ retryNotice: true })],
            { concurrency: "unbounded" },
          )
          expect(results.map((item) => item.notice.status)).toEqual(["idle", "idle"])
          expect(delivered).toBe(1)
          yield* catalog.syncVendors()
          yield* catalog.managed()
          expect(delivered).toBe(1)
          yield* catalog.synchronize({ retryNotice: true })
          expect(delivered).toBe(2)
          expect((yield* auth.get()).revision).toBe(before.revision)
          expect(yield* Effect.promise(() => Bun.file(catalogFile(tmp.path)).exists())).toBe(false)
        }).pipe(Effect.provide(layer))
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("C206 old notification success cannot clear a newer committed responsibility", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const publishing = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const secondCommit = yield* Deferred.make<void>()
          let attempts = 0
          let commits = 0
          const layer = AppNodeBuilder.build(LayerNode.group([RelayCatalog.node, RelayAuth.node]), [
            [Global.node, Global.layerWith({ data: tmp.path })],
            [RelaySecretStore.node, RelaySecretStore.memoryLayer],
            [
              EventV2.node,
              eventsWith(() =>
                Effect.gen(function* () {
                  attempts += 1
                  if (attempts === 1) {
                    yield* Deferred.succeed(publishing, undefined)
                    yield* Deferred.await(release)
                  }
                }),
              ),
            ],
          ])
          yield* Effect.gen(function* () {
            const auth = yield* RelayAuth.Service
            yield* auth.setVendor({
              id: Relay.VendorID.chatgpt,
              name: "Independent",
              baseURL: "https://provider.test/v1",
              key: "notice-key",
              revision: 0,
            })
            const catalog = yield* RelayCatalog.Service
            yield* RelayCatalog.withCommitHook((phase) =>
              Effect.gen(function* () {
                if (phase !== "renamed") return
                commits += 1
                if (commits === 2) yield* Deferred.succeed(secondCommit, undefined)
              }),
            )
            const first = yield* catalog
              .setVisibility({ vendorId: Relay.VendorID.chatgpt, modelId: Model.ID.make("first"), visible: true })
              .pipe(Effect.forkChild)
            yield* Deferred.await(publishing)
            const second = yield* catalog
              .setVisibility({ vendorId: Relay.VendorID.chatgpt, modelId: Model.ID.make("second"), visible: true })
              .pipe(Effect.forkChild)
            yield* Deferred.await(secondCommit).pipe(Effect.timeout("5 seconds"))
            yield* Deferred.succeed(release, undefined)
            yield* Fiber.join(first)
            yield* Fiber.join(second)
            expect(attempts).toBe(2)
            expect((yield* catalog.synchronize()).notice.status).toBe("idle")
          }).pipe(Effect.provide(layer), Effect.ensuring(Deferred.succeed(release, undefined)))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("C114 distinguishes historical missing revision from real zero without writing", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const original = JSON.stringify({ candidates: [], managed: [], requestVersion: 0 })
          yield* Effect.promise(() => Bun.write(catalogFile(tmp.path), original))
          yield* Effect.gen(function* () {
            const catalog = yield* RelayCatalog.Service
            expect((yield* catalog.synchronize()).catalogRevision).toBeNull()
            expect(yield* Effect.promise(() => Bun.file(catalogFile(tmp.path)).text())).toBe(original)
            const auth = yield* RelayAuth.Service
            yield* auth.setVendor({
              id: Relay.VendorID.chatgpt,
              name: "Independent",
              baseURL: "https://provider.test/v1",
              key: "notice-key",
              revision: 0,
            })
            yield* catalog.setVisibility({
              vendorId: Relay.VendorID.chatgpt,
              modelId: Model.ID.make("versioned"),
              visible: true,
            })
            expect((yield* catalog.synchronize()).catalogRevision).toBe(1)
          }).pipe(Effect.provide(open(tmp.path)))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})

for (const mutateDirectly of [false, true])
  it.live(
    `C113 catalog binds rows to persisted entities across external replacement, direct mutation=${mutateDirectly}`,
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) =>
          Effect.gen(function* () {
            const layer = open(tmp.path)
            yield* Effect.gen(function* () {
              const auth = yield* RelayAuth.Service
              const catalog = yield* RelayCatalog.Service
              const id = Relay.VendorID.make("replace-catalog")
              const first = yield* auth.setVendor({
                id,
                name: "Original",
                baseURL: "https://provider.test/v1",
                key: "old-key",
                revision: 0,
              })
              yield* catalog.setVisibility({ vendorId: id, modelId: Model.ID.make("old-entity-model"), visible: true })
              yield* Effect.gen(function* () {
                const otherAuth = yield* RelayAuth.Service
                const otherCatalog = yield* RelayCatalog.Service
                const removed = yield* otherAuth.deleteVendor({ id, revision: first.revision })
                yield* otherAuth.setVendor({
                  id,
                  name: "Replacement",
                  baseURL: "https://replacement.test/v1",
                  key: "new-key",
                  revision: removed.revision,
                })
                yield* otherCatalog.setVisibility({
                  vendorId: id,
                  modelId: Model.ID.make("new-entity-model"),
                  visible: true,
                })
              }).pipe(Effect.provide(open(tmp.path)))
              const before = yield* Effect.promise(() => Bun.file(catalogFile(tmp.path)).text())
              if (mutateDirectly) {
                yield* catalog.setVisibility({ vendorId: id, modelId: Model.ID.make("another-model"), visible: true })
              } else {
                yield* catalog.synchronize()
                expect(yield* Effect.promise(() => Bun.file(catalogFile(tmp.path)).text())).toBe(before)
              }
              expect(ids(yield* catalog.managed())).toEqual(
                mutateDirectly ? ["another-model", "new-entity-model"] : ["new-entity-model"],
              )
              yield* catalog.synchronize()
              expect(ids(yield* catalog.managed())).not.toContain("old-entity-model")
            }).pipe(Effect.provide(layer))
          }),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
  )
