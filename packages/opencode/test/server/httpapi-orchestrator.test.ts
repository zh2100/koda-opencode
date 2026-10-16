import { describe, expect } from "bun:test"
import { ProjectV2 } from "@opencode-ai/core/project"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { TaskOrchestrator } from "@opencode-ai/core/task-orchestrator"
import { Effect, Layer } from "effect"
import { createAndRun } from "../../src/server/routes/instance/httpapi/handlers/experimental"
import { pollWithTimeout, testEffect } from "../lib/effect"

const sessionID = SessionSchema.ID.make("ses")
const projectID = ProjectV2.ID.make("proj")
const tasks = new Map<string, TaskOrchestrator.Task>()

const orchestrator = Layer.succeed(
  TaskOrchestrator.Service,
  TaskOrchestrator.Service.of({
    create: (input) =>
      Effect.sync(() => {
        const task = { id: "task", sessionID: input.sessionID, status: "pending" as const, currentStep: 0 }
        tasks.set(task.id, task)
        return task
      }),
    run: (taskID) =>
      Effect.sync(() => {
        const current = tasks.get(taskID)
        if (current) tasks.set(taskID, { ...current, status: "running" })
      }),
    get: (taskID) => Effect.sync(() => tasks.get(taskID)),
    control: ({ taskID, action }) =>
      Effect.sync(() => {
        const current = tasks.get(taskID)
        if (!current) return
        tasks.set(taskID, {
          ...current,
          status: action === "abort" ? "aborted" : action === "pause" ? "paused" : "pending",
        })
      }),
  }),
)

const it = testEffect(orchestrator)

describe("orchestrator HttpApi", () => {
  it.live("starts execution after create and accepts control", () =>
    Effect.gen(function* () {
      tasks.clear()
      const created = yield* createAndRun({
        sessionID,
        projectID,
        workspaceKey: "directory:c:/repo",
        prompt: "ship",
        models: { worker: "openai/gpt-5" },
      })
      expect(created.status).toBe("pending")

      const orchestrator = yield* TaskOrchestrator.Service
      const started = yield* pollWithTimeout(
        Effect.gen(function* () {
          const current = yield* orchestrator.get(created.id)
          return current?.status === "running" ? created.id : undefined
        }),
        "orchestrator run did not start",
      )
      expect(started).toBe(created.id)

      yield* orchestrator.control({ taskID: created.id, action: "pause" })
      expect((yield* orchestrator.get(created.id))?.status).toBe("paused")

      yield* orchestrator.control({ taskID: created.id, action: "abort" })
      expect((yield* orchestrator.get(created.id))?.status).toBe("aborted")

      yield* orchestrator.control({ taskID: created.id, action: "retry" })
      expect((yield* orchestrator.get(created.id))?.status).toBe("pending")
    }),
  )
})
