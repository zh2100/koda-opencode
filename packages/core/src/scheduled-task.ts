export * as ScheduledTaskStore from "./scheduled-task"

import { Cause, Context, DateTime, Deferred, Duration, Effect, Exit, Layer, Option, Schedule, Schema } from "effect"
import { randomUUID } from "crypto"
import { EffectFlock } from "./util/effect-flock"
import { and, eq, inArray, isNull, sql } from "drizzle-orm"
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
import { AgentV2 } from "./agent"
import { ProviderV2 } from "./provider"
import { ModelV2 } from "./model"
import { Prompt } from "@opencode-ai/schema/prompt"
import { ScheduledTask } from "@opencode-ai/schema/scheduled-task"
import { ScheduledTaskEvent } from "@opencode-ai/schema/scheduled-task-event"
import { ScheduledTaskRunTable, ScheduledTaskTable } from "./scheduled-task/sql"
import path from "path"
import { ScheduledTaskFailure } from "./scheduled-task/failure"
import { SettledIO } from "./util/settled-io"

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

export class DisabledError extends Schema.TaggedErrorClass<DisabledError>()("ScheduledTask.DisabledError", {
  taskID: ScheduledTask.ID,
}) {}

export class ConflictError extends Schema.TaggedErrorClass<ConflictError>()("ScheduledTask.ConflictError", {
  taskID: ScheduledTask.ID,
}) {}

