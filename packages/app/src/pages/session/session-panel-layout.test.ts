import { describe, expect, test } from "bun:test"
import {
  relayRightWidth,
  relayWorkspaceLayout,
  RELAY_RIGHT_WIDTH_DEFAULT,
  sessionPanelLayout,
} from "./session-panel-layout"

describe("sessionPanelLayout", () => {
  test("keeps one V2 owner while changing panel geometry", () => {
    expect(sessionPanelLayout({ review: false, terminal: false, files: false })).toEqual({
      visible: false,
      stacked: false,
    })
    expect(sessionPanelLayout({ review: false, terminal: true, files: false })).toEqual({
      visible: true,
      stacked: false,
    })
    expect(sessionPanelLayout({ review: true, terminal: true, files: false })).toEqual({
      visible: true,
      stacked: true,
    })
  })
})

describe("relayWorkspaceLayout", () => {
  test("uses overlays below 700px", () => {
    expect(relayWorkspaceLayout(699)).toEqual({ left: "overlay", right: "overlay" })
  })

  test("uses a right drawer below 960px", () => {
    expect(relayWorkspaceLayout(800)).toEqual({ left: "rail", right: "drawer" })
    expect(relayWorkspaceLayout(959)).toEqual({ left: "rail", right: "drawer" })
  })

  test("docks the right panel at 960px and above", () => {
    expect(relayWorkspaceLayout(960)).toEqual({ left: "rail", right: "dock" })
    expect(relayWorkspaceLayout(1280)).toEqual({ left: "rail", right: "dock" })
    expect(relayWorkspaceLayout(1440)).toEqual({ left: "rail", right: "dock" })
  })
})

describe("relayRightWidth", () => {
  test("falls back to the default below the minimum", () => {
    expect(relayRightWidth(200)).toBe(RELAY_RIGHT_WIDTH_DEFAULT)
  })

  test("clamps to the allowed range", () => {
    expect(relayRightWidth(280)).toBe(280)
    expect(relayRightWidth(400)).toBe(400)
    expect(relayRightWidth(600)).toBe(480)
  })
})
