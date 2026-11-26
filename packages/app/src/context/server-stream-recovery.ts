/** Coalesce loss and ready notifications without dropping a ready notification during a read. */
export function createStreamRecovery(read: () => Promise<unknown>, delay = 1_000) {
  let pending = false
  let running = false
  let disposed = false
  let failures = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const run = async () => {
    if (disposed || running) return
    running = true
    while (pending && !disposed) {
      pending = false
      const success = await read().then(
        () => true,
        () => false,
      )
      if (success) {
        failures = 0
        // Loss notifications can repeat on every reconnect attempt even when GET succeeds.
        timer = setTimeout(() => {
          timer = undefined
          if (pending) void run()
        }, delay)
        break
      }
      pending = true
      timer = setTimeout(
        () => {
          timer = undefined
          void run()
        },
        Math.min(30_000, delay * 2 ** Math.min(failures++, 5)),
      )
      break
    }
    running = false
  }
  return {
    request() {
      if (disposed) return
      pending = true
      if (!timer) void run()
    },
    dispose() {
      disposed = true
      if (timer) clearTimeout(timer)
    },
  }
}
