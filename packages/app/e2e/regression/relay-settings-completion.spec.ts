import { expect, request, test } from "@playwright/test"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"

test.skip(process.env.RV_RELAY_E2E !== "1", "Requires the independently started RV backend and isolated data root.")
test.describe.configure({ mode: "serial" })

for (const modern of [false, true])
  test(`committed clear ACK and pending catalog recover in real settings, modern=${modern}`, async ({ page }, info) => {
    const backend = process.env.RV_RELAY_BACKEND
    const data = process.env.RV_RELAY_DATA
    if (backend !== "http://127.0.0.1:44096" || data !== "C:\\relay-rv-fix-20261113\\ui\\data\\opencode")
      throw new Error("Expected the isolated RV backend and data root")
    const api = await request.newContext({ baseURL: backend })
    type Auth = { revision: number; vendors: Array<{ id: string; entityId: string; hasKey: boolean }> }
    const read = async (): Promise<Auth> => {
      const response = await api.get("/api/relay/auth")
      expect(response.ok()).toBe(true)
      const raw = await response.json()
      return raw.data ?? raw
    }
    const id = `rv-ui-${crypto.randomUUID().slice(0, 8)}`
    const sibling = id + "-other"
    const url = "http://127.0.0.1:44097/v1"
    const catalogFile = path.join(data, "relay-catalog.json")
    let restore: string | undefined
    let releaseClear = () => {}
    try {
      for (const target of [id, sibling]) {
        const response = await api.put(`/api/relay/auth/vendors/${target}`, {
          data: { name: target, baseURL: url, key: "fake-ui-initial", revision: (await read()).revision },
        })
        expect(response.ok()).toBe(true)
      }
      expect((await api.post("/api/relay/models/refresh", { data: { vendorId: id } })).ok()).toBe(true)
      await page.clock.setFixedTime(new Date("2026-09-01T00:00:00+08:00"))
      await page.addInitScript(
        ({ modern }) => {
          localStorage.setItem("opencode.global.dat:language", JSON.stringify({ locale: "en" }))
          localStorage.setItem(
            "settings.v3",
            JSON.stringify({
              general: { newLayoutDesigns: modern, layoutTransitionEligible: true, newInterfaceNoticeDismissed: true },
            }),
          )
          localStorage.setItem("app-version.v1", JSON.stringify({ version: "1.18.29" }))
        },
        { modern },
      )
      await page.goto("/", { waitUntil: "domcontentloaded" })
      await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible()
      await page.getByRole("button", { name: "Settings", exact: true }).click()
      const dialog = page.locator(modern ? ".settings-v2-dialog" : ".settings-dialog")
      await dialog.getByRole("tab", { name: "Providers", exact: true }).click()
      const card = dialog.locator(`fieldset[data-vendor-id="${id}"]`)
      await card.locator("summary").click()
      const key = card.locator('input[type="password"]')
      const checkbox = card.getByRole("checkbox", { name: "review-model", exact: true })
      await expect(checkbox).toBeVisible()
      await key.fill("fake-submitted-draft")
      let captured!: () => void
      const clearCaptured = new Promise<void>((resolve) => {
        captured = resolve
      })
      const clearGate = new Promise<void>((resolve) => {
        releaseClear = resolve
      })
      const clearRoute = new RegExp(`/api/relay/auth/vendors/${id}/key(?:\\?.*)?$`)
      await page.route(clearRoute, async (route) => {
        const response = await route.fetch()
        expect(response.ok()).toBe(true)
        captured()
        await clearGate
        await route.fulfill({ response })
      })
      await card.getByRole("button", { name: "Clear key", exact: true }).click()
      await clearCaptured
      const changed = await api.put(`/api/relay/auth/vendors/${sibling}`, {
        data: { name: "Sibling changed", revision: (await read()).revision },
      })
      expect(changed.ok()).toBe(true)
      const synced = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/relay/models/sync")
      await dialog.getByRole("button", { name: "Reload settings", exact: true }).click()
      expect((await synced).ok()).toBe(true)
      await expect(card.getByRole("button", { name: "Clear key", exact: true })).toBeDisabled()
      await expect(key).toHaveValue("fake-submitted-draft")
      releaseClear()
      await expect(key).toHaveValue("")
      await page.unroute(clearRoute)
      const subsequentSave = page.waitForRequest(
        (req) => req.method() === "PUT" && new URL(req.url()).pathname === `/api/relay/auth/vendors/${id}`,
      )
      const savedWithoutKey = page.waitForResponse(
        (res) => res.request().method() === "PUT" && new URL(res.url()).pathname === `/api/relay/auth/vendors/${id}`,
      )
      await card.getByRole("button", { name: "Save", exact: true }).click()
      expect((await subsequentSave).postDataJSON()).not.toHaveProperty("key")
      expect((await savedWithoutKey).ok()).toBe(true)

      restore = await readFile(catalogFile, "utf8")
      await writeFile(catalogFile, "{ controlled-ui-catalog-failure")
      await key.fill("fake-pending-save")
      const pendingResponse = page.waitForResponse(
        (res) => res.request().method() === "PUT" && new URL(res.url()).pathname === `/api/relay/auth/vendors/${id}`,
      )
      await card.getByRole("button", { name: "Save", exact: true }).click()
      const pending = await pendingResponse
      expect(pending.ok()).toBe(true)
      const body = await pending.json()
      expect((body.data ?? body).catalogSync).toEqual({ status: "pending", retryable: true })
      await expect(key).toHaveValue("")
      await expect(
        dialog.getByRole("status").filter({ hasText: "Saved, but the latest configuration could not be loaded." }),
      ).toBeVisible()
      const retry = dialog.getByRole("button", { name: "Retry refresh", exact: true })
      await expect(retry).toBeVisible()
      const committedRevision = (await read()).revision
      await writeFile(catalogFile, restore)
      restore = undefined
      const writes: string[] = []
      const observe = (req: import("@playwright/test").Request) => {
        if (new URL(req.url()).pathname.startsWith("/api/relay/auth/vendors/") && req.method() !== "GET")
          writes.push(req.url())
      }
      page.on("request", observe)
      const recovered = page.waitForResponse((res) => new URL(res.url()).pathname === "/api/relay/models/sync")
      await retry.click()
      const response = await recovered
      expect(response.request().postDataJSON()).toEqual({ retryNotice: true })
      expect(response.ok()).toBe(true)
      await expect(retry).toHaveCount(0)
      await expect(key).toHaveValue("")
      expect((await read()).revision).toBe(committedRevision)
      expect(writes).toEqual([])
      page.off("request", observe)
      const fetched = page.waitForResponse((res) => new URL(res.url()).pathname === "/api/relay/models/refresh")
      await card.getByRole("button", { name: "Get models", exact: true }).click()
      expect((await fetched).ok()).toBe(true)
      await expect(checkbox).toBeVisible()
      const visibility = page.waitForResponse((res) => new URL(res.url()).pathname === "/api/relay/models/visibility")
      await card.getByText("review-model", { exact: true }).click()
      expect((await visibility).ok()).toBe(true)
      await expect(checkbox).toBeChecked()
      await info.attach("rv-real-settings", { body: await page.screenshot(), contentType: "image/png" })
    } finally {
      releaseClear()
      if (restore !== undefined) await writeFile(catalogFile, restore)
      for (const target of [id, sibling]) {
        const latest = await read()
        const item = latest.vendors.find((vendor) => vendor.id === target)
        if (!item) continue
        expect(
          (
            await api.delete(`/api/relay/auth/vendors/${target}`, {
              data: { revision: latest.revision, expectedEntityId: item.entityId },
            })
          ).ok(),
        ).toBe(true)
      }
      await api.dispose()
    }
  })
