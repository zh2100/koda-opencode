export * as RelayError from "./relay-error"

import { Schema } from "effect"
import { optional } from "./schema"

export const Code = Schema.Literals([
  "KEY_MISSING",
  "KEY_REJECTED",
  "UPSTREAM_UNREACHABLE",
  "UPSTREAM_TIMEOUT",
  "UPSTREAM_RATE_LIMITED",
  "UPSTREAM_INVALID_RESPONSE",
  "MODEL_UNAVAILABLE",
  "MODEL_VENDOR_MISMATCH",
  "MODEL_VENDOR_CONFLICT",
  "PROVIDER_DISABLED",
  "PROJECT_INVALID",
  "REVISION_CONFLICT",
  "REQUEST_CONFLICT",
  "SECRET_STORE_UNAVAILABLE",
]).annotate({ identifier: "RelayError.Code" })
export type Code = typeof Code.Type

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  code: Code,
  retryable: Schema.Boolean,
  requestId: Schema.String,
  details: Schema.String.pipe(optional),
}).annotate({ identifier: "RelayError.Info" })
