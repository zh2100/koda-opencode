import { describe, expect } from "bun:test"
import * as NFS from "fs/promises"
import path from "path"
import { NodeFileSystem } from "@effect/platform-node"
import { Effect, Exit, FileSystem, Layer, PlatformError } from "effect"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { RelaySecretStore } from "@opencode-ai/core/relay-secret-store"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const it = testEffect(Layer.empty)

const system = (
  values: Map<string, string>,
  options: { failDelete?: boolean; missing?: boolean; throwNotFound?: boolean; absent?: boolean } = {},
): RelaySecretStore.SystemSecrets => ({
  get: async ({ name }) => values.get(name) ?? null,
  set: async ({ name, value }) => void values.set(name, value),
  delete: async ({ name }) => {
    if (options.failDelete) throw new Error("system unavailable")
    if (options.throwNotFound) {
      const error = new Error("secret does not exist")
      Object.assign(error, { code: "NotFound" })
      throw error
    }
    if (options.absent) return false
    if (options.missing) return null
    values.delete(name)
    return true
  },
})

const readFile = (dir: string) =>
  Effect.gen(function* () {
    const text = yield* Effect.tryPromise({
      try: () => NFS.readFile(path.join(dir, "relay-secrets.json"), "utf8"),
      catch: () => undefined,
    }).pipe(Effect.catch(() => Effect.succeed(undefined)))
    return text ? (JSON.parse(text) as Record<string, string>) : {}
  })

const withFailingWrites = (failWrite: () => boolean) =>
  Layer.effect(
    FileSystem.FileSystem,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      return FileSystem.FileSystem.of({
        ...fs,
        writeFileString: (filePath, ...rest) =>
          failWrite() && path.basename(filePath).startsWith("relay-secrets.json")
            ? Effect.fail(
                new PlatformError.PlatformError(
                  new PlatformError.SystemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "writeFileString",
                    pathOrDescriptor: filePath,
                    syscall: "write",
                  }),
                ),
              )
            : fs.writeFileString(filePath, ...rest),
      })
    }),
  ).pipe(Layer.provide(NodeFileSystem.layer))

