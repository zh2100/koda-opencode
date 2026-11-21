import { waitForDialogsIdle } from "../utils/dialog"
import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"

const directory = "C:/OpenCode/McpSource"
const sessionID = "ses_mcp_source"
const project = {
  id: "proj_mcp_source",
  worktree: directory,
  vcs: "git",
  name: "McpSource",
  time: { created: 1700000000000, updated: 1700000000000 },
  sandboxes: [],
}

for (const readOnly of [false, true]) {
  test(`MCP source edit ${readOnly ? "rejects read-only sources" : "saves only changed fields and reloads"}`, async ({
    page,
  }) => {
    const state = { command: ["node", "C:\\Program Files\\server.js", "hello world", ""], revision: 0 }
    const patches: unknown[] = []
    const reads: string[] = []
    await mockOpenCodeServer(page, {
      protocol: "v2",
      directory,
      project,
      provider: { all: [], connected: [], default: {} },
      sessions: [{ id: sessionID, projectID: project.id, directory, title: "MCP source session", time: project.time }],
      pageMessages: () => ({ items: [] }),
      gates: { relayMcp: true },
    })
    await page.route("**/mcp?*", (route) => route.fulfill({ json: { sample: { status: "disabled" } } }))
    await page.route("**/config/mcp/sample?*", async (route) => {
      const url = new URL(route.request().url())
      expect(url.searchParams.get("directory")).toBe(directory)
      if (route.request().method() === "PATCH") {
        const body = route.request().postDataJSON()
        patches.push(body)
        state.command = body.patch.command ?? state.command
        state.revision++
        await route.fulfill({ json: true })
        return
      }
      reads.push(url.href)
      await route.fulfill({
        json: {
          source: readOnly ? "OPENCODE_CONFIG_CONTENT" : `${directory}/opencode.jsonc`,
          version: String(state.revision),
          writable: !readOnly,
          config: { type: "local", command: state.command, environment: { TOKEN: "{env:TEST_TOKEN}" }, enabled: false },
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
    await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
    await expect(page.getByRole("heading", { name: "MCP source session" })).toBeVisible()
    await page.keyboard.press("Control+,")
    const settings = page.locator(".settings-v2-dialog")
    await settings.getByRole("tab", { name: "MCP", exact: true }).click()
    const row = settings
      .locator('[data-component="settings-v2-row"]')
      .filter({ has: page.locator('[data-slot="settings-v2-row-title"]', { hasText: /^sample$/ }) })
    await expect(row.getByRole("button", { name: "Edit", exact: true })).toBeEnabled()
    await row.getByRole("button", { name: "Edit", exact: true }).click()
    const edit = page.locator(".settings-v2-server-dialog")
    const command = edit.getByPlaceholder("npx -y @playwright/mcp")
    await expect(command).toHaveValue(String.raw`node "C:\\Program Files\\server.js" "hello world" ""`)
    if (readOnly) {
      await expect(edit.getByText("This configuration source is read-only.")).toBeVisible()
      await expect(edit.getByRole("button", { name: "Save", exact: true })).toBeDisabled()
      expect(patches).toEqual([])
      return
    }
    await command.fill('node "new file.js" ""')
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" && new URL(response.url()).pathname === "/config/mcp/sample",
    )
    await edit.getByRole("button", { name: "Save", exact: true }).click()
    await saved
    await expect(edit).toHaveCount(0)
    expect(patches).toEqual([
      { source: `${directory}/opencode.jsonc`, version: "0", patch: { command: ["node", "new file.js", ""] } },
    ])
    await waitForDialogsIdle(page)
    await page.keyboard.press("Control+,")
    await settings.getByRole("tab", { name: "MCP", exact: true }).click()
    await row.getByRole("button", { name: "Edit", exact: true }).click()
    await expect(command).toHaveValue('node "new file.js" ""')
    expect(reads.length).toBeGreaterThanOrEqual(2)
  })
}
