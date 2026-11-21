// Observation may time out before fetch settles. Only transport settlement releases a slot.
export const relayRefreshBudgets = Object.freeze({ queue: 30_000, request: 30_000, action: 90_000 })
export type RelayRefreshRuntime = {
  now: () => number
  after: (milliseconds: number, callback: () => void) => () => void
  budgets: { readonly queue: number; readonly request: number; readonly action: number }
}
const runtime: RelayRefreshRuntime = {
  now: () => performance.now(),
  after: (milliseconds, callback) => {
    const timer = setTimeout(callback, milliseconds)
    return () => clearTimeout(timer)
  },
  budgets: relayRefreshBudgets,
}
export function createRelayRefreshLane(clock: RelayRefreshRuntime = runtime) {
  let closed = false
  let occupied = 0
  let queued: { start: () => void; cancel: () => void } | undefined
  const observers = new Set<AbortController>()
  const wake = () => {
    if (closed || occupied >= 2 || !queued) return
    const next = queued
    queued = undefined
    next.start()
  }
  const request = <T>(job: (signal: AbortSignal) => Promise<T>, deadline: number) =>
    new Promise<T>((resolve, reject) => {
      if (closed) return reject(new Error("REQUEST_CONFLICT"))
      const controller = new AbortController()
      observers.add(controller)
      let observed = true
      let cancelTimer = () => {}
      const finish = (result: { value: T } | { error: unknown }) => {
        if (!observed) return
        observed = false
        cancelTimer()
        observers.delete(controller)
        controller.signal.removeEventListener("abort", aborted)
        if (queued === waiting) queued = undefined
        if ("error" in result) reject(result.error)
        else resolve(result.value)
      }
      const aborted = () => finish({ error: controller.signal.reason ?? new Error("REQUEST_CONFLICT") })
      controller.signal.addEventListener("abort", aborted, { once: true })
      const expire = (duration: number) => {
        cancelTimer()
        const remaining = Math.min(duration, deadline - clock.now())
        if (remaining <= 0) {
          controller.abort(new Error("UPSTREAM_TIMEOUT"))
          return false
        }
        cancelTimer = clock.after(remaining, () => controller.abort(new Error("UPSTREAM_TIMEOUT")))
        return true
      }
      const waiting = {
        start: () => {
          if (!observed || !expire(clock.budgets.request)) return
          occupied++
          // Keep the completion observer even if cancellation ended local observation.
          Promise.resolve()
            .then(() => {
              if (controller.signal.aborted) throw controller.signal.reason
              return job(controller.signal)
            })
            .then(
              (value) => finish({ value }),
              (error: unknown) => finish({ error }),
            )
            .finally(() => {
              occupied--
              wake()
            })
        },
        cancel: () => controller.abort(new Error("REQUEST_CONFLICT")),
      }
      if (occupied < 2) {
        waiting.start()
        return
      }
      queued?.cancel()
      queued = waiting
      expire(clock.budgets.queue)
    })
  return {
    request,
    deadline: () => clock.now() + clock.budgets.action,
    cancel: () => {
      queued?.cancel()
      queued = undefined
      for (const controller of observers) controller.abort(new Error("REQUEST_CONFLICT"))
    },
    close: () => {
      closed = true
      queued?.cancel()
      queued = undefined
      for (const controller of observers) controller.abort(new Error("REQUEST_CONFLICT"))
    },
  }
}
