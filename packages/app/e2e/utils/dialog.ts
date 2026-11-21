import { expect, type Page } from "@playwright/test"

export async function waitForDialogCount(page: Page, count: number) {
  const stack = page.locator('[data-component="dialog-stack"]')
  await expect(stack).toHaveCount(1)
  await expect(stack).toHaveAttribute("data-dialog-count", String(count))
}

export async function waitForDialogsIdle(page: Page) {
  await waitForDialogCount(page, 0)
}
