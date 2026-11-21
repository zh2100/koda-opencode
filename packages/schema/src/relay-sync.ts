export * as RelaySync from "./relay-sync"

import { Schema } from "effect"
import { Relay } from "./relay"
import { RelayModel } from "./relay-model"
import { NonNegativeInt } from "./schema"

export interface Snapshot extends Schema.Schema.Type<typeof Snapshot> {}
export const Snapshot = Schema.Struct({
  auth: Relay.AuthState,
  candidates: Schema.Array(RelayModel.Candidate),
  managed: Schema.Array(RelayModel.Managed),
  catalogRevision: Schema.NullOr(NonNegativeInt),
  notice: Schema.Struct({ status: Schema.Literals(["idle", "pending", "exhausted"]) }),
}).annotate({ identifier: "RelaySync.Snapshot" })
