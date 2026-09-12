import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260906120000_permission_effect",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`permission\` ADD COLUMN \`effect\` text NOT NULL DEFAULT 'allow';`)
    })
  },
} satisfies DatabaseMigration.Migration
