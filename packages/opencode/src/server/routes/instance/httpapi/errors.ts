import { Schema } from "effect"

export class InvalidRequestError extends Schema.TaggedErrorClass<InvalidRequestError>()(
  "InvalidRequestError",
  {
    message: Schema.String,
    kind: Schema.optional(Schema.String),
    field: Schema.optional(Schema.String),
  },
  { httpApiStatus: 400 },
) {}

export class UnauthorizedError extends Schema.TaggedErrorClass<UnauthorizedError>()(
  "UnauthorizedError",
  { message: Schema.String },
  { httpApiStatus: 401 },
) {}

export class ForbiddenError extends Schema.TaggedErrorClass<ForbiddenError>()(
  "ForbiddenError",
  { message: Schema.String },
  { httpApiStatus: 403 },
) {}

export class ConflictError extends Schema.TaggedErrorClass<ConflictError>()(
  "ConflictError",
  {
    message: Schema.String,
    resource: Schema.optional(Schema.String),
  },
  { httpApiStatus: 409 },
) {}

export class UpstreamError extends Schema.TaggedErrorClass<UpstreamError>()(
  "UpstreamError",
  {
    message: Schema.String,
    service: Schema.optional(Schema.String),
    status: Schema.optional(Schema.Number),
  },
  { httpApiStatus: 502 },
) {}

export class ServiceUnavailableError extends Schema.TaggedErrorClass<ServiceUnavailableError>()(
  "ServiceUnavailableError",
  {
    message: Schema.String,
    service: Schema.optional(Schema.String),
  },
  { httpApiStatus: 503 },
) {}

export class TimeoutError extends Schema.TaggedErrorClass<TimeoutError>()(
  "TimeoutError",
  {
    message: Schema.String,
    operation: Schema.optional(Schema.String),
  },
  { httpApiStatus: 504 },
) {}

export class UnknownError extends Schema.TaggedErrorClass<UnknownError>()(
  "UnknownError",
  {
    message: Schema.String,
    ref: Schema.optional(Schema.String),
  },
  { httpApiStatus: 500 },
) {}

