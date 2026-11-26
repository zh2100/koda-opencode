import { TestClock } from "effect/testing"
import { describe, expect } from "bun:test"
import path from "path"
import { Deferred, Duration, Effect, Fiber, Layer, Stream } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { asc, eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { Location } from "@opencode-ai/core/location"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionTitle } from "@opencode-ai/core/session/title"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { LLMError, Model, TransportReason } from "@opencode-ai/llm"
import { route } from "@opencode-ai/llm/protocols/openai-chat"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
    directories: () => Effect.succeed([]),
    commit: () => Effect.void,
  }),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionStore.node, SessionV2.node]),
    [
      [ProjectV2.node, projects],
      [SessionExecution.node, SessionExecution.noopLayer],
    ],
  ),
)
const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })
const id = SessionV2.ID.create()

describe("SessionV2.create", () => {
  it.effect("creates a fresh projected session when the ID is omitted", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service

      const first = yield* session.create({ location })
      const second = yield* session.create({ location })

      expect(second.id).not.toBe(first.id)
      expect(yield* session.list()).toHaveLength(2)
    }),
  )

  it.effect("returns the original session when the ID is retried", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const input = { id, location }

      const first = yield* session.create(input)
      const retried = yield* session.create(input)

      expect(retried).toEqual(first)
      expect(yield* session.list()).toEqual([first])
    }),
  )

  it.effect("stores supplied immutable create attributes", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const workspaceID = WorkspaceV2.ID.make("wrk_test")
      const model = ModelV2.Ref.make({
        id: ModelV2.ID.make("sonnet"),
        providerID: ProviderV2.ID.anthropic,
        variant: ModelV2.VariantID.make("fast"),
      })

      expect(
        yield* session.create({
          location: Location.Ref.make({ directory: location.directory, workspaceID }),
          agent: AgentV2.ID.make("build"),
          model,
        }),
      ).toMatchObject({ location: { directory: location.directory, workspaceID }, agent: "build", model })
    }),
  )

  it.effect("returns the existing Session when one ID is reused with different create arguments", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const created = yield* session.create({ id, location })
      const changed = [
        { id, location: Location.Ref.make({ directory: AbsolutePath.make("/other") }) },
        { id, location, agent: AgentV2.ID.make("build") },
        {
          id,
          location,
          model: ModelV2.Ref.make({ id: ModelV2.ID.make("sonnet"), providerID: ProviderV2.ID.anthropic }),
        },
      ]

      for (const input of changed) {
        expect(yield* session.create(input)).toEqual(created)
      }
      expect(yield* session.list()).toHaveLength(1)
    }),
  )

  it.effect("returns one recorded session to concurrent exact retries", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const input = { id, location }

      const created = yield* Effect.all([session.create(input), session.create(input)], { concurrency: "unbounded" })

      expect(created[1]).toEqual(created[0])
      expect(yield* session.list()).toEqual([created[0]])
    }),
  )

  it.effect("returns the current Session projection after updates", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const input = { id, location }
      const created = yield* session.create(input)

      yield* db.update(SessionTable).set({ agent: "build" }).where(eq(SessionTable.id, id)).run().pipe(Effect.orDie)

      expect(yield* session.create(input)).toMatchObject({ id: created.id, agent: "build" })
    }),
  )

  it.effect("returns the current Session projection after projected updates", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const input = { id, location }
      const created = yield* session.create(input)

      yield* events.publish(SessionV1.Event.Updated, {
        sessionID: id,
        info: SessionV1.SessionInfo.make({
          id,
          slug: "updated",
          version: "test",
          projectID: created.projectID,
          directory: created.location.directory,
          title: "updated",
          agent: "build",
          time: { created: 0, updated: 1 },
        }),
      })

      expect(yield* session.create(input)).toMatchObject({ id, agent: "build" })
    }),
  )

  it.effect("persists a renamed title through the existing updated event", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const created = yield* session.create({ location, title: "before" })

      yield* session.setTitle({ sessionID: created.id, title: "after" })

      expect(yield* session.get(created.id)).toMatchObject({ id: created.id, title: "after" })
    }),
  )

  it.effect("persists creation through the existing legacy created event", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ location })

      expect(
        yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, created.id)).all().pipe(Effect.orDie),
      ).toMatchObject([{ type: EventV2.versionedType(SessionV1.Event.Created.type, 1) }])
    }),
  )

  it.effect("persists caller-ID creation through the existing created event", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ id, location })

      expect(
        yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, created.id)).get().pipe(Effect.orDie),
      ).toMatchObject({
        data: { sessionID: id },
      })
    }),
  )

  it.effect("omits legacy creation rows from the V2 Session event stream", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ location })
      yield* session.prompt({ sessionID: created.id, prompt: Prompt.make({ text: "Hello" }), resume: false })
      yield* SessionInput.promoteSteers(db, events, created.id, Number.MAX_SAFE_INTEGER)

      expect(
        Array.from(yield* session.events({ sessionID: created.id }).pipe(Stream.take(2), Stream.runCollect)),
      ).toMatchObject([
        { durable: { seq: 1 }, type: "session.next.prompt.admitted", data: { prompt: { text: "Hello" } } },
        { durable: { seq: 2 }, type: "session.next.prompted" },
      ])
    }),
  )

  it.effect("replays one prompt lifecycle into a fresh target database", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const sourceEvents = yield* EventV2.Service
      const sourceDb = (yield* Database.Service).db
      const created = yield* session.create({ id: SessionV2.ID.make("ses_fresh_target_replay"), location })
      const admitted = yield* session.prompt({
        sessionID: created.id,
        prompt: Prompt.make({ text: "Replay lifecycle" }),
        resume: false,
      })
      yield* SessionInput.promoteSteers(sourceDb, sourceEvents, created.id, Number.MAX_SAFE_INTEGER)
      const serialized = (yield* sourceDb
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, created.id))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)).map((event) => ({
        id: event.id,
        aggregateID: event.aggregate_id,
        seq: event.seq,
        type: event.type,
        data: event.data,
      }))

      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const targetDatabase = Database.layerFromPath(path.join(tmp.path, "target.sqlite"))
      const targetLayer = AppNodeBuilder.build(
        LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionStore.node]),
        [[Database.node, targetDatabase]],
      )

      yield* Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const events = yield* EventV2.Service
        const store = yield* SessionStore.Service
        yield* db
          .insert(ProjectTable)
          .values({ id: ProjectV2.ID.global, worktree: location.directory, sandboxes: [] })
          .run()
          .pipe(Effect.orDie)

        expect(yield* store.get(created.id)).toBeUndefined()
        expect(yield* events.replayAll(serialized.slice(0, 2))).toBe(created.id)
        expect(yield* SessionInput.find(db, admitted.id)).toMatchObject({
          id: admitted.id,
          sessionID: created.id,
          prompt: { text: "Replay lifecycle" },
          delivery: "steer",
          admittedSeq: 1,
        })
        expect(yield* store.context(created.id)).toEqual([])

        expect(yield* events.replayAll(serialized.slice(2))).toBe(created.id)
        expect(yield* SessionInput.find(db, admitted.id)).toMatchObject({
          id: admitted.id,
          sessionID: created.id,
          prompt: { text: "Replay lifecycle" },
          delivery: "steer",
          admittedSeq: 1,
          promotedSeq: 2,
        })
        expect(yield* store.context(created.id)).toMatchObject([
          { id: admitted.id, type: "user", text: "Replay lifecycle" },
        ])
        expect(
          (yield* db
            .select()
            .from(EventTable)
            .where(eq(EventTable.aggregate_id, created.id))
            .orderBy(asc(EventTable.seq))
            .all()
            .pipe(Effect.orDie)).map((event) => [event.seq, event.type]),
        ).toEqual([
          [0, EventV2.versionedType(SessionV1.Event.Created.type, 1)],
          [1, EventV2.versionedType(SessionEvent.PromptAdmitted.type, 1)],
          [2, EventV2.versionedType(SessionEvent.Prompted.type, 1)],
        ])
      }).pipe(Effect.provide(Layer.fresh(targetLayer)))
    }),
  )

  it.effect("replays reverted inbox eligibility while preserving the admission ledger", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const sourceEvents = yield* EventV2.Service
      const database = yield* Database.Service
      const created = yield* session.create({ location })
      const boundary = yield* session.prompt({
        sessionID: created.id,
        prompt: Prompt.make({ text: "Retained boundary" }),
        resume: false,
      })
      yield* SessionInput.promoteSteers(database.db, sourceEvents, created.id, Number.MAX_SAFE_INTEGER)
      const discarded = yield* session.prompt({
        sessionID: created.id,
        prompt: Prompt.make({ text: "Discarded queue" }),
        delivery: "queue",
        resume: false,
      })
      yield* sourceEvents.publish(SessionEvent.RevertEvent.Committed, {
        sessionID: created.id,
        messageID: boundary.id,
        timestamp: created.time.created,
      })
      const expected = yield* SessionInput.find(database.db, discarded.id)
      const pending = yield* session.pending(created.id)
      const serialized = (yield* database.db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, created.id))
        .orderBy(asc(EventTable.seq))
        .all()).map((event) => ({
        id: event.id,
        aggregateID: event.aggregate_id,
        seq: event.seq,
        type: event.type,
        data: event.data,
      }))
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const target = AppNodeBuilder.build(
        LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionStore.node]),
        [[Database.node, Database.layerFromPath(path.join(tmp.path, "reverted.sqlite"))]],
      )
      yield* Effect.gen(function* () {
        const database = yield* Database.Service
        const events = yield* EventV2.Service
        const store = yield* SessionStore.Service
        yield* database.db
          .insert(ProjectTable)
          .values({ id: ProjectV2.ID.global, worktree: location.directory, sandboxes: [] })
          .run()
        expect(yield* events.replayAll(serialized)).toBe(created.id)
        expect(yield* SessionInput.find(database.db, discarded.id)).toEqual(expected)
        expect(yield* SessionInput.pending(database.db, created.id)).toEqual(pending)
        expect(yield* SessionInput.hasPending(database.db, created.id, "queue")).toBe(false)
        expect(yield* store.context(created.id)).toMatchObject([{ id: boundary.id, type: "user" }])
        expect(yield* events.replayAll(serialized)).toBe(created.id)
        expect(yield* SessionInput.pending(database.db, created.id)).toEqual(pending)
      }).pipe(Effect.provide(Layer.fresh(target)))
    }),
  )

  it.effect("does not mask unrelated created projector defects", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const event = yield* EventV2.Service
      const defect = new Error("unrelated projector defect")
      yield* event.project(SessionV1.Event.Created, () => Effect.die(defect))

      expect(yield* session.create({ id, location }).pipe(Effect.catchDefect(Effect.succeed))).toBe(defect)
    }),
  )

  it.effect("reports unfinished Session operations as unavailable", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const created = yield* session.create({ location })
      const unavailable = (
        effect: Effect.Effect<void, SessionV2.NotFoundError | SessionV2.OperationUnavailableError>,
      ) =>
        effect.pipe(
          Effect.flip,
          Effect.map((error) => (error instanceof SessionV2.OperationUnavailableError ? error.operation : "not-found")),
        )

      expect(yield* unavailable(session.shell({ sessionID: created.id, command: "pwd" }))).toBe("shell")
      expect(yield* unavailable(session.skill({ sessionID: created.id, skill: "review" }))).toBe("skill")
    }),
  )

  it.effect("switches the selected agent through the durable Session event", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const created = yield* session.create({ location })

      yield* session.switchAgent({ sessionID: created.id, agent: "plan" })

      expect(yield* session.get(created.id)).toMatchObject({ agent: "plan" })
      expect(
        Array.from(yield* session.events({ sessionID: created.id }).pipe(Stream.take(1), Stream.runCollect)),
      ).toMatchObject([{ type: "session.next.agent.switched", data: { agent: "plan" } }])
    }),
  )

  it.effect("rejects an agent switch for a missing Session", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const missing = SessionV2.ID.make("ses_missing_agent_switch")

      expect(
        yield* session.switchAgent({ sessionID: missing, agent: "plan" }).pipe(
          Effect.flip,
          Effect.map((error) => error._tag),
        ),
      ).toBe("Session.NotFoundError")
    }),
  )

  it.effect("switches the selected model through the durable Session event", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const created = yield* session.create({ location })
      const model = ModelV2.Ref.make({
        id: ModelV2.ID.make("sonnet"),
        providerID: ProviderV2.ID.anthropic,
        variant: ModelV2.VariantID.make("high"),
      })

      yield* session.switchModel({ sessionID: created.id, model })

      expect(yield* session.get(created.id)).toMatchObject({ model })
      expect(
        Array.from(yield* session.events({ sessionID: created.id }).pipe(Stream.take(1), Stream.runCollect)),
      ).toMatchObject([{ type: "session.next.model.switched", data: { model } }])
    }),
  )

  it.effect("ignores a model switch when the selected model is unchanged", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const created = yield* session.create({ location })
      const model = ModelV2.Ref.make({ id: ModelV2.ID.make("sonnet"), providerID: ProviderV2.ID.anthropic })

      yield* session.switchModel({ sessionID: created.id, model })
      yield* session.switchModel({ sessionID: created.id, model })

      const { db } = yield* Database.Service
      expect(
        yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, created.id)).all().pipe(Effect.orDie),
      ).toHaveLength(2)
      expect(yield* session.get(created.id)).toMatchObject({ model })
    }),
  )

  it.effect("treats an omitted variant as the default variant", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const model = ModelV2.Ref.make({ id: ModelV2.ID.make("sonnet"), providerID: ProviderV2.ID.anthropic })
      const created = yield* session.create({ location, model })

      yield* session.switchModel({
        sessionID: created.id,
        model: ModelV2.Ref.make({ ...model, variant: ModelV2.VariantID.make("default") }),
      })

      const { db } = yield* Database.Service
      expect(
        yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, created.id)).all().pipe(Effect.orDie),
      ).toHaveLength(1)
    }),
  )

  it.effect("rejects a model switch for a missing Session", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const missing = SessionV2.ID.make("ses_missing_model_switch")

      expect(
        yield* session
          .switchModel({
            sessionID: missing,
            model: ModelV2.Ref.make({ id: ModelV2.ID.make("sonnet"), providerID: ProviderV2.ID.anthropic }),
          })
          .pipe(
            Effect.flip,
            Effect.map((error) => error._tag),
          ),
      ).toBe("Session.NotFoundError")
    }),
  )
})

