export * as ScheduledTaskEvent from "./scheduled-task-event"

import { Event } from "./event"
import { optional } from "./schema"
import { ScheduledTask } from "./scheduled-task"

export const Updated = Event.define({
  type: "scheduled.task.updated",
  schema: {
    task: ScheduledTask.Info,
    run: ScheduledTask.Run.pipe(optional),
  },
})

export const Definitions = Event.inventory(Updated)
