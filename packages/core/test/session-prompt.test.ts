import { describe, expect } from "bun:test"
import { DateTime, Effect, Fiber, Layer, Stream } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV2 } from "@opencode-ai/core/session"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionInputTable, SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { testEffect } from "./lib/effect"

const executionCalls: SessionV2.ID[] = []
const interruptCalls: SessionV2.ID[] = []
const wakeCalls: SessionV2.ID[] = []
const activeSessions = new Set<SessionV2.ID>()
const execution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    active: Effect.sync(() => new Set(activeSessions)),
    withBarrier: () => (effect) => effect,
    resume: (sessionID) =>
      Effect.sync(() => {
        executionCalls.push(sessionID)
      }),
    interrupt: (sessionID) =>
      Effect.sync(() => {
        interruptCalls.push(sessionID)
      }),
    wake: (sessionID) =>
      Effect.sync(() => {
        wakeCalls.push(sessionID)
      }),
  }),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionStore.node, SessionV2.node]),
    [[SessionExecution.node, execution]],
  ),
)
const sessionID = SessionV2.ID.make("ses_prompt_test")
const messageID = SessionMessage.ID.create()

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "test",
      directory: "/project",
      title: "test",
      version: "test",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

const admitted = (id: SessionMessage.ID) => Database.Service.use(({ db }) => SessionInput.find(db, id))
const admittedCount = Database.Service.use(({ db }) =>
  db
    .select()
    .from(SessionInputTable)
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows.length),
    ),
)
const eventCount = (type: string) =>
  Database.Service.use(({ db }) =>
    db
      .select()
      .from(EventTable)
      .where(eq(EventTable.type, type))
      .all()
      .pipe(
        Effect.orDie,
        Effect.map((rows) => rows.length),
      ),
  )

