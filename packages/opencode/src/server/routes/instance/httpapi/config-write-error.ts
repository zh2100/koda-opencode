import { ConfigWrite } from "@/config/write-error"
import { ProjectConfigInvalidError, ProjectConfigForbiddenError, ProjectConfigConflictError, ProjectConfigUnavailableError } from "./errors"

export function projectConfigHttpError(error: ConfigWrite.Error) {
  const code = error.code
  const ref = error.ref
  if (code === "CONFIG_DOCUMENT_INVALID" || code === "CONFIG_PATCH_INVALID") return new ProjectConfigInvalidError({ code, ref })
  if (code === "CONFIG_PROJECT_DISABLED" || code === "CONFIG_SOURCE_READ_ONLY" || code === "CONFIG_TARGET_OUTSIDE_PROJECT") return new ProjectConfigForbiddenError({ code, ref })
  if (code === "CONFIG_SOURCE_CHANGED" || code === "CONFIG_SOURCE_OVERRIDDEN" || code === "CONFIG_PATH_ALIAS_UNSUPPORTED" || code === "CONFIG_TEMPLATE_EDIT_UNSUPPORTED") return new ProjectConfigConflictError({ code, ref })
  return new ProjectConfigUnavailableError({ code, ref })
}
