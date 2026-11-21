import { McpEditError } from "@/config/mcp-edit"

import { NamedError } from "@opencode-ai/core/util/error"
import { ConfigErrorV1 } from "@opencode-ai/core/v1/config/error"
import { existsSync } from "fs"
import path from "path"
import { Cause, Effect } from "effect"
import { HttpRouter, HttpServerError, HttpServerRequest, HttpServerRespondable, HttpServerResponse } from "effect/unstable/http"
import {
  McpConfigConflictError,
  McpConfigForbiddenError,
  McpConfigInvalidError,
  McpConfigNotFoundError,
  McpConfigUnavailableError,
} from "../errors"

function deletedEnvOnly(directory: string) {
  if (process.env.OPENCODE_CONFIG_CONTENT !== undefined || process.env.OPENCODE_CONFIG !== undefined) return false
  if (directory.length === 0) return false
  return ["opencode.json", "opencode.jsonc", ".opencode/opencode.json", ".opencode/opencode.jsonc"].every(
    (file) => !existsSync(path.join(directory, file)),
  )
}

function nodeCode(error: unknown, seen = new Set<unknown>()): string | undefined {
  if (typeof error !== "object" || error === null || seen.has(error)) return
  seen.add(error)
  if ("code" in error && typeof error.code === "string") return error.code
  if ("cause" in error) {
    const nested = nodeCode(error.cause, seen)
    if (nested) return nested
  }
  if ("defect" in error) {
    const nested = nodeCode(error.defect, seen)
    if (nested) return nested
  }
  if ("reasons" in error && Array.isArray(error.reasons)) {
    for (const reason of error.reasons) {
      const nested = nodeCode(reason, seen)
      if (nested) return nested
    }
  }
  return
}

function isSourceReadFailure(error: unknown) {
  const code = nodeCode(error)
  return code === "EACCES" || code === "EPERM" || code === "EIO" || code === "EBUSY"
}

function respondConfigLoad(error: McpEditError) {
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
  // Schema annotations are not instance fields. jsonUnsafe defaults a missing status to 200.
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

// Keep typed HttpApi failures on their declared error path; this boundary only replaces defect-only empty 500s.
export const errorLayer = HttpRouter.middleware<{ handles: unknown }>()((effect) =>
  effect.pipe(
    Effect.catchCause((cause) => {
      const defect = cause.reasons.filter(Cause.isDieReason).find((reason) => {
        if (HttpServerResponse.isHttpServerResponse(reason.defect)) return false
        if (HttpServerError.isHttpServerError(reason.defect)) return false
        if (HttpServerRespondable.isRespondable(reason.defect)) return false
        return true
      })
      if (!defect) return Effect.failCause(cause)

      const error = defect.defect
      // Config parse defects carry the source document in their message. Answer with the declared code/ref only.
      return Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const mcpSource = /^\/config\/mcp\/[^/]+\/?$/.test(new URL(request.url, "http://localhost").pathname)
        if (!mcpSource && ConfigErrorV1.InvalidError.isInstance(error)) {
          return HttpServerResponse.jsonUnsafe(error.toObject(), { status: 400 })
        }
        const directory = request.headers["x-opencode-directory"] ?? ""
        // A cached boot can still die on an environment document deleted before this request.
        if (
          typeof error === "object" &&
          error !== null &&
          "_tag" in error &&
          error._tag === "McpEditError" &&
          (error as McpEditError).code === "MCP_SOURCE_READ_FAILED"
        ) {
          return respondConfigLoad(error as McpEditError)
        }
        if (mcpSource && request.method === "GET" && deletedEnvOnly(directory)) {
          return HttpServerResponse.jsonUnsafe(null, { status: 200 })
        }
        if (typeof error === "object" && error !== null && "_tag" in error && error._tag === "McpEditError") {
          return respondConfigLoad(error as McpEditError)
        }
        // A denied read is wrapped as a parse error. The node code can sit on the defect or its cause.
        if (
          isSourceReadFailure(error) ||
          isSourceReadFailure(defect) ||
          isSourceReadFailure(cause) ||
          (typeof error === "object" &&
            error !== null &&
            "name" in error &&
            error.name === "FileSystemError" &&
            "reason" in error &&
            typeof error.reason === "object" &&
            error.reason !== null &&
            "_tag" in error.reason &&
            error.reason._tag === "PermissionDenied")
        ) {
          return respondConfigLoad(new McpEditError({ code: "MCP_SOURCE_READ_FAILED", ref: crypto.randomUUID() }))
        }
        if (
          ConfigErrorV1.JsonError.isInstance(error) ||
          ConfigErrorV1.InvalidError.isInstance(error) ||
          ConfigErrorV1.FrontmatterError.isInstance(error)
        ) {
          return respondConfigLoad(new McpEditError({ code: "MCP_DOCUMENT_INVALID", ref: crypto.randomUUID() }))
        }
        if (ConfigErrorV1.DirectoryTypoError.isInstance(error)) {
          return HttpServerResponse.jsonUnsafe({ name: error.name }, { status: 400 })
        }
        const ref = `err_${crypto.randomUUID().slice(0, 8)}`
        yield* Effect.logError("failed", { ref, error, cause: Cause.pretty(cause) })
        return HttpServerResponse.jsonUnsafe(
          new NamedError.Unknown({
            message: "Unexpected server error. Check server logs for details.",
            ref,
          }).toObject(),
          { status: 500 },
        )
      })
    }),
  ),
).layer
