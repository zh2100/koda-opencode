import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261125011752_masked_image_edit",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`masked_image_edit\` (
          \`id\` text PRIMARY KEY,
          \`scope\` text NOT NULL,
          \`session_id\` text,
          \`fingerprint\` text NOT NULL,
          \`result\` text,
          CONSTRAINT \`fk_masked_image_edit_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX \`masked_image_edit_session_idx\` ON \`masked_image_edit\` (\`session_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
