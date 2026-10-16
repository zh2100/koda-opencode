export * as TaskOrchestratorChanges from "./changes"

import { Effect } from "effect"

export const collect = (input: {
  readonly directory: string
  readonly run: (command: string, directory: string) => Effect.Effect<string, unknown>
}) =>
  input.run("git status --porcelain", input.directory).pipe(
    Effect.map((output) =>
      output
        .split(/\r?\n/)
        .filter((line) => /^(?:[ MADRCU?]{2}|[ MADRCU?]{2} )/.test(line))
        .map((line) => line.slice(3).trim())
        .filter((line) => line.length > 0),
    ),
  )
