import { expect, test, type Locator, type Page } from "@playwright/test"
import { createHash } from "node:crypto"
import { base64Encode } from "@opencode-ai/core/util/encode"
import type { ImageEditSubmitInput } from "../../../client/src/generated/types"
import { fixture } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"

// Two synthetic 128 × 64 PNGs, with distinct solid colors.
const original =
  "iVBORw0KGgoAAAANSUhEUgAAAIAAAABACAYAAADS1n9/AAAAmElEQVR4nO3SMREAIBDAsHeBGfwfrkAGQzNk79BZ+1y65ncABsAAGAADYAAMgAEwAAbAABgAA2AADIABMAAGwAAYAANgAAyAATAABsAAGAADYAAMgAEwAAbAABgAA2AADIABMAAGwAAYIM4AcQaIM0CcAeIMEGeAOAPEGSDOAHEGiDNAnAHiDBBngDgDxBkgzgBxBogzwG57+hBD7gnPb5gAAAAASUVORK5CYII="
const edited =
  "iVBORw0KGgoAAAANSUhEUgAAAIAAAABACAYAAADS1n9/AAAAmElEQVR4nO3SIQEAIBDAwNcEoH9EGkAMxE6cn9icvS5d8zsAA2AADIABMAAGwAAYAANgAAyAATAABsAAGAADYAAMgAEwAAbAABgAA2AADIABMAAGwAAYAANgAAyAATAABsAAGAADYAAMEGeAOAPEGSDOAHEGiDNAnAHiDBBngDgDxBkgzgBxBogzQJwB4gwQZ4A4A8QZYLc9Ai7j0KlPWXwAAAAASUVORK5CYII="
const png = (data: string) => `data:image/png;base64,${data}`
const filename = "رسم 12 - test.png"
const prompt = "عدّل الجزء الأيسر — make it green (12%)"
const target = {
  model: "fixture/masked",
  endpoint: "https://images.invalid/v1/images/edits",
  protocol: "openai-mask",
  binding: "fixture",
}
const workspace = "wrk_mask_fixture"
const message = "msg_mask_fixture"
const call = "tool_mask_fixture"

test.beforeEach(async ({ page, baseURL }) => {
  // Unmocked requests may only reach the local static app, not a real provider or server.
  await page.route(/^https?:\/\//, (route) =>
    new URL(route.request().url()).origin === new URL(baseURL ?? "http://127.0.0.1:3000").origin
      ? route.fallback()
      : route.abort(),
  )
})

for (const layout of ["legacy", "v2"]) {
  test(`${layout}: picker and drop edit only the painted area and preserve original versions`, async ({ page }) => {
    const { requests } = await setup(page, layout === "v2", false, layout === "v2" ? "ar" : "en")
    const editor = page.locator('[data-component="masked-image-editor"]')
    const add = page.locator('[data-action="prompt-attach"]')
    await expect(page.locator("html")).toHaveAttribute("lang", layout === "v2" ? /^ar/ : /^en/)
    await expect(page.locator("html")).toHaveAttribute("dir", layout === "v2" ? "rtl" : "ltr")
    await expect(add).toBeVisible()
    if (layout === "v2") await add.click()
    const chooser = page.waitForEvent("filechooser", { timeout: 10_000 })
    await (layout === "v2" ? page.getByRole("menuitem", { name: "الصور والملفات" }) : add).click()
    await (await chooser).setFiles({ name: filename, mimeType: "image/png", buffer: Buffer.from(original, "base64") })
    await page.getByRole("img", { name: filename, exact: true }).click()
    await expect(editor).toBeVisible()
    await editor.getByRole("button", { name: "Paint area to edit" }).click()
    await paint(page, editor)
    await editor.getByRole("textbox").fill(prompt)
    await editor.getByRole("button", { name: "Clear selection" }).click()
    await expect(editor.getByRole("button", { name: "Review request" })).toBeDisabled()
    await paint(page, editor)
    await editor.getByRole("button", { name: "Review request" }).click()
    await expect(editor.getByText("may incur charges", { exact: false })).toBeVisible()
    await expect(editor.getByText(target.endpoint)).toBeVisible()
    await expect(editor.getByRole("button", { name: /original image edit/i })).toHaveCount(0)
    expect(requests).toHaveLength(0)
    await editor.getByRole("button", { name: "Send image edit" }).click()
    await expect(editor.locator('[data-slot="image-edit-versions"] > summary')).toHaveText("Edit 1")
    expect(requests[0]).toMatchObject({ source: { type: "upload", image: original }, target, prompt, confirmed: true })
    const mask = requests[0]?.mask
    if (!mask) throw new Error("No committed mask")
    expect(
      await page.evaluate(async (src) => {
        const image = new Image()
        image.src = src
        await image.decode()
        const canvas = document.createElement("canvas")
        canvas.width = image.width
        canvas.height = image.height
        const ctx = canvas.getContext("2d")
        if (!ctx) throw new Error("No 2D context")
        ctx.drawImage(image, 0, 0)
        return [
          canvas.width,
          canvas.height,
          ctx.getImageData(24, 24, 1, 1).data[3],
          ctx.getImageData(104, 24, 1, 1).data[3],
        ]
      }, png(mask)),
    ).toEqual([128, 64, 0, 255])
    await expect(editor.getByRole("link", { name: "Download image" })).toHaveAttribute("href", png(edited))
    const download = page.waitForEvent("download")
    await editor.getByRole("link", { name: "Download image" }).click()
    const stream = await (await download).createReadStream()
    const bytes = []
    for await (const chunk of stream) bytes.push(chunk)
    expect(Buffer.concat(bytes).toString("base64")).toBe(edited)
    await editor.locator('[data-slot="image-edit-versions"] > summary').click()
    await editor.getByRole("button", { name: "Original", exact: true }).click()
    await expect(editor.getByRole("link", { name: "Download image" })).toHaveAttribute("href", /^blob:/)
    await editor.locator('[data-slot="image-edit-versions"] > summary').click()
    await editor.getByRole("button", { name: "Edit 1", exact: true }).click()
    await expect(editor.getByRole("button", { name: "Review request" })).toBeDisabled()
    await paint(page, editor)
    await editor.getByRole("textbox").fill("Second edit")
    await editor.getByRole("button", { name: "Review request" }).click()
    await editor.getByRole("button", { name: "Send image edit" }).click()
    await expect(editor.locator('[data-slot="image-edit-versions"] > summary')).toHaveText("Edit 2")
    expect(requests[1]).toMatchObject({ source: { type: "edit", id: requests[0]?.id }, scope: requests[0]?.scope })
    await page.keyboard.press("Escape")
    await expect(page.locator('[data-component="dialog-stack"]')).toHaveAttribute("data-dialog-count", "0")

    for (const file of [
      { name: "dropped.png", mime: "image/png", bytes: edited },
      { name: "preview.gif", mime: "image/gif", bytes: "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" },
      { name: "preview.pdf", mime: "application/pdf", bytes: Buffer.from("%PDF-1.4\n%%EOF\n").toString("base64") },
    ]) {
      await page.locator('[data-component="prompt-input"]').evaluate((element, file) => {
        const transfer = new DataTransfer()
        transfer.items.add(
          new File([Uint8Array.from(atob(file.bytes), (char) => char.charCodeAt(0))], file.name, { type: file.mime }),
        )
        element.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer }))
        element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }))
      }, file)
      const attachments = page.locator('[data-slot="prompt-attachments"]')
      await (
        layout === "v2" && file.mime === "application/pdf"
          ? attachments
              .locator('[data-component="attachment-card-v2"][data-clickable="true"]')
              .filter({ hasText: file.name })
          : attachments.getByRole("button", { name: file.name, exact: true })
      ).click({ timeout: 10_000 })
      const preview = page.locator('[data-component="image-preview"]')
      await expect(file.mime === "image/png" ? editor : preview, file.name).toBeVisible()
      expect(requests).toHaveLength(2)
      await page.keyboard.press("Escape")
      await expect(page.locator('[data-component="dialog-stack"]')).toHaveAttribute("data-dialog-count", "0")
    }
  })
}

