import fs from "node:fs/promises"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { Global } from "@opencode-ai/core/global"

const input = parseInput(process.argv[2])

function parseInput(encoded: string | undefined) {
  if (!encoded) throw new Error("missing worker payload")
  const value: unknown = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"))
  if (!value || typeof value !== "object") throw new Error("worker payload is not an object")
  const input = value as Record<string, unknown>
  if (input.scenario !== "normal" && input.scenario !== "failure" && input.scenario !== "hang")
    throw new Error("worker payload has invalid scenario")
  if (typeof input.root !== "string" || input.root.length === 0) throw new Error("worker payload has invalid root")
  if (typeof input.key !== "string" || input.key.length === 0) throw new Error("worker payload has invalid key")
  return { scenario: input.scenario, root: input.root, key: input.key }
}

const emit = (name: string, details: Record<string, unknown> = {}) =>
  Effect.sync(() => process.stdout.write(`${JSON.stringify({ scenario: input.scenario, name, ...details })}\n`))

const global = Global.layerWith({
  home: input.root,
  data: input.root,
  cache: input.root,
  config: input.root,
  state: input.root,
  bin: input.root,
  log: input.root,
})
const layer = AppNodeBuilder.build(EffectFlock.node, [[Global.node, global]])

await Effect.runPromise(emit("started", { pid: process.pid }))

await Effect.runPromise(
  Effect.gen(function* () {
    const flock = yield* EffectFlock.Service
    yield* flock.withLock(
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.writeFile(`${input.root}/holding`, String(process.pid)))
        yield* emit("holding")
        if (input.scenario === "hang") yield* Effect.never
        if (input.scenario === "failure") return yield* Effect.fail(new Error("poc-business-failure"))
      }),
      input.key,
      input.root,
    )
    yield* emit("released")
    yield* emit("result", { ok: true })
  }).pipe(Effect.scoped, Effect.provide(layer)),
)
  .then(() => {
    process.exit(0)
  })
  .catch(async (error) => {
    await Effect.runPromise(
      emit("result", { ok: false, error: error instanceof Error ? error.message : String(error) }),
    )
    process.exit(1)
  })
