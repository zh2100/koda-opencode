import type { InstanceContext } from "@/project/instance-context"

type Disposer = {
  run: (directory: string, owner?: InstanceContext) => Promise<void>
  owned: boolean
}
const disposers = new Set<Disposer>()
const releases = new WeakMap<InstanceContext, Map<Disposer, Promise<void>>>()

export function registerDisposer(disposer: Disposer["run"], options?: { owned: boolean }) {
  const entry = { run: disposer, owned: options?.owned ?? false }
  disposers.add(entry)
  return () => {
    disposers.delete(entry)
  }
}

export async function disposeInstance(directory: string, owner?: InstanceContext, ownedOnly = false) {
  const tasks = owner ? (releases.get(owner) ?? new Map<Disposer, Promise<void>>()) : undefined
  if (owner && tasks) releases.set(owner, tasks)
  const results = await Promise.allSettled(
    [...disposers].filter((entry) => !ownedOnly || entry.owned).map((entry) => {
      const previous = tasks?.get(entry)
      if (previous) return previous
      // Capture synchronous throws independently, and retain the actual close task.
      const task = Promise.resolve().then(() => entry.run(directory, owner))
      tasks?.set(entry, task)
      return task
    }),
  )
  const failed = results.filter((result) => result.status === "rejected")
  if (failed.length) throw new AggregateError(failed.map((result) => result.reason), "Instance resource cleanup failed")
}
