import { describe, expect, test } from "bun:test"
import { DateTime } from "effect"
import { ScheduledTaskStore } from "@opencode-ai/core/scheduled-task"

describe("ScheduledTaskStore.nextDaily", () => {
  test("maps a spring-forward gap to the later wall-clock time", () => {
    const start = DateTime.makeZonedUnsafe(
      { year: 2025, month: 3, day: 8, hour: 2, minute: 30 },
      { timeZone: "America/New_York", adjustForTimeZone: true },
    )
    const next = ScheduledTaskStore.nextDaily(DateTime.toUtc(start), "America/New_York")
    const parts = DateTime.toParts(DateTime.setZone(next, DateTime.zoneMakeNamedUnsafe("America/New_York")))
    expect(parts.month).toBe(3)
    expect(parts.day).toBe(9)
    expect(parts.hour).toBe(3)
    expect(parts.minute).toBe(30)
  })

  test("keeps the earlier occurrence across a fall-back overlap", () => {
    const start = DateTime.makeZonedUnsafe(
      { year: 2025, month: 11, day: 1, hour: 1, minute: 30 },
      { timeZone: "America/New_York", adjustForTimeZone: true },
    )
    const next = ScheduledTaskStore.nextDaily(DateTime.toUtc(start), "America/New_York")
    const parts = DateTime.toParts(DateTime.setZone(next, DateTime.zoneMakeNamedUnsafe("America/New_York")))
    expect(parts.month).toBe(11)
    expect(parts.day).toBe(2)
    expect(parts.hour).toBe(1)
    expect(parts.minute).toBe(30)
  })
})

describe("ScheduledTaskStore.dueSlots", () => {
  test("marks a once task missed after 24 hours", () => {
    const runAt = DateTime.makeUnsafe(1_704_067_200_000)
    const now = DateTime.makeUnsafe(1_704_067_200_000 + 86_400_000 + 1)
    const slots = ScheduledTaskStore.dueSlots({ schedule: "once", timezone: "UTC", runAt, nextRun: runAt }, now)
    expect(slots).toHaveLength(1)
    expect(slots[0]?.missed).toBe(true)
  })

  test("catches up only the latest daily slot after a long sleep", () => {
    const runAt = DateTime.makeUnsafe(1_704_067_200_000)
    const now = DateTime.makeUnsafe(1_704_067_200_000 + 86_400_000 * 3)
    const slots = ScheduledTaskStore.dueSlots({ schedule: "daily", timezone: "UTC", runAt, nextRun: runAt }, now)
    expect(slots.length).toBeGreaterThan(1)
    expect(slots.slice(0, -1).every((slot) => slot.missed)).toBe(true)
    expect(slots.at(-1)?.missed).toBe(false)
  })
})
