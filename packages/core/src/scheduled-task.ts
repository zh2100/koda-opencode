export * as ScheduledTaskStore from "./scheduled-task"

import { Context, DateTime, Duration, Effect, Layer, Option, Schedule, Schema } from "effect"
import { eq } from "drizzle-orm"
import { makeGlobalNode } from "./effect/app-node"
import { KeyedMutex } from "./effect/keyed-mutex"
import { Database } from "./database/database"
import { EventV2 } from "./event"
import { Global } from "./global"
import { ProjectV2 } from "./project"
import { RelayAuth } from "./relay-auth"
import { RelayCatalog } from "./relay-catalog"
import { RelayGate } from "./relay-gate"
import { SessionV2 } from "./session"
import { FSUtil } from "./fs-util"
import { Prompt } from "@opencode-ai/schema/prompt"
import { ScheduledTask } from "@opencode-ai/schema/scheduled-task"
import { ScheduledTaskEvent } from "@opencode-ai/schema/scheduled-task-event"
import { ScheduledTaskRunTable, ScheduledTaskTable } from "./scheduled-task/sql"
import path from "path"

const DAY_MS = 86_400_000
const Stored = Schema.Struct({
  tasks: Schema.Array(ScheduledTask.Info),
  runs: Schema.Array(ScheduledTask.Run),
})

type TaskRow = typeof ScheduledTaskTable.$inferSelect
type RunRow = typeof ScheduledTaskRunTable.$inferSelect

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("ScheduledTask.NotFoundError", {
  taskID: ScheduledTask.ID,
}) {}

export interface Interface {
  readonly list: () => Effect.Effect<ReadonlyArray<ScheduledTask.Info>>
  readonly runs: (taskId?: ScheduledTask.ID) => Effect.Effect<ReadonlyArray<ScheduledTask.Run>>
  readonly create: (
    input: Omit<ScheduledTask.Info, "id" | "revision" | "nextRun" | "lastRun">,
  ) => Effect.Effect<ScheduledTask.Info>
  readonly remove: (id: ScheduledTask.ID) => Effect.Effect<void>
  readonly runNow: (id: ScheduledTask.ID) => Effect.Effect<ScheduledTask.Run, NotFoundError>
  readonly setEnabled: (id: ScheduledTask.ID, enabled: boolean) => Effect.Effect<ScheduledTask.Info, NotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ScheduledTask") {}

export function nextDaily(at: DateTime.Utc, timezone: string) {
  const zone = Option.getOrElse(DateTime.zoneFromString(timezone), () => DateTime.zoneMakeNamedUnsafe("UTC"))
  return DateTime.toUtc(DateTime.add({ days: 1 })(DateTime.setZone(at, zone)))
}

export function dueSlots(
  task: Pick<ScheduledTask.Info, "schedule" | "timezone" | "runAt" | "nextRun">,
  now: DateTime.Utc,
) {
  const current = DateTime.toEpochMillis(now)
  const slots: Array<{ at: DateTime.Utc; missed: boolean }> = []
  let due = task.nextRun ?? task.runAt
  while (DateTime.toEpochMillis(due) <= current) {
    const next = task.schedule === "once" ? undefined : nextDaily(due, task.timezone)
    const laterDue = next !== undefined && DateTime.toEpochMillis(next) <= current
    const missed = current - DateTime.toEpochMillis(due) > DAY_MS || laterDue
    slots.push({ at: due, missed })
    if (task.schedule === "once" || next === undefined) break
    due = next
  }
  return slots
}

const fromTask = (row: TaskRow): ScheduledTask.Info =>
  ScheduledTask.Info.make({
    id: row.id,
    name: row.name,
    projectID: row.project_id,
    location: row.location,
    prompt: row.prompt,
    schedule: row.schedule,
    timezone: row.timezone,
    runAt: DateTime.makeUnsafe(row.run_at),
    model: row.model,
    ...(row.effort ? { effort: row.effort } : {}),
    approvalMode: row.approval_mode,
    enabled: row.enabled,
    revision: row.revision,
    ...(row.next_run === null ? {} : { nextRun: DateTime.makeUnsafe(row.next_run) }),
    ...(row.last_run === null ? {} : { lastRun: DateTime.makeUnsafe(row.last_run) }),
  })

const fromRun = (row: RunRow): ScheduledTask.Run =>
  ScheduledTask.Run.make({
    id: row.id,
    taskId: row.task_id,
    scheduledAt: DateTime.makeUnsafe(row.scheduled_at),
    revision: row.revision,
    status: row.status,
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(row.prompt_message_id ? { promptMessageId: row.prompt_message_id } : {}),
    ...(row.started_at === null ? {} : { startedAt: DateTime.makeUnsafe(row.started_at) }),
    ...(row.ended_at === null ? {} : { endedAt: DateTime.makeUnsafe(row.ended_at) }),
    ...(row.error ? { error: row.error } : {}),
  })

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    const gates = yield* RelayGate.Service
    const sessions = yield* SessionV2.Service
    const projects = yield* ProjectV2.Service
    const auth = yield* RelayAuth.Service
    const catalog = yield* RelayCatalog.Service
    const fs = yield* FSUtil.Service
    const file = path.join((yield* Global.Service).data, "scheduled-tasks.json")
    const locks = KeyedMutex.makeUnsafe<string>()
    const decode = Schema.decodeUnknownSync(Stored)

