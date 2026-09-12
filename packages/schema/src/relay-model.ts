export * as RelayModel from "./relay-model"

import { Schema } from "effect"
import { DateTimeUtcFromMillis, optional } from "./schema"
import { Model } from "./model"
import { Relay } from "./relay"

export const AssignmentSource = Schema.Literals(["manual", "owned_by", "prefix", "unassigned", "conflict"]).annotate({
  identifier: "RelayModel.AssignmentSource",
})
export type AssignmentSource = typeof AssignmentSource.Type

export interface Candidate extends Schema.Schema.Type<typeof Candidate> {}
export const Candidate = Schema.Struct({
  vendorId: Relay.VendorID.pipe(optional),
  modelId: Model.ID,
  displayName: Schema.String.pipe(optional),
  ownedBy: Schema.String.pipe(optional),
  fetchedAt: DateTimeUtcFromMillis,
  assignmentSource: AssignmentSource,
  upstreamPresent: Schema.Boolean,
}).annotate({ identifier: "RelayModel.Candidate" })

export interface Managed extends Schema.Schema.Type<typeof Managed> {}
export const Managed = Schema.Struct({
  vendorId: Relay.VendorID,
  modelId: Model.ID,
  visible: Schema.Boolean,
  reasoningCapabilities: Schema.Array(Relay.Effort),
  assignmentSource: AssignmentSource,
  lastSeenAt: DateTimeUtcFromMillis,
  upstreamPresent: Schema.Boolean,
}).annotate({ identifier: "RelayModel.Managed" })
