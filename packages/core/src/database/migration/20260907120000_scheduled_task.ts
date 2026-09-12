import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260907120000_scheduled_task",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`scheduled_task\` (
          \`id\` text PRIMARY KEY,
          \`name\` text NOT NULL,
          \`project_id\` text NOT NULL,
          \`location\` text NOT NULL,
          \`prompt\` text NOT NULL,
          \`schedule\` text NOT NULL,
          \`timezone\` text NOT NULL,
          \`run_at\` integer NOT NULL,
          \`model\` text NOT NULL,
          \`effort\` text,
          \`approval_mode\` text NOT NULL,
          \`enabled\` integer NOT NULL,
          \`revision\` integer NOT NULL,
          \`next_run\` integer,
          \`last_run\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`scheduled_task_run\` (
          \`id\` text PRIMARY KEY,
          \`task_id\` text NOT NULL,
          \`scheduled_at\` integer NOT NULL,
          \`revision\` integer NOT NULL,
          \`status\` text NOT NULL,
          \`session_id\` text,
          \`prompt_message_id\` text,
          \`started_at\` integer,
          \`ended_at\` integer,
          \`error\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_scheduled_task_run_task_id_scheduled_task_id_fk\` FOREIGN KEY (\`task_id\`) REFERENCES \`scheduled_task\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`scheduled_task_run_task_scheduled_idx\` ON \`scheduled_task_run\` (\`task_id\`,\`scheduled_at\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
