import { Location } from "@opencode-ai/schema/location"
import { Model } from "@opencode-ai/schema/model"
import { Project } from "@opencode-ai/schema/project"
import { Prompt } from "@opencode-ai/schema/prompt"
import { Relay } from "@opencode-ai/schema/relay"
import { ScheduledTask } from "@opencode-ai/schema/scheduled-task"
import { DateTimeUtcFromMillis, optional } from "@opencode-ai/schema/schema"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { ServiceUnavailableError } from "../errors"

export class ScheduledTaskNotFoundError extends Schema.TaggedErrorClass<ScheduledTaskNotFoundError>()(
  "ScheduledTaskNotFoundError",
  {
    taskID: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export const CreatePayload = Schema.Struct({
  name: Schema.String,
  projectID: Project.ID,
  location: Location.Ref,
  prompt: Prompt,
  schedule: ScheduledTask.ScheduleKind,
  timezone: Schema.String,
  runAt: DateTimeUtcFromMillis,
  model: Model.Ref,
  effort: Relay.Effort.pipe(optional),
  approvalMode: ScheduledTask.ApprovalMode,
  enabled: Schema.Boolean,
}).annotate({ identifier: "ScheduledTask.CreatePayload" })

export const ScheduledTaskGroup = HttpApiGroup.make("server.scheduledTask")
  .add(
    HttpApiEndpoint.get("scheduledTask.list", "/api/scheduled-task", {
      success: Schema.Array(ScheduledTask.Info),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.scheduledTask.list",
        summary: "List scheduled tasks",
        description: "List saved scheduled tasks. Empty when the scheduled_tasks gate is closed.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("scheduledTask.create", "/api/scheduled-task", {
      payload: CreatePayload,
      success: ScheduledTask.Info,
      error: [ServiceUnavailableError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.scheduledTask.create",
        summary: "Create a scheduled task",
        description: "Create a once or daily scheduled prompt. Unavailable when the scheduled_tasks gate is closed.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("scheduledTask.runs", "/api/scheduled-task/:taskID/run", {
      params: { taskID: ScheduledTask.ID },
      success: Schema.Array(ScheduledTask.Run),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.scheduledTask.runs",
        summary: "List scheduled task runs",
        description: "List runs for one scheduled task. Empty when the scheduled_tasks gate is closed.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("scheduledTask.run", "/api/scheduled-task/:taskID/run", {
      params: { taskID: ScheduledTask.ID },
      success: ScheduledTask.Run,
      error: [ScheduledTaskNotFoundError, ServiceUnavailableError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.scheduledTask.run",
        summary: "Run a scheduled task now",
        description: "Start one manual run. Unavailable when the scheduled_tasks gate is closed.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("scheduledTask.enable", "/api/scheduled-task/:taskID/enable", {
      params: { taskID: ScheduledTask.ID },
      payload: Schema.Struct({ enabled: Schema.Boolean }),
      success: ScheduledTask.Info,
      error: [ScheduledTaskNotFoundError, ServiceUnavailableError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.scheduledTask.enable",
        summary: "Enable or pause a scheduled task",
        description: "Manually resume a paused task after key, model, or project repair.",
      }),
    ),
  )
