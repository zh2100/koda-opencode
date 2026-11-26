import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261124150601_session_input_invalidation",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_input\` ADD \`invalidated_seq\` integer;`)
    })
  },
} satisfies DatabaseMigration.Migration
