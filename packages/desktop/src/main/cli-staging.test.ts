import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { retainLiveDirectories, stageCli } from "./cli-staging"

const logger = {
  log() {},
  error() {},
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

function source(root: string, native = false, manifestText?: string) {
  const directory = join(root, "source")
  mkdirSync(directory, { recursive: true })
  const executable = join(directory, "opencode-cli.exe")
  writeFileSync(executable, "cli-bytes")
  if (native) {
    writeFileSync(join(directory, "process-lock-win32-x64.node"), "native-bytes")
    writeFileSync(
      join(directory, "process-lock-manifest.json"),
      manifestText ??
        JSON.stringify({
          schemaVersion: 1,
          module: "process-lock",
          napi: "8",
          platform: "win32",
          arch: "x64",
          file: "process-lock-win32-x64.node",
          sha256: digest("native-bytes"),
        }),
    )
  }
  return executable
}

describe("cli staging transaction", () => {
  test("publishes a verified package and reuses the same identity", async () => {
    const root = mkdtempSync(join(tmpdir(), "cli-stage-"))
    const executable = source(root, true)
    const first = await stageCli({
      source: executable,
      stagingRoot: join(root, "cli"),
      version: "1.2.3",
      native: { required: true, platform: "win32", arch: "x64" },
      logger,
      executableName: "opencode-cli.exe",
    })
    expect(first.installed).toBe(true)
    expect(readFileSync(join(first.directory, "READY"), "utf8")).toContain(first.fingerprint)
    const second = await stageCli({
      source: executable,
      stagingRoot: join(root, "cli"),
      version: "1.2.3",
      native: { required: true, platform: "win32", arch: "x64" },
      logger,
      executableName: "opencode-cli.exe",
    })
    expect(second.installed).toBe(false)
    expect(second.directory).toBe(first.directory)
    rmSync(root, { recursive: true, force: true })
  })

  test("does not reuse a staged package whose module or READY record is damaged", async () => {
    const root = mkdtempSync(join(tmpdir(), "cli-stage-"))
    const executable = source(root, true)
    const staged = await stageCli({
      source: executable,
      stagingRoot: join(root, "cli"),
      version: "1.2.3",
      native: { required: true, platform: "win32", arch: "x64" },
      logger,
      executableName: "opencode-cli.exe",
    })
    writeFileSync(join(staged.directory, "process-lock-win32-x64.node"), "damaged")
    await expect(
      stageCli({
        source: executable,
        stagingRoot: join(root, "cli"),
        version: "1.2.3",
        native: { required: true, platform: "win32", arch: "x64" },
        logger,
        executableName: "opencode-cli.exe",
      }),
    ).rejects.toThrow(/incomplete|digest/)
    rmSync(join(staged.directory, "READY"))
    await expect(
      stageCli({
        source: executable,
        stagingRoot: join(root, "other"),
        version: "1.2.3",
        native: { required: true, platform: "win32", arch: "x64" },
        logger,
        executableName: "opencode-cli.exe",
      }),
    ).resolves.toMatchObject({ installed: true })
    rmSync(root, { recursive: true, force: true })
  })

  test("fails a declared native package that has no manifest and rejects an escaping manifest path", async () => {
    const root = mkdtempSync(join(tmpdir(), "cli-stage-"))
    const executable = source(root)
    await expect(
      stageCli({
        source: executable,
        stagingRoot: join(root, "cli"),
        version: "1.2.3",
        native: { required: true, platform: "win32", arch: "x64" },
        logger,
        executableName: "opencode-cli.exe",
      }),
    ).rejects.toThrow(/missing its manifest/)
    const escaping = source(
      join(root, "escape"),
      true,
      JSON.stringify({
        schemaVersion: 1,
        module: "process-lock",
        napi: "8",
        platform: "win32",
        arch: "x64",
        file: "../outside.node",
        sha256: digest("native-bytes"),
      }),
    )
    await expect(
      stageCli({
        source: escaping,
        stagingRoot: join(root, "cli"),
        version: "1.2.3",
        native: { required: true, platform: "win32", arch: "x64" },
        logger,
        executableName: "opencode-cli.exe",
      }),
    ).rejects.toThrow(/escapes/)
    rmSync(root, { recursive: true, force: true })
  })

  test("keeps an older live directory instead of deleting it", async () => {
    const root = mkdtempSync(join(tmpdir(), "cli-stage-"))
    mkdirSync(join(root, "old"), { recursive: true })
    writeFileSync(join(root, "old", "opencode-cli.exe"), "old")
    const retained = await retainLiveDirectories(root, [join(root, "old")], logger)
    expect(retained).toContain("old")
    expect(readFileSync(join(root, "old", "opencode-cli.exe"), "utf8")).toBe("old")
    rmSync(root, { recursive: true, force: true })
  })
})
