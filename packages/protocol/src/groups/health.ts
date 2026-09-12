import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"

export const HealthGroup = HttpApiGroup.make("server.health").add(
  HttpApiEndpoint.get("health.get", "/api/health", {
    success: Schema.Struct({
      healthy: Schema.Literal(true),
      gates: Schema.optional(
        Schema.Struct({
          relayCoreUi: Schema.Boolean,
          relayLayout: Schema.Boolean,
          relaySkills: Schema.Boolean,
          relayMcp: Schema.Boolean,
          scheduledTasks: Schema.Boolean,
        }),
      ),
    }),
  }).annotateMerge(
    OpenApi.annotations({
      identifier: "v2.health.get",
      summary: "Check server health",
      description: "Check whether the API server is ready to accept requests.",
    }),
  ),
)
