import { expect, test } from "bun:test"
import { createStreamRecovery } from "./server-stream-recovery"

test("reads immediately without a business event and retains ready notifications during reads", async () => {
  const first = Promise.withResolvers<void>()
  const second = Promise.withResolvers<void>()
  let calls = 0
  const recovery = createStreamRecovery(() => (++calls === 1 ? first.promise : second.promise), 1)
  recovery.request()
  expect(calls).toBe(1)
  recovery.request()
  recovery.request()
  first.resolve()
  await Bun.sleep(10)
  expect(calls).toBe(2)
  recovery.dispose()
  second.resolve()
  await Bun.sleep(0)
  recovery.request()
  expect(calls).toBe(2)
})

test("failed reads retry without further events and disposal stops retries", async () => {
  let calls = 0
  const done = Promise.withResolvers<void>()
  const recovery = createStreamRecovery(async () => {
    calls++
    if (calls === 1) throw new Error("offline")
    done.resolve()
  }, 1)
  recovery.request()
  await done.promise
  recovery.dispose()
  expect(calls).toBe(2)
})

test("coalesces reconnect storms even when read-only requests succeed", async () => {
  let calls = 0
  const recovery = createStreamRecovery(async () => { calls++ }, 20)
  recovery.request()
  await Bun.sleep(0)
  Array.from({ length: 50 }, () => recovery.request())
  expect(calls).toBe(1)
  await Bun.sleep(40)
  expect(calls).toBe(2)
  recovery.dispose()
})
