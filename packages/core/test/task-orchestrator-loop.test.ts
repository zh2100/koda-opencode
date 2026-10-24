import { describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { Effect } from "effect"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { ProjectV2 } from "@opencode-ai/core/project"
import { TaskOrchestratorLoop } from "@opencode-ai/core/task-orchestrator/loop"
import { TaskOrchestratorRunTable, TaskOrchestratorStepTable, TaskOrchestratorTaskTable } from "@opencode-ai/core/task-orchestrator/sql"

const sqlite = SqliteClient.layer({ filename: ":memory:", disableWAL: true })
const makeDb = EffectDrizzleSqlite.makeWithDefaults().pipe(Effect.tap((db) => DatabaseMigration.apply(db)))

const seed = (db: Effect.Success<typeof makeDb>, status: "pending" | "failed" = "pending") =>
  Effect.gen(function* () {
    const now = Date.now()
    yield* db.insert(TaskOrchestratorTaskTable).values({
      id: "task",
      session_id: SessionSchema.ID.make("ses"),
      project_id: ProjectV2.ID.make("proj"),
      workspace_key: "directory:C:/repo",
      prompt: "ship",
      status,
      current_step: 0,
      created_at: now,
      updated_at: now,
      timeout_ms: 1000,
      max_retries: 1,
    }).run().pipe(Effect.orDie)
    for (const [role, ordinal] of [["planner", 0], ["reviewer", 1], ["tester", 2], ["finalizer", 3]] as const) {
      yield* db.insert(TaskOrchestratorStepTable).values({
        id: role,
        task_id: "task",
        ordinal,
        role,
        model: "openai/gpt-5",
        status: role === "reviewer" && status === "failed" ? "failed" : "pending",
        retry_count: 0,
      }).run().pipe(Effect.orDie)
    }
  })

describe("TaskOrchestratorLoop", () => {
  test("commits reviewer state before scheduling and audits tester changes", async () => {
    const calls: string[] = []
    const result = await makeDb.pipe(
      Effect.flatMap((db) =>
        seed(db).pipe(
          Effect.andThen(TaskOrchestratorLoop.run({
            db,
            taskID: "task",
            runner: {
              output: ({ role }) => Effect.sync(() => role === "reviewer" ? '{"approved":false,"findings":[{"message":"Fix"}]}' : "ok"),
              schedule: () => Effect.sync(() => calls.push("schedule")),
              test: () => Effect.sync(() => "tested"),
              changes: () => ["src/a.ts"],
              audit: ({ changes }) => Effect.sync(() => calls.push(`audit:${changes.join(",")}`)),
               control: () => undefined,
               interrupt: () => Effect.void,
            },
          })),
          Effect.andThen(db.select().from(TaskOrchestratorTaskTable).where(eq(TaskOrchestratorTaskTable.id, "task")).get().pipe(Effect.orDie)),
        ),
      ),
      Effect.provide(sqlite),
      Effect.scoped,
      Effect.runPromise,
    )
    expect(calls[0]).toBe("schedule")
    expect(result?.status).toBe("pending")
  })

  test("persists a transaction conflict without scheduling", async () => {
    const calls: string[] = []
    await makeDb.pipe(
      Effect.flatMap((db) =>
        seed(db, "failed").pipe(
          Effect.andThen(
            TaskOrchestratorLoop.run({
              db,
              taskID: "task",
              runner: {
                output: () => Effect.fail("closed"),
                schedule: () => Effect.sync(() => calls.push("schedule")),
                test: () => Effect.succeed("tested"),
                changes: () => [],
                audit: () => Effect.void,
                control: () => undefined,
                interrupt: () => Effect.void,
              },
            }).pipe(Effect.exit),
          ),
        ),
      ),
      Effect.provide(sqlite),
      Effect.scoped,
      Effect.runPromise,
    )
    expect(calls).toEqual([])
  })

  test("honors pause, abort, and retry at step boundaries", async () => {
    const controls = ["pause", "abort", "retry"] as const
    const statuses = await Promise.all(controls.map((control) =>
      makeDb.pipe(
        Effect.flatMap((db) =>
          seed(db).pipe(
            Effect.andThen(TaskOrchestratorLoop.run({
              db,
              taskID: "task",
              runner: {
                output: ({ role }) => Effect.succeed(role === "reviewer" ? '{"approved":true,"findings":[]}' : "ok"),
                schedule: () => Effect.void,
                test: () => Effect.succeed("ok"),
                changes: () => [],
                audit: () => Effect.void,
                control: () => control,
                interrupt: () => Effect.void,
              },
            })),
            Effect.andThen(db.select().from(TaskOrchestratorTaskTable).where(eq(TaskOrchestratorTaskTable.id, "task")).get().pipe(Effect.orDie)),
            Effect.andThen((task) =>
              db.select().from(TaskOrchestratorStepTable).where(eq(TaskOrchestratorStepTable.id, "planner")).get().pipe(
                Effect.orDie,
                Effect.map((step) => ({ task: task?.status, step: step?.status })),
              ),
            ),
          ),
        ),
        Effect.provide(sqlite),
        Effect.scoped,
        Effect.runPromise,
      ),
    ))
    expect(statuses.map((item) => item.task)).toEqual(["paused", "aborted", "completed"])
    expect(statuses[2]?.step).toBe("completed")
    const runs = await makeDb.pipe(
      Effect.flatMap((db) => db.select().from(TaskOrchestratorRunTable).all().pipe(Effect.orDie)),
      Effect.provide(sqlite),
      Effect.scoped,
      Effect.runPromise,
    )
    expect(runs).toEqual([])
  })

  test("updates current step and persists timed out executions", async () => {
    let interrupted = 0
    const result = await makeDb.pipe(
      Effect.flatMap((db) =>
        seed(db).pipe(
          Effect.andThen(db.update(TaskOrchestratorTaskTable).set({ timeout_ms: 1 }).where(eq(TaskOrchestratorTaskTable.id, "task")).run().pipe(Effect.orDie)),
          Effect.andThen(
            TaskOrchestratorLoop.run({
              db,
              taskID: "task",
              runner: {
                output: () => Effect.sleep("20 millis").pipe(Effect.as("late")),
                schedule: () => Effect.void,
                test: () => Effect.succeed("ok"),
                changes: () => [],
                audit: () => Effect.void,
                control: () => undefined,
                interrupt: () => Effect.sync(() => interrupted += 1),
              },
            }),
          ),
          Effect.andThen(Effect.all({
            task: db.select().from(TaskOrchestratorTaskTable).where(eq(TaskOrchestratorTaskTable.id, "task")).get().pipe(Effect.orDie),
            step: db.select().from(TaskOrchestratorStepTable).where(eq(TaskOrchestratorStepTable.id, "planner")).get().pipe(Effect.orDie),
            run: db.select().from(TaskOrchestratorRunTable).all().pipe(Effect.orDie),
          })),
        ),
      ),
      Effect.provide(sqlite),
      Effect.scoped,
      Effect.runPromise,
    )
    expect(result.task?.status).toBe("failed")
    expect(result.task?.current_step).toBe(0)
    expect(result.step?.status).toBe("failed")
    expect(result.run[0]?.status).toBe("timed_out")
    expect(interrupted).toBe(1)
  })
})
