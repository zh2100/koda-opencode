import { createFixtureState } from "./relay-settings-fixture"
import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createRelaySettingsState } from "../src/hooks/use-relay-settings"

const vendor = (url = "https://old.example/v1", name = "Review") => ({
  id: "review",
  name,
  baseURL: url,
  builtin: false,
  hasKey: true,
  revision: 1,
  updatedAt: 0,
})
const auth = (revision = 1, vendors = [vendor()]) => ({
  revision,
  vendors,
})
const gate = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const catalog = {
  candidates: () => Promise.resolve([]),
  managed: () => Promise.resolve([]),
  refresh: () => Promise.resolve([]),
}
const wait = async (state: ReturnType<typeof createRelaySettingsState>) => {
  const stop = Date.now() + 2000
  while (state.resource.loading && Date.now() < stop) await Bun.sleep(0)
  expect(state.resource.loading).toBe(false)
}
const withState = (
  api: Record<string, unknown>,
  run: (state: ReturnType<typeof createRelaySettingsState>) => Promise<void>,
) =>
  createRoot(async (dispose) => {
    const state = createFixtureState(() => ({
      scope: "review",
      generatedApi: { "server.relay": { get: () => Promise.resolve(auth()), ...catalog, ...api } },
    }))
    try {
      await wait(state)
      await run(state)
    } finally {
      dispose()
    }
  })

test("BF-01 adding before the initial read cannot overwrite an existing same-name vendor", () =>
  createRoot(async (dispose) => {
    const read = gate<ReturnType<typeof auth>>()
    let saved = auth()
    let submitted: { vendorId: string; name: string; baseURL: string } | undefined
    const state = createFixtureState(() => ({
      scope: "initial",
      generatedApi: {
        "server.relay": {
          ...catalog,
          get: () => read.promise,
          vendor: (input: NonNullable<typeof submitted>) => {
            submitted = input
            const item = { ...vendor(input.baseURL, input.name), id: input.vendorId }
            saved = auth(2, [...saved.vendors.filter((value) => value.id !== item.id), item])
            return Promise.resolve(saved)
          },
        },
      },
    }))
    try {
      state.setStore({ addName: "Review", addURL: "https://new.example/v1", addKey: "fake-new-key" })
      const adding = state.addVendor()
      read.resolve(auth())
      await adding
      expect(submitted?.vendorId).toBe("review-2")
      expect(saved.vendors.find((item) => item.id === "review")?.baseURL).toBe("https://old.example/v1")
      expect(saved.vendors).toHaveLength(2)
    } finally {
      dispose()
    }
  }))

test("BF-C01 after the initial read same-name additions use a distinct id", () => {
  let id = ""
  return withState(
    {
      vendor: (input: { vendorId: string }) => {
        id = input.vendorId
        return Promise.resolve(auth(2, [vendor(), { ...vendor("https://new.example/v1"), id }]))
      },
    },
    async (state) => {
      state.setStore({ addName: "Review", addURL: "https://new.example/v1", addKey: "fake-new-key" })
      await state.addVendor()
      expect(id).toBe("review-2")
    },
  )
})

test("BF-02 a successful normalized save must not leave a falsely dirty draft", () => {
  let snapshot = auth()
  return withState(
    {
      get: () => Promise.resolve(snapshot),
      vendor: () => {
        snapshot = auth(2, [vendor("https://saved.example/v1", "Saved")])
        return Promise.resolve(snapshot)
      },
    },
    async (state) => {
      state.setDraft("review", "name", " Saved ")
      state.setDraft("review", "baseURL", "https://saved.example/v1/")
      await state.saveVendor(state.vendors()[0]!)
      const current = state.draft(state.vendors()[0]!)
      expect(current.conflicts).toEqual([])
      snapshot = auth(3, [vendor("https://remote.example/v1", "Remote")])
      await state.reload()
      expect(state.draft(state.vendors()[0]!).conflicts).toEqual([])
      expect(state.draft(state.vendors()[0]!).name).toBe("Remote")
      expect(state.draft(state.vendors()[0]!).baseURL).toBe("https://remote.example/v1")
    },
  )
})

test("BF-03 an old connection test cannot probe a replacement vendor after its save returns", () => {
  const save = gate<ReturnType<typeof auth>>()
  let writes = 0
  let probes = 0
  let snapshot = auth()
  let committed = auth(2)
  return withState(
    {
      get: () => Promise.resolve(snapshot),
      vendor: () => {
        if (++writes === 1) {
          committed = auth(2)
          snapshot = committed
          return save.promise
        }
        snapshot = auth(4, [vendor("https://replacement.example/v1")])
        return Promise.resolve(snapshot)
      },
      delete: () => {
        snapshot = auth(3, [])
        return Promise.resolve(snapshot)
      },
      probe: () => {
        probes++
        return Promise.resolve({ count: 0 })
      },
    },
    async (state) => {
      const testing = state.probe("review")
      await state.reload()
      await state.deleteVendor(state.vendors()[0]!)
      state.setStore({ addName: "Review", addURL: "https://replacement.example/v1", addKey: "fake-replacement-key" })
      await state.addVendor()
      save.resolve(committed)
      await testing
      expect(state.vendors()[0]?.baseURL).toBe("https://replacement.example/v1")
      expect(probes).toBe(0)
    },
  )
})

test("BF-C02 disposal prevents the old connection test from sending a probe", () => {
  const save = gate<ReturnType<typeof auth>>()
  let probes = 0
  return withState(
    {
      vendor: () => save.promise,
      probe: () => {
        probes++
        return Promise.resolve({ count: 0 })
      },
    },
    async (state) => {
      const testing = state.probe("review")
      state.dispose()
      save.resolve(auth(2))
      await testing
      expect(probes).toBe(0)
    },
  )
})
