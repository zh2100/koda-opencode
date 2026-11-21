import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { httpFetch } from "../test/relay-http-fetch"
import { make } from "../../client/src/generated/client"
import { createRelaySettingsState } from "../src/hooks/use-relay-settings"

// This suite is run by the owned TCP acceptance launcher, never against a default server.
const live = process.env.ACC_REFRESH_E2E === "1" ? test : test.skip
const baseUrl = "http://127.0.0.1:44096"
const upstream = "http://127.0.0.1:44097"
const api = make({ baseUrl, fetch: httpFetch })["server.relay"]

for (const kind of ["save", "clear"] as const)
  live(`O24/O25/O26/O28/O29 actual hook and TCP preserve the original ${kind} command after a lost ACK`, () =>
    createRoot(async (dispose) => {
      const id = "http-hook-" + crypto.randomUUID()
      const other = id + "-other"
      const seed = await api.vendor({
        vendorId: id,
        name: id,
        baseURL: upstream + "/first",
        key: "fake-owned-key",
        revision: (await api.get()).revision,
      })
      const original = seed.vendors.find((item) => item.id === id)!
      let lose = true
      const commands: string[] = []
      const client = make({
        baseUrl,
        fetch: Object.assign(
          async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
            const url = new URL(String(input))
            const target = url.pathname === "/api/relay/auth/vendors/" + id + (kind === "clear" ? "/key" : "")
            const response = await httpFetch(input, init)
            if (target && init?.method === (kind === "clear" ? "DELETE" : "PUT")) {
              commands.push(String(init.body))
              if (lose) {
                lose = false
                expect(response.ok).toBe(true)
                await response.text()
                throw new Error("owned fixture: ACK lost after actual commit")
              }
            }
            return response
          },
          { preconnect: httpFetch.preconnect },
        ),
      })
      const state = createRelaySettingsState(() => ({
        scope: ("owned-tcp-" + id) as ReturnType<Parameters<typeof createRelaySettingsState>[0]>["scope"],
        generatedApi: client,
      }))
      try {
        await state.load()
        expect(state.store.auth?.capabilities).toContain("vendor-commit-baseline-v1")
        if (kind === "save") state.setDraft(id, "name", id + " saved")
        const act = () =>
          kind === "save"
            ? state.saveVendor(state.vendors().find((item) => item.id === id)!)
            : state.clearVendorKey(state.vendors().find((item) => item.id === id)!)
        await expect(act()).rejects.toBeDefined()
        const committed = await api.get()
        expect(committed.vendors.find((item) => item.id === id)!.revision).toBe(original.revision! + 1)
        await api.vendor({
          vendorId: other,
          name: other,
          baseURL: upstream + "/first",
          key: "fake-owned-other",
          revision: committed.revision,
        })
        if (kind === "clear") {
          await state.reload()
          state.setDraft(id, "key", "fake-owned-successor")
          await state.saveVendor(state.vendors().find((item) => item.id === id)!)
        } else await state.reload()
        const before = await api.get()
        await act()
        expect(commands).toHaveLength(2)
        expect(commands[1] === commands[0]).toBe(true)
        const dto = JSON.parse(commands[0]!)
        expect(dto.revision).toBe(seed.revision)
        expect(dto.expectedEntityId).toBe(original.entityId)
        const after = await api.get()
        expect(after.revision).toBe(before.revision)
        expect(state.store.auth?.revision).toBe(after.revision)
        expect(state.vendors().find((item) => item.id === id)!.hasKey).toBe(true)
        expect(after.vendors.find((item) => item.id === id)!.revision).toBe(
          original.revision! + (kind === "clear" ? 2 : 1),
        )
        expect(state.store.refreshPending).toBe(false)
      } finally {
        dispose()
        for (const vendorId of [id, other]) {
          const current = await api.get()
          const found = current.vendors.find((item) => item.id === vendorId)
          if (found)
            await api.delete({
              vendorId,
              expectedEntityId: found.entityId,
              revision: current.revision,
              operationId: crypto.randomUUID(),
            })
        }
      }
    }),
  )
