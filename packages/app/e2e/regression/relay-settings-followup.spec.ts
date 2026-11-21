import { expect, request, test, type Page, type APIRequestContext } from "@playwright/test"

test.skip(process.env.FUP_NEXT_E2E !== "1", "Requires dedicated isolated next-acceptance services")
const primary = "http://127.0.0.1:44096"
const secondary = "http://127.0.0.1:44098"
const external = "http://127.0.0.1:44100"
const upstream = "http://127.0.0.1:44097"
const gate = () => {
  let release!: () => void
  const ready = new Promise<void>((resolve) => {
    release = resolve
  })
  return { ready, release }
}
type Auth = {
  revision: number
  vendors: Array<{ id: string; entityId: string; name: string; baseURL: string; hasKey: boolean }>
}
const read = async (api: APIRequestContext, server = primary): Promise<Auth> => {
  const response = await api.get(server + "/api/relay/auth")
  expect(response.ok()).toBe(true)
  const raw = await response.json()
  return raw.data ?? raw
}
const seed = async (api: APIRequestContext, id: string, server = primary, name = id) => {
  const response = await api.put(server + "/api/relay/auth/vendors/" + id, {
    data: {
      name,
      baseURL: upstream + "/first",
      key: "fake-next-acceptance",
      revision: (await read(api, server)).revision,
    },
  })
  expect(response.ok()).toBe(true)
}
const clean = async (api: APIRequestContext, ids: string[], servers = [primary]) => {
  for (const server of servers)
    for (const id of ids) {
      const auth = await read(api, server)
      const vendor = auth.vendors.find((x) => x.id === id)
      if (!vendor) continue
      const response = await api.delete(server + "/api/relay/auth/vendors/" + id, {
        data: {
          revision: auth.revision,
          expectedEntityId: vendor.entityId,
        },
      })
      expect(response.ok()).toBe(true)
    }
}
const prepare = async (page: Page, modern: boolean) => {
  await page.clock.setFixedTime(new Date("2026-09-01T00:00:00+08:00"))
  await page.addInitScript(
    ({ modern, secondary }) => {
      localStorage.setItem("opencode.global.dat:language", JSON.stringify({ locale: "en" }))
      localStorage.setItem(
        "settings.v3",
        JSON.stringify({
          general: { newLayoutDesigns: modern, layoutTransitionEligible: true, newInterfaceNoticeDismissed: true },
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
const open = async (page: Page, modern: boolean) => {
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const dialog = page.locator(modern ? ".settings-v2-dialog" : ".settings-dialog")
  await dialog.getByRole("tab", { name: "Providers", exact: true }).click()
  await expect(dialog.getByRole("button", { name: "Reload settings", exact: true })).toBeEnabled()
  return dialog
}
for (const modern of [false, true]) {
  test(`initial delayed read safely adds a distinct vendor, modern=${modern}`, async ({ page }, info) => {
    const api = await request.newContext({ timeout: 20000 })
    const id = "next-initial-" + crypto.randomUUID().slice(0, 8)
    const block = gate()
    let entered = 0
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    try {
      await seed(api, id)
      const original = (await read(api)).vendors.find((x) => x.id === id)
      await prepare(page, modern)
      await page.getByRole("button", { name: "Settings", exact: true }).click()
      const dialog = page.locator(modern ? ".settings-v2-dialog" : ".settings-dialog")
      await page.route(/\/api\/relay\/auth(?:\?.*)?$/, async (route) => {
        entered++
        await block.ready
        await route.continue()
      })
      await dialog.getByRole("tab", { name: "Providers", exact: true }).click()
      await expect.poll(() => entered).toBeGreaterThan(0)
      await dialog.getByRole("textbox", { name: "Vendor name", exact: true }).fill(id)
      await dialog.getByPlaceholder("https://api.myprovider.com/v1", { exact: true }).fill(upstream + "/second")
      await dialog.getByLabel("sk-xxxxxx", { exact: true }).fill("fake-next-new")
      const saved = page.waitForResponse(
        (r) => r.request().method() === "PUT" && new URL(r.url()).pathname.endsWith("/vendors/" + id + "-2"),
      )
      await dialog.getByRole("button", { name: "Add vendor", exact: true }).click()
      block.release()
      expect((await saved).ok()).toBe(true)
      const card = dialog.locator(`fieldset[data-vendor-id="${id}-2"]`)
      await card.locator("summary").click()
      await expect(card.getByRole("textbox", { name: "Vendor name", exact: true })).toHaveValue(id)
      await expect(card.getByRole("checkbox", { name: "model-second", exact: true })).toBeVisible()
      expect((await read(api)).vendors.find((x) => x.id === id)).toEqual(original)
      expect(errors).toEqual([])
      await info.attach("initial-read-safely-created", { body: await dialog.screenshot(), contentType: "image/png" })
    } finally {
      block.release()
      try {
        await page.unrouteAll({ behavior: "wait" })
      } finally {
        try {
          await clean(api, [id, id + "-2"])
        } finally {
          await api.dispose()
        }
      }
    }
  })
  test(`save ACK preserves later draft and normalizes accepted values, modern=${modern}`, async ({ page }, info) => {
    const api = await request.newContext({ timeout: 20000 })
    const id = "next-draft-" + crypto.randomUUID().slice(0, 8)
    const ack = gate()
    let captured = 0
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    try {
      await seed(api, id)
      await prepare(page, modern)
      const dialog = await open(page, modern)
      const card = dialog.locator(`fieldset[data-vendor-id="${id}"]`)
      await card.locator("summary").click()
      const name = card.getByRole("textbox", { name: "Vendor name", exact: true })
      const url = card.getByPlaceholder("https://api.myprovider.com/v1", { exact: true })
      await expect(name).toHaveValue(id)
      await name.fill(" " + id + " saved ")
      await url.fill(upstream + "/first///")
      const routePath = new RegExp("/api/relay/auth/vendors/" + id + "(?:\\?.*)?$")
      await page.route(routePath, async (route) => {
        if (route.request().method() !== "PUT") return route.continue()
        const response = await route.fetch()
        expect(response.ok()).toBe(true)
        captured++
        await ack.ready
        await route.fulfill({ response })
      })
      const response = page.waitForResponse(
        (r) => r.request().method() === "PUT" && new URL(r.url()).pathname.endsWith("/vendors/" + id),
      )
      await card.getByRole("button", { name: "Save", exact: true }).click()
      await expect.poll(() => captured).toBe(1)
      await name.fill(id + " continued")
      ack.release()
      expect((await response).ok()).toBe(true)
      await expect(url).toHaveValue(upstream + "/first")
      await expect(name).toHaveValue(id + " continued")
      await page.unroute(routePath)
      const next = page.waitForResponse(
        (r) => r.request().method() === "PUT" && new URL(r.url()).pathname.endsWith("/vendors/" + id),
      )
      await card.getByRole("button", { name: "Save", exact: true }).click()
      expect((await next).ok()).toBe(true)
      expect((await read(api)).vendors.find((x) => x.id === id)?.name).toBe(id + " continued")
      expect(errors).toEqual([])
      await info.attach("later-draft-survived", { body: await dialog.screenshot(), contentType: "image/png" })
    } finally {
      ack.release()
      try {
        await page.unrouteAll({ behavior: "wait" })
      } finally {
        try {
          await clean(api, [id])
        } finally {
          await api.dispose()
        }
      }
    }
  })
  test(`address, external visibility, key clearing and deletion update real lists, modern=${modern}`, async ({
    page,
  }, info) => {
    const api = await request.newContext({ timeout: 20000 })
    const id = "next-link-" + crypto.randomUUID().slice(0, 8)
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    try {
      await seed(api, id)
      expect((await api.post(primary + "/api/relay/models/refresh", { data: { vendorId: id } })).ok()).toBe(true)
      await prepare(page, modern)
      const dialog = await open(page, modern)
      const card = dialog.locator(`fieldset[data-vendor-id="${id}"]`)
      await card.locator("summary").click()
      const first = card.getByRole("checkbox", { name: "model-first", exact: true })
      await expect(first).not.toBeChecked()
      const checked = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/relay/models/visibility")
      await card.getByText("model-first", { exact: true }).click()
      expect((await checked).ok()).toBe(true)
      await expect(first).toBeChecked()
      const entity = (await read(api)).vendors.find((x) => x.id === id)!
      expect(
        (
          await api.put(external + "/api/relay/models/visibility", {
            data: { vendorId: id, modelId: "model-first", visible: false, expectedEntityId: entity.entityId },
          })
        ).ok(),
      ).toBe(true)
      const reload = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/relay/models/sync")
      await dialog.getByRole("button", { name: "Reload settings", exact: true }).click()
      expect((await reload).ok()).toBe(true)
      await expect(first).not.toBeChecked()
      await card.getByPlaceholder("https://api.myprovider.com/v1", { exact: true }).fill(upstream + "/second")
      const saved = page.waitForResponse(
        (r) => r.request().method() === "PUT" && new URL(r.url()).pathname.endsWith("/vendors/" + id),
      )
      await card.getByRole("button", { name: "Save", exact: true }).click()
      expect((await saved).ok()).toBe(true)
      const refresh = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/relay/models/refresh")
      await card.getByRole("button", { name: "Get models", exact: true }).click()
      expect((await refresh).ok()).toBe(true)
      const second = card.getByRole("checkbox", { name: "model-second", exact: true })
      await expect(second).toBeVisible()
      await expect(first).toHaveCount(0)
      await expect(card.getByRole("button", { name: "Get models", exact: true })).toBeEnabled()
      const cleared = page.waitForResponse(
        (r) => r.request().method() === "DELETE" && new URL(r.url()).pathname.endsWith("/vendors/" + id + "/key"),
      )
      await card.getByRole("button", { name: "Clear key", exact: true }).click()
      expect((await cleared).ok()).toBe(true)
      await expect(card.getByRole("button", { name: "Clear key", exact: true })).toBeDisabled()
      expect((await read(api)).vendors.find((x) => x.id === id)?.hasKey).toBe(false)
      await card.locator('input[type="password"]').fill("fake-next-restored")
      const restored = page.waitForResponse(
        (r) => r.request().method() === "PUT" && new URL(r.url()).pathname.endsWith("/vendors/" + id),
      )
      await card.getByRole("button", { name: "Save", exact: true }).click()
      expect((await restored).ok()).toBe(true)
      await expect(card.getByRole("button", { name: "Clear key", exact: true })).toBeEnabled()
      await info.attach("address-visibility-and-key-recovered", {
        body: await dialog.screenshot(),
        contentType: "image/png",
      })
      const removed = page.waitForResponse(
        (r) => r.request().method() === "DELETE" && new URL(r.url()).pathname.endsWith("/vendors/" + id),
      )
      await card.getByRole("button", { name: "Delete vendor", exact: true }).click()
      expect((await removed).ok()).toBe(true)
      await expect(card).toHaveCount(0)
      expect((await read(api)).vendors.some((x) => x.id === id)).toBe(false)
      expect(errors).toEqual([])
    } finally {
      try {
        await clean(api, [id])
      } finally {
        await api.dispose()
      }
    }
  })
}

test("modern settings server selection isolates the old refresh response", async ({ page }, info) => {
  const api = await request.newContext({ timeout: 20000 })
  const id = "next-classic-" + crypto.randomUUID().slice(0, 8)
  const block = gate()
  let entered = 0
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await seed(api, id, primary, "Primary unique")
    await seed(api, id, secondary, "Secondary unique")
    // Exercise a late response as well as the cooperating-abort unit cases.
    // Only this owner's refresh transport ignores abort; auth and all backend paths stay real.
    await page.addInitScript(() => {
      const original = window.fetch.bind(window)
      window.fetch = Object.assign(
        (input: RequestInfo | URL, init?: RequestInit) => {
          const url = input instanceof Request ? input.url : String(input)
          return original(
            input,
            url.includes("/api/relay/models/refresh") ? { ...init, signal: new AbortController().signal } : init,
          )
        },
        { preconnect: window.fetch.preconnect },
      )
    })
    await prepare(page, true)
    const dialog = await open(page, true)
    const card = dialog.locator(`fieldset[data-vendor-id="${id}"]`)
    await card.locator("summary").click()
    await expect(card.getByRole("textbox", { name: "Vendor name", exact: true })).toHaveValue("Primary unique")
    await page.route(primary + "/api/relay/models/refresh", async (route) => {
      entered++
      await block.ready
      await route.continue()
    })
    await card.getByRole("button", { name: "Get models", exact: true }).click()
    await expect.poll(() => entered).toBe(1)
    await dialog.getByRole("button", { name: "127.0.0.1:44096", exact: true }).click()
    await page.getByRole("menuitemradio", { name: /127\.0\.0\.1:44098/ }).click()
    await card.locator("summary").filter({ hasText: "Secondary unique" }).click()
    await expect(dialog.getByRole("button", { name: "127.0.0.1:44098", exact: true })).toBeVisible()
    await expect(card.getByRole("textbox", { name: "Vendor name", exact: true })).toHaveValue("Secondary unique")
    const old = page.waitForResponse(
      (r) => new URL(r.url()).origin === primary && new URL(r.url()).pathname === "/api/relay/models/refresh",
    )
    block.release()
    expect((await old).ok()).toBe(true)
    await expect(card.getByRole("textbox", { name: "Vendor name", exact: true })).toHaveValue("Secondary unique")
    await expect(card.getByRole("checkbox", { name: "model-first", exact: true })).toHaveCount(0)
    await dialog.getByRole("button", { name: "127.0.0.1:44098", exact: true }).click()
    await page.getByRole("menuitemradio", { name: /127\.0\.0\.1:44096/ }).click()
    await card.locator("summary").filter({ hasText: "Primary unique" }).click()
    await expect(card.getByRole("textbox", { name: "Vendor name", exact: true })).toHaveValue("Primary unique")
    await expect(card.getByRole("checkbox", { name: "model-first", exact: true })).toBeVisible()
    expect(errors).toEqual([])
    await info.attach("classic-global-switch-kept-secondary", {
      body: await dialog.screenshot(),
      contentType: "image/png",
    })
  } finally {
    block.release()
    try {
      await page.unrouteAll({ behavior: "wait" })
    } finally {
      try {
        await clean(api, [id], [primary, secondary])
      } finally {
        await api.dispose()
      }
    }
  }
})

test("modern selected server owns reload, with close-reopen control", async ({ page }, info) => {
  const api = await request.newContext({ timeout: 20000 })
  const id = "next-classic-cold-" + crypto.randomUUID().slice(0, 8)
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await seed(api, id, primary, "Cold primary")
    await seed(api, id, secondary, "Cold secondary")
    await prepare(page, true)
    const dialog = await open(page, true)
    const card = dialog.locator(`fieldset[data-vendor-id="${id}"]`)
    await card.locator("summary").click()
    await expect(card.getByRole("textbox", { name: "Vendor name", exact: true })).toHaveValue("Cold primary")
    await dialog.getByRole("button", { name: "127.0.0.1:44096", exact: true }).click()
    await page.getByRole("menuitemradio", { name: /127\.0\.0\.1:44098/ }).click()
    await card.locator("summary").filter({ hasText: "Cold secondary" }).click()
    await expect(dialog.getByRole("button", { name: "127.0.0.1:44098", exact: true })).toBeVisible()
    const outgoing = page.waitForRequest((r) => new URL(r.url()).pathname === "/api/relay/models/sync")
    const reloaded = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/relay/models/sync")
    await dialog.getByRole("button", { name: "Reload settings", exact: true }).click()
    const target = new URL((await outgoing).url()).origin
    expect((await reloaded).ok()).toBe(true)
    await info.attach("classic-selected-secondary-reload-target", {
      body: JSON.stringify({
        selected: secondary,
        reloadTarget: target,
        visibleName: await card.getByRole("textbox", { name: "Vendor name", exact: true }).inputValue(),
      }),
      contentType: "application/json",
    })
    await info.attach("classic-selected-secondary-with-old-settings", {
      body: await page.screenshot(),
      contentType: "image/png",
    })
    expect.soft(target).toBe(secondary)
    await page.keyboard.press("Escape")
    await expect(dialog).toBeHidden()
    const reopened = await open(page, true)
    await reopened.locator(`fieldset[data-vendor-id="${id}"] summary`).click()
    await expect(
      reopened.locator(`fieldset[data-vendor-id="${id}"]`).getByRole("textbox", { name: "Vendor name", exact: true }),
    ).toHaveValue("Cold secondary")
    expect(errors).toEqual([])
  } finally {
    try {
      await clean(api, [id], [primary, secondary])
    } finally {
      await api.dispose()
    }
  }
})
