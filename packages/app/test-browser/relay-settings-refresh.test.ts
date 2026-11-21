import { expect, test } from "bun:test"
import { createComputed, createRoot } from "solid-js"
import { createRelaySettingsState } from "../src/hooks/use-relay-settings"

const gate = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
const vendor = (revision = 1, name = "Review", baseURL = "https://before.invalid/v1") => ({
  id: "review",
  entityId: "entity:review",
  revision,
  name,
  baseURL,
  hasKey: true,
  builtin: false,
  updatedAt: 0,
})
const auth = (value = vendor()) => ({
  revision: value.revision,
  vendors: [value],
  capabilities: ["independent-vendors-v1", "vendor-entity-v1", "catalog-sync-v1", "vendor-commit-baseline-v1"],
})
const model = {
  vendorId: "review",
  modelId: "fresh",
  visible: true,
  reasoningCapabilities: [],
  assignmentSource: "manual" as const,
  lastSeenAt: 0,
  upstreamPresent: true,
}

for (const edit of ["name", "empty"] as const)
  test(`O01/O02 ${edit} commit carries a connection refresh past an obsolete conflict`, () =>
    createRoot(async (dispose) => {
      let latest = auth()
      let refreshes = 0
      const entered = gate<void>()
      const old = gate<never>()
      const state = createRelaySettingsState(
        () =>
          ({
            scope: "refresh",
            generatedApi: {
              "server.relay": {
                get: async () => latest,
                sync: async () => ({
                  auth: latest,
                  candidates: refreshes > 1 ? [{ ...model, name: "Fresh" }] : [],
                  managed: [],
                  catalogRevision: latest.revision,
                  notice: { status: "idle" },
                }),
                vendor: async (input: { name?: string; baseURL?: string }) =>
                  (latest = auth({ ...latest.vendors[0]!, ...input, revision: latest.revision + 1 })),
                refresh: async () => {
                  refreshes++
                  if (refreshes === 1) {
                    entered.resolve()
                    return old.promise
                  }
                  return []
                },
              },
            },
          }) as never,
      )
      try {
        await state.load()
        state.setDraft("review", "baseURL", "https://after.invalid/v1")
        const saving = state.saveVendor(state.vendors()[0]!).catch(() => undefined)
        await entered.promise
        if (edit === "name") state.setDraft("review", "name", "Renamed")
        await state.saveVendor(state.vendors()[0]!)
        old.reject(new Error("REQUEST_CONFLICT"))
        await saving
        expect(refreshes).toBe(2)
        expect(state.vendorCandidates("review").map((item) => item.modelId)).toEqual(["fresh"])
        expect(state.store.error).toBeUndefined()
      } finally {
        old.reject(new Error("disposed"))
        dispose()
      }
    }))

test("V01 a checkbox ACK after a name commit still reads the committed catalog", () =>
  createRoot(async (dispose) => {
    let latest = auth()
    let visible = false
    let reads = 0
    const entered = gate<void>()
    const ack = gate<(typeof model)[]>()
    const state = createRelaySettingsState(
      () =>
        ({
          scope: "visibility",
          generatedApi: {
            "server.relay": {
              get: async () => latest,
              sync: async () => {
                reads++
                return {
                  auth: latest,
                  candidates: [],
                  managed: visible ? [model] : [],
                  catalogRevision: reads,
                  notice: { status: "idle" },
                }
              },
              vendor: async (input: { name?: string }) =>
                (latest = auth({ ...latest.vendors[0]!, ...input, revision: latest.revision + 1 })),
              visibility: async () => {
                visible = true
                entered.resolve()
                return ack.promise
              },
            },
          },
        }) as never,
    )
    try {
      await state.load()
      const writing = state.setVisible("review", "fresh", true)
      await entered.promise
      state.setDraft("review", "name", "Renamed")
      await state.saveVendor(state.vendors()[0]!)
      const before = reads
      ack.resolve([model])
      await writing
      expect(reads).toBeGreaterThan(before)
      expect(state.isVisible("review", "fresh")).toBe(true)
    } finally {
      ack.resolve([])
      dispose()
    }
  }))

