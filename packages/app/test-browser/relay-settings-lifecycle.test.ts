import { createFixtureState } from "./relay-settings-fixture"
import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createRelaySettingsState } from "../src/hooks/use-relay-settings"

const vendor = (id: string) => ({
  id,
  name: id,
  builtin: true,
  hasKey: true,
  revision: 1,
  updatedAt: 0,
})
const custom = { ...vendor("custom-review"), builtin: false, baseURL: "https://review.example/v1" }
const auth = (revision = 1, vendors = [vendor("chatgpt"), vendor("claude")]) => ({
  revision,
  vendors,
})
const candidate = (vendorId = "chatgpt", modelId = "gpt") => ({ vendorId, modelId, name: modelId, missing: false })
const managed = (vendorId = "chatgpt", visible = true, modelId = "gpt") => ({ vendorId, modelId, visible })
const gate = <T>() => {
  let resolve: (value: T) => void = () => undefined
  let reject: (error: Error) => void = () => undefined
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve: (value: T) => resolve(value), reject: (error: Error) => reject(error) }
}
const waitFor = async (ready: () => boolean) => {
  const deadline = Date.now() + 1000
  while (!ready() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 0))
  expect(ready()).toBe(true)
}
const withState = (
  api: Record<string, unknown>,
  run: (state: ReturnType<typeof createRelaySettingsState>) => Promise<void>,
) =>
  createRoot(async (dispose) => {
    const state = createFixtureState(() => ({
      scope: "lifecycle-test",
      generatedApi: {
        "server.relay": {
          get: () => Promise.resolve(auth()),
          vendor: () => Promise.resolve(auth()),
          refresh: () => Promise.resolve([]),
          candidates: () => Promise.resolve([candidate()]),
          managed: () => Promise.resolve([managed()]),
          ...api,
        },
      },
    }))
    try {
      await waitFor(() => !state.resource.loading)
      await run(state)
    } finally {
      dispose()
    }
  })

test("H01 rejects the old identity while a same-URL replacement is still refilling", async () => {
  for (const outcome of ["success", "failure"] as const) {
    const visibility = gate<ReturnType<typeof managed>[]>()
    const refill = gate<ReturnType<typeof candidate>[]>()
    let refreshes = 0
    let rebuilt = false
    await withState(
      {
        get: () => Promise.resolve(auth(1, [custom])),
        delete: () => Promise.resolve(auth(2, [])),
        vendor: () => {
          rebuilt = true
          return Promise.resolve(auth(3, [custom]))
        },
        candidates: () => Promise.resolve([candidate(custom.id, rebuilt ? "new" : "old")]),
        managed: () => Promise.resolve([managed(custom.id, false, rebuilt ? "new" : "old")]),
        visibility: () => visibility.promise,
        refresh: () => {
          refreshes += 1
          return refill.promise
        },
      },
      async (state) => {
        const changing = state.setVisible(custom.id, "old", true)
        await waitFor(() => state.store.auth?.revision === 1)
        await state.deleteVendor(state.vendors()[0]!)
        state.setStore({ addName: custom.id, addURL: custom.baseURL, addKey: "fake-new-key" })
        const adding = state.addVendor().catch(() => undefined)
        await waitFor(() => refreshes === 1)
        visibility.resolve([managed(custom.id, true, "old")])
        await changing
        expect(state.store.managed).toEqual([])
        if (outcome === "failure") refill.reject(new Error("UPSTREAM_UNREACHABLE"))
        if (outcome === "success") refill.resolve([])
        await adding
        expect(state.isVisible(custom.id, "old")).toBe(false)
        expect(state.visibleCount(custom.id)).toBe(0)
      },
    )
  }
})

test("H01 rejects a visibility response after the URL changes away and back", async () => {
  const visibility = gate<ReturnType<typeof managed>[]>()
  let revision = 1
  let writes = 0
  await withState(
    {
      get: () => Promise.resolve(auth(1, [custom])),
      vendor: (input: { baseURL: string }) => {
        writes += 1
        return Promise.resolve(auth(++revision, [{ ...custom, baseURL: input.baseURL }]))
      },
      visibility: () => visibility.promise,
      candidates: () => Promise.resolve([candidate(custom.id)]),
      managed: () => Promise.resolve([managed(custom.id, false)]),
    },
    async (state) => {
      const changing = state.setVisible(custom.id, "gpt", true)
      await Promise.resolve()
      state.setDraft(custom.id, "baseURL", "https://other.example/v1")
      await state.saveVendor(state.vendors()[0]!, false)
      state.setDraft(custom.id, "baseURL", custom.baseURL)
      await state.saveVendor(state.vendors()[0]!, false)
      visibility.resolve([managed(custom.id)])
      await changing
      expect(writes).toBe(2)
      expect(state.store.managed).toEqual([])
    },
  )
})

