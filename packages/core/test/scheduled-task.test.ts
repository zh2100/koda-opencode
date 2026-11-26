import { describe, expect, test } from "bun:test"
import {
  LLMError,
  RateLimitReason,
  TransportReason,
  InvalidProviderOutputReason,
  NoRouteReason,
  QuotaExceededReason,
  ContentPolicyReason,
  UnknownProviderReason,
  ProviderInternalReason,
  RouteID,
  ProviderID,
  ModelID,
} from "@opencode-ai/llm"
import fs from "fs/promises"
import path from "path"
import { Hash } from "@opencode-ai/core/util/hash"
import { Cause, DateTime, Deferred, Duration, Effect, Exit, Fiber, Layer, Stream } from "effect"
import { eq } from "drizzle-orm"
import { ScheduledTaskEvent } from "@opencode-ai/schema/scheduled-task-event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { ScheduledTaskRunTable, ScheduledTaskTable } from "@opencode-ai/core/scheduled-task/sql"
import { ScheduledTask } from "@opencode-ai/schema/scheduled-task"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { EventV2 } from "@opencode-ai/core/event"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Database } from "@opencode-ai/core/database/database"
import { Global } from "@opencode-ai/core/global"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Prompt } from "@opencode-ai/schema/prompt"
import { RelayGate } from "@opencode-ai/core/relay-gate"
import { ScheduledTaskStore } from "@opencode-ai/core/scheduled-task"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionInput } from "@opencode-ai/schema/session-input"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { adjust } from "effect/testing/TestClock"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

describe("ScheduledTaskStore.nextDaily", () => {
  test("maps a spring-forward gap to the later wall-clock time", () => {
    const start = DateTime.makeZonedUnsafe(
      { year: 2025, month: 3, day: 8, hour: 2, minute: 30 },
      { timeZone: "America/New_York", adjustForTimeZone: true },
    )
    const next = ScheduledTaskStore.nextDaily(DateTime.toUtc(start), "America/New_York")
    const parts = DateTime.toParts(DateTime.setZone(next, DateTime.zoneMakeNamedUnsafe("America/New_York")))
    expect(parts.month).toBe(3)
    expect(parts.day).toBe(9)
    expect(parts.hour).toBe(3)
    expect(parts.minute).toBe(30)
  })

  test("keeps the earlier occurrence across a fall-back overlap", () => {
    const start = DateTime.makeZonedUnsafe(
      { year: 2025, month: 11, day: 1, hour: 1, minute: 30 },
      { timeZone: "America/New_York", adjustForTimeZone: true },
    )
    const next = ScheduledTaskStore.nextDaily(DateTime.toUtc(start), "America/New_York")
    const parts = DateTime.toParts(DateTime.setZone(next, DateTime.zoneMakeNamedUnsafe("America/New_York")))
    expect(parts.month).toBe(11)
    expect(parts.day).toBe(2)
    expect(parts.hour).toBe(1)
    expect(parts.minute).toBe(30)
  })

  test("keeps Asia/Shanghai daily time across a month boundary", () => {
    const start = DateTime.makeZonedUnsafe(
      { year: 2025, month: 1, day: 31, hour: 9, minute: 15 },
      { timeZone: "Asia/Shanghai", adjustForTimeZone: true },
    )
    const next = ScheduledTaskStore.nextDaily(DateTime.toUtc(start), "Asia/Shanghai")
    const parts = DateTime.toParts(DateTime.setZone(next, DateTime.zoneMakeNamedUnsafe("Asia/Shanghai")))
    expect(parts.month).toBe(2)
    expect(parts.day).toBe(1)
    expect(parts.hour).toBe(9)
    expect(parts.minute).toBe(15)
  })

  test("returns to the original local time after a spring-forward gap", () => {
    const start = DateTime.makeZonedUnsafe(
      { year: 2025, month: 3, day: 8, hour: 2, minute: 30 },
      { timeZone: "America/New_York", adjustForTimeZone: true },
    )
    const anchor = DateTime.toUtc(start)
    const gap = ScheduledTaskStore.nextDaily(anchor, "America/New_York", anchor)
    const restored = ScheduledTaskStore.nextDaily(gap, "America/New_York", anchor)
    const parts = DateTime.toParts(DateTime.setZone(restored, DateTime.zoneMakeNamedUnsafe("America/New_York")))
    expect(parts.month).toBe(3)
    expect(parts.day).toBe(10)
    expect(parts.hour).toBe(2)
    expect(parts.minute).toBe(30)
  })
})

describe("ScheduledTaskStore.dueSlots", () => {
  test("marks a once task missed after 24 hours", () => {
    const runAt = DateTime.makeUnsafe(1_704_067_200_000)
    const now = DateTime.makeUnsafe(1_704_067_200_000 + 86_400_000 + 1)
    const slots = ScheduledTaskStore.dueSlots({ schedule: "once", timezone: "UTC", runAt, nextRun: runAt }, now)
    expect(slots).toHaveLength(1)
    expect(slots[0]?.missed).toBe(true)
  })

  test("catches up only the latest daily slot after a long sleep", () => {
    const runAt = DateTime.makeUnsafe(1_704_067_200_000)
    const now = DateTime.makeUnsafe(1_704_067_200_000 + 86_400_000 * 3)
    const slots = ScheduledTaskStore.dueSlots({ schedule: "daily", timezone: "UTC", runAt, nextRun: runAt }, now)
    expect(slots.length).toBeGreaterThan(1)
    expect(slots.slice(0, -1).every((slot) => slot.missed)).toBe(true)
    expect(slots.at(-1)?.missed).toBe(false)
  })
})

const recordingSession = (
  created: SessionV2.Info[],
  resume: SessionV2.Interface["resume"] = () => Effect.void,
  hooks?: {
    create?: SessionV2.Interface["create"]
    prompt?: SessionV2.Interface["prompt"]
  },
) =>
  Layer.succeed(
    SessionV2.Service,
    SessionV2.Service.of({
      list: () => Effect.succeed(created),
      create: (input) => {
        if (hooks?.create) return hooks.create(input)
        const info = SessionV2.Info.make({
          id: SessionV2.ID.descending(),
          projectID: ProjectV2.ID.global,
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: {
            created: DateTime.makeUnsafe(0),
            updated: DateTime.makeUnsafe(0),
          },
          title: input.title ?? "scheduled",
          approvalMode: input.approvalMode,
          location: input.location,
        })
        created.push(info)
        return Effect.succeed(info)
      },
      get: () => Effect.die("unused"),
      setTitle: () => Effect.void,
      remove: () => Effect.void,
      messages: () => Effect.succeed([]),
      message: () => Effect.succeed(undefined),
      context: () => Effect.succeed([]),
      events: () => Stream.die("unused"),
      history: () => Effect.succeed({ events: [], hasMore: false }),
      pending: () => Effect.die("unused"),
      switchAgent: () => Effect.void,
      switchModel: () => Effect.void,
      notice: () => Effect.void,
      recordPrompt: () => Effect.die("unused"),
      prompt: (input) => {
        if (hooks?.prompt) return hooks.prompt(input)
        return Effect.succeed(
          SessionInput.Admitted.make({
            admittedSeq: 0,
            id: SessionMessage.ID.make("msg_scheduled"),
            sessionID: input.sessionID,
            prompt: Prompt.make({ text: input.prompt.text }),
            delivery: input.delivery ?? "steer",
            timeCreated: DateTime.makeUnsafe(0),
          }),
        )
      },
      shell: () => Effect.void,
      skill: () => Effect.void,
      compact: () => Effect.void,
      wait: () => Effect.void,
      active: Effect.succeed(new Set()),
      resume,
      interrupt: () => Effect.void,
      revert: {
        stage: () => Effect.die("unused"),
        clear: () => Effect.void,
        commit: () => Effect.void,
      },
    }),
  )

const scheduled = testEffect(Layer.empty)

const taskInput = (name: string, directory: AbsolutePath, now: DateTime.Utc) => ({
  name,
  projectID: ProjectV2.ID.global,
  location: { directory },
  prompt: Prompt.make({ text: name }),
  schedule: "daily" as const,
  timezone: "UTC",
  runAt: DateTime.add(now, { hours: 1 }),
  model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.openai },
  approvalMode: "ask" as const,
  enabled: true,
})

const project = (directory: AbsolutePath) =>
  Layer.succeed(
    ProjectV2.Service,
    ProjectV2.Service.of({
      directories: () => Effect.die("unused"),
      resolve: () => Effect.succeed({ id: ProjectV2.ID.global, directory }),
      commit: () => Effect.void,
    }),
  )

