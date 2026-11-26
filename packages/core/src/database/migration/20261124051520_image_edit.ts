import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261124051520_image_edit",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`image_edit\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`state\` text NOT NULL,
          \`binding\` text NOT NULL,
          \`source_ref\` text NOT NULL,
          \`source_digest\` text NOT NULL,
          \`preview\` text,
          \`prompt\` text NOT NULL,
          \`model\` text NOT NULL,
          \`endpoint\` text NOT NULL,
          \`expires\` integer NOT NULL,
          \`status\` integer,
          \`result\` text,
          \`digest\` text,
          CONSTRAINT \`fk_image_edit_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX \`image_edit_session_idx\` ON \`image_edit\` (\`session_id\`,\`expires\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