test("H02 accepts a committed visibility change after a read returned its previous value", async () => {
  for (const requested of [true, false]) {
    const visibility = gate<ReturnType<typeof managed>[]>()
    let persisted = !requested
    let sent = false
    await withState(
      {
        managed: () => Promise.resolve([managed("chatgpt", persisted)]),
        visibility: () => {
          sent = true
          return visibility.promise
        },
      },
      async (state) => {
        const changing = state.setVisible("chatgpt", "gpt", requested)
        await waitFor(() => sent)
        await state.reload()
        expect(state.isVisible("chatgpt", "gpt")).toBe(!requested)
        persisted = requested
        visibility.resolve([managed("chatgpt", persisted)])
        await changing
        expect(state.isVisible("chatgpt", "gpt")).toBe(persisted)
        expect(state.visibleCount("chatgpt")).toBe(requested ? 1 : 0)
      },
    )
  }
})

test("H02 accepts visibility confirmation after the initial managed read finishes", async () => {
  const initial = gate<ReturnType<typeof managed>[]>()
  const visibility = gate<ReturnType<typeof managed>[]>()
  let state: ReturnType<typeof createRelaySettingsState> | undefined
  let sent = false
  await createRoot(async (dispose) => {
    try {
      state = createFixtureState(() => ({
        scope: "initial-read",
        generatedApi: {
          "server.relay": {
            get: () => Promise.resolve(auth()),
            candidates: () => Promise.resolve([candidate()]),
            managed: () => initial.promise,
            visibility: () => {
              sent = true
              return visibility.promise
            },
          },
        },
      }))
      await waitFor(() => state!.store.candidates.length === 1)
      const changing = state.setVisible("chatgpt", "gpt", true)
      await waitFor(() => sent)
      initial.resolve([managed("chatgpt", false)])
      await waitFor(() => !state!.resource.loading)
      visibility.resolve([managed()])
      await changing
      expect(state.isVisible("chatgpt", "gpt")).toBe(true)
    } finally {
      initial.resolve([])
      visibility.resolve([])
      dispose()
    }
  })
})

test("H02 keeps consecutive visibility commands in order across an intervening read", async () => {
  const first = gate<ReturnType<typeof managed>[]>()
  const second = gate<ReturnType<typeof managed>[]>()
  let calls = 0
  await withState(
    {
      managed: () => Promise.resolve([managed("chatgpt", false)]),
      visibility: () => (++calls === 1 ? first.promise : second.promise),
    },
    async (state) => {
      const checking = state.setVisible("chatgpt", "gpt", true)
      const unchecking = state.setVisible("chatgpt", "gpt", false)
      await waitFor(() => calls === 1)
      await state.reload()
      first.resolve([managed()])
      await checking
      expect(state.isVisible("chatgpt", "gpt")).toBe(true)
      await waitFor(() => calls === 2)
      second.resolve([managed("chatgpt", false)])
      await unchecking
      expect(state.isVisible("chatgpt", "gpt")).toBe(false)
    },
  )
})

test("H03 keeps A's managed refill when B changes visibility during the read", async () => {
  for (const target of ["chatgpt", "claude"]) {
    for (const failVisibility of [false, true]) {
      const other = target === "chatgpt" ? "claude" : "chatgpt"
      const refill = gate<ReturnType<typeof managed>[]>()
      let reads = 0
      await withState(
        {
          vendor: () => Promise.resolve(auth(2)),
          candidates: (input?: { vendorId?: string }) =>
            Promise.resolve(input?.vendorId ? [candidate(target)] : [candidate(target), candidate(other)]),
          managed: () => (++reads === 2 ? refill.promise : Promise.resolve([managed(target), managed(other)])),
          visibility: () =>
            failVisibility
              ? Promise.reject(new Error("UPSTREAM_UNREACHABLE"))
              : Promise.resolve([managed(target), managed(other, false)]),
        },
        async (state) => {
          state.setDraft(target, "key", "fake-replacement")
          const saving = state.saveVendor(state.vendors().find((item) => item.id === target)!)
          await waitFor(() => reads === 2)
          await state.setVisible(other, "gpt", false).catch(() => undefined)
          refill.resolve([managed(target), managed(other, false)])
          await saving
          expect(state.isVisible(target, "gpt")).toBe(true)
          expect(state.visibleCount(target)).toBe(1)
          expect(state.isVisible(other, "gpt")).toBe(failVisibility)
        },
      )
    }
  }
})

test("H04 replaces the result of a previous successful connection test", async () => {
  for (const counts of [
    [1, 0],
    [0, 1],
  ]) {
    let calls = 0
    await withState({ probe: () => Promise.resolve({ count: counts[calls++]! }) }, async (state) => {
      await state.probe("chatgpt")
      const result = await state.probe("chatgpt")
      expect(state.store.status.chatgpt).toBe(result)
      expect(result).toBe(counts[1] ? "connected" : "empty")
      expect(state.isBusy("testing", "chatgpt")).toBe(false)
    })
  }
})