const titleModel = Model.make({ id: "title-test", provider: "local", route })

describe("V2 automatic titles", () => {
  it.effect("titles the first actually promoted input once and preserves metadata", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const created = yield* sessions.create({ location })
      yield* db
        .update(SessionTable)
        .set({ metadata: { scheduledApprovalMode: "plan", custom: "keep" }, cost: 12 })
        .where(eq(SessionTable.id, created.id))
      const queued = yield* SessionInput.admit(db, events, {
        id: SessionMessage.ID.create(),
        sessionID: created.id,
        prompt: Prompt.make({ text: "Queued later" }),
        delivery: "queue",
      })
      const steer = yield* SessionInput.admit(db, events, {
        id: SessionMessage.ID.create(),
        sessionID: created.id,
        prompt: Prompt.make({ text: "修复会话标题" }),
        delivery: "steer",
      })
      const promoted: SessionMessage.ID[] = []
      yield* SessionInput.promoteSteers(db, events, created.id, steer.admittedSeq, promoted)
      let calls = 0
      const title = SessionTitle.make(db, events, {
        generate: () =>
          Effect.sync(() => {
            calls++
            return { text: "“修复会话自动命名”\nextra" }
          }),
      })
      yield* title({ session: created, promoted, model: titleModel })
      expect((yield* sessions.get(created.id)).title).toBe("修复会话自动命名")
      const after: SessionMessage.ID[] = []
      yield* SessionInput.promoteNextQueued(db, events, created.id, after)
      yield* title({ session: created, promoted: after, model: titleModel })
      expect(calls).toBe(1)
      expect(after).toEqual([queued.id])
      const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, created.id)).get()
      expect(row).toMatchObject({ cost: 12, metadata: { scheduledApprovalMode: "plan", custom: "keep" } })
      const updates = yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, created.id)).all()
      expect(updates.filter((event) => event.type.startsWith("session.updated"))).toHaveLength(1)
    }),
  )

  it.effect("manual rename wins while title generation is suspended", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const created = yield* sessions.create({ location })
      const input = yield* SessionInput.admit(db, events, {
        id: SessionMessage.ID.create(),
        sessionID: created.id,
        prompt: Prompt.make({ text: "Original message" }),
        delivery: "steer",
      })
      const promoted: SessionMessage.ID[] = []
      yield* SessionInput.promoteSteers(db, events, created.id, input.admittedSeq, promoted)
      const started = yield* Deferred.make<void>()
      const gate = yield* Deferred.make<void>()
      const title = SessionTitle.make(db, events, {
        generate: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(gate)),
            Effect.as({ text: "Automatic title" }),
          ),
      })
      const fiber = yield* title({ session: created, promoted, model: titleModel }).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* sessions.setTitle({ sessionID: created.id, title: "Manual title" })
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(fiber)
      expect((yield* sessions.get(created.id)).title).toBe("Manual title")
    }),
  )

  it.effect("empty output falls back to content; admission alone never names", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const created = yield* sessions.create({ location })
      const input = yield* SessionInput.admit(db, events, {
        id: SessionMessage.ID.create(),
        sessionID: created.id,
        prompt: Prompt.make({ text: "根据内容命名\n后续细节" }),
        delivery: "queue",
      })
      let calls = 0
      const title = SessionTitle.make(db, events, {
        generate: () =>
          Effect.sync(() => {
            calls++
            return { text: "" }
          }),
      })
      yield* title({ session: created, promoted: [], model: titleModel })
      expect(calls).toBe(0)
      const promoted: SessionMessage.ID[] = []
      yield* SessionInput.promoteNextQueued(db, events, created.id, promoted)
      expect(promoted).toEqual([input.id])
      yield* title({ session: created, promoted, model: titleModel })
      expect((yield* sessions.get(created.id)).title).toBe("根据内容命名")
      expect(calls).toBe(1)
    }),
  )
})

