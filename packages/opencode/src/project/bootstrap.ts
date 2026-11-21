import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { Plugin } from "../plugin"
import { Format } from "../format"
import { LSP } from "@/lsp/lsp"
import { Snapshot } from "../snapshot"
import * as Project from "./project"
import * as Vcs from "./vcs"
import { InstanceState } from "@/effect/instance-state"
import { ShareNext } from "@/share/share-next"
import { existsSync } from "fs"
import { access, constants } from "fs/promises"
import path from "path"
import { randomUUID } from "crypto"
import { Cause, Effect, Layer } from "effect"
import { Config } from "@/config/config"
import { ConfigPaths } from "@/config/paths"
import { McpEditError } from "@/config/mcp-edit"
import { Service } from "./bootstrap-service"

export { Service } from "./bootstrap-service"
export type { Interface } from "./bootstrap-service"

function sourceReadCode(error: unknown): string | undefined {
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    if (error.code === "EACCES" || error.code === "EPERM" || error.code === "EIO" || error.code === "EBUSY") {
      return error.code
    }
  }
  if (typeof error === "object" && error !== null && "cause" in error) return sourceReadCode(error.cause)
  return
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // Yield each bootstrap dep at layer init so `run` itself has R = never.
    // InstanceStore imports only the lightweight tag from bootstrap-service.ts,
    // so it can depend on bootstrap without importing this implementation graph.
    const config = yield* Config.Service
    const format = yield* Format.Service
    const lsp = yield* LSP.Service
    const plugin = yield* Plugin.Service
    const project = yield* Project.Service
    const shareNext = yield* ShareNext.Service
    const snapshot = yield* Snapshot.Service
    const vcs = yield* Vcs.Service

    const run = Effect.gen(function* () {
      const ctx = yield* InstanceState.context
      yield* Effect.logInfo("bootstrapping", { directory: ctx.directory })
      // everything depends on config so eager load it for nice traces
      // A corrupt document is a typed config failure. Keep it typed so the instance boundary can answer
      // the declared HTTP contract before the route handler runs.
      // A deleted environment document with no project file is absence, not a document error.
      // A file that still exists keeps the typed failure so the route can answer 400 or 503.
      // Probe only sources the loader would read. A disabled project file must not fail instance init.
      const presentFiles = ConfigPaths.discover("opencode", ctx.directory, ctx.worktree).filter((file) =>
        existsSync(file),
      )
      const denied = yield* Effect.promise(async () => {
        for (const file of presentFiles) {
          try {
            await access(file, constants.R_OK)
          } catch (error) {
            if (sourceReadCode(error)) return true
          }
        }
        return false
      })
      if (denied) {
        return yield* new McpEditError({ code: "MCP_SOURCE_READ_FAILED", ref: randomUUID() })
      }
      const deletedEnvOnly =
        process.env.OPENCODE_CONFIG_CONTENT === undefined &&
        process.env.OPENCODE_CONFIG === undefined &&
        presentFiles.length === 0
      if (deletedEnvOnly) {
        yield* config.get().pipe(Effect.catch(() => Effect.void))
      } else {
        yield* config.get().pipe(
          Effect.catchCause((cause) => {
            const found = Cause.findErrorOption(cause)
            const error = found._tag === "Some" ? found.value : Cause.squash(cause)
            const typed =
              typeof error === "object" && error !== null && "_tag" in error && error._tag === "McpEditError"
                ? (error as McpEditError)
                : undefined
            if (typed?.code === "MCP_SOURCE_READ_FAILED" || sourceReadCode(error) || sourceReadCode(Cause.squash(cause))) {
              return Effect.fail(new McpEditError({ code: "MCP_SOURCE_READ_FAILED", ref: randomUUID() }))
            }
            if (typed) return Effect.fail(typed)
            return Effect.failCause(cause)
          }),
        )
      }
      // Plugin can mutate config so it has to be initialized before anything else.
      yield* plugin.init()
      // Each service self-manages its own slow work via Effect.forkScoped against
      // its per-instance state scope. We just await materialization here.
      yield* Effect.forEach(
        [lsp, shareNext, format, vcs, snapshot, project],
        (s) => s.init().pipe(Effect.catchCause((cause) => Effect.logWarning("init failed", { cause }))),
        { concurrency: "unbounded", discard: true },
      ).pipe(Effect.withSpan("InstanceBootstrap.init"))
    }).pipe(Effect.withSpan("InstanceBootstrap"))

    return Service.of({ run })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer: layer,
  deps: [Config.node, Format.node, LSP.node, Plugin.node, Project.node, ShareNext.node, Snapshot.node, Vcs.node],
})

export * as InstanceBootstrap from "./bootstrap"
