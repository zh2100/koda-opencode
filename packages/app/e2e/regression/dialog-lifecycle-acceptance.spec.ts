import { waitForDialogCount, waitForDialogsIdle } from "../utils/dialog"
import { expect, test } from "@playwright/test"

test.describe("dialog lifecycle", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/e2e/reproduction/dialog-lifecycle/index.html")
    await expect(page.getByRole("button", { name: "Open lower", exact: true })).toBeEnabled()
    await page.getByRole("button", { name: "Open lower", exact: true }).click()
    await expect(
      page.getByRole("dialog", { name: "Lower", exact: true }).getByRole("textbox", { name: "Lower draft" }),
    ).toBeEditable()
  })

  test("bound real UI retains focus when an outside control requests it", async ({ page }, info) => {
    const lower = page.getByRole("dialog", { name: "Lower", exact: true })
    await expect(lower.getByRole("textbox", { name: "Lower draft" })).toBeFocused()
    await info.attach("focus-before-outside-request", {
      body: JSON.stringify(
        await lower.evaluate((element) => ({
          focused: document.activeElement?.outerHTML,
          contained: element.contains(document.activeElement),
          sentinels: element.querySelectorAll("[data-focus-trap]").length,
        })),
      ),
      contentType: "application/json",
    })
    await page.getByTestId("outside").focus()
    await expect.poll(() => lower.evaluate((element) => element.contains(document.activeElement))).toBe(true)
    for (let key = 0; key < 8; key++) {
      await page.keyboard.press("Tab")
      await expect.poll(() => lower.evaluate((element) => element.contains(document.activeElement))).toBe(true)
    }
    await page.screenshot({ path: info.outputPath("bound-dialog-focus.png") })
  })

  test("bound real UI honors its native header close", async ({ page }) => {
    const lower = page.getByRole("dialog", { name: "Lower", exact: true })
    await lower.getByRole("button", { name: "Close", exact: true }).click()
    await waitForDialogsIdle(page)
    await expect(page.getByTestId("closed")).toHaveText('["Lower"]')
    await expect(page.getByTestId("disposed")).toHaveText('["Lower"]')
  })

  test("stacked real UI restores the lower dialog after Escape", async ({ page }, info) => {
    const lower = page.getByRole("dialog", { name: "Lower", exact: true })
    await lower.getByRole("button", { name: "Open upper", exact: true }).click()
    const upper = page.getByRole("dialog", { name: "Upper", exact: true })
    await expect(upper.getByRole("textbox", { name: "Upper draft" })).toBeFocused()
    await page.getByTestId("outside").focus()
    await expect.poll(() => upper.evaluate((element) => element.contains(document.activeElement))).toBe(true)
    await page.keyboard.press("Escape")
    await expect(upper).toHaveCount(0)
    await waitForDialogCount(page, 1)
    await expect(lower.locator("[data-focus-trap]")).toHaveCount(2)
    await expect(lower.getByRole("textbox", { name: "Lower draft" })).toBeEditable()
    await info.attach("focus-after-upper-close", {
      body: JSON.stringify(
        await lower.evaluate((element) => ({
          focused: document.activeElement?.outerHTML,
          contained: element.contains(document.activeElement),
          sentinels: element.querySelectorAll("[data-focus-trap]").length,
        })),
      ),
      contentType: "application/json",
    })
    await page.getByTestId("outside").focus()
    await expect.poll(() => lower.evaluate((element) => element.contains(document.activeElement))).toBe(true)
    await lower.getByRole("button", { name: "Close this", exact: true }).click()
    await waitForDialogsIdle(page)
    await expect(page.getByTestId("disposed")).toHaveText('["Upper","Lower"]')
  })

  for (const order of ["lower first", "upper first"]) {
    test("two legal close requests both finish: " + order, async ({ page }) => {
      await page
        .getByRole("dialog", { name: "Lower", exact: true })
        .getByRole("button", { name: "Open upper", exact: true })
        .click()
      const upper = page.getByRole("dialog", { name: "Upper", exact: true })
      await expect(upper.getByRole("textbox", { name: "Upper draft" })).toBeEditable()
      await upper.getByRole("button", { name: "Close both " + order, exact: true }).click()
      await waitForDialogsIdle(page)
      await expect(page.getByTestId("closed")).toHaveText(
        order === "lower first" ? '["Lower","Upper"]' : '["Upper","Lower"]',
      )
      await expect(page.getByTestId("disposed")).toHaveText(
        order === "lower first" ? '["Lower","Upper"]' : '["Upper","Lower"]',
      )
    })
  }

  test("push preserves the old close and leaves the new real UI usable", async ({ page }) => {
    await page
      .getByRole("dialog", { name: "Lower", exact: true })
      .getByRole("button", { name: "Close lower and push upper", exact: true })
      .click()
    await expect(page.getByTestId("disposed")).toHaveText('["Lower"]')
    await waitForDialogCount(page, 1)
    const upper = page.getByRole("dialog", { name: "Upper", exact: true })
    await upper.getByRole("textbox", { name: "Upper draft" }).fill("upper still works")
    await upper.getByRole("button", { name: "Close this", exact: true }).click()
    await waitForDialogsIdle(page)
    await expect(page.getByTestId("disposed")).toHaveText('["Lower","Upper"]')
  })

  test("same-id replacement remains usable and cleans up exactly once", async ({ page }) => {
    await page
      .getByRole("dialog", { name: "Lower", exact: true })
      .getByRole("button", { name: "Replace while closing", exact: true })
      .click()
    await expect(page.getByTestId("disposed")).toHaveText('["Lower"]')
    const replacement = page.getByRole("dialog", { name: "Replacement", exact: true })
    await replacement.getByRole("textbox", { name: "Replacement draft" }).fill("replacement draft")
    await page.getByTestId("outside").focus()
    await expect.poll(() => replacement.evaluate((el) => el.contains(document.activeElement))).toBe(true)
    await replacement.getByRole("button", { name: "Close this", exact: true }).click()
    await waitForDialogsIdle(page)
    await expect(page.getByTestId("disposed")).toHaveText('["Lower","Replacement"]')
  })

  test("Provider teardown disposes open and closing real UI roots", async ({ page }) => {
    await page
      .getByRole("dialog", { name: "Lower", exact: true })
      .getByRole("button", { name: "Open upper", exact: true })
      .click()
    const upper = page.getByRole("dialog", { name: "Upper", exact: true })
    await expect(upper.getByRole("textbox", { name: "Upper draft" })).toBeEditable()
    await upper.getByRole("button", { name: "Unmount while lower closes", exact: true }).click()
    await expect(page.locator('[data-component="dialog-stack"]')).toHaveCount(0)
    await expect(page.getByTestId("disposed")).toHaveText('["Lower","Upper"]')
    await expect(page.getByTestId("closed")).toHaveText('["Lower"]')
    await page.getByTestId("outside").focus()
    await expect(page.getByTestId("outside")).toBeFocused()
  })
})

