import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createRelaySettingsState } from "../src/hooks/use-relay-settings"

const vendor = (id = "review", entityId = `entity:${id}`, revision = 1, name = "Review") => ({
  id,
  entityId,
  revision,
  name,
  baseURL: "https://review.invalid/v1",
  hasKey: true,
  builtin: false,
  updatedAt: 0,
})
const auth = (revision = 1, vendors = [vendor()]) => ({
  revision,
  vendors,
  capabilities: [
    "independent-vendors-v1",
    "vendor-entity-v1",
    "vendor-create-receipt-v1",
    "catalog-sync-v1",
    "notice-retry-v1",
  ],
})
const managed = (modelId: string, id = "review") => ({
  vendorId: id,
  modelId,
  visible: true,
  reasoningCapabilities: [],
  assignmentSource: "manual" as const,
  lastSeenAt: 0,
  upstreamPresent: true,
})
const snapshot = (catalogRevision: number | null = 1, state = auth(), models = [managed("old")]) => ({
  catalogRevision,
  auth: state,
  managed: models,
  candidates: [],
  notice: { status: "idle" as const },
})
const gate = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
const wait = async (ready: () => boolean) => {
  const deadline = Date.now() + 3000
  while (!ready() && Date.now() < deadline) await Bun.sleep(0)
  expect(ready()).toBe(true)
}
const withState = (
  api: Record<string, unknown>,
  run: (state: ReturnType<typeof createRelaySettingsState>) => Promise<void>,
) =>
  createRoot(async (dispose) => {
    const state = createRelaySettingsState(() => ({
      scope: "protocol-test",
      generatedApi: {
        "server.relay": {
          get: () => Promise.resolve(auth()),
          sync: () => Promise.resolve(snapshot()),
          ...api,
        },
      },
    }))
    try {
      await wait(() => !state.resource.loading)
      await run(state)
    } finally {
      dispose()
    }
  })

test("B209 a stale successful ACK settles normalization without replacing a newer auth snapshot", () => {
  const ack = gate<ReturnType<typeof auth>>()
  const base = auth(1, [vendor(), vendor("other")])
  const saved = auth(2, [vendor("review", "entity:review", 2, "Saved"), vendor("other")])
  const newer = auth(3, [saved.vendors[0]!, vendor("other", "entity:other", 2, "Other updated")])
  let latest = base
  return withState(
    { get: () => Promise.resolve(base), sync: () => Promise.resolve(snapshot(1, latest)), vendor: () => ack.promise },
    async (state) => {
      state.setDraft("review", "name", " Saved ")
      const saving = state.saveVendor(state.vendors()[0]!, false)
      latest = newer
      await state.reload()
      ack.resolve(saved)
      await saving
      const draft = state.draft(state.vendors()[0]!)
      expect(state.store.auth?.revision).toBe(3)
      expect(state.vendors()[1]?.name).toBe("Other updated")
      expect(draft.name).toBe("Saved")
      expect(draft.baseline.name).toBe("Saved")
      expect(draft.conflicts).toEqual([])
    },
  )
})

for (const edited of [false, true])
  test(`B210/B211 stale ACK preserves newer authority and subsequent edits=${edited}`, () => {
    const ack = gate<ReturnType<typeof auth>>()
    let latest = auth()
    return withState({ sync: () => Promise.resolve(snapshot(1, latest)), vendor: () => ack.promise }, async (state) => {
      state.setDraft("review", "name", " Saved ")
      const saving = state.saveVendor(state.vendors()[0]!, false)
      if (edited) state.setDraft("review", "name", "My next edit")
      latest = auth(3, [vendor("review", "entity:review", 3, "Remote after save")])
      await state.reload()
      ack.resolve(auth(2, [vendor("review", "entity:review", 2, "Saved")]))
      await saving
      const draft = state.draft(state.vendors()[0]!)
      expect(draft.name).toBe(edited ? "My next edit" : "Remote after save")
      expect(draft.baseline.name).toBe("Remote after save")
      expect(draft.conflicts).toEqual(edited ? ["name"] : [])
      expect(state.store.auth?.revision).toBe(3)
    })
  })

