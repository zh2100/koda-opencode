import { describe, expect, test } from "bun:test"
import { sessionIdleSessionID } from "./notification"

describe("sessionIdleSessionID", () => {
  test("recognizes the canonical idle status event", () => {
    expect(
      sessionIdleSessionID({
        type: "session.status",
        properties: { sessionID: "ses_1", status: { type: "idle" } },
      }),
    ).toBe("ses_1")
  })

  test("keeps compatibility with the deprecated idle event", () => {
    expect(sessionIdleSessionID({ type: "session.idle", properties: { sessionID: "ses_1" } })).toBe("ses_1")
  })

  test("does not treat busy status as completion", () => {
    expect(
      sessionIdleSessionID({
        type: "session.status",
        properties: { sessionID: "ses_1", status: { type: "busy" } },
      }),
    ).toBeUndefined()
  })
})
