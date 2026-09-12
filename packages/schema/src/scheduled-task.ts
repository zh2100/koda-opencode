export * as ScheduledTask from "./scheduled-task"

import { Schema } from "effect"
import { Location } from "./location"
import { Model } from "./model"
import { Prompt } from "./prompt"
import { Project } from "./project"
import { DateTimeUtcFromMillis, NonNegativeInt, optional, statics } from "./schema"
import { SessionID } from "./session-id"
import { SessionMessage } from "./session-message"
import { ascending } from "./identifier"
import { Relay } from "./relay"
import { RelayError } from "./relay-error"

export const ID = Schema.String.check(Schema.isStartsWith("stk_")).pipe(
  Schema.brand("ScheduledTask.ID"),
  statics((schema) => ({ create: () => schema.make("stk_" + ascending()) })),
)
export type ID = typeof ID.Type

export const ScheduleKind = Schema.Literals(["once", "daily"]).annotate({ identifier: "ScheduledTask.ScheduleKind" })
export type ScheduleKind = typeof ScheduleKind.Type

export const ApprovalMode = Schema.Literals(["ask", "auto", "plan"]).annotate({
  identifier: "ScheduledTask.ApprovalMode",
})
export type ApprovalMode = typeof ApprovalMode.Type

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  name: Schema.String,
  projectID: Project.ID,
  location: Location.Ref,
  prompt: Prompt,
  schedule: ScheduleKind,
  timezone: Schema.String,
  runAt: DateTimeUtcFromMillis,
  model: Model.Ref,
  effort: Relay.Effort.pipe(optional),
  approvalMode: ApprovalMode,
  enabled: Schema.Boolean,
  revision: NonNegativeInt,
  nextRun: DateTimeUtcFromMillis.pipe(optional),
  lastRun: DateTimeUtcFromMillis.pipe(optional),
}).annotate({ identifier: "ScheduledTask.Info" })

export const RunID = Schema.String.check(Schema.isStartsWith("trn_")).pipe(
  Schema.brand("ScheduledTask.RunID"),
  statics((schema) => ({ create: () => schema.make("trn_" + ascending()) })),
)
export type RunID = typeof RunID.Type

export const RunStatus = Schema.Literals([
  "pending",
  "running",
  "completed",
  "failed",
  "missed",
  "interrupted",
]).annotate({ identifier: "ScheduledTask.RunStatus" })
export type RunStatus = typeof RunStatus.Type

export interface Run extends Schema.Schema.Type<typeof Run> {}
export const Run = Schema.Struct({
  id: RunID,
  taskId: ID,
  scheduledAt: DateTimeUtcFromMillis,
  revision: NonNegativeInt,
  status: RunStatus,
  sessionId: SessionID.pipe(optional),
  promptMessageId: SessionMessage.ID.pipe(optional),
  startedAt: DateTimeUtcFromMillis.pipe(optional),
  endedAt: DateTimeUtcFromMillis.pipe(optional),
  error: RelayError.Info.pipe(optional),
}).annotate({ identifier: "ScheduledTask.Run" })
