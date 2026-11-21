import { createFixtureState } from "./relay-settings-fixture"
import { expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createRelaySettingsState } from "../src/hooks/use-relay-settings"

type Auth = {
  vendors: Array<{
    id: string
    name: string
    builtin: boolean
    hasKey: boolean
    revision: number
    updatedAt: number
    baseURL?: string
  }>
  revision: number
}

const vendor = {
  id: "chatgpt",
  name: "ChatGPT",
  builtin: true,
  hasKey: false,
  revision: 0,
  updatedAt: 0,
}

const auth = (revision: number, hasKey: boolean, id = "chatgpt"): Auth => ({
  vendors: [{ ...vendor, id, hasKey, revision }],
  revision,
})

const candidate = (vendorId: string, modelId: string) => ({
  vendorId,
  modelId,
  name: modelId,
  missing: false,
})

const managed = (vendorId: string, modelId: string, visible: boolean) => ({
  vendorId,
  modelId,
  visible,
})

const gate = <T>() => {
  let release: (value: T) => void = () => undefined
  const promise = new Promise<T>((resolve) => {
    release = resolve
  })
  return { promise, release: (value: T) => release(value) }
}

const emptyCatalog = {
  candidates: () => Promise.resolve([]),
  managed: () => Promise.resolve([]),
}

const stateWith = (api: Record<string, unknown>, scope = "server-a") =>
  createFixtureState(() => ({
    scope,
    generatedApi: { "server.relay": { ...emptyCatalog, ...api } },
  }))

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

test("U01 keeps a saved revision when an older read finishes later", async () => {
  const pending = gate<Auth>()
  const ready = gate<Auth>()
  const calls: string[] = []
  let gets = 0
  const state = stateWith({
    get: () => {
      calls.push("get")
      gets += 1
      return gets === 1 ? pending.promise : ready.promise
    },
    vendor: () => {
      calls.push("vendor")
      return Promise.resolve(auth(1, true))
    },
  })
  const loading = Promise.resolve(state.resource.latest)
  const saving = state.saveVendor(vendor)
  ready.release(auth(0, false))
  await saving
  pending.release(auth(0, false))
  await loading.catch(() => undefined)
  expect(state.store.auth?.revision).toBe(1)
  expect(state.store.auth?.vendors[0]?.hasKey).toBe(true)
  expect(calls).toContain("vendor")
})

test("U02 ignores an older read that finishes after a newer read", async () => {
  const gates = [gate<Auth>(), gate<Auth>()]
  let gets = 0
  const state = stateWith({
    get: () => {
      const current = gates[gets] ?? gate<Auth>()
      gets += 1
      return current.promise
    },
  })
  const first = Promise.resolve(state.resource.latest)
  const second = state.load()
  gates[1]?.release(auth(2, true))
  await second
  gates[0]?.release(auth(1, false))
  await first
  expect(state.store.auth?.revision).toBe(2)
  expect(state.store.auth?.vendors[0]?.hasKey).toBe(true)
})

test("R01 loads the current server on open and the next server when scope changes", async () => {
  const scopes: string[] = []
  let current = "server-a"
  const setScope = { current: (_value: string) => undefined as void }
  await createRoot(async (dispose) => {
    const [scope, update] = createSignal(current)
    setScope.current = update
    const pending = gate<Auth>()
    const state = createFixtureState(() => ({
      scope: scope(),
      generatedApi: {
        "server.relay": {
          ...emptyCatalog,
          get: () => {
            scopes.push(scope())
            return scope() === "server-a" ? pending.promise : Promise.resolve(auth(4, true, "claude"))
          },
        },
      },
    }))
    await settle()
    expect(scopes).toEqual(["server-a"])
    current = "server-b"
    update("server-b")
    await settle()
    await settle()
    pending.release(auth(1, false))
    await settle()
    expect(scopes).toEqual(["server-a", "server-b"])
    expect(state.store.auth?.vendors[0]?.id).toBe("claude")
    dispose()
  })
  expect(setScope.current).toBeFunction()
})

test("U03 loads the new server and ignores the old server response", async () => {
  let current = "server-a"
  const scopes: string[] = []
  const pending = gate<Auth>()
  const state = createFixtureState(() => ({
    scope: current,
    generatedApi: {
      "server.relay": {
        get: () => {
          scopes.push(current)
          return current === "server-a" ? pending.promise : Promise.resolve(auth(4, true, "claude"))
        },
        candidates: () =>
          Promise.resolve(current === "server-b" ? [candidate("claude", "opus")] : [candidate("chatgpt", "gpt")]),
        managed: () => Promise.resolve(current === "server-b" ? [managed("claude", "opus", true)] : []),
      },
    },
  }))
  const first = Promise.resolve(state.resource.latest)
  current = "server-b"
  await state.reload()
  pending.release(auth(1, false))
  await first.catch(() => undefined)
  expect(scopes).toContain("server-b")
  expect(state.store.auth?.vendors[0]?.id).toBe("claude")
  expect(state.store.candidates[0]?.vendorId).toBe("claude")
  expect(state.store.managed[0]?.vendorId).toBe("claude")
})

test("U04 rejects the first generation after returning to the same server", async () => {
  let current = "server-a"
  let gets = 0
  const firstA = gate<Auth>()
  const state = createFixtureState(() => ({
    scope: current,
    generatedApi: {
      "server.relay": {
        get: () => {
          gets += 1
          if (gets === 1) return firstA.promise
          return Promise.resolve(auth(current === "server-b" ? 1 : 3, true))
        },
        candidates: () => Promise.resolve([]),
        managed: () => Promise.resolve([]),
      },
    },
  }))
  const original = Promise.resolve(state.resource.latest)
  await settle()
  expect(gets).toBe(1)
  current = "server-b"
  await state.reload()
  current = "server-a"
  await state.reload()
  firstA.release(auth(9, false))
  await original.catch(() => undefined)
  expect(state.store.auth?.revision).toBe(3)
})

test("U05 keeps a newer busy state when an older request fails later", async () => {
  let rejectOlder: (error: Error) => void = () => undefined
  const older = new Promise<{ count: number }>((_resolve, reject) => {
    rejectOlder = reject
  })
  const newer = gate<{ count: number }>()
  let probes = 0
  const state = stateWith({
    get: () => Promise.resolve(auth(1, true)),
    candidates: () => Promise.resolve([]),
    managed: () => Promise.resolve([]),
    vendor: () => Promise.resolve(auth(1, true)),
    probe: () => {
      probes += 1
      return probes === 1 ? older : newer.promise
    },
  })
  await state.load()
  const first = state.probe("chatgpt")
  await waitFor(() => probes === 1)
  const second = state.probe("chatgpt")
  expect(state.isBusy("testing", "chatgpt")).toBe(true)
  newer.release({ count: 0 })
  await second
  expect(state.isBusy("testing", "chatgpt")).toBe(false)
  expect(state.store.status.chatgpt).toBe("empty")
  rejectOlder(new Error("UPSTREAM_UNREACHABLE"))
  await first.catch(() => undefined)
  expect(state.isBusy("testing", "chatgpt")).toBe(false)
  expect(state.store.status.chatgpt).toBe("empty")
  expect(state.store.error).toBeUndefined()
})

