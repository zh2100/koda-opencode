import { expect } from "bun:test"
import { Effect } from "effect"
import { execFile } from "node:child_process"
import path from "node:path"
import { it } from "../lib/effect"
it.live("F36 settled failures leave active work but remain in shutdown diagnostics", () => Effect.gen(function* () {
  const output = yield* Effect.tryPromise(() => new Promise<string>((resolve, reject) => execFile(process.execPath,
    [path.join(import.meta.dir, "fixtures/handoff-child.ts")], { windowsHide: true }, (error, stdout) => error ? reject(error) : resolve(stdout))))
  expect(output).not.toContain("PRIVATE-HANDOFF-TOKEN")
  const result = JSON.parse(output.trim())
  expect(result.before.active).toBe(0)
  expect(result.before.unrecovered).toBe(1030)
  expect(result.before.failures).toHaveLength(1024)
  expect(result.before.overflow).toBe(true)
  expect(result.after).toEqual(result.before)
  expect(result.calls).toBe(1030)
  expect(result.errors).toEqual(["Configuration refresh remains incomplete", "Configuration refresh remains incomplete"])
}))
