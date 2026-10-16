export * as OrchestratorTesterIsolation from "./tester-isolation"

import path from "path"
import { Effect, Layer } from "effect"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { TesterIsolation } from "@opencode-ai/core/tester-isolation"
import { Worktree } from "@/worktree"
import { makeLocationNode } from "@opencode-ai/core/effect/app-node"

const layer = Layer.effect(
  TesterIsolation.Service,
  Effect.gen(function* () {
    const worktree = yield* Worktree.Service

    const acquire = Effect.fn("OrchestratorTesterIsolation.acquire")(function* (input: Parameters<TesterIsolation.Interface["acquire"]>[0]) {
      const info = yield* worktree.create({ name: input.name })
      const location = { directory: AbsolutePath.make(info.directory) }
      return {
        location,
        release: worktree.remove({ directory: info.directory }).pipe(Effect.asVoid, Effect.mapError((error) => new TesterIsolation.ReleaseError({ message: error.message }))),
      }
    })

    return TesterIsolation.Service.of({
      acquire: (input) => acquire(input).pipe(Effect.mapError((error) => error instanceof TesterIsolation.AcquireError ? error : new TesterIsolation.AcquireError({ message: error.message }))),
    })
  }),
)

export const node = makeLocationNode({
  service: TesterIsolation.Service,
  layer,
  deps: [Worktree.node],
})

function normalize(directory: string) {
  const value = path.normalize(path.resolve(directory))
  return process.platform === "win32" ? value.toLowerCase() : value
}