test("U06 keeps independent save follow-ups on the captured server", async () => {
  let current = "server-a"
  const saving = gate<Auth>()
  const calls: string[] = []
  const apis = Object.fromEntries(
    ["server-a", "server-b"].map((id) => [
      id,
      {
        get: () => Promise.resolve(auth(1, true)),
        candidates: () => {
          calls.push(`candidates:${id}`)
          return Promise.resolve([])
        },
        managed: () => {
          calls.push(`managed:${id}`)
          return Promise.resolve([])
        },
        vendor: () => {
          calls.push(`vendor:${id}`)
          return saving.promise
        },
      },
    ]),
  )
  const state = createFixtureState(() => ({ scope: current, generatedApi: { "server.relay": apis[current] } }))
  await state.load()
  calls.length = 0
  state.setDraft("chatgpt", "key", "independent-key")
  const request = state.saveVendor(state.vendors()[0])
  await settle()
  current = "server-b"
  state.resetScope()
  saving.release(auth(2, true))
  await request
  expect(calls).toEqual(["vendor:server-a"])
  expect(state.store.auth).toBeUndefined()
})

test("U07 keeps a key typed while save is in flight", async () => {
  const vendorCall = gate<Auth>()
  const submitted: string[] = []
  const state = stateWith({
    get: () => Promise.resolve(auth(1, false)),
    candidates: () => Promise.resolve([]),
    managed: () => Promise.resolve([]),
    vendor: (input: { key?: string }) => {
      submitted.push(input.key ?? "")
      return vendorCall.promise
    },
  })
  await state.load()
  state.setDraft("chatgpt", "key", "old-secret")
  const saving = state.saveVendor(state.vendors()[0])
  state.setDraft("chatgpt", "key", "new-secret")
  vendorCall.release(auth(2, true))
  await Promise.resolve()
  expect(state.store.drafts.chatgpt?.key).toBe("new-secret")
  await saving.catch(() => undefined)
  expect(submitted).toEqual(["old-secret"])
  expect(state.store.drafts.chatgpt?.key).toBe("new-secret")
})

test("U08 keeps a visibility write that finishes before an older managed read", async () => {
  const managedRead = gate<ReturnType<typeof managed>[]>()
  let reads = 0
  const state = stateWith({
    get: () => Promise.resolve(auth(1, true)),
    candidates: () => Promise.resolve([candidate("chatgpt", "gpt")]),
    managed: () => {
      reads += 1
      return reads === 1 ? Promise.resolve([]) : managedRead.promise
    },
    visibility: () => Promise.resolve([managed("chatgpt", "gpt", true)]),
  })
  await state.load()
  const refresh = state.load()
  await state.setVisible("chatgpt", "gpt", true)
  managedRead.release([managed("chatgpt", "gpt", false)])
  await refresh
  expect(state.store.managed.find((item) => item.modelId === "gpt")?.visible).toBe(true)
})

test("U09 keeps both vendor refreshes when they finish out of order", async () => {
  const gates = new Map<string, ReturnType<typeof gate<ReturnType<typeof candidate>[]>>>()
  const both = (revision: number) => ({
    ...auth(revision, true),
    vendors: [...auth(revision, true).vendors, ...auth(revision, true, "claude").vendors],
  })
  const state = stateWith({
    get: () => Promise.resolve(both(1)),
    candidates: (input?: { vendorId?: string }) => {
      if (!input?.vendorId) return Promise.resolve([])
      const current = gate<ReturnType<typeof candidate>[]>()
      gates.set(input.vendorId, current)
      return current.promise
    },
    managed: () => Promise.resolve([]),
    refresh: () => Promise.resolve([]),
    vendor: () => Promise.resolve(both(2)),
  })
  await state.load()
  state.setDraft("chatgpt", "key", "one")
  state.setDraft("claude", "key", "two")
  const first = state.saveVendor({ ...vendor, id: "chatgpt" })
  const second = state.saveVendor({ ...vendor, id: "claude", name: "Claude" })
  const started = Date.now()
  while ((!gates.has("chatgpt") || !gates.has("claude")) && Date.now() - started < 1000) {
    await Promise.resolve()
  }
  expect(gates.has("chatgpt")).toBe(true)
  expect(gates.has("claude")).toBe(true)
  gates.get("claude")?.release([candidate("claude", "opus")])
  await second
  expect(state.store.candidates.map((item) => item.vendorId)).toEqual(["claude"])
  gates.get("chatgpt")?.release([candidate("chatgpt", "gpt")])
  await first
  expect(state.store.candidates.map((item) => item.vendorId).sort()).toEqual(["chatgpt", "claude"])
})

test("U10 ignores responses after dispose", async () => {
  const pending = gate<Auth>()
  const calls: string[] = []
  const state = stateWith({
    get: () => pending.promise,
    candidates: () => {
      calls.push("candidates")
      return Promise.resolve([candidate("chatgpt", "gpt")])
    },
    managed: () => Promise.resolve([]),
  })
  const loading = Promise.resolve(state.resource.latest)
  state.dispose()
  pending.release(auth(1, true))
  await loading.catch(() => undefined)
  expect(state.store.auth).toBeUndefined()
  expect(calls).not.toContain("candidates")
})

test("U11 removes drafts when the server scope changes and keeps them on reload", async () => {
  let current = "server-a"
  const state = createFixtureState(() => ({
    scope: current,
    generatedApi: {
      "server.relay": {
        get: () => Promise.resolve(auth(1, true)),
        candidates: () => Promise.resolve([]),
        managed: () => Promise.resolve([]),
      },
    },
  }))
  await state.load()
  state.setDraft("chatgpt", "key", "typed")
  state.setStore("status", "chatgpt", "connected")
  await state.reload()
  expect(state.store.drafts.chatgpt?.key).toBe("typed")
  expect(state.store.status.chatgpt).toBe("connected")
  current = "server-b"
  await state.reload()
  expect(state.store.drafts.chatgpt).toBeUndefined()
  expect(state.store.status.chatgpt).toBeUndefined()
})

test("R03 keeps a refresh for a vendor that was not invalidated", async () => {
  const calls: string[] = []
  const state = stateWith({
    get: () => Promise.resolve(auth(1, true)),
    vendor: () => Promise.resolve(auth(1, true)),
    refresh: () => {
      calls.push("refresh")
      return Promise.resolve([])
    },
    candidates: (input?: { vendorId?: string }) => {
      calls.push(input?.vendorId ? "vendor-candidates" : "all-candidates")
      return Promise.resolve(input?.vendorId ? [candidate(input.vendorId, "gpt")] : [])
    },
    managed: () => Promise.resolve([managed("chatgpt", "gpt", true)]),
  })
  await state.load()
  await state.fetchModels("chatgpt")
  expect(calls).toContain("refresh")
  expect(state.store.candidates.map((item) => item.modelId)).toEqual(["gpt"])
  expect(state.store.status.chatgpt).toBe("connected")
})

test("R04 restores managed visibility after a key save", async () => {
  const state = stateWith({
    get: () => Promise.resolve(auth(1, true)),
    vendor: () => Promise.resolve(auth(2, true)),
    refresh: () => Promise.resolve([]),
    candidates: (input?: { vendorId?: string }) =>
      Promise.resolve(input?.vendorId ? [candidate(input.vendorId, "gpt")] : [candidate("chatgpt", "gpt")]),
    managed: (input?: { vendorId?: string }) =>
      Promise.resolve(input?.vendorId ? [managed(input.vendorId, "gpt", true)] : [managed("chatgpt", "gpt", true)]),
  })
  await state.load()
  expect(state.visibleCount("chatgpt")).toBe(1)
  state.setDraft("chatgpt", "key", "next-secret")
  await state.saveVendor(state.vendors()[0])
  expect(state.store.candidates).toHaveLength(1)
  expect(state.visibleCount("chatgpt")).toBe(1)
  expect(state.isVisible("chatgpt", "gpt")).toBe(true)
})

