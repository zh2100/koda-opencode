import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"

for (const modern of [false, true]) {
  test(`stops a running v1 session with an unsent draft in the ${modern ? "modern" : "classic"} composer`, async ({ page }) => {
    const directory = "/workspace/stop-test"
    const projectID = "project_stop_test"
    const sessionID = "ses_stop_test"
    const time = { created: 1700000000000, updated: 1700000000000 }
    // Exercise the classic layout before its retirement date.
    if (!modern) await page.clock.setFixedTime(new Date("2026-09-01T00:00:00+08:00"))
    await mockOpenCodeServer(page, {
      protocol: "v1",
      directory,
      project: { id: projectID, worktree: directory, time, vcs: "git", sandboxes: [] },
      sessions: [{ id: sessionID, projectID, directory, time, title: "Stop test", version: "dev", slug: "stop-test" }],
      sessionStatus: { [sessionID]: { type: "busy" } },
      provider: { all: [], connected: [], default: {} },
      pageMessages: () => ({ items: [] }),
    })
    await page.addInitScript((modern) => {
      localStorage.setItem("opencode.global.dat:language", JSON.stringify({ locale: "en" }))
      localStorage.setItem("app-version.v1", JSON.stringify({ version: "1.18.29" }))
      localStorage.setItem("settings.v3", JSON.stringify({
        general: { newLayoutDesigns: modern, layoutTransitionEligible: true, newInterfaceNoticeDismissed: true, shouldDisplayTabsToast: false },
      }))
    }, modern)
    const stopPath = `/session/${sessionID}/abort`
    await page.route((url) => url.pathname === stopPath, (route) => route.fulfill({ json: true }))
    const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
    await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
    const editor = page.locator('[data-component="prompt-input"]')
    const stop = page.locator('[data-action="prompt-submit"]')
    await expect(stop).toHaveAccessibleName("Stop")
    await expect(page.locator('[data-component="prompt-input-v2"]')).toHaveCount(modern ? 1 : 0)
    await editor.fill("Keep this unsent draft")
    const stopped = page.waitForResponse((res) =>
      new URL(res.url()).pathname === stopPath && res.request().method() === "POST" && res.ok(),
    )
    await stop.click()
    await stopped
    await expect(editor).toHaveText("Keep this unsent draft")
  })
}
