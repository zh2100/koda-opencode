import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { migrateLegacyUserData } from "./user-data"

let root: string
let target: string
let legacy: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "koda-user-data-"))
  target = join(root, "com.shuyuanai.koda.desktop")
  legacy = join(root, "ai.opencode.desktop")
  mkdirSync(legacy, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("legacy user data migration", () => {
  test("copies settings and workspace stores", () => {
    writeFileSync(join(legacy, "default.dat"), JSON.stringify({ theme: "dark" }))
    writeFileSync(join(legacy, "opencode.settings"), JSON.stringify({ locale: "zh" }))
    mkdirSync(join(legacy, "logs"))
    writeFileSync(join(legacy, "logs", "main.log"), "ignored")

    expect(migrateLegacyUserData(target)).toEqual(["default.dat", "opencode.settings"])
    expect(readFileSync(join(target, "default.dat"), "utf8")).toBe(JSON.stringify({ theme: "dark" }))
    expect(existsSync(join(target, "logs"))).toBe(false)
    expect(existsSync(join(target, ".desktop-data-migrated"))).toBe(true)
  })

  test("does not overwrite files already written by the new app", () => {
    writeFileSync(join(legacy, "default.dat"), "legacy")
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, "default.dat"), "current")

    expect(migrateLegacyUserData(target)).toEqual([])
    expect(readFileSync(join(target, "default.dat"), "utf8")).toBe("current")
  })

  test("runs once", () => {
    writeFileSync(join(legacy, "default.dat"), "legacy")
    migrateLegacyUserData(target)
    writeFileSync(join(legacy, "opencode.global.dat"), "later")

    expect(migrateLegacyUserData(target)).toEqual([])
    expect(existsSync(join(target, "opencode.global.dat"))).toBe(false)
  })

  test("does nothing when the legacy profile is missing", () => {
    rmSync(legacy, { recursive: true, force: true })

    expect(migrateLegacyUserData(target)).toEqual([])
    expect(existsSync(target)).toBe(false)
  })
})