test("R02 saving an independent key sends one command and never changes shared mode", async () => {
  const calls: string[] = []
  const state = stateWith({
    get: () => Promise.resolve(auth(1, true)),
    vendor: (input: { operationId: string }) => {
      expect(input.operationId).toBeString()
      calls.push("vendor")
      return Promise.resolve(auth(2, true))
    },
    mode: () => {
      throw new Error("retired shared mode must not be called")
    },
    refresh: () => Promise.resolve([]),
  })
  await state.load()
  state.setDraft("chatgpt", "key", "vendor-secret")
  await state.saveVendor(state.vendors()[0])
  expect(calls).toEqual(["vendor"])
  expect(state.store.auth?.revision).toBe(2)
  expect(state).not.toHaveProperty("saveUnified")
})

const bothVendors = (): Auth => ({
  vendors: [
    { ...vendor, id: "chatgpt", hasKey: true, revision: 1 },
    { ...vendor, id: "claude", name: "Claude", hasKey: true, revision: 1 },
  ],
  revision: 1,
})

const claude = { ...vendor, id: "claude", name: "Claude" }

const waitFor = async (ready: () => boolean) => {
  const started = Date.now()
  while (!ready() && Date.now() - started < 1000) await Promise.resolve()
  expect(ready()).toBe(true)
}

test("F01 keeps vendor A visibility when vendor B visibility is changed after saving A", async () => {
  const state = stateWith({
    get: () => Promise.resolve(bothVendors()),
    vendor: () => Promise.resolve(bothVendors()),
    refresh: () => Promise.resolve([]),
    candidates: () => Promise.resolve([candidate("chatgpt", "gpt"), candidate("claude", "opus")]),
    managed: () => Promise.resolve([managed("chatgpt", "gpt", true), managed("claude", "opus", true)]),
    visibility: () => Promise.resolve([managed("chatgpt", "gpt", true), managed("claude", "opus", false)]),
  })
  await state.load()
  state.setDraft("chatgpt", "key", "next")
  await state.saveVendor(state.vendors()[0])
  expect(state.isVisible("chatgpt", "gpt")).toBe(true)
  await state.setVisible("claude", "opus", false)
  expect(state.isVisible("chatgpt", "gpt")).toBe(true)
  expect(state.visibleCount("chatgpt")).toBe(1)
  expect(state.isVisible("claude", "opus")).toBe(false)
})

test("F01 keeps both vendors when B visibility finishes before or after A's save", async () => {
  const orders = ["visibility-first", "save-first"] as const
  for (const order of orders) {
    const vendorSave = gate<Auth>()
    const visibility = gate<ReturnType<typeof managed>[]>()
    const state = stateWith({
      get: () => Promise.resolve(bothVendors()),
      vendor: () => vendorSave.promise,
      refresh: () => Promise.resolve([]),
      candidates: (input?: { vendorId?: string }) =>
        Promise.resolve(
          input?.vendorId === "chatgpt"
            ? [candidate("chatgpt", "fresh")]
            : [candidate("chatgpt", "gpt"), candidate("claude", "opus")],
        ),
      managed: (input?: { vendorId?: string }) =>
        Promise.resolve(
          input?.vendorId
            ? [managed(input.vendorId, "fresh", true)]
            : [managed("chatgpt", "fresh", true), managed("claude", "opus", true)],
        ),
      visibility: () => visibility.promise,
    })
    await state.load()
    state.setDraft("chatgpt", "key", "next")
    const saving = state.saveVendor(state.vendors()[0])
    const checking = state.setVisible("claude", "opus", false)
    if (order === "visibility-first") {
      visibility.release([managed("chatgpt", "stale", false), managed("claude", "opus", false)])
      await checking
      vendorSave.release(bothVendors())
      await saving
    }
    if (order === "save-first") {
      vendorSave.release(bothVendors())
      await saving
      visibility.release([managed("chatgpt", "fresh", true), managed("claude", "opus", false)])
      await checking
    }
    expect(state.store.candidates.map((item) => item.modelId)).toContain("fresh")
    expect(state.isVisible("chatgpt", "fresh")).toBe(true)
    expect(state.store.managed.some((item) => item.vendorId === "chatgpt" && item.modelId === "gpt")).toBe(false)
    expect(state.visibleCount("chatgpt")).toBe(1)
    expect(state.isVisible("claude", "opus")).toBe(false)
    expect(state.store.managed.map((item) => item.modelId)).not.toContain("stale")
  }
})

test("F01 does not revive a deleted vendor when an older visibility response returns", async () => {
  const visibility = gate<ReturnType<typeof managed>[]>()
  const removed = (): Auth => ({
    ...bothVendors(),
    revision: 2,
    // Deleting chatgpt advances auth.revision, not claude's own revision.
    vendors: [{ ...vendor, id: "claude", name: "Claude", hasKey: true, revision: 1 }],
  })
  const state = stateWith({
    get: () => Promise.resolve(bothVendors()),
    delete: () => Promise.resolve(removed()),
    visibility: () => visibility.promise,
    candidates: () => Promise.resolve([candidate("chatgpt", "gpt"), candidate("claude", "opus")]),
    managed: () => Promise.resolve([managed("chatgpt", "gpt", true), managed("claude", "opus", true)]),
  })
  await state.load()
  const checking = state.setVisible("claude", "opus", false)
  await state.deleteVendor(state.vendors()[0])
  visibility.release([managed("chatgpt", "gpt", true), managed("claude", "opus", false)])
  await checking
  expect(state.store.auth?.vendors.map((item) => item.id)).toEqual(["claude"])
  expect(state.store.managed.map((item) => item.vendorId)).not.toContain("chatgpt")
  expect(state.isVisible("claude", "opus")).toBe(false)
})

test("F01 keeps the second invalidation when the first refill finishes", async () => {
  const reads = [gate<ReturnType<typeof candidate>[]>(), gate<ReturnType<typeof candidate>[]>()]
  let vendorReads = 0
  const state = stateWith({
    get: () => Promise.resolve(auth(1, true)),
    vendor: () => Promise.resolve(auth(2, true)),
    refresh: () => Promise.resolve([]),
    candidates: (input?: { vendorId?: string }) => {
      if (!input?.vendorId) return Promise.resolve([candidate("chatgpt", "old")])
      const current = reads[vendorReads] ?? gate<ReturnType<typeof candidate>[]>()
      vendorReads += 1
      return current.promise
    },
    managed: (input?: { vendorId?: string }) =>
      Promise.resolve([managed("chatgpt", input?.vendorId ? "fresh" : "fresh", true)]),
  })
  await state.load()
  state.setDraft("chatgpt", "key", "first")
  const first = state.saveVendor(state.vendors()[0])
  await waitFor(() => vendorReads === 1)
  state.setDraft("chatgpt", "key", "second")
  const second = state.saveVendor(state.vendors()[0])
  await waitFor(() => vendorReads === 2)
  reads[0]?.release([candidate("chatgpt", "stale")])
  await first
  expect(state.store.candidates.map((item) => item.modelId)).not.toContain("stale")
  reads[1]?.release([candidate("chatgpt", "fresh")])
  await second
  expect(state.store.candidates.map((item) => item.modelId)).toEqual(["fresh"])
  expect(state.isVisible("chatgpt", "fresh")).toBe(true)
})