    const publish = (task: ScheduledTask.Info, run?: ScheduledTask.Run) =>
      events.publish(ScheduledTaskEvent.Updated, { task, ...(run ? { run } : {}) }).pipe(Effect.asVoid)

    const loadTask = (id: ScheduledTask.ID) =>
      db.select().from(ScheduledTaskTable).where(eq(ScheduledTaskTable.id, id)).get().pipe(Effect.orDie)

    const loadRun = (id: ScheduledTask.RunID) =>
      db.select().from(ScheduledTaskRunTable).where(eq(ScheduledTaskRunTable.id, id)).get().pipe(Effect.orDie)

    const listTasks = () => db.select().from(ScheduledTaskTable).all().pipe(Effect.orDie)
    const listRuns = (taskId?: ScheduledTask.ID) =>
      (taskId
        ? db.select().from(ScheduledTaskRunTable).where(eq(ScheduledTaskRunTable.task_id, taskId))
        : db.select().from(ScheduledTaskRunTable)
      )
        .all()
        .pipe(Effect.orDie)

    const insertTask = (task: ScheduledTask.Info) =>
      db
        .insert(ScheduledTaskTable)
        .values({
          id: task.id,
          name: task.name,
          project_id: task.projectID,
          location: task.location,
          prompt: task.prompt,
          schedule: task.schedule,
          timezone: task.timezone,
          run_at: DateTime.toEpochMillis(task.runAt),
          model: task.model,
          effort: task.effort,
          approval_mode: task.approvalMode,
          enabled: task.enabled,
          revision: task.revision,
          next_run: task.nextRun ? DateTime.toEpochMillis(task.nextRun) : null,
          last_run: task.lastRun ? DateTime.toEpochMillis(task.lastRun) : null,
        })
        .run()
        .pipe(Effect.orDie)

    const insertRun = (run: ScheduledTask.Run) =>
      db
        .insert(ScheduledTaskRunTable)
        .values({
          id: run.id,
          task_id: run.taskId,
          scheduled_at: DateTime.toEpochMillis(run.scheduledAt),
          revision: run.revision,
          status: run.status,
          session_id: run.sessionId,
          prompt_message_id: run.promptMessageId,
          started_at: run.startedAt ? DateTime.toEpochMillis(run.startedAt) : null,
          ended_at: run.endedAt ? DateTime.toEpochMillis(run.endedAt) : null,
          error: run.error,
        })
        .onConflictDoNothing()
        .returning({ id: ScheduledTaskRunTable.id })
        .get()
        .pipe(Effect.orDie)

    const patchRun = (id: ScheduledTask.RunID, patch: Partial<ScheduledTask.Run>) =>
      Effect.gen(function* () {
        const current = yield* loadRun(id)
        if (!current) return
        const next = fromRun({
          ...current,
          status: patch.status ?? current.status,
          session_id: patch.sessionId ?? current.session_id,
          prompt_message_id: patch.promptMessageId ?? current.prompt_message_id,
          started_at: patch.startedAt ? DateTime.toEpochMillis(patch.startedAt) : current.started_at,
          ended_at: patch.endedAt ? DateTime.toEpochMillis(patch.endedAt) : current.ended_at,
          error: patch.error === undefined ? current.error : patch.error,
        })
        yield* db
          .update(ScheduledTaskRunTable)
          .set({
            status: next.status,
            session_id: next.sessionId,
            prompt_message_id: next.promptMessageId,
            started_at: next.startedAt ? DateTime.toEpochMillis(next.startedAt) : null,
            ended_at: next.endedAt ? DateTime.toEpochMillis(next.endedAt) : null,
            error: next.error,
          })
          .where(eq(ScheduledTaskRunTable.id, id))
          .run()
          .pipe(Effect.orDie)
        return next
      })

