import { expect, test } from "bun:test"
import { newerKodaRelease } from "./koda-release"

test("compares release titles numerically", () => {
  expect(newerKodaRelease({ name: "Koda v1.0.0" })).toBeUndefined()
  expect(newerKodaRelease({ name: "Koda v0.9.9" })).toBeUndefined()
  expect(newerKodaRelease({ name: "Koda v1.0.1" })).toBe("1.0.1")
  expect(newerKodaRelease({ name: "Koda v1.10.0" }, "1.9.0")).toBe("1.10.0")
  expect(() => newerKodaRelease({ name: "Koda" })).toThrow()
})
