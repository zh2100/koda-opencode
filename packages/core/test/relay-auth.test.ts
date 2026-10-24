import { describe, expect } from "bun:test"
import { writeFile } from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
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
        state = yield* auth.setUnifiedKey({ key: "shared-secret", revision: state.revision })
        state = yield* auth.setMode({ unified: true, revision: state.revision })
        expect(yield* auth.resolve(id)).toEqual({ key: "custom-key", baseURL: "http://localhost:1234/v1" })
        state = yield* auth.setVendor({ id, name: "Renamed", revision: state.revision })
        expect((yield* auth.get()).vendors.find((vendor) => vendor.id === id)?.baseURL).toBe("http://localhost:1234/v1")
        const invalid = yield* auth
          .setVendor({ id, baseURL: "https://user:pass@example.com", revision: state.revision })
          .pipe(Effect.flip)
        expect(invalid.info.code).toBe("REQUEST_CONFLICT")
        const builtin = yield* auth
          .setVendor({ id: Relay.VendorID.chatgpt, baseURL: "https://example.com", revision: state.revision })
          .pipe(Effect.flip)
        expect(builtin.info.code).toBe("REQUEST_CONFLICT")
        state = yield* auth.clearVendorKey({ id, revision: state.revision })
        expect((yield* auth.resolve(id).pipe(Effect.flip)).info.code).toBe("KEY_MISSING")
        expect((yield* auth.resolve(Relay.VendorID.chatgpt)).key).toBe("shared-secret")
      }),
    ),
  )

  it.live("defaults to built-in vendors without keys", () =>
    withAuth((auth) =>
      Effect.gen(function* () {
        const state = yield* auth.get()
        expect(state.unified).toBe(false)
        expect(state.hasUnifiedKey).toBe(false)
        expect(state.canRollback).toBe(false)
        expect(state.vendors.map((vendor) => vendor.id)).toEqual([
          Relay.VendorID.chatgpt,
          Relay.VendorID.claude,
          Relay.VendorID.gemini,
          Relay.VendorID.grok,
          Relay.VendorID.kimi,
        ])
        expect(state.vendors.every((vendor) => vendor.hasKey === false && vendor.builtin)).toBe(true)
      }),
    ),
  )

  it.live("stores independent vendor keys and resolves the selected vendor", () =>
    withAuth((auth) =>
      Effect.gen(function* () {
        const chatgpt = yield* auth.setVendor({
          id: Relay.VendorID.chatgpt,
          key: "sk-chatgpt",
          revision: 0,
        })
        const grok = yield* auth.setVendor({
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

  it.live("uses the unified key for every vendor and restores independent keys after disable", () =>
    withAuth((auth) =>
      Effect.gen(function* () {
        let state = yield* auth.setVendor({ id: Relay.VendorID.chatgpt, key: "sk-chatgpt", revision: 0 })
        state = yield* auth.setVendor({ id: Relay.VendorID.grok, key: "sk-grok", revision: state.revision })
        state = yield* auth.setUnifiedKey({ key: "sk-unified", revision: state.revision })
        state = yield* auth.setMode({ unified: true, revision: state.revision })
        expect((yield* auth.resolve(Relay.VendorID.chatgpt)).key).toBe("sk-unified")
        expect((yield* auth.resolve(Relay.VendorID.grok)).key).toBe("sk-unified")
        state = yield* auth.setMode({ unified: false, revision: state.revision })
        expect((yield* auth.resolve(Relay.VendorID.chatgpt)).key).toBe("sk-chatgpt")
        expect((yield* auth.resolve(Relay.VendorID.grok)).key).toBe("sk-grok")
      }),
    ),
  )

  it.live("clears one vendor key without affecting others", () =>
    withAuth((auth) =>
      Effect.gen(function* () {
        let state = yield* auth.setVendor({ id: Relay.VendorID.chatgpt, key: "sk-chatgpt", revision: 0 })
        state = yield* auth.setVendor({ id: Relay.VendorID.grok, key: "sk-grok", revision: state.revision })
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
          id: Relay.VendorID.chatgpt,
          key: "sk-one",
          revision: 0,
          operationId: "op-1",
        })
        const replayed = yield* auth.setVendor({
          id: Relay.VendorID.chatgpt,
          key: "sk-two",
          revision: 0,
          operationId: "op-1",
        })
        expect(replayed.revision).toBe(first.revision)
        expect((yield* auth.resolve(Relay.VendorID.chatgpt)).key).toBe("sk-one")
        const conflict = yield* auth
          .setVendor({ id: Relay.VendorID.chatgpt, key: "sk-three", revision: 0 })
          .pipe(Effect.flip)
        expect(conflict.info.code).toBe("REVISION_CONFLICT")
      }),
    ),
  )

  it.live("imports api keys from auth.json without writing plaintext backups", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            writeFile(
              path.join(tmp.path, "auth.json"),
              JSON.stringify({
                openai: { type: "api", key: "sk-openai" },
                xai: { type: "api", key: "sk-xai" },
                anthropic: { type: "api", key: "sk-anthropic" },
              }),
              { mode: 0o600 },
            ),
          )
          const layer = AppNodeBuilder.build(RelayAuth.node, [
            [Global.node, Global.layerWith({ data: tmp.path })],
            [RelaySecretStore.node, RelaySecretStore.memoryLayer],
          ])
          return yield* Effect.gen(function* () {
            const auth = yield* RelayAuth.Service
            const state = yield* auth.get()
            expect(state.vendors.find((vendor) => vendor.id === Relay.VendorID.chatgpt)?.hasKey).toBe(true)
            expect(state.vendors.find((vendor) => vendor.id === Relay.VendorID.grok)?.hasKey).toBe(true)
            expect((yield* auth.resolve(Relay.VendorID.chatgpt)).key).toBe("sk-openai")
            expect((yield* auth.resolve(Relay.VendorID.grok)).key).toBe("sk-xai")
            const backup = yield* Effect.promise(() => Bun.file(path.join(tmp.path, "auth.relay-backup.json")).text())
            expect(backup).not.toContain("sk-openai")
            expect(backup).not.toContain("sk-xai")
            expect(backup).not.toContain("sk-anthropic")
            expect(backup).toContain("anthropic")
            expect(state.canRollback).toBe(true)
            const original = yield* Effect.promise(() => Bun.file(path.join(tmp.path, "auth.json")).text())
            expect(original).toContain("sk-openai")
            const rolled = yield* auth.rollback({ revision: state.revision })
            expect(rolled.canRollback).toBe(true)
            expect(rolled.hasUnifiedKey).toBe(false)
            expect(rolled.vendors.every((vendor) => vendor.hasKey === false)).toBe(true)
            const missing = yield* auth.resolve(Relay.VendorID.chatgpt).pipe(Effect.flip)
            expect(missing.info.code).toBe("KEY_MISSING")
            expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "auth.json")).text())).toContain(
              "sk-openai",
            )
          }).pipe(Effect.provide(layer))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})