const countingEvents = (published: string[]) =>
  Layer.effect(
    EventV2.Service,
    Effect.gen(function* () {
      const service = yield* EventV2.Service
      return EventV2.Service.of({
        ...service,
        publish: (definition, data, options) =>
          service
            .publish(definition, data, options)
            .pipe(Effect.tap(() => Effect.sync(() => published.push(definition.type)))),
      })
    }),
  ).pipe(Layer.provide(EventV2.layerWith()))

describe("ScheduledTask", () => {
  scheduled.live("executes a claimed once task after advance disables further scheduling", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const created: SessionV2.Info[] = []
          const directory = AbsolutePath.make(tmp.path)
          const layer = AppNodeBuilder.build(ScheduledTaskStore.node, [
            [Database.node, Database.layerFromPath(path.join(tmp.path, "opencode.db"))],
            [Global.node, Global.layerWith({ data: tmp.path })],
            [
              ProjectV2.node,
              Layer.succeed(
                ProjectV2.Service,
                ProjectV2.Service.of({
                  directories: () => Effect.die("unused"),
                  resolve: () =>
                    Effect.succeed({
                      id: ProjectV2.ID.global,
                      directory,
                    }),
                  commit: () => Effect.void,
                }),
              ),
            ],
            [RelayGate.node, RelayGate.layerWith({ scheduledTasks: true })],
            [SessionV2.node, recordingSession(created)],
          ])
          const result = yield* Effect.gen(function* () {
            const tasks = yield* ScheduledTaskStore.Service
            const now = yield* DateTime.now
            const task = yield* tasks.create({
              name: "once",
              projectID: ProjectV2.ID.global,
              location: { directory },
              prompt: Prompt.make({ text: "run once" }),
              schedule: "once",
              timezone: "UTC",
              runAt: DateTime.subtract(now, { minutes: 1 }),
              model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.openai },
              approvalMode: "auto",
              enabled: true,
            })
            yield* Effect.sleep("50 millis")
            return {
              task: (yield* tasks.list()).find((item) => item.id === task.id),
              runs: yield* tasks.runs(task.id),
              sessions: created.length,
            }
          }).pipe(Effect.provide(layer))
          expect(result.sessions).toBe(1)
          expect(result.task?.enabled).toBe(false)
          expect(result.task?.nextRun).toBeUndefined()
          expect(result.runs[0]?.status).toBe("completed")
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  scheduled.live("rejects a disabled daily run and starts a new run after enabling", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const created: SessionV2.Info[] = []
          const directory = AbsolutePath.make(tmp.path)
          const layer = AppNodeBuilder.build(ScheduledTaskStore.node, [
            [Database.node, Database.layerFromPath(path.join(tmp.path, "opencode.db"))],
            [Global.node, Global.layerWith({ data: tmp.path })],
            [
              ProjectV2.node,
              Layer.succeed(
                ProjectV2.Service,
                ProjectV2.Service.of({
                  directories: () => Effect.die("unused"),
                  resolve: () => Effect.succeed({ id: ProjectV2.ID.global, directory }),
                  commit: () => Effect.void,
                }),
              ),
            ],
            [RelayGate.node, RelayGate.layerWith({ scheduledTasks: true })],
            [SessionV2.node, recordingSession(created)],
          ])
          const result = yield* Effect.gen(function* () {
            const tasks = yield* ScheduledTaskStore.Service
            const now = yield* DateTime.now
            const task = yield* tasks.create({
              name: "daily",
              projectID: ProjectV2.ID.global,
              location: { directory },
              prompt: Prompt.make({ text: "run daily" }),
              schedule: "daily",
              timezone: "UTC",
              runAt: DateTime.add(now, { hours: 2 }),
              model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.openai },
              approvalMode: "ask",
              enabled: true,
            })
            yield* tasks.setEnabled(task.id, false)
            const disabled = yield* tasks.runNow(task.id).pipe(Effect.flip)
            const afterDisable = yield* tasks.runs(task.id)
            yield* tasks.setEnabled(task.id, true)
            const first = yield* tasks.runNow(task.id)
            const active = (yield* tasks.runs(task.id)).find(
              (run) => run.status === "pending" || run.status === "running",
            )
            return {
              disabled: disabled._tag,
              pending: afterDisable.length,
              status: first.status,
              active: active?.id,
              sessions: created.length,
            }
          }).pipe(Effect.provide(layer))
          expect(result.disabled).toBe("ScheduledTask.DisabledError")
          expect(result.pending).toBe(0)
          expect(result.status).toBe("completed")
          expect(result.active).toBeUndefined()
          expect(result.sessions).toBe(1)
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})

for (const scenario of ["same-project", "cross-project", "cancel", "failure"] as const) {
  scheduled.live(
    `controlled task boundary: ${scenario}`,
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) =>
          Effect.gen(function* () {
            const created: SessionV2.Info[] = []
            const entered = yield* Deferred.make<void>()
            const second = yield* Deferred.make<void>()
            const release = yield* Deferred.make<void>()
            const calls = { count: 0 }
            const directory = AbsolutePath.make(tmp.path)
            const layer = AppNodeBuilder.build(ScheduledTaskStore.node, [
              [Database.node, Database.layerFromPath(path.join(tmp.path, "opencode.db"))],
              [Global.node, Global.layerWith({ data: tmp.path })],
              [
                ProjectV2.node,
                Layer.succeed(
                  ProjectV2.Service,
                  ProjectV2.Service.of({
                    directories: () => Effect.die("unused"),
                    resolve: (dir) => Effect.succeed({ id: ProjectV2.ID.make(dir), directory: dir }),
                    commit: () => Effect.void,
                  }),
                ),
              ],
              [RelayGate.node, RelayGate.layerWith({ scheduledTasks: true })],
              [
                SessionV2.node,
                recordingSession(created, () =>
                  Effect.gen(function* () {
                    calls.count++
                    if (calls.count > 1) {
                      yield* Deferred.succeed(second, undefined)
                      return
                    }
                    yield* Deferred.succeed(entered, undefined)
                    yield* Deferred.await(release)
                    if (scenario === "failure")
                      return yield* new SessionV2.NotFoundError({ sessionID: SessionV2.ID.make("ses_missing") })
                  }),
                ),
              ],
            ])
            yield* Effect.gen(function* () {
              const tasks = yield* ScheduledTaskStore.Service
              const now = yield* DateTime.now
              const create = (dir: typeof directory) =>
                tasks.create({
                  name: dir,
                  projectID: ProjectV2.ID.make(dir),
                  location: { directory: dir },
                  prompt: Prompt.make({ text: "controlled" }),
                  schedule: "daily",
                  timezone: "UTC",
                  runAt: DateTime.add(now, { hours: 1 }),
                  model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.openai },
                  approvalMode: "auto",
                  enabled: true,
                })
              const a = yield* create(directory)
              const b = yield* create(
                scenario === "cross-project" ? AbsolutePath.make(path.join(tmp.path, "other")) : directory,
              )
              const first = yield* tasks.runNow(a.id).pipe(Effect.forkScoped)
              yield* Deferred.await(entered)
              const next = yield* tasks.runNow(b.id).pipe(Effect.forkScoped)
              if (scenario === "cross-project") yield* Deferred.await(second)
              if (scenario !== "cross-project") {
                // Wait until the second claim is persisted, not a timer-based guess.
                yield* tasks
                  .runs(b.id)
                  .pipe(Effect.repeat({ until: (runs) => runs.some((run) => run.status === "pending") }))
                expect(created).toHaveLength(1)
              }
              if (scenario === "cancel") yield* Fiber.interrupt(first)
              yield* Deferred.succeed(release, undefined)
              yield* Fiber.join(next)
              if (scenario !== "cancel") yield* Fiber.join(first)
              expect((yield* tasks.runs(a.id))[0]?.status).toBe(
                scenario === "cancel" ? "interrupted" : scenario === "failure" ? "failed" : "completed",
              )
              expect((yield* tasks.runs(b.id))[0]?.status).toBe("completed")
              expect(created.every((session) => session.approvalMode === "auto")).toBe(true)
            }).pipe(Effect.provide(layer))
          }),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
    15000,
  )
}

