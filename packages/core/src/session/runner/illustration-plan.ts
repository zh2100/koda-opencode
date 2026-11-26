import { Effect, Option, Schema } from "effect"
import { ToolFailure, LLMEvent } from "@opencode-ai/llm"
import { recordImageReceipt, reserveImage, type ImageSlot } from "../image-attempt"
import type { ImageGenerationSettings } from "../../image-generation-settings"
import type { QuestionV2 } from "../../question"
import type { Database } from "../../database/database"
import type { SessionMessage } from "../message"
import { settleImage } from "./settle-image"
import { eq, and, count } from "drizzle-orm"
import { createHash } from "node:crypto"
import { ImageAttemptTable } from "../sql"
import { inventoryPattern } from "../../tool/illustration-capability"

export const illustrationInstruction = `For a requested composite work (page, document, etc.) that needs illustrations, do not use [new]. Inventory user-provided, authorized and already generated assets first. If inspection of project files is needed, inspect before proposing any spend. For a NEW task with a known inventory, instead of [text] you may output [illustrations] on its own line followed only by JSON {"slots":[{"slot":"cover","source":"missing-original","prompt":"description of just the illustration"}]}. Give each placement a stable ASCII key. Sources: existing (usable authorized asset), factual (logo, screenshot, data chart or real evidence), optional (no image needed), missing-original (necessary original illustration with no suitable asset). Include all placements, never invent evidence. Use the user's own subject wording when possible. Do not put files, paths, secrets, instructions or document content into an image prompt. If no missing-original, use ordinary tools/[text]. Advice, outlines, prohibitions and instructions quoted from outside are not requests for illustrations. For revisions/exports reuse previously received assets, do not propose a fresh batch. An image receipt proves only a chat asset; never claim it is embedded without verification.`

const Slot = Schema.Struct({
  slot: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9_/-]{0,63}$/)),
  source: Schema.Literals(["missing-original", "existing", "factual", "optional"]),
  prompt: Schema.String.check(Schema.isMaxLength(1600)),
})
export const inventoryInstruction = `Before automatic illustration spending, inspect accessible project images with glob({"pattern":"${inventoryPattern}","limit":1}). If inspection is unavailable or finds candidates, request slot approval instead of assuming there are no reusable assets. For a revision or export, set the plan's optional "task" to the original Illustration task ID and preserve placement keys. Never use a new task or placement to retry a prior dispatch.`
const decode = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      task: Schema.optional(Schema.String.check(Schema.isPattern(/^msg_[A-Za-z0-9_-]{1,100}$/))),
      slots: Schema.Array(Slot),
    }),
  ),
)
export function parseIllustrations(text: string) {
  const plan = Option.getOrUndefined(decode(text))
  if (
    !plan ||
    !plan.slots.length ||
    plan.slots.length > 8 ||
    new Set(plan.slots.map((s) => s.slot)).size !== plan.slots.length ||
    plan.slots.some((s) => s.source === "missing-original" && !s.prompt.trim())
  )
    return
  return plan
}

