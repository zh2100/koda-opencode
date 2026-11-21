export type ShutdownState = {
  phase: "accepting" | "quiescing" | "disposing" | "closed" | "failed"
  actualClosed: boolean
  rawDisposeStarted: boolean
  timedOut: boolean
  error?: unknown
}

/** Observation timeout never settles or interrupts the actual close operation. */
export function makeShutdown(quiesce: () => Promise<void>, dispose: () => Promise<void>, budgetMs = 10_000) {
  const state: ShutdownState = { phase: "accepting", actualClosed: false, rawDisposeStarted: false, timedOut: false }
  let actual: Promise<void> | undefined
  let observed: Promise<void> | undefined
  return {
    state,
    dispose() {
      if (observed) return observed
      state.phase = "quiescing"
      let quiescing: Promise<void>
      try { quiescing = Promise.resolve(quiesce()) }
      catch (error) { quiescing = Promise.reject(error) }
      actual = quiescing.then(() => {
        state.phase = "disposing"
        state.rawDisposeStarted = true
        return dispose()
      }).then(() => {
        state.phase = "closed"
        state.actualClosed = true
      }, (error) => {
        state.phase = "failed"
        state.error = error
        throw error
      })
      observed = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          state.timedOut = true
          reject(new Error("Runtime shutdown is incomplete"))
        }, budgetMs)
        void actual!.then(() => { clearTimeout(timeout); resolve() }, (error) => { clearTimeout(timeout); reject(error) })
      })
      return observed
    },
  }
}
export * as RuntimeShutdown from "./runtime-shutdown"