test("v2: a generated image binds its session, workspace and digest; cancelling only allows reconciliation", async ({
  page,
}) => {
  const { requests } = await setup(page, true, true)
  await expect(page.locator("html")).toHaveAttribute("lang", /^ar/)
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl")
  const generated = page.locator('[data-component="tool-image-attachments"]').getByRole("button", { name: filename })
  await generated.click()
  const editor = page.locator('[data-component="masked-image-editor"]')
  await editor.getByRole("button", { name: "Paint area to edit" }).click()
  await paint(page, editor)
  await editor.getByRole("textbox").fill(prompt)
  await expect(editor.getByRole("textbox")).toHaveCSS("direction", "rtl")
  await editor.locator('[data-slot="image-edit-status"] > summary').click()
  await expect(editor.getByText("Image generation model:", { exact: false })).toHaveCSS("direction", "ltr")
  await expect(editor.getByText("Automatically using the model", { exact: false })).toHaveCSS("direction", "ltr")
  await editor.getByRole("button", { name: "Review request" }).click()
  await expect(editor.getByText("may incur charges", { exact: false })).toHaveCSS("direction", "ltr")
  await editor.getByRole("button", { name: "Send image edit" }).click()
  await expect.poll(() => requests.length).toBe(1)
  await editor.getByRole("button", { name: "Cancel request" }).click()
  await expect(editor.getByRole("alert")).toContainText("cancelled locally")
  await editor.getByRole("button", { name: "Check the same request" }).click()
  await expect(editor.locator('[data-slot="image-edit-versions"] > summary')).toHaveText("Edit 1")
  expect(requests).toHaveLength(2)
  expect(requests[1]).toEqual({ ...requests[0], reconcile: true })
  expect(requests[0]).toMatchObject({
    scope: { type: "session", id: fixture.sourceID },
    source: {
      type: "generated",
      messageID: message,
      callID: call,
      digest: createHash("sha256").update(Buffer.from(original, "base64")).digest("hex"),
    },
  })
})

test("v2: a late receipt cannot enter a different session or a reopened editor", async ({ page }) => {
  const { requests, release } = await setup(page, true, true)
  const editor = page.locator('[data-component="masked-image-editor"]')
  const generated = page.locator('[data-component="tool-image-attachments"]').getByRole("button", { name: filename })
  const navigate = (sessionID: string) =>
    page.evaluate(
      (path) => {
        history.pushState(history.state, "", path)
        window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }))
      },
      `/${base64Encode(fixture.directory)}/session/${sessionID}`,
    )

  await generated.click()
  await editor.getByRole("button", { name: "Paint area to edit" }).click()
  await paint(page, editor)
  await editor.getByRole("textbox").fill(prompt)
  await editor.getByRole("button", { name: "Review request" }).click()
  await editor.getByRole("button", { name: "Send image edit" }).click()
  await expect.poll(() => requests.length).toBe(1)

  // A same-document route change exercises editor cleanup without resetting the page.
  const cancelled = page.waitForEvent("requestfailed", {
    predicate: (request) => request.method() === "POST" && new URL(request.url()).pathname === "/api/image-edit",
  })
  await navigate(fixture.targetID)
  await expect(page).toHaveURL(new RegExp(`${fixture.targetID}$`))
  await expect(page.locator('[data-component="dialog-stack"]')).toHaveAttribute("data-dialog-count", "0")
  await navigate(fixture.sourceID)
  await generated.click()
  release()
  expect((await cancelled).failure()?.errorText).toContain("ERR_ABORTED")
  await expect(editor.getByRole("link", { name: "Download image" })).toHaveAttribute("href", png(original))
  await expect(editor.getByRole("button", { name: "Edit 1" })).toHaveCount(0)
  expect(requests).toHaveLength(1)
})

