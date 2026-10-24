import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261021100727_task_orchestrator_parallel",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`task_orchestrator_task\` ADD \`mode\` text DEFAULT 'sequential' NOT NULL;`)
      yield* tx.run(`
        CREATE TABLE \`task_orchestrator_message\` (
          \`id\` text PRIMARY KEY,
          \`task_id\` text NOT NULL,
          \`role\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`content\` text NOT NULL,
          \`created_at\` integer NOT NULL
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`task_orchestrator_message_task_idx\` ON \`task_orchestrator_message\` (\`task_id\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
