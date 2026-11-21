import { expect, request, test, type Page } from "@playwright/test"

test.skip(process.env.FUP_RELAY_E2E !== "1", "Requires isolated FUP backends and a local test upstream.")
test.describe.configure({ mode: "default" })

const primary = "http://127.0.0.1:44096"
const secondary = "http://127.0.0.1:44098"
const upstream = "http://127.0.0.1:44097"
test.beforeAll(async () => {
  const api = await request.newContext({ timeout: 5000 })
  try {
    for (const url of [primary + "/global/health", secondary + "/global/health", "http://127.0.0.1:44444/"]) {
      await expect
        .poll(
          async () =>
            api
              .get(url)
              .then((response) => response.status())
              .catch(() => 0),
          { timeout: 60000 },
        )
        .toBe(200)
    }
  } finally {
    await api.dispose()
  }
})
const gate = () => {
  let release!: () => void
  const ready = new Promise<void>((resolve) => {
    release = resolve
  })
  return { ready, release }
}
const prepare = async (page: Page, modern: boolean) => {
  await page.clock.setFixedTime(new Date("2026-09-01T00:00:00+08:00"))
  await page.addInitScript(
    ({ modern, secondary }) => {
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
      localStorage.setItem("opencode.global.dat:server", JSON.stringify({ list: [secondary] }))
    },
    { modern, secondary },
  )
  await page.goto("/", { waitUntil: "domcontentloaded" })
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeEnabled()
}
const openProviders = async (page: Page, modern: boolean) => {
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const dialog = page.locator(modern ? ".settings-v2-dialog" : ".settings-dialog")
  await dialog.getByRole("tab", { name: "Providers", exact: true }).click()
  await expect(dialog.getByRole("button", { name: "Reload settings", exact: true })).toBeEnabled()
  return dialog
}

