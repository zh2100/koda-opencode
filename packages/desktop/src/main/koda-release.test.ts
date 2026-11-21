import { expect, test } from "bun:test"
import pkg from "../../package.json"
import { isNewerKodaVersion, KODA_VERSION, newerKodaRelease } from "./koda-release"

test("uses the current desktop release version", () => {
  expect(KODA_VERSION).toBe(pkg.version)
})

test("compares release titles numerically", () => {
  expect(newerKodaRelease({ name: "Koda v1.0.0" }, "1.0.0")).toBeUndefined()
  expect(newerKodaRelease({ name: "Koda v0.9.9" }, "1.0.0")).toBeUndefined()
  expect(newerKodaRelease({ name: "Koda v1.0.1" }, "1.0.0")).toBe("1.0.1")
  expect(newerKodaRelease({ name: "Koda v1.10.0" }, "1.9.0")).toBe("1.10.0")
  expect(() => newerKodaRelease({ name: "Koda" })).toThrow()
})

test("compares valid semantic versions including prereleases and build metadata", () => {
  expect(isNewerKodaVersion("1.0.7", "1.0.6")).toBe(true)
  expect(isNewerKodaVersion("1.0.6", "1.0.6")).toBe(false)
  expect(isNewerKodaVersion("1.0.5", "1.0.6")).toBe(false)
  expect(isNewerKodaVersion("1.0.7-beta.1", "1.0.6")).toBe(true)
  expect(isNewerKodaVersion("1.0.6-beta.1", "1.0.6")).toBe(false)
  expect(isNewerKodaVersion("1.0.6", "1.0.6-beta.1")).toBe(true)
  expect(isNewerKodaVersion("1.0.6+new", "1.0.6+old")).toBe(false)
  expect(isNewerKodaVersion("1.0.6-", "1.0.5")).toBe(false)
  expect(isNewerKodaVersion("invalid", "1.0.6")).toBe(false)
  expect(isNewerKodaVersion("1.0.7", "invalid")).toBe(false)
})
