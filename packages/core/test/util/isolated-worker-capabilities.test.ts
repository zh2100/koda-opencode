import { expect, test } from "bun:test"
import path from "node:path"

test("A3 Bun capability probe records exited, exitCode and pipe EOF", async () => {
  const child = Bun.spawn(
    [process.execPath, "-e", "console.log('probe-stdout'); console.error('probe-stderr'); process.exit(3)"],
    { stdout: "pipe", stderr: "pipe" },
  )
  const before = { exitCode: child.exitCode, at: Date.now() }
  const output = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  const evidence = {
    platform: process.platform,
    bun: Bun.version,
    revision: Bun.revision,
    before,
    after: { exitCode: child.exitCode, exited: output[2], at: Date.now() },
    stdout: output[0],
    stderr: output[1],
    stdoutState: "eof",
    stderrState: "eof",
    signal: "unavailable",
  }
  expect(output[2]).toBe(3)
  expect(child.exitCode).toBe(3)
  expect(output[0]).toContain("probe-stdout")
  expect(output[1]).toContain("probe-stderr")
  if (process.env.A3_EVIDENCE_DIR)
    await Bun.write(path.join(process.env.A3_EVIDENCE_DIR, "capabilities.json"), JSON.stringify(evidence, null, 2))
}, 10000)