for (const modern of [false, true]) {
  for (const finish of ["first", "second", "failure"] as const)
    test(`FUP-02 real settings: independent busy rows, ${finish} completes first, modern=${modern}`, async ({
      page,
    }, info) => {
      const api = await request.newContext({ baseURL: primary, timeout: 20000 })
      const read = async () => {
        const response = await api.get("/api/relay/auth")
        expect(response.ok()).toBe(true)
        const body = await response.json()
        return (body.data ?? body) as { revision: number; vendors: Array<{ id: string; entityId: string }> }
      }
      const prefix = "fup-" + crypto.randomUUID().slice(0, 8)
      const ids = [prefix + "-a", prefix + "-b"]
      const gates = ids.map(() => gate())
      const entered = new Set<string>()
      const errors: string[] = []
      page.on("pageerror", (error) => errors.push(error.message))
      try {
        for (const [index, id] of ids.entries()) {
          const result = await api.put("/api/relay/auth/vendors/" + id, {
            data: {
              name: id,
              key: "fake-fup-ui",
              revision: (await read()).revision,
              baseURL: upstream + (index === 0 ? "/first" : finish === "failure" ? "/failure" : "/second"),
            },
          })
          expect(result.ok()).toBe(true)
        }
        await prepare(page, modern)
        const dialog = await openProviders(page, modern)
        const cards = ids.map((id) => dialog.locator(`fieldset[data-vendor-id="${id}"]`))
        for (const card of cards) await card.locator("summary").click()
        for (const card of cards)
          await expect(card.getByRole("button", { name: "Get models", exact: true })).toBeEnabled()
        await page.route("**/api/relay/models/refresh", async (route) => {
          const id = route.request().postDataJSON().vendorId as string
          const index = ids.indexOf(id)
          if (index < 0) return route.continue()
          entered.add(id)
          await gates[index].ready
          await route.continue()
        })
        for (const [index, card] of cards.entries()) {
          await card.getByRole("button", { name: "Get models", exact: true }).click()
          await expect.poll(() => entered.has(ids[index])).toBe(true)
        }
        for (const card of cards)
          await expect(card.getByRole("button", { name: "Fetching...", exact: true })).toBeDisabled()
        await info.attach("both-refreshing", { body: await dialog.screenshot(), contentType: "image/png" })
        const done = finish === "first" ? 0 : 1
        const pending = 1 - done
        const responseFor = (index: number) =>
          page.waitForResponse(
            (response) =>
              new URL(response.url()).pathname === "/api/relay/models/refresh" &&
              response.request().postDataJSON().vendorId === ids[index],
          )
        const firstResponse = responseFor(done)
        gates[done].release()
        const response = await firstResponse
        expect(response.ok()).toBe(finish !== "failure")
        if (finish === "failure") {
          expect(await response.text()).toContain("UPSTREAM_UNREACHABLE")
          await expect(dialog.getByText("The upstream is unreachable", { exact: true })).toBeVisible()
        }
        await expect(cards[done].getByRole("button", { name: "Get models", exact: true })).toBeEnabled()
        await expect(cards[pending].getByRole("button", { name: "Fetching...", exact: true })).toBeDisabled()
        await cards[pending].getByRole("button", { name: "Fetching...", exact: true }).scrollIntoViewIfNeeded()
        await info.attach("one-still-refreshing", { body: await dialog.screenshot(), contentType: "image/png" })
        const finalResponse = responseFor(pending)
        gates[pending].release()
        expect((await finalResponse).ok()).toBe(true)
        for (const card of cards)
          await expect(card.getByRole("button", { name: "Get models", exact: true })).toBeEnabled()
        await expect(cards[0].getByRole("checkbox", { name: "model-first", exact: true })).toBeVisible()
        if (finish !== "failure")
          await expect(cards[1].getByRole("checkbox", { name: "model-second", exact: true })).toBeVisible()
        expect(errors).toEqual([])
        await info.attach("completed", { body: await dialog.screenshot(), contentType: "image/png" })
      } finally {
        gates.forEach((item) => item.release())
        try {
          await page.unrouteAll({ behavior: "wait" })
        } finally {
          try {
            for (const id of ids) {
              const current = await read()
              const vendor = current.vendors.find((item) => item.id === id)
              if (!vendor) continue
              const removed = await api.delete("/api/relay/auth/vendors/" + id, {
                data: { revision: current.revision, expectedEntityId: vendor.entityId },
              })
              expect(removed.ok()).toBe(true)
            }
          } finally {
            await api.dispose()
          }
        }
      }
    })
}
for (const modern of [false, true])
  test(`FUP-02 real settings: reopening isolates late refresh, modern=${modern}`, async ({ page }, info) => {
    const api = await request.newContext({ baseURL: primary, timeout: 20000 })
    const id = "fup-reopen-" + crypto.randomUUID().slice(0, 8)
    const gates = [gate(), gate()]
    const errors: string[] = []
    let entered = 0
    const revisions: number[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    const read = async () => {
      const response = await api.get("/api/relay/auth")
      expect(response.ok()).toBe(true)
      const raw = await response.json()
      return (raw.data ?? raw) as { revision: number; vendors: Array<{ id: string; entityId: string }> }
    }
    try {
      const response = await api.put("/api/relay/auth/vendors/" + id, {
        data: {
          name: id,
          key: "fake-fup-reopen",
          baseURL: upstream + "/first",
          revision: (await read()).revision,
        },
      })
      expect(response.ok()).toBe(true)
      await prepare(page, modern)
      await page.route("**/api/relay/models/refresh", async (route) => {
        if (route.request().postDataJSON().vendorId !== id) return route.continue()
        revisions.push(route.request().postDataJSON().expectedVendorRevision as number)
        const index = entered++
        expect(index).toBeLessThan(gates.length)
        await gates[index].ready
        await route.continue()
      })
      const oldDialog = await openProviders(page, modern)
      const oldCard = oldDialog.locator(`fieldset[data-vendor-id="${id}"]`)
      await oldCard.locator("summary").click()
      await oldCard.getByRole("button", { name: "Get models", exact: true }).click()
      await expect.poll(() => entered).toBe(1)
      await expect(oldCard.getByRole("button", { name: "Fetching...", exact: true })).toBeDisabled()
      await page.keyboard.press("Escape")
      await expect(oldDialog).toBeHidden()
      const dialog = await openProviders(page, modern)
      const card = dialog.locator(`fieldset[data-vendor-id="${id}"]`)
      await card.locator("summary").click()
      await expect(card.getByRole("button", { name: "Get models", exact: true })).toBeEnabled()
      await card.getByRole("button", { name: "Get models", exact: true }).click()
      await expect.poll(() => entered).toBe(2)
      await expect(card.getByRole("button", { name: "Fetching...", exact: true })).toBeDisabled()
      const responseFor = () =>
        page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === "/api/relay/models/refresh" &&
            response.request().postDataJSON().vendorId === id,
        )
      const oldResponse = responseFor()
      gates[0].release()
      // The newer Get models saves a new vendor revision, so the delayed request must conflict.
      expect(revisions[1]).toBeGreaterThan(revisions[0])
      const stale = await oldResponse
      expect(stale.status()).toBe(409)
      expect(await stale.json()).toMatchObject({ message: "REQUEST_CONFLICT", resource: "relay.auth" })
      await expect(card.getByRole("button", { name: "Fetching...", exact: true })).toBeDisabled()
      await info.attach("old-response-keeps-new-refresh-busy", {
        body: await dialog.screenshot(),
        contentType: "image/png",
      })
      const newResponse = responseFor()
      gates[1].release()
      expect((await newResponse).ok()).toBe(true)
      await expect(card.getByRole("button", { name: "Get models", exact: true })).toBeEnabled()
      await expect(card.getByRole("checkbox", { name: "model-first", exact: true })).toBeVisible()
      expect(errors).toEqual([])
    } finally {
      gates.forEach((item) => item.release())
      try {
        await page.unrouteAll({ behavior: "wait" })
      } finally {
        try {
          const current = await read()
          const vendor = current.vendors.find((item) => item.id === id)
          if (vendor) {
            const response = await api.delete("/api/relay/auth/vendors/" + id, {
              data: { revision: current.revision, expectedEntityId: vendor.entityId },
            })
            expect(response.ok()).toBe(true)
          }
        } finally {
          await api.dispose()
        }
      }
    }
  })