describe("RelaySecretStore", () => {
  it.live("removes a secret from both the system and file backends", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        const values = new Map<string, string>()
        const layer = RelaySecretStore.makeLayer(system(values)).pipe(
          Layer.provide(AppNodeBuilder.build(FSUtil.node)),
          Layer.provide(Global.layerWith({ data: tmp.path })),
        )
        return Effect.gen(function* () {
          const store = yield* RelaySecretStore.Service
          yield* store.put("secret:one", "sk-system")
          yield* Effect.promise(() =>
            NFS.writeFile(
              path.join(tmp.path, "relay-secrets.json"),
              JSON.stringify({ "secret:one": "sk-file" }),
              "utf8",
            ),
          )
          yield* store.remove("secret:one")
          expect(values.has("secret:one")).toBe(false)
          expect(yield* readFile(tmp.path)).toEqual({})
          expect(yield* store.get("secret:one")).toBeUndefined()
        }).pipe(Effect.provide(layer))
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("removes the file copy when the system backend reports the secret missing", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        const layer = RelaySecretStore.makeLayer(system(new Map())).pipe(
          Layer.provide(AppNodeBuilder.build(FSUtil.node)),
          Layer.provide(Global.layerWith({ data: tmp.path })),
        )
        return Effect.gen(function* () {
          yield* Effect.promise(() =>
            NFS.writeFile(
              path.join(tmp.path, "relay-secrets.json"),
              JSON.stringify({ "secret:file": "sk-file" }),
              "utf8",
            ),
          )
          const store = yield* RelaySecretStore.Service
          yield* store.remove("secret:file")
          expect(yield* store.get("secret:file")).toBeUndefined()
          expect(yield* readFile(tmp.path)).toEqual({})
        }).pipe(Effect.provide(layer))
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("reports failure when either backend delete fails and preserves unrelated secrets", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        const values = new Map([["secret:system", "sk-system"]])
        const file = path.resolve(path.join(tmp.path, "relay-secrets.json"))
        let failWrite = false
        const storeLayer = (secrets: RelaySecretStore.SystemSecrets) =>
          RelaySecretStore.makeLayer(secrets).pipe(
            Layer.provide(
              LayerNode.compile(FSUtil.node, [[LayerNodePlatform.filesystem, withFailingWrites(() => failWrite)]]),
            ),
            Layer.provide(Global.layerWith({ data: tmp.path })),
          )
        return Effect.gen(function* () {
          yield* Effect.promise(() =>
            NFS.writeFile(file, JSON.stringify({ "secret:file": "sk-file", "secret:other": "sk-other" }), "utf8"),
          )
          const systemFailed = yield* Effect.gen(function* () {
            const store = yield* RelaySecretStore.Service
            const failed = yield* Effect.exit(store.remove("secret:system"))
            return { failed, file: yield* readFile(tmp.path) }
          }).pipe(Effect.provide(storeLayer(system(values, { failDelete: true }))))
          expect(systemFailed.failed._tag).toBe("Failure")
          expect(values.has("secret:system")).toBe(true)
          expect(systemFailed.file["secret:file"]).toBe("sk-file")
          expect(systemFailed.file["secret:other"]).toBe("sk-other")
          const fileOnly = yield* Effect.gen(function* () {
            const store = yield* RelaySecretStore.Service
            yield* store.remove("secret:file")
            return yield* readFile(tmp.path)
          }).pipe(Effect.provide(storeLayer(system(new Map(), { missing: true }))))
          expect(fileOnly["secret:file"]).toBeUndefined()
          expect(fileOnly["secret:other"]).toBe("sk-other")
          failWrite = true
          values.set("secret:again", "sk-again")
          yield* Effect.promise(() =>
            NFS.writeFile(file, JSON.stringify({ "secret:again": "sk-again", "secret:other": "sk-other" }), "utf8"),
          )
          const fileFailed = yield* Effect.gen(function* () {
            const store = yield* RelaySecretStore.Service
            return yield* Effect.exit(store.remove("secret:again"))
          }).pipe(Effect.provide(storeLayer(system(values))))
          expect(fileFailed._tag).toBe("Failure")
          expect(values.has("secret:again")).toBe(false)
          expect((yield* readFile(tmp.path))["secret:other"]).toBe("sk-other")
          yield* Effect.promise(() => NFS.writeFile(file, "{broken", "utf8"))
          const corrupt = yield* Effect.gen(function* () {
            const store = yield* RelaySecretStore.Service
            return yield* Effect.exit(store.remove("secret:other"))
          }).pipe(Effect.provide(storeLayer(system(new Map(), { missing: true }))))
          expect(corrupt._tag).toBe("Failure")
          expect(yield* Effect.promise(() => NFS.readFile(file, "utf8"))).toBe("{broken")
          const missing = yield* Effect.gen(function* () {
            const store = yield* RelaySecretStore.Service
            yield* store.remove("secret:absent")
            yield* store.remove("secret:absent")
          }).pipe(
            Effect.provide(
              RelaySecretStore.makeLayer(system(new Map(), { missing: true })).pipe(
                Layer.provide(AppNodeBuilder.build(FSUtil.node)),
                Layer.provide(Global.layerWith({ data: path.join(tmp.path, "empty") })),
              ),
            ),
          )
          expect(missing).toBeUndefined()
        })
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("treats a thrown system NotFound as a successful delete and removes the file copy", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        const layer = RelaySecretStore.makeLayer(system(new Map(), { throwNotFound: true })).pipe(
          Layer.provide(AppNodeBuilder.build(FSUtil.node)),
          Layer.provide(Global.layerWith({ data: tmp.path })),
        )
        return Effect.gen(function* () {
          yield* Effect.promise(() =>
            NFS.writeFile(
              path.join(tmp.path, "relay-secrets.json"),
              JSON.stringify({ "secret:gone": "sk-file" }),
              "utf8",
            ),
          )
          const store = yield* RelaySecretStore.Service
          yield* store.remove("secret:gone")
          expect(yield* readFile(tmp.path)).toEqual({})
          expect(yield* store.get("secret:gone")).toBeUndefined()
        }).pipe(Effect.provide(layer))
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("treats a false system delete as an idempotent success and removes the file copy", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        const layer = RelaySecretStore.makeLayer(system(new Map(), { absent: true })).pipe(
          Layer.provide(AppNodeBuilder.build(FSUtil.node)),
          Layer.provide(Global.layerWith({ data: tmp.path })),
        )
        return Effect.gen(function* () {
          yield* Effect.promise(() =>
            NFS.writeFile(
              path.join(tmp.path, "relay-secrets.json"),
              JSON.stringify({ "secret:absent": "sk-file" }),
              "utf8",
            ),
          )
          const store = yield* RelaySecretStore.Service
          yield* store.remove("secret:absent")
          yield* store.remove("secret:absent")
          expect(yield* readFile(tmp.path)).toEqual({})
          expect(yield* store.get("secret:absent")).toBeUndefined()
        }).pipe(Effect.provide(layer))
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})
