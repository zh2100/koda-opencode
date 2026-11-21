import { createFixtureState } from "./relay-settings-fixture"
import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createRelaySettingsState } from "../src/hooks/use-relay-settings"
const vendor = (baseURL = "https://old.example/v1") => ({
  id: "review",
  name: "Review",
  builtin: false,
  hasKey: true,
  revision: 1,
  updatedAt: 0,
  baseURL,
})
const auth = (revision = 1, vendors = [vendor()]) => ({
  revision,
  vendors,
})
const waitUntil = async (ready: () => boolean) => {
  const deadline = Date.now() + 1000
  while (!ready() && Date.now() < deadline) await Bun.sleep(0)
  expect(ready()).toBe(true)
}
const gate = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok
    reject = fail
  })
  return { promise, resolve, reject }
}
const withState = (
  api: Record<string, unknown>,
  run: (state: ReturnType<typeof createRelaySettingsState>) => Promise<void>,
) =>
  createRoot(async (dispose) => {
    const state = createFixtureState(() => ({
      scope: "audit",
      generatedApi: {
        "server.relay": {
          get: () => Promise.resolve(auth()),
          candidates: () => Promise.resolve([]),
          managed: () => Promise.resolve([]),
          refresh: () => Promise.resolve([]),
          ...api,
        },
      },
    }))
    try {
      await waitUntil(() => !state.resource.loading)
      await run(state)
    } finally {
      dispose()
    }
  })
test("RA-03 the current successful retry clears its previous request error", () => {
  let attempts = 0
  return withState(
    { vendor: () => (++attempts === 1 ? Promise.reject(new Error("UPSTREAM_UNREACHABLE")) : Promise.resolve(auth(2))) },
    async (state) => {
      await state.saveVendor(state.vendors()[0]!).catch(() => undefined)
      expect(state.store.error).toBe("settings.relay.error.UPSTREAM_UNREACHABLE")
      await state.saveVendor(state.vendors()[0]!)
      expect(state.store.error).toBeUndefined()
    },
  )
})
test("RA-04 re-adding a deleted vendor ID must not inherit the old credential draft", () => {
  const replacement = vendor("https://new.example/v1")
  return withState(
    { delete: () => Promise.resolve(auth(2, [])), vendor: () => Promise.resolve(auth(3, [replacement])) },
    async (state) => {
      state.setDraft("review", "key", "fake-old-unsaved-key")
      await state.deleteVendor(state.vendors()[0]!)
      state.setStore({ addName: "review", addURL: replacement.baseURL, addKey: "fake-new-key" })
      await state.addVendor()
      const current = state.vendors()[0]!
      const draft = state.draft(current)
      expect(draft.baseURL).toBe(replacement.baseURL)
      expect(draft.key).toBe("")
    },
  )
})
test("RA-05 reload followed by key-only save must preserve the reloaded endpoint", () => {
  let version = 1
  let submitted: { baseURL?: string; revision?: number } | undefined
  const latest = vendor("https://fresh.example/v1")
  return withState(
    {
      get: () => Promise.resolve(auth(version, version === 1 ? [vendor()] : [latest])),
      vendor: (input: typeof submitted) => {
        submitted = input
        return Promise.resolve(auth(3, [latest]))
      },
    },
    async (state) => {
      state.setDraft("review", "key", "fake-typed-key")
      version = 2
      await state.reload()
      expect(state.store.auth?.vendors[0]?.baseURL).toBe(latest.baseURL)
      await state.saveVendor(state.vendors()[0]!)
      expect(submitted?.baseURL).toBeUndefined()
      expect(submitted?.revision).toBe(2)
      expect(state.store.auth?.vendors[0]?.baseURL).toBe(latest.baseURL)
    },
  )
})

