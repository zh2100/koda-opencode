import fs from "fs/promises"
import { chmodSync, statSync } from "node:fs"
import os from "os"
import path from "path"
import { spawnSync } from "child_process"
import { describe, expect, test } from "bun:test"
import { Global } from "@opencode-ai/core/global"
import { tmpdir } from "./fixture/tmpdir"

function relocated(home: string) {
  const base = path.join(home, ".opencode-next")
  return {
    data: path.join(base, "data"),
    cache: path.join(base, "cache"),
    config: path.join(base, "config"),
    state: path.join(base, "state"),
  }
}

function deny(target: string) {
  if (process.platform !== "win32") {
    chmodSync(target, statSync(target).mode & 0o555)
    return true
  }
  const result = spawnSync("icacls", [target, "/deny", `${os.userInfo().username}:(W)`], { encoding: "utf8" })
  return result.status === 0
}

function reset(target: string) {
  if (process.platform !== "win32") {
    chmodSync(target, statSync(target).mode | 0o200)
    return
  }
  spawnSync("icacls", [target, "/reset", "/T", "/C"], { encoding: "utf8" })
}

describe("old resource root isolation", () => {
  test("a recreated or replaced old path remains unwritable to the old writer", async () => {
    await using tmp = await tmpdir()
    const boundary = path.join(tmp.path, "old")
    const oldRoot = path.join(boundary, "old-data", "opencode")
    const project = path.join(tmp.path, "project", ".opencode")
    const nextRoot = path.join(tmp.path, "next-data", "opencode")
    await fs.mkdir(oldRoot, { recursive: true })
    await fs.mkdir(project, { recursive: true })
    await fs.mkdir(nextRoot, { recursive: true })
    await fs.writeFile(path.join(oldRoot, "config.json"), JSON.stringify({ writer: "old" }))
    await fs.writeFile(path.join(project, "opencode.json"), JSON.stringify({ mcp: { sample: { command: ["old"] } } }))

    await fs.rename(oldRoot, path.join(tmp.path, "quarantine-old"))
    await fs.rename(project, path.join(tmp.path, "quarantine-project"))
    await fs.writeFile(path.join(nextRoot, "config.json"), JSON.stringify({ writer: "next" }))
    expect(deny(path.dirname(oldRoot))).toBe(true)
    expect(deny(path.dirname(project))).toBe(true)
    // POSIX rename checks the containing directory, not the entry being moved.
    if (process.platform !== "win32") deny(boundary)
    using cleanup = { [Symbol.dispose]() {
      if (process.platform !== "win32") reset(boundary)
      reset(path.dirname(oldRoot))
      reset(path.dirname(project))
    } }
    await fs.mkdir(oldRoot, { recursive: true }).catch(() => undefined)
    const recreated = await fs.writeFile(path.join(oldRoot, "config.json"), "old").then(
      () => false,
      () => true,
    )
    const replacedParent = path.join(tmp.path, "replacement")
    await fs.mkdir(replacedParent)
    if (process.platform === "win32") {
      expect(spawnSync("cmd", ["/c", "move", "/Y", path.dirname(oldRoot), replacedParent]).status).not.toBe(0)
    } else {
      await expect(fs.rename(path.dirname(oldRoot), path.join(replacedParent, "old-data"))).rejects.toMatchObject({ code: "EACCES" })
    }
    const outside = await fs.writeFile(path.join(project, "opencode.json"), "old").then(
      () => false,
      () => true,
    )

    expect(recreated).toBe(true)
    expect(outside).toBe(true)
    expect(await fs.readFile(path.join(nextRoot, "config.json"), "utf8")).toContain("next")
  })

  test("new resources stay outside the default Global data and config roots", () => {
    const next = relocated(path.join(os.tmpdir(), `opencode-home-${process.pid}`))
    for (const target of [next.data, next.cache, next.config, next.state]) {
      expect(target.startsWith(Global.Path.data)).toBe(false)
      expect(target.startsWith(Global.Path.config)).toBe(false)
      expect(target.startsWith(Global.Path.state)).toBe(false)
      expect(target.startsWith(Global.Path.cache)).toBe(false)
    }
  })

  test("an old writer cannot use the new root, and a new writer leaves the old root untouched", async () => {
    await using tmp = await tmpdir()
    const home = path.join(tmp.path, "home")
    const old = {
      data: path.join(tmp.path, "xdg", "share", "opencode"),
      cache: path.join(tmp.path, "xdg", "cache", "opencode"),
      config: path.join(tmp.path, "xdg", "config", "opencode"),
      state: path.join(tmp.path, "xdg", "state", "opencode"),
    }
    const custom = path.join(tmp.path, "project", ".opencode")
    const next = relocated(home)
    await fs.mkdir(old.data, { recursive: true })
    await fs.mkdir(custom, { recursive: true })
    await fs.writeFile(
      path.join(old.data, "mcp-auth.json"),
      JSON.stringify({ sample: { tokens: { accessToken: "old" } } }),
    )
    await fs.writeFile(path.join(custom, "opencode.json"), JSON.stringify({ mcp: { sample: { command: ["old"] } } }))

    const quarantine = path.join(tmp.path, "quarantine")
    await fs.mkdir(quarantine)
    await fs.rename(old.data, path.join(quarantine, "data"))
    await fs.rename(custom, path.join(quarantine, "project"))
    await fs.mkdir(next.data, { recursive: true })
    await fs.mkdir(next.config, { recursive: true })
    await fs.writeFile(
      path.join(next.data, "mcp-auth.json"),
      JSON.stringify({ sample: { tokens: { accessToken: "next" } } }),
    )
    await fs.writeFile(
      path.join(next.config, "opencode.json"),
      JSON.stringify({ mcp: { sample: { command: ["next"] } } }),
    )
    expect(deny(path.join(quarantine, "data", "mcp-auth.json"))).toBe(true)
    expect(deny(path.join(quarantine, "project", "opencode.json"))).toBe(true)
    expect(deny(path.dirname(old.data))).toBe(true)
    expect(deny(path.dirname(custom))).toBe(true)

    const oldWriter = path.join(tmp.path, "old-writer.cjs")
    const targets = [
      path.join(old.data, "mcp-auth.json"),
      path.join(custom, "opencode.json"),
      path.join(next.data, "mcp-auth.json"),
    ]
    await fs.writeFile(
      oldWriter,
      [
        "const fs = require('node:fs')",
        "const path = require('node:path')",
        `const targets = ${JSON.stringify(targets)}`,
        "const results = targets.map((target) => {",
        "  try {",
        "    fs.mkdirSync(path.dirname(target), { recursive: true })",
        "    fs.writeFileSync(target, 'old-write')",
        "    return 'wrote'",
        "  } catch {",
        "    return 'denied'",
        "  }",
        "})",
        "process.stdout.write(results.join(','))",
      ].join("\n"),
    )
    expect(deny(path.join(next.data, "mcp-auth.json"))).toBe(true)
    expect(deny(next.data)).toBe(true)
    try {
      const ran = spawnSync(process.execPath, [oldWriter], { encoding: "utf8" })
      expect(ran.status).toBe(0)
      expect(ran.stdout).toBe("denied,denied,denied")
      reset(path.join(next.data, "mcp-auth.json"))
      const nextText = await fs.readFile(path.join(next.data, "mcp-auth.json"), "utf8")
      expect(nextText).toContain("next")
    } finally {
      reset(path.join(next.data, "mcp-auth.json"))
      reset(next.data)
      reset(path.join(quarantine, "data", "mcp-auth.json"))
      reset(path.join(quarantine, "project", "opencode.json"))
      reset(path.dirname(old.data))
      reset(path.dirname(custom))
    }
  })
})
