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
  scope = () => "protocol-test",
) =>
  createRoot(async (dispose) => {
    const state = createRelaySettingsState(() => ({
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

for (const kind of ["testing", "fetching"] as const) {
  for (const finish of ["first", "second", "failure"] as const)
    test(`FUP-02 ${kind}: cross-vendor busy ownership, ${finish} finishes first`, () => {
      const base = auth(1, [vendor(), vendor("other")])
      const first = gate<{ count: number }>()
      const second = gate<{ count: number }>()
      const requests: string[] = []
      const request = ({ vendorId }: { vendorId: string }) => {
        requests.push(vendorId)
        return vendorId === "review" ? first.promise : second.promise
      }
      return withState(
        {
          sync: () => Promise.resolve(snapshot(1, base, [])),
          vendor: () => Promise.resolve(base),
          refresh: request,
          probe: request,
        },
        async (state) => {
          const start = (id: string) => (kind === "testing" ? state.probe(id) : state.fetchModels(id))
          const a = start("review")
          await wait(() => requests.includes("review"))
          const errors: unknown[] = []
          const b = start("other").catch((error) => {
            errors.push(error)
          })
          try {
            await wait(() => requests.includes("other"))
            expect(state.isBusy(kind, "review")).toBe(true)
            expect(state.isBusy(kind, "other")).toBe(true)
            if (finish === "first") {
              first.resolve({ count: 1 })
              await a
              expect(state.isBusy(kind, "review")).toBe(false)
              expect(state.isBusy(kind, "other")).toBe(true)
            }
            if (finish !== "first") {
              if (finish === "failure") second.reject(new Error("UPSTREAM_UNREACHABLE"))
              else second.resolve({ count: 1 })
              await b
              expect(errors.length).toBe(finish === "failure" ? 1 : 0)
              expect(state.isBusy(kind, "review")).toBe(true)
              expect(state.isBusy(kind, "other")).toBe(false)
            }
          } finally {
            first.resolve({ count: 1 })
            second.resolve({ count: 1 })
            await Promise.allSettled([a, b])
          }
          expect(state.isBusy(kind, "review")).toBe(false)
          expect(state.isBusy(kind, "other")).toBe(false)
        },
      )
    })

  for (const finish of ["older", "newer"] as const)
    test(`FUP-02 ${kind}: only newest same-vendor request owns busy state, ${finish} first`, () => {
      const base = auth()
      const first = gate<{ count: number }>()
      const second = gate<{ count: number }>()
      let calls = 0
      const request = () => (++calls === 1 ? first.promise : second.promise)
      return withState(
        {
          sync: () => Promise.resolve(snapshot(1, base, [])),
          vendor: () => Promise.resolve(base),
          refresh: request,
          probe: request,
        },
        async (state) => {
          const start = () => (kind === "testing" ? state.probe("review") : state.fetchModels("review"))
          const a = start()
          await wait(() => calls === 1)
          const b = start()
          try {
            await wait(() => calls === 2)
            expect(state.isBusy(kind, "review")).toBe(true)
            if (finish === "older") {
              first.resolve({ count: 0 })
              await a
              expect(state.isBusy(kind, "review")).toBe(true)
            }
            if (finish === "newer") {
              second.resolve({ count: 1 })
              await b
              expect(state.isBusy(kind, "review")).toBe(false)
            }
          } finally {
            first.resolve({ count: 0 })
            second.resolve({ count: 1 })
            await Promise.allSettled([a, b])
          }
          expect(state.isBusy(kind, "review")).toBe(false)
        },
      )
    })

  for (const transition of ["scope", "entity", "dispose"] as const)
    test(`FUP-02 ${kind}: old finalizer cannot clear new busy state after ${transition}`, () => {
      let latest = auth()
      let currentScope = "first"
      const first = gate<{ count: number }>()
      const second = gate<{ count: number }>()
      let calls = 0
      const request = () => (++calls === 1 ? first.promise : second.promise)
      return withState(
        {
          sync: () => Promise.resolve(snapshot(latest.revision, latest, [])),
          vendor: () => Promise.resolve(latest),
          refresh: request,
          probe: request,
        },
        async (state) => {
          const start = () => (kind === "testing" ? state.probe("review") : state.fetchModels("review"))
          const a = start()
          await wait(() => calls === 1)
          let b: Promise<unknown> | undefined
          try {
            expect(state.isBusy(kind, "review")).toBe(true)
            if (transition === "scope") {
              currentScope = "second"
              await state.reload()
            }
            if (transition === "entity") {
              latest = auth(2, [vendor("review", "replacement", 2)])
              state.applyAuth(latest)
            }
            if (transition === "dispose") state.dispose()
            expect(state.isBusy(kind, "review")).toBe(false)
            if (transition !== "dispose") {
              b = start()
              await wait(() => calls === 2)
              expect(state.isBusy(kind, "review")).toBe(true)
            }
            first.resolve({ count: 1 })
            await a
            expect(state.isBusy(kind, "review")).toBe(transition !== "dispose")
          } finally {
            first.resolve({ count: 1 })
            second.resolve({ count: 1 })
            await Promise.allSettled([a, b])
          }
          expect(state.isBusy(kind, "review")).toBe(false)
        },
        () => currentScope,
      )
    })
}
