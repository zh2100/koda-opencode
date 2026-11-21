import { Schema } from "effect"
import { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"
import { Config } from "@/config/config"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Provider } from "@/provider/provider"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import {
  ProjectConfigInvalidError,
  ProjectConfigForbiddenError,
  ProjectConfigConflictError,
  ProjectConfigUnavailableError,
  McpConfigConflictError,
  McpConfigForbiddenError,
  McpConfigInvalidError,
  McpConfigNotFoundError,
  McpConfigUnavailableError,
} from "../errors"
import { Authorization } from "../middleware/authorization"
import { ConfigContextMiddleware, ConfigWriteContextMiddleware, ProjectConfigWriteContextMiddleware, InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/config"

export const ConfigApi = HttpApi.make("config")
  .add(
    HttpApiGroup.make("config")
      .add(
        HttpApiEndpoint.get("get", root, {
          query: WorkspaceRoutingQuery,
          success: described(ConfigV1.Info, "Get config info"),
        }).middleware(InstanceContextMiddleware).annotateMerge(
          OpenApi.annotations({
            identifier: "config.get",
            summary: "Get configuration",
            description: "Retrieve the current OpenCode configuration settings and preferences.",
          }),
        ),
        HttpApiEndpoint.patch("update", root, {
          query: WorkspaceRoutingQuery,
          payload: ConfigV1.Info,
          success: described(ConfigV1.Info, "Successfully updated config"),
          error: [HttpApiError.BadRequest, ProjectConfigInvalidError, ProjectConfigForbiddenError, ProjectConfigConflictError, ProjectConfigUnavailableError],
        }).middleware(ProjectConfigWriteContextMiddleware).annotateMerge(
          OpenApi.annotations({
            identifier: "config.update",
            summary: "Update configuration",
            description: "Update OpenCode configuration settings and preferences.",
          }),
        ),
        HttpApiEndpoint.get("mcpSource", `${root}/mcp/:name`, {
          params: { name: Schema.String },
          query: WorkspaceRoutingQuery,
          success: Schema.UndefinedOr(
            Schema.Struct({
              source: Schema.String,
              version: Schema.String,
              writable: Schema.Boolean,
              config: Schema.Union([ConfigMCPV1.Info, Schema.Struct({ enabled: Schema.Boolean })]),
            }),
          ),
          error: [
            McpConfigNotFoundError,
            McpConfigForbiddenError,
            McpConfigConflictError,
            McpConfigInvalidError,
            McpConfigUnavailableError,
          ],
        }).annotateMerge(
          OpenApi.annotations({ identifier: "config.mcpSource", summary: "Read MCP configuration source" }),
        ),
        HttpApiEndpoint.patch("updateMcp", `${root}/mcp/:name`, {
          params: { name: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: Schema.Struct({
            source: Schema.String,
            version: Schema.String,
            patch: Schema.Struct({
              type: Schema.optional(Schema.Literals(["local", "remote"])),
              command: Schema.optional(Schema.Array(Schema.String)),
              url: Schema.optional(Schema.String),
            }),
          }),
          success: Schema.Boolean,
          error: [
            McpConfigNotFoundError,
            McpConfigForbiddenError,
            McpConfigConflictError,
            McpConfigInvalidError,
            McpConfigUnavailableError,
          ],
        }).middleware(ConfigWriteContextMiddleware).annotateMerge(
          OpenApi.annotations({ identifier: "config.updateMcp", summary: "Update MCP at its configuration source" }),
        ),
        HttpApiEndpoint.get("providers", `${root}/providers`, {
          query: WorkspaceRoutingQuery,
          success: described(Provider.ConfigProvidersResult, "List of providers"),
        }).middleware(InstanceContextMiddleware).annotateMerge(
          OpenApi.annotations({
            identifier: "config.providers",
            summary: "List config providers",
            description: "Get a list of all configured AI providers and their default models.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "config",
          description: "Experimental HttpApi config routes.",
        }),
      )
      .middleware(ConfigContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