for (const boundary of ["create", "prompt"] as const) {
  scheduled.live(`reaches a terminal run when ${boundary} fails and releases the project`, () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const created: SessionV2.Info[] = []
          const directory = AbsolutePath.make(tmp.path)
          const layer = AppNodeBuilder.build(ScheduledTaskStore.node, [
            [Database.node, Database.layerFromPath(path.join(tmp.path, "opencode.db"))],
            [Global.node, Global.layerWith({ data: tmp.path })],
            [
              ProjectV2.node,
              Layer.succeed(
                ProjectV2.Service,
                ProjectV2.Service.of({
                  directories: () => Effect.die("unused"),
                  resolve: () => Effect.succeed({ id: ProjectV2.ID.global, directory }),
                  commit: () => Effect.void,
                }),
              ),
            ],
            [RelayGate.node, RelayGate.layerWith({ scheduledTasks: true })],
            [
              SessionV2.node,
              recordingSession(created, () => Effect.void, {
                ...(boundary === "create" ? { create: () => Effect.die("create failed") } : {}),
                ...(boundary === "prompt" ? { prompt: () => Effect.die("prompt failed") } : {}),
              }),
            ],
          ])
          const result = yield* Effect.gen(function* () {
            const tasks = yield* ScheduledTaskStore.Service
            const now = yield* DateTime.now
            const task = yield* tasks.create({
              name: boundary,
              projectID: ProjectV2.ID.global,
              location: { directory },
              prompt: Prompt.make({ text: "fail boundary" }),
              schedule: "daily",
              timezone: "UTC",
              runAt: DateTime.add(now, { hours: 1 }),
              model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.openai },
              approvalMode: "auto",
              enabled: true,
            })
            const failed = yield* tasks.runNow(task.id).pipe(Effect.exit)
            const runs = yield* tasks.runs(task.id)
            const next = yield* tasks.runNow(task.id).pipe(Effect.exit)
            return {
              failed: Exit.isFailure(failed) ? "error" : failed.value.status,
              stored: runs.map((run) => run.status),
              next: Exit.isFailure(next) ? "error" : next.value.status,
              sessions: created.length,
            }
          }).pipe(Effect.provide(layer))
          expect(
            result.failed === "error" || result.stored.includes("failed") || result.stored.includes("interrupted"),
          ).toBe(true)
          expect(result.stored.every((status) => status !== "pending" && status !== "running")).toBe(true)
          expect(result.next === "error" || result.next === "failed" || result.next === "interrupted").toBe(true)
          expect(result.sessions).toBe(boundary === "create" ? 0 : 1)
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
}

scheduled.live("does not recover when a one-shot probe returns busy after diagnosis is idle", () =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) =>
      Effect.gen(function* () {
        const created: SessionV2.Info[] = []
        const directory = AbsolutePath.make(tmp.path)
        const layer = AppNodeBuilder.build(
          LayerNode.group([ScheduledTaskStore.node, Database.node, EffectFlock.node]),
          [
            [Database.node, Database.layerFromPath(path.join(tmp.path, "opencode.db"))],
            [Global.node, Global.layerWith({ data: tmp.path })],
            [
              ProjectV2.node,
              Layer.succeed(
                ProjectV2.Service,
                ProjectV2.Service.of({
                  directories: () => Effect.die("unused"),
                  resolve: () => Effect.succeed({ id: ProjectV2.ID.global, directory }),
                  commit: () => Effect.void,
                }),
              ),
            ],
            [RelayGate.node, RelayGate.layerWith({ scheduledTasks: true })],
            [SessionV2.node, recordingSession(created)],
          ],
        )
        yield* Effect.gen(function* () {
          const tasks = yield* ScheduledTaskStore.Service
          const database = yield* Database.Service
          const flock = yield* EffectFlock.Service
          const now = yield* DateTime.now
          const task = yield* tasks.create({
            name: "busy-probe",
            projectID: ProjectV2.ID.global,
            location: { directory },
            prompt: Prompt.make({ text: "busy" }),
            schedule: "daily",
            timezone: "UTC",
            runAt: DateTime.add(now, { hours: 1 }),
            model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.openai },
            approvalMode: "ask",
            enabled: true,
          })
          const active = ScheduledTask.RunID.create()
          const owner = "racing-scheduler"
          const locks = path.join(tmp.path, "locks")
          yield* database.db
            .insert(ScheduledTaskRunTable)
            .values({ id: active, task_id: task.id, owner, scheduled_at: 1, revision: 0, status: "pending" })
            .run()
            .pipe(Effect.orDie)
          yield* Effect.scoped(
            Effect.gen(function* () {
              const lease = yield* flock.probe(owner, locks)
              expect(lease.status).toBe("acquired")
              expect((yield* tasks.runNow(task.id)).id).toBe(active)
              expect((yield* tasks.runs(task.id)).find((run) => run.id === active)?.status).toBe("pending")
              expect(created).toHaveLength(0)
            }),
          )
        }).pipe(Effect.provide(layer))
      }),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ),
)

scheduled.live("recovers orphaned runs and preserves runs owned by another active scheduler", () =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) =>
      Effect.gen(function* () {
        const created: SessionV2.Info[] = []
        const directory = AbsolutePath.make(tmp.path)
        const layer = AppNodeBuilder.build(
          LayerNode.group([ScheduledTaskStore.node, Database.node, EffectFlock.node]),
          [
            [Database.node, Database.layerFromPath(path.join(tmp.path, "opencode.db"))],
            [Global.node, Global.layerWith({ data: tmp.path })],
            [
              ProjectV2.node,
              Layer.succeed(
                ProjectV2.Service,
                ProjectV2.Service.of({
                  directories: () => Effect.die("unused"),
                  resolve: () => Effect.succeed({ id: ProjectV2.ID.global, directory }),
                  commit: () => Effect.void,
                }),
              ),
            ],
            [RelayGate.node, RelayGate.layerWith({ scheduledTasks: true })],
            [SessionV2.node, recordingSession(created)],
          ],
        )
        yield* Effect.gen(function* () {
          const tasks = yield* ScheduledTaskStore.Service
          const database = yield* Database.Service
          const flock = yield* EffectFlock.Service
          const now = yield* DateTime.now
          const task = yield* tasks.create({
            name: "recover",
            projectID: ProjectV2.ID.global,
            location: { directory },
            prompt: Prompt.make({ text: "recover" }),
            schedule: "daily",
            timezone: "UTC",
            runAt: DateTime.add(now, { hours: 1 }),
            model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.openai },
            approvalMode: "ask",
            enabled: true,
          })
          const orphan = ScheduledTask.RunID.create()
          yield* database.db
            .insert(ScheduledTaskRunTable)
            .values({ id: orphan, task_id: task.id, scheduled_at: 0, revision: 0, status: "pending" })
            .run()
            .pipe(Effect.orDie)
          const active = ScheduledTask.RunID.create()
          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* flock.acquire("other-scheduler", path.join(tmp.path, "locks"))
              yield* database.db
                .insert(ScheduledTaskRunTable)
                .values({
                  id: active,
                  task_id: task.id,
                  owner: "other-scheduler",
                  scheduled_at: 1,
                  revision: 0,
                  status: "pending",
                })
                .run()
                .pipe(Effect.orDie)
              expect((yield* tasks.runNow(task.id)).id).toBe(active)
              expect((yield* tasks.runs(task.id)).find((run) => run.id === orphan)?.status).toBe("interrupted")
              expect(created).toHaveLength(0)
            }),
          )
          expect((yield* tasks.runNow(task.id)).status).toBe("completed")
          expect((yield* tasks.runs(task.id)).find((run) => run.id === active)?.status).toBe("interrupted")
          expect(created).toHaveLength(1)

          const held = yield* tasks.create({
            name: "unknown-lock",
            projectID: ProjectV2.ID.global,
            location: { directory },
            prompt: Prompt.make({ text: "held" }),
            schedule: "daily",
            timezone: "UTC",
            runAt: DateTime.add(now, { hours: 2 }),
            model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.openai },
            approvalMode: "ask",
            enabled: true,
          })
          const unknown = ScheduledTask.RunID.create()
          const lockDir = path.join(tmp.path, "locks", Hash.fast("held") + ".lock")
          yield* Effect.promise(() => fs.mkdir(lockDir, { recursive: true }))
          yield* database.db
            .insert(ScheduledTaskRunTable)
            .values({
              id: unknown,
              task_id: held.id,
              owner: "held",
              scheduled_at: 2,
              revision: 0,
              status: "running",
            })
            .run()
            .pipe(Effect.orDie)
          const before = created.length
          expect((yield* tasks.runNow(held.id)).id).toBe(unknown)
          expect((yield* tasks.runs(held.id)).find((run) => run.id === unknown)?.status).toBe("running")
          expect(created).toHaveLength(before)
          const backup = path.join(tmp.path, "lock-backup")
          yield* Effect.promise(() => fs.cp(path.join(tmp.path, "locks"), backup, { recursive: true }))
          yield* Effect.promise(() => fs.rm(lockDir, { recursive: true, force: true }))
          expect((yield* tasks.runNow(held.id)).status).toBe("completed")
          expect((yield* tasks.runs(held.id)).find((run) => run.id === unknown)?.status).toBe("interrupted")
          expect(created).toHaveLength(before + 1)
          expect(yield* Effect.promise(() => fs.stat(backup).then(() => true))).toBe(true)
        }).pipe(Effect.provide(layer))
      }),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ),
)

