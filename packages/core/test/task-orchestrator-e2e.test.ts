import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { Location } from "@opencode-ai/core/location"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectV2 } from "@opencode-ai/core/project"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { TaskOrchestrator } from "@opencode-ai/core/task-orchestrator"
import { TaskOrchestratorStepTable, TaskOrchestratorTaskTable } from "@opencode-ai/core/task-orchestrator/sql"
import { TesterSessionBridge } from "@opencode-ai/core/tester-session-bridge"
import { WorkspaceOwnership } from "@opencode-ai/core/workspace-ownership"
import { TaskOrchestratorWorkerSchedulerService } from "@opencode-ai/core/task-orchestrator/worker-scheduler-service"

const sqlite = SqliteClient.layer({ filename: ":memory:", disableWAL: true })
const makeDb = EffectDrizzleSqlite.makeWithDefaults().pipe(Effect.tap((db) => DatabaseMigration.apply(db)))

describe("TaskOrchestrator end to end", () => {
  test("creates, switches models, and completes", async () => {
    const calls: string[] = []
    const prompts: Array<{ sessionID: string; text: string }> = []
    const session = SessionSchema.ID.make("ses")
    const info = {
      id: session,
      projectID: ProjectV2.ID.make("proj"),
      location: { directory: "C:/repo" } as Location.Ref,
    }
    const result = await Effect.gen(function* () {
      const db = yield* makeDb
      const service = yield* TaskOrchestrator.Service
      const created = yield* service.create({
        sessionID: session,
        projectID: info.projectID,
        workspaceKey: "directory:c:/repo",
        prompt: "ship",
        models: { worker: "openai/gpt-5", reviewer: "openai/review", tester: "openai/test" },
      })
      yield* service.run(created.id)
      return {
        task: yield* db.select().from(TaskOrchestratorTaskTable).all().pipe(Effect.orDie),
        steps: yield* db.select().from(TaskOrchestratorStepTable).all().pipe(Effect.orDie),
      }
    }).pipe(
      Effect.provide(TaskOrchestrator.layer),
      Effect.provide(Layer.mergeAll(
        Layer.effect(Database.Service, makeDb.pipe(Effect.map((db) => ({ db })))),
        Layer.succeed(SessionV2.Service, {
          get: (id: SessionSchema.ID) => Effect.succeed(id === session ? info : { ...info, id, location: { directory: "C:/isolated" } }),
          create: () => Effect.sync(() => {
            calls.push("private-session")
            return { ...info, id: SessionSchema.ID.make("ses_private") }
          }),
          interrupt: () => Effect.void,
          switchAgent: ({ sessionID, agent }: { sessionID: SessionSchema.ID; agent: string }) => Effect.sync(() => calls.push(`agent:${sessionID}:${agent}`)),
          switchModel: ({ sessionID, model }: { sessionID: SessionSchema.ID; model: ModelV2.Ref }) => Effect.sync(() => calls.push(`model:${sessionID}:${model.providerID}/${model.id}`)),
           prompt: ({ sessionID, prompt }: { sessionID: SessionSchema.ID; prompt: { text: string } }) => Effect.sync(() => {
             prompts.push({ sessionID, text: prompt.text })
             return { id: "prompt" }
           }),
           resume: () => Effect.void,
           active: Effect.succeed(new Set()),
           context: () => Effect.succeed([{ type: "assistant", content: [{ type: "text", id: "text", text: '{"approved":true,"findings":[]}' }] }]),
        } as never),
        WorkspaceOwnership.layer,
        Layer.succeed(TaskOrchestratorWorkerSchedulerService.Service, { schedule: () => Effect.sync(() => calls.push("schedule")) } as never),
        Layer.succeed(TesterSessionBridge.Service, {
          use: ({ run }: { run: (id: SessionSchema.ID) => Effect.Effect<unknown> }) => run(SessionSchema.ID.make("ses_tester")),
        } as never),
      )),
      Effect.provide(sqlite),
      Effect.scoped,
      Effect.runPromise,
    )
    expect(result.steps.map((item) => item.status)).toEqual(["completed", "completed", "completed", "completed", "completed"])
    expect(result.task[0]?.status).toBe("completed")
    expect(calls).toContain("model:ses_private:openai/gpt-5")
    expect(calls).toContain("model:ses_private:openai/review")
    expect(calls.filter((item) => item === "private-session")).toHaveLength(1)
    expect(prompts.filter((item) => item.sessionID === session).map((item) => item.text)).toHaveLength(1)
    expect(prompts.find((item) => item.sessionID === session)?.text).toContain("planner:")
    expect(prompts.find((item) => item.sessionID === session)?.text).toContain("worker:")
    expect(calls).not.toContain("schedule")
  })
})
