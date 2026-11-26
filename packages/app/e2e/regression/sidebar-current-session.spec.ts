import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"

const directory = "C:/OpenCode/SidebarCurrentSession"
const project = { id: "sidebar-project", worktree: directory, vcs: "git", time: { created: 1, updated: 1 } }
const sourceSession = { id: "ses_sidebar_source", title: "Initial conversation" }
const targetSession = {
  id: "ses_sidebar_target",
  title: "جلسة 123 — Example conversation with an intentionally long title — packages/app/src/pages/home.tsx",
}
const cases = [
  { layout: "v2", locale: "en", direction: "ltr", colorScheme: "light", width: 1440 },
  { layout: "v2", locale: "en", direction: "rtl", colorScheme: "light", width: 1280 },
  { layout: "v2", locale: "ar", direction: "rtl", colorScheme: "dark", width: 1600 },
  { layout: "legacy", locale: "en", direction: "ltr", colorScheme: "light", width: 1440 },
  { layout: "legacy", locale: "en", direction: "rtl", colorScheme: "dark", width: 720 },
] as const

for (const { layout, locale, direction, colorScheme, width } of cases) {
  test(`${layout}: sidebar marks the current session (${locale}, ${direction}, ${colorScheme}, ${width}px)`, async ({ page }) => {
    const v2 = layout === "v2"
    const mobile = width < 1280
    await page.setViewportSize({ width, height: 800 })
    await page.emulateMedia({ colorScheme })
    // Keep the legacy layout available after the product sunset.
    if (!v2) await page.clock.setFixedTime(new Date("2026-08-25T12:00:00Z"))
    await mockSidebarServer(page, { protocol: v2 ? "v2" : "v1" })
    await page.addInitScript(
      ({ v2, locale, directory }) => {
        localStorage.setItem("app-version.v1", JSON.stringify({ version: "1.18.29" }))
        localStorage.setItem(
          "settings.v3",
          JSON.stringify({
            general: { newLayoutDesigns: v2, layoutTransitionEligible: true, newInterfaceNoticeDismissed: true },
          }),
        )
        localStorage.setItem("opencode.global.dat:language", JSON.stringify({ locale }))
        localStorage.setItem(
          "opencode.global.dat:server",
          JSON.stringify({ projects: { local: [{ worktree: directory, expanded: true }] }, lastProject: { local: directory } }),
        )
      },
      { v2, locale, directory },
    )
    await page.goto(`/${base64Encode(directory)}/session/${sourceSession.id}`)
    const html = page.locator("html")
    await expect(html).toHaveAttribute("lang", locale)
    if (locale === "en" && direction === "rtl") await html.evaluate((element) => element.setAttribute("dir", "rtl"))
    await expect(html).toHaveAttribute("dir", direction)
    await expect(html).toHaveAttribute("data-color-scheme", colorScheme)
    const toggle = page.getByRole("button", { name: mobile ? "Toggle menu" : "Toggle sidebar", exact: true })
    if (!v2) await toggle.click()

    const sidebar = page.locator(`[data-component="sidebar-nav-${mobile ? "mobile" : "desktop"}"]`)
    const rows = sidebar.locator(v2 ? '[data-component="home-session-row"]' : "[data-session-id] a")
    const source = rows.filter({ hasText: sourceSession.title })
    const target = rows.filter({ hasText: targetSession.title })
    const current = rows.and(sidebar.locator('[aria-current="page"]'))
    await expect(source).toHaveAttribute("aria-current", "page")
    await expect(current).toHaveCount(1)
    const sourceTitle = source.getByText(sourceSession.title, { exact: true })
    const targetTitle = target.getByText(targetSession.title, { exact: true })
    await expect(sourceTitle).toHaveCSS("font-weight", "600")
    await expect(targetTitle).not.toHaveCSS("font-weight", "600")
    const sourceRow = v2 ? source.locator("..") : sidebar.locator(`[data-session-id="${sourceSession.id}"]`)
    const targetRow = v2 ? target.locator("..") : sidebar.locator(`[data-session-id="${targetSession.id}"]`)
    await expect(sourceRow).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)")
    await expect(targetRow).toHaveCSS("background-color", "rgba(0, 0, 0, 0)")

    if (v2) {
      await source.hover()
      await expect(source).toHaveCSS("background-color", "rgba(0, 0, 0, 0)")
      await target.click({ button: "middle" })
      const openIndicator = target.locator('[data-slot="open-session-indicator"]')
      await expect(openIndicator).toBeVisible()
      await expect
        .poll(() =>
          openIndicator.evaluate((element, direction) => {
            const bounds = element.getBoundingClientRect()
            const avatar = element.parentElement?.getBoundingClientRect()
            if (!avatar || !bounds.width) return false
            return direction === "ltr" ? bounds.right < avatar.left : bounds.left > avatar.right
          }, direction),
        )
        .toBe(true)
      await expect(page).toHaveURL(new RegExp(`/session/${sourceSession.id}$`))
      await expect(source).toHaveAttribute("aria-current", "page")
      await expect(target).not.toHaveAttribute("aria-current", "page")
      await page.mouse.move(0, 0)
      await sidebar.locator('[data-action="home-session-search"]').focus()
      await page.keyboard.press("Tab")
      await expect(source).toBeFocused()
      // The source row's pin, rename, and delete actions precede the next conversation.
      for (const action of ["pin", "rename", "delete"]) {
        await page.keyboard.press("Tab")
        await expect(sourceRow.locator(`[data-action="home-session-${action}"]`)).toBeFocused()
      }
      await page.keyboard.press("Tab")
      await expect(target).toBeFocused()
    }

    if (!v2 && mobile) {
      await target.click()
      await page.mouse.move(0, 0)
    } else {
      if (!v2) {
        await source.focus()
        await page.keyboard.press("Tab")
        await expect(sourceRow.getByRole("button", { name: "Archive", exact: true })).toBeFocused()
        await page.keyboard.press("Tab")
        await expect(target).toBeFocused()
      }
      await expect(target).toHaveCSS("outline-width", "2px")
      await page.keyboard.press("Enter")
    }
    await expect(page).toHaveURL(new RegExp(`/session/${targetSession.id}$`))
    await expect(target).toHaveAttribute("aria-current", "page")
    await expect(current).toHaveCount(1)
    await expect(targetTitle).toHaveCSS("font-weight", "600")
    await expect(targetTitle).toHaveCSS("text-overflow", "ellipsis")
    await expect.poll(() => targetTitle.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true)
    await expect(sourceTitle).not.toHaveCSS("font-weight", "600")
    await expect(sourceRow).toHaveCSS("background-color", "rgba(0, 0, 0, 0)")
    await expect(targetRow).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)")

    if (v2) {
      await sidebar.locator('[data-action="home-new-session"]').click()
      await expect(page).toHaveURL(/\/new-session\?draftId=/)
      await expect(current).toHaveCount(0)
      await page.goBack()
      await expect(page).toHaveURL(new RegExp(`/session/${targetSession.id}$`))
      await expect(target).toHaveAttribute("aria-current", "page")
      await page.reload()
      await expect(target).toHaveAttribute("aria-current", "page")
      await expect(current).toHaveCount(1)
    }
  })
}