scheduled.live("two recoveries of one exited owner interrupt the run once and do not replay it", () =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) =>
      Effect.gen(function* () {
        const created: SessionV2.Info[] = []
        const published: string[] = []
        const directory = AbsolutePath.make(tmp.path)
        const database = Database.layerFromPath(path.join(tmp.path, "opencode.db"))
        const events = countingEvents(published).pipe(Layer.provide(database))
        const layer = AppNodeBuilder.build(
          LayerNode.group([ScheduledTaskStore.node, Database.node, EffectFlock.node]),
          [
            [Database.node, database],
            [EventV2.node, events.pipe(Layer.provide(database))],
            [Global.node, Global.layerWith({ data: tmp.path })],
            [ProjectV2.node, project(directory)],
            [RelayGate.node, RelayGate.layerWith({ scheduledTasks: true })],
            [SessionV2.node, recordingSession(created)],
          ],
        )
        yield* Effect.gen(function* () {
          const tasks = yield* ScheduledTaskStore.Service
          const database = yield* Database.Service
          const now = yield* DateTime.now
          const task = yield* tasks.create(taskInput("two-recoveries", directory, DateTime.toUtc(now)))
          const orphan = ScheduledTask.RunID.create()
          const owner = "exited-scheduler"
          const locks = path.join(tmp.path, "locks")
          const lockDir = path.join(locks, Hash.fast(owner) + ".lock")
          const holder = Bun.spawn(
            [
              process.execPath,
              "-e",
              `const fs=require("fs"); const path=${JSON.stringify(lockDir)}; fs.mkdirSync(path,{recursive:true}); fs.writeFileSync(path+"/heartbeat",""); fs.writeFileSync(path+"/meta.json", JSON.stringify({token:"holder",pid:process.pid,hostname:require("os").hostname(),createdAt:new Date().toISOString()})); console.log("ready"); setInterval(()=>{}, 1000)`,
            ],
            { stdout: "pipe", stderr: "pipe" },
          )
          const ready = yield* Effect.promise(async () => {
            const reader = holder.stdout.getReader()
            const chunk = await reader.read()
            return new TextDecoder().decode(chunk.value)
          })
          expect(ready).toContain("ready")
          holder.kill()
          yield* Effect.promise(() => holder.exited)
          yield* database.db
            .insert(ScheduledTaskRunTable)
            .values({ id: orphan, task_id: task.id, owner, scheduled_at: 1, revision: 0, status: "running" })
            .run()
            .pipe(Effect.orDie)
          const before = published.length
          yield* Effect.all([ScheduledTaskStore.recoverForTest(tasks)(), ScheduledTaskStore.recoverForTest(tasks)()], {
            concurrency: 2,
          })
          const row = (yield* tasks.runs(task.id)).find((run) => run.id === orphan)
          expect(row?.status).toBe("interrupted")
          expect(published.length - before).toBe(1)
          expect(created).toHaveLength(0)
          expect(
            yield* Effect.promise(() =>
              fs
                .stat(lockDir)
                .then(() => true)
                .catch(() => false),
            ),
          ).toBe(false)
        }).pipe(Effect.provide(layer))
      }),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ),
)

scheduled.live("cancellation during recovery leaves the original run and its lock", () =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) =>
      Effect.gen(function* () {
        const created: SessionV2.Info[] = []
        const published: string[] = []
        const directory = AbsolutePath.make(tmp.path)
        const database = Database.layerFromPath(path.join(tmp.path, "opencode.db"))
        const layer = AppNodeBuilder.build(
          LayerNode.group([ScheduledTaskStore.node, Database.node, EffectFlock.node]),
          [
            [Database.node, database],
            [EventV2.node, countingEvents(published).pipe(Layer.provide(database))],
            [Global.node, Global.layerWith({ data: tmp.path })],
            [ProjectV2.node, project(directory)],
            [RelayGate.node, RelayGate.layerWith({ scheduledTasks: true })],
            [SessionV2.node, recordingSession(created)],
          ],
        )
        yield* Effect.gen(function* () {
          const tasks = yield* ScheduledTaskStore.Service
          const database = yield* Database.Service
          const now = yield* DateTime.now
          const task = yield* tasks.create(taskInput("cancel-recovery", directory, DateTime.toUtc(now)))
          const active = ScheduledTask.RunID.create()
          const owner = "cancel-owner"
          const locks = path.join(tmp.path, "locks")
          yield* database.db
            .insert(ScheduledTaskRunTable)
            .values({ id: active, task_id: task.id, owner, scheduled_at: 1, revision: 0, status: "pending" })
            .run()
            .pipe(Effect.orDie)
          const before = published.length
          const fiber = yield* ScheduledTaskStore.recoverForTest(tasks)(task.id).pipe(Effect.forkChild)
          yield* Fiber.interrupt(fiber)
          expect((yield* tasks.runs(task.id)).find((run) => run.id === active)?.status).toBe("pending")
          expect(published.length).toBe(before)
          expect(created).toHaveLength(0)
          expect(
            yield* Effect.promise(() =>
              fs
                .stat(path.join(locks, Hash.fast(owner) + ".lock"))
                .then(() => true)
                .catch(() => false),
            ),
          ).toBe(false)
        }).pipe(Effect.provide(layer))
      }),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ),
)

scheduled.live("a database failure during recovery publishes no interrupted event and does not replay", () =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) =>
      Effect.gen(function* () {
        const created: SessionV2.Info[] = []
        const published: string[] = []
        const directory = AbsolutePath.make(tmp.path)
        const filename = path.join(tmp.path, "opencode.db")
        const database = Database.layerFromPath(filename)
        const layer = AppNodeBuilder.build(LayerNode.group([ScheduledTaskStore.node, EventV2.node, Database.node]), [
          [Database.node, database],
          [EventV2.node, countingEvents(published).pipe(Layer.provide(database))],
          [Global.node, Global.layerWith({ data: tmp.path })],
          [ProjectV2.node, project(directory)],
          [RelayGate.node, RelayGate.layerWith({ scheduledTasks: true })],
          [SessionV2.node, recordingSession(created)],
        ])
        yield* Effect.gen(function* () {
          const tasks = yield* ScheduledTaskStore.Service
          const db = yield* Database.Service
          const now = yield* DateTime.now
          const task = yield* tasks.create(taskInput("db-failure", directory, DateTime.toUtc(now)))
          const orphan = ScheduledTask.RunID.create()
          const before = published.length
          yield* db.db
            .insert(ScheduledTaskRunTable)
            .values({ id: orphan, task_id: task.id, scheduled_at: 1, revision: 0, status: "pending" })
            .run()
            .pipe(Effect.orDie)
          yield* db.db.run("DROP TABLE scheduled_task_run").pipe(Effect.orDie)
          const exit = yield* ScheduledTaskStore.recoverForTest(tasks)(task.id).pipe(Effect.exit)
          expect(Exit.isFailure(exit)).toBe(true)
          expect(published.length).toBe(before)
          expect(created).toHaveLength(0)
          const events = yield* db.db.select().from(EventTable).all().pipe(Effect.orDie)
          expect(events.filter((event) => JSON.stringify(event.data).includes(orphan))).toHaveLength(0)
        }).pipe(Effect.provide(layer))
      }),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ),
)

