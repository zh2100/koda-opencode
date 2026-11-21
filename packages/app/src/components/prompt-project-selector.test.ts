import { describe, expect, test } from "bun:test"
import { submenuOpenKey } from "./prompt-project-selector"

describe("prompt project submenu keyboard navigation", () => {
  test("opens forward in LTR", () => {
    expect(submenuOpenKey("ltr")).toBe("ArrowRight")
  })

  test("opens forward in RTL", () => {
    expect(submenuOpenKey("rtl")).toBe("ArrowLeft")
  })
})
