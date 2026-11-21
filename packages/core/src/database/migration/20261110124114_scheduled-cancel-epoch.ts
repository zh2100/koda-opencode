import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261110124114_scheduled-cancel-epoch",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`scheduled_task_run\` ADD \`cancel_epoch\` integer;`)
      yield* tx.run(`ALTER TABLE \`scheduled_task\` ADD \`cancel_epoch\` integer DEFAULT 0 NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
