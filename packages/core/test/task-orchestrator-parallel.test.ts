import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { Cause, Effect } from "effect"
import { AuthenticationReason, LLMError, TransportReason } from "@opencode-ai/llm"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { ProjectV2 } from "@opencode-ai/core/project"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { TaskOrchestratorParallel } from "@opencode-ai/core/task-orchestrator/parallel"
import {
  TaskOrchestratorMessageTable,
  TaskOrchestratorRunTable,
  TaskOrchestratorStepTable,
  TaskOrchestratorTaskTable,
} from "@opencode-ai/core/task-orchestrator/sql"

const sqlite = SqliteClient.layer({ filename: ":memory:", disableWAL: true })
const makeDb = EffectDrizzleSqlite.makeWithDefaults().pipe(Effect.tap((db) => DatabaseMigration.apply(db)))

const roles = ["planner", "worker", "reviewer", "tester", "finalizer"] as const

const seed = (db: Effect.Success<typeof makeDb>) =>
  Effect.gen(function* () {
    const now = Date.now()
    yield* db
      .insert(TaskOrchestratorTaskTable)
      .values({
        id: "task",
        session_id: SessionSchema.ID.make("ses"),
        project_id: ProjectV2.ID.make("proj"),
        workspace_key: "directory:C:/repo",
        prompt: "ship",
        status: "pending",
        mode: "parallel",
        current_step: 0,
        created_at: now,
        updated_at: now,
        timeout_ms: 1000,
        max_retries: 1,
      })
      .run()
      .pipe(Effect.orDie)
    for (const [ordinal, role] of roles.entries()) {
      yield* db
        .insert(TaskOrchestratorStepTable)
        .values({
          id: role,
          task_id: "task",
          ordinal,
          role,
          model: "openai/gpt-5",
          status: "pending",
          retry_count: 0,
        })
        .run()
        .pipe(Effect.orDie)
    }
  })

const plan = JSON.stringify({
  summary: "ship",
  tasks: [
    { id: "a", title: "A", instruction: "Implement A", files: ["a.ts"] },
    { id: "b", title: "B", instruction: "Implement B", files: ["b.ts"] },
  ],
})