test("F02 keeps a fresh vendor refresh when an older full read finishes later", async () => {
  const fullCandidates = gate<ReturnType<typeof candidate>[]>()
  const fullManaged = gate<ReturnType<typeof managed>[]>()
  let fullCandidateReads = 0
  let phase: "initial" | "reload-candidates" | "reload-managed" | "vendor" = "initial"
  const state = stateWith({
    get: () => Promise.resolve(bothVendors()),
    vendor: () => Promise.resolve(bothVendors()),
    refresh: () => Promise.resolve([]),
    candidates: (input?: { vendorId?: string }) => {
      if (input?.vendorId === "chatgpt") {
        phase = "vendor"
        return Promise.resolve([candidate("chatgpt", "fresh")])
      }
      fullCandidateReads += 1
      phase = fullCandidateReads === 1 ? "initial" : "reload-candidates"
      if (fullCandidateReads === 1) return Promise.resolve([candidate("chatgpt", "old"), candidate("claude", "opus")])
      return fullCandidates.promise
    },
    managed: () => {
      if (phase === "initial")
        return Promise.resolve([managed("chatgpt", "old", true), managed("claude", "opus", true)])
      if (phase === "vendor") return Promise.resolve([managed("chatgpt", "fresh", true)])
      phase = "reload-managed"
      return fullManaged.promise
    },
  })
  await state.load()
  const reload = state.reload()
  await waitFor(() => phase === "reload-candidates")
  state.setDraft("chatgpt", "key", "next")
  await state.saveVendor(state.vendors()[0])
  expect(state.store.candidates.map((item) => item.modelId)).toContain("fresh")
  fullCandidates.release([candidate("chatgpt", "old"), candidate("claude", "opus")])
  fullManaged.release([managed("chatgpt", "old", true), managed("claude", "opus", true)])
  await reload
  expect(state.store.candidates.map((item) => item.modelId)).toContain("fresh")
  expect(state.store.candidates.map((item) => item.modelId)).not.toContain("old")
  expect(state.store.candidates.map((item) => item.modelId)).toContain("opus")
})

test("F02 keeps a newer full merge when an older vendor read finishes later", async () => {
  const vendorCandidates = gate<ReturnType<typeof candidate>[]>()
  const vendorManaged = gate<ReturnType<typeof managed>[]>()
  let vendorReads = 0
  const state = stateWith({
    get: () => Promise.resolve(bothVendors()),
    vendor: () => Promise.resolve(bothVendors()),
    refresh: () => Promise.resolve([]),
    candidates: (input?: { vendorId?: string }) => {
      if (input?.vendorId !== "chatgpt")
        return Promise.resolve([candidate("chatgpt", "fresh"), candidate("claude", "opus")])
      vendorReads += 1
      return vendorReads === 1 ? vendorCandidates.promise : Promise.resolve([candidate("chatgpt", "fresh")])
    },
    managed: (input?: { vendorId?: string }) => {
      if (!input?.vendorId) return Promise.resolve([managed("chatgpt", "fresh", true), managed("claude", "opus", true)])
      if (vendorReads === 1) return vendorManaged.promise
      return Promise.resolve([managed("chatgpt", "fresh", true)])
    },
  })
  await state.load()
  state.setDraft("chatgpt", "key", "next")
  const saving = state.saveVendor(state.vendors()[0])
  await waitFor(() => vendorReads === 1)
  await state.reload()
  vendorCandidates.release([candidate("chatgpt", "old")])
  vendorManaged.release([managed("chatgpt", "old", false)])
  await saving
  expect(state.store.candidates.map((item) => item.modelId).sort()).toEqual(["fresh", "opus"])
  expect(state.store.candidates.map((item) => item.modelId)).not.toContain("old")
  expect(state.isVisible("chatgpt", "fresh")).toBe(true)
})

test("F02 does not revive a vendor deleted while a full read is pending", async () => {
  const fullCandidates = gate<ReturnType<typeof candidate>[]>()
  const fullManaged = gate<ReturnType<typeof managed>[]>()
  let fullReads = 0
  const removed = (): Auth => ({
    ...bothVendors(),
    revision: 2,
    vendors: [{ ...claude, hasKey: true, revision: 2 }],
  })
  const state = stateWith({
    get: () => Promise.resolve(bothVendors()),
    delete: () => Promise.resolve(removed()),
    candidates: () => {
      fullReads += 1
      return fullReads === 1
        ? Promise.resolve([candidate("chatgpt", "gpt"), candidate("claude", "opus")])
        : fullCandidates.promise
    },
    managed: () =>
      fullReads === 1
        ? Promise.resolve([managed("chatgpt", "gpt", true), managed("claude", "opus", true)])
        : fullManaged.promise,
  })
  await state.load()
  const reload = state.reload()
  await waitFor(() => fullReads === 2)
  await state.deleteVendor(state.vendors()[0])
  fullCandidates.release([candidate("chatgpt", "gpt"), candidate("claude", "opus")])
  fullManaged.release([managed("chatgpt", "gpt", true), managed("claude", "opus", true)])
  await reload
  expect(state.store.auth?.vendors.map((item) => item.id)).toEqual(["claude"])
  expect(state.store.candidates.map((item) => item.vendorId)).toEqual(["claude"])
  expect(state.store.managed.map((item) => item.vendorId)).toEqual(["claude"])
})

test("F02 validates candidates and managed at separate hang points", async () => {
  const heldCandidates = gate<ReturnType<typeof candidate>[]>()
  const heldManaged = gate<ReturnType<typeof managed>[]>()
  let fullCandidateReads = 0
  let fullManagedReads = 0
  const state = stateWith({
    get: () => Promise.resolve(bothVendors()),
    vendor: () => Promise.resolve(bothVendors()),
    refresh: () => Promise.resolve([]),
    candidates: (input?: { vendorId?: string }) => {
      if (input?.vendorId === "chatgpt") return Promise.resolve([candidate("chatgpt", "fresh")])
      fullCandidateReads += 1
      if (fullCandidateReads === 1) return Promise.resolve([candidate("chatgpt", "old"), candidate("claude", "opus")])
      return heldCandidates.promise
    },
    managed: () => {
      fullManagedReads += 1
      if (fullManagedReads === 1)
        return Promise.resolve([managed("chatgpt", "old", true), managed("claude", "opus", true)])
      if (fullManagedReads === 2) return Promise.resolve([managed("chatgpt", "fresh", true)])
      return heldManaged.promise
    },
  })
  await state.load()
  const reload = state.reload()
  await waitFor(() => fullCandidateReads === 2)
  state.setDraft("chatgpt", "key", "next")
  await state.saveVendor(state.vendors()[0])
  heldCandidates.release([candidate("chatgpt", "old"), candidate("claude", "opus")])
  await waitFor(() => fullManagedReads === 3)
  expect(state.store.candidates.map((item) => item.modelId)).toContain("fresh")
  heldManaged.release([managed("chatgpt", "old", false), managed("claude", "opus", true)])
  await reload
  expect(state.store.candidates.map((item) => item.modelId)).toContain("fresh")
  expect(state.isVisible("chatgpt", "fresh")).toBe(true)
  expect(state.store.managed.map((item) => item.modelId)).not.toContain("old")
})

