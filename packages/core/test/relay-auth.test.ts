import { describe, expect } from "bun:test"
import * as NFS from "fs/promises"
import path from "path"
import { Deferred, Effect, Fiber, Layer, PlatformError } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Relay } from "@opencode-ai/schema/relay"
import { RelayAuth } from "@opencode-ai/core/relay-auth"
import { RelaySecretStore } from "@opencode-ai/core/relay-secret-store"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const withAuth = <A, E, R>(body: (auth: RelayAuth.Interface) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => {
      const layer = AppNodeBuilder.build(RelayAuth.node, [
        [Global.node, Global.layerWith({ data: tmp.path })],
        [RelaySecretStore.node, RelaySecretStore.memoryLayer],
      ])
      return Effect.gen(function* () {
        return yield* body(yield* RelayAuth.Service)
      }).pipe(Effect.provide(layer))
    },
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

const it = testEffect(Layer.empty)

describe("RelayAuth", () => {
  it.live("persists custom endpoints and never falls back to the unified key", () =>
    withAuth((auth) =>
      Effect.gen(function* () {
        const id = Relay.VendorID.make("custom")
        let state = yield* auth.setVendor({
          id,
          name: "Custom",
          baseURL: "http://localhost:1234/v1/",
          key: "custom-key",
          revision: 0,
        })
        expect(yield* auth.resolve(id)).toEqual({ key: "custom-key", baseURL: "http://localhost:1234/v1" })
        state = yield* auth.setVendor({ id, name: "Renamed", revision: state.revision })
        expect((yield* auth.get()).vendors.find((vendor) => vendor.id === id)?.baseURL).toBe("http://localhost:1234/v1")
        const invalid = yield* auth
          .setVendor({ id, baseURL: "https://user:pass@example.com", revision: state.revision })
          .pipe(Effect.flip)
        expect(invalid.info.code).toBe("REQUEST_CONFLICT")
        const builtin = yield* auth
          .setVendor({ name: "Independent", id: Relay.VendorID.chatgpt, baseURL: "invalid", revision: state.revision })
          .pipe(Effect.flip)
        expect(builtin.info.code).toBe("REQUEST_CONFLICT")
        state = yield* auth.clearVendorKey({ id, revision: state.revision })
        expect((yield* auth.resolve(id).pipe(Effect.flip)).info.code).toBe("KEY_MISSING")
        expect((yield* auth.resolve(Relay.VendorID.chatgpt).pipe(Effect.flip)).info.code).toBe("KEY_MISSING")
      }),
    ),
  )

  it.live("starts without hosted vendors or shared credential state", () =>
    withAuth((auth) =>
      Effect.gen(function* () {
        const state = yield* auth.get()
        expect(state.vendors).toEqual([])
        expect(state.revision).toBe(0)
        expect(state.capabilities).toContain("independent-vendors-v1")
        expect(state).not.toHaveProperty("unified")
        expect(state).not.toHaveProperty("hasUnifiedKey")
      }),
    ),
  )

  it.live("stores independent vendor keys and resolves the selected vendor", () =>
    withAuth((auth) =>
      Effect.gen(function* () {
        const chatgpt = yield* auth.setVendor({
          name: "Independent",
          baseURL: "https://provider.test/v1",
          id: Relay.VendorID.chatgpt,
          key: "sk-chatgpt",
          revision: 0,
        })
        const grok = yield* auth.setVendor({
          name: "Independent",
          baseURL: "https://provider.test/v1",
          id: Relay.VendorID.grok,
          key: "sk-grok",
          revision: chatgpt.revision,
        })
        expect(JSON.stringify(grok)).not.toContain("sk-")
        expect((yield* auth.resolve(Relay.VendorID.chatgpt)).key).toBe("sk-chatgpt")
        expect((yield* auth.resolve(Relay.VendorID.grok)).key).toBe("sk-grok")
      }),
    ),
  )

  it.live("clears one vendor key without affecting others", () =>
    withAuth((auth) =>
      Effect.gen(function* () {
        let state = yield* auth.setVendor({
          name: "Independent",
          baseURL: "https://provider.test/v1",
          id: Relay.VendorID.chatgpt,
          key: "sk-chatgpt",
          revision: 0,
        })
        state = yield* auth.setVendor({
          name: "Independent",
          baseURL: "https://provider.test/v1",
          id: Relay.VendorID.grok,
          key: "sk-grok",
          revision: state.revision,
        })
        state = yield* auth.clearVendorKey({ id: Relay.VendorID.chatgpt, revision: state.revision })
        expect(state.vendors.find((vendor) => vendor.id === Relay.VendorID.chatgpt)?.hasKey).toBe(false)
        expect((yield* auth.resolve(Relay.VendorID.grok)).key).toBe("sk-grok")
        const missing = yield* auth.resolve(Relay.VendorID.chatgpt).pipe(Effect.flip)
        expect(missing.info.code).toBe("KEY_MISSING")
      }),
    ),
  )

  it.live("rejects stale revisions and replays identical operation IDs", () =>
    withAuth((auth) =>
      Effect.gen(function* () {
        const first = yield* auth.setVendor({
          name: "Independent",
          baseURL: "https://provider.test/v1",
          id: Relay.VendorID.chatgpt,
          key: "sk-one",
          revision: 0,
          operationId: "op-1",
        })
        const different = yield* auth
          .setVendor({
            name: "Independent",
            baseURL: "https://provider.test/v1",
            id: Relay.VendorID.chatgpt,
            key: "sk-two",
            revision: 0,
            operationId: "op-1",
          })
          .pipe(Effect.flip)
        expect(different.info.code).toBe("REQUEST_CONFLICT")
        expect((yield* auth.get()).revision).toBe(first.revision)
        const replayed = yield* auth.setVendor({
          name: "Independent",
          baseURL: "https://provider.test/v1",
          id: Relay.VendorID.chatgpt,
          key: "sk-one",
          revision: 0,
          operationId: "op-1",
        })
        expect(replayed.revision).toBe(first.revision)
        expect((yield* auth.resolve(Relay.VendorID.chatgpt)).key).toBe("sk-one")
        const conflict = yield* auth
          .setVendor({
            name: "Independent",
            baseURL: "https://provider.test/v1",
            id: Relay.VendorID.chatgpt,
            key: "sk-three",
            revision: 0,
          })
          .pipe(Effect.flip)
        expect(conflict.info.code).toBe("REVISION_CONFLICT")
      }),
    ),
  )

  it.live("does not import legacy auth.json credentials into independent providers", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const file = path.join(tmp.path, "auth.json")
          const original = JSON.stringify({
            leidiandonghua: { type: "api", key: "shared-secret" },
            openai: { type: "api", key: "official-secret" },
          })
          yield* Effect.promise(() => Bun.write(file, original))
          const layer = AppNodeBuilder.build(RelayAuth.node, [
            [Global.node, Global.layerWith({ data: tmp.path })],
            [RelaySecretStore.node, RelaySecretStore.memoryLayer],
          ])
          yield* Effect.gen(function* () {
            const auth = yield* RelayAuth.Service
            expect((yield* auth.get()).vendors).toEqual([])
            expect((yield* auth.resolve(Relay.VendorID.chatgpt).pipe(Effect.flip)).info.code).toBe("KEY_MISSING")
          }).pipe(Effect.provide(layer))
          expect(yield* Effect.promise(() => Bun.file(file).text())).toBe(original)
          expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "auth.relay-backup.json")).exists())).toBe(
            false,
          )
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("conflicts an overlapping save and keeps both vendors after the loser retries", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          let writes = 0
          const secrets = new Map<string, string>()
          const secretsLayer = Layer.succeed(
            RelaySecretStore.Service,
            RelaySecretStore.Service.of({
              get: (ref) => Effect.sync(() => secrets.get(ref)),
              put: (ref, secret) =>
                Effect.gen(function* () {
                  writes += 1
                  if (writes === 1) {
                    yield* Deferred.succeed(entered, undefined)
                    yield* Deferred.await(release)
                  }
                  secrets.set(ref, secret)
                }),
              remove: (ref) => Effect.sync(() => void secrets.delete(ref)),
            }),
          )
          const layer = AppNodeBuilder.build(RelayAuth.node, [
            [Global.node, Global.layerWith({ data: tmp.path })],
            [RelaySecretStore.node, secretsLayer],
          ])
          const first = Relay.VendorID.make("audit-a")
          const second = Relay.VendorID.make("audit-b")
          const result = yield* Effect.gen(function* () {
            const auth = yield* RelayAuth.Service
            const left = yield* auth
              .setVendor({ id: first, name: "Audit A", key: "sk-a", baseURL: "https://a.invalid/v1", revision: 0 })
              .pipe(Effect.forkChild)
            yield* Deferred.await(entered)
            const right = yield* auth
              .setVendor({ id: second, name: "Audit B", key: "sk-b", baseURL: "https://b.invalid/v1", revision: 0 })
              .pipe(Effect.forkChild)
            yield* Deferred.succeed(release, undefined)
            const leftExit = yield* Fiber.join(left).pipe(Effect.result)
            const rightExit = yield* Fiber.join(right).pipe(Effect.result)
            const outcomes = [leftExit, rightExit]
            const saved = yield* auth.get()
            const conflict = outcomes.some(
              (item) => item._tag === "Failure" && item.failure.info.code === "REVISION_CONFLICT",
            )
            const retried = yield* auth.setVendor({
              id: second,
              name: "Audit B",
              key: "sk-b",
              baseURL: "https://b.invalid/v1",
              revision: saved.revision,
            })
            return { conflict, retried }
          }).pipe(Effect.provide(layer))
          expect(result.conflict).toBe(true)
          expect(
            result.retried.vendors
              .filter((vendor) => vendor.id === first || vendor.id === second)
              .map((vendor) => vendor.id)
              .sort(),
          ).toEqual([first, second].sort())
          expect(JSON.stringify(result.retried)).not.toContain("sk-")
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("keeps the vendor key when the config commit fails", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const config = path.resolve(path.join(tmp.path, "relay-auth.json"))
          const fs = yield* Effect.gen(function* () {
            return yield* FSUtil.Service
          }).pipe(Effect.provide(AppNodeBuilder.build(FSUtil.node)))
          let rejectClear = false
          const wrapped = FSUtil.Service.of({
            ...fs,
            rename: (from, to) => {
              if (path.resolve(to) !== config) return fs.rename(from, to)
              // Arm at the operation boundary; initialization may add durable metadata.
              if (!rejectClear) return fs.rename(from, to)
              return fs.rename(from, path.join(path.dirname(config), "missing", "relay-auth.json"))
            },
          })
          const layer = AppNodeBuilder.build(RelayAuth.node, [
            [Global.node, Global.layerWith({ data: tmp.path })],
            [RelaySecretStore.node, RelaySecretStore.memoryLayer],
            [FSUtil.node, Layer.succeed(FSUtil.Service, wrapped)],
          ])
          const result = yield* Effect.gen(function* () {
            const auth = yield* RelayAuth.Service
            const saved = yield* auth.setVendor({
              name: "Independent",
              baseURL: "https://provider.test/v1",
              id: Relay.VendorID.chatgpt,
              key: "sk-keep",
              revision: 0,
            })
            rejectClear = true
            const failed = yield* auth
              .clearVendorKey({ id: Relay.VendorID.chatgpt, revision: saved.revision })
              .pipe(Effect.flip)
            return {
              code: failed.info.code,
              hasKey: (yield* auth.get()).vendors.find((vendor) => vendor.id === Relay.VendorID.chatgpt)?.hasKey,
              resolved: yield* auth.resolve(Relay.VendorID.chatgpt),
            }
          }).pipe(Effect.provide(layer))
          expect(result.code).toBe("SECRET_STORE_UNAVAILABLE")
          expect(result.hasKey).toBe(true)
          expect(result.resolved.key).toBe("sk-keep")
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("rotates a vendor through a new secret ref and restores the old pair on failure", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const config = path.resolve(path.join(tmp.path, "relay-auth.json"))
          const fs = yield* Effect.gen(function* () {
            return yield* FSUtil.Service
          }).pipe(Effect.provide(AppNodeBuilder.build(FSUtil.node)))
          const secrets = new Map<string, string>()
          let failPut = false
          let failCommit = false
          const secretsLayer = Layer.succeed(
            RelaySecretStore.Service,
            RelaySecretStore.Service.of({
              get: (ref) => Effect.sync(() => secrets.get(ref)),
              put: (ref, secret) =>
                failPut
                  ? Effect.fail(new RelaySecretStore.UnavailableError())
                  : Effect.sync(() => void secrets.set(ref, secret)),
              remove: (ref) => Effect.sync(() => void secrets.delete(ref)),
            }),
          )
          const wrapped = FSUtil.Service.of({
            ...fs,
            rename: (from, to) =>
              failCommit && path.resolve(to) === config
                ? fs.rename(from, path.join(tmp.path, "missing", "relay-auth.json"))
                : fs.rename(from, to),
          })
          const layer = AppNodeBuilder.build(RelayAuth.node, [
            [Global.node, Global.layerWith({ data: tmp.path })],
            [RelaySecretStore.node, secretsLayer],
            [FSUtil.node, Layer.succeed(FSUtil.Service, wrapped)],
          ])
          const id = Relay.VendorID.make("rotated")
          const result = yield* Effect.gen(function* () {
            const auth = yield* RelayAuth.Service
            const saved = yield* auth.setVendor({
              id,
              name: "Rotated",
              key: "sk-old",
              baseURL: "https://old.invalid/v1",
              revision: 0,
            })
            failPut = true
            const putFailed = yield* auth
              .setVendor({
                id,
                key: "sk-new",
                baseURL: "https://new.invalid/v1",
                revision: saved.revision,
              })
              .pipe(Effect.flip)
            failPut = false
            const afterPut = yield* auth.resolve(id)
            failCommit = true
            const commitFailed = yield* auth
              .setVendor({
                id,
                key: "sk-new",
                baseURL: "https://new.invalid/v1",
                revision: saved.revision,
              })
              .pipe(Effect.flip)
            failCommit = false
            const afterCommit = yield* auth.resolve(id)
            const rotated = yield* auth.setVendor({
              id,
              key: "sk-new",
              baseURL: "https://new.invalid/v1",
              revision: saved.revision,
            })
            return {
              putCode: putFailed.info.code,
              commitCode: commitFailed.info.code,
              afterPut,
              afterCommit,
              rotated: yield* auth.resolve(id),
              revision: rotated.revision,
              cleanupPending: rotated.cleanupPending,
              address: rotated.vendors.find((vendor) => vendor.id === id)?.baseURL,
            }
          }).pipe(Effect.provide(layer))
          expect(result.putCode).toBe("SECRET_STORE_UNAVAILABLE")
          expect(result.afterPut).toEqual({ key: "sk-old", baseURL: "https://old.invalid/v1" })
          expect(result.commitCode).toBe("SECRET_STORE_UNAVAILABLE")
          expect(result.afterCommit).toEqual({ key: "sk-old", baseURL: "https://old.invalid/v1" })
          expect(result.rotated).toEqual({ key: "sk-new", baseURL: "https://new.invalid/v1" })
          expect(result.address).toBe("https://new.invalid/v1")
          expect(result.cleanupPending).toBe(false)
          expect(secrets.get([...secrets.keys()].find((ref) => secrets.get(ref) === "sk-old") ?? "")).toBeUndefined()
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("retries only the remaining secret cleanup for the same operation", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const secrets = new Map<string, string>()
          let failRemove = false
          let removes = 0
          const secretsLayer = Layer.succeed(
            RelaySecretStore.Service,
            RelaySecretStore.Service.of({
              get: (ref) => Effect.sync(() => secrets.get(ref)),
              put: (ref, secret) => Effect.sync(() => void secrets.set(ref, secret)),
              remove: (ref) => {
                removes += 1
                if (failRemove) return Effect.fail(new RelaySecretStore.UnavailableError())
                secrets.delete(ref)
                return Effect.void
              },
            }),
          )
          const layer = AppNodeBuilder.build(RelayAuth.node, [
            [Global.node, Global.layerWith({ data: tmp.path })],
            [RelaySecretStore.node, secretsLayer],
          ])
          const id = Relay.VendorID.make("cleanup")
          const first = yield* Effect.gen(function* () {
            const auth = yield* RelayAuth.Service
            const saved = yield* auth.setVendor({
              id,
              name: "Cleanup",
              key: "sk-old",
              baseURL: "https://old.invalid/v1",
              revision: 0,
              operationId: "save-old",
            })
            failRemove = true
            const failed = yield* auth.setVendor({
              id,
              key: "sk-new",
              baseURL: "https://new.invalid/v1",
              revision: saved.revision,
              operationId: "rotate",
            })
            return {
              revision: failed.revision,
              cleanupPending: failed.cleanupPending,
              resolved: yield* auth.resolve(id),
              oldPresent: [...secrets.values()].includes("sk-old"),
            }
          }).pipe(Effect.provide(layer))
          expect(first.cleanupPending).toBe(true)
          expect(first.resolved).toEqual({ key: "sk-new", baseURL: "https://new.invalid/v1" })
          expect(first.oldPresent).toBe(true)
          failRemove = false
          const retried = yield* Effect.gen(function* () {
            const auth = yield* RelayAuth.Service
            const beforeBytes = yield* Effect.promise(() =>
              NFS.readFile(path.join(tmp.path, "relay-auth.json"), "utf8"),
            )
            const error = yield* auth
              .setVendor({
                id,
                key: "sk-other",
                baseURL: "https://other.invalid/v1",
                revision: 0,
                operationId: "rotate",
              })
              .pipe(Effect.flip)
            // A fresh service has no command proof after successful recovery.
            expect(error.info.code).toBe("REVISION_CONFLICT")
            expect(yield* Effect.promise(() => NFS.readFile(path.join(tmp.path, "relay-auth.json"), "utf8"))).toBe(
              beforeBytes,
            )
            const state = yield* auth.get()
            const before = (yield* auth.get()).revision
            const repeatedError = yield* auth
              .setVendor({
                id,
                key: "sk-again",
                baseURL: "https://again.invalid/v1",
                revision: 0,
                operationId: "rotate",
              })
              .pipe(Effect.flip)
            expect(repeatedError.info.code).toBe("REVISION_CONFLICT")
            const repeated = yield* auth.get()
            return {
              revision: state.revision,
              cleanupPending: !!JSON.parse(
                yield* Effect.promise(() => NFS.readFile(path.join(tmp.path, "relay-auth.json"), "utf8")),
              ).pendingCleanup?.length,
              repeatedRevision: repeated.revision,
              before,
              resolved: yield* auth.resolve(id),
              oldPresent: [...secrets.values()].includes("sk-old"),
              otherPresent: [...secrets.values()].includes("sk-other"),
              againPresent: [...secrets.values()].includes("sk-again"),
            }
          }).pipe(Effect.provide(layer))
          expect(retried.revision).toBe(first.revision)
          expect(retried.cleanupPending).toBe(false)
          expect(retried.repeatedRevision).toBe(retried.before)
          expect(retried.resolved).toEqual({ key: "sk-new", baseURL: "https://new.invalid/v1" })
          expect(retried.oldPresent).toBe(false)
          expect(retried.otherPresent).toBe(false)
          expect(retried.againPresent).toBe(false)
          expect(removes).toBeGreaterThan(1)
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("continues a persisted cleanup when the service starts again", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const secrets = new Map<string, string>()
          let failRemove = false
          let removes = 0
          const secretsLayer = Layer.succeed(
            RelaySecretStore.Service,
            RelaySecretStore.Service.of({
              get: (ref) => Effect.sync(() => secrets.get(ref)),
              put: (ref, secret) => Effect.sync(() => void secrets.set(ref, secret)),
              remove: (ref) => {
                removes += 1
                if (failRemove && secrets.get(ref) === "sk-old")
                  return Effect.fail(new RelaySecretStore.UnavailableError())
                secrets.delete(ref)
                return Effect.void
              },
            }),
          )
          const layer = AppNodeBuilder.build(RelayAuth.node, [
            [Global.node, Global.layerWith({ data: tmp.path })],
            [RelaySecretStore.node, secretsLayer],
          ])
          const saved = yield* Effect.gen(function* () {
            const auth = yield* RelayAuth.Service
            const state = yield* auth.setVendor({
              id: Relay.VendorID.chatgpt,
              name: "Independent",
              baseURL: "https://provider.test/v1",
              key: "sk-old",
              revision: 0,
              operationId: "save",
            })
            failRemove = true
            const rotated = yield* auth.setVendor({
              name: "Independent",
              baseURL: "https://provider.test/v1",
              id: Relay.VendorID.chatgpt,
              key: "sk-new",
              revision: state.revision,
              operationId: "rotate-independent",
            })
            return { revision: rotated.revision, cleanupPending: rotated.cleanupPending }
          }).pipe(Effect.provide(layer))
          expect(saved.cleanupPending).toBe(true)
          const stored = JSON.parse(
            yield* Effect.promise(() => NFS.readFile(path.join(tmp.path, "relay-auth.json"), "utf8")),
          )
          expect(JSON.stringify(stored.pendingCleanup)).not.toContain("sk-")
          expect(stored.pendingCleanup).toEqual([
            { operationId: "rotate-independent", refs: [expect.any(String)], revision: saved.revision },
          ])
          failRemove = false
          const removesBeforeRestart = removes
          const restarted = yield* Effect.gen(function* () {
            const auth = yield* RelayAuth.Service
            return {
              revision: (yield* auth.get()).revision,
              resolved: yield* auth.resolve(Relay.VendorID.chatgpt),
            }
          }).pipe(Effect.provide(layer))
          expect(removes).toBeGreaterThan(removesBeforeRestart)
          expect(restarted.revision).toBe(saved.revision)
          expect(restarted.resolved).toEqual({ key: "sk-new", baseURL: "https://provider.test/v1" })
          expect([...secrets.values()]).not.toContain("sk-old")
          const again = JSON.parse(
            yield* Effect.promise(() => NFS.readFile(path.join(tmp.path, "relay-auth.json"), "utf8")),
          )
          expect(again.pendingCleanup).toBeUndefined()
          expect(again.revision).toBe(saved.revision)
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("treats a missing retired secret as cleanup success and keeps the current secret", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const secrets = new Map<string, string>()
          let failRemove = false
          const secretsLayer = Layer.succeed(
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
          const layer = AppNodeBuilder.build(RelayAuth.node, [
            [Global.node, Global.layerWith({ data: tmp.path })],
            [RelaySecretStore.node, secretsLayer],
          ])
          const id = Relay.VendorID.make("missing")
          const saved = yield* Effect.gen(function* () {
            const auth = yield* RelayAuth.Service
            const state = yield* auth.setVendor({
              id,
              name: "Missing",
              key: "sk-old",
              baseURL: "https://old.invalid/v1",
              revision: 0,
            })
            failRemove = true
            return yield* auth.setVendor({
              id,
              key: "sk-new",
              baseURL: "https://new.invalid/v1",
              revision: state.revision,
              operationId: "rotate-missing",
            })
          }).pipe(Effect.provide(layer))
          expect(saved.cleanupPending).toBe(true)
          for (const [ref, secret] of secrets) if (secret === "sk-old") secrets.delete(ref)
          failRemove = false
          const retried = yield* Effect.gen(function* () {
            const auth = yield* RelayAuth.Service
            const before = yield* Effect.promise(() => NFS.readFile(path.join(tmp.path, "relay-auth.json"), "utf8"))
            const error = yield* auth
              .setVendor({
                id,
                key: "sk-other",
                baseURL: "https://other.invalid/v1",
                revision: 0,
                operationId: "rotate-missing",
              })
              .pipe(Effect.flip)
            expect(error.info.code).toBe("REVISION_CONFLICT")
            expect(yield* Effect.promise(() => NFS.readFile(path.join(tmp.path, "relay-auth.json"), "utf8"))).toBe(
              before,
            )
            return {
              revision: (yield* auth.get()).revision,
              cleanupPending: !!JSON.parse(before).pendingCleanup?.length,
              resolved: yield* auth.resolve(id),
            }
          }).pipe(Effect.provide(layer))
          expect(retried.cleanupPending).toBe(false)
          expect(retried.revision).toBe(saved.revision)
          expect(retried.resolved).toEqual({ key: "sk-new", baseURL: "https://new.invalid/v1" })
          expect([...secrets.values()]).toContain("sk-new")
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("keeps a committed vendor deletion successful while cleanup remains unavailable", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const secrets = new Map<string, string>()
          let failRemove = false
          const layer = AppNodeBuilder.build(RelayAuth.node, [
            [Global.node, Global.layerWith({ data: tmp.path })],
            [
              RelaySecretStore.node,
              Layer.succeed(
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
              ),
            ],
          ])
          const id = Relay.VendorID.make("deleted")
          const first = yield* Effect.gen(function* () {
            const auth = yield* RelayAuth.Service
            const saved = yield* auth.setVendor({
              id,
              name: "Deleted",
              key: "sk-delete",
              baseURL: "https://delete.invalid/v1",
              revision: 0,
            })
            failRemove = true
            const deleted = yield* auth.deleteVendor({ id, revision: saved.revision, operationId: "delete" })
            expect(
              (yield* auth.deleteVendor({ id, revision: 0, operationId: "delete" }).pipe(Effect.flip)).info.code,
            ).toBe("REQUEST_CONFLICT")
            const retried = yield* auth.deleteVendor({ id, revision: saved.revision, operationId: "delete" })
            return {
              deleted,
              retried,
              commandRevision: saved.revision,
              present: [...secrets.values()].includes("sk-delete"),
            }
          }).pipe(Effect.provide(layer))
          expect(first.deleted.cleanupPending).toBe(true)
          expect(first.retried.cleanupPending).toBe(true)
          expect(first.retried.revision).toBe(first.deleted.revision)
          expect(first.retried.vendors.some((vendor) => vendor.id === id)).toBe(false)
          expect(first.present).toBe(true)
          failRemove = false
          const done = yield* Effect.gen(function* () {
            const auth = yield* RelayAuth.Service
            expect(
              (yield* auth
                .deleteVendor({ id, revision: first.commandRevision, operationId: "delete" })
                .pipe(Effect.flip)).info.code,
            ).toBe("REVISION_CONFLICT")
            const current = yield* auth.get()
            const pending = yield* Effect.promise(() => Bun.file(path.join(tmp.path, "relay-auth.json")).json())
            const state = { ...current, cleanupPending: !!pending.pendingCleanup?.length }
            return { state, present: [...secrets.values()].includes("sk-delete") }
          }).pipe(Effect.provide(layer))
          expect(done.state.cleanupPending).toBe(false)
          expect(done.state.revision).toBe(first.deleted.revision)
          expect(done.present).toBe(false)
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("keeps committed key changes successful while every cleanup retry fails", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const secrets = new Map<string, string>()
          let failRemove = false
          const layer = AppNodeBuilder.build(RelayAuth.node, [
            [Global.node, Global.layerWith({ data: tmp.path })],
            [
              RelaySecretStore.node,
              Layer.succeed(
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
              ),
            ],
          ])
          const id = Relay.VendorID.make("retry")
          const first = yield* Effect.gen(function* () {
            const auth = yield* RelayAuth.Service
            const saved = yield* auth.setVendor({
              id,
              name: "Retry",
              key: "sk-vendor",
              baseURL: "https://retry.invalid/v1",
              revision: 0,
              operationId: "save-vendor",
            })
            failRemove = true
            const cleared = yield* auth.clearVendorKey({ id, revision: saved.revision, operationId: "clear-vendor" })
            expect(
              (yield* auth.clearVendorKey({ id, revision: 0, operationId: "clear-vendor" }).pipe(Effect.flip)).info
                .code,
            ).toBe("REQUEST_CONFLICT")
            const again = yield* auth.clearVendorKey({ id, revision: saved.revision, operationId: "clear-vendor" })
            const restored = yield* auth.setVendor({
              id,
              key: "sk-vendor",
              revision: again.revision,
              operationId: "restore-vendor",
            })
            const rotated = yield* auth.setVendor({
              id,
              key: "sk-vendor-next",
              revision: restored.revision,
              operationId: "rotate-vendor",
            })
            expect(
              (yield* auth
                .setVendor({ id, key: "sk-ignored", revision: 0, operationId: "rotate-vendor" })
                .pipe(Effect.flip)).info.code,
            ).toBe("REQUEST_CONFLICT")
            expect((yield* auth.resolve(id)).key).toBe("sk-vendor-next")
            const rotatedAgain = yield* auth.setVendor({
              id,
              key: "sk-vendor-next",
              revision: restored.revision,
              operationId: "rotate-vendor",
            })
            return { cleared, again, rotated, rotatedAgain }
          }).pipe(Effect.provide(layer))
          expect(first.cleared.cleanupPending).toBe(true)
          expect(first.again.cleanupPending).toBe(true)
          expect(first.again.revision).toBe(first.cleared.revision)
          expect(first.rotated.cleanupPending).toBe(true)
          expect(first.rotatedAgain.revision).toBe(first.rotated.revision)
          expect([...secrets.values()]).toEqual(expect.arrayContaining(["sk-vendor", "sk-vendor-next"]))
          const restarted = yield* Effect.gen(function* () {
            const auth = yield* RelayAuth.Service
            const before = yield* Effect.promise(() => NFS.readFile(path.join(tmp.path, "relay-auth.json"), "utf8"))
            expect(
              (yield* auth
                .setVendor({ id, key: "ignored", revision: 0, operationId: "rotate-vendor" })
                .pipe(Effect.flip)).info.code,
            ).toBe("REQUEST_CONFLICT")
            expect(yield* Effect.promise(() => NFS.readFile(path.join(tmp.path, "relay-auth.json"), "utf8"))).toBe(
              before,
            )
            return {
              revision: (yield* auth.get()).revision,
              cleanupPending: !!JSON.parse(before).pendingCleanup?.length,
            }
          }).pipe(Effect.provide(layer))
          expect(restarted.cleanupPending).toBe(true)
          expect(restarted.revision).toBe(first.rotated.revision)
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("completes cleanup after the cleanup record cannot be written", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const config = path.resolve(path.join(tmp.path, "relay-auth.json"))
          const fs = yield* Effect.gen(function* () {
            return yield* FSUtil.Service
          }).pipe(Effect.provide(AppNodeBuilder.build(FSUtil.node)))
          const secrets = new Map<string, string>()
          let failCleanupWrite = false
          let cleanupWrites = 0
          const wrapped = FSUtil.Service.of({
            ...fs,
            rename: (from, to) => {
              if (failCleanupWrite && path.resolve(to) === config) {
                cleanupWrites += 1
                if (cleanupWrites > 1)
                  return Effect.fail(
                    new PlatformError.PlatformError(
                      new PlatformError.SystemError({
                        _tag: "PermissionDenied",
                        module: "FileSystem",
                        method: "rename",
                      }),
                    ),
                  )
              }
              return fs.rename(from, to)
            },
          })
          const layer = AppNodeBuilder.build(RelayAuth.node, [
            [Global.node, Global.layerWith({ data: tmp.path })],
            [
              RelaySecretStore.node,
              Layer.succeed(
                RelaySecretStore.Service,
                RelaySecretStore.Service.of({
                  get: (ref) => Effect.sync(() => secrets.get(ref)),
                  put: (ref, secret) => Effect.sync(() => void secrets.set(ref, secret)),
                  remove: (ref) => Effect.sync(() => void secrets.delete(ref)),
                }),
              ),
            ],
            [FSUtil.node, Layer.succeed(FSUtil.Service, wrapped)],
          ])
          const id = Relay.VendorID.make("record")
          const saved = yield* Effect.gen(function* () {
            const auth = yield* RelayAuth.Service
            const created = yield* auth.setVendor({
              id,
              name: "Record",
              key: "sk-record",
              baseURL: "https://record.invalid/v1",
              revision: 0,
              operationId: "save-record",
            })
            failCleanupWrite = true
            const deleted = yield* auth.deleteVendor({ id, revision: created.revision, operationId: "delete-record" })
            return {
              revision: deleted.revision,
              cleanupPending: deleted.cleanupPending,
              commandRevision: created.revision,
            }
          }).pipe(Effect.provide(layer))
          expect(saved.cleanupPending).toBe(true)
          expect([...secrets.values()]).not.toContain("sk-record")
          failCleanupWrite = false
          const retried = yield* Effect.gen(function* () {
            const auth = yield* RelayAuth.Service
            expect(
              (yield* auth
                .deleteVendor({ id, revision: saved.commandRevision, operationId: "delete-record" })
                .pipe(Effect.flip)).info.code,
            ).toBe("REVISION_CONFLICT")
            const state = yield* auth.get()
            const pending = yield* Effect.promise(() => Bun.file(path.join(tmp.path, "relay-auth.json")).json())
            return {
              revision: state.revision,
              cleanupPending: !!pending.pendingCleanup?.length,
              present: [...secrets.values()].includes("sk-record"),
            }
          }).pipe(Effect.provide(layer))
          expect(retried.cleanupPending).toBe(false)
          expect(retried.revision).toBe(saved.revision)
          expect(retried.present).toBe(false)
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("completes cleanup when the system backend reports the secret absent with false", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const secrets = RelaySecretStore.makeLayer({
            get: async () => null,
            set: async () => undefined,
            delete: async () => false,
          }).pipe(Layer.provide(AppNodeBuilder.build(FSUtil.node)), Layer.provide(Global.layerWith({ data: tmp.path })))
          const layer = AppNodeBuilder.build(RelayAuth.node, [
            [Global.node, Global.layerWith({ data: tmp.path })],
            [RelaySecretStore.node, secrets],
          ])
          const id = Relay.VendorID.make("absent")
          const saved = yield* Effect.gen(function* () {
            const auth = yield* RelayAuth.Service
            const created = yield* auth.setVendor({
              id,
              name: "Absent",
              key: "sk-absent",
              baseURL: "https://absent.invalid/v1",
              revision: 0,
              operationId: "save-absent",
            })
            const deleted = yield* auth.deleteVendor({ id, revision: created.revision, operationId: "delete-absent" })
            const retried = yield* auth.deleteVendor({ id, revision: created.revision, operationId: "delete-absent" })
            return { deleted, retried }
          }).pipe(Effect.provide(layer))
          expect(saved.deleted.cleanupPending).toBe(false)
          expect(saved.retried.cleanupPending).toBe(false)
          expect(saved.retried.revision).toBe(saved.deleted.revision)
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})

it.live("recovers prepared references without deleting a credential referenced by committed config", () =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) =>
      Effect.gen(function* () {
        const values = new Map<string, string>()
        const secrets = Layer.succeed(
          RelaySecretStore.Service,
          RelaySecretStore.Service.of({
            get: (ref) => Effect.succeed(values.get(ref)),
            put: (ref, secret) => Effect.sync(() => void values.set(ref, secret)),
            remove: (ref) => Effect.sync(() => void values.delete(ref)),
          }),
        )
        const layer = AppNodeBuilder.build(RelayAuth.node, [
          [Global.node, Global.layerWith({ data: tmp.path })],
          [RelaySecretStore.node, secrets],
        ])
        yield* Effect.gen(function* () {
          const auth = yield* RelayAuth.Service
          yield* auth.setVendor({
            name: "Independent",
            baseURL: "https://provider.test/v1",
            id: Relay.VendorID.chatgpt,
            key: "active",
            revision: 0,
          })
        }).pipe(Effect.provide(layer))
        const stored = yield* Effect.promise(() => Bun.file(path.join(tmp.path, "relay-auth.json")).json())
        const ref = stored.vendors.chatgpt.keyRef as string
        values.set("uncommitted", "orphan")
        yield* Effect.promise(() =>
          Bun.write(path.join(tmp.path, "relay-auth-preparing.json"), JSON.stringify([ref, "uncommitted"])),
        )
        yield* Effect.gen(function* () {
          const auth = yield* RelayAuth.Service
          expect((yield* auth.resolve(Relay.VendorID.chatgpt)).key).toBe("active")
          expect(values.has("uncommitted")).toBe(false)
          expect(values.get(ref)).toBe("active")
        }).pipe(Effect.provide(layer))
        expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "relay-auth-preparing.json")).exists())).toBe(
          false,
        )
      }),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ),
)
