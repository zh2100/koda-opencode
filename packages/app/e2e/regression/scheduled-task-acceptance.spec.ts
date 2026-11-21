import { expect, test } from "@playwright/test"

test.skip(process.env.ACC_REFRESH_E2E !== "1", "Requires the owned isolated acceptance server")

test("T09 applicable scheduled-task page reflects the real saved enable state", async ({ page, request }) => {
  const primary = "http://127.0.0.1:44096"
  const name = "scheduled-acceptance-" + crypto.randomUUID()
  const created = await request.post(primary + "/api/scheduled-task", {
    data: {
      name,
      projectID: "global",
      location: { directory: process.env.ACC_PROJECT_ROOT! },
      prompt: { text: "No model call: future disabled task" },
      schedule: "daily",
      timezone: "UTC",
      runAt: Date.now() + 86_400_000,
      model: { providerID: "openai", id: "model" },
      approvalMode: "ask",
      enabled: false,
    },
  })
  expect(created.status()).toBe(200)
  const task = (await created.json()) as { id: string }
  try {
    await page.clock.setFixedTime(new Date("2026-09-01T00:00:00+08:00"))
    await page.addInitScript(() => {
      localStorage.setItem("opencode.global.dat:language", JSON.stringify({ locale: "en" }))
      localStorage.setItem(
        "settings.v3",
        JSON.stringify({
          general: {
            newLayoutDesigns: true,
            layoutTransitionEligible: true,
            newInterfaceNoticeDismissed: true,
          },
        }),
      )
      localStorage.setItem("app-version.v1", JSON.stringify({ version: "1.18.29" }))
    })
    await page.goto(`/${Buffer.from(process.env.ACC_PROJECT_ROOT!).toString("base64url")}/session`, {
      waitUntil: "domcontentloaded",
    })
    await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeEnabled()
    await page.getByRole("button", { name: "Settings", exact: true }).click()
    const dialog = page.locator(".settings-v2-dialog")
    await dialog.getByRole("tab", { name: "Scheduled tasks", exact: true }).click()
    const row = dialog.locator('[data-component="settings-v2-row"]').filter({ hasText: name })
    await expect(row).toHaveCount(1)
    await expect(row.getByRole("button", { name: "Continue", exact: true })).toBeEnabled()
    const enabled = page.waitForResponse(
      (response) =>
        response.url().includes(`/api/scheduled-task/${task.id}/enable`) && response.request().method() === "POST",
    )
    await row.getByRole("button", { name: "Continue", exact: true }).click()
    expect((await enabled).status()).toBe(200)
    await expect(row.getByRole("button", { name: "Submit", exact: true })).toBeEnabled()
    const list = await request.get(primary + "/api/scheduled-task")
    expect(list.status()).toBe(200)
    expect(
      ((await list.json()) as { id: string; enabled: boolean }[]).find((item) => item.id === task.id)?.enabled,
    ).toBe(true)
    await expect(row.getByRole("button", { name: "Continue", exact: true })).toHaveCount(0)
  } finally {
    expect(
      (await request.post(primary + `/api/scheduled-task/${task.id}/enable`, { data: { enabled: false } })).status(),
    ).toBe(200)
  }
})
