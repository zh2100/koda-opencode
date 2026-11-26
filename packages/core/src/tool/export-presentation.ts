export * as ExportPresentationTool from "./export-presentation"

import { createHash } from "node:crypto"
import { and, eq } from "drizzle-orm"
import { Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { makeLocationNode } from "../effect/app-node"
import { FileMutation } from "../file-mutation"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { SessionStore } from "../session/store"
import { ImageAttemptTable } from "../session/sql"
import type { Asset } from "../presentation/pptx"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

const Input = Schema.Struct({
  path: Schema.String.check(Schema.isPattern(/\.pptx$/i)),
  task: Schema.String.check(Schema.isPattern(/^msg_[A-Za-z0-9_-]{1,100}$/)),
  slides: Schema.Array(
    Schema.Struct({
      title: Schema.String.check(Schema.isMaxLength(160)),
      body: Schema.String.check(Schema.isMaxLength(4000)),
      slot: Schema.optional(Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9_/-]{0,63}$/))),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
})
const Output = Schema.Struct({
  file: Schema.String,
  embedded: Schema.Array(
    Schema.Struct({ slide: Schema.Number, slot: Schema.String, media: Schema.String, digest: Schema.String }),
  ),
})
export const name = "export_presentation"
export const node = makeLocationNode({
  name: "tool/export-presentation",
  deps: [
    ToolRegistry.node,
    Database.node,
    SessionStore.node,
    FileMutation.node,
    FSUtil.node,
    LocationMutation.node,
    PermissionV2.node,
  ],
  layer: Layer.effectDiscard(
    Effect.gen(function* () {
      const tools = yield* Tools.Service,
        database = yield* Database.Service,
        store = yield* SessionStore.Service,
        files = yield* FileMutation.Service,
        fs = yield* FSUtil.Service,
        mutation = yield* LocationMutation.Service,
        permission = yield* PermissionV2.Service
      yield* tools
        .register({
          [name]: Tool.withPermission(
            Tool.make({
              description:
                "Create a NEW .pptx in the active project from the current session's verified Illustration task ID. Put the original placement key in the target slide's slot; omit slot for text-only slides. No generation or upload. Use only for requested presentations; report embedding only on verified success.",
              input: Input,
              output: Output,
              toModelOutput: ({ output }) => [{ type: "text", text: JSON.stringify(output) }],
              execute: (input, context) =>
                Effect.gen(function* () {
                  const target = yield* mutation.resolve({ path: input.path, kind: "file" })
                  if (target.externalDirectory || !target.canonical.toLowerCase().endsWith(".pptx"))
                    return yield* new Tool.Failure({ message: "Choose a new .pptx file inside the project." })
                  yield* permission.assert({
                    action: "edit",
                    resources: [target.resource],
                    save: [target.resource],
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                  })
                  const slots = new Set(input.slides.flatMap((s) => (s.slot ? [s.slot] : [])))
                  if (!slots.size) return yield* new Tool.Failure({ message: "No illustration placement supplied." })
                  const attempts = yield* database.db
                    .select()
                    .from(ImageAttemptTable)
                    .where(
                      and(
                        eq(ImageAttemptTable.session_id, context.sessionID),
                        eq(ImageAttemptTable.task_id, input.task),
                      ),
                    )
                    .all()
                  const history = yield* store.context(context.sessionID)
                  const assets = new Map<string, Asset>()
                  let total = 0
                  for (const slot of slots) {
                    const row = attempts.find(
                      (r) => r.slot === slot && r.call_id === `illustration-${input.task}-${slot}`,
                    )
                    if (!row?.digest)
                      return yield* new Tool.Failure({
                        message: `No verified receipt for ${slot}. No image request sent.`,
                      })
                    const matches = history.flatMap((m) =>
                      m.type === "assistant"
                        ? m.content.flatMap((v) =>
                            v.type === "tool" &&
                            v.id === row.call_id &&
                            v.name === "image_generation" &&
                            v.state.status === "completed"
                              ? v.state.content.filter((f) => f.type === "file")
                              : [],
                          )
                        : [],
                    )
                    const file = matches[0]
                    if (
                      matches.length !== 1 ||
                      !file ||
                      !["image/png", "image/jpeg"].includes(file.mime) ||
                      !file.uri.startsWith(`data:${file.mime};base64,`)
                    )
                      return yield* new Tool.Failure({ message: "Expected a verified PNG or JPEG attachment." })
                    const bytes = Buffer.from(file.uri.slice(file.uri.indexOf(",") + 1), "base64")
                    total += bytes.length * input.slides.filter((s) => s.slot === slot).length
                    if (total > 32 * 1024 * 1024 || createHash("sha256").update(bytes).digest("hex") !== row.digest)
                      return yield* new Tool.Failure({
                        message: "Asset digest mismatch or presentation media budget exceeded.",
                      })
                    assets.set(slot, { uri: file.uri, digest: row.digest })
                  }
                  const pptx = yield* Effect.tryPromise(() => import("../presentation/pptx"))
                  const bytes = yield* Effect.tryPromise(() => pptx.build(input.slides, assets))
                  const current = yield* mutation.resolve({ path: input.path, kind: "file" })
                  if (current.canonical !== target.canonical || current.externalDirectory)
                    return yield* new Tool.Failure({ message: "Output location changed after permission approval." })
                  yield* files.create({ target, content: bytes })
                  // Only parse our own package, not unrelated content substituted after the write.
                  const read = yield* fs.readFile(target.canonical)
                  if (!Buffer.from(bytes).equals(read))
                    return yield* new Tool.Failure({ message: "Presentation changed before verification." })
                  const embedded = yield* Effect.tryPromise(() => pptx.verify(read, input.slides, assets))
                  return { file: target.resource, embedded }
                }).pipe(
                  Effect.mapError((e) =>
                    e instanceof Tool.Failure
                      ? e
                      : new Tool.Failure({
                          message:
                            "Presentation export not verified. Check the output path; existing files are not replaced. Reuse the receipt, do not generate another image.",
                        }),
                  ),
                ),
            }),
            "edit",
          ),
        })
        .pipe(Effect.orDie)
    }),
  ),
})