const withApi = (
  extra: Record<string, unknown>,
  run: (state: ReturnType<typeof createRelaySettingsState>) => Promise<void>,
) =>
  createRoot(async (dispose) => {
    const state = createRelaySettingsState(
      () => ({ scope: "late-ack", generatedApi: { "server.relay": extra } }) as never,
    )
    try {
      await state.load()
      await run(state)
    } finally {
      dispose()
    }
  })

for (const later of ["name", "connection", "clear"] as const)
  test(`O15/O21/O22 late connection ACK follows ${later} without reviving covered work`, () => {
    let latest = auth()
    let refreshes = 0
    let writes = 0
    const entered = gate<void>()
    const ack = gate<ReturnType<typeof auth>>()
    return withApi(
      {
        get: async () => latest,
        sync: async () => ({
          auth: latest,
          candidates: refreshes ? [{ ...model, name: "Fresh" }] : [],
          managed: [],
          catalogRevision: latest.revision,
          notice: { status: "idle" },
        }),
        vendor: async (input: { name?: string; key?: string }) => {
          latest = auth({
            ...latest.vendors[0]!,
            name: input.name ?? latest.vendors[0]!.name,
            hasKey: true,
            revision: latest.revision + 1,
          })
          if (++writes === 1) {
            entered.resolve()
            return ack.promise
          }
          return latest
        },
        key: async () => (latest = auth({ ...latest.vendors[0]!, revision: latest.revision + 1, hasKey: false })),
        refresh: async () => {
          refreshes++
          return []
        },
      },
      async (state) => {
        state.setDraft("review", "key", "first")
        const first = state.saveVendor(state.vendors()[0]!)
        await entered.promise
        const committed = latest
        await state.reload()
        if (later === "clear") await state.clearVendorKey(state.vendors()[0]!)
        else {
          // The old command owns its own key. A name-only successor must not resubmit it.
          state.setDraft("review", "key", later === "connection" ? "second" : "")
          state.setDraft("review", "name", "Renamed")
          await state.saveVendor(state.vendors()[0]!)
        }
        const before = refreshes
        ack.resolve(committed)
        await first
        expect(state.vendors()[0]!.revision).toBe(3)
        expect(state.vendors()[0]!.hasKey).toBe(later !== "clear")
        expect(refreshes).toBe(later === "clear" ? 0 : 1)
        if (later === "connection") expect(refreshes).toBe(before)
        expect(state.store.refreshPending).toBe(false)
        expect(state.store.error).toBeUndefined()
      },
    )
  })

test("O23 a late clear ACK cannot cancel a newer key refresh", () => {
  let latest = auth()
  let refreshes = 0
  const entered = gate<void>()
  const ack = gate<ReturnType<typeof auth>>()
  return withApi(
    {
      get: async () => latest,
      sync: async () => ({
        auth: latest,
        candidates: refreshes ? [{ ...model, name: "Fresh" }] : [],
        managed: [],
        catalogRevision: latest.revision,
        notice: { status: "idle" },
      }),
      key: async () => {
        latest = auth({ ...vendor(2), hasKey: false })
        entered.resolve()
        return ack.promise
      },
      vendor: async () => (latest = auth(vendor(3))),
      refresh: async () => {
        refreshes++
        return []
      },
    },
    async (state) => {
      const clearing = state.clearVendorKey(state.vendors()[0]!)
      await entered.promise
      const cleared = latest
      await state.reload()
      state.setDraft("review", "key", "new")
      await state.saveVendor(state.vendors()[0]!)
      ack.resolve(cleared)
      await clearing
      expect(state.vendors()[0]!.hasKey).toBe(true)
      expect(refreshes).toBe(1)
      expect(state.vendorCandidates("review").map((item) => item.modelId)).toEqual(["fresh"])
      expect(state.store.refreshPending).toBe(false)
    },
  )
})