for (const scenario of ["legacy", "default", "removed", "disabled", "moved", "empty", "popover"]) {
  test("focus matrix: " + scenario, async ({ page }) => {
    await page.goto("/e2e/reproduction/dialog-lifecycle/index.html?scenario=" + scenario)
    await page.getByRole("button", { name: "Open scenario", exact: true }).click()
    const dialog = page.getByRole("dialog", { name: "Scenario", exact: true })
    await waitForDialogCount(page, 1)
    if (scenario === "empty") await expect(dialog).toBeFocused()
    else if (scenario === "default")
      await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeFocused()
    else await expect(dialog.getByRole("textbox", { name: "Scenario draft" })).toBeFocused()
    await page.getByTestId("outside").focus()
    await expect.poll(() => dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true)
    if (["removed", "disabled", "moved"].includes(scenario)) {
      const input = dialog.getByRole("textbox", { name: "Scenario draft" })
      await input.evaluate((el, action) => {
        if (action === "removed") el.remove()
        if (action === "disabled") (el as HTMLInputElement).disabled = true
        if (action === "moved") document.querySelector('[data-testid="outside"]')!.after(el)
      }, scenario)
      await page.getByTestId("outside").focus()
      await expect.poll(() => dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true)
    }
    if (scenario === "default") {
      for (const key of ["Tab", "Shift+Tab", "Tab", "Tab", "Shift+Tab"]) {
        await page.keyboard.press(key)
        await expect.poll(() => dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true)
      }
    }
    if (scenario === "popover") {
      await dialog.getByRole("button", { name: "Open popover", exact: true }).click()
      const popover = page.getByRole("dialog", { name: "Nested popover", exact: true })
      await popover.getByRole("textbox", { name: "Popover draft" }).fill("nested input")
      await expect(popover.getByRole("textbox", { name: "Popover draft" })).toBeFocused()
      await popover.getByRole("button", { name: "Close popover", exact: true }).click()
      await expect(popover).toHaveCount(0)
    }
    await page.keyboard.press("Escape")
    await waitForDialogsIdle(page)
    await page.getByTestId("outside").focus()
    await expect(page.getByTestId("outside")).toBeFocused()
  })
}
