import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261123190132_image_attempt",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`image_attempt\` (
          \`session_id\` text NOT NULL,
          \`task_id\` text NOT NULL,
          \`slot\` text NOT NULL,
          \`call_id\` text NOT NULL,
          \`model\` text NOT NULL,
          \`digest\` text,
          CONSTRAINT \`image_attempt_pk\` PRIMARY KEY(\`session_id\`, \`task_id\`, \`slot\`),
          CONSTRAINT \`fk_image_attempt_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
