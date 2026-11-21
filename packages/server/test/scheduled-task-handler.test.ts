import { expect, test } from "bun:test"
import path from "node:path"
import { DateTime, Effect, Layer, Schema, Stream } from "effect"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { ScheduledTaskGroup } from "@opencode-ai/protocol/groups/scheduled-task"
import { ScheduledTask } from "../../schema/src/scheduled-task"
import { Prompt } from "../../schema/src/prompt"
import { SessionInput } from "../../schema/src/session-input"
import { SessionMessage } from "../../schema/src/session-message"
import { LLMError, RateLimitReason } from "../../llm/src/index"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { Global } from "@opencode-ai/core/global"
import { ProjectV2 } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { RelayGate } from "@opencode-ai/core/relay-gate"
import { ScheduledTaskStore } from "@opencode-ai/core/scheduled-task"
import { ScheduledTaskRunTable, ScheduledTaskTable } from "@opencode-ai/core/scheduled-task/sql"
import { SessionV2 } from "@opencode-ai/core/session"
import { ScheduledTaskHandler } from "../src/handlers/scheduled-task"
import { Authorization } from "../src/middleware/authorization"
import { LocationMiddleware } from "../src/location"
import { schemaErrorLayer } from "../src/middleware/schema-error"
import { tmpdir } from "../../core/test/fixture/tmpdir"

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

// Real handler/store/SQLite/events; only Session execution is controlled.
// The actual runner and loopback 429 are covered by scheduled-task-wire.test.ts.
test("T08/T09 public TCP agrees with SQLite/events and preserves the schedule after transient failure", async () => {
  await using tmp = await tmpdir()
  const directory = AbsolutePath.make(tmp.path)
  const marker = "SCHEDULED-HTTP-PRIVATE-DETAIL"
  const created: SessionV2.Info[] = []
  const layer = AppNodeBuilder.build(LayerNode.group([ScheduledTaskStore.node, Database.node, EventV2.node]), [
    [Database.node, Database.layerFromPath(path.join(tmp.path, "scheduled.db"))],
    [Global.node, Global.layerWith({ data: tmp.path, state: path.join(tmp.path, "state") })],
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
      recordingSession(created, () =>
        Effect.fail(
          new LLMError({
            module: "test",
            method: "resume",
            reason: new RateLimitReason({ message: marker }),
          }),
        ),
      ),
    ],
  ])
  await Effect.gen(function* () {
    const store = yield* ScheduledTaskStore.Service
    const gate = RelayGate.Service.of({ ...RelayGate.closed, scheduledTasks: true })
    const database = yield* Database.Service
    const publisher = yield* EventV2.Service
    const observed: unknown[] = []
    yield* publisher.listen((event) =>
      Effect.sync(() => {
        observed.push(event)
      }),
    )
    const app = HttpRouter.toWebHandler(
      HttpApiBuilder.layer(HttpApi.make("server").add(ScheduledTaskGroup)).pipe(
        Layer.provide(ScheduledTaskHandler),
        Layer.provide(Layer.succeed(ScheduledTaskStore.Service, store)),
        Layer.provide(Layer.succeed(RelayGate.Service, gate)),
        Layer.provide(
          Layer.succeed(
            Authorization,
            Authorization.of((effect) => effect),
          ),
        ),
        Layer.provide(
          Layer.succeed(
            LocationMiddleware,
            LocationMiddleware.of((effect) => effect as never),
          ),
        ),
        Layer.provide(schemaErrorLayer),
        Layer.provide(HttpServer.layerServices),
      ),
      { disableLogger: true },
    )
    yield* Effect.promise(async () => {
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => app.handler(request) })
      const request = (route = "", body?: object) =>
        fetch(new URL(`/api/scheduled-task${route}`, server.url), {
          method: body ? "POST" : "GET",
          ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
        })
      try {
        const response = await request("", {
          name: "Transient failure acceptance",
          projectID: ProjectV2.ID.global,
          location: { directory },
          prompt: { text: "local-only" },
          schedule: "daily",
          timezone: "UTC",
          runAt: Date.now() + 3_600_000,
          model: { providerID: "openai", id: "model" },
          approvalMode: "ask",
          enabled: true,
        })
        expect(response.status).toBe(200)
        const task = (await response.json()) as { id: string; nextRun: number }
        const failure = await request(`/${task.id}/run`, {})
        expect(failure.status).toBe(200)
        const text = await failure.text()
        expect(text).not.toContain(marker)
        const run = Schema.decodeUnknownSync(Schema.fromJsonString(ScheduledTask.Run))(text)
        expect(run.status).toBe("failed")
        expect(run.error?.code).toBe("UPSTREAM_RATE_LIMITED")
        expect(run.error?.retryable).toBe(true)
        const list = await request()
        expect(list.status).toBe(200)
        const tasks = (await list.json()) as { id: string; enabled: boolean; nextRun: number }[]
        expect(tasks.find((item) => item.id === task.id)).toMatchObject({ enabled: true, nextRun: task.nextRun })
        const runs = await request(`/${task.id}/run`)
        expect(runs.status).toBe(200)
        expect(await runs.json()).toMatchObject([
          { id: run.id, status: "failed", error: { code: "UPSTREAM_RATE_LIMITED" } },
        ])
        expect((await request(`/${task.id}/enable`, { enabled: false })).status).toBe(200)
        expect((await request(`/${task.id}/run`, {})).status).toBe(409)
        expect((await request(`/${task.id}/enable`, { enabled: true })).status).toBe(200)
        expect(created).toHaveLength(1)
      } finally {
        await server.stop(true)
        await app.dispose()
      }
    })
    const rows = yield* database.db.select().from(ScheduledTaskRunTable).all().pipe(Effect.orDie)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe("failed")
    expect(rows[0]?.error?.code).toBe("UPSTREAM_RATE_LIMITED")
    const tasks = yield* database.db.select().from(ScheduledTaskTable).all().pipe(Effect.orDie)
    expect(tasks[0]?.enabled).toBe(true)
    const events = yield* database.db.select().from(EventTable).all().pipe(Effect.orDie)
    expect(observed.some((event) => JSON.stringify(event).includes("UPSTREAM_RATE_LIMITED"))).toBe(true)
    expect(JSON.stringify({ rows, events, tasks, observed })).not.toContain(marker)
  }).pipe(Effect.scoped, Effect.provide(layer), Effect.runPromise)
}, 30000)