export class ProviderNotFoundError extends Schema.TaggedErrorClass<ProviderNotFoundError>()(
  "ProviderNotFoundError",
  {
    providerID: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class ModelNotFoundError extends Schema.TaggedErrorClass<ModelNotFoundError>()(
  "ModelNotFoundError",
  {
    providerID: Schema.String,
    modelID: Schema.String,
    suggestions: Schema.Array(Schema.String),
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class SessionNotFoundError extends Schema.TaggedErrorClass<SessionNotFoundError>()(
  "SessionNotFoundError",
  {
    sessionID: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class MessageNotFoundError extends Schema.TaggedErrorClass<MessageNotFoundError>()(
  "MessageNotFoundError",
  {
    sessionID: Schema.String,
    messageID: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class InvalidCursorError extends Schema.TaggedErrorClass<InvalidCursorError>()(
  "InvalidCursorError",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

export class SessionBusyError extends Schema.TaggedErrorClass<SessionBusyError>()(
  "SessionBusyError",
  {
    sessionID: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 409 },
) {}

export class QuestionNotFoundError extends Schema.TaggedErrorClass<QuestionNotFoundError>()(
  "QuestionNotFoundError",
  {
    requestID: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class PermissionNotFoundError extends Schema.TaggedErrorClass<PermissionNotFoundError>()(
  "PermissionNotFoundError",
  {
    requestID: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class McpServerNotFoundError extends Schema.TaggedErrorClass<McpServerNotFoundError>()(
  "McpServerNotFoundError",
  {
    name: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class PtyNotFoundError extends Schema.TaggedErrorClass<PtyNotFoundError>()(
  "PtyNotFoundError",
  {
    ptyID: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class PtyForbiddenError extends Schema.TaggedErrorClass<PtyForbiddenError>()(
  "PtyForbiddenError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 403 },
) {}

const mcpConfigCodes = [
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
] as const

export class McpConfigNotFoundError extends Schema.TaggedErrorClass<McpConfigNotFoundError>()(
  "McpConfigNotFoundError",
  { code: Schema.Literals(["MCP_SOURCE_MISSING", "MCP_ENTRY_MISSING"]), ref: Schema.String },
  { httpApiStatus: 404 },
) {}

export class McpConfigForbiddenError extends Schema.TaggedErrorClass<McpConfigForbiddenError>()(
  "McpConfigForbiddenError",
  { code: Schema.Literals(["MCP_SOURCE_READ_ONLY"]), ref: Schema.String },
  { httpApiStatus: 403 },
) {}

export class McpConfigConflictError extends Schema.TaggedErrorClass<McpConfigConflictError>()(
  "McpConfigConflictError",
  { code: Schema.Literals(["MCP_SOURCE_CHANGED", "MCP_VERSION_CONFLICT", "MCP_SOURCE_ALIAS_UNSUPPORTED"]), ref: Schema.String },
  { httpApiStatus: 409 },
) {}

export class McpConfigInvalidError extends Schema.TaggedErrorClass<McpConfigInvalidError>()(
  "McpConfigInvalidError",
  { code: Schema.Literals(["MCP_DOCUMENT_INVALID"]), ref: Schema.String },
  { httpApiStatus: 400 },
) {}

export class McpConfigUnavailableError extends Schema.TaggedErrorClass<McpConfigUnavailableError>()(
  "McpConfigUnavailableError",
  { code: Schema.Literals(["MCP_SOURCE_READ_FAILED", "MCP_LOCK_TIMEOUT", "MCP_WRITE_FAILED"]), ref: Schema.String },
  { httpApiStatus: 503 },
) {}

export type McpConfigCode = (typeof mcpConfigCodes)[number]

export class ProjectNotFoundError extends Schema.TaggedErrorClass<ProjectNotFoundError>()(
  "ProjectNotFoundError",
  {
    projectID: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class ApiNotFoundError extends Schema.ErrorClass<ApiNotFoundError>("NotFoundError")(
  {
    name: Schema.Literal("NotFoundError"),
    data: Schema.Struct({
      message: Schema.String,
    }),
  },
  { httpApiStatus: 404 },
) {}

export function notFound(message: string) {
  return new ApiNotFoundError({
    name: "NotFoundError",
    data: { message },
  })
}

export class ProjectConfigInvalidError extends Schema.TaggedErrorClass<ProjectConfigInvalidError>()("ProjectConfigInvalidError", {
  code: Schema.Literals(["CONFIG_DOCUMENT_INVALID", "CONFIG_PATCH_INVALID"]), ref: Schema.String,
}, { httpApiStatus: 400 }) {}
export class ProjectConfigForbiddenError extends Schema.TaggedErrorClass<ProjectConfigForbiddenError>()("ProjectConfigForbiddenError", {
  code: Schema.Literals(["CONFIG_PROJECT_DISABLED", "CONFIG_SOURCE_READ_ONLY", "CONFIG_TARGET_OUTSIDE_PROJECT"]), ref: Schema.String,
}, { httpApiStatus: 403 }) {}
export class ProjectConfigConflictError extends Schema.TaggedErrorClass<ProjectConfigConflictError>()("ProjectConfigConflictError", {
  code: Schema.Literals(["CONFIG_SOURCE_CHANGED", "CONFIG_SOURCE_OVERRIDDEN", "CONFIG_PATH_ALIAS_UNSUPPORTED", "CONFIG_TEMPLATE_EDIT_UNSUPPORTED"]), ref: Schema.String,
}, { httpApiStatus: 409 }) {}
export class ProjectConfigUnavailableError extends Schema.TaggedErrorClass<ProjectConfigUnavailableError>()("ProjectConfigUnavailableError", {
  code: Schema.Literals(["CONFIG_SOURCE_READ_FAILED", "CONFIG_LOCK_TIMEOUT", "CONFIG_WRITE_FAILED", "CONFIG_REFRESH_CAPACITY_EXHAUSTED", "CONFIG_COMMIT_UNKNOWN"]), ref: Schema.String,
}, { httpApiStatus: 503 }) {}
