export * as ConfigWrite from "./write-error"

import { Schema } from "effect"
import { randomUUID } from "node:crypto"

export const Codes = Schema.Literals([
  "CONFIG_DOCUMENT_INVALID",
  "CONFIG_PATCH_INVALID",
  "CONFIG_PROJECT_DISABLED",
  "CONFIG_SOURCE_READ_ONLY",
  "CONFIG_TARGET_OUTSIDE_PROJECT",
  "CONFIG_SOURCE_CHANGED",
  "CONFIG_SOURCE_OVERRIDDEN",
  "CONFIG_PATH_ALIAS_UNSUPPORTED",
  "CONFIG_TEMPLATE_EDIT_UNSUPPORTED",
  "CONFIG_SOURCE_READ_FAILED",
  "CONFIG_LOCK_TIMEOUT",
  "CONFIG_WRITE_FAILED",
  "CONFIG_REFRESH_CAPACITY_EXHAUSTED",
  "CONFIG_COMMIT_UNKNOWN",
])
export class Error extends Schema.TaggedErrorClass<Error>()("ConfigWriteError", { code: Codes, ref: Schema.String }) {
  get status() {
    return status(this.code)
  }
}
export function fail(code: typeof Codes.Type) {
  return new Error({ code, ref: randomUUID() })
}
export function status(code: typeof Codes.Type) {
  if (code === "CONFIG_DOCUMENT_INVALID" || code === "CONFIG_PATCH_INVALID") return 400
  if (
    code === "CONFIG_PROJECT_DISABLED" ||
    code === "CONFIG_SOURCE_READ_ONLY" ||
    code === "CONFIG_TARGET_OUTSIDE_PROJECT"
  )
    return 403
  if (
    code === "CONFIG_SOURCE_CHANGED" ||
    code === "CONFIG_SOURCE_OVERRIDDEN" ||
    code === "CONFIG_PATH_ALIAS_UNSUPPORTED" ||
    code === "CONFIG_TEMPLATE_EDIT_UNSUPPORTED"
  )
    return 409
  return 503
}