describe("SessionV2.prompt", () => {
  it.effect("exposes the execution registry", () =>
    Effect.gen(function* () {
      activeSessions.add(sessionID)
      expect(Array.from(yield* (yield* SessionV2.Service).active)).toEqual([sessionID])
    }).pipe(Effect.ensuring(Effect.sync(() => activeSessions.clear()))),
  )

  it.effect("delegates execution continuation through SessionExecution", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      executionCalls.length = 0
      wakeCalls.length = 0
      yield* session.resume(sessionID)
      expect(executionCalls).toEqual([sessionID])
      expect(wakeCalls).toEqual([])
    }),
  )

  it.effect("delegates process-local interruption through SessionExecution", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      interruptCalls.length = 0

      yield* session.interrupt(sessionID)
      expect(interruptCalls).toEqual([sessionID])
      expect(yield* session.messages({ sessionID })).toEqual([])
    }),
  )

  it.effect("delegates interruption without requiring a recorded Session", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      interruptCalls.length = 0

      yield* session.interrupt(SessionV2.ID.make("ses_missing"))
      expect(interruptCalls).toEqual([SessionV2.ID.make("ses_missing")])
    }),
  )

  it.effect("durably admits one user message before transcript promotion", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service

      const message = yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Fix the failing tests" }),
        resume: false,
      })

      expect(message.prompt.text).toBe("Fix the failing tests")
      expect(yield* session.messages({ sessionID })).toEqual([])
      expect(yield* admitted(message.id)).toMatchObject({
        id: message.id,
        sessionID,
        prompt: { text: "Fix the failing tests" },
        delivery: "steer",
      })
    }),
  )

  it.effect("resolves attachment MIME before admission", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service

      const message = yield* session.prompt({
        sessionID,
        prompt: {
          text: "Inspect this image",
          files: [{ uri: "data:image/png;base64,aGVsbG8=", name: "image.png" }],
        },
        resume: false,
      })

      expect(message.prompt.files).toEqual([
        { uri: "data:image/png;base64,aGVsbG8=", name: "image.png", mime: "image/png" },
      ])
      expect((yield* admitted(message.id))?.prompt.files).toEqual(message.prompt.files)
    }),
  )

  it.effect("streams durable Session events after an aggregate sequence", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const fiber = yield* session.events({ sessionID }).pipe(Stream.take(4), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow

      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      yield* SessionInput.promoteSteers(db, events, sessionID, Number.MAX_SAFE_INTEGER)
      const streamed = Array.from(yield* Fiber.join(fiber))

      expect(streamed.map((event) => [event.durable?.seq, event.type])).toEqual([
        [0, "session.next.prompt.admitted"],
        [1, "session.next.prompt.admitted"],
        [2, "session.next.prompted"],
        [3, "session.next.prompted"],
      ])
      expect(
        Array.from(
          yield* session
            .events({ sessionID, after: streamed[0]!.durable?.seq })
            .pipe(Stream.take(1), Stream.runCollect),
        ).map((event) => [event.durable?.seq, event.type]),
      ).toEqual([[1, "session.next.prompt.admitted"]])
    }),
  )

  it.effect("resumes through a recorded message without appending another prompt", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const message = yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Fix the failing tests" }),
        resume: false,
      })

      executionCalls.length = 0
      wakeCalls.length = 0
      yield* session.resume(sessionID)

      expect(yield* session.messages({ sessionID })).toEqual([])
      expect(yield* admitted(message.id)).not.toHaveProperty("promotedSeq")
      expect(executionCalls).toEqual([sessionID])
      expect(wakeCalls).toEqual([])
    }),
  )

  it.effect("records distinct messages when the ID is omitted", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const input = { sessionID, prompt: Prompt.make({ text: "Fix the failing tests" }), resume: false }

      const first = yield* session.prompt(input)
      const second = yield* session.prompt(input)

      expect(second.id).not.toBe(first.id)
      expect(yield* session.messages({ sessionID })).toEqual([])
      expect(yield* admittedCount).toBe(2)
    }),
  )

  it.effect("returns the original recorded message when the ID is retried", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const input = {
        sessionID,
        id: messageID,
        prompt: Prompt.make({ text: "Fix the failing tests" }),
        resume: false,
      }

      const first = yield* session.prompt(input)
      const retried = yield* session.prompt(input)

      expect(retried).toEqual(first)
      expect(yield* session.messages({ sessionID })).toEqual([])
      expect(yield* admittedCount).toBe(1)
    }),
  )

  it.effect("does not wake execution when an exact retry returns an admitted prompt", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const input = {
        sessionID,
        id: messageID,
        prompt: Prompt.make({ text: "Recover committed prompt" }),
        resume: false,
      }
      const first = yield* session.prompt(input)
      wakeCalls.length = 0

      const retried = yield* session.prompt({ ...input, resume: true })

      expect(retried).toEqual(first)
      expect(wakeCalls).toEqual([])
    }),
  )

  it.effect("wakes only once for concurrent exact retries", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const input = { sessionID, id: messageID, prompt: Prompt.make({ text: "Run once" }) }
      wakeCalls.length = 0
      interruptCalls.length = 0

      const results = yield* Effect.all([session.prompt(input), session.prompt(input)], { concurrency: "unbounded" })

      expect(results[1]).toEqual(results[0])
      expect(yield* admittedCount).toBe(1)
      expect(yield* eventCount(EventV2.versionedType(SessionEvent.PromptAdmitted.type, 1))).toBe(1)
      expect(wakeCalls).toEqual([sessionID])
      expect(interruptCalls).toEqual([])
    }),
  )

  it.effect("rejects ordinary sends while a revert is staged without changing history or scheduling work", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const target = SessionMessage.ID.create()
      const prompt = Prompt.make({ text: "Original history" })
      yield* events.publish(SessionEvent.Prompted, {
        sessionID,
        messageID: target,
        timestamp: yield* DateTime.now,
        prompt,
        delivery: "steer",
      })
      yield* events.publish(SessionEvent.RevertEvent.Staged, {
        sessionID,
        timestamp: yield* DateTime.now,
        revert: { messageID: target, files: [] },
      })
      wakeCalls.length = 0
      interruptCalls.length = 0

      const failure = yield* session
        .prompt({ sessionID, id: messageID, prompt: Prompt.make({ text: "Stale window draft" }) })
        .pipe(Effect.flip)

      expect(failure).toMatchObject({ _tag: "Session.PromptConflictError", sessionID, messageID })
      expect(yield* admitted(messageID)).toBeUndefined()
      expect(yield* admittedCount).toBe(1)
      expect(yield* eventCount(EventV2.versionedType(SessionEvent.PromptAdmitted.type, 1))).toBe(0)
      expect(yield* session.messages({ sessionID })).toMatchObject([{ id: target, text: prompt.text }])
      expect((yield* session.get(sessionID)).revert).toMatchObject({ messageID: target })
      expect(wakeCalls).toEqual([])
      expect(interruptCalls).toEqual([])
    }),
  )

  it.effect("returns a previously admitted prompt even after another window stages a revert", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const input = { sessionID, id: messageID, prompt: Prompt.make({ text: "Already admitted" }) }
      const first = yield* session.prompt(input)
      yield* events.publish(SessionEvent.RevertEvent.Staged, {
        sessionID,
        timestamp: yield* DateTime.now,
        revert: { messageID, files: [] },
      })
      wakeCalls.length = 0
      interruptCalls.length = 0

      expect(yield* session.prompt(input)).toEqual(first)
      expect((yield* session.get(sessionID)).revert).toMatchObject({ messageID })
      expect(yield* admittedCount).toBe(1)
      expect(wakeCalls).toEqual([])
      expect(interruptCalls).toEqual([])
    }),
  )

  it.effect("keeps reverted admission identities but never promotes their pending work", () =>
    Effect.gen(function* () {
      yield* setup
      const database = yield* Database.Service
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const target = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Prompted, {
        sessionID,
        messageID: target,
        timestamp: yield* DateTime.now,
        prompt: Prompt.make({ text: "Keep this boundary" }),
        delivery: "steer",
      })
      const input = { sessionID, id: messageID, prompt: Prompt.make({ text: "Discard this steer" }) }
      const steer = yield* session.prompt(input)
      const queue = yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Discard this queue" }),
        delivery: "queue",
        resume: false,
      })
      const committed = yield* events.publish(SessionEvent.RevertEvent.Committed, {
        sessionID,
        messageID: target,
        timestamp: yield* DateTime.now,
      })
      if (!committed.durable) return yield* Effect.die("Expected durable revert")
      wakeCalls.length = 0

      expect(yield* session.prompt(input)).toEqual({ ...steer, invalidatedSeq: committed.durable.seq })
      expect(yield* admitted(queue.id)).toEqual({ ...queue, invalidatedSeq: committed.durable.seq })
      expect(yield* SessionInput.hasPending(database.db, sessionID, "steer")).toBe(false)
      expect(yield* SessionInput.hasPending(database.db, sessionID, "queue")).toBe(false)
      expect(yield* SessionInput.promoteSteers(database.db, events, sessionID, Number.MAX_SAFE_INTEGER)).toBe(0)
      expect(yield* SessionInput.promoteNextQueued(database.db, events, sessionID)).toBe(false)
      expect(yield* session.messages({ sessionID })).toMatchObject([{ id: target }])
      expect(wakeCalls).toEqual([])

      const failure = yield* session
        .prompt({ ...input, prompt: Prompt.make({ text: "Reuse discarded ID" }) })
        .pipe(Effect.flip)
      expect(failure._tag).toBe("Session.PromptConflictError")
      expect(yield* admittedCount).toBe(3)
    }),
  )

  it.effect(
    "invalidates queued work admitted before the retained boundary and rejects late promotions atomically",
    () =>
      Effect.gen(function* () {
        yield* setup
        const database = yield* Database.Service
        const session = yield* SessionV2.Service
        const events = yield* EventV2.Service
        const queued = yield* session.prompt({
          sessionID,
          prompt: Prompt.make({ text: "Queued before the retained user message" }),
          delivery: "queue",
          resume: false,
        })
        const target = SessionMessage.ID.create()
        yield* events.publish(SessionEvent.Prompted, {
          sessionID,
          messageID: target,
          timestamp: yield* DateTime.now,
          prompt: Prompt.make({ text: "Keep this boundary" }),
          delivery: "steer",
        })
        const input = {
          sessionID,
          id: SessionMessage.ID.create(),
          prompt: Prompt.make({ text: "Promoted on the discarded branch" }),
          resume: false,
        }
        const recorded = yield* session.prompt(input)
        yield* SessionInput.promoteSteers(database.db, events, sessionID, Number.MAX_SAFE_INTEGER)
        const promoted = yield* admitted(recorded.id)
        if (!promoted) return yield* Effect.die("Expected promoted admission")
        const committed = yield* events.publish(SessionEvent.RevertEvent.Committed, {
          sessionID,
          messageID: target,
          timestamp: yield* DateTime.now,
        })
        if (!committed.durable) return yield* Effect.die("Expected durable revert")

        expect(yield* SessionInput.hasPending(database.db, sessionID, "queue")).toBe(false)
        expect(yield* session.prompt(input)).toEqual({ ...promoted, invalidatedSeq: committed.durable.seq })
        const promptedCount = yield* eventCount(SessionEvent.Prompted.type)
        for (const stored of [queued, recorded]) {
          const exit = yield* events
            .publish(SessionEvent.Prompted, {
              sessionID,
              messageID: stored.id,
              timestamp: stored.timeCreated,
              prompt: stored.prompt,
              delivery: stored.delivery,
            })
            .pipe(Effect.exit)
          expect(exit._tag).toBe("Failure")
        }
        expect(yield* eventCount(SessionEvent.Prompted.type)).toBe(promptedCount)
        expect(yield* session.messages({ sessionID })).toMatchObject([{ id: target }])

        yield* events.publish(SessionEvent.RevertEvent.Committed, {
          sessionID,
          messageID: target,
          timestamp: yield* DateTime.now,
        })
        expect(
          yield* database.db
            .select({ invalidated: SessionInputTable.invalidated_seq })
            .from(SessionInputTable)
            .where(eq(SessionInputTable.id, queued.id))
            .get(),
        ).toEqual({ invalidated: committed.durable?.seq })

        const fresh = yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "New branch" }), resume: false })
        expect(yield* SessionInput.promoteSteers(database.db, events, sessionID, Number.MAX_SAFE_INTEGER)).toBe(1)
        expect((yield* session.messages({ sessionID, order: "asc" })).map((message) => message.id)).toEqual([
          target,
          fresh.id,
        ])
      }),
  )

  it.effect("reads eligible pending inputs with a durable watermark without promoting or waking execution", () =>
    Effect.gen(function* () {
      yield* setup
      const database = yield* Database.Service
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      wakeCalls.length = 0
      expect(yield* session.pending(sessionID)).toEqual({ sessionID, sequence: -1, inputs: [] })
      const first = yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Pending steer" }), resume: false })
      const second = yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Pending queue" }),
        delivery: "queue",
        resume: false,
      })
      const other = SessionV2.ID.make("ses_other_inbox")
      yield* session.create({ id: other, location: { directory: AbsolutePath.make("/project") } })
      yield* session.prompt({ sessionID: other, prompt: Prompt.make({ text: "Other session" }), resume: false })
      expect(yield* session.pending(sessionID)).toEqual({
        sessionID,
        sequence: second.admittedSeq,
        inputs: [first, second],
      })
      expect(yield* session.messages({ sessionID })).toEqual([])
      expect(yield* session.context(sessionID)).toEqual([])

      yield* SessionInput.promoteSteers(database.db, events, sessionID, Number.MAX_SAFE_INTEGER)
      expect((yield* session.pending(sessionID)).inputs).toEqual([second])
      const committed = yield* events.publish(SessionEvent.RevertEvent.Committed, {
        sessionID,
        messageID: first.id,
        timestamp: yield* DateTime.now,
      })
      if (!committed.durable) return yield* Effect.die("Expected durable revert")
      expect(yield* session.pending(sessionID)).toEqual({
        sessionID,
        sequence: committed.durable?.seq,
        inputs: [],
      })
      expect(wakeCalls).toEqual([])
      const failure = yield* session.pending(SessionV2.ID.make("ses_missing_inbox")).pipe(Effect.flip)
      expect(failure._tag).toBe("Session.NotFoundError")
    }),
  )

  it.effect("rejects reuse of one ID with a different prompt", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service

      yield* session.prompt({
        sessionID,
        id: messageID,
        prompt: Prompt.make({ text: "Fix the failing tests" }),
      })
      const failure = yield* session
        .prompt({
          sessionID,
          id: messageID,
          prompt: Prompt.make({ text: "Delete the failing tests" }),
          resume: false,
        })
        .pipe(Effect.flip)

      expect(failure._tag).toBe("Session.PromptConflictError")
      expect(yield* session.messages({ sessionID })).toHaveLength(0)
      expect(yield* admittedCount).toBe(1)
    }),
  )

  it.effect("rejects reuse of one ID with a different delivery mode", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service

      yield* session.prompt({
        id: messageID,
        sessionID,
        prompt: Prompt.make({ text: "Fix the failing tests" }),
        resume: false,
      })
      const failure = yield* session
        .prompt({
          id: messageID,
          sessionID,
          prompt: Prompt.make({ text: "Fix the failing tests" }),
          delivery: "queue",
          resume: false,
        })
        .pipe(Effect.flip)

      expect(failure._tag).toBe("Session.PromptConflictError")
    }),
  )

  it.effect("returns one recorded message to concurrent exact retries", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const input = {
        sessionID,
        id: messageID,
        prompt: Prompt.make({ text: "Fix the failing tests" }),
        resume: false,
      }

      const messages = yield* Effect.all([session.prompt(input), session.prompt(input)], { concurrency: "unbounded" })

      expect(messages[1]).toEqual(messages[0])
      expect(yield* session.messages({ sessionID })).toEqual([])
      expect(yield* admittedCount).toBe(1)
      expect(yield* eventCount(EventV2.versionedType(SessionEvent.PromptAdmitted.type, 1))).toBe(1)
    }),
  )

  it.effect("promotes one message once under concurrent promotion attempts", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ id: messageID, sessionID, prompt: Prompt.make({ text: "Promote once" }), resume: false })

      yield* Effect.all(
        [
          SessionInput.promoteSteers(db, events, sessionID, Number.MAX_SAFE_INTEGER),
          SessionInput.promoteSteers(db, events, sessionID, Number.MAX_SAFE_INTEGER),
        ],
        { concurrency: "unbounded" },
      )

      expect(yield* eventCount(EventV2.versionedType(SessionEvent.Prompted.type, 1))).toBe(1)
      expect(yield* admitted(messageID)).toMatchObject({ promotedSeq: 1 })
      expect(yield* session.messages({ sessionID })).toMatchObject([
        { id: messageID, type: "user", text: "Promote once" },
      ])
    }),
  )

  it.effect("promotes steers only through the captured inbox cutoff", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const first = yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Before cutoff" }), resume: false })
      const cutoff = first.admittedSeq
      const second = yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "After cutoff" }), resume: false })

      yield* SessionInput.promoteSteers(db, events, sessionID, cutoff)

      expect(yield* admitted(first.id)).toHaveProperty("promotedSeq")
      expect(yield* admitted(second.id)).not.toHaveProperty("promotedSeq")
    }),
  )

  it.effect("reprojects pending inbox input without scheduling execution", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      wakeCalls.length = 0
      yield* session.prompt({
        id: messageID,
        sessionID,
        prompt: Prompt.make({ text: "Replay pending" }),
        resume: false,
      })
      const recorded = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .all()
        .pipe(Effect.orDie)

      yield* events.remove(sessionID)
      yield* db.delete(SessionInputTable).where(eq(SessionInputTable.session_id, sessionID)).run().pipe(Effect.orDie)
      yield* db
        .delete(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .run()
        .pipe(Effect.orDie)
      yield* events.replayAll(
        recorded.map((event) => ({
          id: event.id,
          aggregateID: event.aggregate_id,
          seq: event.seq,
          type: event.type,
          data: event.data,
        })),
      )

      expect(yield* admitted(messageID)).toMatchObject({ id: messageID, prompt: { text: "Replay pending" } })
      expect(yield* session.messages({ sessionID })).toEqual([])
      expect(wakeCalls).toEqual([])
    }),
  )

  it.effect("returns an exact retry of a legacy projected prompt", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const prompt = Prompt.make({ text: "Historical prompt" })
      yield* events.publish(SessionEvent.Prompted, {
        sessionID,
        messageID,
        timestamp: yield* DateTime.now,
        prompt,
        delivery: "steer",
      })

      const retried = yield* session.prompt({ id: messageID, sessionID, prompt, resume: false })

      expect(retried).toMatchObject({ id: messageID, prompt: { text: "Historical prompt" } })
      expect(yield* admitted(messageID)).toHaveProperty("promotedSeq")
    }),
  )

  it.effect("returns an exact retry of a legacy projected queued prompt", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const prompt = Prompt.make({ text: "Historical queued prompt" })
      yield* events.publish(SessionEvent.Prompted, {
        sessionID,
        messageID,
        timestamp: yield* DateTime.now,
        prompt,
        delivery: "queue",
      })

      const retried = yield* session.prompt({ id: messageID, sessionID, prompt, delivery: "queue", resume: false })

      expect(retried).toMatchObject({ id: messageID, prompt: { text: "Historical queued prompt" } })
      expect(yield* admitted(messageID)).toMatchObject({ delivery: "queue" })
    }),
  )

  it.effect("rejects reuse of one globally unique message ID across sessions", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const session = yield* SessionV2.Service
      const other = SessionV2.ID.make("ses_prompt_other")
      yield* db
        .insert(SessionTable)
        .values({
          id: other,
          project_id: Project.ID.global,
          slug: "other",
          directory: "/project",
          title: "other",
          version: "test",
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      const prompt = Prompt.make({ text: "Fix the failing tests" })

      yield* session.prompt({ id: messageID, sessionID, prompt, resume: false })
      const failure = yield* session
        .prompt({ id: messageID, sessionID: other, prompt, resume: false })
        .pipe(Effect.flip)

      expect(failure).toMatchObject({ _tag: "Session.PromptConflictError", sessionID: other, messageID })
    }),
  )

  it.effect("rejects a prompt ID already used by visible Session history", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* events.publish(SessionEvent.Synthetic, {
        sessionID,
        messageID,
        timestamp: yield* DateTime.now,
        text: "Existing history",
      })

      const failure = yield* session
        .prompt({ id: messageID, sessionID, prompt: Prompt.make({ text: "Conflicting prompt" }), resume: false })
        .pipe(Effect.flip)

      expect(failure).toMatchObject({ _tag: "Session.PromptConflictError", sessionID, messageID })
      expect(yield* admitted(messageID)).toBeUndefined()
    }),
  )

  it.effect("starts execution by default after recording the prompt", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      executionCalls.length = 0
      wakeCalls.length = 0

      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Run by default" }) })

      expect(executionCalls).toEqual([])
      expect(wakeCalls).toEqual([sessionID])
    }),
  )

  it.effect("starts execution when resume is explicitly true", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      executionCalls.length = 0
      wakeCalls.length = 0

      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Run explicitly" }),
        resume: true,
      })

      expect(executionCalls).toEqual([])
      expect(wakeCalls).toEqual([sessionID])
    }),
  )

  it.effect("only records the prompt when resume is false", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      executionCalls.length = 0
      wakeCalls.length = 0

      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Do not run" }), resume: false })

      expect(executionCalls).toEqual([])
      expect(wakeCalls).toEqual([])
    }),
  )

  it.effect("records a collaboration prompt and notices without scheduling execution", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      executionCalls.length = 0
      wakeCalls.length = 0

      const messageID = yield* session.recordPrompt({
        sessionID,
        prompt: Prompt.make({ text: "Collaborate on the failing tests" }),
      })
      expect(yield* admitted(messageID)).toMatchObject({
        id: messageID,
        sessionID,
        prompt: { text: "Collaborate on the failing tests" },
        delivery: "queue",
      })
      expect(yield* admitted(messageID)).toHaveProperty("promotedSeq")

      yield* session.notice({
        sessionID,
        text: "Planner started.",
        agent: "build",
        model: { providerID: ProviderV2.ID.make("provider"), id: ModelV2.ID.make("model") },
      })

      expect(yield* session.messages({ sessionID, order: "asc" })).toMatchObject([
        { id: messageID, type: "user", text: "Collaborate on the failing tests" },
        { type: "assistant", content: [{ type: "text", text: "Planner started." }] },
      ])
      expect(executionCalls).toEqual([])
      expect(wakeCalls).toEqual([])
    }),
  )
})
