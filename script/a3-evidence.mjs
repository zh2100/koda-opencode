import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { spawn, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const files = [
  "script/a3-evidence.mjs",
  "script/a3-evidence.test.mjs",
  "script/test-isolated.mjs",
  "script/test-isolation.mjs",
  "packages/core/test/preload.ts",
  "packages/opencode/test/preload.ts",
  "packages/opencode/src/server/server.ts",
  "packages/opencode/test/server/project-refresh-lifecycle.test.ts",
  "packages/opencode/test/server/fixtures/project-refresh-child.ts",
  "packages/opencode/test/server/httpapi-file.test.ts",
  "packages/opencode/test/server/httpapi-sdk.test.ts",
  "packages/opencode/test/server/installed-plugin.ts",
  ...[
    "isolated-worker-runner",
    "isolated-worker-capabilities",
    "effect-flock-test-layer",
    "effect-flock-resolution",
    "lock-wait-poc",
    "lock-wait-faults",
    "stage0-lock-worker",
  ].map((name) => `packages/core/test/util/${name}.test.ts`),
  "packages/core/test/support/isolated-worker-runner.ts",
  "packages/core/test/support/descendant-probe.ts",
  "packages/core/test/support/verify-lock-worker.ts",
  "packages/core/test/support/effect-flock-test-layer.ts",
  ...["lock-wait-poc-worker", "lock-wait-fault-worker", "stage0-lock-worker"].map(
    (name) => `packages/core/test/fixture/${name}.ts`,
  ),
  "packages/core/test/image-generation-settings.test.ts",
  "packages/core/src/image-generation-settings.ts",
  "packages/core/src/config/atomic-document.ts",
  "packages/core/src/config/document.ts",
  "packages/core/test/config/atomic-document.test.ts",
  "packages/core/test/config/document.test.ts",
  "packages/core/test/skill/guidance.test.ts",
  "packages/core/test/effect/cross-spawn-spawner.test.ts",
  "packages/core/test/location-layer.test.ts",
  "packages/core/test/ripgrep.test.ts",
  "packages/opencode/test/permission-task.test.ts",
  "packages/opencode/test/cli/mcp-add.test.ts",
  "packages/opencode/test/lib/cli-process.ts",
  "packages/opencode/test/format/format.test.ts",
  "packages/opencode/test/skill/skill.test.ts",
  "packages/opencode/test/tool/skill.test.ts",
  "packages/opencode/test/tool/read.test.ts",
  "packages/opencode/src/index.ts",
  "packages/opencode/src/cli/commands.ts",
  "packages/opencode/src/server/routes/instance/httpapi/middleware/error.ts",
  "packages/opencode/test/server/httpapi-mcp.test.ts",
  "packages/opencode/test/cli/help/help-snapshots.test.ts",
  "packages/opencode/test/cli/help/__snapshots__/help-snapshots.test.ts.snap",
  "packages/opencode/src/cli/cmd/acp.ts",
  "packages/opencode/test/tool/external-directory.test.ts",
  "packages/opencode/test/cli/tui/editor-context-zed.test.ts",
  "packages/opencode/test/cli/acp/lifecycle.test.ts",
  "packages/opencode/test/agent/agent.test.ts",
  "packages/opencode/test/agent/plan-mode-subagent-bypass.test.ts",
  "packages/opencode/test/mcp/lifecycle.test.ts",
  "packages/opencode/test/server/global-session-list.test.ts",
  "packages/opencode/test/project/instance-install-dispose.test.ts",
  "packages/opencode/src/effect/instance-work.ts",
  "packages/opencode/src/project/instance-store.ts",
  "packages/opencode/src/config/config.ts",
  "packages/core/src/npm.ts",
  "packages/opencode/test/fixture/fixture.ts",
  "packages/opencode/test/fake/npm.ts",
  "packages/opencode/test/fixture/config.ts",
]
const hash = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")

export function reserve(directory) {
  // Non-recursive mkdir is the atomic reservation; never open an existing archive.
  fs.mkdirSync(directory)
}

export function audit(directory) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"))
  for (const [file, expected] of Object.entries(manifest.sources)) {
    if (hash(path.join(repo, file)) !== expected) throw new Error(`source drift: ${file}`)
  }
  for (const [file, expected] of Object.entries(manifest.artifacts)) {
    if (hash(path.join(directory, file)) !== expected) throw new Error(`artifact mismatch: ${file}`)
  }
  for (const name of manifest.required) {
    if (!(name in manifest.artifacts)) throw new Error(`missing required artifact: ${name}`)
  }
  return manifest
}