test("automatic generation model checks distinguish relay compatibility, unknown capability and lookup failure", async ({
  page,
}) => {
  const { requests } = await setup(page, true)
  const model = "leidiandonghua/custom:gpt:gpt-image-2.5-flare"
  const checks: string[] = []
  await page.route(/\/api\/image-edit\/status\?/, (route) => {
    checks.push(route.request().method())
    const headers = { "access-control-allow-origin": "*" }
    if (checks.length === 2) return route.fulfill({ status: 503, headers })
    if (checks.length === 3) return route.fulfill({ status: 404, headers })
    if (checks.length === 4)
      return route.fulfill({
        json: {
          generation: { model, state: "compatible" },
          editor: { state: "configured", target: { ...target, model }, source: "generation" },
        },
        headers,
      })
    if (checks.length === 5)
      return route.fulfill({
        json: {
          generation: { model, state: "unsupported" },
          editor: { state: "unconfigured" },
        },
        headers,
      })
    return route.fulfill({
      json: { generation: { model, state: "unknown" }, editor: { state: "unconfigured" } },
      headers,
    })
  })
  await page.locator('[data-action="prompt-attach"]').click()
  const chooser = page.waitForEvent("filechooser")
  await page.getByRole("menuitem", { name: "Images and files" }).click()
  await (await chooser).setFiles({ name: filename, mimeType: "image/png", buffer: Buffer.from(original, "base64") })
  await page.getByRole("img", { name: filename, exact: true }).click()
  const editor = page.locator('[data-component="masked-image-editor"]')
  const refresh = editor.getByRole("button", { name: "Recheck image models" })
  await expect(editor.getByText(model, { exact: true })).toHaveAttribute("dir", "ltr")
  await expect(editor.getByText("Mask support has not been verified", { exact: false })).toBeVisible()
  await expect(editor.getByText("No compatible masked editor was detected", { exact: false })).toBeVisible()
  const download = editor.getByRole("link", { name: "Download image" })
  await expect(download).toBeInViewport({ ratio: 1 })
  await expect(refresh).toBeInViewport({ ratio: 1 })
  const file = page.waitForEvent("download")
  await download.click()
  const stream = await (await file).createReadStream()
  const bytes = []
  for await (const chunk of stream) bytes.push(chunk)
  expect(Buffer.concat(bytes).toString("base64")).toBe(original)
  await expect(editor.getByRole("button", { name: "Paint area to edit" })).toHaveCount(0)
  await refresh.click()
  await expect(editor.getByText("Could not check image models on this server. Try again.")).toBeVisible()
  await expect(download).toBeInViewport({ ratio: 1 })
  await expect(refresh).toBeInViewport({ ratio: 1 })
  await expect(editor.getByText("No compatible masked editor was detected", { exact: false })).toHaveCount(0)
  await refresh.click()
  await editor.locator('[data-slot="image-edit-status"] > summary').click()
  await expect(editor.getByText("Could not check the generation model on this server.")).toBeVisible()
  await expect(editor.getByRole("button", { name: "Paint area to edit" })).toBeVisible()
  await refresh.click()
  await editor.locator('[data-slot="image-edit-status"] > summary').click()
  await expect(editor.getByText("Automatically using the model from image generation settings:")).toBeVisible()
  await expect(editor.getByText("This relay's support and access are unverified", { exact: false })).toBeVisible()
  await editor.getByRole("button", { name: "Paint area to edit" }).click()
  await paint(page, editor)
  await editor.getByRole("textbox").fill(prompt)
  await editor.getByRole("button", { name: "Review request" }).click()
  await editor.locator('[data-slot="image-edit-status"] > summary').click()
  await expect(refresh).toBeDisabled()
  await expect(editor.getByText(target.endpoint, { exact: true })).toBeVisible()
  expect(requests).toHaveLength(0)
  await editor.getByRole("button", { name: "Back to editing" }).click()
  await refresh.click()
  await expect(editor.getByText("The selected model or API is not supported", { exact: false })).toBeVisible()
  await expect(editor.getByRole("button", { name: "Paint area to edit" })).toHaveCount(0)
  expect(checks).toEqual(["GET", "GET", "GET", "GET", "GET"])
  expect(requests).toHaveLength(0)
})