test("F02 keeps both vendor refreshes that overlap a full read", async () => {
  const vendorReads = new Map<string, ReturnType<typeof gate<ReturnType<typeof candidate>[]>>>()
  let fullReads = 0
  const state = stateWith({
    get: () => Promise.resolve(bothVendors()),
    vendor: () => Promise.resolve(bothVendors()),
    refresh: () => Promise.resolve([]),
    candidates: (input?: { vendorId?: string }) => {
      if (!input?.vendorId) {
        fullReads += 1
        return fullReads === 1
          ? Promise.resolve([])
          : new Promise<ReturnType<typeof candidate>[]>((resolve) => {
              setTimeout(() => resolve([candidate("chatgpt", "full-old"), candidate("claude", "full-old")]), 0)
            })
      }
      const current = gate<ReturnType<typeof candidate>[]>()
      vendorReads.set(input.vendorId, current)
      return current.promise
    },
    managed: (input?: { vendorId?: string }) =>
      Promise.resolve(
        input?.vendorId
          ? [managed(input.vendorId, "fresh", true)]
          : [managed("chatgpt", "full-old", true), managed("claude", "full-old", true)],
      ),
  })
  await state.load()
  state.setDraft("chatgpt", "key", "one")
  state.setDraft("claude", "key", "two")
  const first = state.saveVendor(vendor)
  const second = state.saveVendor(claude)
  await waitFor(() => vendorReads.has("chatgpt") && vendorReads.has("claude"))
  const reload = state.reload()
  await waitFor(() => fullReads === 2)
  vendorReads.get("claude")?.release([candidate("claude", "fresh")])
  await second
  vendorReads.get("chatgpt")?.release([candidate("chatgpt", "fresh")])
  await first
  await reload
  expect(state.store.candidates.map((item) => item.modelId).sort()).toEqual(["fresh", "fresh"])
  expect(state.store.candidates.map((item) => item.modelId)).not.toContain("full-old")
})

test("F03 ignores an older read failure after a newer read succeeds", async () => {
  const first = gate<Auth>()
  let rejectFirst: (error: Error) => void = () => undefined
  const rejected = new Promise<Auth>((_resolve, reject) => {
    rejectFirst = reject
  })
  let gets = 0
  const state = stateWith({
    get: () => {
      gets += 1
      return gets === 1 ? rejected : first.promise
    },
  })
  const opened = state.load()
  const reloaded = state.reload()
  first.release(auth(1, true))
  await reloaded
  expect(state.store.error).toBeUndefined()
  rejectFirst(new Error("UPSTREAM_UNREACHABLE"))
  await opened
  expect(state.store.error).toBeUndefined()
  expect(state.store.auth?.revision).toBe(1)
})

test("F03 ignores an older catalog failure after a newer read succeeds", async () => {
  const stages = ["candidates", "managed"] as const
  for (const stage of stages) {
    let rejectOld: (error: Error) => void = () => undefined
    const rejected = new Promise<never>((_resolve, reject) => {
      rejectOld = reject
    })
    let reads = 0
    const state = stateWith({
      get: () => Promise.resolve(auth(1, true)),
      candidates: () => {
        if (stage !== "candidates") return Promise.resolve([candidate("chatgpt", "gpt")])
        reads += 1
        return reads === 1 ? rejected : Promise.resolve([candidate("chatgpt", "gpt")])
      },
      managed: () => {
        if (stage !== "managed") return Promise.resolve([managed("chatgpt", "gpt", true)])
        reads += 1
        return reads === 1 ? rejected : Promise.resolve([managed("chatgpt", "gpt", true)])
      },
    })
    const opened = state.load()
    await waitFor(() => reads === 1)
    await state.reload()
    expect(state.store.error).toBeUndefined()
    rejectOld(new Error("UPSTREAM_UNREACHABLE"))
    await opened
    expect(state.store.error).toBeUndefined()
    expect(state.store.candidates.map((item) => item.modelId)).toEqual(["gpt"])
  }
})

test("F03 keeps a newer read failure when an older read succeeds later", async () => {
  const older = gate<Auth>()
  let gets = 0
  const state = stateWith({
    get: () => {
      gets += 1
      if (gets === 1) return older.promise
      return Promise.reject(new Error("UPSTREAM_UNREACHABLE"))
    },
    candidates: () => Promise.resolve([candidate("chatgpt", "gpt")]),
    managed: () => Promise.resolve([managed("chatgpt", "gpt", true)]),
  })
  const opened = state.load()
  older.release(auth(1, true))
  await opened
  const reloaded = state.reload()
  await reloaded
  expect(state.store.error).toBe("settings.relay.error.UPSTREAM_UNREACHABLE")
  expect(state.store.auth).toBeUndefined()
  expect(state.store.candidates).toEqual([])
})

test("F03 drops errors from a disposed scope and from an older server generation", async () => {
  const pending = gate<Auth>()
  let rejectOld: (error: Error) => void = () => undefined
  const rejected = new Promise<Auth>((_resolve, reject) => {
    rejectOld = reject
  })
  const disposed = stateWith({
    get: () => rejected,
  })
  const opened = disposed.load()
  disposed.dispose()
  rejectOld(new Error("UPSTREAM_UNREACHABLE"))
  await opened
  expect(disposed.store.error).toBeUndefined()

  let current = "server-a"
  const first = gate<Auth>()
  let gets = 0
  const returned = createFixtureState(() => ({
    scope: current,
    generatedApi: {
      "server.relay": {
        ...emptyCatalog,
        get: () => {
          gets += 1
          if (gets === 1) return first.promise
          if (gets === 2) return Promise.reject(new Error("UPSTREAM_UNREACHABLE"))
          return Promise.resolve(auth(3, true))
        },
      },
    },
  }))
  const initial = returned.load()
  current = "server-b"
  const left = returned.reload()
  current = "server-a"
  await returned.reload()
  first.release(auth(1, false))
  await Promise.all([initial, left.catch(() => undefined)])
  expect(returned.store.error).toBeUndefined()
  expect(returned.store.auth?.revision).toBe(3)
})

test("F03 keeps a newer probe success when an older probe fails", async () => {
  let rejectOlder: (error: Error) => void = () => undefined
  const older = new Promise<{ count: number }>((_resolve, reject) => {
    rejectOlder = reject
  })
  const newer = gate<{ count: number }>()
  let probes = 0
  const state = stateWith({
    get: () => Promise.resolve(auth(1, true)),
    vendor: () => Promise.resolve(auth(1, true)),
    probe: () => {
      probes += 1
      return probes === 1 ? older : newer.promise
    },
  })
  await state.load()
  const first = state.probe("chatgpt")
  await waitFor(() => probes === 1)
  const second = state.probe("chatgpt")
  expect(state.isBusy("testing", "chatgpt")).toBe(true)
  newer.release({ count: 1 })
  await second
  expect(state.isBusy("testing", "chatgpt")).toBe(false)
  expect(state.store.status.chatgpt).toBe("connected")
  expect(state.store.error).toBeUndefined()
  rejectOlder(new Error("UPSTREAM_UNREACHABLE"))
  await first.catch(() => undefined)
  expect(state.isBusy("testing", "chatgpt")).toBe(false)
  expect(state.store.status.chatgpt).toBe("connected")
  expect(state.store.error).toBeUndefined()
})