test("B211 editing a field away and back still protects the later raw input", () => {
  const ack = gate<ReturnType<typeof auth>>()
  return withState({ vendor: () => ack.promise }, async (state) => {
    state.setDraft("review", "name", " Saved ")
    const saving = state.saveVendor(state.vendors()[0]!, false)
    state.setDraft("review", "name", "Different")
    state.setDraft("review", "name", " Saved ")
    ack.resolve(auth(2, [vendor("review", "entity:review", 2, "Saved")]))
    await saving
    expect(state.draft(state.vendors()[0]!).name).toBe(" Saved ")
    expect(state.draft(state.vendors()[0]!).baseline.name).toBe("Saved")
  })
})

test("B003/B212 an unobserved same-ID replacement supersedes a pending probe before sending", () => {
  const ack = gate<ReturnType<typeof auth>>()
  let latest = auth()
  let probes = 0
  return withState(
    {
      sync: () => Promise.resolve(snapshot(1, latest)),
      vendor: () => ack.promise,
      probe: () => {
        probes++
        return Promise.resolve({ count: 1 })
      },
    },
    async (state) => {
      const testing = state.probe("review")
      latest = auth(3, [vendor("review", "replacement-entity")])
      await state.reload()
      ack.resolve(auth(2))
      await testing
      expect(probes).toBe(0)
      expect(state.vendors()[0]?.entityId).toBe("replacement-entity")
    },
  )
})

test("C111 a later-sent response containing an older catalog cannot replace newer data", () => {
  const first = gate<ReturnType<typeof snapshot>>()
  const second = gate<ReturnType<typeof snapshot>>()
  let calls = 0
  return withState(
    { sync: () => (++calls === 1 ? Promise.resolve(snapshot()) : calls === 2 ? first.promise : second.promise) },
    async (state) => {
      const a = state.reload()
      const b = state.reload()
      await wait(() => calls === 3)
      first.resolve(snapshot(3, auth(), [managed("newer")]))
      await a
      second.resolve(snapshot(2, auth(), [managed("older")]))
      await b
      expect(state.store.managed.map((item) => item.modelId)).toEqual(["newer"])
    },
  )
})

test("C111 a previously sent request can carry genuinely newer server data", () => {
  const first = gate<ReturnType<typeof snapshot>>()
  const second = gate<ReturnType<typeof snapshot>>()
  let calls = 0
  return withState(
    { sync: () => (++calls === 1 ? Promise.resolve(snapshot()) : calls === 2 ? first.promise : second.promise) },
    async (state) => {
      const a = state.reload()
      const b = state.reload()
      await wait(() => calls === 3)
      second.resolve(snapshot(2, auth(), [managed("middle")]))
      await b
      first.resolve(snapshot(3, auth(), [managed("newest")]))
      await a
      expect(state.store.managed.map((item) => item.modelId)).toEqual(["newest"])
    },
  )
})

test("C113 accepting an empty catalog leaves a deletion watermark", () => {
  const old = gate<ReturnType<typeof snapshot>>()
  let calls = 0
  return withState(
    {
      sync: () =>
        ++calls === 1
          ? Promise.resolve(snapshot())
          : calls === 2
            ? old.promise
            : Promise.resolve(snapshot(3, auth(), [])),
    },
    async (state) => {
      const reading = state.reload()
      await state.reload()
      expect(state.store.managed).toEqual([])
      old.resolve(snapshot(2, auth(), [managed("revived")]))
      await reading
      expect(state.store.managed).toEqual([])
    },
  )
})

test("C114 historical null responses cannot downgrade an accepted numeric revision", () => {
  let calls = 0
  return withState(
    { sync: () => Promise.resolve(++calls === 1 ? snapshot() : snapshot(null, auth(), [])) },
    async (state) => {
      await state.reload()
      expect(state.store.managed.map((item) => item.modelId)).toEqual(["old"])
      expect(state.store.error).toBe("settings.relay.error.REVISION_CONFLICT")
    },
  )
})

test("C2 explicit reload retries only notification and does not resubmit auth", () => {
  const requests: boolean[] = []
  return withState(
    {
      sync: (input: { retryNotice?: boolean }) => {
        requests.push(!!input.retryNotice)
        return Promise.resolve(snapshot())
      },
    },
    async (state) => {
      await state.reload()
      expect(requests).toEqual([false, true])
    },
  )
})