export interface Interface {
  readonly list: () => Effect.Effect<ReadonlyArray<ScheduledTask.Info>>
  readonly runs: (taskId?: ScheduledTask.ID) => Effect.Effect<ReadonlyArray<ScheduledTask.Run>>
  readonly create: (
    input: Omit<ScheduledTask.Info, "id" | "revision" | "nextRun" | "lastRun">,
  ) => Effect.Effect<ScheduledTask.Info>
  readonly remove: (id: ScheduledTask.ID) => Effect.Effect<void>
  readonly runNow: (
    id: ScheduledTask.ID,
    at?: DateTime.Utc,
  ) => Effect.Effect<ScheduledTask.Run, NotFoundError | DisabledError | ConflictError>
  readonly setEnabled: (id: ScheduledTask.ID, enabled: boolean) => Effect.Effect<ScheduledTask.Info, NotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ScheduledTask") {}

const recoveryEntries = new WeakMap<
  Interface,
  (taskID?: ScheduledTask.ID) => Effect.Effect<void, EffectFlock.LockError>
>()
const tickEntries = new WeakMap<
  Interface,
  (beforeAdmission?: Effect.Effect<void>) => Effect.Effect<void, never, import("effect/Scope").Scope>
>()
export const tickForTest = (service: Interface, beforeAdmission?: Effect.Effect<void>) =>
  tickEntries.get(service)!(beforeAdmission)

const projectLockEntries = new WeakMap<Interface, (projectID: string) => Effect.Effect<void>>()
const projectReleaseEntries = new WeakMap<Interface, (projectID: string) => Effect.Effect<void>>()

// Test seam. Production callers use Service.runNow, which recovers only after this process holds its owner lease.
export function recoverForTest(service: Interface) {
  const recover = recoveryEntries.get(service)
  if (!recover) {
    return (_taskID?: ScheduledTask.ID) =>
      Effect.die("scheduled task recovery is not registered") as Effect.Effect<void, EffectFlock.LockError>
  }
  return recover
}

export function projectLockForTest(service: Interface) {
  const lock = projectLockEntries.get(service)
  if (!lock) return (_projectID: string) => Effect.die("scheduled task project lock is not registered")
  return lock
}

export function releaseProjectLockForTest(service: Interface) {
  const release = projectReleaseEntries.get(service)
  if (!release) return (_projectID: string) => Effect.die("scheduled task project lock release is not registered")
  return release
}

export function nextDaily(at: DateTime.Utc, timezone: string, anchor: DateTime.Utc = at) {
  const zone = Option.getOrElse(DateTime.zoneFromString(timezone), () => DateTime.zoneMakeNamedUnsafe("UTC"))
  const local = DateTime.setZone(at, zone)
  const clock = DateTime.toParts(DateTime.setZone(anchor, zone))
  const parts = DateTime.toParts(local)
  const candidate = DateTime.makeZoned(
    {
      year: parts.year,
      month: parts.month,
      day: parts.day + 1,
      hour: clock.hour,
      minute: clock.minute,
      second: clock.second,
      millisecond: clock.millisecond,
    },
    { timeZone: zone, disambiguation: "later", adjustForTimeZone: true },
  )
  const resolved = Option.getOrElse(candidate, () => DateTime.add({ days: 1 })(local))
  const utc = DateTime.toUtc(resolved)
  if (DateTime.toEpochMillis(utc) > DateTime.toEpochMillis(at)) return utc
  return DateTime.toUtc(DateTime.add({ days: 1 })(local))
}

export function dueSlots(
  task: Pick<ScheduledTask.Info, "schedule" | "timezone" | "runAt" | "nextRun">,
  now: DateTime.Utc,
) {
  const current = DateTime.toEpochMillis(now)
  const slots: Array<{ at: DateTime.Utc; missed: boolean }> = []
  let due = task.nextRun ?? task.runAt
  while (DateTime.toEpochMillis(due) <= current) {
    const next = task.schedule === "once" ? undefined : nextDaily(due, task.timezone, task.runAt)
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

function currentSlot() {
  return Effect.map(DateTime.now, (now) => DateTime.makeUnsafe(Math.floor(DateTime.toEpochMillis(now) / 1000) * 1000))
}

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
    const data = (yield* Global.Service).data
    const file = path.join(data, "scheduled-tasks.json")
    const flock = yield* EffectFlock.Service
    const owner = `scheduled-task:${randomUUID()}`
    const ownerDirectory = path.join(data, "locks")
    // Claims persist this owner only after its scoped lock is held.
    yield* flock.acquire(owner, ownerDirectory).pipe(Effect.orDie)
    const locks = KeyedMutex.makeUnsafe<string>()
    const states = KeyedMutex.makeUnsafe<ScheduledTask.ID>()
    const notices = new Map<ScheduledTask.ID, Cause.Cause<unknown>>()
    const heldProjectLocks = new Map<string, Deferred.Deferred<void>>()
    const decode = Schema.decodeUnknownSync(Stored)

    // Called only inside the same task's short state/publication section.
    const publish = (task: Pick<ScheduledTask.Info, "id">, run?: ScheduledTask.Run) =>
      Effect.gen(function* () {
        const current = yield* loadTask(task.id)
        if (!current) return
        yield* events.publish(ScheduledTaskEvent.Updated, { task: fromTask(current), ...(run ? { run } : {}) }).pipe(
          Effect.catchCause((cause) => {
            // Publication may already have delivered to a prefix of listeners. Never replay it.
            notices.set(task.id, cause)
            return Effect.logWarning("scheduled task notification outcome unknown").pipe(
              Effect.annotateLogs({ taskID: task.id, stage: "publication" }),
              Effect.andThen(Effect.failCause(cause)),
            )
          }),
          Effect.asVoid,
        )
      })

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
          cancel_epoch: 0,
          revision: task.revision,
          next_run: task.nextRun ? DateTime.toEpochMillis(task.nextRun) : null,
          last_run: task.lastRun ? DateTime.toEpochMillis(task.lastRun) : null,
        })
        .run()
        .pipe(Effect.orDie)

    const insertRun = (run: ScheduledTask.Run, executionOwner?: string) =>
      db
        .insert(ScheduledTaskRunTable)
        .values({
          id: run.id,
          task_id: run.taskId,
          owner: executionOwner,
          scheduled_at: DateTime.toEpochMillis(run.scheduledAt),
          revision: run.revision,
          cancel_epoch: null,
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
        const updated = yield* db
          .update(ScheduledTaskRunTable)
          .set({
            status: next.status,
            session_id: next.sessionId,
            prompt_message_id: next.promptMessageId,
            started_at: next.startedAt ? DateTime.toEpochMillis(next.startedAt) : null,
            ended_at: next.endedAt ? DateTime.toEpochMillis(next.endedAt) : null,
            error: next.error,
          })
          .where(
            and(
              eq(ScheduledTaskRunTable.id, id),
              inArray(ScheduledTaskRunTable.status, ["pending", "running"]),
              current.owner ? eq(ScheduledTaskRunTable.owner, current.owner) : isNull(ScheduledTaskRunTable.owner),
            ),
          )
          .returning()
          .get()
          .pipe(Effect.orDie)
        return updated ? fromRun(updated) : undefined
      })