export async function run(directory) {
  const lock = path.join(repo, ".a3-evidence-active.json")
  fs.writeFileSync(lock, JSON.stringify({ directory, pid: process.pid, started: new Date().toISOString() }), { flag: "wx" })
  // Do not infer cleanup from a dead supervisor PID. Leave the reservation for
  // inspection after a crash, interrupted gate, or unsuccessful run.
  const results = await runReserved(directory)
  if (results.every((result) => result.status === 0 && !result.timedOut)) fs.unlinkSync(lock)
  return results
}

async function runReserved(directory) {
  reserve(directory)
  fs.mkdirSync(path.join(directory, "workers"))
  const sources = Object.fromEntries(files.map((file) => [file, hash(path.join(repo, file))]))
  fs.writeFileSync(path.join(directory, "sources-before.json"), JSON.stringify(sources, null, 2))
  const results = []
  const execute = async (name, cwd, args, timeout = 180000) => {
    const log = fs.openSync(path.join(directory, `${name}.log`), "wx")
    const started = new Date().toISOString()
    const child = spawn(args[0], args.slice(1), {
      cwd: path.join(repo, cwd),
      stdio: ["ignore", log, log],
      env: { ...process.env, A3_EVIDENCE_DIR: path.join(directory, "workers") },
    })
    const termination = []
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      if (process.platform !== "win32") {
        child.kill("SIGKILL")
        return
      }
      // Terminate the entire gate tree, not merely its node wrapper.
      const killed = spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        encoding: "utf8",
        timeout: 10000,
      })
      termination.push({
        command: `taskkill /pid ${child.pid} /T /F`,
        status: killed.status,
        stdout: killed.stdout,
        stderr: killed.stderr,
        error: killed.error?.message,
      })
    }, timeout)
    const result = await new Promise((resolve) => {
      child.once("error", (error) => resolve({ status: null, signal: null, error }))
      child.once("close", (status, signal) => resolve({ status, signal }))
    })
    clearTimeout(timer)
    if (termination.length)
      fs.writeFileSync(path.join(directory, `${name}-termination.json`), JSON.stringify(termination, null, 2))
    fs.closeSync(log)
    results.push({
      name,
      cwd,
      args,
      started,
      ended: new Date().toISOString(),
      timedOut,
      status: result.status,
      signal: result.signal,
      error: result.error?.message,
    })
    fs.writeFileSync(path.join(directory, "results.json"), JSON.stringify(results, null, 2))
  }
  await execute("archive-negatives", "packages/core", [
    "node",
    "--test",
    path.join(repo, "script/a3-evidence.test.mjs"),
  ])
  await execute("core-typecheck", "packages/core", ["bun", "typecheck"])
  await execute(
    "joint",
    "packages/core",
    [
      "node",
      path.join(repo, "script/test-isolated.mjs"),
      "test",
      ...files.filter((file) => file.includes("/test/util/")).map((file) => file.replace("packages/core/", "")),
      "--timeout",
      "120000",
    ],
    300000,
  )
  await execute("img", "packages/core", [
    "node",
    path.join(repo, "script/test-isolated.mjs"),
    "test",
    "test/image-generation-settings.test.ts",
    "--test-name-pattern",
    "IMG-T07a|IMG-T10",
    "--timeout",
    "120000",
  ])
  // Full product gates are separately logged; a timeout is a failed/unconfirmed gate, not success.
  for (const pkg of ["core", "server", "opencode"]) {
    if (pkg !== "core") await execute(`${pkg}-typecheck`, `packages/${pkg}`, ["bun", "typecheck"])
    await execute(
      `${pkg}-tests`,
      `packages/${pkg}`,
      ["node", path.join(repo, "script/test-isolated.mjs"), "test", "--timeout", "30000"],
      pkg === "server" ? 180000 : pkg === "opencode" ? 3600000 : 900000,
    )
  }
  fs.writeFileSync(
    path.join(directory, "environment.json"),
    JSON.stringify(
      {
        platform: process.platform,
        node: process.version,
        bun: spawnSync("bun", ["--version"], { encoding: "utf8" }).stdout,
        head: spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout,
      },
      null,
      2,
    ),
  )
  const artifacts = Object.fromEntries(
    fs
      .readdirSync(directory, { recursive: true })
      .filter((file) => fs.statSync(path.join(directory, file)).isFile())
      .map((file) => [file, hash(path.join(directory, file))]),
  )
  const required = [
    "sources-before.json",
    "environment.json",
    "results.json",
    ...results.map((result) => `${result.name}.log`),
  ]
  fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({ sources, artifacts, required }, null, 2))
  audit(directory)
  return results
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = path.resolve(process.argv[3])
  if (process.argv[2] === "audit") console.log(JSON.stringify(audit(directory), null, 2))
  if (process.argv[2] === "run") {
    const results = await run(directory)
    console.log(JSON.stringify(results, null, 2))
    if (results.some((result) => result.status !== 0 || result.timedOut)) process.exitCode = 1
  }
}
