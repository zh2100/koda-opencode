import { describe, expect, test } from "bun:test"
import { releaseNotesDelta } from "./dialog-release-notes"

describe("release notes keyboard navigation", () => {
  test("uses physical left and right arrows for LTR", () => {
    expect(releaseNotesDelta("ArrowLeft", "ltr")).toBe(-1)
    expect(releaseNotesDelta("ArrowRight", "ltr")).toBe(1)
  })

  test("keeps previous and next controls on their logical sides in RTL", () => {
    expect(releaseNotesDelta("ArrowRight", "rtl")).toBe(-1)
    expect(releaseNotesDelta("ArrowLeft", "rtl")).toBe(1)
  })

  test("ignores unrelated keys", () => {
    expect(releaseNotesDelta("ArrowDown", "rtl")).toBe(0)
  })
})
