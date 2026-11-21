import path from "path"
import fs from "fs/promises"
import os from "os"
import { expect, spyOn } from "bun:test"
import { AtomicDocument } from "@opencode-ai/core/config/atomic-document"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Hash } from "@opencode-ai/core/util/hash"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { LockProtocol } from "@opencode-ai/core/util/lock-protocol"
import { ImageGenerationSettings } from "@opencode-ai/core/image-generation-settings"
import { Npm } from "@opencode-ai/core/npm"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { HttpClient } from "effect/unstable/http"
import { Config } from "../../src/config/config"
import { Auth } from "../../src/auth"
import { Account } from "../../src/account/account"
import { AuthTest } from "../fake/auth"
import { AccountTest } from "../fake/account"
import { NpmTest } from "../fake/npm"
import { provideInstanceEffect, testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)
const image = { enabled: true, model: "local/image", api: "openai-images" } as const
type Writer = "image" | "global" | "mcp" | "project" | "schema" | "mcp-unannotated" | "legacy"

for (const [first, second] of [
  ["image", "global"],
  ["global", "image"],
  ["image", "mcp"],
  ["mcp", "image"],
  ["mcp-unannotated", "image"],
  ["global", "global"],
  ["project", "global"],
  ["mcp", "mcp"],
  ["schema", "image"],
  ["legacy", "image"],
] as const) {
  it.live("serializes real document writers: " + first + " then " + second, () =>
    Effect.gen(function* () {
      const originalConfig = Global.Path.config
      const configRoot = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "opencode-document-")))
      ;(Global.Path as { config: string }).config = configRoot
      yield* Effect.addFinalizer(() => Effect.promise(async () => {
        ;(Global.Path as { config: string }).config = originalConfig
        await fs.rm(configRoot, { recursive: true, force: true })
      }))
      const file = path.join(Global.Path.config, first === "project" ? "opencode.jsonc" : "config.json")
      if (first === "legacy") {
        process.env.REVIEW_LEGACY_USERNAME = "modern-from-env"
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            delete process.env.REVIEW_LEGACY_USERNAME
          }),
        )
      }
      const initial = {
        ...(first === "schema" ? {} : { $schema: "https://opencode.ai/config.json" }),
        username: first === "legacy" ? "{env:REVIEW_LEGACY_USERNAME}" : "before",
        image_generation: { enabled: false },
        mcp: {
          review: { type: "remote", url: "https://before.example/mcp" },
          other: { type: "remote", url: "https://other.example/mcp" },
        },
      }
      yield* Effect.promise(() => fs.writeFile(file, JSON.stringify(initial)))
      const legacy = path.join(Global.Path.config, "config")
      if (first === "legacy") yield* Effect.promise(() => fs.writeFile(legacy, 'username = "legacy-default"\n'))
      const reached = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      let armed = false
      const pause = Effect.promise(async () => {
        if (!armed) return
        armed = false
        reached.resolve()
        await release.promise
      })
      const originalPublish = AtomicDocument.publish
      const publishing = spyOn(AtomicDocument, "publish").mockImplementation(async (input) => {
        if (input.file === file) await Effect.runPromise(pause)
        return originalPublish(input)
      })
      yield* Effect.addFinalizer(() => Effect.sync(() => { release.resolve(); publishing.mockRestore() }))
      const intercepted = Layer.effect(
        FSUtil.Service,
        Effect.gen(function* () {
          const original = yield* FSUtil.Service
          return FSUtil.Service.of({
            ...original,
            writeFileString: (target, text, options) =>
              (target === file ? pause : Effect.void).pipe(
                Effect.andThen(original.writeFileString(target, text, options)),
              ),
            rename: (from, to) => (to === file ? pause : Effect.void).pipe(Effect.andThen(original.rename(from, to))),
          })
        }),
      ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
      const services = LayerNode.compile(LayerNode.group([Config.node, ImageGenerationSettings.node]), [
        [Global.node, Global.layerWith({ lockContext: LockProtocol.unregistered({ ...Global.lockContext, config: configRoot }) })],
        [FSUtil.node, intercepted],
        [Auth.node, AuthTest.empty],
        [Account.node, AccountTest.empty],
        [Npm.node, NpmTest.noop],
        [
          httpClient,
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) => Effect.die("unexpected HTTP " + request.url)),
          ),
        ],
      ])

      yield* Effect.gen(function* () {
        const settings = yield* ImageGenerationSettings.Service
        const config = yield* Config.Service
        const source = first !== "schema" && first !== "legacy" ? yield* config.mcpSource("review") : undefined
        if (first !== "schema" && first !== "legacy") expect(source?.source).toBe(file)
        const unannotated = JSON.stringify({ ...initial, $schema: undefined })
        if (first === "mcp-unannotated") yield* Effect.promise(() => fs.writeFile(file, unannotated))
        const write = (writer: Writer, order: number): Effect.Effect<unknown, unknown> => {
          if (writer === "image") return settings.update(image)
          if (writer === "global")
            return config.updateGlobal(order === 1 ? { username: "saved" } : { model: "local/chat" })
          if (writer === "project") return config.update({ username: "project-saved" })
          if (writer === "schema" || writer === "legacy") return config.getGlobal()
          return config.updateMcp({
            name: order === 1 ? "review" : "other",
            source: file,
            version: first === "mcp-unannotated" ? Hash.fast(unannotated) : source!.version,
            patch: { url: "https://saved.example/mcp" },
          })
        }
        armed = true
        const a = yield* write(first, 1).pipe(Effect.exit, Effect.tap((exit) => Exit.isFailure(exit) ? Effect.logError("first writer failed", Cause.pretty(exit.cause)) : Effect.void), Effect.forkScoped)
        yield* Effect.promise(() => reached.promise).pipe(Effect.timeout("5 seconds"))
        let completed = false
        const b = yield* write(second, 2).pipe(
          Effect.exit,
          Effect.tap((exit) => Exit.isFailure(exit) ? Effect.logError("second writer failed", Cause.pretty(exit.cause)) : Effect.void),
          Effect.tap(() =>
            Effect.sync(() => {
              completed = true
            }),
          ),
          Effect.forkScoped,
        )
        try {
          yield* Effect.promise(() => Bun.sleep(80))
          expect(completed).toBe(false)
        } finally {
          release.resolve()
        }
        const firstResult = yield* Fiber.join(a)
        expect(Exit.isSuccess(firstResult)).toBe(true)
        if (first === "legacy" && Exit.isSuccess(firstResult))
          expect(firstResult.value).toMatchObject({ username: "modern-from-env" })
        const result = yield* Fiber.join(b)
        if (second === "mcp") {
          expect(Exit.isFailure(result)).toBe(true)
          if (Exit.isFailure(result)) expect(Cause.squash(result.cause)).toMatchObject({ code: "MCP_VERSION_CONFLICT" })
          const latest = yield* config.mcpSource("other")
          expect(latest).toBeDefined()
          yield* config.updateMcp({
            name: "other",
            source: file,
            version: latest!.version,
            patch: { url: "https://saved.example/mcp" },
          }).pipe(provideInstanceEffect(Global.Path.config))
        } else {
          expect(Exit.isSuccess(result)).toBe(true)
        }
        const final = JSON.parse(yield* Effect.promise(() => fs.readFile(file, "utf8")))
        if (first === "image" || second === "image") expect(final.image_generation).toEqual(image)
        if (first === "global") expect(final.username).toBe("saved")
        if (first === "project") expect(final.username).toBe("project-saved")
        if (second === "global") expect(final.model).toBe("local/chat")
        if (first === "mcp" || first === "mcp-unannotated")
          expect(final.mcp.review.url).toBe("https://saved.example/mcp")
        if (second === "mcp") expect(final.mcp.other.url).toBe("https://saved.example/mcp")
        if (first === "schema") expect(final.$schema).toBe("https://opencode.ai/config.json")
        if (first === "legacy") {
          expect(final.username).toBe("{env:REVIEW_LEGACY_USERNAME}")
          expect(JSON.stringify(final)).not.toContain("modern-from-env")
          expect(
            yield* Effect.promise(() =>
              fs.access(legacy).then(
                () => true,
                () => false,
              ),
            ),
          ).toBe(false)
        }
      }).pipe(
        provideInstanceEffect(Global.Path.config),
        Effect.provide(testInstanceStoreLayer),
        Effect.provide(services),
      )
      yield* Effect.promise(() => fs.rm(file, { force: true }))
    }),
  )
}