test("H04 ignores an older successful probe after the latest probe completed", async () => {
  const older = gate<{ count: number }>()
  let calls = 0
  await withState({ probe: () => (++calls === 1 ? older.promise : Promise.resolve({ count: 0 })) }, async (state) => {
    const first = state.probe("chatgpt")
    await waitFor(() => calls === 1)
    await state.probe("chatgpt")
    older.resolve({ count: 1 })
    await first
    expect(state.store.status.chatgpt).toBe("empty")
    expect(state.isBusy("testing", "chatgpt")).toBe(false)
  })
})

test("H04 gives status ownership to the newest probe or model refresh", async () => {
  for (const latest of ["probe", "refresh"] as const) {
    const probe = gate<{ count: number }>()
    const refresh = gate<ReturnType<typeof candidate>[]>()
    let probes = 0
    let refreshes = 0
    await withState(
      {
        probe: () => {
          probes += 1
          return probe.promise
        },
        refresh: () => {
          refreshes += 1
          return refresh.promise
        },
        candidates: (input?: { vendorId?: string }) => Promise.resolve(input?.vendorId ? [] : [candidate()]),
      },
      async (state) => {
        const older = latest === "probe" ? state.fetchModels("chatgpt") : state.probe("chatgpt")
        await waitFor(() => (latest === "probe" ? refreshes : probes) === 1)
        const newer = latest === "probe" ? state.probe("chatgpt") : state.fetchModels("chatgpt")
        await waitFor(() => probes === 1 && refreshes === 1)
        if (latest === "probe") probe.resolve({ count: 1 })
        if (latest === "refresh") refresh.resolve([])
        await newer
        const expected = latest === "probe" ? "connected" : "empty"
        expect(state.store.status.chatgpt).toBe(expected)
        if (latest === "probe") refresh.resolve([])
        if (latest === "refresh") probe.resolve({ count: 1 })
        await older
        expect(state.store.status.chatgpt).toBe(expected)
        expect(state.isBusy("testing", "chatgpt")).toBe(false)
        expect(state.isBusy("fetching", "chatgpt")).toBe(false)
      },
    )
  }
})

test("H01 does not send a queued checkbox command to a replacement identity", async () => {
  const first = gate<ReturnType<typeof managed>[]>()
  let calls = 0
  await withState(
    {
      get: () => Promise.resolve(auth(1, [custom])),
      delete: () => Promise.resolve(auth(2, [])),
      vendor: () => Promise.resolve(auth(3, [custom])),
      candidates: () => Promise.resolve([candidate(custom.id)]),
      managed: () => Promise.resolve([]),
      visibility: () => {
        calls += 1
        return first.promise
      },
    },
    async (state) => {
      const checking = state.setVisible(custom.id, "gpt", true)
      await waitFor(() => calls === 1)
      const queued = state.setVisible(custom.id, "gpt", false)
      await state.deleteVendor(state.vendors()[0]!)
      state.setStore({ addName: custom.id, addURL: custom.baseURL, addKey: "fake-new-key" })
      await state.addVendor()
      first.resolve([managed(custom.id)])
      await Promise.all([checking, queued])
      expect(calls).toBe(1)
      expect(state.store.managed).toEqual([])
    },
  )
})

test("H02 preserves sibling model data from an intervening read", async () => {
  const visibility = gate<ReturnType<typeof managed>[]>()
  let reloaded = false
  let sent = false
  await withState(
    {
      candidates: () => Promise.resolve([candidate(), candidate("chatgpt", "sibling")]),
      managed: () => Promise.resolve([managed("chatgpt", false), managed("chatgpt", reloaded, "sibling")]),
      visibility: () => {
        sent = true
        return visibility.promise
      },
    },
    async (state) => {
      const checking = state.setVisible("chatgpt", "gpt", true)
      await waitFor(() => sent)
      reloaded = true
      await state.reload()
      expect(state.isVisible("chatgpt", "sibling")).toBe(true)
      visibility.resolve([managed(), managed("chatgpt", false, "sibling")])
      await checking
      expect(state.isVisible("chatgpt", "gpt")).toBe(true)
      expect(state.isVisible("chatgpt", "sibling")).toBe(true)
    },
  )
})

test("H03 refills sibling preferences when visibility completes before the original refill", async () => {
  const refill = gate<ReturnType<typeof managed>[]>()
  let reads = 0
  await withState(
    {
      vendor: () => Promise.resolve(auth(2)),
      candidates: () => Promise.resolve([candidate(), candidate("chatgpt", "sibling")]),
      managed: () =>
        ++reads === 2 ? refill.promise : Promise.resolve([managed(), managed("chatgpt", true, "sibling")]),
      visibility: () => Promise.resolve([managed("chatgpt", false), managed("chatgpt", true, "sibling")]),
    },
    async (state) => {
      state.setDraft("chatgpt", "key", "fake-replacement")
      const saving = state.saveVendor(state.vendors()[0]!)
      await waitFor(() => reads === 2)
      await state.setVisible("chatgpt", "gpt", false)
      refill.resolve([managed(), managed("chatgpt", false, "sibling")])
      await saving
      expect(state.isVisible("chatgpt", "gpt")).toBe(false)
      expect(state.isVisible("chatgpt", "sibling")).toBe(true)
    },
  )
})
