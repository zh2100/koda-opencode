import { expect, request, test } from "@playwright/test"

test.skip(process.env.BF_RELAY_E2E !== "1", "Requires the independently started BF relay test backend and data root.")
test.describe.configure({ mode: "serial" })

for (const modern of [false, true]) {
  test(`real relay settings: delayed create, normalization and external visibility, modern=${modern}`, async ({
    page,
  }, info) => {
    const api = await request.newContext({ timeout: 15000 })
    const backend = process.env.BF_RELAY_BACKEND
    if (backend !== "http://127.0.0.1:44096") throw new Error("Expected the isolated BF backend")
    const external = process.env.BF_RELAY_EXTERNAL_BACKEND
    if (external !== "http://127.0.0.1:44098") throw new Error("Expected the second isolated BF backend")
    const read = async () => {
      const response = await api.get(backend + "/api/relay/auth")
      expect(response.ok()).toBe(true)
      const raw = await response.json()
      return (raw.data ?? raw) as {
        revision: number
        vendors: Array<{ id: string; entityId: string; baseURL?: string; hasKey: boolean }>
      }
    }
    expect((await read()).vendors).toEqual([])
    const name = `BF ${modern ? "Modern" : "Classic"} ${crypto.randomUUID().slice(0, 8)}`
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-")
    const createdID = id + "-2"
    const upstream = "http://127.0.0.1:44097/v1/new"
    const seeded = await api.put(backend + "/api/relay/auth/vendors/" + id, {
      data: {
        name,
        baseURL: "http://127.0.0.1:44097/v1/original",
        key: "fake-ui-original",
        revision: (await read()).revision,
      },
    })
    expect(seeded.ok()).toBe(true)
    const original = (await read()).vendors.find((vendor) => vendor.id === id)
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    try {
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
      await expect(dialog.getByRole("tab", { name: "Providers", exact: true })).toBeVisible()
      await page.route(/\/api\/relay\/auth(?:\?.*)?$/, async (route) => {
        entered()
        await blocked
        await route.continue()
      })
      await dialog.getByRole("tab", { name: "Providers", exact: true }).click()
      await started
      await dialog.getByRole("textbox", { name: "Vendor name", exact: true }).fill(name)
      await dialog.getByPlaceholder("https://api.myprovider.com/v1", { exact: true }).fill(upstream)
      await dialog.getByLabel("sk-xxxxxx", { exact: true }).fill("fake-ui-created")
      const added = page.waitForResponse(
        (response) =>
          response.request().method() === "PUT" && new URL(response.url()).pathname.endsWith("/vendors/" + createdID),
      )
      await dialog.getByRole("button", { name: "Add vendor", exact: true }).click()
      release()
      expect((await added).ok()).toBe(true)
      await page.unroute(/\/api\/relay\/auth(?:\?.*)?$/)
      await expect(dialog.getByRole("button", { name: "Get API key", exact: true })).toHaveCount(0)
      await expect(dialog.locator('a[href*="leidiandonghua.cn"]')).toHaveCount(0)
      await expect(dialog.getByText("智联AI keys", { exact: true })).toHaveCount(0)
      await expect(dialog.getByText("Use a shared API key", { exact: true })).toHaveCount(0)
      const card = dialog.locator(`fieldset[data-vendor-id="${createdID}"]`)
      await card.locator("summary").click()
      await expect(card.getByRole("textbox", { name: "Vendor name", exact: true })).toHaveValue(name)
      expect((await read()).vendors.find((vendor) => vendor.id === id)).toEqual(original)
      const checkbox = card.getByRole("checkbox", { name: "review-model", exact: true })
      await expect(checkbox).toBeVisible()
      const checked = page.waitForResponse(
        (response) =>
          response.request().method() === "PUT" && new URL(response.url()).pathname === "/api/relay/models/visibility",
      )
      await card.getByText("review-model", { exact: true }).click()
      expect((await checked).ok()).toBe(true)
      await expect(checkbox).toBeChecked()
      const entity = (await read()).vendors.find((vendor) => vendor.id === createdID)!
      const changed = await api.put(external + "/api/relay/models/visibility", {
        data: { vendorId: createdID, modelId: "review-model", visible: false, expectedEntityId: entity.entityId },
      })
      expect(changed.ok()).toBe(true)
      const sync = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/relay/models/sync")
      await dialog.getByRole("button", { name: "Reload settings", exact: true }).click()
      expect((await sync).ok()).toBe(true)
      await expect(checkbox).not.toBeChecked()
      const normalized = name + " Saved"
      await card.getByRole("textbox", { name: "Vendor name", exact: true }).fill(" " + normalized + " ")
      await card.getByPlaceholder("https://api.myprovider.com/v1", { exact: true }).fill(upstream + "///")
      const saved = page.waitForResponse(
        (response) =>
          response.request().method() === "PUT" && new URL(response.url()).pathname.endsWith("/vendors/" + createdID),
      )
      await card.getByRole("button", { name: "Save", exact: true }).click()
      expect((await saved).ok()).toBe(true)
      await expect(card.getByRole("textbox", { name: "Vendor name", exact: true })).toHaveValue(normalized)
      await expect(card.getByPlaceholder("https://api.myprovider.com/v1", { exact: true })).toHaveValue(upstream)
      await expect(checkbox).not.toBeChecked()
      // Let a different real server retire/recreate the entity before an already prepared save reaches Core.
      let allowSave!: () => void
      const saving = new Promise<void>((resolve) => {
        allowSave = resolve
      })
      let reachedSave!: () => void
      const saveStarted = new Promise<void>((resolve) => {
        reachedSave = resolve
      })
      const vendorRoute = new RegExp("/api/relay/auth/vendors/" + createdID + "(?:\\?.*)?$")
      const refreshes: string[] = []
      const recordRefresh = (request: import("@playwright/test").Request) => {
        if (new URL(request.url()).pathname === "/api/relay/models/refresh") refreshes.push(request.url())
      }
      page.on("request", recordRefresh)
      await page.route(vendorRoute, async (route) => {
        expect(route.request().postDataJSON().expectedEntityId).toBe(entity.entityId)
        reachedSave()
        await saving
        await route.continue()
      })
      try {
        const rejected = page.waitForResponse(
          (response) =>
            response.request().method() === "PUT" && new URL(response.url()).pathname.endsWith("/vendors/" + createdID),
        )
        await card.getByRole("button", { name: "Get models", exact: true }).click()
        await saveStarted
        const current = await read()
        const removed = await api.delete(external + "/api/relay/auth/vendors/" + createdID, {
          data: { revision: current.revision, expectedEntityId: entity.entityId },
        })
        expect(removed.ok()).toBe(true)
        const rebuilt = await api.put(external + "/api/relay/auth/vendors/" + createdID, {
          data: {
            name: normalized,
            baseURL: upstream,
            key: "fake-ui-replacement",
            revision: (await read()).revision,
            createOnly: true,
            operationId: crypto.randomUUID(),
          },
        })
        expect(rebuilt.ok()).toBe(true)
        allowSave()
        expect((await rejected).status()).toBe(409)
        await expect(card.getByRole("button", { name: "Get models", exact: true })).toBeEnabled()
        expect(refreshes).toEqual([])
      } finally {
        allowSave()
        await page.unroute(vendorRoute)
        page.off("request", recordRefresh)
      }
      const replacementSync = page.waitForResponse(
        (response) => new URL(response.url()).pathname === "/api/relay/models/sync",
      )
      await dialog.getByRole("button", { name: "Reload settings", exact: true }).click()
      expect((await replacementSync).ok()).toBe(true)
      await expect(checkbox).toHaveCount(0)
      await expect(card.getByRole("textbox", { name: "Vendor name", exact: true })).toHaveValue(normalized)
      const fetched = page.waitForResponse(
        (response) => new URL(response.url()).pathname === "/api/relay/models/refresh",
      )
      await card.getByRole("button", { name: "Get models", exact: true }).click()
      expect((await fetched).ok()).toBe(true)
      await expect(checkbox).toBeVisible()
      await expect(checkbox).not.toBeChecked()
      await info.attach("real-relay-settings", { body: await page.screenshot(), contentType: "image/png" })
    } finally {
      release()
      try {
        for (const target of [createdID, id]) {
          const current = await read()
          const vendor = current.vendors.find((vendor) => vendor.id === target)
          if (!vendor) continue
          const removed = await api.delete(backend + "/api/relay/auth/vendors/" + target, {
            data: { revision: current.revision, expectedEntityId: vendor.entityId },
          })
          expect(removed.ok()).toBe(true)
        }
      } finally {
        await api.dispose()
      }
    }
  })
}