test("RA-C02 without an older draft a reload saves the current endpoint", () => {
  let version = 1
  let submitted: { baseURL?: string } | undefined
  const latest = vendor("https://fresh.example/v1")
  return withState(
    {
      get: () => Promise.resolve(auth(version, version === 1 ? [vendor()] : [latest])),
      vendor: (input: typeof submitted) => {
        submitted = input
        return Promise.resolve(auth(3, [latest]))
      },
    },
    async (state) => {
      version = 2
      await state.reload()
      await state.saveVendor(state.vendors()[0]!)
      expect(submitted?.baseURL).toBeUndefined()
      expect(state.store.error).toBeUndefined()
    },
  )
})

test("RA-05 key-only saving never normalizes an untouched URL into a field patch", () => {
  const current = vendor("https://fresh.example/v1/")
  let submitted: { baseURL?: string } | undefined
  return withState(
    {
      get: () => Promise.resolve(auth(1, [current])),
      vendor: (input: typeof submitted) => {
        submitted = input
        return Promise.resolve(auth(2, [current]))
      },
    },
    async (state) => {
      state.setDraft("review", "key", "test-key-only")
      await state.saveVendor(state.vendors()[0]!)
      expect(submitted).not.toHaveProperty("baseURL")
      expect(state.vendors()[0]?.baseURL).toBe(current.baseURL)
    },
  )
})

test("RA-05 conflicting fields survive repeated reloads until an explicit edit", () => {
  let revision = 1
  let calls = 0
  const latest = vendor("https://remote.example/v1")
  return withState(
    {
      get: () => Promise.resolve(auth(revision, revision === 1 ? [vendor()] : [latest])),
      vendor: (input: { baseURL?: string }) => {
        calls++
        expect(input.baseURL).toBe("https://chosen.example/v1")
        return Promise.resolve(auth(3, [vendor(input.baseURL)]))
      },
    },
    async (state) => {
      state.setDraft("review", "baseURL", "https://local.example/v1")
      revision = 2
      await state.reload()
      await state.reload()
      expect(state.draft(state.vendors()[0]!).conflicts).toEqual(["baseURL"])
      await expect(state.saveVendor(state.vendors()[0]!)).rejects.toThrow("REVISION_CONFLICT")
      expect(calls).toBe(0)
      state.setDraft("review", "key", "test-new-key")
      expect(state.draft(state.vendors()[0]!).conflicts).toEqual(["baseURL"])
      state.setDraft("review", "baseURL", "https://chosen.example/v1")
      await state.saveVendor(state.vendors()[0]!)
      expect(state.draft(state.vendors()[0]!).conflicts).toEqual([])
      expect(state.store.error).toBeUndefined()
      expect(calls).toBe(1)
    },
  )
})

test("RA-05 save acknowledgement preserves edits made during the request", () => {
  const pending = gate<ReturnType<typeof auth>>()
  return withState({ vendor: () => pending.promise }, async (state) => {
    state.setDraft("review", "name", "Sent")
    state.setDraft("review", "baseURL", "https://sent.example/v1")
    state.setDraft("review", "key", "test-sent-key")
    const saving = state.saveVendor(state.vendors()[0]!)
    state.setDraft("review", "name", "Review")
    state.setDraft("review", "baseURL", "https://later.example/v1")
    state.setDraft("review", "key", "test-later-key")
    pending.resolve(auth(2, [{ ...vendor("https://sent.example/v1"), name: "Sent" }]))
    await saving
    const current = state.draft(state.vendors()[0]!)
    expect(current.name).toBe("Review")
    expect(current.baseURL).toBe("https://later.example/v1")
    expect(current.key).toBe("test-later-key")
    expect(current.baseline).toEqual({ name: "Sent", baseURL: "https://sent.example/v1" })
    expect(current.conflicts).toEqual([])
  })
})