test("B0 old servers remain readable but protected writes do not fall back", () => {
  let writes = 0
  const old = { ...auth(), capabilities: [], vendors: [{ ...vendor(), entityId: undefined }] }
  return withState(
    {
      get: () => Promise.resolve(old),
      candidates: () => Promise.resolve([]),
      managed: () => Promise.resolve([]),
      vendor: () => {
        writes++
        return Promise.resolve(auth())
      },
    },
    async (state) => {
      await expect(state.saveVendor(state.vendors()[0]!, false)).rejects.toBeDefined()
      expect(writes).toBe(0)
      expect(state.canEdit()).toBe(false)
      expect(state.store.error).toBe("settings.relay.unsupported")
    },
  )
})

test("B111 uncertain creation retries exactly the same command after form edits", () => {
  const calls: unknown[] = []
  let latest = auth()
  return withState(
    {
      sync: () => Promise.resolve(snapshot(1, latest)),
      refresh: () => Promise.resolve([]),
      vendor: (input: { vendorId: string; operationId: string; revision: number }) => {
        calls.push(input)
        if (calls.length === 1) return Promise.reject(new Error("UPSTREAM_UNREACHABLE"))
        const created = vendor(input.vendorId, "created-entity")
        latest = auth(2, [vendor(), created])
        return Promise.resolve({
          ...latest,
          operationReceipt: {
            operationId: input.operationId,
            kind: "vendor-create",
            vendorId: input.vendorId,
            entityId: created.entityId,
            committedRevision: 2,
          },
        })
      },
    },
    async (state) => {
      state.setStore({ addName: "New", addURL: "https://new.invalid/v1", addKey: "fake-create" })
      await expect(state.addVendor()).rejects.toBeDefined()
      expect(state.store.addUnconfirmed).toBe(true)
      state.setStore("addName", "Another new form")
      await state.addVendor()
      expect(calls).toHaveLength(2)
      expect(calls[1]).toEqual(calls[0])
      expect(state.store.addName).toBe("Another new form")
      expect(state.store.addUnconfirmed).toBe(false)
    },
  )
})

test("C113 replacement snapshot accepts the new entity's own catalog in one reload", () => {
  let latest = snapshot()
  return withState({ sync: () => Promise.resolve(latest) }, async (state) => {
    state.setDraft("review", "name", "Old unsaved input")
    latest = snapshot(3, auth(3, [vendor("review", "replacement-entity")]), [managed("replacement-model")])
    await state.reload()
    expect(state.vendors()[0]?.entityId).toBe("replacement-entity")
    expect(state.draft(state.vendors()[0]!).name).toBe("Review")
    expect(state.store.managed.map((item) => item.modelId)).toEqual(["replacement-model"])
  })
})

test("C112/C115 modern sync protects a locally changing slice while accepting an unchanged sibling", () => {
  const reading = gate<ReturnType<typeof snapshot>>()
  const committed = gate<ReturnType<typeof snapshot>["managed"]>()
  const both = auth(1, [vendor(), vendor("other")])
  const initial = snapshot(1, both, [managed("old"), managed("other-old", "other")])
  let calls = 0
  return withState(
    {
      get: () => Promise.resolve(both),
      sync: () => {
        calls++
        return calls === 1
          ? Promise.resolve(initial)
          : calls === 2
            ? reading.promise
            : Promise.resolve(
                snapshot(3, both, [{ ...managed("old"), visible: false }, managed("other-fresh", "other")]),
              )
      },
      visibility: () => committed.promise,
    },
    async (state) => {
      const oldRead = state.reload()
      const writing = state.setVisible("review", "old", false)
      await wait(() => calls === 2)
      await Bun.sleep(0)
      reading.resolve(snapshot(2, both, [managed("stale-review"), managed("other-fresh", "other")]))
      await oldRead
      expect(state.store.managed.filter((item) => item.vendorId === "review").map((item) => item.modelId)).toEqual([
        "old",
      ])
      expect(state.store.managed.filter((item) => item.vendorId === "other").map((item) => item.modelId)).toEqual([
        "other-fresh",
      ])
      committed.resolve([managed("unversioned-write-result")])
      await writing
      expect(state.isVisible("review", "old")).toBe(false)
      expect(state.store.managed.map((item) => item.modelId)).not.toContain("unversioned-write-result")
    },
  )
})

