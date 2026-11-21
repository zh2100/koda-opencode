import { expect, request, test, type Request } from "@playwright/test"
import { readFile } from "node:fs/promises"
import path from "node:path"

test.skip(process.env.ACC_REFRESH_E2E !== "1", "Requires isolated acceptance services and data root")
const primary = "http://127.0.0.1:44096"
const upstream = "http://127.0.0.1:44097"
const gate = () => {
  const promise = Promise.withResolvers<void>()
  return { ready: promise.promise, release: () => promise.resolve() }
}
type Auth = {
  revision: number
  vendors: Array<{ id: string; entityId: string; revision: number; name: string; baseURL: string }>
}

for (const modern of [false, true]) {
  for (const action of ["fetch", "save"] as const) {
    test(`OBS-01 auto refresh held before dispatch, next=${action}, modern=${modern}`, async ({ page }, info) => {
      const api = await request.newContext({ timeout: 30000 })
      const id = "obs-" + crypto.randomUUID().slice(0, 8)
      const block = gate()
      const entered = gate()
      const finished = gate()
      const actions: Array<{ action: string; method: string; status: number; revision?: number }> = []
      const errors: string[] = []
      let first = true
      let held: Request | undefined
      const read = async (): Promise<Auth> => {
        const response = await api.get(primary + "/api/relay/auth")
        expect(response.ok()).toBe(true)
        const raw = await response.json()
        return raw.data ?? raw
      }
      page.on("pageerror", (error) => errors.push(error.message))
      try {
        const seeded = await api.put(primary + "/api/relay/auth/vendors/" + id, {
          data: {
            name: id,
            baseURL: upstream + "/first",
            key: "fake-obs-acceptance",
            revision: (await read()).revision,
          },
        })
        expect(seeded.ok()).toBe(true)
        await page.clock.setFixedTime(new Date("2026-09-01T00:00:00+08:00"))
        await page.addInitScript(
          ({ modern }) => {
            localStorage.setItem("opencode.global.dat:language", JSON.stringify({ locale: "en" }))
            localStorage.setItem(
              "settings.v3",
              JSON.stringify({
                general: {
                  newLayoutDesigns: modern,
                  layoutTransitionEligible: true,
                  newInterfaceNoticeDismissed: true,
                },
              }),
            )
            localStorage.setItem("app-version.v1", JSON.stringify({ version: "1.18.29" }))
          },
          { modern },
        )
        await page.goto("/", { waitUntil: "domcontentloaded" })
        await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeEnabled()
        await page.getByRole("button", { name: "Settings", exact: true }).click()
        const dialog = page.locator(modern ? ".settings-v2-dialog" : ".settings-dialog")
        await dialog.getByRole("tab", { name: "Providers", exact: true }).click()
        const card = dialog.locator(`fieldset[data-vendor-id="${id}"]`)
        await card.locator("summary").click()
        const name = card.getByRole("textbox", { name: "Vendor name", exact: true })
        await expect(name).toHaveValue(id)
        await expect(dialog.getByRole("button", { name: "Reload settings", exact: true })).toBeEnabled()
        await page.route(primary + "/api/relay/models/refresh", async (route) => {
          const body = route.request().postDataJSON()
          if (body.vendorId !== id || !first) return route.continue()
          first = false
          held = route.request()
          entered.release()
          await block.ready
          try {
            const response = await route.fetch()
            actions.push({
              action: "auto-refresh",
              method: "POST",
              status: response.status(),
              revision: body.expectedVendorRevision,
            })
            await route.fulfill({ response })
          } finally {
            finished.release()
          }
        })
        await card.getByPlaceholder("https://api.myprovider.com/v1", { exact: true }).fill(upstream + "/second")
        const saveResponse = page.waitForResponse(
          (response) =>
            response.request().method() === "PUT" &&
            new URL(response.url()).pathname === "/api/relay/auth/vendors/" + id,
        )
        await card.getByRole("button", { name: "Save", exact: true }).click()
        const saved = await saveResponse
        expect(saved.ok()).toBe(true)
        actions.push({ action: "address-save", method: "PUT", status: saved.status() })
        await entered.ready
        // The automatic refresh has not reached the server. The next action
        // must own its own request and finish before fixture cleanup begins.
        if (action === "fetch") {
          const manual = page.waitForResponse(
            (response) => new URL(response.url()).pathname === "/api/relay/models/refresh",
          )
          await card.getByRole("button", { name: "Get models", exact: true }).click()
          const response = await manual
          expect(response.ok()).toBe(true)
          actions.push({ action: "manual-refresh", method: "POST", status: response.status() })
          await expect(card.getByRole("button", { name: "Get models", exact: true })).toBeEnabled()
          await expect(card.getByRole("checkbox", { name: "model-second", exact: true })).toBeVisible()
        } else {
          await name.fill(id + " renamed")
          const secondSave = page.waitForResponse(
            (response) =>
              response.request().method() === "PUT" &&
              new URL(response.url()).pathname === "/api/relay/auth/vendors/" + id,
          )
          await card.getByRole("button", { name: "Save", exact: true }).click()
          const response = await secondSave
          expect(response.ok()).toBe(true)
          actions.push({ action: "name-save", method: "PUT", status: response.status() })
          await expect(name).toHaveValue(id + " renamed")
        }
        // The follow-up refresh can finish before the old one is released.
        // Observe the held request, rather than whichever refresh responds next.
        const autoResponse = page.waitForResponse((response) => response.request() === held)
        block.release()
        expect((await autoResponse).status()).toBe(409)
        await finished.ready
        await expect(card.getByRole("checkbox", { name: "model-second", exact: true })).toBeVisible()
        await expect(card.getByRole("checkbox", { name: "model-first", exact: true })).toHaveCount(0)
        await expect(dialog.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0)
        await expect(page.getByText("Request failed", { exact: true })).toHaveCount(0)
        const auth = await read()
        const vendor = auth.vendors.find((item) => item.id === id)!
        expect(vendor.baseURL).toBe(upstream + "/second")
        expect(vendor.name).toBe(action === "save" ? id + " renamed" : id)
        const root = process.env.ACC_REFRESH_DATA_ROOT
        if (!root || !path.resolve(root).includes("opencode-acc-next-")) throw new Error("Missing isolated data root")
        const disk = JSON.parse(await readFile(path.join(root, "relay-auth.json"), "utf8"))
        expect(disk.vendors[id]).toMatchObject({ name: vendor.name, baseURL: vendor.baseURL })
        expect(errors).toEqual([])
        await info.attach("page-state", { body: await dialog.screenshot(), contentType: "image/png" })
      } finally {
        block.release()
        try {
          await page.unrouteAll({ behavior: "wait" })
          const auth = await read()
          const vendor = auth.vendors.find((item) => item.id === id)
          const root = process.env.ACC_REFRESH_DATA_ROOT
          if (!root || !path.resolve(root).includes("opencode-acc-next-")) throw new Error("Missing isolated data root")
          const disk = JSON.parse(await readFile(path.join(root, "relay-auth.json"), "utf8"))
          const syncResponse = await api.post(primary + "/api/relay/models/sync", { data: {} })
          expect(syncResponse.ok()).toBe(true)
          const sync = await syncResponse.json()
          await info.attach("settled-state", {
            body: JSON.stringify(
              {
                vendor,
                disk: {
                  name: disk.vendors[id]?.name,
                  baseURL: disk.vendors[id]?.baseURL,
                  revision: disk.vendors[id]?.revision,
                },
                candidates: (sync.data ?? sync).candidates.filter(
                  (item: { vendorId?: string }) => item.vendorId === id,
                ),
              },
              null,
              2,
            ),
            contentType: "application/json",
          })
          // Destroy the page owner before deleting the fixture, so a later
          // refresh cannot create a misleading cleanup conflict.
          await page.close()
          if (vendor) {
            const response = await api.delete(primary + "/api/relay/auth/vendors/" + id, {
              data: { revision: (await read()).revision, expectedEntityId: vendor.entityId },
            })
            actions.push({ action: "fixture-delete", method: "DELETE", status: response.status() })
            expect(response.ok()).toBe(true)
          }
        } finally {
          await info.attach("action-results", {
            body: JSON.stringify({ actions, errors }, null, 2),
            contentType: "application/json",
          })
          await api.dispose()
        }
      }
    })
  }
}