scheduled.live("terminalizes a claim when publication defects before execution", () =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) =>
      Effect.gen(function* () {
        const created: SessionV2.Info[] = []
        const directory = AbsolutePath.make(tmp.path)
        const failure = { pending: false }
        const database = Database.layerFromPath(path.join(tmp.path, "opencode.db"))
        const events = Layer.effect(
          EventV2.Service,
          Effect.gen(function* () {
            const service = yield* EventV2.Service
            return EventV2.Service.of({
              ...service,
              publish: (definition, data, options) =>
                Effect.suspend(() => {
                  if (!failure.pending) return service.publish(definition, data, options)
                  failure.pending = false
                  return Effect.die("publication failed after claim")
                }),
            })
          }),
        ).pipe(Layer.provide(EventV2.layerWith()), Layer.provide(database))
        const layer = AppNodeBuilder.build(ScheduledTaskStore.node, [
          [Database.node, database],
          [EventV2.node, events],
          [Global.node, Global.layerWith({ data: tmp.path })],
          [
            ProjectV2.node,
            Layer.succeed(
              ProjectV2.Service,
              ProjectV2.Service.of({
                directories: () => Effect.die("unused"),
                resolve: () => Effect.succeed({ id: ProjectV2.ID.global, directory }),
                commit: () => Effect.void,
              }),
            ),
          ],
          [RelayGate.node, RelayGate.layerWith({ scheduledTasks: true })],
          [SessionV2.node, recordingSession(created)],
        ])
        yield* Effect.gen(function* () {
          const tasks = yield* ScheduledTaskStore.Service
          const now = yield* DateTime.now
          const input = {
            name: "publication",
            projectID: ProjectV2.ID.global,
            location: { directory },
            prompt: Prompt.make({ text: "run" }),
            schedule: "daily" as const,
            timezone: "UTC",
            runAt: DateTime.add(now, { hours: 1 }),
            model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.openai },
            approvalMode: "ask" as const,
            enabled: true,
          }
          const first = yield* tasks.create(input)
          failure.pending = true
          const result = yield* tasks.runNow(first.id).pipe(Effect.exit)
          expect(result._tag).toBe("Failure")
          expect((yield* tasks.runs(first.id))[0]?.status).toBe("interrupted")
          expect(created).toHaveLength(0)
          const second = yield* tasks.create(input)
          expect((yield* tasks.runNow(second.id)).status).toBe("completed")
          expect(created).toHaveLength(1)
        }).pipe(Effect.provide(layer))
      }),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ),
)

for (const failure of ["pending", "recovery", "interrupt", "none"] as const)
  scheduled.effect(
    `FUP-01: background scheduler survives ${failure} without replaying claims`,
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) =>
          Effect.gen(function* () {
            const created: SessionV2.Info[] = []
            const directory = AbsolutePath.make(tmp.path)
            const database = Database.layerFromPath(path.join(tmp.path, "opencode.db"))
            const fault = { armed: failure !== "none", attempts: 0, completed: 0 }
            const events = Layer.effect(
              EventV2.Service,
              Effect.gen(function* () {
                const original = yield* EventV2.Service
                return EventV2.Service.of({
                  ...original,
                  publish: (definition, data, options) =>
                    Effect.suspend(() => {
                      if (
                        definition.type === ScheduledTaskEvent.Updated.type &&
                        typeof data === "object" &&
                        data !== null &&
                        "run" in data &&
                        data.run &&
                        typeof data.run === "object" &&
                        "status" in data.run
                      ) {
                        if (data.run.status === "completed") fault.completed++
                        if (data.run.status === (failure === "recovery" ? "interrupted" : "pending")) {
                          fault.attempts++
                          if (fault.armed) {
                            fault.armed = false
                            return failure === "interrupt"
                              ? Effect.interrupt
                              : Effect.die("controlled notification failure")
                          }
                        }
                      }
                      return original.publish(definition, data, options)
                    }),
                })
              }),
            ).pipe(Layer.provide(EventV2.layerWith()), Layer.provide(database))
            const build = (enabled: boolean) =>
              AppNodeBuilder.build(LayerNode.group([ScheduledTaskStore.node, Database.node]), [
                [Database.node, database],
                [EventV2.node, events],
                [Global.node, Global.layerWith({ data: tmp.path })],
                [ProjectV2.node, project(directory)],
                [RelayGate.node, RelayGate.layerWith({ scheduledTasks: enabled })],
                [SessionV2.node, recordingSession(created)],
              ])
            const now = DateTime.toUtc(yield* DateTime.now)
            const input = {
              ...taskInput("first", directory, now),
              schedule: "once" as const,
              runAt: DateTime.subtract(now, { minutes: 1 }),
            }
            const seeded = yield* Effect.gen(function* () {
              const tasks = yield* ScheduledTaskStore.Service
              const first = yield* tasks.create({
                ...input,
                ...(failure === "recovery" ? { runAt: DateTime.add(now, { hours: 1 }) } : {}),
              })
              const second = yield* tasks.create({
                ...input,
                name: "same-round",
                runAt: failure === "recovery" ? DateTime.add(now, { seconds: 60 }) : input.runAt,
              })
              return { first, second }
            }).pipe(Effect.scoped, Effect.provide(build(false)))
            yield* Effect.gen(function* () {
              const tasks = yield* ScheduledTaskStore.Service
              const db = yield* Database.Service
              yield* adjust(Duration.zero)
              if (failure === "pending" || failure === "none")
                expect((yield* tasks.runs(seeded.second.id)).map((run) => run.status)).toEqual(["completed"])
              if (failure === "recovery") {
                yield* db.db
                  .insert(ScheduledTaskRunTable)
                  .values({
                    id: ScheduledTask.RunID.create(),
                    task_id: seeded.first.id,
                    scheduled_at: 1,
                    revision: 0,
                    status: "pending",
                  })
                  .run()
                  .pipe(Effect.orDie)
                yield* adjust(Duration.seconds(31))
                expect(fault.armed).toBe(false)
              }
              yield* adjust(Duration.seconds(31))
              const first = yield* tasks.runs(seeded.first.id)
              const second = yield* tasks.runs(seeded.second.id)
              expect(fault.armed).toBe(false)
              expect(first).toHaveLength(1)
              expect(first[0]?.status).toBe(failure === "none" ? "completed" : "interrupted")
              expect(second.map((run) => run.status)).toEqual(failure === "interrupt" ? [] : ["completed"])
              const later = yield* tasks.create({ ...input, name: "next-round" })
              yield* adjust(Duration.seconds(31))
              expect((yield* tasks.runs(later.id)).map((run) => run.status)).toEqual(
                failure === "interrupt" ? [] : ["completed"],
              )
              const count = created.length
              yield* adjust(Duration.seconds(31))
              expect(created).toHaveLength(count)
              expect(created).toHaveLength(failure === "interrupt" ? 0 : failure === "none" ? 3 : 2)
              // Leave eligible work behind: a leaked polling fiber would execute it after scope exit.
              yield* tasks.create({ ...input, name: "after-scope" })
            }).pipe(Effect.scoped, Effect.provide(build(true)))
            const sessions = created.length
            const attempts = fault.attempts
            const completed = fault.completed
            yield* adjust(Duration.seconds(90))
            expect(fault.attempts).toBe(attempts)
            expect(fault.completed).toBe(completed)
            expect(created).toHaveLength(sessions)
          }),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
    15000,
  )

