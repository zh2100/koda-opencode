import fs from "node:fs/promises"
import path from "node:path"
import { spyOn } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ConfigDocument } from "@opencode-ai/core/config/document"
import { AtomicDocument } from "@opencode-ai/core/config/atomic-document"
import { Hash } from "../../src/util/hash"
import { Global } from "@opencode-ai/core/global"
import { ImageGenerationSettings } from "@opencode-ai/core/image-generation-settings"
import { EffectFlock } from "../../src/util/effect-flock"
import { createEffectFlockTestNode } from "../support/effect-flock-test-layer"

const input = parseInput(process.argv[2])
const file = path.join(input.root, "opencode.json")
const key = ConfigDocument.key(file)
const lockfile = path.join(input.root, "state", "locks", `${Hash.fast(key)}.lock`)
const before = '\uFEFF{\r\n  // keep\r\n  "model": "chat/model"\r\n}\r\n'
const higher = '{\r\n  // higher\r\n  "model": "chat/model"\r\n}\r\n'
const jsonc = path.join(input.root, "opencode.jsonc")
const wait = Effect.runSync(Deferred.make<{ readonly key: string; readonly lockfile: string }>())
const emit = (name: string, details: Record<string, unknown> = {}) =>
  process.stdout.write(`${JSON.stringify({ scenario: input.scenario, name, ...details })}\n`)

let productError: string | undefined
function productFailure(message: string): never {
  productError = message
  throw new Error(message)
}

function parseInput(encoded: string | undefined) {
  if (!encoded) throw new Error("missing stage 0 payload")
  const value: unknown = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"))
  if (!value || typeof value !== "object") throw new Error("invalid stage 0 payload")
  const record = value as Record<string, unknown>
  if (record.scenario !== "t07a" && record.scenario !== "t10") throw new Error("invalid stage 0 scenario")
  if (typeof record.root !== "string" || record.root.length === 0) throw new Error("invalid stage 0 root")
  const injection = record.injection
  if (injection !== undefined && !(record.scenario === "t10" && injection === "invert-conflict") &&
    !(record.scenario === "t07a" && injection === "pause-before-interrupt")) throw new Error("invalid injection")
  return { scenario: record.scenario, root: record.root, injection }
}

const layer = AppNodeBuilder.build(LayerNode.group([ImageGenerationSettings.node, EffectFlock.node, Global.node]), [
  [Global.node, Global.layerWith({ config: input.root, state: path.join(input.root, "state") })],
  [
    EffectFlock.node,
    createEffectFlockTestNode({
      onWait: (event) => {
        if (event.key !== key || event.lockfile !== lockfile) return
        if (Effect.runSync(Deferred.succeed(wait, event))) emit("wait", event)
      },
    }),
  ],
])

await Effect.runPromise(
  Effect.gen(function* () {
    const flock = yield* EffectFlock.Service
    const settings = yield* ImageGenerationSettings.Service
    const publish = spyOn(AtomicDocument, "publish")
    const held = yield* Deferred.make<void>()
    yield* Effect.promise(() => fs.writeFile(file, before))
    const holder = yield* Effect.scoped(
      Effect.gen(function* () {
        yield* flock.acquire(key)
        emit("holding")
        yield* Deferred.succeed(held, undefined)
        yield* Effect.never
      }),
    ).pipe(Effect.forkChild)
    yield* Deferred.await(held)
    const saving = yield* settings
      .update({ enabled: true, model: "local/image", api: "openai-images" })
      .pipe(Effect.forkChild)
    yield* Deferred.await(wait)
    if ((yield* Effect.scoped(flock.probe(key))).status !== "busy") productFailure("lease not busy")
    if (input.scenario === "t07a") {
      emit("interrupt-requested")
      if (input.injection === "pause-before-interrupt") yield* Effect.never
      yield* Fiber.interrupt(saving)
      const exit = yield* Fiber.await(saving)
      if (!Exit.isFailure(exit) || !Cause.hasInterrupts(exit.cause))
        productFailure("saving was not interrupted")
      emit("saving-terminated")
    } else {
      yield* Effect.promise(() => fs.writeFile(jsonc, higher))
      emit("higher-created")
    }
    yield* Fiber.interrupt(holder)
    yield* Fiber.await(holder)
    emit("holder-released")
    if (input.scenario === "t10") {
      const exit = yield* Fiber.await(saving)
      if (!Exit.isFailure(exit)) return productFailure("T10 save unexpectedly succeeded")
      const error = Cause.findErrorOption(exit.cause)
      if (
        error._tag !== "Some" ||
        !(error.value instanceof ImageGenerationSettings.Error) ||
        (error.value.code === "conflict") === (input.injection === "invert-conflict")
      ) {
        productFailure("T10 save did not produce a conflict error")
      }
    }
    if (publish.mock.calls.length !== 0) productFailure("unexpected publication")
    if ((yield* Effect.scoped(flock.probe(key))).status !== "acquired") productFailure("lease not reusable")
    yield* Effect.promise(async () => {
      if (!(await fs.readFile(file)).equals(Buffer.from(before))) productFailure("original document changed")
      if (input.scenario === "t10" && !(await fs.readFile(jsonc)).equals(Buffer.from(higher)))
        productFailure("higher-priority document changed")
      if ((await fs.readdir(input.root)).some((entry) => entry.startsWith(".opencode-stage-")))
        productFailure("staging directory leaked")
    })
    emit("result", { ok: true, outcome: input.scenario === "t10" ? "conflict" : "interrupted" })
  }).pipe(Effect.provide(layer)),
)
  .then(() => process.exit(0))
  .catch((error) => {
    emit("result", productError ? { ok: false, outcome: "product-failure", error: productError } : { ok: false, error: error instanceof Error ? error.message : String(error) })
    process.exit(1)
  })