test("U12 reports a conflict without replaying the submitted key", async () => {
  const submitted: string[] = []
  let vendors = 0
  const state = stateWith({
    get: () => Promise.resolve(auth(vendors === 0 ? 1 : 5, true)),
    refresh: () => Promise.resolve([]),
    candidates: () => Promise.resolve([]),
    managed: () => Promise.resolve([]),
    vendor: (input: { key?: string }) => {
      vendors += 1
      submitted.push(input.key ?? "")
      return Promise.reject(new Error("REVISION_CONFLICT"))
    },
  })
  await state.load()
  state.setDraft("chatgpt", "key", "secret")
  await state.saveVendor(state.vendors()[0]).catch(() => undefined)
  expect(state.store.error).toBe("settings.relay.error.REVISION_CONFLICT")
  expect(state.store.auth?.revision).toBe(1)
  expect(submitted).toEqual(["secret"])
  await state.load()
  expect(state.store.auth?.revision).toBe(5)
  expect(submitted).toEqual(["secret"])
})

const customReview = {
  id: "custom-review",
  name: "custom-review",
  builtin: false,
  hasKey: true,
  revision: 1,
  updatedAt: 0,
  baseURL: "https://review.example/v1",
}

const customAuth = (revision = 1, item = customReview): Auth => ({
  vendors: [{ ...item, revision }],
  revision,
})

test("G01 replaces every baseline slice when a full snapshot is empty", async () => {
  let reads = 0
  const state = stateWith({
    get: () => Promise.resolve(auth(1, true)),
    candidates: () => {
      reads += 1
      return Promise.resolve(reads === 1 ? [candidate("chatgpt", "old")] : [])
    },
    managed: () => Promise.resolve(reads === 1 ? [managed("chatgpt", "old", true)] : []),
  })
  await state.load()
  await state.reload()
  expect(state.store.candidates).toEqual([])
  expect(state.store.managed).toEqual([])
  expect(state.visibleCount("chatgpt")).toBe(0)
  expect(state.isVisible("chatgpt", "old")).toBe(false)
})

test("G01 clears only the vendor missing from a full snapshot", async () => {
  const missing = ["chatgpt", "claude"] as const
  for (const absent of missing) {
    let reads = 0
    const present = absent === "chatgpt" ? "claude" : "chatgpt"
    const model = present === "chatgpt" ? "gpt" : "opus"
    const state = stateWith({
      get: () => Promise.resolve(bothVendors()),
      candidates: () => {
        reads += 1
        return Promise.resolve(
          reads === 1 ? [candidate("chatgpt", "gpt"), candidate("claude", "opus")] : [candidate(present, model)],
        )
      },
      managed: () =>
        Promise.resolve(
          reads === 1
            ? [managed("chatgpt", "gpt", true), managed("claude", "opus", true)]
            : [managed(present, model, true)],
        ),
    })
    await state.load()
    await state.reload()
    expect(state.store.candidates.map((item) => item.vendorId)).toEqual([present])
    expect(state.store.managed.map((item) => item.vendorId)).toEqual([present])
    expect(state.visibleCount(absent)).toBe(0)
    expect(state.visibleCount(present)).toBe(1)
    expect(state.isVisible(present, model)).toBe(true)
  }
})

test("G01 clears an empty candidates or managed list without clearing the other", async () => {
  const stages = ["candidates", "managed"] as const
  for (const stage of stages) {
    let reads = 0
    const state = stateWith({
      get: () => Promise.resolve(auth(1, true)),
      candidates: () => {
        reads += 1
        if (stage === "candidates" && reads > 1) return Promise.resolve([])
        return Promise.resolve([candidate("chatgpt", "gpt")])
      },
      managed: () => {
        if (stage === "managed" && reads > 1) return Promise.resolve([])
        return Promise.resolve([managed("chatgpt", "gpt", true)])
      },
    })
    await state.load()
    await state.reload()
    expect(state.store.candidates.map((item) => item.modelId)).toEqual(stage === "candidates" ? [] : ["gpt"])
    expect(state.store.managed.map((item) => item.modelId)).toEqual(stage === "managed" ? [] : ["gpt"])
    expect(state.visibleCount("chatgpt")).toBe(stage === "managed" ? 0 : 1)
  }
})

test("G01 keeps a vendor refresh when an older empty snapshot finishes later", async () => {
  const fullCandidates = gate<ReturnType<typeof candidate>[]>()
  const fullManaged = gate<ReturnType<typeof managed>[]>()
  let fullReads = 0
  let managedCalls = 0
  const state = stateWith({
    get: () => Promise.resolve(bothVendors()),
    vendor: () => Promise.resolve(bothVendors()),
    refresh: () => Promise.resolve([]),
    candidates: (input?: { vendorId?: string }) => {
      if (input?.vendorId === "chatgpt") return Promise.resolve([candidate("chatgpt", "fresh")])
      fullReads += 1
      if (fullReads === 1) return Promise.resolve([candidate("chatgpt", "old"), candidate("claude", "opus")])
      return fullCandidates.promise
    },
    managed: () => {
      managedCalls += 1
      if (managedCalls === 1) return Promise.resolve([managed("chatgpt", "old", true), managed("claude", "opus", true)])
      if (managedCalls === 3) return fullManaged.promise
      return Promise.resolve([managed("chatgpt", "fresh", true)])
    },
  })
  await state.load()
  const reload = state.reload()
  await waitFor(() => fullReads === 2)
  state.setDraft("chatgpt", "key", "next")
  await state.saveVendor(state.vendors()[0])
  fullCandidates.release([])
  fullManaged.release([])
  await reload
  expect(state.store.candidates.map((item) => item.modelId)).toEqual(["fresh"])
  expect(state.isVisible("chatgpt", "fresh")).toBe(true)
  expect(state.visibleCount("chatgpt")).toBe(1)
  expect(state.store.managed.map((item) => item.vendorId)).not.toContain("claude")
  expect(state.visibleCount("claude")).toBe(0)
})

test("G01 drops an older non-empty snapshot after a newer empty snapshot", async () => {
  const olderCandidates = gate<ReturnType<typeof candidate>[]>()
  const olderManaged = gate<ReturnType<typeof managed>[]>()
  let reads = 0
  const state = stateWith({
    get: () => Promise.resolve(auth(1, true)),
    candidates: () => {
      reads += 1
      if (reads === 1) return Promise.resolve([candidate("chatgpt", "old")])
      if (reads === 2) return olderCandidates.promise
      return Promise.resolve([])
    },
    managed: () =>
      reads === 2 ? olderManaged.promise : Promise.resolve(reads === 1 ? [managed("chatgpt", "old", true)] : []),
  })
  await state.load()
  const older = state.reload()
  await waitFor(() => reads === 2)
  await state.reload()
  olderCandidates.release([candidate("chatgpt", "revived")])
  olderManaged.release([managed("chatgpt", "revived", true)])
  await older
  expect(state.store.candidates).toEqual([])
  expect(state.store.managed).toEqual([])
  expect(state.visibleCount("chatgpt")).toBe(0)
})