for (const direction of ["ltr", "rtl"]) {
  const locale = direction === "rtl" ? "ar" : "en"
  const fileMenu = direction === "rtl" ? "الصور والملفات" : "Images and files"
  test(`selection tools: shapes, eraser, undo and zoom preserve source coordinates (${direction})`, async ({
    page,
  }) => {
    const { requests } = await setup(page, true, false, locale)
    await expect(page.locator("html")).toHaveAttribute("dir", direction)
    await expect(page.locator("html")).toHaveAttribute("lang", new RegExp(`^${locale}`))
    await page.locator('[data-action="prompt-attach"]').click()
    const chooser = page.waitForEvent("filechooser")
    await page.getByRole("menuitem", { name: fileMenu }).click()
    await (await chooser).setFiles({ name: filename, mimeType: "image/png", buffer: Buffer.from(original, "base64") })
    await page.getByRole("img", { name: filename, exact: true }).click()
    const editor = page.locator('[data-component="masked-image-editor"]')
    await expect(editor).toBeVisible()
    if (direction === "rtl") await page.setViewportSize({ width: 720, height: 900 })
    const canvas = editor.locator("canvas")
    const review = editor.getByRole("button", { name: "Review request" })
    const undo = editor.getByRole("button", { name: "Undo last stroke" })
    const slider = editor.getByRole("slider", { name: "Brush size (source pixels)", exact: true })
    const range = async (control: Locator, value: number) => {
      const brush = (await control.count()) === 0
      if (brush) await editor.locator('[data-slot="image-edit-settings"] > summary').click()
      await control.evaluate((element, value) => {
        if (!(element instanceof HTMLInputElement)) throw new Error("Not a slider")
        element.value = String(value)
        element.dispatchEvent(new Event("input", { bubbles: true }))
      }, value)
      if (brush) await editor.locator('[data-slot="image-edit-settings"] > summary').click()
    }
    const drag = async (from: number[], to: number[]) => {
      const box = await canvas.boundingBox()
      if (!box) throw new Error("Missing canvas")
      await page.mouse.move(box.x + (from[0] * box.width) / 128, box.y + (from[1] * box.height) / 64)
      await page.mouse.down()
      await page.mouse.move(box.x + (to[0] * box.width) / 128, box.y + (to[1] * box.height) / 64, { steps: 4 })
      await page.mouse.up()
    }
    const alpha = (x: number, y: number) =>
      canvas.evaluate(
        (element, point) => {
          if (!(element instanceof HTMLCanvasElement)) throw new Error("Not a canvas")
          return element.getContext("2d")?.getImageData(point.x, point.y, 1, 1).data[3]
        },
        { x, y },
      )
    await editor.getByRole("textbox").fill(prompt)
    await expect(undo).toBeDisabled()
    await editor.locator('[data-slot="image-edit-settings"] > summary').click()
    await slider.focus()
    await page.keyboard.press("Home")
    await expect(slider).toHaveValue("4")
    await page.keyboard.press("ArrowRight")
    await expect(slider).toHaveValue("5")
    await editor.locator('[data-slot="image-edit-settings"] > summary').click()
    await editor.getByRole("button", { name: "Rectangle", exact: true }).click()
    await drag([52, 48], [8, 8])
    expect(await alpha(24, 24)).toBe(255)
    expect(await alpha(100, 24)).toBe(0)
    await editor.getByRole("button", { name: "Eraser", exact: true }).click()
    await range(slider, 120)
    await drag([30, 28], [30, 28])
    await expect(review).toBeDisabled()
    await expect(editor.getByRole("button", { name: "Clear selection", exact: true })).toBeEnabled()
    await undo.click()
    await expect(review).toBeEnabled()
    expect(await alpha(24, 24)).toBe(255)
    await undo.click()
    await expect(review).toBeDisabled()
    await drag([30, 28], [30, 28])
    await editor.getByRole("button", { name: "Clear selection", exact: true }).click()
    await expect(undo).toBeDisabled()
    expect(await alpha(24, 24)).toBe(0)
    await editor.getByRole("button", { name: "Ellipse", exact: true }).click()
    await drag([8, 8], [52, 48])
    expect(await alpha(30, 28)).toBe(255)
    expect(await alpha(9, 9)).toBe(0)
    await editor.getByRole("button", { name: "Clear selection" }).click()
    await expect(undo).toBeDisabled()
    await range(slider, 4)
    await editor.getByRole("button", { name: "Line", exact: true }).click()
    await drag([8, 16], [52, 16])
    expect(await alpha(24, 16)).toBe(255)
    expect(await alpha(24, 24)).toBe(0)
    await undo.click()
    await editor.getByRole("button", { name: "Brush", exact: true }).click()
    await drag([24, 24], [24, 24])
    const before = await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL())
    const fitted = await canvas.boundingBox()
    await range(editor.getByRole("slider", { name: "Zoom", exact: true }), 200)
    await expect(editor.getByText("200%", { exact: true })).toBeVisible()
    expect((await canvas.boundingBox())?.width).toBe((fitted?.width ?? 0) * 2)
    expect(await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL())).toBe(before)
    await editor.getByRole("button", { name: "Eraser", exact: true }).click()
    await range(slider, 12)
    await drag([24, 24], [24, 24])
    await expect(review).toBeDisabled()
    await undo.click()
    expect(await alpha(24, 24)).toBe(255)
    await editor.getByRole("button", { name: "Clear selection" }).click()
    await editor.getByRole("button", { name: "Arrow selection", exact: true }).click()
    await editor.locator('[data-slot="image-edit-settings"] > summary').click()
    await expect(editor.getByText("it is not a direction instruction", { exact: false })).toBeVisible()
    await editor.locator('[data-slot="image-edit-settings"] > summary').click()
    await range(slider, 4)
    await drag([8, 24], [48, 24])
    expect(await alpha(24, 24)).toBe(255)
    expect(await alpha(40, 21)).toBeGreaterThan(0)
    expect(await alpha(104, 24)).toBe(0)
    await editor.getByRole("button", { name: "Fit image", exact: true }).click()
    await expect(editor.getByText("100%", { exact: true })).toBeVisible()
    // Interrupted pointer gestures roll back instead of leaving an unreviewed partial shape.
    const committed = await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL())
    const box = await canvas.boundingBox()
    if (!box) throw new Error("Missing canvas")
    await page.mouse.move(box.x + 80, box.y + 24)
    await page.mouse.down()
    await canvas.dispatchEvent("pointercancel", { pointerId: 1 })
    await page.mouse.up()
    expect(await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL())).toBe(committed)
    await editor.getByRole("button", { name: "Eraser", exact: true }).click()
    await range(slider, 12)
    await drag([24, 24], [24, 24])
    expect(await alpha(24, 24)).toBe(0)
    expect(await alpha(36, 24)).toBe(255)
    expect(requests).toHaveLength(0)
    await review.click()
    await expect(editor.locator('[data-slot="image-edit-settings"] > summary')).toHaveAttribute("aria-disabled", "true")
    await expect(editor.getByRole("button", { name: "Arrow selection", exact: true })).toBeDisabled()
    await editor.getByRole("button", { name: "Send image edit", exact: true }).click()
    await expect.poll(() => requests.length).toBe(1)
    expect(requests[0]).toMatchObject({ source: { type: "upload", image: original }, prompt, confirmed: true })
    expect(
      await page.evaluate(async (src) => {
        const image = new Image()
        image.src = src
        await image.decode()
        const canvas = document.createElement("canvas")
        canvas.width = image.width
        canvas.height = image.height
        const ctx = canvas.getContext("2d")
        if (!ctx) throw new Error("No context")
        ctx.drawImage(image, 0, 0)
        return [
          canvas.width,
          canvas.height,
          ctx.getImageData(36, 24, 1, 1).data[3],
          ctx.getImageData(24, 24, 1, 1).data[3],
          ctx.getImageData(104, 24, 1, 1).data[3],
        ]
      }, png(requests[0].mask)),
    ).toEqual([128, 64, 0, 255, 255])
    await expect(editor.locator('[data-slot="image-edit-versions"] > summary')).toHaveText("Edit 1")
    await expect(undo).toBeDisabled()
    await expect(review).toBeDisabled()
    await editor.getByRole("button", { name: "Brush", exact: true }).click()
    // Undo depth is bounded; older strokes remain in the flattened base mask.
    for (let index = 0; index < 31; index++) await drag([24, 24], [24, 24])
    for (let index = 0; index < 30; index++) await undo.click()
    await expect(undo).toBeDisabled()
    expect(await alpha(24, 24)).toBe(255)
    await editor.getByRole("button", { name: "Clear selection", exact: true }).click()
    expect(await alpha(24, 24)).toBe(0)
    await expect(review).toBeDisabled()
    expect(requests).toHaveLength(1)
  })

  test(`acceptance: large image scroll, resize and pointer boundaries (${direction})`, async ({ page }) => {
    const { requests } = await setup(page, true, false, locale)
    await expect(page.locator("html")).toHaveAttribute("dir", direction)
    const image = await page.evaluate(() => {
      const canvas = document.createElement("canvas")
      canvas.width = 2048
      canvas.height = 1024
      const ctx = canvas.getContext("2d")
      if (!ctx) throw new Error("No context")
      ctx.fillStyle = "#ffffff"
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      return canvas.toDataURL().split(",")[1]
    })
    await page.locator('[data-action="prompt-attach"]').click()
    const chooser = page.waitForEvent("filechooser")
    await page.getByRole("menuitem", { name: fileMenu }).click()
    await (await chooser).setFiles({ name: filename, mimeType: "image/png", buffer: Buffer.from(image, "base64") })
    await page.getByRole("img", { name: filename, exact: true }).click()
    const editor = page.locator('[data-component="masked-image-editor"]')
    const canvas = editor.locator("canvas")
    const viewport = editor.locator('[data-slot="image-edit-viewport"]')
    const alpha = (x: number, y: number) =>
      canvas.evaluate(
        (element: HTMLCanvasElement, point) => element.getContext("2d")?.getImageData(point.x, point.y, 1, 1).data[3],
        { x, y },
      )
    await editor.getByRole("button", { name: "Brush", exact: true }).click()
    await page.setViewportSize({ width: 720, height: 700 })
    await expect
      .poll(() => canvas.evaluate((element: HTMLCanvasElement) => [element.width, element.height]))
      .toEqual([2048, 1024])
    const before = await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL())
    const zoom = editor.getByRole("slider", { name: "Zoom", exact: true })
    await zoom.focus()
    await page.keyboard.press("Home")
    await expect(zoom).toHaveValue("50")
    await expect(editor.getByRole("button", { name: "Zoom out", exact: true })).toBeDisabled()
    await page.keyboard.press("End")
    await expect(zoom).toHaveValue("200")
    await expect(editor.getByRole("button", { name: "Zoom in", exact: true })).toBeDisabled()
    expect(await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL())).toBe(before)
    await viewport.scrollIntoViewIfNeeded()
    await viewport.evaluate((element) => {
      element.scrollLeft = element.scrollWidth
      element.scrollTop = element.scrollHeight
    })
    expect(await viewport.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0)
    expect(await viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
    const box = await viewport.boundingBox()
    const geometry = await canvas.boundingBox()
    if (!box || !geometry) throw new Error("Missing viewport")
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    const source = {
      x: Math.floor(((point.x - geometry.x) * 2048) / geometry.width),
      y: Math.floor(((point.y - geometry.y) * 1024) / geometry.height),
    }
    await page.mouse.click(point.x, point.y, { button: "right" })
    expect(await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL())).toBe(before)
    await page.mouse.click(point.x, point.y)
    expect(await alpha(source.x, source.y)).toBe(255)
    expect(await alpha(10, 10)).toBe(0)
    await page.screenshot({ path: `../../.tmp/image-edit-acceptance-scrolled-${direction}.png` })
    const committed = await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL())
    await editor.getByRole("button", { name: "Rectangle", exact: true }).click()
    await viewport.scrollIntoViewIfNeeded()
    const frame = await viewport.boundingBox()
    if (!frame) throw new Error("Missing viewport")
    await page.mouse.move(frame.x + frame.width / 2, frame.y + frame.height / 2)
    await page.mouse.down()
    await page.mouse.move(frame.x + frame.width / 2 + 30, frame.y + frame.height / 2 + 30)
    await expect(editor.getByRole("button", { name: "Undo last stroke" })).toBeDisabled()
    await canvas.evaluate((element: HTMLCanvasElement) => {
      element.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 1, bubbles: true }))
    })
    await page.mouse.up()
    expect(await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL())).toBe(committed)
    await page.setViewportSize({ width: 720, height: 500 })
    await editor.getByRole("button", { name: "Fit image", exact: true }).click()
    await expect
      .poll(async () => {
        const image = await canvas.boundingBox()
        const frame = await viewport.boundingBox()
        return !!image && !!frame && image.height <= frame.height && image.width <= frame.width
      })
      .toBe(true)
    expect(await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL())).toBe(committed)
    await editor.getByRole("textbox").fill(prompt)
    await editor.getByRole("button", { name: "Review request" }).click()
    await expect(editor.getByRole("textbox")).toHaveJSProperty("readOnly", true)
    await editor.getByRole("button", { name: "Back to editing", exact: true }).focus()
    await page.keyboard.press("Enter")
    await expect(editor.getByRole("textbox")).toHaveValue(prompt)
    await expect(editor.getByRole("textbox")).toBeEnabled()
    expect(await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL())).toBe(committed)
    expect(requests).toHaveLength(0)
    await page.screenshot({ path: `../../.tmp/image-edit-acceptance-large-${direction}.png` })
  })
}

