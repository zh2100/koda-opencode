import { expect, test } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"

for (const modern of [false, true]) {
  test(`provider disclosure, model columns and scroll retention in the ${modern ? "modern" : "classic"} layout`, async ({ page }) => {
    const vendorId = "layout-test"
    const vendor = {
      id: vendorId, entityId: "layout-entity", name: "Layout test", baseURL: "https://example.invalid/v1",
      builtin: false, hasKey: true, updatedAt: 1, revision: 1,
    }
    const auth = { vendors: [vendor], revision: 1, capabilities: ["independent-vendors-v1", "vendor-entity-v1", "catalog-sync-v1"] }
    const candidates = Array.from({ length: 150 }, (_, i) => ({
      vendorId, modelId: `model-${i}`, upstreamPresent: true, fetchedAt: 1, assignmentSource: "manual",
    }))
    let selected = false
    let revision = 1
    const modelId = "model-125"
    const managed = () => [{ vendorId, modelId, visible: selected, reasoningCapabilities: [], assignmentSource: "manual", lastSeenAt: 1, upstreamPresent: true }]
    await mockOpenCodeServer(page, {
      protocol: "v2",
      directory: "/layout", project: { id: "layout", worktree: "/layout", time: { created: 1, updated: 1 } },
      sessions: [], provider: { all: [], connected: [], default: {} }, pageMessages: () => ({ items: [] }),
    })
    await page.route("**/api/relay/auth", route => route.fulfill({ json: auth }))
    await page.route("**/api/relay/models/sync", route => route.fulfill({
      json: { auth, candidates, managed: managed(), catalogRevision: revision, notice: { status: "idle" } },
    }))
    await page.route("**/api/relay/models/visibility", route => {
      const change = route.request().postDataJSON()
      expect(change).toMatchObject({ vendorId, modelId, expectedEntityId: vendor.entityId })
      selected = change.visible
      revision++
      return route.fulfill({ json: managed() })
    })
    if (!modern) await page.clock.setFixedTime(new Date("2026-09-01T00:00:00+08:00"))
    await page.addInitScript(modern => {
      localStorage.setItem("opencode.global.dat:language", JSON.stringify({ locale: "en" }))
      localStorage.setItem("app-version.v1", JSON.stringify({ version: "1.18.29" }))
      localStorage.setItem("settings.v3", JSON.stringify({ general: {
        newLayoutDesigns: modern, layoutTransitionEligible: true, newInterfaceNoticeDismissed: true, shouldDisplayTabsToast: false,
      } }))
    }, modern)
    await page.goto("/")
    await page.getByRole("button", { name: "Settings", exact: true }).click()
    const dialog = page.locator(modern ? ".settings-v2-dialog" : ".settings-dialog")
    await dialog.getByRole("tab", { name: "Providers", exact: true }).click()
    const card = dialog.locator(`fieldset[data-vendor-id="${vendorId}"]`)
    const summary = card.locator("summary")
    const box = card.getByRole("checkbox", { name: modelId, exact: true })
    await expect(summary).toBeVisible()
    await expect(box).toBeHidden()
    await summary.click()
    const grid = card.locator(".settings-provider-model-grid")
    const columns = () => grid.evaluate(el => getComputedStyle(el).gridTemplateColumns.split(" ").length)
    await expect.poll(columns).toBe(3)
    await page.setViewportSize({ width: 720, height: 640 })
    await expect.poll(columns).toBe(2)
    const label = card.getByText(modelId, { exact: true })
    await label.scrollIntoViewIfNeeded()
    const position = () => label.evaluate(el => {
      for (let parent = el.parentElement; parent; parent = parent.parentElement) {
        if (parent.scrollHeight > parent.clientHeight && /auto|scroll/.test(getComputedStyle(parent).overflowY))
          return parent.scrollTop
      }
      return 0
    })
    const before = await position()
    expect(before).toBeGreaterThan(100)
    for (const checked of [true, false]) {
      const synced = page.waitForResponse(res => new URL(res.url()).pathname === "/api/relay/models/sync" && res.ok())
      await label.click()
      await synced
      await expect(box).toBeChecked({ checked })
      await expect(box).toBeFocused()
      expect(Math.abs((await position()) - before)).toBeLessThan(2)
    }
    await summary.click()
    await expect(box).toBeHidden()
  })
}
