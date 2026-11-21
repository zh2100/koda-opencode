import { expect, request, test, type Page, type APIRequestContext } from "@playwright/test"
import { readFile } from "node:fs/promises"
import path from "node:path"

test.skip(process.env.ACC_REFRESH_E2E !== "1", "Requires owned isolated acceptance services")
const primary = "http://127.0.0.1:44096"
const upstream = "http://127.0.0.1:44097"
const gate = () => {
  const deferred = Promise.withResolvers<void>()
  return { promise: deferred.promise, release: () => deferred.resolve() }
}
type Auth = {
  revision: number
  vendors: Array<{ id: string; entityId: string; revision: number; name: string; baseURL: string; hasKey: boolean }>
}
const read = async (api: APIRequestContext): Promise<Auth> => {
  const response = await api.get(primary + "/api/relay/auth")
  expect(response.ok()).toBe(true)
  const body = await response.json()
  return body.data ?? body
}
const seed = async (api: APIRequestContext, id: string) => {
  expect(
    (
      await api.put(primary + "/api/relay/auth/vendors/" + id, {
        data: {
          revision: (await read(api)).revision,
          name: id,
          baseURL: upstream + "/first",
          key: "fake-owned-acceptance",
        },
      })
    ).ok(),
  ).toBe(true)
}
const open = async (page: Page, modern: boolean, id: string) => {
  await page.clock.install({ time: new Date("2026-09-01T00:00:00+08:00") })
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
  await page.goto("/")
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeEnabled()
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const dialog = page.locator(modern ? ".settings-v2-dialog" : ".settings-dialog")
  await dialog.getByRole("tab", { name: "Providers", exact: true }).click()
  const card = dialog.locator(`fieldset[data-vendor-id="${id}"]`)
  await card.locator("summary").click()
  await expect(card.getByRole("textbox", { name: "Vendor name", exact: true })).toHaveValue(id)
  return { dialog, card }
}
const clean = async (page: Page, api: APIRequestContext, id: string) => {
  await page.close()
  const vendor = (await read(api)).vendors.find((item) => item.id === id)
  if (vendor)
    expect(
      (
        await api.delete(primary + "/api/relay/auth/vendors/" + id, {
          data: {
            revision: (await read(api)).revision,
            expectedEntityId: vendor.entityId,
          },
        })
      ).ok(),
    ).toBe(true)
  await api.dispose()
}
const reconcile = async (api: APIRequestContext, id: string) => {
  const vendor = (await read(api)).vendors.find((item) => item.id === id)!
  const root = process.env.ACC_REFRESH_DATA_ROOT
  if (!root || !path.resolve(root).includes("opencode-acc-next-")) throw new Error("Missing owned root")
  const disk = JSON.parse(await readFile(path.join(root, "relay-auth.json"), "utf8"))
  expect(disk.vendors[id]).toMatchObject({
    entityId: vendor.entityId,
    name: vendor.name,
    baseURL: vendor.baseURL,
    revision: vendor.revision,
  })
  expect(!!disk.vendors[id].keyRef).toBe(vendor.hasKey)
  const response = await api.post(primary + "/api/relay/models/sync", { data: {} })
  expect(response.ok()).toBe(true)
  const raw = await response.json()
  const sync = raw.data ?? raw
  const catalog = JSON.parse(await readFile(path.join(root, "relay-catalog.json"), "utf8"))
  const managed = sync.managed.filter((item: { vendorId: string }) => item.vendorId === id)
  // reasoningCapabilities is computed for the API, and is not a StoredManaged field.
  const persisted = (item: {
    vendorId: string
    modelId: string
    visible: boolean
    assignmentSource: string
    lastSeenAt: number
    upstreamPresent: boolean
  }) => ({
    vendorId: item.vendorId,
    modelId: item.modelId,
    visible: item.visible,
    assignmentSource: item.assignmentSource,
    lastSeenAt: item.lastSeenAt,
    upstreamPresent: item.upstreamPresent,
  })
  expect(catalog.managed.filter((item: { vendorId: string }) => item.vendorId === id)).toEqual(managed.map(persisted))
  return { vendor, managed }
}