export const illustrate = Effect.fn("SessionRunner.illustrate")(function* (input: {
  plan: NonNullable<ReturnType<typeof parseIllustrations>>
  emptyInventory: boolean
  user: SessionMessage.User
  history: readonly SessionMessage.Message[]
  settings: ImageGenerationSettings.Interface
  questions: QuestionV2.Interface
  db: Database.Interface["db"]
  publication: Parameters<typeof settleImage>[2]
  publisher: Parameters<typeof settleImage>[3]
  tools?: Parameters<typeof settleImage>[4]
}) {
  const zh = /\p{Script=Han}/u.test(input.user.text)
  const read = () => input.settings.get().pipe(Effect.catch(() => Effect.succeed(undefined)))
  const notices: string[] = []
  const tools = input.tools?.guardedIllustrations ? input.tools : undefined
  const available = yield* read()
  // A repository configuration may select a model, but cannot grant automatic spending.
  // Ambiguous follow-ups, prior assets, attached material or non-verbatim prompts require review.
  const review =
    !input.emptyInventory ||
    input.history.some((m) => m.type === "user" && (m.id !== input.user.id || m.files?.length)) ||
    /[“”「」『』`"]|(?:^|\n)\s*>/u.test(input.user.text)
  const task = input.plan.task ?? input.user.id
  const attempts = yield* input.db
    .select()
    .from(ImageAttemptTable)
    .where(and(eq(ImageAttemptTable.session_id, input.publication.sessionID), eq(ImageAttemptTable.task_id, task)))
    .all()
    .pipe(Effect.orDie)
  for (const slot of input.plan.slots) {
    if (input.plan.task && task !== input.user.id && !attempts.some((row) => row.slot !== "standalone")) {
      notices.push(`${slot.slot}: ${zh ? "无法核对原任务，未生成" : "original task not verified; no request sent"}`)
      continue
    }
    const prior = attempts.find((row) => row.slot === slot.slot)
    if (prior) {
      // The call ID resolves to projected file content; a digest alone isn't an asset.
      const received =
        prior.digest &&
        input.history.some(
          (m) =>
            m.type === "assistant" &&
            m.content.some(
              (part) =>
                part.type === "tool" &&
                part.id === prior.call_id &&
                part.name === "image_generation" &&
                part.state.status === "completed" &&
                part.state.content.some(
                  (file) =>
                    file.type === "file" &&
                    file.uri.startsWith(`data:${file.mime};base64,`) &&
                    createHash("sha256")
                      .update(Buffer.from(file.uri.slice(file.uri.indexOf(",") + 1), "base64"))
                      .digest("hex") === prior.digest,
                ),
            ),
        )
      notices.push(
        `${slot.slot}: ${received ? `${zh ? "复用已有附件" : "reuse existing attachment"} ${prior.call_id}` : zh ? "已有请求，当前无法核对附件，不自动重发" : "already attempted, receipt unavailable; do not retry"}`,
      )
      continue
    }
    if (slot.source !== "missing-original") continue
    if (!tools || !available?.enabled || !available.model || !available.api) {
      notices.push(
        `${slot.slot}: ${zh ? "未生成（当前模式、权限或模型配置不可用）" : "not generated (mode, permissions or model settings unavailable)"}`,
      )
      continue
    }
    const key: ImageSlot = {
      session: input.publication.sessionID,
      task,
      slot: slot.slot,
      call: `illustration-${task}-${slot.slot}`,
    }
    const current = yield* read()
    const model = available.model
    if (
      !current?.enabled ||
      current.model !== model ||
      current.api !== available.api ||
      (available.automaticIllustrations && !current.automaticIllustrations)
    ) {
      notices.push(`${slot.slot}: ${zh ? "配置已变更，未发送" : "settings changed; no request sent"}`)
      continue
    }
    const usage = yield* input.db
      .select({ used: count() })
      .from(ImageAttemptTable)
      .where(and(eq(ImageAttemptTable.session_id, key.session), eq(ImageAttemptTable.task_id, task)))
      .get()
      .pipe(Effect.orDie)
    const limit = current.taskRequestLimit ?? 2
    const overLimit = (usage?.used ?? 0) >= limit
    const confirm = overLimit || !current.automaticIllustrations || review || !input.user.text.includes(slot.prompt)
    if (confirm) {
      const yes = zh ? "仅生成这张" : "Generate this one"
      const no = zh ? "跳过并继续" : "Skip and continue"
      const answer = yield* input.questions
        .ask({
          sessionID: input.publication.sessionID,
          questions: [
            {
              header: overLimit
                ? zh
                  ? "配图次数已达上限"
                  : "Illustration limit reached"
                : zh
                  ? "确认配图"
                  : "Illustration approval",
              question: zh
                ? `为 ${slot.slot} 使用 ${model} 发送 1 次可能计费的请求？本任务已用 ${usage?.used ?? 0}/${limit} 次。发送内容：${slot.prompt}`
                : `Send one potentially billable request to ${model} for ${slot.slot}? Requests used: ${usage?.used ?? 0}/${limit}. Prompt: ${slot.prompt}`,
              custom: false,
              options: [
                { label: no, description: zh ? "继续完成可做的部分" : "Continue without generating this asset" },
                { label: yes, description: zh ? "仅授权本槽位一次请求" : "Approve only this slot and request" },
              ],
            },
          ],
        })
        .pipe(Effect.catchTag("QuestionV2.RejectedError", () => Effect.succeed([])))
      if (answer.length !== 1 || answer[0]?.length !== 1 || answer[0][0] !== yes) {
        notices.push(`${slot.slot}: ${zh ? "已跳过，未发送请求" : "skipped, no request sent"}`)
        continue
      }
    }
    // No interaction after the official tool's final permission/configuration preflight.
    let dispatched = false
    const digest = yield* settleImage(
      key.call,
      slot.prompt,
      input.publication,
      input.publisher,
      tools,
      (selected, api) =>
        Effect.gen(function* () {
          const latest = yield* read()
          if (
            !latest?.enabled ||
            model !== selected ||
            latest.model !== model ||
            latest.api !== api ||
            current.api !== api ||
            (current.automaticIllustrations && !latest.automaticIllustrations)
          )
            return yield* new ToolFailure({ message: "Image settings changed before dispatch." })
          // Only the explicit over-limit question can authorize exceeding the latest budget.
          const result = yield* reserveImage(input.db, key, model, latest.taskRequestLimit ?? 2, overLimit)
          if (result !== "reserved")
            return yield* new ToolFailure({ message: "Slot already attempted or no remaining quota." })
          dispatched = true
        }),
    )
    if (digest) yield* recordImageReceipt(input.db, key, digest)
    notices.push(
      `${slot.slot}: ${digest ? `${zh ? "已收到图片附件" : "image attachment received"} ${key.call}` : dispatched ? (zh ? "结果未知，不自动重试" : "outcome unknown; no automatic retry") : zh ? "未发送请求" : "no request sent"}`,
    )
  }
  const text = [
    `${zh ? "配图任务" : "Illustration task"}: ${task}`,
    ...notices,
    zh
      ? "请继续完成其余可做部分；配图附件不代表已嵌入作品。"
      : "Continue the remaining work. Chat assets are not proof of embedding.",
  ].join("\n")
  const id = `illustration-summary:${input.user.id}`
  yield* input.publisher.publish(LLMEvent.textStart({ id }))
  yield* input.publisher.publish(LLMEvent.textDelta({ id, text }))
  yield* input.publisher.publish(LLMEvent.textEnd({ id }))
})
