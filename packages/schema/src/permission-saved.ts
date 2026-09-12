export * as PermissionSaved from "./permission-saved"

import { Effect, Schema } from "effect"
import { ascending } from "./identifier"
import { Permission } from "./permission"
import { ProjectID } from "./project-id"
import { statics } from "./schema"

export const ID = Schema.String.pipe(
  Schema.brand("PermissionSaved.ID"),
  statics((schema) => ({ create: () => schema.make("psv_" + ascending()) })),
)
export type ID = typeof ID.Type

export const Info = Schema.Struct({
  id: ID,
  projectID: ProjectID,
  action: Schema.String,
  resource: Schema.String,
  effect: Permission.Effect.pipe(Schema.withDecodingDefault(Effect.succeed("allow" as const))),
}).annotate({ identifier: "PermissionSaved.Info" })
export interface Info extends Schema.Schema.Type<typeof Info> {}
