import { RelayGate } from "@opencode-ai/core/relay-gate"
import { ScheduledTaskStore } from "@opencode-ai/core/scheduled-task"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ServiceUnavailableError } from "@opencode-ai/protocol/errors"
import { ScheduledTaskNotFoundError } from "@opencode-ai/protocol/groups/scheduled-task"
import { Api } from "../api"

export const ScheduledTaskHandler = HttpApiBuilder.group(Api, "server.scheduledTask", (handlers) =>
  Effect.gen(function* () {
    const store = yield* ScheduledTaskStore.Service
    const gates = yield* RelayGate.Service
    const unavailable = new ServiceUnavailableError({
      message: "Scheduled tasks are disabled",
      service: "scheduled_tasks",
    })
    return handlers
      .handle("scheduledTask.list", () => store.list())
      .handle(
        "scheduledTask.create",
        Effect.fn(function* (ctx) {
          if (!gates.scheduledTasks) return yield* unavailable
          return yield* store.create(ctx.payload)
        }),
      )
      .handle("scheduledTask.runs", (ctx) => store.runs(ctx.params.taskID))
      .handle(
        "scheduledTask.run",
        Effect.fn(function* (ctx) {
          if (!gates.scheduledTasks) return yield* unavailable
          return yield* store.runNow(ctx.params.taskID).pipe(
            Effect.catchTag(
              "ScheduledTask.NotFoundError",
              (error) =>
                new ScheduledTaskNotFoundError({
                  taskID: error.taskID,
                  message: `Scheduled task not found: ${error.taskID}`,
                }),
            ),
          )
        }),
      )
      .handle(
        "scheduledTask.enable",
        Effect.fn(function* (ctx) {
          if (!gates.scheduledTasks) return yield* unavailable
          return yield* store.setEnabled(ctx.params.taskID, ctx.payload.enabled).pipe(
            Effect.catchTag(
              "ScheduledTask.NotFoundError",
              (error) =>
                new ScheduledTaskNotFoundError({
                  taskID: error.taskID,
                  message: `Scheduled task not found: ${error.taskID}`,
                }),
            ),
          )
        }),
      )
  }),
)
