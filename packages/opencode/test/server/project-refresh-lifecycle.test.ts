import { expect } from "bun:test"
import path from "node:path"
import { execFile } from "node:child_process"
import { Effect } from "effect"
import { it } from "../lib/effect"
for (const mode of ["transient", "terminal"]) {
  it.live(
    `F36 real TCP committed refresh ${mode}`,
    () =>
      Effect.gen(function* () {
        const output = yield* Effect.tryPromise(
          () =>
            new Promise<string>((resolve, reject) =>
              execFile(
                process.execPath,
                [path.join(import.meta.dir, "fixtures/project-refresh-child.ts"), mode],
                { windowsHide: true, timeout: 60000 },
                (error, stdout, stderr) =>
                  error ? reject(new Error(`refresh child failed: ${String(error)}\n${stderr}`)) : resolve(stdout),
              ),
            ),
        )
        const result = output.split("\n").find((line) => line.startsWith("REFRESH_HTTP_RESULT "))
        expect(result).toBeDefined()
        expect(JSON.parse(result!.slice("REFRESH_HTTP_RESULT ".length))).toEqual({
          mode,
          calls: mode === "terminal" ? 1 : 2,
          admitted: 1,
          shutdownFailed: mode === "terminal",
        })
      }),
    90000,
  )
}
