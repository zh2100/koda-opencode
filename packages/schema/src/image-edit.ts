export * as ImageEdit from "./image-edit"

import { Schema } from "effect"
import { SessionID } from "./session-id"
import { SessionMessage } from "./session-message"

export const MaxImageChars = 8 * 1024 * 1024
const ID = Schema.String.check(Schema.isUUID())
const Base64Image = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MaxImageChars))
const Model = Schema.String.check(Schema.isPattern(/^[^/\s]+\/\S+$/))

export const Config = Schema.Struct({ model: Model, protocol: Schema.Literal("openai-mask") })
export type Config = typeof Config.Type

export const Target = Schema.Struct({
  model: Model,
  protocol: Config.fields.protocol,
  endpoint: Schema.String,
  binding: Schema.String,
})
export type Target = typeof Target.Type

export const Status = Schema.Struct({
  generation: Schema.Struct({
    model: Schema.optional(Model),
    state: Schema.Literals(["unconfigured", "disabled", "unavailable", "unknown", "documented", "compatible", "unsupported", "failed"]),
  }),
  editor: Schema.Union([
    Schema.Struct({ state: Schema.Literal("unconfigured") }),
    Schema.Struct({ state: Schema.Literal("unavailable"), model: Model }),
    Schema.Struct({ state: Schema.Literal("configured"), target: Target, source: Schema.optional(Schema.Literals(["generation", "explicit"])) }),
  ]),
})
export type Status = typeof Status.Type

export const Scope = Schema.Union([
  Schema.Struct({ type: Schema.Literal("draft"), id: ID }),
  Schema.Struct({ type: Schema.Literal("session"), id: SessionID }),
])
export type Scope = typeof Scope.Type

export const Source = Schema.Union([
  Schema.Struct({ type: Schema.Literal("upload"), image: Base64Image }),
  Schema.Struct({
    type: Schema.Literal("generated"),
    messageID: SessionMessage.ID,
    callID: Schema.String,
    digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  }),
  Schema.Struct({ type: Schema.Literal("edit"), id: ID }),
])

export const Request = Schema.Struct({
  id: ID,
  scope: Scope,
  source: Source,
  target: Target,
  confirmed: Schema.Literal(true),
  reconcile: Schema.optional(Schema.Literal(true)),
  mask: Base64Image,
  prompt: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32000)),
})
export type Request = typeof Request.Type

export const Result = Schema.Struct({
  id: ID,
  mime: Schema.String,
  data: Schema.String,
})
export type Result = typeof Result.Type
