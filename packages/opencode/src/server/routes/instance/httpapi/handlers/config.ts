import { projectConfigHttpError } from "../config-write-error"
import { ProjectConfig } from "@/config/project-write"
import { InstanceRef } from "@/effect/instance-ref"
import { Config } from "@/config/config"
import { McpEditError } from "@/config/mcp-edit"
import { Provider } from "@/provider/provider"
import * as InstanceState from "@/effect/instance-state"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import {
  McpConfigConflictError,
  McpConfigForbiddenError,
  McpConfigInvalidError,
  McpConfigNotFoundError,
  McpConfigUnavailableError,
} from "../errors"

const mcpHttpError = (error: McpEditError) => {
  if (error.code === "MCP_SOURCE_MISSING" || error.code === "MCP_ENTRY_MISSING")
    return new McpConfigNotFoundError({ code: error.code, ref: error.ref })
  if (error.code === "MCP_SOURCE_READ_ONLY") return new McpConfigForbiddenError({ code: error.code, ref: error.ref })
  if (error.code === "MCP_DOCUMENT_INVALID") return new McpConfigInvalidError({ code: error.code, ref: error.ref })
  if (error.code === "MCP_SOURCE_READ_FAILED" || error.code === "MCP_LOCK_TIMEOUT" || error.code === "MCP_WRITE_FAILED")
    return new McpConfigUnavailableError({ code: error.code, ref: error.ref })
  return new McpConfigConflictError({ code: error.code, ref: error.ref })
}

export const configHandlers = HttpApiBuilder.group(InstanceHttpApi, "config", (handlers) =>
  Effect.gen(function* () {
    const providerSvc = yield* Provider.Service
    const configSvc = yield* Config.Service

    const get = Effect.fn("ConfigHttpApi.get")(function* () {
      return yield* configSvc.get()
    })

    const update = Effect.fn("ConfigHttpApi.update")(function* (ctx) {
      const instance = yield* InstanceRef
      if (instance) yield* ProjectConfig.signal(instance, "handler")
      yield* configSvc.update(ctx.payload).pipe(Effect.mapError(projectConfigHttpError))
      return ctx.payload
    })

    const providers = Effect.fn("ConfigHttpApi.providers")(function* () {
      const providers = yield* providerSvc.list()
      return {
        providers: Object.values(providers).map(Provider.toPublicInfo),
        default: Provider.defaultModelIDs(providers),
      }
    })

    return handlers
      .handle("mcpSource", (ctx) =>
        configSvc.mcpSource(ctx.params.name).pipe(Effect.mapError(mcpHttpError)),
      )
      .handle("updateMcp", (ctx) =>
        Effect.gen(function* () {
          yield* configSvc
            .updateMcp({ name: ctx.params.name, ...ctx.payload })
            .pipe(Effect.mapError(mcpHttpError))
          return true
        }),
      )
      .handle("get", get)
      .handle("update", update)
      .handle("providers", providers)
  }),
)
