import { describe, expect, test } from "bun:test"
import { createEffect, createRoot, createSignal } from "solid-js"
import { MutationObserver, QueryClient } from "@tanstack/solid-query"
import { bindRefreshResume, createConfigSaveGate, createRefreshQueue } from "./queue"
import { directoryKey } from "./utils"

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("createRefreshQueue", () => {
  test("clears queued directories by normalized key", async () => {
    const calls: string[] = []
    const queue = createRefreshQueue({
      paused: () => false,
      key: directoryKey,
      bootstrap: async () => {},
      bootstrapInstance: (directory) => {
        calls.push(directory)
      },
    })

    queue.push("C:\\tmp\\demo")
    queue.clear("C:/tmp/demo")

    await tick()

    expect(calls).toEqual([])
    queue.dispose()
  })

  test("passes the original directory to bootstrapInstance", async () => {
    const calls: string[] = []
    const queue = createRefreshQueue({
      paused: () => false,
      key: directoryKey,
      bootstrap: async () => {},
      bootstrapInstance: (directory) => {
        calls.push(directory)
      },
    })

    queue.push("C:\\tmp\\demo")

    await tick()

    expect(calls).toEqual(["C:\\tmp\\demo"])
    queue.dispose()
  })

  test("resumes work queued while paused without another event", async () => {
    const calls: string[] = []
    let paused = true
    const queue = createRefreshQueue({
      paused: () => paused,
      bootstrap: async () => {},
      bootstrapInstance: (directory) => {
        calls.push(directory)
      },
    })

    queue.push("demo")
    await tick()
    expect(calls).toEqual([])
    paused = false
    queue.resume()
    await tick()
    expect(calls).toEqual(["demo"])
    queue.dispose()
  })
})