    const disable = (id: ScheduledTask.ID, reason: string) =>
      db.transaction((tx) =>
        Effect.gen(function* () {
          const current = yield* tx.select().from(ScheduledTaskTable).where(eq(ScheduledTaskTable.id, id)).get()
          if (!current) return
          yield* tx
            .update(ScheduledTaskTable)
            .set({ enabled: false, cancel_epoch: sql`${ScheduledTaskTable.cancel_epoch} + 1` })
            .where(eq(ScheduledTaskTable.id, id))
            .run()
          const task = yield* tx.select().from(ScheduledTaskTable).where(eq(ScheduledTaskTable.id, id)).get()
          if (!task) return
          const ended = Date.now()
          const interrupted = yield* tx
            .update(ScheduledTaskRunTable)
            .set({
              status: "interrupted",
              ended_at: ended,
              error: {
                code: "REQUEST_CONFLICT",
                retryable: false,
                requestId: id,
                details: reason,
              },
            })
            .where(and(eq(ScheduledTaskRunTable.task_id, id), eq(ScheduledTaskRunTable.status, "pending")))
            .returning()
            .all()
          return { task: fromTask(task), runs: interrupted.map(fromRun) }
        }),
      )

    const requireReady = (task: ScheduledTask.Info) =>
      Effect.gen(function* () {
        if (task.model.providerID === ProviderV2.ID.leidiandonghua) {
          const managed = yield* catalog.managed()
          const item = managed.find((entry) => RelayCatalog.modelID(entry.vendorId, entry.modelId) === task.model.id)
          if (!item?.visible) return yield* failReady(task, "MODEL_UNAVAILABLE")
          yield* auth.resolve(item.vendorId)
        }
        const project = yield* projects.resolve(task.location.directory)
        if (project.id !== task.projectID) return yield* failReady(task, "PROJECT_INVALID")
      })

    const failReady = (task: ScheduledTask.Info, code: "MODEL_UNAVAILABLE" | "PROJECT_INVALID") =>
      Effect.fail({ _tag: "ScheduledTask.Paused", code, task })