describe("TaskOrchestratorParallel", () => {
  test("runs independent workers and reviewers concurrently through a shared message log", async () => {
    let active = 0
    let maxActive = 0
    const merged: string[] = []
    const notices: string[] = []
    const result = await makeDb.pipe(
      Effect.flatMap((db) =>
        seed(db).pipe(
          Effect.andThen(
            TaskOrchestratorParallel.run({
              db,
              taskID: "task",
              runner: {
                plan: () => Effect.succeed(plan),
                discuss: () => Effect.succeed("critique"),
                work: ({ name }) =>
                  Effect.gen(function* () {
                    active += 1
                    maxActive = Math.max(maxActive, active)
                    yield* Effect.sleep("20 millis")
                    active -= 1
                    return { output: `done ${name}`, patch: `patch ${name}` }
                  }),
                review: () => Effect.succeed('{"approved":true,"findings":[]}'),
                test: () => Effect.succeed("ok"),
                finalize: () => Effect.succeed("final"),
                merge: (patch) => Effect.sync(() => merged.push(patch)),
                notice: (text) => Effect.sync(() => notices.push(text)),
              },
            }),
          ),
          Effect.andThen(
            Effect.all({
              task: db.select().from(TaskOrchestratorTaskTable).all().pipe(Effect.orDie),
              steps: db.select().from(TaskOrchestratorStepTable).all().pipe(Effect.orDie),
              messages: db.select().from(TaskOrchestratorMessageTable).all().pipe(Effect.orDie),
              runs: db.select().from(TaskOrchestratorRunTable).all().pipe(Effect.orDie),
            }),
          ),
        ),
      ),
      Effect.provide(sqlite),
      Effect.scoped,
      Effect.runPromise,
    )

    expect(maxActive).toBe(2)
    expect(result.task[0]?.status).toBe("completed")
    expect(result.steps.every((step) => step.status === "completed")).toBe(true)
    expect(result.messages.some((message) => message.kind === "critique")).toBe(true)
    expect(result.messages.filter((message) => message.kind === "submission")).toHaveLength(2)
    expect(result.runs.filter((run) => run.role === "worker")).toHaveLength(2)
    expect(result.runs.filter((run) => run.role === "worker").every((run) => run.status === "completed")).toBe(true)
    expect(result.runs.map((run) => JSON.parse(run.input_snapshot).id).sort((a, b) => a.localeCompare(b))).toEqual([
      "a",
      "b",
    ])
    expect(merged).toHaveLength(2)
    expect(notices.some((text) => text.includes("Plan draft ready") && text.includes("Implement A"))).toBe(true)
    expect(notices.some((text) => text.includes("Plan ready") && text.includes("Implement B"))).toBe(true)
    expect(notices.findIndex((text) => text.includes("Plan draft ready"))).toBeLessThan(
      notices.findIndex((text) => text.includes("Reviewer and tester are reviewing")),
    )
    expect(notices.filter((text) => text.startsWith("Worker ") && text.includes("started"))).toHaveLength(2)
  })

  test("feeds reviewer findings back to the worker and merges the revised patch", async () => {
    let workCalls = 0
    const rejected = new Set<string>()
    const merged: string[] = []
    const result = await makeDb.pipe(
      Effect.flatMap((db) =>
        seed(db).pipe(
          Effect.andThen(
            TaskOrchestratorParallel.run({
              db,
              taskID: "task",
              runner: {
                plan: () => Effect.succeed(plan),
                discuss: () => Effect.succeed("critique"),
                work: ({ patch }) =>
                  Effect.sync(() => {
                    workCalls += 1
                    return { output: "done", patch: patch ? "revised patch" : "initial patch" }
                  }),
                review: ({ name }) =>
                  Effect.sync(() => {
                    const key = name.split(":review:")[0]
                    if (rejected.has(key)) return '{"approved":true,"findings":[]}'
                    rejected.add(key)
                    return '{"approved":false,"findings":[{"message":"fix it"}]}'
                  }),
                test: () => Effect.succeed("ok"),
                finalize: () => Effect.succeed("final"),
                merge: (patch) => Effect.sync(() => merged.push(patch)),
              },
            }),
          ),
          Effect.andThen(
            Effect.all({
              task: db.select().from(TaskOrchestratorTaskTable).all().pipe(Effect.orDie),
              messages: db.select().from(TaskOrchestratorMessageTable).all().pipe(Effect.orDie),
            }),
          ),
        ),
      ),
      Effect.provide(sqlite),
      Effect.scoped,
      Effect.runPromise,
    )

    expect(result.task[0]?.status).toBe("completed")
    expect(workCalls).toBe(4)
    expect(merged).toEqual(["revised patch", "revised patch"])
    expect(result.messages.filter((message) => message.kind === "revision")).toHaveLength(2)
  })

  test("keeps successful workers when another worker fails and resumes only the failed worker", async () => {
    let planCalls = 0
    let workerA = 0
    let workerB = 0
    let failA = true
    const merged: string[] = []
    const result = await makeDb.pipe(
      Effect.flatMap((db) =>
        seed(db).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              const runner = {
                plan: () => {
                  planCalls += 1
                  return Effect.succeed(plan)
                },
                discuss: () => Effect.succeed("critique"),
                work: ({ name }: { readonly name: string }) =>
                  Effect.gen(function* () {
                    if (name.endsWith(":a")) {
                      workerA += 1
                      if (failA) return yield* Effect.fail(new Error("transport failed"))
                      return { output: "a done", patch: "patch a" }
                    }
                    workerB += 1
                    return { output: "b done", patch: "patch b" }
                  }),
                review: () => Effect.succeed('{"approved":true,"findings":[]}'),
                test: () => Effect.succeed("ok"),
                finalize: () => Effect.succeed("final"),
                merge: (patch: string) => Effect.sync(() => merged.push(patch)),
              }
              yield* TaskOrchestratorParallel.run({ db, taskID: "task", runner })
              failA = false
              yield* TaskOrchestratorParallel.run({ db, taskID: "task", runner })
            }),
          ),
          Effect.andThen(
            Effect.all({
              task: db.select().from(TaskOrchestratorTaskTable).all().pipe(Effect.orDie),
              messages: db.select().from(TaskOrchestratorMessageTable).all().pipe(Effect.orDie),
              runs: db.select().from(TaskOrchestratorRunTable).all().pipe(Effect.orDie),
            }),
          ),
        ),
      ),
      Effect.provide(sqlite),
      Effect.scoped,
      Effect.runPromise,
    )

    expect(planCalls).toBe(2)
    expect(workerA).toBe(2)
    expect(workerB).toBe(1)
    expect(result.task[0]?.status).toBe("completed")
    expect(result.runs.filter((run) => run.role === "worker")).toHaveLength(2)
    expect(result.runs.filter((run) => run.role === "worker").every((run) => run.status === "completed")).toBe(true)
    expect(result.messages.filter((message) => message.kind === "submission")).toHaveLength(2)
    expect(merged).toEqual(["patch a", "patch b"])
  })

  test("retries one transient worker failure and does not retry authentication failures", async () => {
    let transient = 0
    let permanent = 0
    const provider = (reason: LLMError["reason"]) =>
      Cause.fail(new LLMError({ module: "RequestExecutor", method: "execute", reason }))
    const result = await makeDb.pipe(
      Effect.flatMap((db) =>
        seed(db).pipe(
          Effect.andThen(
            TaskOrchestratorParallel.run({
              db,
              taskID: "task",
              runner: {
                plan: () => Effect.succeed(plan),
                discuss: () => Effect.succeed("critique"),
                work: ({ name }) => {
                  const id = name.split(":")[1]
                  if (id === "a") {
                    transient += 1
                    if (name.endsWith(":retry")) return Effect.succeed({ output: "a done", patch: "patch a" })
                    return Effect.failCause(provider(new TransportReason({ message: "socket hang up", kind: "TransportError" })))
                  }
                  permanent += 1
                  return Effect.failCause(provider(new AuthenticationReason({ message: "invalid key", kind: "invalid" })))
                },
                review: () => Effect.succeed('{"approved":true,"findings":[]}'),
                test: () => Effect.succeed("ok"),
                finalize: () => Effect.succeed("final"),
                merge: () => Effect.void,
              },
            }),
          ),
          Effect.andThen(db.select().from(TaskOrchestratorRunTable).all().pipe(Effect.orDie)),
        ),
      ),
      Effect.provide(sqlite),
      Effect.scoped,
      Effect.runPromise,
    )

    expect(transient).toBe(2)
    expect(permanent).toBe(1)
    const workerA = result.find((run) => JSON.parse(run.input_snapshot).id === "a")
    const workerB = result.find((run) => JSON.parse(run.input_snapshot).id === "b")
    expect(workerA?.status).toBe("completed")
    expect(workerB?.status).toBe("failed")
    expect(workerB?.failure_reason).toContain("Authentication")
  })
})
