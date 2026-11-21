import { waitForDialogsIdle } from "../utils/dialog"
import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"

const directory = "C:/OpenCode/McpAcceptance"
const sessionID = "ses_mcp_acceptance"
const time = { created: 1700000000000, updated: 1700000000000 }

async function prepare(page: Page, commit = Promise.resolve()) {
  const state = { command: ["node", "server.js"], revision: 0 }
  const patches: unknown[] = []
  await mockOpenCodeServer(page, {
    protocol: "v2",
    directory,
    project: {
      id: "proj_mcp_acceptance",
      worktree: directory,
      vcs: "git",
      name: "MCP Acceptance",
      time,
      sandboxes: [],
    },
    provider: { all: [], connected: [], default: {} },
    sessions: [{ id: sessionID, projectID: "proj_mcp_acceptance", directory, title: "MCP acceptance session", time }],
    pageMessages: () => ({ items: [] }),
    gates: { relayMcp: true },
  })
  await page.route("**/mcp?*", (route) => route.fulfill({ json: { sample: { status: "disabled" } } }))
  await page.route("**/config/mcp/sample?*", async (route) => {
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON()
      patches.push(body)
      await commit
      state.command = body.patch.command ?? state.command
      state.revision++
      await route.fulfill({ json: true })
      return
    }
    await route.fulfill({
      json: {
        source: directory + "/opencode.jsonc",
        version: String(state.revision),
        writable: true,
        config: { type: "local", command: state.command, enabled: false },
      },
    })
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
  await page.goto("/" + base64Encode(directory) + "/session/" + sessionID)
  await expect(page.getByRole("heading", { name: "MCP acceptance session", exact: true })).toBeVisible()
  return { state, patches }
}

async function editMcp(page: Page) {
  await waitForDialogsIdle(page)
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const settings = page.locator(".settings-v2-dialog")
  await expect(settings.getByRole("tab", { name: "MCP", exact: true })).toBeEnabled()
  await settings.getByRole("tab", { name: "MCP", exact: true }).click()
  const row = settings.locator('[data-component="settings-v2-row"]').filter({
    has: page.locator('[data-slot="settings-v2-row-title"]', { hasText: /^sample$/ }),
  })
  await expect(row.getByRole("button", { name: "Edit", exact: true })).toBeEnabled()
  await row.getByRole("button", { name: "Edit", exact: true }).click()
  const edit = page.locator(".settings-v2-server-dialog")
  await expect(edit.getByPlaceholder("npx -y @playwright/mcp")).toBeEditable()
  return edit
}

test("real MCP settings traps focus, closes, saves and reloads", async ({ page }, info) => {
  const server = await prepare(page)
  const edit = await editMcp(page)
  await expect(edit.getByPlaceholder("npx -y @playwright/mcp")).toHaveValue("node server.js")
  for (let key = 0; key < 10; key++) {
    await page.keyboard.press("Tab")
    await expect.poll(() => edit.evaluate((element) => element.contains(document.activeElement))).toBe(true)
  }
  await page.screenshot({ path: info.outputPath("mcp-edit-focus.png") })
  await page.keyboard.press("Escape")
  await expect(edit).toHaveCount(0)
  const reopened = await editMcp(page)
  await reopened.getByPlaceholder("npx -y @playwright/mcp").fill("node saved.js")
  const saved = page.waitForResponse(
    (response) => response.request().method() === "PATCH" && new URL(response.url()).pathname === "/config/mcp/sample",
  )
  await reopened.getByRole("button", { name: "Save", exact: true }).click()
  await saved
  await expect(reopened).toHaveCount(0)
  const loaded = await editMcp(page)
  await expect(loaded.getByPlaceholder("npx -y @playwright/mcp")).toHaveValue("node saved.js")
  expect(server.patches).toEqual([
    { source: directory + "/opencode.jsonc", version: "0", patch: { command: ["node", "saved.js"] } },
  ])
  await page.screenshot({ path: info.outputPath("mcp-saved-reopened.png") })
})

test("real MCP late save preserves a replacement dialog and draft", async ({ page }, info) => {
  const pending = Promise.withResolvers<void>()
  const server = await prepare(page, pending.promise)
  try {
    const edit = await editMcp(page)
    await edit.getByPlaceholder("npx -y @playwright/mcp").fill("node first-save.js")
    const submitted = page.waitForRequest(
      (request) => request.method() === "PATCH" && new URL(request.url()).pathname === "/config/mcp/sample",
    )
    await edit.getByRole("button", { name: "Save", exact: true }).click()
    await submitted
    await page.keyboard.press("Escape")
    await expect(edit).toHaveCount(0)
    const replacement = await editMcp(page)
    const draft = replacement.getByPlaceholder("npx -y @playwright/mcp")
    await draft.fill("node replacement-draft.js")
    const completed = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" && new URL(response.url()).pathname === "/config/mcp/sample",
    )
    const refreshed = page.waitForResponse(
      async (response) =>
        response.request().method() === "GET" &&
        new URL(response.url()).pathname === "/config/mcp/sample" &&
        (await response.json()).version === "1",
    )
    pending.resolve()
    await Promise.all([completed, refreshed])
    await expect(draft).toHaveValue("node replacement-draft.js")
    await expect(replacement.getByRole("button", { name: "Save", exact: true })).toBeEnabled()
    expect(server.patches).toHaveLength(1)
    await page.screenshot({ path: info.outputPath("mcp-late-save-preserved-draft.png") })
  } finally {
    pending.resolve()
  }
})