test("v2: equal session IDs on different servers do not share the current marker", async ({ page }) => {
  const primary = "http://sidebar-primary.test"
  const secondary = "http://sidebar-secondary.test"
  const secondaryTitle = "Same ID on another server"
  await mockSidebarServer(page, { protocol: "v2", origin: primary })
  await mockSidebarServer(page, { protocol: "v2", origin: secondary, sourceTitle: secondaryTitle })
  await page.addInitScript(
    ({ primary, secondary, directory }) => {
      localStorage.setItem("opencode.settings.dat:defaultServerUrl", primary)
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          list: [primary, secondary],
          projects: { [primary]: [{ worktree: directory, expanded: true }] },
        }),
      )
    },
    { primary, secondary, directory },
  )
  // The sidebar remains scoped to the default server when directly opening a remote session.
  const href = `/server/${base64Encode(secondary)}/session/${sourceSession.id}`
  await page.goto(href)
  await expect(page).toHaveURL(href)
  await expect(page.getByRole("heading", { name: secondaryTitle, exact: true })).toBeVisible()
  const sidebar = page.locator('[data-component="sidebar-nav-desktop"]')
  const source = sidebar.getByRole("button", { name: new RegExp(sourceSession.title) })
  await expect(source).toBeVisible()
  await expect(source).not.toHaveAttribute("aria-current", "page")
  await expect(sidebar.locator('[data-component="home-session-row"][aria-current="page"]')).toHaveCount(0)
  await source.click()
  await expect(page).toHaveURL(`/server/${base64Encode(primary)}/session/${sourceSession.id}`)
  await expect(source).toHaveAttribute("aria-current", "page")
})

