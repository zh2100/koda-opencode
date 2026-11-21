import { describe, expect } from "bun:test"
import path from "path"
import { DateTime, Deferred, Effect, Exit, Fiber, Layer, Stream } from "effect"
import { eq, sql } from "drizzle-orm"
import { Prompt } from "@opencode-ai/schema/prompt"
import { ScheduledTask } from "@opencode-ai/schema/scheduled-task"
import { ScheduledTaskEvent } from "@opencode-ai/schema/scheduled-task-event"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { Global } from "@opencode-ai/core/global"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { RelayCatalog } from "@opencode-ai/core/relay-catalog"
import { RelayError } from "@opencode-ai/schema/relay-error"
import { RelayGate } from "@opencode-ai/core/relay-gate"
import { ScheduledTaskRunTable, ScheduledTaskTable } from "@opencode-ai/core/scheduled-task/sql"
import { ScheduledTaskStore } from "@opencode-ai/core/scheduled-task"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionInput } from "@opencode-ai/schema/session-input"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const it = testEffect(Layer.empty)

const recordingSession = (
  created: SessionV2.Info[],
  hooks?: {
    create?: SessionV2.Interface["create"]
    prompt?: SessionV2.Interface["prompt"]
    resume?: SessionV2.Interface["resume"]
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
          time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
          title: "scheduled",
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
            delivery: "steer",
            timeCreated: DateTime.makeUnsafe(0),
          }),
        )
      },
      shell: () => Effect.void,
      skill: () => Effect.void,
      compact: () => Effect.void,
      wait: () => Effect.void,
      active: Effect.succeed(new Set()),
      resume: hooks?.resume ?? (() => Effect.void),
      interrupt: () => Effect.void,
      revert: { stage: () => Effect.die("unused"), clear: () => Effect.void, commit: () => Effect.void },
    }),
  )

const open = (
  root: string,
  created: SessionV2.Info[],
  hooks?: Parameters<typeof recordingSession>[1],
  catalog?: Layer.Layer<RelayCatalog.Service>,
  database = path.join(root, "opencode.db"),
) =>
  AppNodeBuilder.build(LayerNode.group([ScheduledTaskStore.node, Database.node, EventV2.node]), [
    [Database.node, Database.layerFromPath(database)],
    [Global.node, Global.layerWith({ data: root })],
    [
      ProjectV2.node,
      Layer.succeed(
        ProjectV2.Service,
        ProjectV2.Service.of({
          directories: () => Effect.die("unused"),
          resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.make(directory), directory }),
          commit: () => Effect.void,
        }),
      ),
    ],
    [RelayGate.node, RelayGate.layerWith({ scheduledTasks: true })],
    [SessionV2.node, recordingSession(created, hooks)],
    ...(catalog ? [[RelayCatalog.node, catalog] as const] : []),
  ])

const input = (name: string, directory: AbsolutePath, now: DateTime.Utc, schedule: "once" | "daily" = "daily") => ({
  name,
  projectID: ProjectV2.ID.make(directory),
  location: { directory },
  prompt: Prompt.make({ text: name }),
  schedule,
  timezone: "UTC",
  runAt: schedule === "once" ? DateTime.subtract(now, { minutes: 1 }) : DateTime.add(now, { hours: 2 }),
  model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.openai },
  approvalMode: "auto" as const,
  enabled: true,
})

const untilPending = (tasks: ScheduledTaskStore.Interface, id: ScheduledTask.ID) =>
  tasks
    .runs(id)
    .pipe(Effect.repeat({ until: (runs) => runs.some((run) => run.status === "pending") }), Effect.timeout("5 seconds"))

const releaseProject = (tasks: ScheduledTaskStore.Interface, projectID: string) =>
  ScheduledTaskStore.releaseProjectLockForTest(tasks)(projectID)

const epoch = (database: Database.Interface, id: ScheduledTask.ID) =>
  database.db
    .select({ cancel_epoch: ScheduledTaskTable.cancel_epoch })
    .from(ScheduledTaskTable)
    .where(eq(ScheduledTaskTable.id, id))
    .get()
    .pipe(Effect.orDie)

