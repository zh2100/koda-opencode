#!/usr/bin/env bun
import { $ } from "bun"
import { copyFile } from "node:fs/promises"
import { join } from "node:path"

import pkg from "../package.json"
import { downloadCliToResources, resolveChannel } from "./utils"

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
  await copyFile(join(import.meta.dirname, "../../cli/dist/cli-windows-x64/bin/lildax.exe"), "resources/opencode-cli.exe")
}