test("O26/O28 an explicit unknown-save retry keeps the original DTO and R/V after a newer read", () => {
  let latest = auth()
  const commands: object[] = []
  let reads = 0
  return withApi(
    {
      get: async () => latest,
      sync: async () => {
        reads++
        return { auth: latest, candidates: [], managed: [], catalogRevision: reads, notice: { status: "idle" } }
      },
      vendor: async (input: object) => {
        commands.push(input)
        if (commands.length === 1) {
          latest = auth(vendor(2, "Saved"))
          throw new Error("response lost after commit")
        }
        return latest
      },
    },
    async (state) => {
      state.setDraft("review", "name", "Saved")
      await state.saveVendor(state.vendors()[0]!).catch(() => undefined)
      latest = auth(vendor(3, "Saved"))
      await state.reload()
      await state.saveVendor(state.vendors()[0]!)
      expect(commands).toHaveLength(2)
      expect(commands[1]).toBe(commands[0])
      expect(commands[1]).toMatchObject({ revision: 1, expectedEntityId: "entity:review", name: "Saved" })
      expect(state.vendors()[0]!.revision).toBe(3)
    },
  )
})

for (const rejectRead of [false, true])
  test(`V03/V05/V06 checkbox writes do not wait behind their catalog read; failed=${rejectRead}`, () => {
    let latest = auth()
    let visible = false
    let writes = 0
    let reads = 0
    const readEntered = gate<void>()
    const oldRead = gate<ReturnType<typeof snapshotFor>>()
    const written = gate<void>()
    const snapshotFor = () => ({
      auth: latest,
      candidates: [],
      managed: visible ? [model] : [],
      catalogRevision: reads,
      notice: { status: "idle" },
    })
    return withApi(
      {
        get: async () => latest,
        sync: async () => {
          reads++
          if (reads === 2) {
            readEntered.resolve()
            return oldRead.promise
          }
          return snapshotFor()
        },
        vendor: async (input: { name: string }) => (latest = auth(vendor(2, input.name))),
        visibility: async (input: { visible: boolean }) => {
          visible = input.visible
          if (++writes === 2) written.resolve()
          return visible ? [model] : []
        },
      },
      async (state) => {
        const first = state.setVisible("review", "fresh", true).catch(() => undefined)
        await readEntered.promise
        const second = state.setVisible("review", "fresh", false).catch(() => undefined)
        state.setDraft("review", "name", "Renamed")
        await state.saveVendor(state.vendors()[0]!)
        await written.promise
        expect(writes).toBe(2)
        if (rejectRead) oldRead.reject(new Error("UPSTREAM_UNREACHABLE"))
        else oldRead.resolve(snapshotFor())
        await Promise.all([first, second])
        // The newer ACK owns a fresh read even when the superseded read failed.
        expect(reads).toBe(3)
        expect(state.store.visibilityPending).toBe(false)
        expect(state.isVisible("review", "fresh")).toBe(false)
        expect(writes).toBe(2)
      },
    )
  })

for (const successor of ["connection", "replacement", "dispose"] as const)
  test(`V07/V08 a retired visibility failure cannot escape to the current dialog: ${successor}`, () => {
    let latest = auth()
    let reads = 0
    const entered = gate<void>()
    const ack = gate<never>()
    return withApi(
      {
        get: async () => latest,
        sync: async () => ({
          auth: latest,
          candidates: [],
          managed: [],
          catalogRevision: ++reads,
          notice: { status: "idle" },
        }),
        visibility: async () => {
          entered.resolve()
          return ack.promise
        },
        vendor: async () => (latest = auth(vendor(2, "Review", "https://after.invalid/v1"))),
        refresh: async () => [],
      },
      async (state) => {
        const result = state.setVisible("review", "fresh", true).then(
          () => "retired",
          () => "escaped",
        )
        await entered.promise
        if (successor === "connection") {
          state.setDraft("review", "baseURL", "https://after.invalid/v1")
          await state.saveVendor(state.vendors()[0]!)
        }
        if (successor === "replacement") {
          latest = auth({ ...vendor(2), entityId: "entity:replacement" })
          await state.reload()
        }
        if (successor === "dispose") state.dispose()
        ack.reject(new Error("old visibility failure"))
        expect(await result).toBe("retired")
        expect(state.store.error).toBeUndefined()
        expect(state.store.visibilityPending).toBe(false)
      },
    )
  })