    const advance = (task: ScheduledTask.Info, scheduledAt: DateTime.Utc) =>
      Effect.gen(function* () {
        const nextRun = task.schedule === "once" ? undefined : nextDaily(scheduledAt, task.timezone)
        const enabled = task.schedule === "once" ? false : task.enabled
        yield* db
          .update(ScheduledTaskTable)
          .set({
            last_run: DateTime.toEpochMillis(scheduledAt),
            next_run: nextRun ? DateTime.toEpochMillis(nextRun) : null,
            enabled,
          })
          .where(eq(ScheduledTaskTable.id, task.id))
          .run()
          .pipe(Effect.orDie)
        const updated = yield* loadTask(task.id)
        return updated ? fromTask(updated) : task
      })

    const pause = (task: ScheduledTask.Info) =>
      Effect.gen(function* () {
        yield* db
          .update(ScheduledTaskTable)
          .set({ enabled: false })
          .where(eq(ScheduledTaskTable.id, task.id))
          .run()
          .pipe(Effect.orDie)
        const updated = yield* loadTask(task.id)
        return updated ? fromTask(updated) : { ...task, enabled: false }
      })

    const requireReady = (task: ScheduledTask.Info) =>
      Effect.gen(function* () {
        if (catalog.hasManaged() && !catalog.visible(task.model.id)) return yield* failReady(task, "MODEL_UNAVAILABLE")
        const vendorId = (yield* catalog.managed()).find((item) => item.modelId === task.model.id)?.vendorId
        if (vendorId) yield* auth.resolve(vendorId)
        const project = yield* projects.resolve(task.location.directory)
        if (project.id !== task.projectID) return yield* failReady(task, "PROJECT_INVALID")
      })

    const failReady = (task: ScheduledTask.Info, code: "MODEL_UNAVAILABLE" | "PROJECT_INVALID") =>
      Effect.fail({ _tag: "ScheduledTask.Paused", code, task })