test("acceptance: Chinese tools, multiline instructions and keyboard confirmation", async ({ page }) => {
  const { requests } = await setup(page, true, false, "zh")
  await expect(page.locator("html")).toHaveAttribute("lang", /^zh/)
  await page.locator('[data-action="prompt-attach"]').click()
  const chooser = page.waitForEvent("filechooser")
  await page.getByRole("menuitem", { name: "图片和文件" }).click()
  await (await chooser).setFiles({ name: filename, mimeType: "image/png", buffer: Buffer.from(original, "base64") })
  await page.getByRole("img", { name: filename, exact: true }).click()
  const editor = page.locator('[data-component="masked-image-editor"]')
  await page.setViewportSize({ width: 360, height: 740 })
  await expect(editor).toBeVisible()
  expect(await editor.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
  await expect(editor.getByRole("group", { name: "选区工具" })).toBeVisible()
  for (const name of ["画笔", "橡皮擦", "矩形", "椭圆", "直线", "箭头形选区"])
    await expect(editor.getByRole("button", { name, exact: true })).toBeVisible()
  const review = editor.getByRole("button", { name: "下一步：核对修改", exact: true })
  await editor.getByRole("button", { name: "画笔", exact: true }).click()
  await paint(page, editor)
  await editor.getByRole("textbox").fill(" \n ")
  await expect(review).toBeDisabled()
  const description = "把选区改为绿色\n保留右侧 العربية 12%"
  await editor.getByRole("textbox").fill(description)
  await review.focus()
  await page.keyboard.press("Enter")
  expect(requests).toHaveLength(0)
  await expect(editor.locator('[data-slot="image-edit-settings"] > summary')).toHaveAttribute("aria-disabled", "true")
  const confirm = editor.getByRole("button", { name: "确认并开始修改", exact: true })
  await confirm.scrollIntoViewIfNeeded()
  await expect(confirm).toBeInViewport({ ratio: 1 })
  await confirm.focus()
  await page.screenshot({ path: "../../.tmp/image-edit-acceptance-chinese-review.png" })
  await page.keyboard.press("Enter")
  await expect.poll(() => requests.length).toBe(1)
  expect(requests[0].prompt).toBe(description)
  await expect(editor.locator('[data-slot="image-edit-versions"] > summary')).toHaveText("修改版 1")
})

test("layout: first screen contains the full image, tools and instructions", async ({ page }) => {
  await page.setViewportSize({ width: 1645, height: 1186 })
  const { requests } = await setup(page, true, false, "zh")
  const image = await page.evaluate(() => {
    const canvas = document.createElement("canvas")
    canvas.width = 1536
    canvas.height = 1024
    const ctx = canvas.getContext("2d")
    if (!ctx) throw new Error("No context")
    ctx.fillStyle = "#d7e9f0"
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = "#183f66"
    ctx.fillRect(0, 0, canvas.width, 32)
    ctx.fillRect(0, canvas.height - 32, canvas.width, 32)
    ctx.fillRect(0, 0, 32, canvas.height)
    ctx.fillRect(canvas.width - 32, 0, 32, canvas.height)
    ctx.font = "80px sans-serif"
    ctx.fillText("1536 × 1024 · Full image", 100, canvas.height / 2)
    return canvas.toDataURL().split(",")[1]
  })
  await page.locator('[data-action="prompt-attach"]').click()
  const chooser = page.waitForEvent("filechooser")
  await page.getByRole("menuitem", { name: "图片和文件" }).click()
  await (await chooser).setFiles({ name: filename, mimeType: "image/png", buffer: Buffer.from(image, "base64") })
  await page.getByRole("img", { name: filename, exact: true }).click()
  const editor = page.locator('[data-component="masked-image-editor"]')
  await expect(editor.getByRole("button", { name: "画笔", exact: true })).toBeEnabled()
  for (const control of [
    editor.locator("canvas"),
    editor.getByRole("button", { name: "画笔", exact: true }),
    editor.getByRole("textbox"),
    editor.getByRole("link", { name: "下载图片" }),
  ]) {
    await expect(control).toBeInViewport({ ratio: 1 })
    expect(
      await control.evaluate((element) => {
        const frame = element.closest('[data-slot="dialog-content"]')?.getBoundingClientRect()
        const box = element.getBoundingClientRect()
        return (
          !!frame &&
          box.top >= frame.top &&
          box.bottom <= frame.bottom &&
          box.left >= frame.left &&
          box.right <= frame.right
        )
      }),
    ).toBe(true)
  }
  await expect(page.getByRole("dialog", { name: "编辑图片" })).toBeVisible()
  await page.screenshot({ path: "../../.tmp/image-edit-floating-desktop.png" })
  const tools = editor.locator('[data-slot="image-edit-tools"]')
  const view = editor.locator('[data-slot="image-edit-view"]')
  const empty = await editor.locator("canvas").evaluate((element: HTMLCanvasElement) => element.toDataURL())
  const drag = editor.getByRole("button", { name: "移动绘图工具栏" })
  await drag.focus()
  await page.keyboard.press("Enter")
  await expect(tools).toHaveAttribute("data-bottom", "")
  const handle = await drag.boundingBox()
  const stage = await editor.locator('[data-slot="image-edit-stage"]').boundingBox()
  if (!handle || !stage) throw new Error("Missing floating toolbar")
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
  await page.mouse.down()
  await page.mouse.move(stage.x + 24, stage.y + 24, { steps: 5 })
  await page.mouse.up()
  await expect(tools).not.toHaveAttribute("data-bottom")
  await editor.getByRole("button", { name: "移动查看工具栏" }).click()
  await expect(view).toHaveAttribute("data-bottom", "")
  expect(await editor.locator("canvas").evaluate((element: HTMLCanvasElement) => element.toDataURL())).toBe(empty)
  await editor.getByRole("button", { name: "画笔", exact: true }).click()
  await paint(page, editor)
  const marked = await editor.locator("canvas").evaluate((element: HTMLCanvasElement) => element.toDataURL())
  await editor.locator('[data-slot="image-edit-settings"] > summary').click()
  await expect(editor.getByRole("slider", { name: "画笔大小（原图像素）", exact: true })).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(editor).toBeVisible()
  await expect(editor.locator('[data-slot="image-edit-settings"]')).not.toHaveAttribute("open")
  const download = page.waitForEvent("download")
  await editor.getByRole("link", { name: "下载图片" }).click()
  const file = await download
  const stream = await file.createReadStream()
  const bytes = []
  for await (const chunk of stream) bytes.push(chunk)
  expect(Buffer.concat(bytes).toString("base64")).toBe(image)
  expect(await editor.locator("canvas").evaluate((element: HTMLCanvasElement) => element.toDataURL())).toBe(marked)
  for (const size of [
    { width: 1000, height: 700 },
    { width: 360, height: 740 },
  ]) {
    await page.setViewportSize(size)
    for (const control of [
      editor.locator("canvas"),
      editor.getByRole("textbox"),
      editor.getByRole("link", { name: "下载图片" }),
      editor.getByRole("button", { name: "下一步：核对修改" }),
    ])
      await expect(control).toBeInViewport({ ratio: 1 })
    for (const control of [
      editor.getByRole("button", { name: "画笔", exact: true }),
      editor.getByRole("link", { name: "下载图片" }),
      editor.getByRole("textbox"),
      editor.locator('[data-slot="image-edit-status"] > summary'),
      page.getByRole("button", { name: "关闭", exact: true }),
    ])
      await expect
        .poll(() =>
          control.evaluate((element) => {
            const box = element.getBoundingClientRect()
            return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))
          }),
        )
        .toBe(true)
    expect(await editor.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
    expect(await editor.locator("canvas").evaluate((element: HTMLCanvasElement) => element.toDataURL())).toBe(marked)
  }
  await page.screenshot({ path: "../../.tmp/image-edit-floating-narrow.png" })
  await page.keyboard.press("Escape")
  await expect(editor).toHaveCount(0)
  expect(requests).toHaveLength(0)
})