test("V06 a stable committed checkbox with a failed read retries only the read", () => {
  let reads = 0
  let writes = 0
  return withApi(
    {
      get: async () => auth(),
      sync: async () => {
        if (++reads === 2) throw new Error("UPSTREAM_UNREACHABLE")
        return {
          auth: auth(),
          candidates: [],
          managed: writes ? [model] : [],
          catalogRevision: reads,
          notice: { status: "idle" },
        }
      },
      visibility: async () => {
        writes++
        return [model]
      },
    },
    async (state) => {
      await expect(state.setVisible("review", "fresh", true)).rejects.toThrow()
      expect(state.store.visibilityPending).toBe(true)
      expect(reads).toBe(2)
      await state.reload()
      expect(state.store.visibilityPending).toBe(false)
      expect(state.isVisible("review", "fresh")).toBe(true)
      expect(writes).toBe(1)
    },
  )
})

test("O04 three saves coalesce behind two unfinished transports without dropping the latest target", () => {
  let latest = auth()
  let calls = 0
  let occupied = 0
  let maximum = 0
  const first = gate<never>()
  const second = gate<never>()
  const firstSent = gate<void>()
  const secondSent = gate<void>()
  const finalCommit = gate<void>()
  return withApi(
    {
      get: async () => latest,
      sync: async () => ({
        auth: latest,
        candidates: [{ ...model, name: "Fresh" }],
        managed: [],
        catalogRevision: latest.revision,
        notice: { status: "idle" },
      }),
      vendor: async (input: { name?: string; key?: string }) => {
        latest = auth({
          ...latest.vendors[0]!,
          name: input.name ?? latest.vendors[0]!.name,
          revision: latest.revision + 1,
        })
        if (latest.revision === 4) finalCommit.resolve()
        return latest
      },
      refresh: async () => {
        maximum = Math.max(maximum, ++occupied)
        const call = ++calls
        try {
          if (call === 1) {
            firstSent.resolve()
            return await first.promise
          }
          if (call === 2) {
            secondSent.resolve()
            return await second.promise
          }
          return []
        } finally {
          occupied--
        }
      },
    },
    async (state) => {
      state.setDraft("review", "key", "fake-key")
      const a = state.saveVendor(state.vendors()[0]!)
      await firstSent.promise
      state.setDraft("review", "name", "Second")
      const b = state.saveVendor(state.vendors()[0]!)
      await secondSent.promise
      state.setDraft("review", "name", "Final")
      const c = state.saveVendor(state.vendors()[0]!)
      await finalCommit.promise
      expect(calls).toBe(2)
      first.reject(new Error("REQUEST_CONFLICT"))
      second.reject(new Error("REQUEST_CONFLICT"))
      await Promise.all([a, b, c])
      expect(maximum).toBe(2)
      expect(calls).toBe(3)
      expect(state.vendors()[0]!.name).toBe("Final")
      expect(state.vendorCandidates("review").map((item) => item.modelId)).toEqual(["fresh"])
      expect(state.store.refreshPending).toBe(false)
    },
  )
})

test("O06 a successful empty upstream refresh fulfills the demand without polling", () => {
  let latest = auth()
  let calls = 0
  return withApi(
    {
      get: async () => latest,
      sync: async () => ({
        auth: latest,
        candidates: [],
        managed: [],
        catalogRevision: latest.revision,
        notice: { status: "idle" },
      }),
      vendor: async () => (latest = auth(vendor(latest.revision + 1))),
      refresh: async () => {
        calls++
        return []
      },
    },
    async (state) => {
      state.setDraft("review", "key", "fake-key")
      await state.saveVendor(state.vendors()[0]!)
      expect(calls).toBe(1)
      expect(state.store.refreshPending).toBe(false)
      await state.fetchModels("review")
      expect(calls).toBe(2)
      expect(state.store.status.review).toBe("empty")
      expect(state.store.refreshPending).toBe(false)
      expect(state.store.error).toBeUndefined()
    },
  )
})