test("closing protects the shortcut until the internal stack is idle", async ({ page }) => {
  await prepare(page)
  const edit = await editMcp(page)
  await edit.getByPlaceholder("npx -y @playwright/mcp").fill("node closing-boundary.js")
  await page.evaluate(() => {
    const output = document.createElement("output")
    output.dataset.testid = "closing-shortcut-result"
    output.hidden = true
    document.body.append(output)
    let attempted: { count: string; accepted: boolean } | undefined
    const observer = new MutationObserver(() => {
      const stack = document.querySelector('[data-component="dialog-stack"]')
      const count = stack?.getAttribute("data-dialog-count")
      if (!attempted && count === "1" && !document.querySelector(".settings-v2-server-dialog")) {
        const event = new KeyboardEvent("keydown", { key: ",", ctrlKey: true, bubbles: true, cancelable: true })
        document.dispatchEvent(event)
        attempted = { count, accepted: event.defaultPrevented }
      }
      if (!attempted || count !== "0") return
      output.textContent = JSON.stringify({ ...attempted, settled: count })
      observer.disconnect()
    })
    observer.observe(document.body, { attributes: true, childList: true, subtree: true })
  })
  await edit.getByRole("button", { name: "Save", exact: true }).click()
  const result = page.getByTestId("closing-shortcut-result")
  await expect(result).toHaveText('{"count":"1","accepted":false,"settled":"0"}')
  await waitForDialogsIdle(page)
  await expect(page.locator(".settings-v2-dialog")).toHaveCount(0)
  await page.keyboard.press("Control+,")
  await expect(page.locator(".settings-v2-dialog").getByRole("tab", { name: "MCP", exact: true })).toBeEnabled()
})

test("DR-01 Escape closes the MCP type list without losing the edit draft", async ({ page }) => {
  await prepare(page)
  const edit = await editMcp(page)
  const command = edit.getByPlaceholder("npx -y @playwright/mcp")
  await command.fill("node keep-unsaved-draft.js")
  await edit.locator('[data-component="select-v2"]').click()
  const list = page.locator('[data-slot="select-v2-listbox"]')
  await expect(list).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(list).toHaveCount(0)
  await expect(edit).toBeVisible()
  await expect(command).toHaveValue("node keep-unsaved-draft.js")
})

test("DR-01 Escape without an inner list closes the MCP edit dialog", async ({ page }) => {
  await prepare(page)
  const edit = await editMcp(page)
  await expect(edit.getByPlaceholder("npx -y @playwright/mcp")).toBeEditable()
  await page.keyboard.press("Escape")
  await waitForDialogsIdle(page)
  await expect(edit).toHaveCount(0)
})

test("DR-02 visible MCP type options remain exposed to assistive technology", async ({ page }, info) => {
  await prepare(page)
  const edit = await editMcp(page)
  await edit.locator('[data-component="select-v2"]').click()
  const list = page.locator('[data-slot="select-v2-listbox"]')
  await expect(list).toBeVisible()
  const hidden = await list.evaluate((el) => {
    const ancestors = []
    for (let node: Element | null = el; node; node = node.parentElement) {
      if (node.getAttribute("aria-hidden") === "true") ancestors.push(node.outerHTML.slice(0, 600))
    }
    return { hiddenAncestors: ancestors, list: el.outerHTML, active: document.activeElement?.outerHTML }
  })
  await info.attach("visible-list-accessibility", { body: JSON.stringify(hidden), contentType: "application/json" })
  await expect(page.getByRole("listbox")).toBeVisible()
})
