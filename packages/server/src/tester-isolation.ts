export * as ServerTesterIsolation from "./tester-isolation"

import { ChildProcess } from "effect/unstable/process"
import { Effect, Layer, Path } from "effect"
import { AppProcess } from "@opencode-ai/core/process"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { TesterIsolation } from "@opencode-ai/core/tester-isolation"
import { makeLocationNode } from "@opencode-ai/core/effect/app-node"
import { path } from "@opencode-ai/core/effect/app-node-platform"

const layer = Layer.effect(
  TesterIsolation.Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const pathSvc = yield* Path.Path
    const process = yield* AppProcess.Service

    const git = (args: string[], cwd: string) =>
      process.run(ChildProcess.make("git", args, { cwd, extendEnv: true, stdin: "ignore" })).pipe(
        Effect.map((result) => ({
          code: result.exitCode,
          text: result.stdout.toString("utf8"),
          stderr: result.stderr.toString("utf8"),
        })),
        Effect.catch((error) =>
          Effect.succeed({
            code: 1,
            text: "",
            stderr: error instanceof Error ? error.message : String(error),
          }),
        ),
      )

    const acquire = Effect.fn("ServerTesterIsolation.acquire")(function* (
      input: Parameters<TesterIsolation.Interface["acquire"]>[0],
    ) {
      const source = input.source.directory
      const top = yield* git(["-c", `safe.directory=${source}`, "rev-parse", "--show-toplevel"], source)
      if (top.code !== 0) {
        return yield* new TesterIsolation.AcquireError({
          message: top.stderr || top.text || `Tester isolation requires a git repository: ${source}`,
        })
      }

      const base = top.text.trim()
      const root = pathSvc.join(Global.Path.data, "worktree", "tester")
      yield* fs
        .makeDirectory(root, { recursive: true })
        .pipe(
          Effect.mapError(
            (error) =>
              new TesterIsolation.AcquireError({ message: error instanceof Error ? error.message : String(error) }),
          ),
        )

      const directory = pathSvc.join(root, `${slugify(input.name)}-${crypto.randomUUID().slice(0, 8)}`)
      const added = yield* git(["-c", `safe.directory=${base}`, "worktree", "add", "--detach", directory, "HEAD"], base)
      if (added.code !== 0) {
        return yield* new TesterIsolation.AcquireError({
          message: added.stderr || added.text || "Failed to create isolated tester worktree",
        })
      }

      return {
        location: { directory: AbsolutePath.make(directory) },
        release: remove(directory, base, fs, git),
      }
    })

    return TesterIsolation.Service.of({ acquire })
  }),
)

const remove = (
  directory: string,
  base: string,
  fs: FSUtil.Interface,
  git: (args: string[], cwd: string) => Effect.Effect<{ code: number; text: string; stderr: string }>,
) =>
  Effect.gen(function* () {
    const removed = yield* git(["-c", `safe.directory=${base}`, "worktree", "remove", "--force", directory], base)
    if (removed.code === 0) return

    yield* fs.remove(directory, { recursive: true }).pipe(Effect.ignore)
    const pruned = yield* git(["-c", `safe.directory=${base}`, "worktree", "prune"], base)
    if (pruned.code !== 0) {
      return yield* new TesterIsolation.ReleaseError({
        message: removed.stderr || removed.text || pruned.stderr || pruned.text || "Failed to remove tester worktree",
      })
    }
  })

function slugify(input: string) {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "tester"
  )
}

export const node = makeLocationNode({
  service: TesterIsolation.Service,
  layer,
  deps: [FSUtil.node, path, AppProcess.node],
})