    const fail = (
      task: ScheduledTask.Info,
      run: ScheduledTask.Run,
      error: unknown,
      phase: "ready" | "execution" = "execution",
    ) =>
      states.withLock(task.id)(
        Effect.gen(function* () {
          const decision = ScheduledTaskFailure.classify(error, phase)
          const current = yield* loadTask(task.id)
          const claimed = yield* loadRun(run.id)
          const failed = yield* patchRun(run.id, {
            status: "failed",
            endedAt: yield* DateTime.now,
            error: { code: decision.code, retryable: decision.retryable, requestId: run.id },
          })
          if (!failed) return
          if (
            decision.pauseTask &&
            current?.enabled &&
            claimed?.cancel_epoch !== null &&
            claimed?.cancel_epoch === current.cancel_epoch
          ) {
            const paused = yield* disable(task.id, decision.code).pipe(Effect.orDie)
            if (paused) {
              yield* publish(paused.task, failed)
              for (const interrupted of paused.runs) yield* publish(paused.task, interrupted)
            }
            return
          }
          yield* publish(task, failed)
        }),
      )
    const stillDue = (task: ScheduledTask.Info, run: ScheduledTask.Run) =>
      states.withLock(task.id)(
        Effect.gen(function* () {
          const admitted = yield* db.transaction((tx) =>
            Effect.gen(function* () {
              const current = yield* tx
                .select()
                .from(ScheduledTaskTable)
                .where(eq(ScheduledTaskTable.id, task.id))
                .get()
              const claimed = yield* tx
                .select()
                .from(ScheduledTaskRunTable)
                .where(eq(ScheduledTaskRunTable.id, run.id))
                .get()
              if (!current || !claimed || claimed.status !== "pending" || claimed.owner !== owner) return false
              // A null epoch is a pre-migration claim and is not authorized to start.
              if (claimed.cancel_epoch === null || claimed.cancel_epoch !== current.cancel_epoch) {
                yield* tx
                  .update(ScheduledTaskRunTable)
                  .set({
                    status: "interrupted",
                    ended_at: Date.now(),
                    error: {
                      code: "REQUEST_CONFLICT",
                      retryable: false,
                      requestId: run.id,
                      details: "disabled",
                    },
                  })
                  .where(and(eq(ScheduledTaskRunTable.id, run.id), eq(ScheduledTaskRunTable.status, "pending")))
                  .run()
                return false
              }
              const started = yield* tx
                .update(ScheduledTaskRunTable)
                .set({ status: "running", started_at: Date.now() })
                .where(
                  and(
                    eq(ScheduledTaskRunTable.id, run.id),
                    eq(ScheduledTaskRunTable.status, "pending"),
                    eq(ScheduledTaskRunTable.owner, owner),
                    eq(ScheduledTaskRunTable.cancel_epoch, current.cancel_epoch),
                  ),
                )
                .returning()
                .get()
              return Boolean(started)
            }),
          )
          if (!admitted) {
            const current = yield* loadTask(task.id)
            const claimed = yield* loadRun(run.id)
            if (current && claimed?.status === "interrupted") yield* publish(fromTask(current), fromRun(claimed))
            return false
          }
          return true
        }),
      )
    const abandoned = (task: ScheduledTask.Info, run: ScheduledTask.Run, exit: Exit.Exit<unknown, unknown>) =>
      states.withLock(task.id)(
        Effect.gen(function* () {
          if (Exit.isSuccess(exit)) return
          const current = yield* loadRun(run.id)
          if (!current || (current.status !== "pending" && current.status !== "running")) return
          const interrupted = yield* patchRun(run.id, {
            status: "interrupted",
            endedAt: yield* DateTime.now,
            error: {
              code: "REQUEST_CONFLICT",
              retryable: false,
              requestId: run.id,
              details: "Execution interrupted before completion",
            },
          })
          if (interrupted) yield* publish(task, interrupted)
        }),
      )
    const perform = (task: ScheduledTask.Info, run: ScheduledTask.Run) =>
      locks
        .withLock(task.projectID)(
          Effect.gen(function* () {
            if (!(yield* stillDue(task, run))) return
            const ready = yield* requireReady(task).pipe(
              Effect.as(true),
              Effect.catchCause((cause) => {
                // Fatal/mixed causes are not recoverable API errors; propagate their exact runtime reasons.
                const error = Cause.findErrorOption(cause)
                return Cause.hasDies(cause) || Cause.hasInterrupts(cause) || Option.isNone(error)
                  ? Effect.failCause(cause as Cause.Cause<never>)
                  : fail(task, run, error.value, "ready").pipe(Effect.as(false))
              }),
            )
            if (!ready) return
            const agent = task.approvalMode === "plan" ? AgentV2.ID.make("plan") : undefined
            const session = yield* sessions.create({
              location: task.location,
              approvalMode: task.approvalMode,
              model: {
                ...task.model,
                ...(task.effort ? { variant: ModelV2.VariantID.make(task.effort) } : {}),
              },
              ...(agent ? { agent } : {}),
            })
            const admitted = yield* sessions.prompt({
              sessionID: session.id,
              prompt: task.prompt,
              resume: false,
            })
            yield* states.withLock(task.id)(
              Effect.gen(function* () {
                const running = yield* db
                  .update(ScheduledTaskRunTable)
                  .set({ session_id: session.id, prompt_message_id: admitted.id })
                  .where(
                    and(
                      eq(ScheduledTaskRunTable.id, run.id),
                      eq(ScheduledTaskRunTable.status, "running"),
                      eq(ScheduledTaskRunTable.owner, owner),
                    ),
                  )
                  .returning()
                  .get()
                  .pipe(Effect.orDie)
                if (running) yield* publish(task, fromRun(running))
              }),
            )
            yield* sessions.resume(session.id)
            yield* states.withLock(task.id)(
              Effect.gen(function* () {
                const ended = yield* DateTime.now
                const completed = yield* patchRun(run.id, { status: "completed", endedAt: ended })
                if (completed) yield* publish(task, completed)
              }),
            )
          }),
        )
        .pipe(
          Effect.catchCause((cause) => {
            const error = Cause.findErrorOption(cause)
            return Cause.hasDies(cause) || Cause.hasInterrupts(cause) || Option.isNone(error)
              ? Effect.failCause(cause as Cause.Cause<never>)
              : fail(task, run, error.value)
          }),
          SettledIO.onExit((exit) => abandoned(task, run, exit)),
        )
    const execute = (task: ScheduledTask.Info, run: ScheduledTask.Run) => perform(task, run).pipe(Effect.forkScoped)