for (const outcome of ["success", "failure"] as const) {
  test(`RA-04 an old save ${outcome} cannot affect a recreated vendor`, () => {
    const pending = gate<ReturnType<typeof auth>>()
    let calls = 0
    const replacement = vendor("https://replacement.example/v1")
    return withState(
      {
        delete: () => Promise.resolve(auth(2, [])),
        vendor: () => (++calls === 1 ? pending.promise : Promise.resolve(auth(3, [replacement]))),
      },
      async (state) => {
        state.setDraft("review", "key", "test-old-key")
        const saving = state.saveVendor(state.vendors()[0]!).catch(() => undefined)
        await state.deleteVendor(state.vendors()[0]!)
        state.setStore({ addName: "review", addURL: replacement.baseURL, addKey: "test-replacement-key" })
        await state.addVendor()
        state.setDraft("review", "key", "test-unsaved-replacement-key")
        if (outcome === "success") pending.resolve(auth(4))
        else pending.reject(new Error("UPSTREAM_UNREACHABLE"))
        await saving
        expect(state.store.auth?.revision).toBe(3)
        expect(state.vendors()[0]?.baseURL).toBe(replacement.baseURL)
        expect(state.draft(state.vendors()[0]!).key).toBe("test-unsaved-replacement-key")
        expect(state.store.error).toBeUndefined()
      },
    )
  })
}

test("RA-03 an older successful save cannot clear a newer failure", () => {
  const pending = gate<ReturnType<typeof auth>>()
  let calls = 0
  return withState(
    { vendor: () => (++calls === 1 ? pending.promise : Promise.reject(new Error("KEY_MISSING"))) },
    async (state) => {
      const saving = state.saveVendor(state.vendors()[0]!)
      await state.saveVendor(state.vendors()[0]!).catch(() => undefined)
      pending.resolve(auth(2))
      await saving
      expect(state.store.error).toBe("settings.relay.error.KEY_MISSING")
    },
  )
})

test("RA-03 one vendor success cannot hide another vendor error", () => {
  const other = { ...vendor(), id: "other" }
  return withState(
    {
      get: () => Promise.resolve(auth(1, [vendor(), other])),
      vendor: (input: { vendorId: string }) =>
        input.vendorId === "review"
          ? Promise.reject(new Error("KEY_MISSING"))
          : Promise.resolve(auth(2, [vendor(), other])),
    },
    async (state) => {
      await state.saveVendor(state.vendors()[0]!).catch(() => undefined)
      await state.saveVendor(state.vendors()[1]!)
      expect(state.store.error).toBe("settings.relay.error.KEY_MISSING")
    },
  )
})

test("RA-03 a failed refresh stays visible until its retry completes", () => {
  let refreshes = 0
  return withState(
    {
      vendor: () => Promise.resolve(auth(2)),
      refresh: () => (++refreshes === 1 ? Promise.reject(new Error("UPSTREAM_UNREACHABLE")) : Promise.resolve([])),
    },
    async (state) => {
      state.setDraft("review", "key", "test-key")
      await state.fetchModels("review").catch(() => undefined)
      expect(state.store.error).toBe("settings.relay.error.UPSTREAM_UNREACHABLE")
      await state.fetchModels("review")
      expect(state.store.error).toBeUndefined()
    },
  )
})

test("RA-03 saving settings does not hide an unrelated failed connection test", () => {
  return withState(
    {
      vendor: () => Promise.resolve(auth(2)),
      probe: () => Promise.reject(new Error("UPSTREAM_UNREACHABLE")),
    },
    async (state) => {
      await state.probe("review").catch(() => undefined)
      await state.saveVendor(state.vendors()[0]!)
      expect(state.store.error).toBe("settings.relay.error.UPSTREAM_UNREACHABLE")
    },
  )
})

test("RA-04 does not offer retired built-ins before the first auth read", () =>
  createRoot(async (dispose) => {
    const pending = gate<ReturnType<typeof auth>>()
    const state = createFixtureState(() => ({
      scope: "initial",
      generatedApi: {
        "server.relay": {
          get: () => pending.promise,
          candidates: () => Promise.resolve([]),
          managed: () => Promise.resolve([]),
        },
      },
    }))
    try {
      expect(state.vendors()).toEqual([])
      expect(state.canEdit()).toBe(false)
      state.setDraft("chatgpt", "key", "unused")
      expect(state.store.drafts).toEqual({})
      pending.resolve(auth(1))
      await waitUntil(() => !state.resource.loading)
      expect(state.vendors().map((item) => item.id)).toEqual(["review"])
    } finally {
      dispose()
    }
  }))
