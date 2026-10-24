import { Project } from "@opencode-ai/schema/project"
import { Session } from "@opencode-ai/schema/session"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { InvalidRequestError } from "../errors"
import { LocationQuery, locationQueryOpenApi } from "./location"

const root = "/experimental/orchestrator"

export const OrchestratorTaskStep = Schema.Struct({
  role: Schema.Literals(["planner", "worker", "reviewer", "tester", "finalizer"]),
  status: Schema.Literals(["pending", "running", "needs_revision", "failed", "completed"]),
  startedAt: Schema.optional(Schema.Int),
  finishedAt: Schema.optional(Schema.Int),
}).annotate({ identifier: "OrchestratorTaskStep" })

export const OrchestratorTaskWorker = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  status: Schema.Literals(["pending", "running", "completed", "failed"]),
  startedAt: Schema.optional(Schema.Int),
  finishedAt: Schema.optional(Schema.Int),
  failureReason: Schema.optional(Schema.String),
}).annotate({ identifier: "OrchestratorTaskWorker" })

export const OrchestratorTask = Schema.Struct({
  id: Schema.String,
  sessionID: Session.ID,
  status: Schema.Literals(["pending", "running", "completed", "failed", "paused", "aborted"]),
  currentStep: Schema.Int,
  failureReason: Schema.optional(Schema.String),
  steps: Schema.optional(Schema.Array(OrchestratorTaskStep)),
  workers: Schema.optional(Schema.Array(OrchestratorTaskWorker)),
}).annotate({ identifier: "OrchestratorTask" })

export const OrchestratorModels = Schema.Struct({
  mode: Schema.optional(Schema.Literals(["sequential", "parallel"])),
  planner: Schema.optional(Schema.String),
  worker: Schema.String,
  reviewer: Schema.optional(Schema.String),
  tester: Schema.optional(Schema.String),
  finalizer: Schema.optional(Schema.String),
  fallback: Schema.optional(Schema.String),
  timeoutMs: Schema.optional(Schema.Int),
  maxRetries: Schema.optional(Schema.Int),
}).annotate({ identifier: "OrchestratorModels" })

export const OrchestratorCreatePayload = Schema.Struct({
  sessionID: Session.ID,
  projectID: Project.ID,
  workspaceKey: Schema.String,
  prompt: Schema.String,
  models: OrchestratorModels,
}).annotate({ identifier: "OrchestratorCreatePayload" })

export const OrchestratorControlPayload = Schema.Struct({
  action: Schema.Literals(["pause", "abort", "retry"]),
}).annotate({ identifier: "OrchestratorControlPayload" })

export class OrchestratorTaskNotFoundError extends Schema.TaggedErrorClass<OrchestratorTaskNotFoundError>()(
  "OrchestratorTaskNotFoundError",
  {
    taskID: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export const OrchestratorGroup = HttpApiGroup.make("server.orchestrator")
  .add(
    HttpApiEndpoint.post("orchestrator.create", root, {
      query: LocationQuery,
      payload: OrchestratorCreatePayload,
      success: OrchestratorTask,
      error: InvalidRequestError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.orchestrator.create",
          summary: "Create a collaboration task",
          description: "Create a planner/worker/reviewer/tester/finalizer task and start it in the background.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("orchestrator.get", `${root}/:taskID`, {
      params: { taskID: Schema.String },
      query: LocationQuery,
      success: OrchestratorTask,
      error: OrchestratorTaskNotFoundError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.orchestrator.get",
          summary: "Get a collaboration task",
          description: "Read the current status of a collaboration task.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("orchestrator.control", `${root}/:taskID/control`, {
      params: { taskID: Schema.String },
      query: LocationQuery,
      payload: OrchestratorControlPayload,
      success: HttpApiSchema.NoContent,
      error: OrchestratorTaskNotFoundError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.orchestrator.control",
          summary: "Control a collaboration task",
          description: "Pause, abort, or retry a collaboration task.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "orchestrator",
      description: "Collaboration task orchestration routes.",
    }),
  )
