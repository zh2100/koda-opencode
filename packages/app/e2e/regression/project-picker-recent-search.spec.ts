import { expect, test } from "@playwright/test"
import type { Page } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

const NAMES = ["alpha-service", "bravo-web", "charlie-api", "delta-tools", "echo-infra", "foxtrot-docs"]
const worktrees = NAMES.map((name) => `/opencode-demo/${name}`)

// The sixth project sits outside the five-item recent cap, so it is only reachable if the
// dialog hands every recent project to the list filter instead of a pre-truncated slice.
const OUTSIDE_CAP = "foxtrot-docs"

// Dialog rows carry data-directory-path; the sidebar project list does not, so this
// scopes assertions to the picker instead of matching the sidebar entry of the same name.
const rows = (page: Page) => page.locator("[data-directory-path]")
const row = (page: Page, name: string) => page.locator(`[data-directory-path*="${name}"]`)

async function openProjectMenu(page: Page, directories = worktrees) {
  await mockOpenCodeServer(page, {
    sessions: fixture.sessions,
    provider: fixture.provider,
    directory: fixture.directory,
    project: fixture.project,
    pageMessages,
    fileList: () => [],
    findFiles: () => [],
  })
  await page.addInitScript((dirs) => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
    localStorage.setItem(
      "opencode.global.dat:server",
      JSON.stringify({
        projects: { local: dirs.map((worktree: string) => ({ worktree, expanded: false })) },
        lastProject: {},
      }),
    )
  }, directories)
  await page.goto("/")
  const newSession = page.getByRole("main").locator('[data-action="home-new-session"]')
  await expectAppVisible(newSession)
  await newSession.click()
  await expectAppVisible(page.locator('[data-component="prompt-input-v2"]'))

  await page.locator('[data-action="prompt-project"]').click()
}

async function openProjectDialog(page: Page) {
  await openProjectMenu(page)
  await page.getByText("Open existing project", { exact: true }).click()
  await expect(rows(page)).toHaveCount(5)
  return page.getByRole("textbox").last()
}

test("removes a listed project without selecting it", async ({ page }) => {
  await openProjectMenu(page)
  const trigger = page.locator('[data-action="prompt-project"]')
  const menu = page.locator("#prompt-project-menu")
  const selected = menu.getByRole("menuitemradio", { checked: true })
  const before = await selected.innerText()
  const count = await menu.getByRole("menuitemradio").count()
  await menu.getByRole("menuitem", { name: `Remove ${OUTSIDE_CAP} from the project list` }).click()
  await expect(menu).toBeHidden()
  await trigger.click()
  await expect(selected).toHaveText(before, { useInnerText: true })
  await expect(menu.getByRole("menuitemradio", { name: OUTSIDE_CAP })).toHaveCount(0)
  await expect(menu.getByRole("menuitemradio")).toHaveCount(count - 1)
})

test("removing the current draft project selects another project", async ({ page }) => {
  await openProjectMenu(page)
  const menu = page.locator("#prompt-project-menu")
  const current = menu.getByRole("menuitemradio", { checked: true })
  const key = await current.getAttribute("data-option-key")
  const row = current.locator("..")
  await row.getByRole("menuitem").click()
  await expect(menu).toBeHidden()
  await page.locator('[data-action="prompt-project"]').click()
  await expect(current).toBeVisible()
  await expect(menu.locator(`[data-option-key="${key}"]`)).toHaveCount(0)
})

test("removing the last project returns home", async ({ page }) => {
  await openProjectMenu(page, [fixture.directory])
  const menu = page.locator("#prompt-project-menu")
  await expect(menu.getByRole("menuitemradio")).toHaveCount(1)
  await menu.getByRole("menuitem", { name: /^Remove .* from the project list$/ }).click()
  await expect(page).toHaveURL(/\/$/)
})

test("searches every recent project, not just the five most recent", async ({ page }) => {
  const search = await openProjectDialog(page)
  await expect(row(page, OUTSIDE_CAP)).toHaveCount(0)

  await search.fill("foxtrot")

  await expect(row(page, OUTSIDE_CAP)).toHaveCount(1)
})

test("still caps the idle recent list at five projects", async ({ page }) => {
  await openProjectDialog(page)

  await expect(row(page, NAMES[4])).toHaveCount(1)
  await expect(row(page, OUTSIDE_CAP)).toHaveCount(0)
})
