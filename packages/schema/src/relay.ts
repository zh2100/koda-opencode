export * as Relay from "./relay"

import { Schema } from "effect"
import { DateTimeUtcFromMillis, NonNegativeInt, statics } from "./schema"

export const VendorID = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-_]*$/)).pipe(
  Schema.brand("Relay.VendorID"),
  statics((schema) => ({
    chatgpt: schema.make("chatgpt"),
    grok: schema.make("grok"),
  })),
)
export type VendorID = typeof VendorID.Type

export interface Vendor extends Schema.Schema.Type<typeof Vendor> {}
export const Vendor = Schema.Struct({
  id: VendorID,
  name: Schema.String,
  builtin: Schema.Boolean,
  hasKey: Schema.Boolean,
  updatedAt: DateTimeUtcFromMillis,
  revision: NonNegativeInt,
}).annotate({ identifier: "Relay.Vendor" })

export interface AuthState extends Schema.Schema.Type<typeof AuthState> {}
export const AuthState = Schema.Struct({
  unified: Schema.Boolean,
  hasUnifiedKey: Schema.Boolean,
  vendors: Schema.Array(Vendor),
  revision: NonNegativeInt,
  canRollback: Schema.Boolean,
}).annotate({ identifier: "Relay.AuthState" })

export const ProviderID = Schema.Literal("leidiandonghua").pipe(Schema.brand("Relay.ProviderID"))
export type ProviderID = typeof ProviderID.Type

export const BaseURL = Schema.Literal("https://api.leidiandonghua.cn/v1")
export type BaseURL = typeof BaseURL.Type

export const Effort = Schema.Literals(["low", "medium", "high", "xhigh"]).annotate({ identifier: "Relay.Effort" })
export type Effort = typeof Effort.Type
