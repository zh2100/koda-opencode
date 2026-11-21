import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261107102331_scheduled-run-owner",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`scheduled_task_run\` ADD \`owner\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