test("layout: portrait image fits the available viewport", async ({ page }) => {
  const { requests } = await setup(page, true)
  await page.setViewportSize({ width: 1100, height: 740 })
  const image = await page.evaluate(() => {
    const canvas = document.createElement("canvas")
    canvas.width = 1024
    canvas.height = 1536
    const ctx = canvas.getContext("2d")
    if (!ctx) throw new Error("No context")
    ctx.fillStyle = "#d7e9f0"
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = "#183f66"
    ctx.fillRect(0, 0, canvas.width, 32)
    ctx.fillRect(0, canvas.height - 32, canvas.width, 32)
    ctx.fillRect(0, 0, 32, canvas.height)
    ctx.fillRect(canvas.width - 32, 0, 32, canvas.height)
    ctx.font = "60px sans-serif"
    ctx.fillText("1024 × 1536", 100, canvas.height / 2)
    return canvas.toDataURL().split(",")[1]
  })
  await page.locator('[data-action="prompt-attach"]').click()
  const chooser = page.waitForEvent("filechooser")
  await page.getByRole("menuitem", { name: "Images and files" }).click()
  await (await chooser).setFiles({ name: filename, mimeType: "image/png", buffer: Buffer.from(image, "base64") })
  await page.getByRole("img", { name: filename, exact: true }).click()
  const editor = page.locator('[data-component="masked-image-editor"]')
  const canvas = editor.locator("canvas")
  await expect(editor.getByRole("button", { name: "Brush", exact: true })).toBeEnabled()
  await expect(canvas).toBeInViewport({ ratio: 1 })
  const box = await canvas.boundingBox()
  expect((box?.width ?? 0) / (box?.height ?? 1)).toBeCloseTo(2 / 3)
  await expect(editor.getByRole("textbox")).toBeInViewport({ ratio: 1 })
  await page.screenshot({ path: "../../.tmp/image-edit-floating-portrait.png" })
  await page.keyboard.press("Escape")
  await expect(page.locator(".image-edit-dialog")).toHaveCount(0)
  expect(requests).toHaveLength(0)
})

