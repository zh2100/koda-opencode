import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import path from "node:path"
import { sql } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Database } from "../src/database/database"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { Location } from "../src/location"
import { PermissionV2 } from "../src/permission"
import { Project } from "../src/project"
import { ProjectTable } from "../src/project/sql"
import { AbsolutePath } from "../src/schema"
import { SessionV2 } from "../src/session"
import { ImageAttemptTable, SessionTable } from "../src/session/sql"
import { ExportPresentationTool } from "../src/tool/export-presentation"
import { ToolRegistry } from "../src/tool/registry"
import { ToolOutputStore } from "../src/tool-output-store"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { executeTool, toolIdentity } from "./lib/tool"

test("only exports the authorized local path and matching receipt; re-export requires a new file", async () => {
  await using tmp = await tmpdir()
  const directory = AbsolutePath.make(tmp.path)
  const svc = AppNodeBuilder.build(LayerNode.group([ExportPresentationTool.node, Database.node, ToolRegistry.node]), [
    [Database.node, Database.layerFromPath(path.join(tmp.path, "test.sqlite"))],
    [Location.node, Layer.succeed(Location.Service, location({ directory }))],
    [
      PermissionV2.node,
      Layer.mock(PermissionV2.Service, {
        assert: (i) =>
          i.action === "edit" && !i.resources.includes("denied.pptx")
            ? Effect.void
            : Effect.fail(new PermissionV2.BlockedError({ rules: [] })),
      }),
    ],
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
  ])
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service,
        reg = yield* ToolRegistry.Service
      const sessionID = SessionV2.ID.make("ses_test_export"),
        other = SessionV2.ID.make("ses_other_export"),
        task = "msg_illustration",
        id = `illustration-${task}-cover`
      const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
        digest = createHash("sha256").update(Buffer.from(png, "base64")).digest("hex")
      yield* database.db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: directory, sandboxes: [] })
        .onConflictDoNothing()
        .run()
      yield* database.db
        .insert(SessionTable)
        .values(
          [sessionID, other].map((id) => ({
            id,
            project_id: Project.ID.global,
            directory,
            slug: "test",
            title: "test",
            version: "test",
          })),
        )
        .run()
      yield* database.db
        .insert(ImageAttemptTable)
        .values({ session_id: sessionID, task_id: task, slot: "cover", call_id: id, model: "test", digest })
        .run()
      const call = (file: string, session = sessionID, key = task) =>
        executeTool(reg, {
          ...toolIdentity,
          sessionID: session,
          call: {
            id: "call-export",
            type: "tool-call",
            name: "export_presentation",
            input: {
              path: file,
              task: key,
              slides: [
                { title: "Title", body: "Text" },
                { title: "Image", body: "Caption", slot: "cover" },
              ],
            },
          },
        })
      const part = {
        type: "tool",
        id,
        name: "image_generation",
        provider: { executed: false },
        state: {
          status: "completed",
          input: { prompt: "test" },
          content: [{ type: "file", uri: `data:image/png;base64,${png}`, mime: "image/png", name: "cover.png" }],
          outputPaths: [],
          structured: {},
        },
        time: { created: 1, ran: 1, completed: 2 },
      }
      const message = {
        time: { created: 1, completed: 2 },
        agent: "build",
        model: { id: "test", providerID: "test" },
        content: [part],
        finish: "stop",
        cost: 0,
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      }
      const data = JSON.stringify(message)
      expect((yield* call("missing.pptx")).type).toBe("error")
      yield* database.db.run(
        sql`insert into session_message(id,session_id,type,seq,data,time_created,time_updated) values ('msg_picture',${sessionID},'assistant',1,${data},1,2)`,
      )
      expect((yield* call("wrong-task.pptx", sessionID, "msg_other")).type).toBe("error")
      expect((yield* call("other.pptx", other)).type).toBe("error")
      expect((yield* call("denied.pptx")).type).toBe("error")
      expect((yield* call("../outside.pptx")).type).toBe("error")
      const success = yield* call("first.pptx")
      expect(success).toMatchObject({ type: "text" })
      expect(success.value).toContain(digest)
      expect((yield* call("first.pptx")).type).toBe("error")
      expect((yield* call("revision.pptx")).type).toBe("text")
      for (const [file, changed] of [
        ["same-name.pptx", data.replace(png, "AQID")],
        ["wrong-call.pptx", data.replace(id, "another-id")],
      ]) {
        yield* database.db.run(sql`update session_message set data=${changed} where id='msg_picture'`)
        expect((yield* call(file)).type).toBe("error")
      }
      for (const file of [
        "same-name.pptx",
        "wrong-call.pptx",
        "denied.pptx",
        "wrong-task.pptx",
        "other.pptx",
        "missing.pptx",
      ])
        expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, file)).exists())).toBe(false)
    }).pipe(Effect.provide(svc), Effect.scoped),
  )
})
