import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { stageCli } from "../src/main/cli-staging"
import pkg from "../package.json"

const executableName = process.platform === "win32" ? "opencode-cli.exe" : "opencode-cli"
const root = await mkdtemp(join(tmpdir(), "koda-release-lock-"))
try {
  const input = {
    executableName,
    source: resolve(process.argv[2], executableName),
    stagingRoot: root,
    version: pkg.version,
    native: { required: true, platform: process.platform, arch: process.arch },
    logger: console,
  }
  const staged = await stageCli(input)
  if (!staged.installed || (await stageCli(input)).installed) throw new Error("Staged package not reusable")
  const result = Bun.spawnSync([staged.binary, "--version"])
  if (result.exitCode !== 0 || result.stdout.toString().trim() !== `lildax v${pkg.version}`) {
    throw new Error(`Bundled CLI version check failed: ${result.stdout} ${result.stderr}`)
  }
  // Use a child so Windows unmaps the DLL before removing the staged directory.
  const probe = Bun.spawnSync([
    process.execPath, "-e",
    `const lock = require(process.argv[1]); const result = lock.tryAcquire(process.argv[2]);
     if (result.status !== "acquired" || lock.release(result.token) !== "released") process.exit(1)`,
    join(staged.directory, `process-lock-${process.platform}-${process.arch}.node`), join(root, "probe.lock"),
  ], { stderr: "inherit" })
  if (probe.exitCode !== 0) {
    throw new Error("Packaged process-lock failed its lock/unlock probe")
  }
} finally {
  await rm(root, { recursive: true, force: true })
}
