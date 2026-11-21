import { expect, test } from "bun:test"
import { runLockWorker, verifyLockWorker } from "../support/verify-lock-worker"

test("stage 0 dangerous lock scenarios run in a hard-isolated worker", async () => {
  for (const scenario of ["t07a", "t10"] as const) {
    await verifyLockWorker(scenario)
  }
}, 120000)

test("T10 reports a failed conflict assertion without inventing a protocol error", async () => {
  const result = await runLockWorker("t10", "invert-conflict")
  expect(result.classification).toBe("business-failure")
  expect(result.errors.protocol).toBeUndefined()
  expect(result.exit?.exitCode).toBe(1)
  expect(result.events.at(-1)).toMatchObject({ name: "result", ok: false, outcome: "product-failure", error: "T10 save did not produce a conflict error" })
  expect(result.cleanupStatus).toBe("removed")
}, 30000)

test("T07a timeout distinguishes the request from confirmed termination", async () => {
  const result = await runLockWorker("t07a", "pause-before-interrupt")
  expect(result.classification).toBe("scenario-timeout")
  expect(result.timeoutStage).toBe("scenario")
  expect(result.events.map((event) => event.name)).toEqual(["holding", "wait", "interrupt-requested"])
  expect(result.errors.primary).toContain("last confirmed: interrupt-requested; not confirmed: saving-terminated; cause unknown")
  expect(result.cleanupStatus).toBe("removed")
}, 30000)