for (const failure of [
  {
    reason: new ProviderInternalReason({ message: "TEST-PRIVATE-internal", status: 500 }),
    code: "UPSTREAM_UNREACHABLE",
    retryable: true,
  },
  {
    reason: new NoRouteReason({
      route: RouteID.make("private"),
      provider: ProviderID.make("test"),
      model: ModelID.make("test"),
    }),
    code: "TASK_EXECUTION_FAILED",
    retryable: false,
  },
  {
    reason: new QuotaExceededReason({ message: "TEST-PRIVATE-quota" }),
    code: "TASK_EXECUTION_FAILED",
    retryable: false,
  },
  {
    reason: new ContentPolicyReason({ message: "TEST-PRIVATE-policy" }),
    code: "TASK_EXECUTION_FAILED",
    retryable: false,
  },
  {
    reason: new UnknownProviderReason({ message: "TEST-PRIVATE-unknown" }),
    code: "TASK_EXECUTION_FAILED",
    retryable: false,
  },
  { reason: new RateLimitReason({ message: "TEST-PRIVATE-rate" }), code: "UPSTREAM_RATE_LIMITED", retryable: true },
  { reason: new TransportReason({ message: "TEST-PRIVATE-transport" }), code: "UPSTREAM_UNREACHABLE", retryable: true },
  {
    reason: new InvalidProviderOutputReason({ message: "TEST-PRIVATE-output" }),
    code: "UPSTREAM_INVALID_RESPONSE",
    retryable: false,
  },
] as const) {
  scheduled.live(`T01/T02 execution ${failure.code} is safe and does not disable a daily task`, () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const directory = AbsolutePath.make(tmp.path)
          const created: SessionV2.Info[] = []
          const layer = AppNodeBuilder.build(ScheduledTaskStore.node, [
            [Database.node, Database.layerFromPath(path.join(tmp.path, "opencode.db"))],
            [Global.node, Global.layerWith({ data: tmp.path })],
            [ProjectV2.node, project(directory)],
            [RelayGate.node, RelayGate.layerWith({ scheduledTasks: true })],
            [
              SessionV2.node,
              recordingSession(created, () =>
                Effect.fail(new LLMError({ module: "test", method: "resume", reason: failure.reason })),
              ),
            ],
          ])
          yield* Effect.gen(function* () {
            const tasks = yield* ScheduledTaskStore.Service
            const now = yield* DateTime.now
            const task = yield* tasks.create(taskInput("safe-error", directory, now))
            const run = yield* tasks.runNow(task.id)
            expect(run.status).toBe("failed")
            expect(run.error?.code).toBe(failure.code)
            expect(run.error?.retryable).toBe(failure.retryable)
            expect(JSON.stringify(run)).not.toContain("TEST-PRIVATE")
            const current = (yield* tasks.list()).find((item) => item.id === task.id)!
            expect(current.enabled).toBe(true)
            expect(current.nextRun).toEqual(task.nextRun)
            expect(run.sessionId).toBeDefined()
            expect(run.promptMessageId).toBeDefined()
          }).pipe(Effect.provide(layer))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
}

for (const terminal of ["success", "failure", "old-pause"] as const) {
  scheduled.live(`T06 terminal ${terminal} publishes the task disabled during execution`, () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const directory = AbsolutePath.make(tmp.path)
          const entered = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const received: Array<{ enabled: boolean; status?: string }> = []
          const layer = AppNodeBuilder.build(LayerNode.group([ScheduledTaskStore.node, EventV2.node]), [
            [Database.node, Database.layerFromPath(path.join(tmp.path, "opencode.db"))],
            [Global.node, Global.layerWith({ data: tmp.path })],
            [ProjectV2.node, project(directory)],
            [RelayGate.node, RelayGate.layerWith({ scheduledTasks: true })],
            [
              SessionV2.node,
              recordingSession([], () =>
                Effect.gen(function* () {
                  yield* Deferred.succeed(entered, undefined)
                  yield* Deferred.await(release)
                  if (terminal === "old-pause")
                    return yield* new SessionRunnerModel.ModelNotSelectedError({
                      sessionID: SessionV2.ID.make("ses_controlled"),
                    })
                  if (terminal === "failure")
                    return yield* new LLMError({
                      module: "test",
                      method: "resume",
                      reason: new RateLimitReason({ message: "TEST-PRIVATE-terminal" }),
                    })
                }),
              ),
            ],
          ])
          yield* Effect.gen(function* () {
            const tasks = yield* ScheduledTaskStore.Service
            const events = yield* EventV2.Service
            yield* events.listen((event) =>
              Effect.sync(() => {
                if (event.type !== ScheduledTaskEvent.Updated.type) return
                const data = event.data as typeof ScheduledTaskEvent.Updated.data.Type
                received.push({ enabled: data.task.enabled, status: data.run?.status })
              }),
            )
            const task = yield* tasks.create(taskInput("stop-before-terminal", directory, yield* DateTime.now))
            const running = yield* tasks.runNow(task.id).pipe(Effect.forkScoped)
            yield* Deferred.await(entered)
            yield* tasks.setEnabled(task.id, false)
            if (terminal === "old-pause") yield* tasks.setEnabled(task.id, true)
            yield* Deferred.succeed(release, undefined)
            const result = yield* Fiber.join(running)
            expect(result.status).toBe(terminal === "success" ? "completed" : "failed")
            expect(received.at(-1)?.enabled).toBe(terminal === "old-pause")
            expect((yield* tasks.list())[0]?.enabled).toBe(terminal === "old-pause")
          }).pipe(Effect.provide(layer))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
}
for (const schedule of ["daily", "once"] as const) {
  for (const status of ["pending", "running", "completed", "failed", "interrupted", "missed"] as const) {
    for (const epoch of [null, 0, 1])
      scheduled.effect(
        `T19 ${schedule} consumes an existing ${status} epoch=${epoch} exact slot without execution or duplicate run notification`,
        () =>
          Effect.acquireUseRelease(
            Effect.promise(() => tmpdir()),
            (tmp) =>
              Effect.gen(function* () {
                const directory = AbsolutePath.make(tmp.path)
                const created: SessionV2.Info[] = []
                const gate = { enabled: false }
                const received: Array<{ run?: ScheduledTask.Run }> = []
                const layer = AppNodeBuilder.build(
                  LayerNode.group([ScheduledTaskStore.node, Database.node, EventV2.node, EffectFlock.node]),
                  [
                    [Database.node, Database.layerFromPath(path.join(tmp.path, "opencode.db"))],
                    [Global.node, Global.layerWith({ data: tmp.path })],
                    [ProjectV2.node, project(directory)],
                    [
                      RelayGate.node,
                      Layer.succeed(RelayGate.Service, {
                        ...RelayGate.closed,
                        get scheduledTasks() {
                          return gate.enabled
                        },
                      }),
                    ],
                    [SessionV2.node, recordingSession(created)],
                  ],
                )
                yield* Effect.gen(function* () {
                  const tasks = yield* ScheduledTaskStore.Service
                  const { db } = yield* Database.Service
                  const events = yield* EventV2.Service
                  const task = yield* tasks.create({
                    ...taskInput("same-slot", directory, yield* DateTime.now),
                    schedule,
                    runAt: DateTime.makeUnsafe(0),
                  })
                  yield* db
                    .update(ScheduledTaskTable)
                    .set({ cancel_epoch: 1 })
                    .where(eq(ScheduledTaskTable.id, task.id))
                    .run()
                    .pipe(Effect.orDie)
                  const runID = ScheduledTask.RunID.create()
                  // Current owner keeps active rows live; terminal rows also exercise historical epochs.
                  yield* db
                    .insert(ScheduledTaskRunTable)
                    .values({
                      id: runID,
                      task_id: task.id,
                      scheduled_at: 0,
                      revision: 0,
                      cancel_epoch: epoch,
                      status,
                      ...(status === "pending" || status === "running"
                        ? { owner: "scheduled-task:controlled-live" }
                        : {}),
                    })
                    .run()
                    .pipe(Effect.orDie)
                  const flock = yield* EffectFlock.Service
                  if (status === "pending" || status === "running")
                    yield* flock.acquire("scheduled-task:controlled-live", path.join(tmp.path, "locks"))
                  const before = yield* db
                    .select()
                    .from(ScheduledTaskRunTable)
                    .where(eq(ScheduledTaskRunTable.id, runID))
                    .get()
                    .pipe(Effect.orDie)
                  yield* events.listen((event) =>
                    Effect.sync(() => {
                      if (event.type === ScheduledTaskEvent.Updated.type)
                        received.push(event.data as { run?: ScheduledTask.Run })
                    }),
                  )
                  const count = created.length
                  gate.enabled = true
                  yield* ScheduledTaskStore.tickForTest(tasks)
                  yield* ScheduledTaskStore.tickForTest(tasks)
                  const rows = yield* db
                    .select()
                    .from(ScheduledTaskRunTable)
                    .where(eq(ScheduledTaskRunTable.task_id, task.id))
                    .all()
                    .pipe(Effect.orDie)
                  expect(rows).toEqual([before!])
                  expect(created.length).toBe(count)
                  expect(received).toHaveLength(1)
                  expect(received[0]?.run).toBeUndefined()
                  const current = (yield* tasks.list())[0]!
                  expect(DateTime.toEpochMillis(current.lastRun!)).toBe(0)
                  expect(current.enabled).toBe(schedule === "daily")
                  expect(current.nextRun === undefined ? undefined : DateTime.toEpochMillis(current.nextRun)).toBe(
                    schedule === "daily" ? 86_400_000 : undefined,
                  )
                }).pipe(Effect.provide(layer), Effect.scoped)
              }),
            (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
          ),
        15000,
      )
  }
}

for (const action of ["disable", "remove", "reenable"] as const) {
  for (const schedule of ["daily", "once"] as const) {
    scheduled.effect(`T16 scanned ${schedule} rejects ${action} before admission`, () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) =>
          Effect.gen(function* () {
            const directory = AbsolutePath.make(tmp.path)
            const created: SessionV2.Info[] = []
            const gate = { enabled: false }
            const layer = AppNodeBuilder.build(ScheduledTaskStore.node, [
              [Database.node, Database.layerFromPath(path.join(tmp.path, "opencode.db"))],
              [Global.node, Global.layerWith({ data: tmp.path })],
              [ProjectV2.node, project(directory)],
              [
                RelayGate.node,
                Layer.succeed(RelayGate.Service, {
                  ...RelayGate.closed,
                  get scheduledTasks() {
                    return gate.enabled
                  },
                }),
              ],
              [SessionV2.node, recordingSession(created)],
            ])
            yield* Effect.gen(function* () {
              const tasks = yield* ScheduledTaskStore.Service
              const task = yield* tasks.create({
                ...taskInput("scan-race", directory, yield* DateTime.now),
                schedule,
                runAt: DateTime.makeUnsafe(0),
              })
              gate.enabled = true
              yield* ScheduledTaskStore.tickForTest(
                tasks,
                Effect.gen(function* () {
                  if (action === "remove") return yield* tasks.remove(task.id)
                  yield* tasks.setEnabled(task.id, false).pipe(Effect.orDie)
                  if (action === "reenable") yield* tasks.setEnabled(task.id, true).pipe(Effect.orDie)
                }),
              )
              expect(created).toHaveLength(0)
              expect(yield* tasks.runs(task.id)).toEqual([])
              const current = (yield* tasks.list()).find((item) => item.id === task.id)
              if (action === "remove") expect(current).toBeUndefined()
              else {
                expect(current?.enabled).toBe(action === "reenable")
                expect(current?.nextRun).toEqual(task.nextRun)
                expect(current?.lastRun).toBeUndefined()
              }
            }).pipe(Effect.provide(layer), Effect.scoped)
          }),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
    )
  }
}

for (const mode of ["failure", "interrupt", "slow"] as const) {
  scheduled.live(
    `T18 real listener prefix ${mode} is not replayed and releases the task section`,
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) =>
          Effect.gen(function* () {
            const directory = AbsolutePath.make(tmp.path)
            const first: string[] = []
            const second: string[] = []
            const created: SessionV2.Info[] = []
            const arrived = yield* Deferred.make<void>()
            const release = yield* Deferred.make<void>()
            const armed = { value: true }
            const typed: string[] = []
            const all: string[] = []
            const typedDone = yield* Deferred.make<void>()
            const allDone = yield* Deferred.make<void>()
            const consume = yield* Deferred.make<void>()
            const layer = AppNodeBuilder.build(LayerNode.group([ScheduledTaskStore.node, EventV2.node]), [
              [Database.node, Database.layerFromPath(path.join(tmp.path, "opencode.db"))],
              [Global.node, Global.layerWith({ data: tmp.path })],
              [ProjectV2.node, project(directory)],
              [RelayGate.node, RelayGate.layerWith({ scheduledTasks: true })],
              [SessionV2.node, recordingSession(created)],
            ])
            yield* Effect.gen(function* () {
              const tasks = yield* ScheduledTaskStore.Service
              const events = yield* EventV2.Service
              const task = yield* tasks.create(taskInput("partial-delivery", directory, yield* DateTime.now))
              const subscriber = (target: string[], done: Deferred.Deferred<void>) => (event: EventV2.Payload) =>
                Effect.gen(function* () {
                  if (event.type !== ScheduledTaskEvent.Updated.type) return
                  const data = event.data as typeof ScheduledTaskEvent.Updated.data.Type
                  if (!data.run) return
                  target.push(data.run.status)
                  if (mode === "slow" && data.task.id === task.id && data.run.status === "pending")
                    yield* Deferred.await(consume)
                  if (data.task.name === "later-task" && data.run.status === "completed")
                    yield* Deferred.succeed(done, undefined)
                })
              yield* events
                .subscribe(ScheduledTaskEvent.Updated)
                .pipe(Stream.runForEach(subscriber(typed, typedDone)), Effect.forkScoped({ startImmediately: true }))
              yield* events
                .all()
                .pipe(Stream.runForEach(subscriber(all, allDone)), Effect.forkScoped({ startImmediately: true }))
              yield* events.listen((event) =>
                Effect.sync(() => {
                  if (event.type === ScheduledTaskEvent.Updated.type) {
                    const data = event.data as typeof ScheduledTaskEvent.Updated.data.Type
                    if (data.run) first.push(data.run.status)
                  }
                }),
              )
              yield* events.listen((event) =>
                Effect.gen(function* () {
                  if (event.type !== ScheduledTaskEvent.Updated.type) return
                  const data = event.data as typeof ScheduledTaskEvent.Updated.data.Type
                  if (!data.run) return
                  if (data.run.status === "pending" && armed.value) {
                    armed.value = false
                    yield* Deferred.succeed(arrived, undefined)
                    if (mode === "failure") return yield* Effect.die(new Error("T18-PRIVATE-diagnostic"))
                    yield* Deferred.await(release)
                  }
                  second.push(data.run.status)
                }),
              )
              const fiber = yield* tasks.runNow(task.id).pipe(Effect.forkScoped)
              yield* Deferred.await(arrived)
              if (mode === "interrupt") yield* Fiber.interrupt(fiber)
              else {
                yield* Deferred.succeed(release, undefined)
                const exit = yield* Fiber.await(fiber)
                expect(exit._tag).toBe(mode === "failure" ? "Failure" : "Success")
              }
              expect(first.filter((status) => status === "pending")).toHaveLength(1)
              expect(second.filter((status) => status === "pending")).toHaveLength(mode === "slow" ? 1 : 0)
              const run = (yield* tasks.runs(task.id))[0]!
              expect(run.status).toBe(mode === "slow" ? "completed" : "interrupted")
              expect(JSON.stringify(run)).not.toContain("T18-PRIVATE")
              expect(created).toHaveLength(mode === "slow" ? 1 : 0)
              yield* tasks.setEnabled(task.id, false)
              expect((yield* tasks.list())[0]?.enabled).toBe(false)
              const later = yield* tasks.create(taskInput("later-task", directory, yield* DateTime.now))
              expect((yield* tasks.runNow(later.id)).status).toBe("completed")
              yield* Deferred.succeed(consume, undefined)
              yield* Deferred.await(typedDone)
              yield* Deferred.await(allDone)
              expect(typed.filter((status) => status === "pending")).toHaveLength(mode === "slow" ? 2 : 1)
              expect(all).toEqual(typed)
            }).pipe(Effect.provide(layer), Effect.scoped)
          }),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
    15000,
  )
}

for (const action of ["stop", "reenable", "remove"] as const) {
  for (const finish of ["normal", "failure", "interrupt"] as const) {
    scheduled.live(
      `T14 terminal publication ${finish} serializes ${action} on the same task only`,
      () =>
        Effect.acquireUseRelease(
          Effect.promise(() => tmpdir()),
          (tmp) =>
            Effect.gen(function* () {
              const directory = AbsolutePath.make(tmp.path)
              const entered = yield* Deferred.make<void>()
              const release = yield* Deferred.make<void>()
              const attempting = yield* Deferred.make<void>()
              const observed: Array<{ id: string; enabled: boolean; status?: string }> = []
              const layer = AppNodeBuilder.build(LayerNode.group([ScheduledTaskStore.node, EventV2.node]), [
                [Database.node, Database.layerFromPath(path.join(tmp.path, "opencode.db"))],
                [Global.node, Global.layerWith({ data: tmp.path })],
                [ProjectV2.node, project(directory)],
                [RelayGate.node, RelayGate.layerWith({ scheduledTasks: true })],
                [SessionV2.node, recordingSession([])],
              ])
              yield* Effect.gen(function* () {
                const tasks = yield* ScheduledTaskStore.Service
                const events = yield* EventV2.Service
                const task = yield* tasks.create(taskInput("ordered", directory, yield* DateTime.now))
                yield* events.listen((event) =>
                  Effect.gen(function* () {
                    if (event.type !== ScheduledTaskEvent.Updated.type) return
                    const data = event.data as typeof ScheduledTaskEvent.Updated.data.Type
                    observed.push({ id: data.task.id, enabled: data.task.enabled, status: data.run?.status })
                    if (data.task.id !== task.id || data.run?.status !== "completed") return
                    yield* Deferred.succeed(entered, undefined)
                    yield* Deferred.await(release)
                    if (finish === "failure") return yield* Effect.die(new Error("T14-PRIVATE-notify"))
                  }),
                )
                const run = yield* tasks.runNow(task.id).pipe(Effect.forkScoped)
                yield* Deferred.await(entered)
                expect((yield* tasks.runs(task.id))[0]?.status).toBe("completed")
                const stop = yield* Deferred.succeed(attempting, undefined).pipe(
                  Effect.andThen(
                    action === "remove"
                      ? tasks.remove(task.id)
                      : tasks
                          .setEnabled(task.id, false)
                          .pipe(Effect.andThen(action === "reenable" ? tasks.setEnabled(task.id, true) : Effect.void)),
                  ),
                  Effect.forkScoped,
                )
                yield* Deferred.await(attempting)
                expect(stop.pollUnsafe()).toBeUndefined()
                const other = yield* tasks.create(taskInput("independent", directory, yield* DateTime.now))
                expect(other.id).not.toBe(task.id)
                if (finish === "interrupt") yield* Fiber.interrupt(run)
                else {
                  yield* Deferred.succeed(release, undefined)
                  expect((yield* Fiber.await(run))._tag).toBe(finish === "failure" ? "Failure" : "Success")
                }
                yield* Fiber.join(stop)
                if (action !== "remove") {
                  expect((yield* tasks.runs(task.id))[0]?.status).toBe("completed")
                  expect((yield* tasks.list()).find((item) => item.id === task.id)?.enabled).toBe(action === "reenable")
                  expect(observed.filter((entry) => entry.id === task.id).at(-1)?.enabled).toBe(action === "reenable")
                  yield* tasks.remove(task.id)
                }
                expect(observed.filter((entry) => entry.id === task.id && entry.status === "completed")).toHaveLength(1)
                expect((yield* tasks.list()).some((item) => item.id === task.id)).toBe(false)
              }).pipe(Effect.provide(layer), Effect.scoped)
            }),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        ),
      15000,
    )
  }
}
for (const schedule of ["daily", "once"] as const) {
  for (const order of ["manual-first", "automatic-first", "rollback", "notification-failure", "non-exact"] as const) {
    scheduled.effect(
      `T19 ${schedule} ${order} uses one atomic admission and advance`,
      () =>
        Effect.acquireUseRelease(
          Effect.promise(() => tmpdir()),
          (tmp) =>
            Effect.gen(function* () {
              const directory = AbsolutePath.make(tmp.path)
              const created: SessionV2.Info[] = []
              const gate = { enabled: false }
              const completed = yield* Deferred.make<void>()
              const nextCompleted = yield* Deferred.make<void>()
              const notifications = { failed: false, completed: 0 }
              const layer = AppNodeBuilder.build(
                LayerNode.group([ScheduledTaskStore.node, Database.node, EventV2.node]),
                [
                  [Database.node, Database.layerFromPath(path.join(tmp.path, "opencode.db"))],
                  [Global.node, Global.layerWith({ data: tmp.path })],
                  [ProjectV2.node, project(directory)],
                  [
                    RelayGate.node,
                    Layer.succeed(RelayGate.Service, {
                      ...RelayGate.closed,
                      get scheduledTasks() {
                        return gate.enabled
                      },
                    }),
                  ],
                  [SessionV2.node, recordingSession(created)],
                ],
              )
              yield* Effect.gen(function* () {
                const tasks = yield* ScheduledTaskStore.Service
                const { db } = yield* Database.Service
                const events = yield* EventV2.Service
                const task = yield* tasks.create({
                  ...taskInput("order", directory, yield* DateTime.now),
                  schedule,
                  runAt: DateTime.makeUnsafe(order === "non-exact" ? 1 : 0),
                })
                yield* events.listen((event) =>
                  Effect.gen(function* () {
                    if (event.type !== ScheduledTaskEvent.Updated.type) return
                    const data = event.data as typeof ScheduledTaskEvent.Updated.data.Type
                    if (data.task.id !== task.id) return
                    if (order === "notification-failure" && data.run?.status === "pending" && !notifications.failed) {
                      notifications.failed = true
                      return yield* Effect.die(new Error("controlled publication failure"))
                    }
                    if (data.run?.status === "completed") {
                      notifications.completed++
                      yield* Deferred.succeed(notifications.completed === 1 ? completed : nextCompleted, undefined)
                    }
                  }),
                )
                gate.enabled = true
                if (order === "manual-first" || order === "non-exact")
                  expect((yield* tasks.runNow(task.id)).status).toBe("completed")
                if (order === "non-exact") yield* adjust("1 milli")
                if (order === "rollback") {
                  yield* db
                    .run(
                      "CREATE TRIGGER reject_advance BEFORE UPDATE OF next_run ON scheduled_task BEGIN SELECT RAISE(ABORT, 'controlled rollback'); END",
                    )
                    .pipe(Effect.orDie)
                  yield* ScheduledTaskStore.tickForTest(tasks)
                  expect(yield* tasks.runs(task.id)).toEqual([])
                  expect(created).toHaveLength(0)
                  expect((yield* tasks.list())[0]?.nextRun).toEqual(task.nextRun)
                  yield* db.run("DROP TRIGGER reject_advance").pipe(Effect.orDie)
                }
                yield* Effect.all([ScheduledTaskStore.tickForTest(tasks), ScheduledTaskStore.tickForTest(tasks)], {
                  concurrency: 2,
                })
                if (order !== "notification-failure")
                  yield* Deferred.await(order === "non-exact" ? nextCompleted : completed)
                if (order === "automatic-first") {
                  const exit = yield* tasks.runNow(task.id).pipe(Effect.exit)
                  expect(exit._tag).toBe("Failure")
                  if (Exit.isFailure(exit))
                    expect(Cause.pretty(exit.cause)).toContain(schedule === "once" ? "DisabledError" : "ConflictError")
                }
                const runs = yield* tasks.runs(task.id)
                expect(runs).toHaveLength(order === "non-exact" ? 2 : 1)
                expect(runs[0]?.status).toBe(order === "notification-failure" ? "interrupted" : "completed")
                expect(created).toHaveLength(order === "notification-failure" ? 0 : order === "non-exact" ? 2 : 1)
                const current = (yield* tasks.list())[0]!
                expect(current.enabled).toBe(schedule === "daily")
                expect(current.lastRun).toEqual(DateTime.makeUnsafe(order === "non-exact" ? 1 : 0))
                expect(current.nextRun).toEqual(
                  schedule === "daily" ? DateTime.makeUnsafe(86_400_000 + (order === "non-exact" ? 1 : 0)) : undefined,
                )
                if (schedule === "daily" && order === "manual-first") {
                  yield* adjust("1 day")
                  yield* ScheduledTaskStore.tickForTest(tasks)
                  yield* Deferred.await(nextCompleted)
                  expect(created).toHaveLength(2)
                  expect((yield* tasks.runs(task.id)).map((run) => run.status)).toEqual(["completed", "completed"])
                }
              }).pipe(Effect.provide(layer), Effect.scoped)
            }),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        ),
      15000,
    )
  }
}

for (const schedule of ["daily", "once"] as const) {
  scheduled.effect(`T19 ${schedule} restart consumes the persisted exact slot without replay`, () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const directory = AbsolutePath.make(tmp.path)
          const created: SessionV2.Info[] = []
          const gate = { enabled: false }
          const layer = AppNodeBuilder.build(LayerNode.group([ScheduledTaskStore.node, Database.node, EventV2.node]), [
            [Database.node, Database.layerFromPath(path.join(tmp.path, "opencode.db"))],
            [Global.node, Global.layerWith({ data: tmp.path })],
            [ProjectV2.node, project(directory)],
            [
              RelayGate.node,
              Layer.succeed(RelayGate.Service, {
                ...RelayGate.closed,
                get scheduledTasks() {
                  return gate.enabled
                },
              }),
            ],
            [SessionV2.node, recordingSession(created)],
          ])
          const task = yield* Effect.gen(function* () {
            const tasks = yield* ScheduledTaskStore.Service
            const database = yield* Database.Service
            const task = yield* tasks.create({
              ...taskInput("restart-slot", directory, yield* DateTime.now),
              schedule,
              runAt: DateTime.makeUnsafe(0),
            })
            yield* database.db
              .insert(ScheduledTaskRunTable)
              .values({
                id: ScheduledTask.RunID.create(),
                task_id: task.id,
                scheduled_at: 0,
                revision: 0,
                cancel_epoch: 0,
                status: "completed",
              })
              .run()
              .pipe(Effect.orDie)
            return task
          }).pipe(Effect.provide(layer), Effect.scoped)
          yield* Effect.gen(function* () {
            const tasks = yield* ScheduledTaskStore.Service
            const events = yield* EventV2.Service
            const received: unknown[] = []
            yield* events.listen((event) =>
              Effect.sync(() => {
                if (event.type === ScheduledTaskEvent.Updated.type) received.push(event.data)
              }),
            )
            gate.enabled = true
            yield* ScheduledTaskStore.tickForTest(tasks)
            yield* ScheduledTaskStore.tickForTest(tasks)
            const runs = yield* tasks.runs(task.id)
            expect(runs).toHaveLength(1)
            expect(runs[0]?.status).toBe("completed")
            expect(created).toHaveLength(0)
            expect(received).toHaveLength(1)
            const current = (yield* tasks.list())[0]!
            expect(current.enabled).toBe(schedule === "daily")
            expect(current.nextRun === undefined ? undefined : DateTime.toEpochMillis(current.nextRun)).toBe(
              schedule === "daily" ? 86_400_000 : undefined,
            )
          }).pipe(Effect.provide(layer), Effect.scoped)
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
}
