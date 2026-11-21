import { expect } from "bun:test"
import { Effect } from "effect"
import { execFile } from "node:child_process"
import path from "node:path"
import { it } from "../lib/effect"
for (const scenario of ["recovery", "close-backoff", "close-running", "early-recovery"]) {
  it.live(`F36 refresh responsibility ${scenario}`, () =>
    Effect.gen(function* () {
      const result = yield* Effect.tryPromise(
        () =>
          new Promise<string>((resolve, reject) =>
            execFile(
              process.execPath,
              [path.join(import.meta.dir, "fixtures/refresh-child.ts"), scenario],
              { windowsHide: true, timeout: 10000 },
              (error, stdout) => (error ? reject(error) : resolve(stdout)),
            ),
          ),
      )
      expect(JSON.parse(result.trim())).toEqual({ mode: scenario, ok: true })
    }),
  )
}
