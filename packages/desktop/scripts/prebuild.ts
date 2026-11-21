#!/usr/bin/env bun
import { $ } from "bun"
import { existsSync } from "node:fs"
import { copyFile } from "node:fs/promises"
import { join } from "node:path"

import pkg from "../package.json"
import { downloadCliToResources, getCurrentCli, resolveChannel } from "./utils"

const channel = resolveChannel()
await $`bun ./scripts/copy-icons.ts ${channel}`
await $`bun ./scripts/copy-metainfo.ts ${channel}`

await $`cd ../opencode && bun script/build-node.ts`
if (channel === "dev") {
  await downloadCliToResources()
} else {
  // Version the bundled CLI with the desktop release so staged copies and
  // daemon registrations from older builds are never reused.
  process.env.OPENCODE_VERSION = pkg.version
  await $`cd ../cli && bun script/build.ts --single --skip-install`
  const cli = getCurrentCli()
  const cliName = cli.os === "win32" ? "windows" : cli.os
  const binary = cli.os === "win32" ? "lildax.exe" : "lildax"
  await copyFile(
    join(import.meta.dirname, `../../cli/dist/cli-${cliName}-${cli.cpu}/bin/${binary}`),
    cli.os === "win32" ? "resources/opencode-cli.exe" : "resources/opencode-cli",
  )
  const nativeDir = join(import.meta.dirname, "../../core/native/dist")
  const nativeName = `process-lock-${process.platform}-${process.arch}.node`
  const nativeSource = join(nativeDir, nativeName)
  if (existsSync(nativeSource)) {
    await copyFile(nativeSource, join("resources", nativeName))
    await copyFile(join(nativeDir, "process-lock-manifest.json"), join("resources", "process-lock-manifest.json"))
  }
}
