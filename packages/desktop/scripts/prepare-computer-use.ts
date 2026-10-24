#!/usr/bin/env bun
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

const version = "1.1.2"
const integrity = "sha512-xb88Gwf3y0NgRY2qVkC+Ff00lSBOR5tD7vQCIph+YoYaPrZ6FPata7UW9fR5zowGrHF3aK/E0buutXl0TlUvnQ=="
const packageDir = resolve(dirname(import.meta.path), "..")
const destination = join(packageDir, "resources", "open-computer-use")
const arch = process.arch === "arm64" ? "arm64" : "amd64"
const runtime =
  process.platform === "win32"
    ? join(destination, "dist", "windows", arch, "open-computer-use.exe")
    : process.platform === "linux"
      ? join(destination, "dist", "linux", arch, "open-computer-use")
      : join(destination, "dist", "Open Computer Use.app", "Contents", "MacOS", "OpenComputerUse")
const archive = join(packageDir, ".cache", "open-computer-use", `${version}.tgz`)

if (existsSync(runtime)) {
  console.log(`open-computer-use ${version} is already staged`)
  process.exit(0)
}

const digest = Buffer.from(integrity.slice("sha512-".length), "base64")
if (!existsSync(archive) || !createHash("sha512").update(await readFile(archive)).digest().equals(digest)) {
  const response = await fetch(`https://registry.npmjs.org/open-computer-use/-/open-computer-use-${version}.tgz`, {
    signal: AbortSignal.timeout(120_000),
  })
  if (!response.ok) throw new Error(`Failed to download open-computer-use: HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (!createHash("sha512").update(bytes).digest().equals(digest)) {
    throw new Error("open-computer-use checksum mismatch")
  }
  await mkdir(dirname(archive), { recursive: true })
  await writeFile(archive, bytes)
}

await rm(destination, { recursive: true, force: true })
await mkdir(destination, { recursive: true })
execFileSync("tar", ["-xzf", archive, "-C", destination, "--strip-components=1"], {
  cwd: tmpdir(),
  timeout: 120_000,
  stdio: "inherit",
})
if (!existsSync(runtime)) {
  throw new Error(`Staged open-computer-use is incomplete for ${process.platform}-${process.arch}`)
}
console.log(`Staged open-computer-use ${version}`)