test("G02 keeps a newer full snapshot when an older vendor managed response finishes later", async () => {
  const vendorManaged = gate<ReturnType<typeof managed>[]>()
  let managedCalls = 0
  let vendorManagedSent = false
  const state = stateWith({
    get: () => Promise.resolve(bothVendors()),
    vendor: () => Promise.resolve(bothVendors()),
    refresh: () => Promise.resolve([]),
    candidates: (input?: { vendorId?: string }) =>
      Promise.resolve(
        input?.vendorId === "chatgpt"
          ? [candidate("chatgpt", "vendor")]
          : [candidate("chatgpt", "fresh"), candidate("claude", "opus")],
      ),
    managed: () => {
      managedCalls += 1
      if (managedCalls === 1) return Promise.resolve([managed("chatgpt", "old", true), managed("claude", "opus", true)])
      if (managedCalls === 2) {
        vendorManagedSent = true
        return vendorManaged.promise
      }
      return Promise.resolve([managed("chatgpt", "fresh", true), managed("claude", "opus", true)])
    },
  })
  await state.load()
  state.setDraft("chatgpt", "key", "next")
  const saving = state.saveVendor(state.vendors()[0])
  await waitFor(() => vendorManagedSent)
  expect(managedCalls).toBe(2)
  await state.reload()
  const before = state.store.managed.map((item) => item.modelId)
  vendorManaged.release([managed("chatgpt", "old", false)])
  await saving
  expect(before).toEqual(["fresh", "opus"])
  expect(state.store.candidates.map((item) => item.modelId).sort()).toEqual(["fresh", "opus"])
  expect(state.store.managed.map((item) => item.modelId).sort()).toEqual(["fresh", "opus"])
  expect(state.isVisible("chatgpt", "fresh")).toBe(true)
  expect(state.isVisible("chatgpt", "old")).toBe(false)
})

test("G02 drops an older full managed response after a newer vendor managed write", async () => {
  const fullManaged = gate<ReturnType<typeof managed>[]>()
  let managedCalls = 0
  const state = stateWith({
    get: () => Promise.resolve(bothVendors()),
    vendor: () => Promise.resolve(bothVendors()),
    refresh: () => Promise.resolve([]),
    candidates: (input?: { vendorId?: string }) =>
      Promise.resolve(
        input?.vendorId === "chatgpt"
          ? [candidate("chatgpt", "fresh")]
          : [candidate("chatgpt", "old"), candidate("claude", "opus")],
      ),
    managed: () => {
      managedCalls += 1
      if (managedCalls === 1) return Promise.resolve([managed("chatgpt", "old", true), managed("claude", "opus", true)])
      if (managedCalls === 2) return fullManaged.promise
      return Promise.resolve([managed("chatgpt", "fresh", true)])
    },
  })
  await state.load()
  const reload = state.reload()
  await waitFor(() => managedCalls === 2)
  state.setDraft("chatgpt", "key", "next")
  await state.saveVendor(state.vendors()[0])
  expect(managedCalls).toBe(3)
  fullManaged.release([managed("chatgpt", "old", false), managed("claude", "opus", true)])
  await reload
  expect(state.store.candidates.map((item) => item.modelId)).toContain("fresh")
  expect(state.isVisible("chatgpt", "fresh")).toBe(true)
  expect(state.store.managed.map((item) => item.modelId)).not.toContain("old")
  expect(state.isVisible("claude", "opus")).toBe(true)
})

test("G02 drops an older vendor managed response after a newer visibility write", async () => {
  const vendorManaged = gate<ReturnType<typeof managed>[]>()
  let managedCalls = 0
  const state = stateWith({
    get: () => Promise.resolve(bothVendors()),
    vendor: () => Promise.resolve(bothVendors()),
    refresh: () => Promise.resolve([]),
    candidates: (input?: { vendorId?: string }) =>
      Promise.resolve(
        input?.vendorId ? [candidate("chatgpt", "gpt")] : [candidate("chatgpt", "gpt"), candidate("claude", "opus")],
      ),
    managed: () => {
      managedCalls += 1
      if (managedCalls === 2) return vendorManaged.promise
      return Promise.resolve([managed("chatgpt", "gpt", true), managed("claude", "opus", true)])
    },
    visibility: () => Promise.resolve([managed("chatgpt", "gpt", false), managed("claude", "opus", true)]),
  })
  await state.load()
  state.setDraft("chatgpt", "key", "next")
  const saving = state.saveVendor(state.vendors()[0])
  await waitFor(() => managedCalls === 2)
  await state.setVisible("chatgpt", "gpt", false)
  vendorManaged.release([managed("chatgpt", "gpt", true)])
  await saving
  expect(state.isVisible("chatgpt", "gpt")).toBe(false)
  expect(state.isVisible("claude", "opus")).toBe(true)
  expect(state.visibleCount("chatgpt")).toBe(0)
})

test("G03 does not restore a deleted custom vendor from its own visibility response", async () => {
  const visibility = gate<ReturnType<typeof managed>[]>()
  const removed = (): Auth => ({ ...customAuth(), revision: 2, vendors: [] })
  const state = stateWith({
    get: () => Promise.resolve(customAuth()),
    delete: () => Promise.resolve(removed()),
    candidates: () => Promise.resolve([candidate("custom-review", "gpt")]),
    managed: () => Promise.resolve([managed("custom-review", "gpt", true)]),
    visibility: () => visibility.promise,
  })
  await state.load()
  const checking = state.setVisible("custom-review", "gpt", false)
  await state.deleteVendor(state.vendors()[0])
  visibility.release([managed("custom-review", "gpt", true)])
  await checking.catch(() => undefined)
  expect(state.store.auth?.vendors).toEqual([])
  expect(state.store.managed.map((item) => item.vendorId)).not.toContain("custom-review")
  expect(state.visibleCount("custom-review")).toBe(0)
})

test("G03 does not restore a recreated custom vendor from the deleted identity response", async () => {
  const visibility = gate<ReturnType<typeof managed>[]>()
  let vendors = 0
  const state = stateWith({
    get: () => Promise.resolve(customAuth()),
    delete: () => Promise.resolve({ ...customAuth(), revision: 2, vendors: [] }),
    vendor: () => {
      vendors += 1
      return Promise.resolve(customAuth(3, { ...customReview, baseURL: "https://rebuilt.example/v1" }))
    },
    refresh: () => Promise.resolve([]),
    candidates: () => Promise.resolve([candidate("custom-review", "gpt")]),
    managed: () => Promise.resolve([managed("custom-review", "gpt", true)]),
    visibility: () => visibility.promise,
  })
  await state.load()
  const checking = state.setVisible("custom-review", "gpt", false)
  await state.deleteVendor(state.vendors()[0])
  state.setStore("addName", "custom-review")
  state.setStore("addURL", "https://rebuilt.example/v1")
  state.setStore("addKey", "rebuilt-key")
  await state.addVendor()
  visibility.release([managed("custom-review", "gpt", false)])
  await checking.catch(() => undefined)
  expect(vendors).toBe(1)
  expect(state.store.auth?.vendors[0]?.baseURL).toBe("https://rebuilt.example/v1")
  expect(state.isVisible("custom-review", "gpt")).toBe(true)
  expect(state.visibleCount("custom-review")).toBe(1)
})

