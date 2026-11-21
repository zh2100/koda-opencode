import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createTestState } from "./relay-settings-fixture"
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
  scope = () => "protocol-test",
) =>
  createRoot(async (dispose) => {
    const state = createTestState(() => ({
      scope: scope(),
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

for (const editedAfter of [false, true])
  test(`RV-03 late clear-key ACK settles only its submitted draft, editedAfter=${editedAfter}`, () => {
    const ack = gate<ReturnType<typeof auth>>()
    const base = auth(1, [vendor(), vendor("other")])
    const cleared = { ...vendor("review", "entity:review", 2), hasKey: false }
    const saved = auth(2, [cleared, vendor("other")])
    const newer = auth(3, [cleared, vendor("other", "entity:other", 2, "Other changed")])
    let latest = base
    return withState(
      {
        get: () => Promise.resolve(base),
        sync: () => Promise.resolve(snapshot(latest.revision, latest, [])),
        key: () => ack.promise,
      },
      async (state) => {
        state.setDraft("review", "key", "fake-submitted")
        const clearing = state.clearVendorKey(state.vendors()[0]!)
        if (editedAfter) state.setDraft("review", "key", "fake-new-input")
        latest = newer
        await state.reload()
        ack.resolve(saved)
        await clearing
        console.info("RV-03 observed", {
          editedAfter,
          revision: state.store.auth?.revision,
          hasKey: state.vendors()[0]?.hasKey,
          draftRetained: state.draft(state.vendors()[0]!).key.length > 0,
        })
        expect(state.store.auth?.revision).toBe(3)
        expect(state.vendors()[0]?.hasKey).toBe(false)
        expect(state.draft(state.vendors()[0]!).key).toBe(editedAfter ? "fake-new-input" : "")
      },
    )
  })

test("RV-03 editing a key away and back keeps the user's edit on a late ACK", () => {
  const ack = gate<ReturnType<typeof auth>>()
  const cleared = { ...vendor("review", "entity:review", 2), hasKey: false }
  let latest = auth()
  return withState(
    { sync: () => Promise.resolve(snapshot(latest.revision, latest, [])), key: () => ack.promise },
    async (state) => {
      state.setDraft("review", "key", "fake-submitted")
      const clearing = state.clearVendorKey(state.vendors()[0]!)
      state.setDraft("review", "key", "fake-intermediate")
      state.setDraft("review", "key", "fake-submitted")
      latest = auth(3, [cleared])
      await state.reload()
      ack.resolve(auth(2, [cleared]))
      await clearing
      expect(state.draft(state.vendors()[0]!).key).toBe("fake-submitted")
      expect(state.store.auth?.revision).toBe(3)
    },
  )
})

test("RV-03 a recreated entity keeps its own draft when an old clear ACK arrives", () => {
  const ack = gate<ReturnType<typeof auth>>()
  let latest = auth()
  return withState(
    { sync: () => Promise.resolve(snapshot(latest.revision, latest, [managed("fresh")])), key: () => ack.promise },
    async (state) => {
      state.setDraft("review", "key", "fake-original")
      const clearing = state.clearVendorKey(state.vendors()[0]!)
      latest = auth(3, [vendor("review", "replacement", 1)])
      await state.reload()
      state.setDraft("review", "key", "fake-replacement")
      ack.resolve(auth(2, [{ ...vendor("review", "entity:review", 2), hasKey: false }]))
      await clearing
      expect(state.draft(state.vendors()[0]!).key).toBe("fake-replacement")
      expect(state.store.managed.map((item) => item.modelId)).toEqual(["fresh"])
    },
  )
})

for (const action of ["save", "clear", "delete"] as const)
  test(`RV-04 ${action} acknowledges commit and retries only synchronization`, () => {
    let latest = auth()
    let writes = 0
    let refreshes = 0
    let failSync = false
    let staleSync = false
    const submit = () => {
      writes += 1
      latest = auth(
        2,
        action === "delete" ? [] : [{ ...vendor("review", "entity:review", 2), hasKey: action !== "clear" }],
      )
      return Promise.resolve({ ...latest, catalogSync: { status: "pending", retryable: true } })
    }
    return withState(
      {
        sync: () =>
          failSync
            ? Promise.reject(new Error("SECRET_STORE_UNAVAILABLE"))
            : Promise.resolve(snapshot(latest.revision, staleSync ? auth() : latest, [managed("fresh")])),
        vendor: submit,
        key: submit,
        delete: submit,
        refresh: () => {
          refreshes += 1
          return Promise.resolve([])
        },
      },
      async (state) => {
        state.setDraft("review", "key", "fake-submitted")
        if (action === "save") await state.saveVendor(state.vendors()[0]!)
        if (action === "clear") await state.clearVendorKey(state.vendors()[0]!)
        if (action === "delete") await state.deleteVendor(state.vendors()[0]!)
        expect(state.store.catalogPending).toBe(true)
        expect(state.store.auth?.revision).toBe(2)
        expect(state.store.error).toBeUndefined()
        if (action !== "delete") expect(state.draft(state.vendors()[0]!).key).toBe("")
        failSync = true
        await state.reload()
        expect(state.store.catalogPending).toBe(true)
        expect(state.store.error).toBe("settings.relay.error.SECRET_STORE_UNAVAILABLE")
        failSync = false
        if (action !== "delete") {
          staleSync = true
          await state.reload()
          expect(state.store.catalogPending).toBe(true)
        }
        staleSync = false
        await state.reload()
        expect(state.store.catalogPending).toBe(false)
        expect(state.store.error).toBeUndefined()
        expect(writes).toBe(1)
        expect(refreshes).toBe(action === "save" ? 1 : 0)
      },
    )
  })

test("RV-04 a late pending ACK cannot re-open a synchronization already accepted", () => {
  const ack = gate<ReturnType<typeof auth> & { catalogSync: { status: "pending"; retryable: boolean } }>()
  let latest = auth()
  return withState(
    { vendor: () => ack.promise, sync: () => Promise.resolve(snapshot(latest.revision, latest, [managed("fresh")])) },
    async (state) => {
      state.setDraft("review", "key", "fake-submitted")
      const saving = state.saveVendor(state.vendors()[0]!, false)
      latest = auth(3, [vendor("review", "entity:review", 2)])
      await state.reload()
      ack.resolve({
        ...auth(2, [vendor("review", "entity:review", 2)]),
        catalogSync: { status: "pending", retryable: true },
      })
      await saving
      expect(state.store.catalogPending).toBe(false)
      expect(state.store.managed.map((item) => item.modelId)).toEqual(["fresh"])
      expect(state.draft(state.vendors()[0]!).key).toBe("")
    },
  )
})

test("RV-04 a different server cannot inherit a late committed-pending response", () => {
  const ack = gate<ReturnType<typeof auth> & { catalogSync: { status: "pending"; retryable: boolean } }>()
  let server = "a"
  return withState(
    { vendor: () => ack.promise },
    async (state) => {
      state.setDraft("review", "key", "fake-a")
      const saving = state.saveVendor(state.vendors()[0]!, false)
      server = "b"
      await state.reload()
      state.setDraft("review", "key", "fake-b")
      ack.resolve({ ...auth(2), catalogSync: { status: "pending", retryable: true } })
      await saving
      expect(state.store.catalogPending).toBe(false)
      expect(state.store.auth?.revision).toBe(1)
      expect(state.draft(state.vendors()[0]!).key).toBe("fake-b")
    },
    () => server,
  )
})

test("RV-04 a pending create confirms its receipt and retries only synchronization", () => {
  let latest = auth()
  let writes = 0
  let refreshes = 0
  return withState(
    {
      vendor: (input: { operationId: string; vendorId: string }) => {
        writes += 1
        latest = auth(2, [vendor(), vendor(input.vendorId)])
        return Promise.resolve({
          ...latest,
          catalogSync: { status: "pending", retryable: true },
          operationReceipt: {
            operationId: input.operationId,
            kind: "vendor-create",
            vendorId: input.vendorId,
            entityId: `entity:${input.vendorId}`,
            committedRevision: 2,
          },
        })
      },
      sync: () => Promise.resolve(snapshot(latest.revision, latest, [])),
      refresh: () => {
        refreshes += 1
        return Promise.resolve([])
      },
    },
    async (state) => {
      state.setStore({ addName: "Pending create", addURL: "https://create.invalid/v1", addKey: "fake-create" })
      await state.addVendor()
      expect(state.store.catalogPending).toBe(true)
      expect(state.store.addUnconfirmed).toBe(false)
      expect(state.store.addKey).toBe("")
      expect(state.store.error).toBeUndefined()
      await state.reload()
      expect(state.store.catalogPending).toBe(false)
      expect(writes).toBe(1)
      expect(refreshes).toBe(1)
    },
  )
})

for (const ending of ["failure", "dispose", "scope"] as const)
  test(`RV-03 clearing cannot consume a draft after ${ending}`, () => {
    const ack = gate<ReturnType<typeof auth>>()
    let server = "a"
    return withState(
      { key: () => ack.promise },
      async (state) => {
        state.setDraft("review", "key", "fake-submitted")
        const clearing = state.clearVendorKey(state.vendors()[0]!)
        if (ending === "failure") {
          ack.reject(new Error("KEY_REJECTED"))
          await expect(clearing).rejects.toThrow("KEY_REJECTED")
          expect(state.store.error).toBe("settings.relay.error.KEY_REJECTED")
        } else {
          if (ending === "dispose") state.dispose()
          else {
            server = "b"
            await state.reload()
            state.setDraft("review", "key", "fake-b")
          }
          ack.resolve(auth(2, [{ ...vendor("review", "entity:review", 2), hasKey: false }]))
          await clearing
          expect(state.store.error).toBeUndefined()
        }
        expect(state.store.auth?.revision).toBe(1)
        expect(state.draft(state.vendors()[0]!).key).toBe(ending === "scope" ? "fake-b" : "fake-submitted")
      },
      () => server,
    )
  })
