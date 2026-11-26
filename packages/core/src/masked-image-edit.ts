export * as MaskedImageEdit from "./masked-image-edit"

import { createHash, createHmac, randomBytes } from "node:crypto"
import { eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Headers, HttpClient } from "effect/unstable/http"
import type { ImageEdit as Contract } from "@opencode-ai/schema/image-edit"
import { Catalog } from "./catalog"
import { Config } from "./config"
import { Database } from "./database/database"
import { makeLocationNode } from "./effect/app-node"
import { httpClient } from "./effect/app-node-platform"
import { ImageEdit } from "./image-edit"
import { ImageGenerationSettings } from "./image-generation-settings"
import { imageGenerationSelection, resolveImageTarget } from "./image-target"
import { Integration } from "./integration"
import { Location } from "./location"
import { ModelV2 } from "./model"
import { RelayAuth } from "./relay-auth"
import { RelayCatalog } from "./relay-catalog"
import { MaskedImageEditTable } from "./session/sql"
import { SessionStore } from "./session/store"

export class Rejected extends Schema.TaggedErrorClass<Rejected>()("MaskedImageEdit.Rejected", {
  reason: Schema.Literals(["scope", "source", "target", "prompt", "conflict", "unknown"]),
}) {}

export interface Interface {
  readonly target: () => Effect.Effect<Contract.Target | null>
  readonly status: () => Effect.Effect<Contract.Status>
  readonly edit: (input: Contract.Request) => Effect.Effect<Contract.Result, Rejected | ImageEdit.InvalidImage | ImageEdit.ProviderFailure>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/MaskedImageEdit") {}

const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
// Use a keyed binding so a confirmation neither exposes credentials nor remains valid after restart.
const confirmationKey = randomBytes(32)

// OpenAI's Image API explicitly lists these wire IDs for masked edits. This is
// documentation, not a capability claim about compatible endpoints or relays.
const documentedOpenAIMasks = new Set<string>([
  "gpt-image-1.5",
  "gpt-image-1.5-2025-12-16",
  "gpt-image-1-mini",
  "chatgpt-image-latest",
  "gpt-image-2",
  "gpt-image-2-2026-04-21",
  "gpt-image-2.5-flare",
  "gpt-image-2.5-flare-2026-09-08",
  "gpt-image-2.5-sunburst",
  "gpt-image-2.5-sunburst-2026-09-08",
  "gpt-image-2.6-flare",
  "gpt-image-2.6-sunburst",
])

function findModel(selection: string, models: readonly ModelV2.Info[]) {
  const ref = ModelV2.parse(selection)
  return models.find((item) => item.providerID === ref.providerID && item.id === ref.modelID)
}

const layer = Layer.effect(Service, Effect.gen(function* () {
  const database = yield* Database.Service
  const store = yield* SessionStore.Service
  const config = yield* Config.Service
  const settings = yield* ImageGenerationSettings.Service
  const catalog = yield* Catalog.Service
  const integrations = yield* Integration.Service
  const relay = yield* RelayAuth.Service
  const relayCatalog = yield* RelayCatalog.Service
  const location = yield* Location.Service
  const http = yield* HttpClient.HttpClient

  const resolve = Effect.fn("MaskedImageEdit.target")(function* (
    selected: Contract.Config | undefined,
    models?: readonly ModelV2.Info[],
    source = "explicit",
  ) {
    if (selected?.protocol !== "openai-mask") return yield* new Rejected({ reason: "target" })
    const model = findModel(selected.model, models ?? (yield* catalog.model.available()))
    if (!model) return yield* new Rejected({ reason: "target" })
    const target = yield* resolveImageTarget(model, "openai-images", catalog, integrations, relay, relayCatalog)
      .pipe(Effect.mapError(() => new Rejected({ reason: "target" })))
    const url = yield* ImageEdit.endpoint(target.baseURL).pipe(Effect.mapError(() => new Rejected({ reason: "target" })))
    const binding = createHmac("sha256", confirmationKey).update(JSON.stringify([
      location.directory, location.workspaceID, source, selected.model, selected.protocol, target.model, url,
      Object.entries(Headers.fromInput(target.headers)).sort(([left], [right]) => left.localeCompare(right)),
    ])).digest("hex")
    return {
      visible: { ...selected, endpoint: url, binding },
      request: { url, model: target.model, headers: target.headers, protocol: selected.protocol },
    }
  })

  const inspect = Effect.fn("MaskedImageEdit.inspect")(function* (
    entries: readonly Config.Entry[],
    models: readonly ModelV2.Info[],
  ) {
    const selected = yield* imageGenerationSelection(entries, settings)
    const result = (state: Contract.Status["generation"]["state"]): {
      generation: Contract.Status["generation"]
      target?: Effect.Success<ReturnType<typeof resolve>>
    } => ({
      generation: { ...(selected.model ? { model: selected.model } : {}), state },
    })
    if (!selected.model) {
      const legacy = Config.latest(entries, "image_edit")
      const target = yield* resolve(legacy, models).pipe(Effect.orElseSucceed(() => undefined))
      return { ...result("unconfigured"), target, legacy }
    }
    if (!selected.enabled) return result("disabled")
    const model = findModel(selected.model, models)
    if (!model || !selected.api) return result("unavailable")
    // Only the multipart Images API is implemented here. Image output or a chat
    // model name alone does not establish support for our binary alpha mask.
    if (selected.api !== "openai-images") return result("unsupported")
    const target = yield* resolveImageTarget(model, selected.api, catalog, integrations, relay, relayCatalog)
      .pipe(Effect.orElseSucceed(() => undefined))
    if (!target) return result("unavailable")
    const endpoint = yield* ImageEdit.endpoint(target.baseURL).pipe(Effect.orElseSucceed(() => undefined))
    if (!endpoint) return result("unavailable")
    if (!documentedOpenAIMasks.has(target.model))
      return result(/^(?:dall-e-[23]|gpt-image-1)$/.test(target.model) ? "unsupported" : "unknown")
    const documented = model.providerID === "openai" && endpoint === "https://api.openai.com/v1/images/edits" &&
      documentedOpenAIMasks.has(target.model)
    const editor = yield* resolve({ model: selected.model, protocol: "openai-mask" }, models, "generation:openai-images")
      .pipe(Effect.orElseSucceed(() => undefined))
    if (!editor) return result("unavailable")
    return { generation: { model: selected.model, state: documented ? "documented" as const : "compatible" as const }, target: editor }
  })

  const current = Effect.fn("MaskedImageEdit.current")(function* () {
    return yield* inspect(yield* config.entries(), yield* catalog.model.available()).pipe(
      Effect.orElseSucceed(() => ({ generation: { state: "failed" as const }, target: undefined })),
    )
  })

  const status = Effect.fn("MaskedImageEdit.status")(function* (): Effect.fn.Return<Contract.Status> {
    const value = yield* current()
    return {
      generation: value.generation,
      editor: value.target
        ? { state: "configured", target: value.target.visible, source: value.generation.state === "unconfigured" ? "explicit" : "generation" }
        : "legacy" in value && value.legacy
          ? { state: "unavailable", model: value.legacy.model }
          : { state: "unconfigured" },
    }
  })

  const checkScope = Effect.fnUntraced(function* (scope: Contract.Scope) {
    if (scope.type === "draft") return undefined
    const session = yield* store.get(scope.id)
    if (!session || session.location.directory !== location.directory || session.location.workspaceID !== location.workspaceID ||
      session.approvalMode === "plan" || session.revert)
      return yield* new Rejected({ reason: "scope" })
    return session.id
  })

  const read = (id: string) => database.db.select().from(MaskedImageEditTable).where(eq(MaskedImageEditTable.id, id)).get().pipe(Effect.orDie)
  const retry = (row: typeof MaskedImageEditTable.$inferSelect, scope: string, fingerprint: string) => {
    if (row.scope !== scope || row.fingerprint !== fingerprint) return Effect.fail(new Rejected({ reason: "conflict" }))
    if (!row.result) return Effect.fail(new Rejected({ reason: "unknown" }))
    return Effect.succeed({ id: row.id, ...row.result })
  }

  const edit = Effect.fn("MaskedImageEdit.edit")(function* (input: Contract.Request) {
    const sessionID = yield* checkScope(input.scope)
    const scope = JSON.stringify([location.directory, location.workspaceID, input.scope.type, input.scope.id])
    const source = input.source
    const fingerprint = digest(JSON.stringify([
      source.type,
      source.type === "upload" ? digest(source.image) : source.type === "generated" ? [source.messageID, source.callID, source.digest] : source.id,
      digest(input.mask), input.prompt, input.target.model, input.target.protocol, input.target.endpoint, input.target.binding,
    ]))
    const prior = yield* read(input.id)
    if (prior) return yield* retry(prior, scope, fingerprint)
    if (input.reconcile) return yield* new Rejected({ reason: "unknown" })
    if (!input.prompt.trim()) return yield* new Rejected({ reason: "prompt" })

    const image = yield* Effect.gen(function* () {
      if (source.type === "upload") return source.image
      if (source.type === "edit") {
        const parent = yield* read(source.id)
        if (parent?.scope === scope && parent.result?.mime === "image/png") return parent.result.data
        return yield* new Rejected({ reason: "source" })
      }
      if (!sessionID) return yield* new Rejected({ reason: "source" })
      const record = yield* store.message(source.messageID)
      if (record?.sessionID !== sessionID || record.message.type !== "assistant") return yield* new Rejected({ reason: "source" })
      const call = record.message.content.find((part) => part.type === "tool" && part.id === source.callID)
      if (call?.type !== "tool" || call.name !== "image_generation" || call.state.status !== "completed")
        return yield* new Rejected({ reason: "source" })
      const prefix = "data:image/png;base64,"
      const files = call.state.content.filter((part) => part.type === "file")
      const file = files.length === 1 ? files[0] : undefined
      if (file?.type !== "file" || file.mime !== "image/png" || !file.uri.startsWith(prefix))
        return yield* new Rejected({ reason: "source" })
      const data = file.uri.slice(prefix.length)
      if (digest(Buffer.from(data, "base64")) !== source.digest) return yield* new Rejected({ reason: "source" })
      return data
    })
    const pixels = yield* ImageEdit.validate({ image, mask: input.mask })
    const target = (yield* current()).target
    if (!target) return yield* new Rejected({ reason: "target" })
    if (target.visible.model !== input.target.model || target.visible.endpoint !== input.target.endpoint || target.visible.binding !== input.target.binding)
      return yield* new Rejected({ reason: "target" })
    yield* checkScope(input.scope)
    // The unique insert is the dispatch boundary. An interrupted or crashed dispatch leaves a reservation,
    // never a lease that would allow the same confirmation to send a second paid request.
    const claimed = yield* database.db.insert(MaskedImageEditTable).values({ id: input.id, scope, session_id: sessionID, fingerprint })
      .onConflictDoNothing().returning({ id: MaskedImageEditTable.id }).get().pipe(Effect.orDie)
    if (!claimed) {
      const other = yield* read(input.id)
      if (other) return yield* retry(other, scope, fingerprint)
      return yield* new Rejected({ reason: "unknown" })
    }
    const result = yield* ImageEdit.dispatch(target.request, { ...pixels, prompt: input.prompt }).pipe(Effect.provideService(HttpClient.HttpClient, http))
    yield* database.db.update(MaskedImageEditTable).set({ result }).where(eq(MaskedImageEditTable.id, input.id)).run()
      .pipe(Effect.orDie, Effect.uninterruptible)
    return { id: input.id, ...result }
  })

  return Service.of({
    target: () => current().pipe(Effect.map((value) => value.target?.visible ?? null)),
    status,
    edit,
  })
}))

export const node = makeLocationNode({
  service: Service, layer, deps: [Database.node, SessionStore.node, Config.node, Catalog.node, Integration.node,
    RelayAuth.node, RelayCatalog.node, Location.node, ImageGenerationSettings.node, httpClient],
})
