import { describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
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

describe("TaskOrchestrator service", () => {
  test("stores pause, abort, and retry controls durably", async () => {
    const controls = ["pause", "abort", "retry"] as const
    const statuses = await Promise.all(controls.map(async (action) => {
      const effect = makeDb.pipe(
        Effect.flatMap((db) => Effect.gen(function* () {
        const now = Date.now()
        yield* db.insert(TaskOrchestratorTaskTable).values({
          id: action,
          session_id: SessionSchema.ID.make("ses"),
          project_id: ProjectV2.ID.make("proj"),
          workspace_key: "directory:C:/repo",
          prompt: "ship",
          status: "running",
          current_step: 0,
          created_at: now,
          updated_at: now,
          timeout_ms: 1000,
          max_retries: 1,
        }).run().pipe(Effect.orDie)
        yield* db.insert(TaskOrchestratorStepTable).values({
          id: `${action}:planner`,
          task_id: action,
          ordinal: 0,
          role: "planner",
          model: "openai/gpt-5",
          status: "pending",
          retry_count: 0,
        }).run().pipe(Effect.orDie)
        yield* TaskOrchestrator.Service.use((service) => service.control({ taskID: action, action }))
        return yield* db.select().from(TaskOrchestratorTaskTable).where(eq(TaskOrchestratorTaskTable.id, action)).get().pipe(Effect.orDie)
      }).pipe(Effect.provide(TaskOrchestrator.layer.pipe(Layer.provide(Layer.mergeAll(
          Layer.succeed(Database.Service, { db }),
          Layer.succeed(SessionV2.Service, { get: () => Effect.die("unused"), interrupt: () => Effect.void } as never),
          WorkspaceOwnership.layer,
          Layer.succeed(TaskOrchestratorWorkerSchedulerService.Service, { schedule: () => Effect.void } as never),
          Layer.succeed(TesterSessionBridge.Service, { use: () => Effect.void } as never),
        ))))),
        ),
        Effect.provide(sqlite),
        Effect.scoped,
      )
      return effect.pipe(Effect.runPromise)
    }))
    expect(statuses.map((item) => item?.status)).toEqual(["paused", "aborted", "pending"])
  })
})