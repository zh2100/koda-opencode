import { Schema } from "effect"

export class McpEditError extends Schema.TaggedErrorClass<McpEditError>()("McpEditError", {
  code: Schema.Literals([
    "MCP_SOURCE_MISSING",
    "MCP_SOURCE_READ_ONLY",
    "MCP_SOURCE_CHANGED",
    "MCP_SOURCE_ALIAS_UNSUPPORTED",
    "MCP_VERSION_CONFLICT",
    "MCP_ENTRY_MISSING",
    "MCP_DOCUMENT_INVALID",
    "MCP_SOURCE_READ_FAILED",
    "MCP_LOCK_TIMEOUT",
    "MCP_WRITE_FAILED",
  ]),
  ref: Schema.String,
}) {
  get status() {
    if (this.code === "MCP_SOURCE_MISSING" || this.code === "MCP_ENTRY_MISSING") return 404
    if (this.code === "MCP_SOURCE_READ_ONLY") return 403
    if (this.code === "MCP_DOCUMENT_INVALID") return 400
    if (this.code === "MCP_SOURCE_READ_FAILED" || this.code === "MCP_LOCK_TIMEOUT" || this.code === "MCP_WRITE_FAILED")
      return 503
    return 409
  }
}