for (const modern of [false, true]) {
  for (const action of ["empty", "clear", "recreate"] as const)
    test(`O02/O09/O10 held refresh followed by ${action}, modern=${modern}`, async ({ page }, info) => {
      const api = await request.newContext()
      const id = "obligation-" + crypto.randomUUID().slice(0, 8)
      const held = gate()
      const entered = gate()
      let first = true
      try {
        await seed(api, id)
        const { dialog, card } = await open(page, modern, id)
        await page.route(primary + "/api/relay/models/refresh", async (route) => {
          if (!first || route.request().postDataJSON().vendorId !== id) return route.continue()
          first = false
          entered.release()
          await held.promise
          const response = await route.fetch()
          try {
            await route.fulfill({ response })
          } catch {
            /* The retired owner may have aborted its fetch. */
          }
        })
        await card.getByPlaceholder("https://api.myprovider.com/v1", { exact: true }).fill(upstream + "/second")
        const saved = page.waitForResponse(
          (response) =>
            response.request().method() === "PUT" && new URL(response.url()).pathname.endsWith("/vendors/" + id),
        )
        await card.getByRole("button", { name: "Save", exact: true }).click()
        expect((await saved).ok()).toBe(true)
        await entered.promise
        if (action === "empty") {
          const committed = page.waitForResponse(
            (response) =>
              response.request().method() === "PUT" && new URL(response.url()).pathname.endsWith("/vendors/" + id),
          )
          await card.getByRole("button", { name: "Save", exact: true }).click()
          expect((await committed).ok()).toBe(true)
          await expect(card.getByRole("checkbox", { name: "model-second", exact: true })).toBeVisible()
        }
        if (action === "clear") {
          const cleared = page.waitForResponse((response) =>
            new URL(response.url()).pathname.endsWith("/vendors/" + id + "/key"),
          )
          await card.getByRole("button", { name: "Clear key", exact: true }).click()
          expect((await cleared).ok()).toBe(true)
          await expect(card.getByRole("button", { name: "Clear key", exact: true })).toBeDisabled()
        }
        if (action === "recreate") {
          const old = (await read(api)).vendors.find((item) => item.id === id)!
          const deleted = page.waitForResponse(
            (response) =>
              response.request().method() === "DELETE" && new URL(response.url()).pathname.endsWith("/vendors/" + id),
          )
          await card.getByRole("button", { name: "Delete vendor", exact: true }).click()
          expect((await deleted).ok()).toBe(true)
          await expect(card).toHaveCount(0)
          await seed(api, id)
          expect((await read(api)).vendors.find((item) => item.id === id)!.entityId).not.toBe(old.entityId)
          await dialog.getByRole("button", { name: "Reload settings", exact: true }).click()
          await card.locator("summary").click()
          await expect(card.getByRole("textbox", { name: "Vendor name", exact: true })).toHaveValue(id)
        }
        held.release()
        await page.unrouteAll({ behavior: "wait" })
        if (action !== "empty") await expect(card.getByRole("checkbox")).toHaveCount(0)
        const state = await reconcile(api, id)
        expect(state.vendor.hasKey).toBe(action !== "clear")
        await info.attach("verified-state", { body: JSON.stringify(state), contentType: "application/json" })
      } finally {
        held.release()
        await page.unrouteAll({ behavior: "wait" })
        await clean(page, api, id)
      }
    })

  test(`O07 a failed upstream refresh retries without another save, modern=${modern}`, async ({ page }, info) => {
    const api = await request.newContext()
    const id = "obligation-" + crypto.randomUUID().slice(0, 8)
    let writes = 0
    let refreshes = 0
    page.on("request", (request) => {
      if (request.method() === "PUT" && new URL(request.url()).pathname.endsWith("/vendors/" + id)) writes++
    })
    try {
      await seed(api, id)
      const { dialog, card } = await open(page, modern, id)
      await page.route(primary + "/api/relay/models/refresh", async (route) => {
        if (++refreshes > 1) return route.continue()
        return route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            _tag: "ServiceUnavailableError",
            message: "UPSTREAM_UNREACHABLE",
            resource: "relay.catalog",
          }),
        })
      })
      await card.getByPlaceholder("https://api.myprovider.com/v1", { exact: true }).fill(upstream + "/second")
      await card.getByRole("button", { name: "Save", exact: true }).click()
      await expect(dialog.getByRole("button", { name: "Retry", exact: true })).toBeEnabled()
      const committed = (await read(api)).revision
      await dialog.getByRole("button", { name: "Retry", exact: true }).click()
      await expect(card.getByRole("checkbox", { name: "model-second", exact: true })).toBeVisible()
      await expect(dialog.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0)
      expect(writes).toBe(1)
      expect(refreshes).toBe(2)
      expect((await read(api)).revision).toBe(committed)
      await info.attach("verified-state", {
        body: JSON.stringify(await reconcile(api, id)),
        contentType: "application/json",
      })
    } finally {
      await page.unrouteAll({ behavior: "wait" })
      await clean(page, api, id)
    }
  })

  test(`V10 checkbox ACK after name save reads the persisted selection, modern=${modern}`, async ({ page }, info) => {
    const api = await request.newContext()
    const id = "obligation-" + crypto.randomUUID().slice(0, 8)
    const held = gate()
    const committed = gate()
    try {
      await seed(api, id)
      expect((await api.post(primary + "/api/relay/models/refresh", { data: { vendorId: id } })).ok()).toBe(true)
      const { card } = await open(page, modern, id)
      await page.route(primary + "/api/relay/models/visibility", async (route) => {
        const response = await route.fetch()
        expect(response.ok()).toBe(true)
        committed.release()
        await held.promise
        await route.fulfill({ response })
      })
      await card.getByText("model-first", { exact: true }).click()
      await committed.promise
      await card.getByRole("textbox", { name: "Vendor name", exact: true }).fill(id + " renamed")
      const saved = page.waitForResponse(
        (response) =>
          response.request().method() === "PUT" && new URL(response.url()).pathname.endsWith("/vendors/" + id),
      )
      await card.getByRole("button", { name: "Save", exact: true }).click()
      expect((await saved).ok()).toBe(true)
      held.release()
      await expect(card.getByRole("checkbox", { name: "model-first", exact: true })).toBeChecked()
      const state = await reconcile(api, id)
      expect(state.managed.find((item: { modelId: string }) => item.modelId === "model-first").visible).toBe(true)
      await info.attach("verified-state", { body: JSON.stringify(state), contentType: "application/json" })
    } finally {
      held.release()
      await page.unrouteAll({ behavior: "wait" })
      await clean(page, api, id)
    }
  })
  test(`O21 a committed key ACK held past clear does not restart refresh, modern=${modern}`, async ({ page }, info) => {
    const api = await request.newContext()
    const id = "obligation-" + crypto.randomUUID().slice(0, 8)
    const held = gate()
    const committed = gate()
    let refreshes = 0
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/relay/models/refresh") refreshes++
    })
    try {
      await seed(api, id)
      const { dialog, card } = await open(page, modern, id)
      await page.route(primary + "/api/relay/auth/vendors/" + id, async (route) => {
        if (route.request().method() !== "PUT") return route.continue()
        const response = await route.fetch()
        expect(response.ok()).toBe(true)
        committed.release()
        await held.promise
        await route.fulfill({ response })
      })
      await card.locator('input[type="password"]').fill("fake-owned-new")
      await card.getByRole("button", { name: "Save", exact: true }).click()
      await committed.promise
      const synchronized = page.waitForResponse(
        (response) => new URL(response.url()).pathname === "/api/relay/models/sync",
      )
      await dialog.getByRole("button", { name: "Reload settings", exact: true }).click()
      expect((await synchronized).ok()).toBe(true)
      const cleared = page.waitForResponse((response) =>
        new URL(response.url()).pathname.endsWith("/vendors/" + id + "/key"),
      )
      await card.getByRole("button", { name: "Clear key", exact: true }).click()
      expect((await cleared).ok()).toBe(true)
      held.release()
      await page.unrouteAll({ behavior: "wait" })
      await expect(card.getByRole("button", { name: "Clear key", exact: true })).toBeDisabled()
      await expect(card.getByRole("checkbox")).toHaveCount(0)
      const state = await reconcile(api, id)
      expect(state.vendor.hasKey).toBe(false)
      expect(refreshes).toBe(0)
      await info.attach("verified-state", { body: JSON.stringify(state), contentType: "application/json" })
    } finally {
      held.release()
      await page.unrouteAll({ behavior: "wait" })
      await clean(page, api, id)
    }
  })

  test(`O17/O18 both occupied transport slots give a bounded retryable result, modern=${modern}`, async ({
    page,
  }, info) => {
    const api = await request.newContext()
    const id = "obligation-" + crypto.randomUUID().slice(0, 8)
    const held = gate()
    const twoSent = gate()
    let requests = 0
    const completions: Promise<void>[] = []
    try {
      await seed(api, id)
      // Deliberately model an uncooperative transport at the real SDK fetch boundary.
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
      const { dialog, card } = await open(page, modern, id)
      await page.route(primary + "/api/relay/models/refresh", (route) => {
        const completion = (async () => {
          if (++requests === 2) twoSent.release()
          await held.promise
          const response = await route.fetch()
          await route.fulfill({ response })
        })()
        completions.push(completion)
        return completion
      })
      await card.getByPlaceholder("https://api.myprovider.com/v1", { exact: true }).fill(upstream + "/second")
      const address = page.waitForResponse(
        (response) =>
          response.request().method() === "PUT" && new URL(response.url()).pathname.endsWith("/vendors/" + id),
      )
      await card.getByRole("button", { name: "Save", exact: true }).click()
      expect((await address).ok()).toBe(true)
      await card.getByRole("textbox", { name: "Vendor name", exact: true }).fill(id + " renamed")
      const named = page.waitForResponse(
        (response) =>
          response.request().method() === "PUT" && new URL(response.url()).pathname.endsWith("/vendors/" + id),
      )
      await card.getByRole("button", { name: "Save", exact: true }).click()
      expect((await named).ok()).toBe(true)
      await twoSent.promise
      const fetchedDraft = page.waitForEvent("requestfinished", {
        predicate: (request) =>
          request.method() === "PUT" && new URL(request.url()).pathname.endsWith("/vendors/" + id),
      })
      await card.getByRole("button", { name: "Get models", exact: true }).click()
      await fetchedDraft
      await expect(card.getByRole("button", { name: "Fetching...", exact: true })).toBeDisabled()
      // This advances the product deadline, not a readiness wait.
      await page.clock.runFor(90_001)
      await expect(card.getByRole("button", { name: "Get models", exact: true })).toBeEnabled()
      await expect(dialog.getByRole("button", { name: "Retry", exact: true })).toBeEnabled()
      expect(requests).toBe(2)
      held.release()
      await Promise.all(completions)
      await page.unrouteAll({ behavior: "wait" })
      await dialog.getByRole("button", { name: "Retry", exact: true }).click()
      await expect(card.getByRole("checkbox", { name: "model-second", exact: true })).toBeVisible()
      await info.attach("verified-state", {
        body: JSON.stringify(await reconcile(api, id)),
        contentType: "application/json",
      })
    } finally {
      held.release()
      await Promise.allSettled(completions)
      await page.unrouteAll({ behavior: "wait" })
      await clean(page, api, id)
    }
  })
}
