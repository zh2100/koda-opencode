import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

const directory = "C:/OpenCode/RelayGates"
const sessionID = "ses_relay_gates"
const project = {
  id: "proj_relay_gates",
  worktree: directory,
  vcs: "git",
  name: "RelayGates",
  time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
  sandboxes: [],
}

const session = {
  id: sessionID,
  projectID: project.id,
  directory,
  title: "Relay gates session",
  time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
}

async function openSettings(page: import("@playwright/test").Page) {
  await page.keyboard.press("Control+,")
  const dialog = page.locator(".settings-v2-dialog")
  await expectAppVisible(dialog)
  return dialog
}

test("relay settings hide official providers and gated tabs until each gate is open", async ({ page }) => {
  await mockOpenCodeServer(page, {
    protocol: "v2",
    directory,
    project,
    provider: {
      all: [{ id: "leidiandonghua", name: "雷电动画", models: {} }],
      connected: ["leidiandonghua"],
      default: { providerID: "leidiandonghua", modelID: "gpt-5.2" },
    },
    sessions: [session],
    pageMessages: () => ({ items: [] }),
    skills: [{ name: "review", description: "Review code", location: "/builtin/review", content: "# review" }],
  })
  await page.addInitScript(
    ({ directory }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({ projects: { local: [{ worktree: directory, sandboxes: [] }] } }),
      )
    },
    { directory },
  )

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expect(page.getByRole("heading", { name: session.title })).toBeVisible()

  await expect(page.locator('[data-action="home-open-skills"]')).toHaveCount(0)
  await expect(page.locator('[data-action="home-open-mcp"]')).toHaveCount(0)
  await expect(page.locator('[data-action="home-open-scheduled"]')).toHaveCount(0)

  const closed = await openSettings(page)
  await closed.getByRole("tab", { name: "Providers" }).click()
  await expect(closed.getByText("Relay keys")).toBeVisible()
  await expect(closed.getByText("https://api.leidiandonghua.cn/v1")).toBeVisible()
  await expect(closed.getByRole("tab", { name: "Skills" })).toHaveCount(0)
  await expect(closed.getByRole("tab", { name: "MCP" })).toHaveCount(0)
  await expect(closed.getByRole("tab", { name: "Scheduled tasks" })).toHaveCount(0)
  await expect(closed.getByText("OpenAI")).toHaveCount(0)
  await expect(closed.getByText("Anthropic")).toHaveCount(0)
  await page.keyboard.press("Escape")
})

test("open UI gates show skills, MCP, scheduled tasks, and a docked right panel", async ({ page }) => {
  await mockOpenCodeServer(page, {
    protocol: "v2",
    directory,
    project,
    provider: {
      all: [{ id: "leidiandonghua", name: "雷电动画", models: {} }],
      connected: ["leidiandonghua"],
      default: { providerID: "leidiandonghua", modelID: "gpt-5.2" },
    },
    sessions: [session],
    pageMessages: () => ({ items: [] }),
    gates: {
      relayCoreUi: true,
      relayLayout: true,
      relaySkills: true,
      relayMcp: true,
      scheduledTasks: true,
    },
    skills: [{ name: "review", description: "Review code", location: "/builtin/review", content: "# review" }],
    scheduledTasks: [],
  })
  await page.addInitScript(
    ({ directory }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({ projects: { local: [{ worktree: directory, sandboxes: [] }] } }),
      )
    },
    { directory },
  )

  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expect(page.getByRole("heading", { name: session.title })).toBeVisible()

  await expect(page.getByRole("button", { name: "Files", exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Changes", exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Tasks", exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Terminal", exact: true })).toBeVisible()
  await expect(page.locator('[data-action="home-open-skills"]')).toBeVisible()
  await expect(page.locator('[data-action="home-open-mcp"]')).toBeVisible()
  await expect(page.locator('[data-action="home-open-scheduled"]')).toBeVisible()

  const dialog = await openSettings(page)
  await expect(dialog.getByRole("tab", { name: "Skills" })).toBeVisible()
  await expect(dialog.getByRole("tab", { name: "MCP" })).toBeVisible()
  await expect(dialog.getByRole("tab", { name: "Scheduled tasks" })).toBeVisible()
  await dialog.getByRole("tab", { name: "Skills" }).click()
  await expect(dialog.locator('[data-slot="settings-v2-row-title"]', { hasText: "review" })).toBeVisible()
  await dialog.getByRole("tab", { name: "MCP" }).click()
  await expect(dialog.getByText("Connect, authenticate, and edit MCP servers for this project.")).toBeVisible()
  await dialog.getByRole("tab", { name: "Scheduled tasks" }).click()
  await expect(dialog.getByText("No scheduled tasks")).toBeVisible()
  await dialog.getByRole("tab", { name: "Providers" }).click()
  await expect(dialog.getByText("Relay keys")).toBeVisible()
  await expect(dialog.getByText("OpenAI")).toHaveCount(0)
})
