import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { TaskOrchestratorChanges } from "@opencode-ai/core/task-orchestrator/changes"

describe("TaskOrchestratorChanges", () => {
  test("collects changed paths from git status", async () => {
    const changes = await Effect.runPromise(
      TaskOrchestratorChanges.collect({
        directory: "C:/repo",
        run: (command, directory) => Effect.succeed(`${command}:${directory}\n M src/a.ts\n?? src/b.ts\n`),
      }),
    )
    expect(changes).toEqual(["src/a.ts", "src/b.ts"])
  })
})