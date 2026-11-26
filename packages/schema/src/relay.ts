export * as Relay from "./relay"

import { Schema } from "effect"
import { DateTimeUtcFromMillis, NonNegativeInt, optional, statics } from "./schema"

export const VendorID = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-_]*$/)).pipe(
  Schema.brand("Relay.VendorID"),
  statics((schema) => ({
    chatgpt: schema.make("chatgpt"),
    claude: schema.make("claude"),
    gemini: schema.make("gemini"),
    grok: schema.make("grok"),
    kimi: schema.make("kimi"),
  })),
)
export type VendorID = typeof VendorID.Type

export const VendorBaseURL = Schema.String.check(
  Schema.isPattern(/^https?:\/\/(?:\[[0-9a-fA-F:]+\]|[^\s\/?#@:\\]+)(?::[0-9]{1,5})?(?:\/[^\s?#\\]*)?$/i),
).annotate({ identifier: "Relay.VendorBaseURL" })

export interface Vendor extends Schema.Schema.Type<typeof Vendor> {}
export const Vendor = Schema.Struct({
  id: VendorID,
  entityId: optional(Schema.String),
  name: Schema.String,
  baseURL: optional(VendorBaseURL),
  builtin: Schema.Boolean,
  hasKey: Schema.Boolean,
  updatedAt: DateTimeUtcFromMillis,
  revision: NonNegativeInt,
}).annotate({ identifier: "Relay.Vendor" })

export interface OperationReceipt extends Schema.Schema.Type<typeof OperationReceipt> {}
export const OperationReceipt = Schema.Struct({
  operationId: Schema.String,
  kind: Schema.Literal("vendor-create"),
  vendorId: VendorID,
  entityId: Schema.String,
  committedRevision: NonNegativeInt,
}).annotate({ identifier: "Relay.OperationReceipt" })

export interface CatalogSync extends Schema.Schema.Type<typeof CatalogSync> {}
export const CatalogSync = Schema.Struct({
  status: Schema.Literals(["synced", "pending"]),
  retryable: Schema.Boolean,
}).annotate({ identifier: "Relay.CatalogSync" })

export interface AuthState extends Schema.Schema.Type<typeof AuthState> {}
export const AuthState = Schema.Struct({
  vendors: Schema.Array(Vendor),
  revision: NonNegativeInt,
  capabilities: optional(Schema.Array(Schema.String)),
  operationReceipt: optional(OperationReceipt),
  catalogSync: optional(CatalogSync),
}).annotate({ identifier: "Relay.AuthState" })

export const ProviderID = Schema.Literal("leidiandonghua").pipe(Schema.brand("Relay.ProviderID"))
export type ProviderID = typeof ProviderID.Type

export const Effort = Schema.Literals(["none", "low", "medium", "high", "xhigh", "max", "ultra"]).annotate({ identifier: "Relay.Effort" })
export type Effort = typeof Effort.Type
