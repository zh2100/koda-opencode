import { Config } from "@/config/config"
import { ProjectConfig } from "@/config/project-write"
import { ConfigWrite } from "@/config/write-error"
import { projectConfigHttpError } from "../config-write-error"
import { McpEditError } from "@/config/mcp-edit"
import { ConfigLoaderWrites } from "@/effect/config-loader-mode"
import { ConfigErrorV1 } from "@opencode-ai/core/v1/config/error"
import { existsSync } from "fs"
import path from "path"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { Project } from "@/project/project"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Cause, Effect, Layer } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { WorkspaceRouteContext } from "./workspace-routing"
import {
  McpConfigConflictError,
  McpConfigForbiddenError,
  McpConfigInvalidError,
  McpConfigNotFoundError,
  McpConfigUnavailableError,
} from "../errors"

export class InstanceContextMiddleware extends HttpApiMiddleware.Service<
  InstanceContextMiddleware,
  {
    requires: WorkspaceRouteContext
  }
>()("@opencode/ExperimentalHttpApiInstanceContext") {}

export class ConfigContextMiddleware extends HttpApiMiddleware.Service<
  ConfigContextMiddleware,
  { requires: WorkspaceRouteContext }
>()("@opencode/ConfigSourceContext") {}

export class ConfigWriteContextMiddleware extends HttpApiMiddleware.Service<ConfigWriteContextMiddleware, {
  requires: WorkspaceRouteContext
}>()("@opencode/ConfigWriteContext") {}

export const configContextLayer = Layer.effect(
  ConfigContextMiddleware,
  Effect.gen(function* () {
    const project = yield* Project.Service
    return ConfigContextMiddleware.of((effect) => Effect.gen(function* () {
      const route = yield* WorkspaceRouteContext
      const directory = FSUtil.resolve(decode(route.directory))
      const resolved = yield* project.fromDirectory(directory)
      return yield* effect.pipe(
        Effect.provideService(InstanceRef, { directory, worktree: resolved.sandbox, project: resolved.project }),
        Effect.provideService(WorkspaceRef, route.workspaceID),
      )
    }))
  }),
)

function decode(input: string): string {
  try {
    return decodeURIComponent(input)
  } catch {
    return input
  }
}

function sourceReadCode(error: unknown, seen = new Set<unknown>()): string | undefined {
  if (typeof error !== "object" || error === null || seen.has(error)) return
  seen.add(error)
  if ("code" in error && typeof error.code === "string") {
    if (error.code === "EACCES" || error.code === "EPERM" || error.code === "EIO" || error.code === "EBUSY") {
      return error.code
    }
  }
  if (error instanceof Error && error.message.length > 0) {
    const named = error.message.match(/\b(EACCES|EPERM|EIO|EBUSY)\b/)
    if (named) return named[1]
  }
  if ("cause" in error) {
    const nested = sourceReadCode(error.cause, seen)
    if (nested) return nested
  }
  if ("defect" in error) {
    const nested = sourceReadCode(error.defect, seen)
    if (nested) return nested
  }
  if ("error" in error) {
    const nested = sourceReadCode(error.error, seen)
    if (nested) return nested
  }
  if ("reason" in error) {
    const nested = sourceReadCode(error.reason, seen)
    if (nested) return nested
  }
  if ("reasons" in error && Array.isArray(error.reasons)) {
    for (const reason of error.reasons) {
      const nested = sourceReadCode(reason, seen)
      if (nested) return nested
    }
  }
  return
}

function configDocumentError(error: unknown, seen = new Set<unknown>()): boolean {
  if (typeof error !== "object" || error === null || seen.has(error)) return false
  seen.add(error)
  if (
    ConfigErrorV1.JsonError.isInstance(error) ||
    ConfigErrorV1.InvalidError.isInstance(error) ||
    ConfigErrorV1.FrontmatterError.isInstance(error)
  ) {
    return true
  }
  if (
    "name" in error &&
    (error.name === "ConfigJsonError" || error.name === "ConfigInvalidError" || error.name === "ConfigFrontmatterError")
  ) {
    return true
  }
  if ("cause" in error && configDocumentError(error.cause, seen)) return true
  if ("defect" in error && configDocumentError(error.defect, seen)) return true
  if ("error" in error && configDocumentError(error.error, seen)) return true
  if ("reason" in error && configDocumentError(error.reason, seen)) return true
  if ("reasons" in error && Array.isArray(error.reasons)) {
    return error.reasons.some((reason) => configDocumentError(reason, seen))
  }
  return false
}

function deletedEnvOnly(directory: string) {
  if (process.env.OPENCODE_CONFIG_CONTENT !== undefined || process.env.OPENCODE_CONFIG !== undefined) return false
  return ["opencode.json", "opencode.jsonc", ".opencode/opencode.json", ".opencode/opencode.jsonc"].every(
    (file) => !existsSync(path.join(directory, file)),
  )
}

function instanceLoadError(error: McpEditError) {
  if (error.code === "MCP_SOURCE_MISSING" || error.code === "MCP_ENTRY_MISSING")
    return new McpConfigNotFoundError({ code: error.code, ref: error.ref })
  if (error.code === "MCP_SOURCE_READ_ONLY") return new McpConfigForbiddenError({ code: error.code, ref: error.ref })
  if (error.code === "MCP_DOCUMENT_INVALID") return new McpConfigInvalidError({ code: error.code, ref: error.ref })
  if (error.code === "MCP_SOURCE_READ_FAILED" || error.code === "MCP_LOCK_TIMEOUT" || error.code === "MCP_WRITE_FAILED")
    return new McpConfigUnavailableError({ code: error.code, ref: error.ref })
  return new McpConfigConflictError({ code: error.code, ref: error.ref })
}