describe("V2 title failure boundaries", () => {
  it.effect("provider failure uses content without retrying", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const created = yield* sessions.create({ location })
      const input = yield* SessionInput.admit(db, events, {
        id: SessionMessage.ID.create(),
        sessionID: created.id,
        prompt: Prompt.make({ text: "失败时使用内容标题" }),
        delivery: "steer",
      })
      const promoted: SessionMessage.ID[] = []
      yield* SessionInput.promoteSteers(db, events, created.id, input.admittedSeq, promoted)
      let calls = 0
      const title = SessionTitle.make(db, events, {
        generate: () =>
          Effect.sync(() => calls++).pipe(
            Effect.andThen(
              Effect.fail(
                new LLMError({
                  module: "test",
                  method: "generate",
                  reason: new TransportReason({ message: "offline" }),
                }),
              ),
            ),
          ),
      })
      yield* title({ session: created, promoted, model: titleModel })
      expect(calls).toBe(1)
      expect((yield* sessions.get(created.id)).title).toBe("失败时使用内容标题")
    }),
  )

  it.effect("skips custom titles, child sessions, attachment-only input and deleted sessions", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const root = yield* sessions.create({ location })
      const custom = yield* sessions.create({ location, title: "我的标题" })
      const child = yield* sessions.create({ location, parentID: root.id })
      let calls = 0
      const title = SessionTitle.make(db, events, {
        generate: () =>
          Effect.sync(() => {
            calls++
            return { text: "Unexpected" }
          }),
      })
      for (const created of [custom, child, root]) {
        const input = yield* SessionInput.admit(db, events, {
          id: SessionMessage.ID.create(),
          sessionID: created.id,
          prompt: Prompt.make({ text: created.id === root.id ? "" : "Text" }),
          delivery: "steer",
        })
        const promoted: SessionMessage.ID[] = []
        yield* SessionInput.promoteSteers(db, events, created.id, input.admittedSeq, promoted)
        yield* title({ session: created, promoted, model: titleModel })
      }
      yield* db.delete(SessionTable).where(eq(SessionTable.id, root.id))
      expect(
        yield* SessionTitle.rename(db, events, { sessionID: root.id, expected: root.title, title: "No resurrection" }),
      ).toBe(false)
      expect(calls).toBe(0)
      expect(SessionTitle.normalize("😀".repeat(100))).toBe("😀".repeat(80))
    }),
  )
})

describe("V2 title timeout", () => {
  it.effect("bounds a stalled model request and uses content without retry", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const created = yield* sessions.create({ location })
      const input = yield* SessionInput.admit(db, events, {
        id: SessionMessage.ID.create(),
        sessionID: created.id,
        prompt: Prompt.make({ text: "超时后的内容标题" }),
        delivery: "steer",
      })
      const promoted: SessionMessage.ID[] = []
      yield* SessionInput.promoteSteers(db, events, created.id, input.admittedSeq, promoted)
      let calls = 0
      const title = SessionTitle.make(db, events, {
        generate: () => Effect.sync(() => calls++).pipe(Effect.andThen(Effect.never)),
      })
      const fiber = yield* title({ session: created, promoted, model: titleModel }).pipe(Effect.forkChild)
      yield* TestClock.adjust(Duration.seconds(20))
      yield* Fiber.join(fiber)
      expect((yield* sessions.get(created.id)).title).toBe("超时后的内容标题")
      expect(calls).toBe(1)
    }),
  )
})