    type Admission =
      | { readonly kind: "created"; readonly task: ScheduledTask.Info; readonly run: ScheduledTask.Run }
      | { readonly kind: "active"; readonly run: ScheduledTask.Run }
      | { readonly kind: "consumed"; readonly task: ScheduledTask.Info }
      | { readonly kind: "skipped" }

    const admitRun = (id: ScheduledTask.ID, at: DateTime.Utc, status: ScheduledTask.RunStatus, candidate?: TaskRow) =>
      db
        .transaction((tx) =>
          Effect.gen(function* (): Effect.fn.Return<
            Admission,
            | NotFoundError
            | DisabledError
            | ConflictError
            | import("drizzle-orm/effect-core/errors").EffectDrizzleQueryError
          > {
            const row = yield* tx.select().from(ScheduledTaskTable).where(eq(ScheduledTaskTable.id, id)).get()
            if (!row) return candidate ? { kind: "skipped" } : yield* new NotFoundError({ taskID: id })
            if (!row.enabled) return candidate ? { kind: "skipped" } : yield* new DisabledError({ taskID: id })
            const millis = DateTime.toEpochMillis(at)
            if (
              candidate &&
              (row.cancel_epoch !== candidate.cancel_epoch ||
                row.revision !== candidate.revision ||
                (row.next_run ?? row.run_at) !== millis)
            )
              return { kind: "skipped" }
            if (!candidate) {
              const active = yield* tx
                .select()
                .from(ScheduledTaskRunTable)
                .where(
                  and(
                    eq(ScheduledTaskRunTable.task_id, id),
                    inArray(ScheduledTaskRunTable.status, ["pending", "running"]),
                  ),
                )
                .get()
              if (active) return { kind: "active", run: fromRun(active) }
            }
            const task = fromTask(row)
            const run = ScheduledTask.Run.make({
              id: ScheduledTask.RunID.create(),
              taskId: id,
              scheduledAt: at,
              revision: row.revision,
              status,
            })
            const inserted = yield* tx
              .insert(ScheduledTaskRunTable)
              .values({
                id: run.id,
                task_id: id,
                owner,
                scheduled_at: millis,
                revision: row.revision,
                cancel_epoch: row.cancel_epoch,
                status,
              })
              .onConflictDoNothing()
              .returning()
              .get()
            if (!inserted && !candidate) return yield* new ConflictError({ taskID: id })
            if (candidate) {
              // A unique same-slot row is an existing attempt, not permission to replay it.
              const existing =
                inserted ??
                (yield* tx
                  .select()
                  .from(ScheduledTaskRunTable)
                  .where(and(eq(ScheduledTaskRunTable.task_id, id), eq(ScheduledTaskRunTable.scheduled_at, millis)))
                  .get())
              if (!existing) return { kind: "skipped" }
              const next = task.schedule === "once" ? undefined : nextDaily(at, task.timezone, task.runAt)
              const updated = yield* tx
                .update(ScheduledTaskTable)
                .set({
                  last_run: millis,
                  next_run: next ? DateTime.toEpochMillis(next) : null,
                  ...(task.schedule === "once" ? { enabled: false } : {}),
                })
                .where(eq(ScheduledTaskTable.id, id))
                .returning()
                .get()
              if (!inserted) return { kind: "consumed", task: fromTask(updated!) }
            }
            return { kind: "created", task, run: fromRun(inserted!) }
          }),
        )
        .pipe(
          Effect.catchTags({
            EffectDrizzleQueryError: (error) => Effect.die(error),
            SqlError: (error) => Effect.die(error),
          }),
        )