test("layout: ordinary preview and public settings keep their geometry and Escape behavior", async ({ page }) => {
  const { requests } = await setup(page, false)
  await page.route("**/pty/shells", (route) => route.fulfill({ json: [] }))
  await page.setViewportSize({ width: 1100, height: 740 })
  await page.locator('[data-component="prompt-input"]').evaluate((element, original) => {
    const transfer = new DataTransfer()
    transfer.items.add(
      new File(
        [
          Uint8Array.from(atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"), (char) =>
            char.charCodeAt(0),
          ),
        ],
        "preview.gif",
        { type: "image/gif" },
      ),
    )
    transfer.items.add(
      new File([Uint8Array.from(atob(original), (char) => char.charCodeAt(0))], "edit.png", { type: "image/png" }),
    )
    element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }))
  }, original)
  const preview = page.locator('[data-slot="image-preview-container"]')
  const settings = page.locator('[data-slot="dialog-container"]:has(.settings-dialog)')
  const measurements = []
  for (const edited of [false, true]) {
    if (edited) {
      await page.getByRole("img", { name: "edit.png", exact: true }).click()
      const editor = page.locator('[data-component="masked-image-editor"]')
      await expect(editor.getByRole("button", { name: "Brush", exact: true })).toBeEnabled()
      await page.keyboard.press("Escape")
      await expect(editor).toHaveCount(0)
    }
    await page.getByRole("img", { name: "preview.gif", exact: true }).click()
    await expect(preview).toBeVisible()
    await expect(page.locator(".image-edit-dialog")).toHaveCount(0)
    const image = await preview.boundingBox()
    expect(image?.width).toBe(990)
    expect(image?.height).toBe(666)
    await page.getByRole("button", { name: "Close", exact: true }).focus()
    await page.keyboard.press("Escape")
    await expect(preview).toHaveCount(0)
    await page.getByRole("button", { name: "Toggle menu", exact: true }).click()
    await page.getByRole("button", { name: "Settings", exact: true }).click()
    await expect(settings).toBeVisible()
    const dialog = await settings.boundingBox()
    expect(dialog?.width).toBe(980)
    expect(dialog?.height).toBe(600)
    await page.getByRole("tab", { name: "General", exact: true }).focus()
    await page.keyboard.press("Tab")
    expect(await settings.evaluate((element) => element.contains(document.activeElement))).toBe(true)
    measurements.push({ image, dialog })
    await page.keyboard.press("Escape")
    await expect(settings).toHaveCount(0)
    await page.getByRole("button", { name: "Toggle menu", exact: true }).click()
  }
  expect(measurements[1]).toEqual(measurements[0])
  expect(requests).toHaveLength(0)
})