describe("ScheduledTask cancel epoch", () => {
  it.live("T01 interrupts a pending once task while another project task holds the lock", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const created: SessionV2.Info[] = []
          const entered = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const directory = AbsolutePath.make(tmp.path)
          const observed = yield* Effect.gen(function* () {
            const tasks = yield* ScheduledTaskStore.Service
            const now = yield* DateTime.now
            const holder = yield* tasks.create(input("holder", directory, DateTime.toUtc(now)))
            const target = yield* tasks.create({
              ...input("target", directory, DateTime.toUtc(now), "once"),
              runAt: DateTime.add(now, { hours: 2 }),
            })
            const first = yield* tasks.runNow(holder.id).pipe(Effect.forkChild)
            yield* Deferred.await(entered).pipe(Effect.timeout("5 seconds"))
            const pending = yield* tasks.runNow(target.id).pipe(Effect.forkChild)
            yield* tasks
              .runs(target.id)
              .pipe(
                Effect.repeat({ until: (runs) => runs.some((run) => run.status === "pending") }),
                Effect.timeout("5 seconds"),
              )
            const before = created.length
            yield* tasks.setEnabled(target.id, false)
            yield* Deferred.succeed(release, undefined)
            yield* Fiber.join(first).pipe(Effect.timeout("5 seconds"))
            const second = yield* Fiber.join(pending).pipe(Effect.exit)
            return {
              before,
              created: created.length,
              target: (yield* tasks.runs(target.id))[0]?.status,
              holder: (yield* tasks.runs(holder.id))[0]?.status,
              second: second._tag,
            }
          }).pipe(
            Effect.provide(
              open(tmp.path, created, {
                resume: () =>
                  Effect.gen(function* () {
                    yield* Deferred.succeed(entered, undefined)
                    yield* Deferred.await(release)
                  }),
              }),
            ),
            Effect.ensuring(Deferred.succeed(release, undefined)),
          )
          expect(observed.before).toBe(1)
          expect(observed.created).toBe(1)
          expect(observed.target).toBe("interrupted")
          expect(observed.holder).toBe("completed")
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("T02 completes an automatic once claim after advance disables the task", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const created: SessionV2.Info[] = []
          const directory = AbsolutePath.make(tmp.path)
          const result = yield* Effect.gen(function* () {
            const tasks = yield* ScheduledTaskStore.Service
            const database = yield* Database.Service
            const task = yield* tasks.create(input("once", directory, DateTime.toUtc(yield* DateTime.now), "once"))
            yield* Effect.sleep("40 millis")
            return {
              enabled: (yield* tasks.list()).find((item) => item.id === task.id)?.enabled,
              status: (yield* tasks.runs(task.id))[0]?.status,
              epoch: (yield* epoch(database, task.id))?.cancel_epoch,
              sessions: created.length,
              error: (yield* tasks.runs(task.id))[0]?.error?.details,
            }
          }).pipe(Effect.provide(open(tmp.path, created)))
          expect(result.error).toBeUndefined()
          expect(result.enabled).toBe(false)
          expect(result.status).toBe("completed")
          expect(result.epoch).toBe(0)
          expect(result.sessions).toBe(1)
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("T03 cancels a pending once claim when disable is called after automatic advance", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const created: SessionV2.Info[] = []
          const entered = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const directory = AbsolutePath.make(tmp.path)
          const result = yield* Effect.gen(function* () {
            const tasks = yield* ScheduledTaskStore.Service
            const database = yield* Database.Service
            const task = yield* tasks.create({
              ...input("once-disable", directory, DateTime.toUtc(yield* DateTime.now), "once"),
              runAt: DateTime.add(yield* DateTime.now, { hours: 3 }),
            })
            const held = yield* ScheduledTaskStore.projectLockForTest(tasks)(task.projectID).pipe(Effect.forkChild)
            const running = yield* tasks.runNow(task.id).pipe(Effect.forkChild)
            yield* untilPending(tasks, task.id)
            const before = (yield* epoch(database, task.id))?.cancel_epoch
            yield* tasks.setEnabled(task.id, false)
            yield* releaseProject(tasks, task.projectID)
            yield* Fiber.join(held).pipe(Effect.timeout("5 seconds"))
            yield* Fiber.join(running).pipe(Effect.timeout("5 seconds"))
            return {
              before,
              after: (yield* epoch(database, task.id))?.cancel_epoch,
              status: (yield* tasks.runs(task.id))[0]?.status,
              sessions: created.length,
            }
          }).pipe(
            Effect.provide(
              open(tmp.path, created, {
                create: () =>
                  Effect.gen(function* () {
                    yield* Deferred.succeed(entered, undefined)
                    yield* Deferred.await(release)
                    return yield* Effect.die("should not create")
                  }),
              }),
            ),
            Effect.ensuring(Deferred.succeed(release, undefined)),
          )
          expect(result.before).toBe(0)
          expect(result.after).toBe(1)
          expect(result.status).toBe("interrupted")
          expect(result.sessions).toBe(0)
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("T04 does not revive an interrupted claim when the task is enabled again", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const created: SessionV2.Info[] = []
          const directory = AbsolutePath.make(tmp.path)
          const result = yield* Effect.gen(function* () {
            const tasks = yield* ScheduledTaskStore.Service
            const task = yield* tasks.create(input("revive", directory, DateTime.toUtc(yield* DateTime.now)))
            const held = yield* ScheduledTaskStore.projectLockForTest(tasks)(task.projectID).pipe(Effect.forkChild)
            const running = yield* tasks.runNow(task.id).pipe(Effect.forkChild)
            yield* untilPending(tasks, task.id)
            yield* tasks.setEnabled(task.id, false)
            yield* releaseProject(tasks, task.projectID)
            yield* Fiber.join(held).pipe(Effect.timeout("5 seconds"))
            yield* Fiber.join(running).pipe(Effect.exit)
            const old = (yield* tasks.runs(task.id))[0]
            yield* tasks.setEnabled(task.id, true)
            const next = yield* Effect.gen(function* () {
              const deadline = Date.now() + 1500
              while (Date.now() < deadline) {
                const attempt = yield* tasks.runNow(task.id).pipe(Effect.exit)
                if (attempt._tag === "Success" && attempt.value.id !== old?.id) return attempt.value
              }
              return yield* Effect.die("new claim did not land in the next scheduled second")
            })
            return { old: old?.status, next: next.status, revived: next.id === old?.id, sessions: created.length }
          }).pipe(Effect.provide(open(tmp.path, created)))
          expect(result.old).toBe("interrupted")
          expect(result.next).toBe("completed")
          expect(result.revived).toBe(false)
          expect(result.sessions).toBe(1)
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("T05 deletes a pending task before session creation and publishes no completion", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const created: SessionV2.Info[] = []
          const directory = AbsolutePath.make(tmp.path)
          const result = yield* Effect.gen(function* () {
            const tasks = yield* ScheduledTaskStore.Service
            const events = yield* EventV2.Service
            const published = new Array<EventV2.Payload>()
            yield* events.subscribe(ScheduledTaskEvent.Updated).pipe(
              Stream.runForEach((event) => Effect.sync(() => published.push(event))),
              Effect.forkScoped,
            )
            const task = yield* tasks.create(input("removed", directory, DateTime.toUtc(yield* DateTime.now)))
            const held = yield* ScheduledTaskStore.projectLockForTest(tasks)(task.projectID).pipe(Effect.forkChild)
            const running = yield* tasks.runNow(task.id).pipe(Effect.forkChild)
            yield* untilPending(tasks, task.id)
            yield* tasks.remove(task.id)
            yield* releaseProject(tasks, task.projectID)
            yield* Fiber.join(held).pipe(Effect.timeout("5 seconds"))
            yield* Fiber.join(running).pipe(Effect.exit)
            return {
              sessions: created.length,
              runs: (yield* tasks.runs(task.id)).length,
              completions: published
                .filter(
                  (event): event is EventV2.Payload<typeof ScheduledTaskEvent.Updated> =>
                    event.type === ScheduledTaskEvent.Updated.type,
                )
                .filter((event) => event.data.run?.status === "completed" && event.data.task.id === task.id).length,
            }
          }).pipe(
            Effect.provide(
              open(tmp.path, created, {
                create: () => Effect.die("should not create"),
              }),
            ),
          )
          expect(result.sessions).toBe(0)
          expect(result.runs).toBe(0)
          expect(result.completions).toBe(0)
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("T06 interrupts a pending daily claim on explicit disable", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const created: SessionV2.Info[] = []
          const release = yield* Deferred.make<void>()
          const directory = AbsolutePath.make(tmp.path)
          const status = yield* Effect.gen(function* () {
            const tasks = yield* ScheduledTaskStore.Service
            const task = yield* tasks.create(input("daily-disable", directory, DateTime.toUtc(yield* DateTime.now)))
            const held = yield* ScheduledTaskStore.projectLockForTest(tasks)(task.projectID).pipe(Effect.forkChild)
            const running = yield* tasks.runNow(task.id).pipe(Effect.forkChild)
            yield* untilPending(tasks, task.id)
            yield* tasks.setEnabled(task.id, false)
            yield* releaseProject(tasks, task.projectID)
            yield* Fiber.join(held).pipe(Effect.timeout("5 seconds"))
            yield* Fiber.join(running).pipe(Effect.exit)
            return (yield* tasks.runs(task.id))[0]?.status
          }).pipe(
            Effect.provide(
              open(tmp.path, created, {
                create: () =>
                  Effect.gen(function* () {
                    yield* Deferred.await(release)
                    return yield* Effect.die("should not create")
                  }),
              }),
            ),
            Effect.ensuring(Deferred.succeed(release, undefined)),
          )
          expect(status).toBe("interrupted")
          expect(created).toHaveLength(0)
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("T07 keeps a claim that became running before disable and cancels one still pending", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const created: SessionV2.Info[] = []
          const started = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const directory = AbsolutePath.make(tmp.path)
          const result = yield* Effect.gen(function* () {
            const tasks = yield* ScheduledTaskStore.Service
            const database = yield* Database.Service
            const now = DateTime.toUtc(yield* DateTime.now)
            const runningTask = yield* tasks.create(input("already-running", directory, now))
            const pendingTask = yield* tasks.create({
              ...input("still-pending", AbsolutePath.make(path.join(tmp.path, "other")), now),
            })
            const running = yield* tasks.runNow(runningTask.id).pipe(Effect.forkChild)
            yield* Deferred.await(started).pipe(Effect.timeout("5 seconds"))
            const held = yield* ScheduledTaskStore.projectLockForTest(tasks)(pendingTask.projectID).pipe(
              Effect.forkChild,
            )
            const pending = yield* tasks.runNow(pendingTask.id).pipe(Effect.forkChild)
            yield* untilPending(tasks, pendingTask.id)
            yield* tasks.setEnabled(runningTask.id, false)
            yield* tasks.setEnabled(pendingTask.id, false)
            yield* releaseProject(tasks, pendingTask.projectID)
            yield* Fiber.join(held).pipe(Effect.timeout("5 seconds"))
            yield* Deferred.succeed(release, undefined)
            yield* Fiber.join(running).pipe(Effect.timeout("5 seconds"))
            yield* Fiber.join(pending).pipe(Effect.exit)
            return {
              running: (yield* tasks.runs(runningTask.id))[0]?.status,
              pending: (yield* tasks.runs(pendingTask.id))[0]?.status,
              sessions: created.length,
              runningEpoch: (yield* epoch(database, runningTask.id))?.cancel_epoch,
            }
          }).pipe(
            Effect.provide(
              open(tmp.path, created, {
                resume: () =>
                  Effect.gen(function* () {
                    yield* Deferred.succeed(started, undefined)
                    yield* Deferred.await(release)
                  }),
                create: (sessionInput) =>
                  Effect.gen(function* () {
                    if (sessionInput.location.directory !== directory) {
                      yield* Deferred.await(release)
                      return yield* Effect.die("pending blocked")
                    }
                    const info = SessionV2.Info.make({
                      id: SessionV2.ID.descending(),
                      projectID: ProjectV2.ID.global,
                      cost: 0,
                      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                      time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
                      title: "running",
                      approvalMode: sessionInput.approvalMode,
                      location: sessionInput.location,
                    })
                    created.push(info)
                    return info
                  }),
              }),
            ),
            Effect.ensuring(Deferred.succeed(release, undefined)),
          )
          expect(result.running).toBe("completed")
          expect(result.pending).toBe("interrupted")
          expect(result.sessions).toBe(1)
          expect(result.runningEpoch).toBe(1)
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("T08 leaves a running claim running when the task is disabled", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const created: SessionV2.Info[] = []
          const prompts: string[] = []
          const started = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const directory = AbsolutePath.make(tmp.path)
          const result = yield* Effect.gen(function* () {
            const tasks = yield* ScheduledTaskStore.Service
            const task = yield* tasks.create(input("running-disable", directory, DateTime.toUtc(yield* DateTime.now)))
            const running = yield* tasks.runNow(task.id).pipe(Effect.forkChild)
            yield* Deferred.await(started).pipe(Effect.timeout("5 seconds"))
            const before = (yield* tasks.runs(task.id))[0]?.status
            yield* tasks.setEnabled(task.id, false)
            const during = (yield* tasks.runs(task.id))[0]
            yield* Deferred.succeed(release, undefined)
            yield* Fiber.join(running).pipe(Effect.timeout("5 seconds"))
            return {
              before,
              during: during?.status,
              session: during?.sessionId,
              prompts: prompts.length,
              sessions: created.length,
            }
          }).pipe(
            Effect.provide(
              open(tmp.path, created, {
                prompt: (input) =>
                  Effect.sync(() => {
                    prompts.push(input.sessionID)
                    return SessionInput.Admitted.make({
                      admittedSeq: 0,
                      id: SessionMessage.ID.make("msg_once"),
                      sessionID: input.sessionID,
                      prompt: Prompt.make({ text: input.prompt.text }),
                      delivery: "steer",
                      timeCreated: DateTime.makeUnsafe(0),
                    })
                  }),
                resume: () =>
                  Effect.gen(function* () {
                    yield* Deferred.succeed(started, undefined)
                    yield* Deferred.await(release)
                  }),
              }),
            ),
            Effect.ensuring(Deferred.succeed(release, undefined)),
          )
          expect(result.before).toBe("running")
          expect(result.during).toBe("running")
          expect(result.session).toBeDefined()
          expect(result.prompts).toBe(1)
          expect(result.sessions).toBe(1)
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("T11 interrupts a historical pending row with a null epoch and does not replay it", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const created: SessionV2.Info[] = []
          const directory = AbsolutePath.make(tmp.path)
          const result = yield* Effect.gen(function* () {
            const tasks = yield* ScheduledTaskStore.Service
            const database = yield* Database.Service
            const task = yield* tasks.create(input("historical", directory, DateTime.toUtc(yield* DateTime.now)))
            const id = ScheduledTask.RunID.create()
            yield* database.db
              .insert(ScheduledTaskRunTable)
              .values({ id, task_id: task.id, scheduled_at: 1, revision: 0, status: "pending", cancel_epoch: null })
              .run()
              .pipe(Effect.orDie)
            yield* ScheduledTaskStore.recoverForTest(tasks)(task.id)
            const next = yield* tasks.runNow(task.id)
            return {
              old: (yield* tasks.runs(task.id)).find((run) => run.id === id)?.status,
              next: next.id === id ? "same" : next.status,
              sessions: created.length,
            }
          }).pipe(Effect.provide(open(tmp.path, created)))
          expect(result.old).toBe("interrupted")
          expect(result.next).toBe("completed")
          expect(result.sessions).toBe(1)
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("T13 interrupts pending claims when an unavailable model pauses the task", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const created: SessionV2.Info[] = []
          const directory = AbsolutePath.make(tmp.path)
          const catalog = Layer.succeed(
            RelayCatalog.Service,
            RelayCatalog.Service.of({
              candidates: () => Effect.succeed([]),
              managed: () => Effect.succeed([]),
              hasManaged: () => true,
              visible: () => false,
              refresh: () => Effect.die("unused"),
              probe: () => Effect.die("unused"),
              setVisibility: () => Effect.die("unused"),
              synchronize: () => Effect.die("unexpected relay sync in this fixture"),
              syncVendors: () => Effect.die("unused"),
              apply: () => undefined,
            }),
          )
          const result = yield* Effect.gen(function* () {
            const tasks = yield* ScheduledTaskStore.Service
            const database = yield* Database.Service
            const task = yield* tasks.create({
              ...input("paused", directory, DateTime.toUtc(yield* DateTime.now)),
              model: { id: ModelV2.ID.make("hidden"), providerID: ProviderV2.ID.leidiandonghua },
            })
            const queued = ScheduledTask.RunID.create()
            yield* database.db
              .insert(ScheduledTaskRunTable)
              .values({
                id: queued,
                task_id: task.id,
                scheduled_at: 2,
                revision: 0,
                status: "pending",
                cancel_epoch: 0,
                owner: "queued",
              })
              .run()
              .pipe(Effect.orDie)
            const finished = yield* tasks.runNow(task.id)
            return {
              status: finished.status,
              code: finished.error?.code,
              enabled: (yield* tasks.list()).find((item) => item.id === task.id)?.enabled,
              queued: (yield* tasks.runs(task.id)).find((run) => run.id === queued)?.status,
              epoch: (yield* epoch(database, task.id))?.cancel_epoch,
              sessions: created.length,
            }
          }).pipe(Effect.provide(open(tmp.path, created, undefined, catalog)))
          expect(result.status).toBe("failed")
          expect(result.code).toBe("MODEL_UNAVAILABLE")
          expect(result.enabled).toBe(false)
          expect(result.queued).toBe("interrupted")
          expect(result.epoch).toBe(1)
          expect(result.sessions).toBe(0)
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("T09 keeps cancel epochs when two processes disable and claim together", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const database = path.join(tmp.path, "shared.sqlite")
          const ready = path.join(tmp.path, "ready.json")
          const release = path.join(tmp.path, "release.json")
          yield* Effect.promise(() => Bun.write(release, ""))
          const child = Bun.spawn(
            [
              process.execPath,
              path.join(import.meta.dir, "fixture", "scheduled-cancel-worker.ts"),
              database,
              ready,
              release,
            ],
            {
              cwd: path.join(import.meta.dir, ".."),
              env: { ...process.env, OPENCODE_DB: database, OPENCODE_DISABLE_MODELS_FETCH: "true" },
              stdout: "pipe",
              stderr: "pipe",
            },
          )
          const output = new Array<string>()
          const stderr = new Array<string>()
          child.stdout
            .pipeTo(new WritableStream({ write: (chunk) => void output.push(new TextDecoder().decode(chunk)) }))
            .catch(() => undefined)
          child.stderr
            .pipeTo(new WritableStream({ write: (chunk) => void stderr.push(new TextDecoder().decode(chunk)) }))
            .catch(() => undefined)
          const readyTask = yield* Effect.promise(async () => {
            const deadline = Date.now() + 10_000
            while (Date.now() < deadline) {
              const text = await Bun.file(ready)
                .text()
                .catch(() => "")
              if (text.startsWith("stk_")) return text
              await Bun.sleep(20)
            }
            throw new Error(stderr.join("") || output.join("") || "worker did not become ready")
          })
          const parent = yield* Effect.gen(function* () {
            const tasks = yield* ScheduledTaskStore.Service
            const db = yield* Database.Service
            const task = (yield* tasks.list()).find((item) => item.id === readyTask)
            if (!task) return yield* Effect.die(`worker task missing: ${readyTask}`)
            const claimed = yield* tasks.runNow(task.id).pipe(Effect.exit)
            yield* tasks.setEnabled(task.id, false)
            yield* tasks.setEnabled(task.id, false)
            return { claimed: claimed._tag }
          }).pipe(Effect.provide(open(tmp.path, [], undefined, undefined, database)))
          yield* Effect.promise(() => Bun.write(release, "go"))
          const childExit = yield* Effect.promise(() => child.exited)
          if (childExit !== 0) return yield* Effect.die(stderr.join("") || output.join(""))
          const reported = JSON.parse(output.join("")) as { epoch: number; pending: number }
          const settled = yield* Effect.gen(function* () {
            const db = yield* Database.Service
            const tasks = yield* ScheduledTaskStore.Service
            return {
              epoch: (yield* epoch(db, ScheduledTask.ID.make(readyTask)))?.cancel_epoch,
              runs: yield* tasks.runs(ScheduledTask.ID.make(readyTask)),
            }
          }).pipe(Effect.provide(open(tmp.path, [], undefined, undefined, database)))
          const active = settled.runs.filter((run) => run.status === "pending" || run.status === "running")
          expect(settled.epoch).toBe(reported.epoch)
          expect(settled.epoch).toBeGreaterThanOrEqual(2)
          expect(childExit).toBe(0)
          expect(parent.claimed).toMatch(/Success|Failure/)
          expect(active).toHaveLength(0)
          expect(reported.pending).toBe(0)
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("T10 releases the project lock after create, prompt, and resume failures", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const stages = ["create", "prompt", "resume", "cancel"] as const
          for (const stage of stages) {
            const created: SessionV2.Info[] = []
            const started = yield* Deferred.make<void>()
            const release = yield* Deferred.make<void>()
            const directory = AbsolutePath.make(path.join(tmp.path, stage))
            const nextDirectory = AbsolutePath.make(path.join(tmp.path, `${stage}-next`))
            yield* Effect.promise(() => Bun.write(path.join(nextDirectory, ".keep"), ""))
            const result = yield* Effect.gen(function* () {
              const tasks = yield* ScheduledTaskStore.Service
              const now = DateTime.toUtc(yield* DateTime.now)
              const task = yield* tasks.create(input(stage, directory, now))
              const running = yield* tasks.runNow(task.id).pipe(Effect.forkChild)
              if (stage === "cancel") {
                yield* Deferred.await(started).pipe(Effect.timeout("5 seconds"))
                yield* Fiber.interrupt(running)
              }
              yield* Fiber.join(running).pipe(Effect.exit, Effect.timeout("5 seconds"))
              const next = yield* tasks.create(input(`${stage}-next`, nextDirectory, now))
              const followed = yield* tasks.runNow(next.id)
              return {
                first: (yield* tasks.runs(task.id))[0]?.status,
                followed: followed.status,
                sessions: created.filter((item) => item.location.directory === directory).length,
              }
            }).pipe(
              Effect.provide(
                open(tmp.path, created, {
                  create: (sessionInput) =>
                    sessionInput.location.directory === directory && stage === "create"
                      ? Effect.die("create failed")
                      : recordingCreate(created)(sessionInput),
                  prompt: (promptInput) =>
                    created.some(
                      (item) => item.id === promptInput.sessionID && item.location.directory === directory,
                    ) && stage === "prompt"
                      ? Effect.die("prompt failed")
                      : recordingPrompt()(promptInput),
                  resume: (sessionID) =>
                    created.some((item) => item.id === sessionID && item.location.directory === directory) &&
                    stage === "resume"
                      ? Effect.die("resume failed")
                      : stage === "cancel" &&
                          created.some((item) => item.id === sessionID && item.location.directory === directory)
                        ? Effect.gen(function* () {
                            yield* Deferred.succeed(started, undefined)
                            return yield* Deferred.await(release)
                          })
                        : Effect.void,
                }),
              ),
              Effect.ensuring(Deferred.succeed(release, undefined)),
            )
            expect(result.followed).toBe("completed")
            expect(["failed", "interrupted"]).toContain(result.first)
          }
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("T12 keeps same-project serial execution and cross-project overlap", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const created: SessionV2.Info[] = []
          const entered = yield* Deferred.make<string>()
          const release = yield* Deferred.make<void>()
          const directory = AbsolutePath.make(path.join(tmp.path, "same"))
          const other = AbsolutePath.make(path.join(tmp.path, "other"))
          yield* Effect.promise(() => Bun.write(path.join(other, ".keep"), ""))
          const result = yield* Effect.gen(function* () {
            const tasks = yield* ScheduledTaskStore.Service
            const now = DateTime.toUtc(yield* DateTime.now)
            const first = yield* tasks.create(input("first", directory, now))
            const second = yield* tasks.create(input("second", directory, now))
            const parallel = yield* tasks.create(input("parallel", other, now))
            const held = yield* ScheduledTaskStore.projectLockForTest(tasks)(first.projectID).pipe(Effect.forkChild)
            const claimed = yield* tasks.runNow(first.id).pipe(Effect.forkChild)
            yield* untilPending(tasks, first.id)
            const overlap = yield* tasks.runNow(parallel.id).pipe(Effect.forkChild)
            yield* Deferred.await(entered).pipe(Effect.timeout("5 seconds"))
            const queued = yield* tasks.runNow(second.id).pipe(Effect.forkChild)
            yield* untilPending(tasks, second.id)
            const whileHeld = (yield* tasks.runs(second.id))[0]?.status
            yield* releaseProject(tasks, first.projectID)
            yield* Fiber.join(held).pipe(Effect.timeout("5 seconds"))
            yield* Deferred.succeed(release, undefined)
            const finished = yield* Fiber.join(claimed).pipe(Effect.timeout("5 seconds"))
            const overlapped = yield* Fiber.join(overlap).pipe(Effect.timeout("5 seconds"))
            const serial = yield* Fiber.join(queued).pipe(Effect.timeout("5 seconds"))
            return {
              whileHeld,
              finished: finished.status,
              overlapped: overlapped.status,
              serial: serial.status,
              sessions: created.length,
            }
          }).pipe(
            Effect.provide(
              open(tmp.path, created, {
                resume: (sessionID) =>
                  Effect.gen(function* () {
                    const info = created.find((item) => item.id === sessionID)
                    if (info?.location.directory === other) {
                      yield* Deferred.succeed(entered, sessionID)
                      return yield* Deferred.await(release)
                    }
                  }),
              }),
            ),
            Effect.ensuring(Deferred.succeed(release, undefined)),
          )
          expect(result.whileHeld).toBe("pending")
          expect(result.finished).toBe("completed")
          expect(result.overlapped).toBe("completed")
          expect(result.serial).toBe("completed")
          expect(result.sessions).toBe(3)
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.effect("T12 same-second slot conflicts, and the next second is a new slot", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const created: SessionV2.Info[] = []
          const directory = AbsolutePath.make(path.join(tmp.path, "slot"))
          const result = yield* Effect.gen(function* () {
            const tasks = yield* ScheduledTaskStore.Service
            const slot = DateTime.makeUnsafe(1_700_000_000_000)
            const task = yield* tasks.create(input("slot", directory, slot))
            const first = yield* tasks.runNow(task.id, slot)
            const again = yield* tasks.runNow(task.id, slot).pipe(Effect.exit)
            const next = yield* tasks.runNow(task.id, DateTime.makeUnsafe(1_700_000_001_000))
            return {
              first: first.status,
              again: again._tag,
              next: next.status,
              slots: (yield* tasks.runs(task.id)).map((run) => DateTime.toEpochMillis(run.scheduledAt)),
            }
          }).pipe(Effect.provide(open(tmp.path, created)))
          expect(result.first).toBe("completed")
          expect(result.again).toBe("Failure")
          expect(result.next).toBe("completed")
          expect(result.slots).toEqual([1_700_000_000_000, 1_700_000_001_000])
          expect(created).toHaveLength(2)
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("T14 reports running before session creation finishes and still terminates on cancel", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const created: SessionV2.Info[] = []
          const entered = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const directory = AbsolutePath.make(tmp.path)
          const result = yield* Effect.gen(function* () {
            const tasks = yield* ScheduledTaskStore.Service
            const task = yield* tasks.create(input("preparing", directory, DateTime.toUtc(yield* DateTime.now)))
            const running = yield* tasks.runNow(task.id).pipe(Effect.forkChild)
            yield* tasks
              .runs(task.id)
              .pipe(
                Effect.repeat({ until: (runs) => runs.some((run) => run.status === "running" && !run.sessionId) }),
                Effect.timeout("5 seconds"),
              )
            const during = (yield* tasks.runs(task.id))[0]
            const listed = (yield* tasks.list()).find((item) => item.id === task.id)
            yield* Fiber.interrupt(running)
            yield* Deferred.succeed(release, undefined)
            yield* Fiber.join(running).pipe(Effect.exit)
            return {
              status: during?.status,
              session: during?.sessionId,
              listed: Boolean(listed),
              after: (yield* tasks.runs(task.id))[0]?.status,
              sessions: created.length,
            }
          }).pipe(
            Effect.provide(
              open(tmp.path, created, {
                create: () =>
                  Effect.gen(function* () {
                    yield* Deferred.succeed(entered, undefined)
                    yield* Deferred.await(release)
                    return yield* Effect.die("cancelled before create")
                  }),
              }),
            ),
            Effect.ensuring(Deferred.succeed(release, undefined)),
          )
          expect(result.status).toBe("running")
          expect(result.session).toBeUndefined()
          expect(result.listed).toBe(true)
          expect(result.after).toBe("interrupted")
          expect(result.sessions).toBe(0)
          expect(entered).toBeDefined()
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})

const recordingCreate =
  (created: SessionV2.Info[]): SessionV2.Interface["create"] =>
  (input) => {
    const info = SessionV2.Info.make({
      id: SessionV2.ID.descending(),
      projectID: ProjectV2.ID.global,
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
      title: "scheduled",
      approvalMode: input.approvalMode,
      location: input.location,
    })
    created.push(info)
    return Effect.succeed(info)
  }

const recordingPrompt = (): SessionV2.Interface["prompt"] => (input) =>
  Effect.succeed(
    SessionInput.Admitted.make({
      admittedSeq: 0,
      id: SessionMessage.ID.make("msg_scheduled"),
      sessionID: input.sessionID,
      prompt: Prompt.make({ text: input.prompt.text }),
      delivery: "steer",
      timeCreated: DateTime.makeUnsafe(0),
    }),
  )