    const withAdmission = <A, E, R>(
      id: ScheduledTask.ID,
      at: DateTime.Utc,
      status: ScheduledTask.RunStatus,
      body: (admission: Admission) => Effect.Effect<A, E, R>,
      candidate?: TaskRow,
    ) =>
      Effect.suspend(() => {
        let responsibility: Extract<Admission, { kind: "created" }> | undefined
        return states
          .withLock(id)(
            Effect.uninterruptibleMask((restore) =>
              Effect.gen(function* () {
                const admission = yield* admitRun(id, at, status, candidate)
                if (admission.kind === "created") responsibility = admission
                if (admission.kind === "created") yield* restore(publish(admission.task, admission.run))
                if (admission.kind === "consumed") yield* restore(publish(admission.task))
                return admission
              }),
            ),
          )
          .pipe(
            Effect.flatMap(body),
            SettledIO.onExit((exit) =>
              responsibility ? abandoned(responsibility.task, responsibility.run, exit) : Effect.void,
            ),
          )
      })

    const recover = Effect.fn("ScheduledTask.recover")(function* (taskID?: ScheduledTask.ID) {
      for (const row of yield* listRuns(taskID)) {
        if (row.status !== "pending" && row.status !== "running") continue
        yield* states.withLock(row.task_id)(
          Effect.gen(function* () {
            const recovered = yield* Effect.scoped(
              Effect.gen(function* () {
                if (row.owner) {
                  // A real probe failure keeps the row. Cancellation stops this recovery without writing.
                  const probed = yield* flock.probe(row.owner, ownerDirectory).pipe(Effect.exit)
                  if (Exit.isFailure(probed)) {
                    if (Cause.hasInterruptsOnly(probed.cause)) return yield* Effect.failCause(probed.cause)
                    yield* Effect.logWarning("scheduled task recovery could not acquire the owner lease").pipe(
                      Effect.annotateLogs({ runID: row.id, stage: "owner-probe" }),
                    )
                    return
                  }
                  if (probed.value.status !== "acquired") return
                }
                const current = yield* loadRun(row.id)
                if (!current || current.status !== row.status || current.owner !== row.owner) return
                if (current.status === "pending" && current.cancel_epoch === null) {
                  return yield* db
                    .update(ScheduledTaskRunTable)
                    .set({
                      status: "interrupted",
                      ended_at: Date.now(),
                      error: {
                        code: "REQUEST_CONFLICT",
                        retryable: false,
                        requestId: row.id,
                        details: "historical pending epoch",
                      },
                    })
                    .where(
                      and(
                        eq(ScheduledTaskRunTable.id, row.id),
                        eq(ScheduledTaskRunTable.status, "pending"),
                        isNull(ScheduledTaskRunTable.cancel_epoch),
                        row.owner ? eq(ScheduledTaskRunTable.owner, row.owner) : isNull(ScheduledTaskRunTable.owner),
                      ),
                    )
                    .returning()
                    .get()
                    .pipe(Effect.orDie)
                }
                return yield* db
                  .update(ScheduledTaskRunTable)
                  .set({
                    status: "interrupted",
                    ended_at: Date.now(),
                    error: {
                      code: "REQUEST_CONFLICT",
                      retryable: false,
                      requestId: row.id,
                      details: "execution owner unavailable",
                    },
                  })
                  .where(
                    and(
                      eq(ScheduledTaskRunTable.id, row.id),
                      eq(ScheduledTaskRunTable.status, row.status),
                      row.owner ? eq(ScheduledTaskRunTable.owner, row.owner) : isNull(ScheduledTaskRunTable.owner),
                    ),
                  )
                  .returning()
                  .get()
                  .pipe(Effect.orDie)
              }),
            )
            if (!recovered) return
            const task = yield* loadTask(recovered.task_id)
            if (!task) return
            yield* publish(fromTask(task), fromRun(recovered))
          }),
        )
      }
    })

    const reportTickFailure = <E>(cause: Cause.Cause<E>, taskID?: ScheduledTask.ID) => {
      if (Cause.hasInterrupts(cause)) return Effect.failCause(cause)
      return Effect.logWarning("scheduled task polling failed; continuing on the next opportunity").pipe(
        Effect.annotateLogs({ ...(taskID ? { taskID } : {}), reasons: cause.reasons.map((reason) => reason._tag) }),
      )
    }