test("FUP-02 real settings: modern server picker isolates late refresh", async ({ page }, info) => {
  const api = await request.newContext({ timeout: 20000 })
  const id = "fup-picker-" + crypto.randomUUID().slice(0, 8)
  const gates = [gate(), gate()]
  const entered = new Set<string>()
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  const read = async (server: string) => {
    const response = await api.get(server + "/api/relay/auth")
    expect(response.ok()).toBe(true)
    const raw = await response.json()
    return (raw.data ?? raw) as { revision: number; vendors: Array<{ id: string; entityId: string }> }
  }
  try {
    for (const [index, server] of [primary, secondary].entries()) {
      const response = await api.put(server + "/api/relay/auth/vendors/" + id, {
        data: {
          name: index === 0 ? "Picker primary" : "Picker secondary",
          key: "fake-fup-picker",
          baseURL: upstream + (index === 0 ? "/first" : "/second"),
          revision: (await read(server)).revision,
        },
      })
      expect(response.ok()).toBe(true)
    }
    await prepare(page, true)
    const dialog = await openProviders(page, true)
    await page.route("**/api/relay/models/refresh", async (route) => {
      if (route.request().postDataJSON().vendorId !== id) return route.continue()
      const origin = new URL(route.request().url()).origin
      entered.add(origin)
      await gates[origin === primary ? 0 : 1].ready
      await route.continue()
    })
    const card = dialog.locator(`fieldset[data-vendor-id="${id}"]`)
    await card.locator("summary").click()
    await expect(card.getByRole("textbox", { name: "Vendor name", exact: true })).toHaveValue("Picker primary")
    await card.getByRole("button", { name: "Get models", exact: true }).click()
    await expect.poll(() => entered.has(primary)).toBe(true)
    await expect(card.getByRole("button", { name: "Fetching...", exact: true })).toBeDisabled()
    await dialog.getByRole("button", { name: /127\.0\.0\.1:44096/ }).click()
    const target = page.getByRole("menuitemradio", { name: /127\.0\.0\.1:44098/ })
    await expect(target).toBeEnabled()
    await target.click()
    await card.locator("summary").filter({ hasText: "Picker secondary" }).click()
    await expect(card.getByRole("textbox", { name: "Vendor name", exact: true })).toHaveValue("Picker secondary")
    await expect(card.getByRole("button", { name: "Get models", exact: true })).toBeEnabled()
    await card.getByRole("button", { name: "Get models", exact: true }).click()
    await expect.poll(() => entered.has(secondary)).toBe(true)
    await expect(card.getByRole("button", { name: "Fetching...", exact: true })).toBeDisabled()
    const oldResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).origin === primary && new URL(response.url()).pathname === "/api/relay/models/refresh",
    )
    gates[0].release()
    expect((await oldResponse).ok()).toBe(true)
    await expect(card.getByRole("textbox", { name: "Vendor name", exact: true })).toHaveValue("Picker secondary")
    await expect(card.getByRole("button", { name: "Fetching...", exact: true })).toBeDisabled()
    await expect(card.getByRole("checkbox", { name: "model-first", exact: true })).toHaveCount(0)
    await info.attach("late-primary-keeps-secondary-busy", {
      body: await dialog.screenshot(),
      contentType: "image/png",
    })
    const newResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).origin === secondary &&
        new URL(response.url()).pathname === "/api/relay/models/refresh",
    )
    gates[1].release()
    expect((await newResponse).ok()).toBe(true)
    await expect(card.getByRole("button", { name: "Get models", exact: true })).toBeEnabled()
    await expect(card.getByRole("checkbox", { name: "model-second", exact: true })).toBeVisible()
    await expect(card.getByRole("checkbox", { name: "model-first", exact: true })).toHaveCount(0)
    expect(errors).toEqual([])
  } finally {
    gates.forEach((item) => item.release())
    try {
      await page.unrouteAll({ behavior: "wait" })
    } finally {
      try {
        for (const server of [primary, secondary]) {
          const current = await read(server)
          const vendor = current.vendors.find((item) => item.id === id)
          if (!vendor) continue
          const response = await api.delete(server + "/api/relay/auth/vendors/" + id, {
            data: { revision: current.revision, expectedEntityId: vendor.entityId },
          })
          expect(response.ok()).toBe(true)
        }
      } finally {
        await api.dispose()
      }
    }
  }
})
