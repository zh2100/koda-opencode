import { rm } from "node:fs/promises"
import path from "node:path"
import { loadGlobal, preload } from "../../../script/test-isolation.mjs"

const env = { ...process.env }
const binary = process.platform === "win32" ? "rg.exe" : "rg"
const admission = Bun.which(binary) ? undefined : preload("opencode-core-ripgrep-")
try {
  if (admission) {
    // Resolve the pinned fallback once, outside individual test deadlines and in an isolated home.
    await loadGlobal(admission.root)
    const { Effect } = await import("effect")
    const { LayerNode } = await import("../src/effect/layer-node")
    const { RipgrepBinary } = await import("../src/ripgrep/binary")
    const executable = await RipgrepBinary.Service.use((service) => service.filepath).pipe(
      Effect.provide(LayerNode.compile(RipgrepBinary.node)),
      Effect.timeout("60 seconds"),
      Effect.runPromise,
    )
    const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH") ?? "PATH"
    env[key] = [path.dirname(executable), env[key]].filter(Boolean).join(path.delimiter)
  }

  // The test process has its own preload and must not inherit the bootstrap home.
  const tests = Bun.spawn([process.execPath, "test", "--only-failures", ...process.argv.slice(2)], {
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  process.exitCode = await tests.exited
} finally {
  if (admission) await rm(admission.root, { recursive: true, force: true, maxRetries: 3 })
}