test("v2: a sidebar session update preserves keyboard focus on another row", async ({ page }) => {
  const updates: unknown[] = []
  await page.setViewportSize({ width: 1440, height: 800 })
  await mockSidebarServer(page, { protocol: "v2", events: () => updates.splice(0) })
  await page.addInitScript((directory) => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
    localStorage.setItem(
      "opencode.global.dat:server",
      JSON.stringify({ projects: { local: [{ worktree: directory, expanded: true }] } }),
    )
  }, directory)
  await page.goto(`/${base64Encode(directory)}/session/${sourceSession.id}`)
  const sidebar = page.locator('[data-component="sidebar-nav-desktop"]')
  const rows = sidebar.locator('[data-component="home-session-row"]')
  const source = rows.filter({ hasText: sourceSession.title })
  await expect(source).toBeVisible()
  await expect(rows.filter({ hasText: targetSession.title })).toBeVisible()
  await sidebar.locator('[data-action="home-session-search"]').focus()
  await page.keyboard.press("Tab")
  await expect(source).toBeFocused()
  await page.keyboard.press("Tab")
  const sourcePin = source.locator("..").locator('[data-action="home-session-pin"]')
  await expect(sourcePin).toBeFocused()
  const focusedButton = await sourcePin.elementHandle()
  if (!focusedButton) throw new Error("The focused pin button is missing")

  const title = "Updated while the sidebar has focus"
  updates.push({
    id: "evt_sidebar_update",
    type: "session.updated",
    created: Date.now(),
    data: { sessionID: targetSession.id, info: sidebarSession({ ...targetSession, title }) },
    location: { directory },
  })
  await expect(rows.filter({ hasText: title })).toBeVisible()
  expect(
    await focusedButton.evaluate((button) => ({ connected: button.isConnected, focused: document.activeElement === button })),
  ).toEqual({ connected: true, focused: true })
  await page.keyboard.press("Tab")
  await expect(source.locator("..").locator('[data-action="home-session-rename"]')).toBeFocused()
})

function sidebarSession(session: { id: string; title: string }) {
  return {
    ...session,
    slug: session.id,
    projectID: project.id,
    directory,
    version: "dev",
    time: { created: 1700000000000, updated: 1700000000000 },
  }
}

async function mockSidebarServer(
  page: Page,
  options: { protocol: "v1" | "v2"; origin?: string; sourceTitle?: string; events?: () => unknown[] },
) {
  await mockOpenCodeServer(page, {
    protocol: options.protocol,
    origin: options.origin,
    events: options.events,
    sessions: [{ ...sourceSession, title: options.sourceTitle ?? sourceSession.title }, targetSession].map(sidebarSession),
    directory,
    project,
    provider: { all: [], connected: [], default: {} },
    pageMessages: () => ({ items: [] }),
  })
}
