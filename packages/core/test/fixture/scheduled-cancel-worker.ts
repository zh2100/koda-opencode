import { DateTime, Effect, Layer, Stream } from "effect"
import { eq } from "drizzle-orm"
import path from "path"
import { Prompt } from "@opencode-ai/schema/prompt"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { Global } from "@opencode-ai/core/global"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { RelayGate } from "@opencode-ai/core/relay-gate"
import { ScheduledTaskStore } from "@opencode-ai/core/scheduled-task"
import { ScheduledTaskTable } from "@opencode-ai/core/scheduled-task/sql"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionInput } from "@opencode-ai/schema/session-input"
import { SessionMessage } from "@opencode-ai/schema/session-message"

const [database, ready, release] = process.argv.slice(2)
if (!database || !ready || !release) throw new Error("worker arguments missing")
const directory = AbsolutePath.make(path.dirname(database))
const layer = AppNodeBuilder.build(LayerNode.group([ScheduledTaskStore.node, Database.node, EventV2.node]), [
  [Database.node, Database.layerFromPath(database)],
  [Global.node, Global.layerWith({ data: path.dirname(database) })],
  [
    ProjectV2.node,
    Layer.succeed(
      ProjectV2.Service,
      ProjectV2.Service.of({
        directories: () => Effect.die("unused"),
        resolve: (value) => Effect.succeed({ id: ProjectV2.ID.make(value), directory: value }),
        commit: () => Effect.void,
      }),
    ),
  ],
  [RelayGate.node, RelayGate.layerWith({ scheduledTasks: true })],
  [
    SessionV2.node,
    Layer.succeed(
      SessionV2.Service,
      SessionV2.Service.of({
        list: () => Effect.succeed([]),
        create: () => Effect.die("unused"),
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
        prompt: () =>
          Effect.succeed(
            SessionInput.Admitted.make({
              admittedSeq: 0,
              id: SessionMessage.ID.make("msg_worker"),
              sessionID: SessionV2.ID.descending(),
              prompt: Prompt.make({ text: "worker" }),
              delivery: "steer",
              timeCreated: DateTime.makeUnsafe(0),
            }),
          ),
        shell: () => Effect.void,
        skill: () => Effect.void,
        compact: () => Effect.void,
        wait: () => Effect.void,
        active: Effect.succeed(new Set()),
        resume: () => Effect.void,
        interrupt: () => Effect.void,
        revert: { stage: () => Effect.die("unused"), clear: () => Effect.void, commit: () => Effect.void },
      }),
    ),
  ],
])

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const tasks = yield* ScheduledTaskStore.Service
      const database = yield* Database.Service
      const now = DateTime.toUtc(yield* DateTime.now)
      const task = yield* tasks.create({
        name: "shared",
        projectID: ProjectV2.ID.make(directory),
        location: { directory },
        prompt: Prompt.make({ text: "shared" }),
        schedule: "daily",
        timezone: "UTC",
        runAt: DateTime.add(now, { hours: 2 }),
        model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.openai },
        approvalMode: "auto",
        enabled: true,
      })
      yield* database.db.run("PRAGMA wal_checkpoint(TRUNCATE)").pipe(Effect.orDie)
      yield* Effect.promise(() => Bun.write(ready, task.id))
      yield* Effect.promise(async () => {
        const deadline = Date.now() + 15_000
        while (Date.now() < deadline) {
          if ((await Bun.file(release).text()) === "go") return
          await Bun.sleep(20)
        }
        throw new Error("parent did not release")
      })
      const claimed = yield* tasks.runNow(task.id).pipe(Effect.exit)
      yield* tasks.setEnabled(task.id, false)
      yield* database.db.run("PRAGMA wal_checkpoint(TRUNCATE)").pipe(Effect.orDie)
      yield* Effect.sync(() => void claimed)
      const runs = yield* tasks.runs(task.id)
      const stored = yield* database.db
        .select({ cancel_epoch: ScheduledTaskTable.cancel_epoch })
        .from(ScheduledTaskTable)
        .where(eq(ScheduledTaskTable.id, task.id))
        .get()
        .pipe(Effect.orDie)
      process.stdout.write(
        JSON.stringify({
          epoch: stored?.cancel_epoch ?? 0,
          pending: runs.filter((run) => run.status === "pending" || run.status === "running").length,
        }),
      )
    }).pipe(Effect.provide(layer)),
  ),
)
