type QueueInput = {
  paused: () => boolean
  bootstrap: () => Promise<void>
  bootstrapInstance: (directory: string) => Promise<void> | void
  key?: (directory: string) => string
}

export function bindRefreshResume(input: {
  saves: () => number
  resume: () => void
  observe: (run: () => void) => () => void
}) {
  let previous = input.saves()
  const check = () => {
    const current = input.saves()
    if (previous > 0 && current === 0) input.resume()
    previous = current
  }
  const stop = input.observe(check)
  check()
  return { dispose: stop }
}

export function createConfigSaveGate() {
  let count = 0
  const listeners = new Set<() => void>()
  const emit = () => {
    for (const listener of listeners) listener()
  }
  return {
    count: () => count,
    begin() {
      count += 1
      emit()
    },
    finish() {
      count = Math.max(0, count - 1)
      emit()
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export function createRefreshQueue(input: QueueInput) {
  const queued = new Map<string, string>()
  let root = false
  let running = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const key = input.key ?? ((directory: string) => directory)

  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

  const take = (count: number) => {
    if (queued.size === 0) return [] as string[]
    const items: string[] = []
    for (const [id, directory] of queued) {
      queued.delete(id)
      items.push(directory)
      if (items.length >= count) break
    }
    return items
  }

  const schedule = () => {
    if (timer) return
    timer = setTimeout(() => {
      timer = undefined
      void drain()
    }, 0)
  }

  const push = (directory: string) => {
    if (!directory) return
    queued.set(key(directory), directory)
    if (input.paused()) return
    schedule()
  }

  const refresh = () => {
    root = true
    if (input.paused()) return
    schedule()
  }

  async function drain() {
    if (running) return
    running = true
    try {
      while (true) {
        if (input.paused()) return
        if (root) {
          root = false
          await input.bootstrap()
          await tick()
          continue
        }
        const dirs = take(2)
        if (dirs.length === 0) return
        await Promise.all(dirs.map((dir) => input.bootstrapInstance(dir)))
        await tick()
      }
    } finally {
      running = false
      // oxlint-disable-next-line no-unsafe-finally -- intentional: early return skips schedule() when paused
      if (input.paused()) return
      if (root || queued.size) schedule()
    }
  }

  return {
    push,
    refresh,
    resume() {
      if (input.paused()) return
      if (!root && queued.size === 0) return
      if (running) return
      void drain()
    },
    clear(directory: string) {
      queued.delete(key(directory))
    },
    dispose() {
      if (!timer) return
      clearTimeout(timer)
      timer = undefined
    },
  }
}