test("O14 probe hands a committed key refresh back without waiting for itself", () => {
  let latest = auth()
  let calls = 0
  return withApi(
    {
      get: async () => latest,
      sync: async () => ({
        auth: latest,
        candidates: calls ? [{ ...model, name: "Fresh" }] : [],
        managed: [],
        catalogRevision: latest.revision,
        notice: { status: "idle" },
      }),
      vendor: async () => (latest = auth(vendor(latest.revision + 1))),
      probe: async () => ({ count: 1 }),
      refresh: async () => {
        calls++
        return []
      },
    },
    async (state) => {
      const refreshed = gate<void>()
      let demanded = false
      const stop = createRoot((dispose) => {
        createComputed(() => {
          if (state.store.refreshPending) demanded = true
          if (demanded && !state.store.refreshPending) refreshed.resolve()
        })
        return dispose
      })
      try {
        state.setDraft("review", "key", "fake-key")
        await state.probe("review")
        expect(state.isBusy("testing", "review")).toBe(false)
        await refreshed.promise
        expect(calls).toBe(1)
        expect(state.vendorCandidates("review").map((item) => item.modelId)).toEqual(["fresh"])
        expect(state.store.status.review).toBe("connected")
        expect(state.store.refreshPending).toBe(false)
      } finally {
        stop()
      }
    },
  )
})

for (const phase of ["queued", "sent", "committed"] as const)
  for (const transition of ["clear", "connection", "replacement", "scope", "dispose"] as const)
    test(`V07/V08 modern visibility ${phase} is retired by ${transition}`, () => {
      let latest = auth()
      let calls = 0
      let reads = 0
      const entered = gate<void>()
      const held = gate<(typeof model)[]>()
      const oldRead = gate<{
        auth: ReturnType<typeof auth>
        candidates: (typeof model)[]
        managed: (typeof model)[]
        catalogRevision: number
        notice: { status: "idle" }
      }>()
      return withApi(
        {
          get: async () => latest,
          sync: async () => {
            if (++reads === 2 && phase === "committed") {
              entered.resolve()
              return oldRead.promise
            }
            return { auth: latest, candidates: [], managed: [], catalogRevision: reads, notice: { status: "idle" } }
          },
          visibility: async () => {
            calls++
            if (phase !== "committed") {
              entered.resolve()
              return held.promise
            }
            return [model]
          },
          vendor: async () => (latest = auth(vendor(latest.revision + 1, "Review", "https://after.invalid/v1"))),
          key: async () => (latest = auth({ ...latest.vendors[0]!, revision: latest.revision + 1, hasKey: false })),
        },
        async (state) => {
          const first = state.setVisible("review", "fresh", true)
          await entered.promise
          const second = phase === "queued" ? state.setVisible("review", "fresh", false) : undefined
          if (transition === "clear") await state.clearVendorKey(state.vendors()[0]!)
          if (transition === "connection") {
            state.setDraft("review", "baseURL", "https://after.invalid/v1")
            await state.saveVendor(state.vendors()[0]!, false)
          }
          if (transition === "replacement") state.applyAuth(auth({ ...vendor(2), entityId: "entity:new" }))
          if (transition === "scope") state.resetScope()
          if (transition === "dispose") state.dispose()
          const before = JSON.stringify({
            candidates: state.store.candidates,
            managed: state.store.managed,
            auth: state.store.auth,
            error: state.store.error,
          })
          held.resolve([model])
          oldRead.resolve({
            auth: auth(),
            candidates: [model],
            managed: [model],
            catalogRevision: 100,
            notice: { status: "idle" },
          })
          await Promise.all([first, second])
          expect(calls).toBe(1)
          expect(
            JSON.stringify({
              candidates: state.store.candidates,
              managed: state.store.managed,
              auth: state.store.auth,
              error: state.store.error,
            }),
          ).toBe(before)
          if (transition !== "dispose") expect(state.store.visibilityPending).toBe(false)
        },
      )
    })
