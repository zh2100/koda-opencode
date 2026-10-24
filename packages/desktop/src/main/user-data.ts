import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

const LEGACY_APP_ID = "ai.opencode.desktop"
const MARKER = ".desktop-data-migrated"
const DATA_FILE = /^(?:.*\.dat|opencode\.settings|drafts\.sqlite(?:-(?:wal|shm))?|window-state-.*\.json)$/

// Copy the desktop profile that older Koda builds shared with OpenCode into the
// Koda-specific userData directory. Chromium caches, logs, and staged CLIs are
// intentionally left behind.
export function migrateLegacyUserData(target: string) {
  if (existsSync(join(target, MARKER))) return []
  const source = join(dirname(target), LEGACY_APP_ID)
  if (source === target || !existsSync(source)) return []

  mkdirSync(target, { recursive: true })
  const copied: string[] = []
  for (const name of readdirSync(source)) {
    if (!DATA_FILE.test(name)) continue
    const from = join(source, name)
    const to = join(target, name)
    if (existsSync(to) || !statSync(from).isFile()) continue
    copyFileSync(from, to)
    copied.push(name)
  }
  writeFileSync(join(target, MARKER), "")
  return copied
}
