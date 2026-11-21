import { expect, test } from "bun:test"
import { createRelayRefreshLane, relayRefreshBudgets } from "../src/hooks/relay-refresh"
import { make } from "../../client/src/generated/client"

const gate = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
export const clock = () => {
  let now = 0
  let sequence = 0
  const timers = new Map<number, { due: number; callback: () => void }>()
  return {
    now: () => now,
    budgets: { queue: 30, request: 30, action: 90 },
    after: (duration: number, callback: () => void) => {
      const id = ++sequence
      timers.set(id, { due: now + duration, callback })
      return () => {
        timers.delete(id)
      }
    },
    advance: (duration: number) => {
      now += duration
      for (const [id, timer] of [...timers]) {
        if (timer.due > now) continue
        timers.delete(id)
        timer.callback()
      }
    },
    timers: () => timers.size,
  }
}

test("O17/O18 observation timeout does not release either uncooperative transport slot", async () => {
  expect(relayRefreshBudgets).toEqual({ queue: 30_000, request: 30_000, action: 90_000 })
  const time = clock()
  const lane = createRelayRefreshLane(time)
  const first = gate<void>()
  const second = gate<void>()
  const started = gate<void>()
  let sends = 0
  const job = (signal: AbortSignal) => {
    expect(signal.aborted).toBe(false)
    sends++
    if (sends === 2) started.resolve()
    return sends === 1 ? first.promise : second.promise
  }
  const a = lane.request(job, lane.deadline()).catch((error: Error) => error.message)
  const b = lane.request(job, lane.deadline()).catch((error: Error) => error.message)
  await started.promise
  time.advance(5)
  const c = lane.request(job, lane.deadline()).catch((error: Error) => error.message)
  time.advance(25)
  expect(await a).toBe("UPSTREAM_TIMEOUT")
  expect(await b).toBe("UPSTREAM_TIMEOUT")
  expect(sends).toBe(2)
  time.advance(5)
  expect(await c).toBe("UPSTREAM_TIMEOUT")
  expect(sends).toBe(2)
  const completed = gate<void>()
  const d = lane.request(async () => {
    sends++
    completed.resolve()
  }, lane.deadline())
  first.resolve()
  await completed.promise
  await d
  expect(sends).toBe(3)
  second.resolve()
  lane.close()
  expect(time.timers()).toBe(0)
})

test("O17/O20 a settled cancelled transport wakes only the newest queued request", async () => {
  const time = clock()
  const lane = createRelayRefreshLane(time)
  const holding = [gate<void>(), gate<void>()]
  const entered = gate<void>()
  let sent = 0
  const running = holding.map((item) =>
    lane
      .request(async () => {
        if (++sent === 2) entered.resolve()
        await item.promise
      }, lane.deadline())
      .catch(() => undefined),
  )
  await entered.promise
  const superseded = lane
    .request(async () => {
      throw new Error("must not send")
    }, lane.deadline())
    .catch((error: Error) => error.message)
  const newest = gate<void>()
  const pending = lane.request(async () => {
    newest.resolve()
  }, lane.deadline())
  expect(await superseded).toBe("REQUEST_CONFLICT")
  holding[0]!.resolve()
  await newest.promise
  await pending
  holding[1]!.resolve()
  await Promise.all(running)
  lane.close()
  expect(time.timers()).toBe(0)
})

test("O19 a follow-up HTTP retains the original absolute action deadline", async () => {
  const time = clock()
  const lane = createRelayRefreshLane(time)
  const deadline = lane.deadline()
  time.advance(80)
  const entered = gate<void>()
  const late = gate<void>()
  const pending = lane
    .request(async () => {
      entered.resolve()
      await late.promise
    }, deadline)
    .catch((error: Error) => error.message)
  await entered.promise
  time.advance(10)
  expect(await pending).toBe("UPSTREAM_TIMEOUT")
  late.resolve()
  lane.close()
  expect(time.timers()).toBe(0)
})

test("O19 actual SDK fetch keeps its signal and deadline through a hanging TCP body", async () => {
  const time = clock()
  const lane = createRelayRefreshLane(time)
  const bodyRead = gate<void>()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"auth":'))
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
  })
  const api = make({
    baseUrl: server.url.href,
    fetch: Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const response = await fetch(input, init)
        expect(init?.signal).toBeInstanceOf(AbortSignal)
        const text = response.text.bind(response)
        response.text = () => {
          bodyRead.resolve()
          return text()
        }
        return response
      },
      { preconnect: fetch.preconnect },
    ),
  })["server.relay"]
  try {
    const pending = lane
      .request((signal) => api.sync({}, { signal }), lane.deadline())
      .catch((error: Error) => error.message)
    await bodyRead.promise
    time.advance(30)
    expect(await pending).toBe("UPSTREAM_TIMEOUT")
    expect(time.timers()).toBe(0)
  } finally {
    lane.close()
    await server.stop(true)
  }
})

for (const finish of ["resolve", "reject"] as const)
  test(`O20 disposed owner consumes a late ${finish} without observation or timer leaks`, async () => {
    const time = clock()
    const lane = createRelayRefreshLane(time)
    const entered = gate<void>()
    const completed = gate<void>()
    const pending = lane
      .request(async () => {
        entered.resolve()
        await completed.promise
        if (finish === "reject") throw new Error("late transport failure")
        return "late"
      }, lane.deadline())
      .catch((error: Error) => error.message)
    await entered.promise
    lane.close()
    expect(await pending).toBe("REQUEST_CONFLICT")
    expect(time.timers()).toBe(0)
    completed.resolve()
  })
