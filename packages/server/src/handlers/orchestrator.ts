import { TaskOrchestrator } from "@opencode-ai/core/task-orchestrator"
import { InvalidRequestError } from "@opencode-ai/protocol/errors"
import { OrchestratorTaskNotFoundError } from "@opencode-ai/protocol/groups/orchestrator"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"

export const OrchestratorHandler = HttpApiBuilder.group(Api, "server.orchestrator", (handlers) =>
  Effect.gen(function* () {
    const orchestrator = yield* TaskOrchestrator.Service

    return handlers
      .handle(
        "orchestrator.create",
        Effect.fn(function* (ctx) {
          const task = yield* orchestrator
            .create({
              sessionID: ctx.payload.sessionID,
              projectID: ctx.payload.projectID,
              workspaceKey: ctx.payload.workspaceKey,
              prompt: ctx.payload.prompt,
              models: ctx.payload.models,
            })
            .pipe(
              Effect.mapError(
                (error) =>
                  new InvalidRequestError({
                    message: message(error),
                    kind: "_tag" in error ? error._tag : undefined,
                  }),
              ),
            )
          yield* Effect.forkDetach(
            orchestrator
              .run(task.id)
              .pipe(
                Effect.catchCause((cause) => Effect.logError("orchestrator run failed", { taskID: task.id, cause })),
              ),
          )
          return task
        }),
      )
      .handle(
        "orchestrator.get",
        Effect.fn(function* (ctx) {
          const task = yield* orchestrator.get(ctx.params.taskID)
          if (!task) return yield* notFound(ctx.params.taskID)
          return task
        }),
      )
      .handle(
        "orchestrator.control",
        Effect.fn(function* (ctx) {
          const task = yield* orchestrator.get(ctx.params.taskID)
          if (!task) return yield* notFound(ctx.params.taskID)
          yield* orchestrator.control({ taskID: ctx.params.taskID, action: ctx.payload.action })
          return HttpApiSchema.NoContent.make()
        }),
      )
  }),
)

function notFound(taskID: string) {
  return new OrchestratorTaskNotFoundError({ taskID, message: `Orchestrator task not found: ${taskID}` })
}

function message(error: unknown) {
  if (!error || typeof error !== "object") return String(error)
  const tag = "_tag" in error && typeof error._tag === "string" ? error._tag : undefined
  if (tag === "Session.NotFoundError" && "sessionID" in error) return `Session not found: ${String(error.sessionID)}`
  if (tag === "TaskOrchestrator.ProjectMismatchError")
    return `Session project does not match: expected ${String("expected" in error ? error.expected : "")}, actual ${String("actual" in error ? error.actual : "")}`
  if (tag === "TaskOrchestrator.WorkspaceMismatchError")
    return `Session workspace does not match: expected ${String("expected" in error ? error.expected : "")}, actual ${String("actual" in error ? error.actual : "")}`
  if (tag === "TaskOrchestrator.ExecutionUnavailable" && "message" in error) return String(error.message)
  if ("message" in error && typeof error.message === "string") return error.message
  return tag ?? "Unable to create orchestrator task"
}
