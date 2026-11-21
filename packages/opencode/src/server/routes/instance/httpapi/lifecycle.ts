import { McpEditError } from "@/config/mcp-edit"
import { EffectBridge } from "@/effect/bridge"
import type { InstanceContext } from "@/project/instance-context"
import { InstanceStore } from "@/project/instance-store"
import { Cause, Effect } from "effect"
import { HttpEffect, HttpMiddleware, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import {
  McpConfigConflictError,
  McpConfigForbiddenError,
  McpConfigInvalidError,
  McpConfigNotFoundError,
  McpConfigUnavailableError,
} from "./errors"

function sourceReadCode(error: unknown): string | undefined {
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    if (error.code === "EACCES" || error.code === "EPERM" || error.code === "EIO" || error.code === "EBUSY") {
      return error.code
    }
  }
  if (typeof error === "object" && error !== null && "cause" in error) return sourceReadCode(error.cause)
  return
}

function respondMcpLoad(error: McpEditError) {
  const mapped =
    error.code === "MCP_SOURCE_MISSING" || error.code === "MCP_ENTRY_MISSING"
      ? new McpConfigNotFoundError({ code: error.code, ref: error.ref })
      : error.code === "MCP_SOURCE_READ_ONLY"
        ? new McpConfigForbiddenError({ code: error.code, ref: error.ref })
        : error.code === "MCP_DOCUMENT_INVALID"
          ? new McpConfigInvalidError({ code: error.code, ref: error.ref })
          : error.code === "MCP_SOURCE_READ_FAILED" ||
              error.code === "MCP_LOCK_TIMEOUT" ||
              error.code === "MCP_WRITE_FAILED"
            ? new McpConfigUnavailableError({ code: error.code, ref: error.ref })
            : new McpConfigConflictError({ code: error.code, ref: error.ref })
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
  return HttpServerResponse.jsonUnsafe(mapped, { status })
}

type MarkedInstance = {
  ctx: InstanceContext
  store: InstanceStore.Interface
  bridge: EffectBridge.Shape
}

// Disposal is requested by an endpoint handler, but must run from the outer
// server middleware after the response has been produced. The original Request
// object is the stable handoff key between those two phases.
const disposeAfterResponse = new WeakMap<object, MarkedInstance>()

const mark = (ctx: InstanceContext) =>
  Effect.gen(function* () {
    return { ctx, store: yield* InstanceStore.Service, bridge: yield* EffectBridge.make() }
  })

export const markInstanceForDisposal = (ctx: InstanceContext) =>
  Effect.gen(function* () {
    const marked = yield* mark(ctx)
    return yield* HttpEffect.appendPreResponseHandler((request, response) =>
      Effect.sync(() => {
        // The response is sent before disposeMiddleware performs the teardown.
        disposeAfterResponse.set(request.source, marked)
        return response
      }),
    )
  })

export const markInstanceForReload = (ctx: InstanceContext, next: InstanceStore.LoadInput) =>
  Effect.gen(function* () {
    const marked = yield* mark(ctx)
    return yield* HttpEffect.appendPreResponseHandler((_request, response) =>
      Effect.as(
        Effect.uninterruptible(marked.bridge.run(marked.store.reload(next))).pipe(Effect.orDie),
        response,
      ),
    )
  })

export const disposeMiddleware: HttpMiddleware.HttpMiddleware = (effect) =>
  Effect.gen(function* () {
    // Instance bootstrap dies before the handler. Answer that typed config failure here so both the test
    // handler and the listener keep the declared code/ref and never serialize the source document.
    const response = yield* effect.pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          const found = Cause.findErrorOption(cause)
          const failed = found._tag === "Some" ? found.value : undefined
          if (typeof failed === "object" && failed !== null && "_tag" in failed && failed._tag === "McpEditError") {
            return respondMcpLoad(failed as unknown as McpEditError)
          }
          if (sourceReadCode(failed)) {
            return respondMcpLoad(new McpEditError({ code: "MCP_SOURCE_READ_FAILED", ref: crypto.randomUUID() }))
          }
          return yield* Effect.failCause(cause)
        }),
      ),
    )
    const request = yield* HttpServerRequest.HttpServerRequest
    const marked = disposeAfterResponse.get(request.source)
    if (!marked) return response
    disposeAfterResponse.delete(request.source)
    yield* Effect.uninterruptible(marked.bridge.run(marked.store.dispose(marked.ctx))).pipe(
      Effect.catchCause((cause) => Effect.logWarning("instance disposal failed", { cause })),
    )
    return response
  })