test("G03 does not apply visibility after the target URL changes and keeps the other vendor", async () => {
  const visibility = gate<ReturnType<typeof managed>[]>()
  const changed = (): Auth => ({
    ...bothVendors(),
    revision: 2,
    vendors: [
      {
        ...customReview,
        id: "chatgpt",
        name: "ChatGPT",
        builtin: false,
        baseURL: "https://moved.example/v1",
        revision: 2,
      },
      { ...vendor, id: "claude", name: "Claude", hasKey: true, revision: 2 },
    ],
  })
  const state = stateWith({
    get: () =>
      Promise.resolve({
        ...bothVendors(),
        vendors: [
          { ...customReview, id: "chatgpt", name: "ChatGPT", builtin: false },
          { ...vendor, id: "claude", name: "Claude", hasKey: true, revision: 1 },
        ],
      }),
    vendor: () => Promise.resolve(changed()),
    refresh: () => Promise.resolve([]),
    candidates: () => Promise.resolve([candidate("chatgpt", "gpt"), candidate("claude", "opus")]),
    managed: () => Promise.resolve([managed("chatgpt", "gpt", true), managed("claude", "opus", true)]),
    visibility: () => visibility.promise,
  })
  await state.load()
  const checking = state.setVisible("chatgpt", "gpt", false)
  state.setDraft("chatgpt", "baseURL", "https://moved.example/v1")
  await state.saveVendor(state.vendors()[0], false)
  expect(state.store.managed.map((item) => item.vendorId)).toEqual(["claude"])
  visibility.release([managed("chatgpt", "gpt", false), managed("claude", "opus", false)])
  await checking.catch(() => undefined)
  expect(state.store.auth?.vendors[0]?.baseURL).toBe("https://moved.example/v1")
  expect(state.store.managed.map((item) => item.vendorId)).toEqual(["claude"])
  expect(state.isVisible("chatgpt", "gpt")).toBe(false)
  expect(state.isVisible("claude", "opus")).toBe(true)
  expect(state.visibleCount("claude")).toBe(1)
})

test("G04 keeps the current error clear when an older fetch refresh fails", async () => {
  const stages = ["refresh", "candidates", "managed"] as const
  for (const stage of stages) {
    const firstSave = gate<Auth>()
    const secondSave = gate<Auth>()
    let rejectFollowup: (error: Error) => void = () => undefined
    const rejected = new Promise<never>((_resolve, reject) => {
      rejectFollowup = reject
    })
    const entered = gate<void>()
    let vendorCalls = 0
    let refreshCalls = 0
    const state = stateWith({
      get: () => Promise.resolve(auth(1, true)),
      vendor: () => {
        vendorCalls += 1
        return vendorCalls === 1 ? firstSave.promise : secondSave.promise
      },
      refresh: () => {
        refreshCalls += 1
        if (stage === "refresh" && refreshCalls === 1) { entered.release(); return rejected }
        return Promise.resolve([])
      },
      candidates: (input?: { vendorId?: string }) => {
        if (stage === "candidates" && input?.vendorId && refreshCalls === 1) { entered.release(); return rejected }
        return Promise.resolve([candidate("chatgpt", "gpt")])
      },
      managed: () => {
        if (stage === "managed" && refreshCalls === 1) { entered.release(); return rejected }
        return Promise.resolve([managed("chatgpt", "gpt", true)])
      },
    })
    await state.load()
    state.setDraft("chatgpt", "key", "first")
    const older = state.fetchModels("chatgpt")
    await waitFor(() => vendorCalls === 1)
    firstSave.release(auth(1, true))
    await entered.promise
    state.setDraft("chatgpt", "key", "second")
    const newer = state.fetchModels("chatgpt")
    await waitFor(() => vendorCalls === 2)
    secondSave.release(auth(2, true))
    await newer
    expect(state.store.error).toBeUndefined()
    expect(refreshCalls).toBe(2)
    rejectFollowup(new Error("UPSTREAM_UNREACHABLE"))
    await older.catch(() => undefined)
    expect(state.store.error).toBeUndefined()
    expect(state.isBusy("fetching", "chatgpt")).toBe(false)
    expect(state.isVisible("chatgpt", "gpt")).toBe(true)
    expect(vendorCalls).toBe(2)
  }
})

test("G04 reports a different vendor failure while another vendor action is newer", async () => {
  let rejectClaude: (error: Error) => void = () => undefined
  const rejected = new Promise<never>((_resolve, reject) => {
    rejectClaude = reject
  })
  let probes = 0
  const state = stateWith({
    get: () => Promise.resolve(bothVendors()),
    vendor: () => Promise.resolve(bothVendors()),
    probe: (input: { vendorId: string }) => {
      probes += 1
      if (input.vendorId === "claude") return rejected
      return Promise.resolve({ count: 1 })
    },
  })
  await state.load()
  const claudeProbe = state.probe("claude")
  await state.probe("chatgpt")
  expect(state.store.error).toBeUndefined()
  rejectClaude(new Error("UPSTREAM_UNREACHABLE"))
  await claudeProbe.catch(() => undefined)
  expect(state.store.error).toBe("settings.relay.error.UPSTREAM_UNREACHABLE")
  expect(state.store.status.chatgpt).toBe("connected")
})

test("G04 passes the original action ticket through save and add refreshes", async () => {
  const commands = ["save", "add"] as const
  for (const command of commands) {
    const firstWrite = gate<Auth>()
    const secondWrite = gate<Auth>()
    let rejectFollowup: (error: Error) => void = () => undefined
    const rejected = new Promise<never>((_resolve, reject) => {
      rejectFollowup = reject
    })
    let writes = 0
    let refreshCalls = 0
    const added = customAuth(2)
    const state = stateWith({
      get: () => Promise.resolve(auth(1, true)),
      delete: () => Promise.resolve({ ...auth(2, false), vendors: [] }),
      vendor: () => {
        writes += 1
        if (writes === 1) return firstWrite.promise
        return secondWrite.promise
      },
      refresh: () => {
        refreshCalls += 1
        if (refreshCalls === 1) return rejected
        return Promise.resolve([])
      },
      candidates: () => Promise.resolve([candidate(command === "add" ? "custom-review" : "chatgpt", "gpt")]),
      managed: () => Promise.resolve([managed(command === "add" ? "custom-review" : "chatgpt", "gpt", true)]),
    })
    await state.load()
    const older =
      command === "save"
        ? (state.setDraft("chatgpt", "key", "first"), state.saveVendor(state.vendors()[0]))
        : (state.setStore("addName", "custom-review"),
          state.setStore("addURL", "https://review.example/v1"),
          state.setStore("addKey", "first-key"),
          state.addVendor())
    await waitFor(() => writes === 1)
    firstWrite.release(command === "add" ? customAuth(2) : auth(2, true))
    await waitFor(() => refreshCalls === 1)
    if (command === "save") {
      state.setDraft("chatgpt", "key", "second")
      const newer = state.saveVendor(state.vendors()[0])
      await waitFor(() => writes === 2)
      secondWrite.release(auth(3, true))
      await newer
    }
    if (command === "add") {
      await state.deleteVendor(state.vendors().find((item) => item.id === "custom-review") ?? state.vendors()[0])
      state.setStore("addName", "custom-review")
      state.setStore("addURL", "https://review.example/v1")
      state.setStore("addKey", "second-key")
      const newer = state.addVendor()
      await waitFor(() => writes === 2)
      secondWrite.release(added)
      await newer
    }
    expect(state.store.error).toBeUndefined()
    expect(refreshCalls).toBe(2)
    rejectFollowup(new Error("UPSTREAM_UNREACHABLE"))
    await older.catch(() => undefined)
    expect(state.store.error).toBeUndefined()
    expect(writes).toBe(2)
  }
})
