import assert from "node:assert/strict"
import { ConfigRefresh } from "@/config/refresh"
import { InstanceWork } from "@/effect/instance-work"
import type { InstanceContext } from "@/project/instance-context"
import type { Project } from "@/project/project"
const ctx = (): InstanceContext => ({
  directory: crypto.randomUUID(),
  worktree: "/test",
  project: { id: "global" } as Project.Info,
})
const mode = process.argv[2]
if (mode === "recovery") {
  const delays: number[] = [],
    manager = ConfigRefresh.make({
      delay: async (ms) => {
        delays.push(ms)
      },
    }),
    owner = ctx()
  let retry = 0,
    plain = 0,
    successful = 0,
    broken = true
  const steps = [
    {
      id: {},
      retryable: true,
      run: async () => {
        successful++
      },
    },
    {
      id: {},
      retryable: true,
      run: async () => {
        retry++
        if (broken) throw Error("PRIVATE-REFRESH")
      },
    },
    {
      id: {},
      retryable: false,
      run: async () => {
        plain++
        throw Error("PRIVATE-REFRESH")
      },
    },
  ]
  await assert.rejects(manager.reserve(owner, steps).start(), /refresh remains incomplete/)
  assert.equal(retry, 2)
  assert.equal(plain, 1)
  assert.equal(successful, 1)
  assert.deepEqual(delays, [250])
  assert.equal(manager.diagnostics().failed.length, 2)
  assert.equal(InstanceWork.handoffDiagnostics().active, 0)
  broken = false
  await manager.reserve(ctx(), [steps[1]!]).start()
  assert.equal(manager.diagnostics().failed.length, 2)
  await manager.reserve(owner, [steps[1]!]).start()
  assert.equal(manager.diagnostics().failed.length, 1)
  await manager.reserve(owner, [{ ...steps[2]!, run: async () => {} }]).start()
  assert.equal(manager.diagnostics().failed.length, 1)
  assert.equal(InstanceWork.handoffDiagnostics().unrecovered, 1)
  assert.equal(successful, 1)
  assert.equal(plain, 1)
  const bounded = ConfigRefresh.make({ limit: 1 }),
    reservation = bounded.reserve(owner, [steps[0]!])
  assert.throws(
    () => bounded.reserve(ctx(), [steps[0]!]),
    (e: unknown) =>
      typeof e === "object" && e !== null && "code" in e && e.code === "CONFIG_REFRESH_CAPACITY_EXHAUSTED",
  )
  assert.throws(() => bounded.reserve(owner, [steps[0]!]))
  reservation.release()
  await bounded.reserve(ctx(), [steps[0]!]).start()
  assert.equal(bounded.diagnostics().pending, 0)
  const recovered = ConfigRefresh.make({ delay: async () => {} }),
    retryOwner = ctx(),
    id = {}
  await recovered
    .reserve(retryOwner, [
      {
        id,
        retryable: true,
        run: async () => {
          throw Error("PRIVATE-REFRESH")
        },
      },
    ])
    .start()
    .catch(() => {})
  const previous = InstanceWork.handoffDiagnostics().unrecovered
  await recovered.reserve(retryOwner, [{ id, retryable: true, run: async () => {} }]).start()
  assert.equal(recovered.diagnostics().pending, 0)
  assert.equal(InstanceWork.handoffDiagnostics().unrecovered, previous - 1)
} else if (mode === "close-backoff" || mode === "close-running") {
  const waiting = Promise.withResolvers<void>(),
    running = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<void>()
  const manager = ConfigRefresh.make({
      delay: async () => {
        waiting.resolve()
        await new Promise<void>(() => {})
      },
    }),
    owner = ctx(),
    other = ctx()
  let calls = 0,
    ended = false
  const first = manager
    .reserve(owner, [
      {
        id: {},
        retryable: true,
        run: async () => {
          calls++
          if (mode === "close-running") {
            running.resolve()
            await finish.promise
          }
          throw Error("PRIVATE-REFRESH")
        },
      },
    ])
    .start()
    .catch(() => {})
  const second =
    mode === "close-backoff"
      ? manager
          .reserve(other, [
            {
              id: {},
              retryable: false,
              run: async () => {
                running.resolve()
                await finish.promise
                ended = true
              },
            },
          ])
          .start()
      : Promise.resolve()
  await (mode === "close-backoff" ? waiting.promise : running.promise)
  await running.promise
  let closed = false
  const close = InstanceWork.drainAll().then(
    () => {
      closed = true
    },
    () => {
      closed = true
    },
  )
  assert.equal(closed, false)
  if (mode === "close-backoff") {
    await first
    assert.equal(ended, false)
    assert.equal(closed, false)
  }
  finish.resolve()
  await Promise.all([first, second, close])
  assert.equal(calls, 1)
  assert.equal(closed, true)
  assert.equal(InstanceWork.handoffDiagnostics().active, 0)
  assert.equal(InstanceWork.handoffDiagnostics().unrecovered, 1)
  assert.equal(manager.diagnostics().failed.length, 1)
} else if (mode === "early-recovery") {
  const responsibility = {}
  await InstanceWork.handoff(
    async () => {
      InstanceWork.recoverHandoff(responsibility)
      throw Error("PRIVATE-REFRESH")
    },
    "project",
    responsibility,
  ).catch(() => {})
  assert.equal(InstanceWork.handoffDiagnostics().unrecovered, 0)
  assert.equal(InstanceWork.handoffDiagnostics().historicalFailures, 1)
  await InstanceWork.drainAll()
} else throw Error("Unknown test scenario")
assert.equal(JSON.stringify(InstanceWork.handoffDiagnostics()).includes("PRIVATE-REFRESH"), false)
console.log(JSON.stringify({ mode, ok: true }))