describe("config save refresh resume", () => {
  test("resumes directory and global refresh after a real mutation succeeds", async () => {
    const result = await runSave({
      update: () => Promise.resolve({ ok: true }),
    })
    expect(result.pendingAtSettled).toBe(true)
    expect(result.directories).toEqual(["/project"])
    expect(result.roots).toBe(1)
  })

  test("resumes queued refresh after a real mutation fails", async () => {
    const result = await runSave({
      update: () => Promise.reject(new Error("save failed")),
    })
    expect(result.pendingAtSettled).toBe(true)
    expect(result.directories).toEqual(["/project"])
    expect(result.roots).toBe(1)
  })

  test("stays paused until the last concurrent save leaves pending", async () => {
    let releaseFirst: (value: { ok: boolean }) => void = () => undefined
    let releaseSecond: (value: { ok: boolean }) => void = () => undefined
    const first = new Promise<{ ok: boolean }>((resolve) => {
      releaseFirst = resolve
    })
    const second = new Promise<{ ok: boolean }>((resolve) => {
      releaseSecond = resolve
    })
    const updates = [first, second]
    const result = await runSave({
      update: () => updates.shift() ?? Promise.resolve({ ok: true }),
      concurrent: true,
      release: () => {
        releaseFirst({ ok: true })
        return releaseSecond
      },
    })
    expect(result.pendingAtSettled).toBe(true)
    expect(result.directories).toEqual(["/project"])
    expect(result.roots).toBe(1)
  })

  test("keeps the queue paused when a later save finishes before an earlier one", async () => {
    let releaseFirst: (value: { ok: boolean }) => void = () => undefined
    let releaseSecond: (value: { ok: boolean }) => void = () => undefined
    const first = new Promise<{ ok: boolean }>((resolve) => {
      releaseFirst = resolve
    })
    const second = new Promise<{ ok: boolean }>((resolve) => {
      releaseSecond = resolve
    })
    const updates = [first, second]
    const directories: string[] = []
    const client = new QueryClient()
    const gate = createConfigSaveGate()
    const queue = createRefreshQueue({
      paused: () => gate.count() > 0,
      bootstrap: async () => {},
      bootstrapInstance: (directory) => {
        directories.push(directory)
      },
    })
    const binding = bindRefreshResume({
      saves: gate.count,
      resume: () => queue.resume(),
      observe: (run) => gate.subscribe(run),
    })
    const observer = new MutationObserver(client, {
      mutationFn: () => updates.shift() ?? Promise.resolve({ ok: true }),
      onMutate: () => gate.begin(),
    })
    const pending = [
      observer.mutate(undefined).finally(() => gate.finish()),
      observer.mutate(undefined).finally(() => gate.finish()),
    ]
    queue.push("/project")
    releaseSecond({ ok: true })
    await pending[1]
    await tick()
    expect(directories).toEqual([])
    releaseFirst({ ok: true })
    await pending[0]
    await tick()
    expect(directories).toEqual(["/project"])
    binding.dispose()
    queue.dispose()
    client.clear()
  })

  test("keeps the queue paused when one concurrent save fails and another is still pending", async () => {
    let releaseFirst: (error: Error) => void = () => undefined
    let releaseSecond: (value: { ok: boolean }) => void = () => undefined
    const first = new Promise<{ ok: boolean }>((_resolve, reject) => {
      releaseFirst = reject
    })
    const second = new Promise<{ ok: boolean }>((resolve) => {
      releaseSecond = resolve
    })
    const updates = [first, second]
    const directories: string[] = []
    const client = new QueryClient()
    const gate = createConfigSaveGate()
    const queue = createRefreshQueue({
      paused: () => gate.count() > 0,
      bootstrap: async () => {},
      bootstrapInstance: (directory) => {
        directories.push(directory)
      },
    })
    const binding = bindRefreshResume({
      saves: gate.count,
      resume: () => queue.resume(),
      observe: (run) => gate.subscribe(run),
    })
    const observer = new MutationObserver(client, {
      mutationFn: () => updates.shift() ?? Promise.resolve({ ok: true }),
      onMutate: () => gate.begin(),
    })
    const pending = [
      observer.mutate(undefined).finally(() => gate.finish()),
      observer.mutate(undefined).finally(() => gate.finish()),
    ]
    queue.push("/project")
    releaseFirst(new Error("save failed"))
    await pending[0]?.catch(() => undefined)
    await tick()
    expect(directories).toEqual([])
    releaseSecond({ ok: true })
    await pending[1]?.catch(() => undefined)
    await tick()
    expect(directories).toEqual(["/project"])
    binding.dispose()
    queue.dispose()
    client.clear()
  })

  test("resumes from a Solid effect when the save signal leaves pending", async () => {
    const directories: string[] = []
    let roots = 0
    const [saves, setSaves] = createSignal(1)
    const queue = createRefreshQueue({
      paused: () => saves() > 0,
      bootstrap: async () => {
        roots += 1
      },
      bootstrapInstance: (directory) => {
        directories.push(directory)
      },
    })
    const dispose = createRoot((stop) => {
      bindRefreshResume({
        saves,
        resume: () => queue.resume(),
        observe: (run) => {
          createEffect(run)
          return stop
        },
      })
      return stop
    })
    queue.push("/project")
    queue.refresh()
    await tick()
    expect(directories).toEqual([])
    expect(roots).toBe(0)
    setSaves(0)
    await new Promise((resolve) => setTimeout(resolve, 0))
    await tick()
    expect(directories).toEqual(["/project"])
    expect(roots).toBe(1)
    dispose()
    queue.dispose()
  })

  test("keeps a second server queue paused while another server is saving", async () => {
    const directories: string[] = []
    const other = createRefreshQueue({
      paused: () => false,
      bootstrap: async () => {},
      bootstrapInstance: (directory) => {
        directories.push(directory)
      },
    })
    const result = await runSave({
      update: () => Promise.resolve({ ok: true }),
      sibling: other,
    })
    await tick()
    expect(result.directories).toEqual(["/project"])
    expect(directories).toEqual(["/other"])
    other.dispose()
  })
})

async function runSave(input: {
  update: () => Promise<{ ok: boolean }>
  concurrent?: boolean
  release?: () => (value: { ok: boolean }) => void
  sibling?: ReturnType<typeof createRefreshQueue>
}) {
  const client = new QueryClient()
  const gate = createConfigSaveGate()
  let pendingAtSettled = false
  const directories: string[] = []
  let roots = 0
  const queue = createRefreshQueue({
    paused: () => gate.count() > 0,
    bootstrap: async () => {
      roots += 1
    },
    bootstrapInstance: (directory) => {
      directories.push(directory)
    },
  })
  const binding = bindRefreshResume({
    saves: gate.count,
    resume: () => queue.resume(),
    observe: (run) => gate.subscribe(run),
  })
  const observer = new MutationObserver(client, {
    mutationFn: input.update,
    onMutate: () => {
      gate.begin()
    },
    onSettled: () => {
      pendingAtSettled = observer.getCurrentResult().isPending
    },
  })
  const tracked = () => observer.mutate(undefined).finally(() => gate.finish())
  const pending = [tracked()]
  if (input.concurrent) pending.push(tracked())
  queue.push("/project")
  queue.refresh()
  input.sibling?.push("/other")
  if (input.release) {
    await tick()
    expect(directories).toEqual([])
    const finishSecond = input.release()
    await pending[0]?.catch(() => undefined)
    await tick()
    expect(directories).toEqual([])
    finishSecond({ ok: true })
  }
  await Promise.all(pending.map((item) => item.catch(() => undefined)))
  await tick()
  binding.dispose()
  queue.dispose()
  client.clear()
  return { pendingAtSettled, directories, roots }
}
