import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Global } from "../src/global"

const inheritedNames = [
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_CONFIG_CONTENT",
  "OPENCODE_TUI_CONFIG",
  "OPENCODE_PLUGIN_META_FILE",
  "OPENCODE_PERMISSION",
  "OPENCODE_DISABLE_PROJECT_CONFIG",
  "OPENCODE_PURE",
  "OPENCODE_WORKSPACE_ID",
  "OPENCODE_EXPERIMENTAL",
  "OPENCODE_EXPERIMENTAL_NATIVE_LLM",
  "OPENCODE_NATIVE_LOCK_DIR",
  "OPENCODE_CONSOLE_TOKEN",
  "RECORD",
] as const

const inside = (resolved: string, root: string) => {
  const real = fs.existsSync(resolved) ? fs.realpathSync(resolved) : path.resolve(resolved)
  const base = fs.existsSync(root) ? fs.realpathSync(root) : path.resolve(root)
  return real === base || real.startsWith(base + path.sep)
}

test("review isolation drops inherited config overrides and resolves inside the review root", () => {
  const reviewRoot = process.env.XDG_CONFIG_HOME
  const reviewHome = process.env.OPENCODE_TEST_HOME
  if (!reviewRoot || !reviewHome) throw new Error("isolation root was not set before importing Global")
  const inheritedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-uc-inherited-"))
  const sentinel = path.join(inheritedRoot, "sentinel.txt")
  fs.writeFileSync(sentinel, "untouched")
  const previous = new Map(inheritedNames.map((name) => [name, process.env[name]]))
  try {
    process.env.OPENCODE_CONFIG = path.join(inheritedRoot, "config.json")
    process.env.OPENCODE_CONFIG_DIR = inheritedRoot
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      mcp: { leaked: { type: "remote", url: "http://inherited.invalid", enabled: false } },
    })
    for (const name of inheritedNames) delete process.env[name]
    const global = Global.make()
    expect(inside(global.home, reviewHome)).toBe(true)
    expect(inside(global.config, reviewRoot)).toBe(true)
    for (const resolved of [global.home, global.config, global.data, global.state, global.cache]) {
      expect(inside(resolved, inheritedRoot)).toBe(false)
    }
    expect(fs.readFileSync(sentinel, "utf8")).toBe("untouched")
    expect(process.env.OPENCODE_CONFIG).toBeUndefined()
    expect(process.env.OPENCODE_CONFIG_DIR).toBeUndefined()
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    fs.rmSync(inheritedRoot, { recursive: true, force: true })
  }
})