    const fail = (task: ScheduledTask.Info, run: ScheduledTask.Run, error: unknown) =>
      Effect.gen(function* () {
        const code =
          error && typeof error === "object" && "info" in error && error.info && typeof error.info === "object" && "code" in error.info
            ? String(error.info.code)
            : error && typeof error === "object" && "_tag" in error && error._tag === "ScheduledTask.Paused" && "code" in error
              ? String(error.code)
              : "PROJECT_INVALID"
        const ended = yield* DateTime.now
        const failed = yield* patchRun(run.id, {
          status: "failed",
          endedAt: ended,
          error: {
            code: code === "KEY_MISSING" || code === "MODEL_UNAVAILABLE" || code === "PROJECT_INVALID" ? code : "PROJECT_INVALID",
            retryable: false,
            requestId: run.id,
            details: String(error),
          },
        })
        if (code === "KEY_MISSING" || code === "MODEL_UNAVAILABLE" || code === "PROJECT_INVALID") {
          const paused = yield* pause(task)
          if (failed) yield* publish(paused, failed)
          return
        }
        if (failed) yield* publish(task, failed)
      })
    const perform = (task: ScheduledTask.Info, run: ScheduledTask.Run) =>
      Effect.gen(function* () {
        yield* requireReady(task)
        const session = yield* sessions.create({ location: task.location, model: task.model })
        const admitted = yield* sessions.prompt({
          sessionID: session.id,
          prompt: Prompt.make({ text: task.prompt.text }),
          resume: false,
        })
        const started = yield* DateTime.now
        const running = yield* patchRun(run.id, {
          status: "running",
          sessionId: session.id,
          promptMessageId: admitted.id,
          startedAt: started,
        })
        if (running) yield* publish(task, running)
        yield* sessions.resume(session.id).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              const ended = yield* DateTime.now
              const completed = yield* patchRun(run.id, { status: "completed", endedAt: ended })
              if (completed) yield* publish(task, completed)
            }),
          ),
          Effect.catch((error) => fail(task, run, error)),
          Effect.forkDetach,
        )
      }).pipe(Effect.catch((error) => fail(task, run, error)))
    const execute = (task: ScheduledTask.Info, run: ScheduledTask.Run) =>
      locks.withLock(`${task.id}:${task.projectID}`)(perform(task, run))

    const claim = (task: ScheduledTask.Info, scheduledAt: DateTime.Utc, status: ScheduledTask.RunStatus) =>
      Effect.gen(function* () {
        const run = ScheduledTask.Run.make({
          id: ScheduledTask.RunID.create(),
          taskId: task.id,
          scheduledAt,
          revision: task.revision,
          status,
        })
        const stored = yield* insertRun(run)
        return stored ? run : undefined
      })

    const tick = Effect.fn("ScheduledTask.tick")(function* () {
      if (!gates.scheduledTasks) return
      const now = yield* DateTime.now
      const tasks = yield* listTasks()
      for (const row of tasks) {
        const task = fromTask(row)
        if (!task.enabled) continue
        for (const slot of dueSlots(task, now)) {
          const run = yield* claim(task, slot.at, slot.missed ? "missed" : "pending")
          if (!run) continue
          const next = yield* advance(task, slot.at)
          yield* publish(next, run)
          if (slot.missed) continue
          yield* execute(task, run)
        }
      }
    })

    const migrate = Effect.gen(function* () {
      const existing = yield* listTasks()
      if (existing.length > 0) return
      const data = yield* fs.readJson(file).pipe(Effect.orElseSucceed(() => undefined))
      if (data === undefined) return
      const stored = (() => {
        try {
          return decode(data)
        } catch {
          return undefined
        }
      })()
      if (!stored) return
      for (const task of stored.tasks) yield* insertTask(task)
      for (const run of stored.runs) yield* insertRun(run).pipe(Effect.asVoid)
    })

    yield* migrate
    if (gates.scheduledTasks) {
      yield* tick().pipe(Effect.repeat(Schedule.spaced(Duration.seconds(30))), Effect.ignore, Effect.forkScoped)
    }

    return Service.of({
      list: Effect.fn("ScheduledTask.list")(function* () {
        if (!gates.scheduledTasks) return []
        return (yield* listTasks()).map(fromTask)
      }),
      runs: Effect.fn("ScheduledTask.runs")(function* (taskId) {
        if (!gates.scheduledTasks) return []
        return (yield* listRuns(taskId)).map(fromRun)
      }),
      create: Effect.fn("ScheduledTask.create")(function* (input) {
        const task = ScheduledTask.Info.make({
          ...input,
          id: ScheduledTask.ID.create(),
          revision: 0,
          nextRun: input.runAt,
        })
        yield* insertTask(task)
        yield* publish(task)
        return task
      }),
      remove: Effect.fn("ScheduledTask.remove")(function* (id) {
        yield* db.delete(ScheduledTaskRunTable).where(eq(ScheduledTaskRunTable.task_id, id)).run().pipe(Effect.orDie)
        yield* db.delete(ScheduledTaskTable).where(eq(ScheduledTaskTable.id, id)).run().pipe(Effect.orDie)
      }),
      runNow: Effect.fn("ScheduledTask.runNow")(function* (id) {
        const row = yield* loadTask(id)
        if (!row) return yield* new NotFoundError({ taskID: id })
        const task = fromTask(row)
        return yield* locks.withLock(`${task.id}:${task.projectID}`)(
          Effect.gen(function* () {
            const current = (yield* listRuns(id)).find((item) => item.status === "pending" || item.status === "running")
            if (current) return fromRun(current)
            const now = yield* DateTime.now
            const scheduledAt = DateTime.makeUnsafe(Math.floor(DateTime.toEpochMillis(now) / 1000) * 1000)
            const run = yield* claim(task, scheduledAt, "pending")
            if (!run) {
              const again = (yield* listRuns(id)).find((item) => item.status === "pending" || item.status === "running")
              if (again) return fromRun(again)
              return yield* new NotFoundError({ taskID: id })
            }
            yield* publish(task, run)
            yield* perform(task, run)
            const finished = yield* loadRun(run.id)
            return finished ? fromRun(finished) : run
          }),
        )
      }),
      setEnabled: Effect.fn("ScheduledTask.setEnabled")(function* (id, enabled) {
        const row = yield* loadTask(id)
        if (!row) return yield* new NotFoundError({ taskID: id })
        yield* db
          .update(ScheduledTaskTable)
          .set({ enabled })
          .where(eq(ScheduledTaskTable.id, id))
          .run()
          .pipe(Effect.orDie)
        const updated = yield* loadTask(id)
        const task = fromTask(updated ?? row)
        yield* publish(task)
        return task
      }),
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, EventV2.node, FSUtil.node, Global.node, ProjectV2.node, RelayAuth.node, RelayCatalog.node, RelayGate.node, SessionV2.node],
})