async function paint(page: Page, editor: Locator) {
  const box = await editor.locator("canvas").boundingBox()
  if (!box) throw new Error("Mask canvas not visible")
  await page.mouse.move(box.x + box.width * 0.1875, box.y + box.height * 0.375)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.375)
  await page.mouse.up()
}

async function setup(page: Page, v2: boolean, generated = false, locale = generated ? "ar" : "en") {
  const requests: Omit<ImageEditSubmitInput, "location">[] = []
  // The legacy layout intentionally becomes unavailable after its product sunset.
  if (!v2) await page.clock.setFixedTime(new Date("2026-08-25T12:00:00Z"))
  const sessions = fixture.sessions.map((session) => (generated ? { ...session, workspaceID: workspace } : session))
  await mockOpenCodeServer(page, {
    protocol: generated ? "v2" : "v1",
    sessions,
    directory: fixture.directory,
    project: fixture.project,
    provider: fixture.provider,
    pageMessages: () => ({ items: [] }),
  })
  if (generated) {
    await page.route(`**/api/session/${fixture.sourceID}/message?*`, (route) =>
      route.fulfill({
        json: {
          data: [
            {
              id: message,
              type: "assistant",
              time: { created: 1700000001000 },
              agent: "build",
              model: { id: "fixture", providerID: "fixture" },
              content: [
                {
                  type: "tool",
                  id: call,
                  name: "image_generation",
                  time: { start: 1700000001000, end: 1700000001100 },
                  state: {
                    status: "completed",
                    input: {},
                    structured: {},
                    content: [{ type: "file", uri: png(original), mime: "image/png", name: filename }],
                  },
                },
              ],
            },
            { id: "msg_mask_prompt", type: "user", time: { created: 1700000000000 }, text: "Draw a synthetic fixture" },
          ],
          cursor: {},
        },
      }),
    )
  }
  const result = Promise.withResolvers<void>()
  await page.route(/\/api\/image-edit(?:\/(?:target|status))?(?:\?|$)/, async (route) => {
    const request = route.request()
    const headers = {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
    }
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers })
    const url = new URL(request.url())
    expect(url.searchParams.get("location[directory]")).toBe(fixture.directory)
    expect(url.searchParams.get("location[workspace]")).toBe(generated ? workspace : null)
    if (url.pathname === "/api/image-edit/status")
      return route.fulfill({
        json: {
          generation: { model: target.model, state: "compatible" },
          editor: { state: "configured", target, source: "generation" },
        },
        headers,
      })
    if (url.pathname === "/api/image-edit/target") return route.fulfill({ json: target, headers })
    const body: Omit<ImageEditSubmitInput, "location"> = request.postDataJSON()
    requests.push(body)
    if (generated && !body.reconcile) await result.promise
    if (body.reconcile) result.resolve()
    await route.fulfill({ json: { id: body.id, mime: "image/png", data: edited }, headers })
  })
  await page.addInitScript(
    ({ v2, locale }) => {
      localStorage.setItem("app-version.v1", JSON.stringify({ version: "1.18.29" }))
      localStorage.setItem(
        "settings.v3",
        JSON.stringify({
          general: { newLayoutDesigns: v2, layoutTransitionEligible: true, newInterfaceNoticeDismissed: true },
        }),
      )
      localStorage.setItem("opencode.global.dat:language", JSON.stringify({ locale }))
    },
    { v2, locale },
  )
  await page.goto(`/${base64Encode(fixture.directory)}/session/${fixture.sourceID}`)
  return { requests, release: result.resolve }
}
