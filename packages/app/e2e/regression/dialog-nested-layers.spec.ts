import { expect, test, type Page } from "@playwright/test"
import { waitForDialogCount, waitForDialogsIdle } from "../utils/dialog"

async function open(page: Page, kind: string) {
  await page.goto("/e2e/reproduction/dialog-lifecycle/index.html?scenario=nested-" + kind)
  await page.getByRole("button", { name: "Open scenario", exact: true }).click()
  const parent = page.getByRole("dialog", { name: "Scenario", exact: true })
  await parent.getByRole("textbox", { name: "Scenario draft" }).fill("keep parent draft")
  await parent.getByRole("button", { name: kind.startsWith("select") ? "Local" : "Open child", exact: true }).click()
  return parent
}

for (const kind of ["select-v2", "select", "popover", "menu"]) {
  test("nested " + kind + " exposes only the active layer and Escape preserves its parent", async ({ page }) => {
    const parent = await open(page, kind)
    const child =
      kind === "popover"
        ? page.getByRole("dialog", { name: "Child", exact: true })
        : page.getByRole(kind === "menu" ? "menu" : "listbox")
    await expect(child).toBeVisible()
    await expect(page.getByRole("button", { name: "Outside control", exact: true })).toHaveCount(0)
    if (kind === "popover") await child.getByRole("textbox", { name: "Child draft" }).fill("child draft")
    else
      await expect(
        child.getByRole(kind === "menu" ? "menuitem" : "option", {
          name: kind === "menu" ? "Remote" : "Local",
          exact: true,
        }),
      ).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(child).toHaveCount(0)
    await expect(parent).toBeVisible()
    await expect(parent.getByRole("textbox", { name: "Scenario draft" })).toHaveValue("keep parent draft")
    await expect(
      parent.getByRole("button", { name: kind.startsWith("select") ? "Local" : "Open child", exact: true }),
    ).toBeFocused()
    await waitForDialogCount(page, 1)
    await page.keyboard.press("Escape")
    await waitForDialogsIdle(page)
    await expect(parent).toHaveCount(0)
    await page.getByTestId("outside").focus()
    await expect(page.getByRole("button", { name: "Outside control", exact: true })).toBeFocused()
  })
}

for (const kind of ["select-v2", "select"]) {
  test("nested " + kind + " allows keyboard selection without closing the parent", async ({ page }) => {
    const parent = await open(page, kind)
    const list = page.getByRole("listbox")
    await expect(list.getByRole("option", { name: "Local", exact: true })).toBeFocused()
    await page.keyboard.press("ArrowDown")
    await expect(list.getByRole("option", { name: "Remote", exact: true })).toBeFocused()
    await page.keyboard.press("Enter")
    await expect(list).toHaveCount(0)
    await expect(parent.getByTestId("nested-selection")).toHaveText("Remote")
    await expect(parent.getByRole("textbox", { name: "Scenario draft" })).toHaveValue("keep parent draft")
  })
}

test("SelectV2 inside a real Popover consumes one Escape per layer", async ({ page }) => {
  const parent = await open(page, "popover-select")
  const child = page.getByRole("dialog", { name: "Child", exact: true })
  await child.getByRole("textbox", { name: "Child draft" }).fill("keep child draft")
  await child.getByRole("button", { name: "Local", exact: true }).click()
  const list = page.getByRole("listbox")
  await expect(list).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(list).toHaveCount(0)
  await expect(child.getByRole("textbox", { name: "Child draft" })).toHaveValue("keep child draft")
  await page.keyboard.press("Escape")
  await expect(child).toHaveCount(0)
  await expect(parent.getByRole("textbox", { name: "Scenario draft" })).toHaveValue("keep parent draft")
  await page.keyboard.press("Escape")
  await waitForDialogsIdle(page)
})

for (const kind of ["select-v2", "select", "popover"]) {
  test("standalone " + kind + " retains non-modal outside-focus dismissal", async ({ page }) => {
    await page.goto("/e2e/reproduction/dialog-lifecycle/index.html?scenario=standalone-" + kind)
    await page.getByRole("button", { name: kind.startsWith("select") ? "Local" : "Open child", exact: true }).click()
    const child =
      kind === "popover" ? page.getByRole("dialog", { name: "Child", exact: true }) : page.getByRole("listbox")
    await expect(child).toBeVisible()
    await expect(page.getByRole("button", { name: "Outside control", exact: true })).toBeVisible()
    await page.getByTestId("outside").focus()
    await expect(child).toHaveCount(0)
    await expect(page.getByTestId("outside")).toBeFocused()
  })
}

test("clicking outside a nested Popover keeps the parent draft", async ({ page }) => {
  const parent = await open(page, "popover")
  const child = page.getByRole("dialog", { name: "Child", exact: true })
  await expect(child).toBeVisible()
  // The modal child intentionally hides the parent from accessibility queries.
  // Click the visible outside surface with a real pointer rather than bypassing hit testing.
  const outside = page.getByRole("button", { name: "Fallback control", exact: true, includeHidden: true })
  await expect(outside).toBeVisible()
  const bounds = await outside.boundingBox()
  if (!bounds) throw new Error("The parent outside surface must be rendered")
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
  await expect(child).toHaveCount(0)
  await expect(parent.getByRole("textbox", { name: "Scenario draft" })).toHaveValue("keep parent draft")
})