function respondInstanceLoad(error: McpEditError) {
  const status =
    error.code === "MCP_SOURCE_MISSING" || error.code === "MCP_ENTRY_MISSING"
      ? 404
      : error.code === "MCP_SOURCE_READ_ONLY"
        ? 403
        : error.code === "MCP_DOCUMENT_INVALID"
          ? 400
          : error.code === "MCP_SOURCE_READ_FAILED" ||
              error.code === "MCP_LOCK_TIMEOUT" ||
              error.code === "MCP_WRITE_FAILED"
            ? 503
            : 409
  // Schema annotations are not instance fields. jsonUnsafe defaults a missing status to 200.
  return HttpServerResponse.jsonUnsafe(instanceLoadError(error), { status })
}

function provideInstanceContext<E>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E>,
  store: InstanceStore.Interface,
): Effect.Effect<HttpServerResponse.HttpServerResponse, E, WorkspaceRouteContext> {
  return Effect.gen(function* () {
    const route = yield* WorkspaceRouteContext
    // Instance load runs before the handler. Convert a dying typed config error here so the public body
    // stays on the declared contract and never serializes the source document.
    const directory = decode(route.directory)
    const loaded = yield* store.load({ directory }).pipe(Effect.exit)
    if (loaded._tag === "Failure") {
      const found = Cause.findErrorOption(loaded.cause)
      const failed = found._tag === "Some" ? found.value : Cause.squash(loaded.cause)
      if (sourceReadCode(failed) || sourceReadCode(loaded.cause)) {
        return respondInstanceLoad(new McpEditError({ code: "MCP_SOURCE_READ_FAILED", ref: crypto.randomUUID() }))
      }
      if (configDocumentError(failed) || configDocumentError(loaded.cause)) {
        return respondInstanceLoad(new McpEditError({ code: "MCP_DOCUMENT_INVALID", ref: crypto.randomUUID() }))
      }
      if (typeof failed === "object" && failed !== null && "_tag" in failed && failed._tag === "McpEditError") {
        const error = failed as McpEditError
        // The cached boot died on an environment document that has since been deleted.
        if (error.code === "MCP_DOCUMENT_INVALID" && deletedEnvOnly(directory)) {
          const reloaded = yield* store.reload({ directory }).pipe(Effect.exit)
          if (reloaded._tag === "Success") {
            return yield* effect.pipe(
              Effect.provideService(InstanceRef, reloaded.value),
              Effect.provideService(WorkspaceRef, route.workspaceID),
            )
          }
        }
        // Answer here. Dying the mapped error lets the platform middleware replace it with an empty 500.
        return respondInstanceLoad(error)
      }
      return yield* Effect.die(loaded.cause)
    }
    return yield* effect.pipe(
      Effect.provideService(InstanceRef, loaded.value),
      Effect.provideService(WorkspaceRef, route.workspaceID),
    )
  })
}

export const instanceContextLayer = Layer.effect(
  InstanceContextMiddleware,
  Effect.gen(function* () {
    const store = yield* InstanceStore.Service
    return InstanceContextMiddleware.of((effect) => provideInstanceContext(effect, store))
  }),
)

export const configWriteContextLayer = Layer.effect(ConfigWriteContextMiddleware, Effect.gen(function* () {
  const store = yield* InstanceStore.Service
  return ConfigWriteContextMiddleware.of((effect) => provideInstanceContext(effect, store).pipe(
    Effect.provideService(ConfigLoaderWrites, false),
  ))
}))

export class ProjectConfigWriteContextMiddleware extends HttpApiMiddleware.Service<ProjectConfigWriteContextMiddleware, {
  requires: WorkspaceRouteContext
}>()("@opencode/ProjectConfigWriteContext") {}

export const projectConfigWriteContextLayer = Layer.effect(ProjectConfigWriteContextMiddleware, Effect.gen(function* () {
  const store = yield* InstanceStore.Service
  const config = yield* Config.Service
  return ProjectConfigWriteContextMiddleware.of((effect) => Effect.gen(function* () {
    const checked = yield* config.preflight().pipe(Effect.exit)
    if (checked._tag === "Failure") return yield* respondProjectLoad(checked.cause)
    const route = yield* WorkspaceRouteContext
    const ctx = yield* InstanceRef
    if (ctx) yield* ProjectConfig.signal(ctx, "bootstrap")
    const loaded = yield* store.load({ directory: decode(route.directory) }).pipe(Effect.provideService(ConfigLoaderWrites, false), Effect.exit)
    if (loaded._tag === "Failure") return yield* respondProjectLoad(loaded.cause)
    return yield* effect.pipe(Effect.provideService(InstanceRef, loaded.value), Effect.provideService(WorkspaceRef, route.workspaceID))
  }))
}))
function respondProjectLoad<E>(cause: Cause.Cause<E>): Effect.Effect<HttpServerResponse.HttpServerResponse> {
  if (Cause.hasInterrupts(cause)) return Effect.failCause(cause as Cause.Cause<never>)
  const error = Cause.squash(cause)
  const mapped = error instanceof ConfigWrite.Error ? error
    : sourceReadCode(cause) ? ConfigWrite.fail("CONFIG_SOURCE_READ_FAILED")
    : configDocumentError(cause) ? ConfigWrite.fail("CONFIG_DOCUMENT_INVALID")
    : undefined
  if (!mapped) return Effect.failCause(cause as Cause.Cause<never>)
  return Effect.succeed(HttpServerResponse.jsonUnsafe(projectConfigHttpError(mapped), { status: mapped.status }))
}