test("C115 a stale auth snapshot can contribute an unchanged vendor without reverting a changed vendor", () => {
  const reading = gate<ReturnType<typeof snapshot>>()
  const both = auth(1, [vendor(), vendor("other")])
  const staleAuth = structuredClone(both)
  let calls = 0
  return withState(
    {
      get: () => Promise.resolve(both),
      sync: () =>
        ++calls === 1
          ? Promise.resolve(snapshot(1, both, [managed("old"), managed("other-old", "other")]))
          : reading.promise,
    },
    async (state) => {
      const pending = state.reload()
      state.applyAuth(auth(3, [vendor("review", "entity:review", 2, "Changed"), vendor("other")]))
      reading.resolve(snapshot(4, staleAuth, [managed("stale-review"), managed("other-fresh", "other")]))
      await pending
      expect(state.store.auth?.revision).toBe(3)
      expect(state.vendors()[0]?.name).toBe("Changed")
      expect(state.store.managed.filter((item) => item.vendorId === "review").map((item) => item.modelId)).toEqual([
        "old",
      ])
      expect(state.store.managed.filter((item) => item.vendorId === "other").map((item) => item.modelId)).toEqual([
        "other-fresh",
      ])
    },
  )
})

test("C114 historical null syncs serialize and generation reset rejects a late numeric response", () => {
  const first = gate<ReturnType<typeof snapshot>>()
  const late = gate<ReturnType<typeof snapshot>>()
  let calls = 0
  let inFlight = 0
  let maxInFlight = 0
  return withState(
    {
      sync: async () => {
        const call = ++calls
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        try {
          if (call === 2) return await first.promise
          if (call === 4) return await late.promise
          return snapshot(call < 4 ? null : 1)
        } finally {
          inFlight--
        }
      },
    },
    async (state) => {
      const a = state.reload()
      const b = state.reload()
      await wait(() => calls === 2)
      expect(maxInFlight).toBe(1)
      first.resolve(snapshot(null))
      await Promise.all([a, b])
      expect(calls).toBe(3)
      expect(maxInFlight).toBe(1)
      const previousGeneration = state.reload()
      await wait(() => calls === 4)
      state.resetScope()
      await state.reload()
      late.resolve(snapshot(99, auth(99), [managed("retired-generation")]))
      await previousGeneration
      expect(state.store.auth?.revision).toBe(1)
      expect(state.store.managed.map((item) => item.modelId)).toEqual(["old"])
    },
  )
})

test("B2 clearing a key preserves input edited away and back while the clear request is pending", () => {
  const cleared = gate<ReturnType<typeof auth>>()
  return withState({ key: () => cleared.promise }, async (state) => {
    state.setDraft("review", "key", "fake-next-key")
    const removing = state.clearVendorKey(state.vendors()[0]!)
    state.setDraft("review", "key", "different-input")
    state.setDraft("review", "key", "fake-next-key")
    cleared.resolve(auth(2, [{ ...vendor(), hasKey: false }]))
    await removing
    expect(state.draft(state.vendors()[0]!).key).toBe("fake-next-key")
  })
})

test("retired servers remain read-only even when they advertise entity protection", () =>
  createRoot(async (dispose) => {
    const legacy = { ...auth(), capabilities: ["vendor-entity-v1", "vendor-create-receipt-v1"] }
    let writes = 0
    const state = createRelaySettingsState(() => ({
      scope: "legacy",
      generatedApi: {
        "server.relay": {
          get: async () => legacy,
          candidates: async () => [],
          managed: async () => [],
          vendor: async () => {
            writes++
            return legacy
          },
        },
      },
    }))
    try {
      await state.load()
      expect(state.canEdit()).toBe(false)
      expect(state.canAdd()).toBe(false)
      state.setDraft("review", "key", "must-not-submit")
      await expect(state.saveVendor(state.vendors()[0]!)).rejects.toThrow("RELAY_UNSUPPORTED")
      expect(writes).toBe(0)
    } finally {
      dispose()
    }
  }))