    const tick = Effect.fn("ScheduledTask.tick")(function* (beforeAdmission?: Effect.Effect<void>) {
      if (!gates.scheduledTasks) return
      yield* recover()
      const now = yield* DateTime.now
      const tasks = yield* listTasks()
      for (const row of tasks) {
        const task = fromTask(row)
        if (!task.enabled) continue
        for (const slot of dueSlots(task, now)) {
          if (beforeAdmission) yield* beforeAdmission
          yield* withAdmission(
            task.id,
            slot.at,
            slot.missed ? "missed" : "pending",
            (admission) => {
              if (admission.kind !== "created" || slot.missed) return Effect.void
              return execute(admission.task, admission.run)
            },
            row,
          ).pipe(Effect.catchCause((cause) => reportTickFailure(cause, task.id)))
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
    yield* recover().pipe(Effect.orDie)
    if (gates.scheduledTasks) {
      yield* tick().pipe(
        Effect.catchCause((cause) => reportTickFailure(cause)),
        Effect.repeat(Schedule.spaced(Duration.seconds(30))),
        Effect.forkScoped,
      )
    }

    const service = Service.of({
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
        yield* states.withLock(task.id)(insertTask(task).pipe(Effect.andThen(publish(task))))
        return task
      }),
      remove: Effect.fn("ScheduledTask.remove")(function* (id) {
        yield* states.withLock(id)(
          Effect.gen(function* () {
            notices.delete(id)
            yield* db
              .delete(ScheduledTaskRunTable)
              .where(eq(ScheduledTaskRunTable.task_id, id))
              .run()
              .pipe(Effect.orDie)
            yield* db.delete(ScheduledTaskTable).where(eq(ScheduledTaskTable.id, id)).run().pipe(Effect.orDie)
          }),
        )
      }),
      runNow: Effect.fn("ScheduledTask.runNow")(function* (id, at?: DateTime.Utc) {
        yield* recover(id).pipe(Effect.orDie)
        const slot = at ?? (yield* currentSlot())
        return yield* withAdmission(id, slot, "pending", (admission) =>
          Effect.gen(function* () {
            if (admission.kind === "active") return admission.run
            if (admission.kind !== "created") return yield* new ConflictError({ taskID: id })
            yield* perform(admission.task, admission.run)
            const finished = yield* loadRun(admission.run.id)
            return finished ? fromRun(finished) : admission.run
          }),
        )
      }),
      setEnabled: Effect.fn("ScheduledTask.setEnabled")((id, enabled) =>
        states.withLock(id)(
          Effect.gen(function* () {
            const row = yield* loadTask(id)
            if (!row) return yield* new NotFoundError({ taskID: id })
            if (!enabled) {
              const paused = yield* disable(id, "disabled").pipe(Effect.orDie)
              if (!paused) return yield* new NotFoundError({ taskID: id })
              yield* publish(paused.task)
              for (const interrupted of paused.runs) yield* publish(paused.task, interrupted)
              return paused.task
            }
            yield* db
              .update(ScheduledTaskTable)
              .set({ enabled: true })
              .where(eq(ScheduledTaskTable.id, id))
              .run()
              .pipe(Effect.orDie)
            const updated = yield* loadTask(id)
            const task = fromTask(updated ?? row)
            yield* publish(task)
            return task
          }),
        ),
      ),
    })
    recoveryEntries.set(service, (taskID) => recover(taskID))
    tickEntries.set(service, (beforeAdmission) => tick(beforeAdmission).pipe(Effect.orDie))
    projectLockEntries.set(service, (projectID) =>
      Effect.gen(function* () {
        const release = yield* Deferred.make<void>()
        heldProjectLocks.set(projectID, release)
        return yield* locks.withLock(projectID)(Deferred.await(release))
      }),
    )
    projectReleaseEntries.set(service, (projectID) =>
      Effect.sync(() => {
        const release = heldProjectLocks.get(projectID)
        if (release) Deferred.doneUnsafe(release, Effect.void)
        heldProjectLocks.delete(projectID)
      }),
    )
    return service
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [
    EffectFlock.node,
    Database.node,
    EventV2.node,
    FSUtil.node,
    Global.node,
    ProjectV2.node,
    RelayAuth.node,
    RelayCatalog.node,
    RelayGate.node,
    SessionV2.node,
  ],
})
