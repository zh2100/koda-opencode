import { describe, expect, test } from "bun:test"
import { joinProjectPath, projectNameInvalid } from "./project-path"

describe("project-path", () => {
  test("joins unix and windows parents", () => {
    expect(joinProjectPath("/home/luke/Projects", "demo")).toBe("/home/luke/Projects/demo")
    expect(joinProjectPath("D:\\Projects\\", "demo")).toBe("D:\\Projects\\demo")
  })

  test("rejects empty and illegal names", () => {
    expect(projectNameInvalid("")).toBe("name")
    expect(projectNameInvalid("  ")).toBe("name")
    expect(projectNameInvalid("a/b")).toBe("invalid")
    expect(projectNameInvalid("ok")).toBeUndefined()
  })
})
