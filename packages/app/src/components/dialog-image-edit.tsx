import "./dialog-image-edit.css"
import { Dialog } from "@opencode-ai/ui/dialog"
import { ImagePreview } from "@opencode-ai/ui/image-preview"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { createEffect, createResource, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useParams, useSearchParams } from "@solidjs/router"
import { ClientError } from "@opencode-ai/client"
import type { GeneratedApi } from "@/utils/server"
import type { ImageEditSubmitInput } from "../../../client/src/generated/types"

type Source = ImageEditSubmitInput["source"]
type Scope = ImageEditSubmitInput["scope"]
type Preview = { src: string; alt?: string; mime?: string }
type Generated = { sessionID: string; messageID: string; callID: string }
type Point = { x: number; y: number }
type Tool = "brush" | "eraser" | "rectangle" | "ellipse" | "line" | "arrow"
type Stroke = { tool: Tool; size: number; points: Point[] }
const prefix = "data:image/png;base64,"

export function useImageEditor(session: () => string | undefined, directory?: () => string) {
  const sdk = useSDK()
  const sync = useSync()
  const dialog = useDialog()
  const params = useParams()
  const [search] = useSearchParams()
  return (preview: Preview, generated?: Generated) => {
    const context = sdk()
    const sessionID = session()
    const routeSession = params.id
    const draft = search.draftId
    const info = sessionID ? sync().session.get(sessionID) : undefined
    const path = info?.directory ?? directory?.() ?? context.directory
    const workspace = info?.workspaceID
    if (
      preview.mime !== "image/png" ||
      !(preview.src.startsWith(prefix) || (!generated && preview.src.startsWith("blob:"))) ||
      (generated && (!info || sessionID !== generated.sessionID))
    )
      return dialog.show(() => <ImagePreview {...preview} />)
    const scope: Scope = sessionID ? { type: "session", id: sessionID } : { type: "draft", id: crypto.randomUUID() }
    const lifetime = new AbortController()
    return dialog.show(
      () => (
        <ImageEditor
          preview={preview}
          generated={generated}
          api={context.api}
          scope={scope}
          location={{ directory: path, workspace }}
          lifetime={lifetime}
          active={() => {
            const current = sessionID ? sync().session.get(sessionID) : undefined
            return (
              sdk().scope === context.scope &&
              session() === sessionID &&
              params.id === routeSession &&
              search.draftId === draft &&
              (current?.directory ?? directory?.() ?? sdk().directory) === path &&
              current?.workspaceID === workspace
            )
          }}
        />
      ),
      () => lifetime.abort(),
    )
  }
}

function ImageEditor(props: {
  preview: Preview
  generated?: Generated
  api: GeneratedApi
  scope: Scope
  location: ImageEditSubmitInput["location"]
  lifetime: AbortController
  active: () => boolean
}) {
  const language = useLanguage()
  const dialog = useDialog()
  const lifetime = props.lifetime
  const location = props.location
  const [status, statusActions] = createResource(async () => {
    const options = { signal: lifetime.signal }
    return props.api.imageEdit.status({ location }, options).catch((error: unknown) => {
      if (!(error instanceof ClientError) || error.reason !== "UnexpectedStatus") return undefined
      const cause = error.cause
      if (!cause || typeof cause !== "object" || !("status" in cause) || cause.status !== 404) return undefined
      // Older servers can still edit using their explicit target, but cannot diagnose the generation model.
      return props.api.imageEdit
        .target({ location }, options)
        .then((target) => ({
          generation: { state: "failed" as const, model: undefined },
          editor: target ? { state: "configured" as const, target } : { state: "legacyUnavailable" as const },
        }))
        .catch(() => undefined)
    })
  })
  const target = () => {
    if (status.loading) return
    const editor = status()?.editor
    if (editor?.state === "configured") return editor.target
  }
  const [state, set] = createStore({
    prompt: "",
    painting: false,
    ready: false,
    marked: false,
    review: false,
    busy: false,
    failure: undefined as "prepare" | "dispatch" | "cancelled" | undefined,
    versions: [{ ...props.preview, id: undefined as string | undefined }],
    index: 0,
    tool: "brush" as Tool,
    size: 24,
    zoom: 100,
    width: 0,
    height: 0,
    available: 0,
    viewport: 0,
    dock: "top" as "top" | "bottom",
    viewBottom: false,
    drawing: false,
    undo: 0,
  })
  const drag = { pointer: undefined as number | undefined, y: 0, moved: false, dock: "top" as "top" | "bottom" }
  const current = () => state.versions[state.index]
  const work = {
    canvas: undefined as HTMLCanvasElement | undefined,
    request: undefined as AbortController | undefined,
    pointer: undefined as number | undefined,
    stroke: undefined as Stroke | undefined,
    history: [] as Stroke[],
    base: undefined as HTMLCanvasElement | undefined,
    retry: undefined as ImageEditSubmitInput | undefined,
  }

  onCleanup(() => lifetime.abort())
  createEffect(() => {
    if (!props.active()) {
      lifetime.abort()
      dialog.close()
    }
  })

  // Zoom changes display geometry only; strokes and exported masks stay in source pixels.
  const scale = () =>
    (Math.min(1, state.available / (state.width || 1), state.viewport / (state.height || 1)) * state.zoom) / 100

  function draw(ctx: CanvasRenderingContext2D, stroke: Stroke) {
    const from = stroke.points[0]
    const to = stroke.points[stroke.points.length - 1]
    if (!from || !to) return
    ctx.save()
    ctx.globalCompositeOperation = stroke.tool === "eraser" ? "destination-out" : "source-over"
    ctx.lineWidth = stroke.size
    ctx.lineCap = ctx.lineJoin = "round"
    ctx.fillStyle = ctx.strokeStyle = "#ee376b"
    ctx.beginPath()
    if (stroke.tool === "rectangle") {
      ctx.rect(Math.min(from.x, to.x), Math.min(from.y, to.y), Math.abs(to.x - from.x), Math.abs(to.y - from.y))
      ctx.fill()
      ctx.restore()
      return
    }
    if (stroke.tool === "ellipse") {
      ctx.ellipse(
        (from.x + to.x) / 2,
        (from.y + to.y) / 2,
        Math.abs(to.x - from.x) / 2,
        Math.abs(to.y - from.y) / 2,
        0,
        0,
        Math.PI * 2,
      )
      ctx.fill()
      ctx.restore()
      return
    }
    ctx.moveTo(from.x, from.y)
    stroke.points.slice(1).forEach((point) => ctx.lineTo(point.x, point.y))
    ctx.stroke()
    // A click is a dot, including when erasing.
    if (stroke.points.length === 1) {
      ctx.beginPath()
      ctx.arc(from.x, from.y, stroke.size / 2, 0, Math.PI * 2)
      ctx.fill()
    }
    if (stroke.tool === "arrow" && (from.x !== to.x || from.y !== to.y)) {
      const angle = Math.atan2(to.y - from.y, to.x - from.x)
      const head = Math.min(Math.hypot(to.x - from.x, to.y - from.y), stroke.size * 3)
      ctx.beginPath()
      ctx.moveTo(to.x, to.y)
      ctx.lineTo(to.x - head * Math.cos(angle - Math.PI / 6), to.y - head * Math.sin(angle - Math.PI / 6))
      ctx.lineTo(to.x - head * Math.cos(angle + Math.PI / 6), to.y - head * Math.sin(angle + Math.PI / 6))
      ctx.closePath()
      ctx.fill()
    }
    ctx.restore()
  }

  function redraw(preview?: Stroke) {
    const canvas = work.canvas
    const ctx = canvas?.getContext("2d")
    if (!canvas || !ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    if (work.base) ctx.drawImage(work.base, 0, 0)
    work.history.forEach((stroke) => draw(ctx, stroke))
    if (preview) draw(ctx, preview)
  }

  function selection() {
    const canvas = work.canvas
    const pixels = canvas?.getContext("2d")?.getImageData(0, 0, canvas.width, canvas.height).data
    set("marked", pixels?.some((value, index) => index % 4 === 3 && value !== 0) ?? false)
    set("undo", work.history.length)
    work.retry = undefined
  }

  function undo() {
    if (state.drawing || state.busy || state.review) return
    work.history.pop()
    redraw()
    selection()
  }

  function clear() {
    const canvas = work.canvas
    canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height)
    set("marked", false)
    set("review", false)
    work.pointer = undefined
    work.stroke = undefined
    work.history = []
    work.base = undefined
    set("undo", 0)
    set("drawing", false)
    work.retry = undefined
  }

  function paint(event: PointerEvent & { currentTarget: HTMLCanvasElement }, start: boolean) {
    const canvas = event.currentTarget
    if (state.busy || state.review || !state.painting || !state.ready || !target()) return
    if (start) {
      if (!event.isPrimary || event.button !== 0 || work.pointer !== undefined) return
      canvas.setPointerCapture(event.pointerId)
      work.pointer = event.pointerId
      work.stroke = { tool: state.tool, size: state.size, points: [] }
      set("drawing", true)
    }
    if (work.pointer !== event.pointerId) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    const rect = canvas.getBoundingClientRect()
    const x = ((event.clientX - rect.left) * canvas.width) / rect.width
    const y = ((event.clientY - rect.top) * canvas.height) / rect.height
    const stroke = work.stroke
    if (!stroke) return
    const point = { x: Math.max(0, Math.min(canvas.width, x)), y: Math.max(0, Math.min(canvas.height, y)) }
    if (stroke.tool === "brush" || stroke.tool === "eraser") {
      const last = stroke.points[stroke.points.length - 1]
      stroke.points.push(point)
      draw(ctx, { ...stroke, points: last ? [last, point] : [point] })
    }
    if (stroke.tool !== "brush" && stroke.tool !== "eraser") {
      stroke.points = stroke.points.length ? [stroke.points[0], point] : [point]
      redraw(stroke)
    }
    work.retry = undefined
  }

  function end(event: PointerEvent) {
    if (event.pointerId !== work.pointer) return
    const stroke = work.stroke
    work.pointer = undefined
    work.stroke = undefined
    if (stroke && event.type === "pointerup") {
      work.history.push(stroke)
      // Keep 30 undoable vector operations, not 30 full-size RGBA snapshots.
      if (work.history.length > 30 && work.canvas) {
        work.base ??= document.createElement("canvas")
        if (work.base.width !== work.canvas.width || work.base.height !== work.canvas.height) {
          work.base.width = work.canvas.width
          work.base.height = work.canvas.height
        }
        const ctx = work.base.getContext("2d")
        const oldest = work.history.shift()
        if (ctx && oldest) draw(ctx, oldest)
      }
    }
    redraw()
    selection()
    set("drawing", false)
    if (work.canvas?.hasPointerCapture(event.pointerId)) work.canvas.releasePointerCapture(event.pointerId)
  }

  async function submit() {
    if (!props.active() || lifetime.signal.aborted || state.busy || !state.review) return
    const chosen = target()
    const canvas = work.canvas
    const view = current()
    if (!chosen || !canvas || !view || !state.marked || !state.prompt.trim()) return
    set("busy", true)
    set("failure", undefined)
    const request = new AbortController()
    work.request = request
    const signal = AbortSignal.any([request.signal, lifetime.signal])
    try {
      const reconcile = work.retry !== undefined
      if (!work.retry) {
        const ctx = canvas.getContext("2d")
        if (!ctx) throw new Error("No canvas context")
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height)
        for (let i = 0; i < pixels.data.length; i += 4) {
          const marked = pixels.data[i + 3] !== 0
          pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = 255
          pixels.data[i + 3] = marked ? 0 : 255
        }
        const mask = document.createElement("canvas")
        mask.width = canvas.width
        mask.height = canvas.height
        const maskContext = mask.getContext("2d")
        if (!maskContext) throw new Error("No mask context")
        maskContext.putImageData(pixels, 0, 0)
        const source: Source = await (async () => {
          if (view.id) return { type: "edit", id: view.id }
          const blob = await fetch(view.src, { signal }).then((response) => response.blob())
          if (blob.size > 6 * 1024 * 1024) throw new Error("Image is too large")
          const bytes = new Uint8Array(await blob.arrayBuffer())
          if (props.generated) {
            const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
            const digest = Array.from(hash, (value) => value.toString(16).padStart(2, "0")).join("")
            return { type: "generated", messageID: props.generated.messageID, callID: props.generated.callID, digest }
          }
          const chunks = []
          for (let offset = 0; offset < bytes.length; offset += 0x8000)
            chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)))
          const image = btoa(chunks.join(""))
          return { type: "upload", image }
        })()
        work.retry = {
          id: crypto.randomUUID(),
          location,
          source,
          scope: props.scope,
          target: chosen,
          confirmed: true,
          mask: mask.toDataURL("image/png").slice(prefix.length),
          prompt: state.prompt,
        }
      }
      if (!props.active() || signal.aborted) return
      const result = await props.api.imageEdit.submit(reconcile ? { ...work.retry, reconcile: true } : work.retry, {
        signal,
      })
      if (!props.active() || signal.aborted) return
      set("versions", (versions) => [
        ...versions,
        { id: result.id, mime: result.mime, src: `data:${result.mime};base64,${result.data}`, alt: props.preview.alt },
      ])
      set("index", state.versions.length - 1)
      set("ready", false)
      set("prompt", "")
      clear()
    } catch {
      if (!lifetime.signal.aborted)
        set("failure", request.signal.aborted ? "cancelled" : work.retry ? "dispatch" : "prepare")
    } finally {
      if (!lifetime.signal.aborted) set("busy", false)
      work.request = undefined
    }
  }

  return (
    <Dialog title={<span>{language.t("imageEdit.title")}</span>} size="large" class="image-edit-dialog">
      <div
        data-component="masked-image-editor"
        onPointerDown={(event) => {
          if (!(event.target instanceof Element)) return
          event.currentTarget
            .querySelectorAll<HTMLDetailsElement>(
              '[data-slot="image-edit-settings"][open], [data-slot="image-edit-versions"][open]',
            )
            .forEach((element) => {
              if (!element.contains(event.target as Node)) element.open = false
            })
        }}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return
          const opened = event.currentTarget.querySelectorAll<HTMLDetailsElement>("details[open]")
          if (!opened.length) return
          event.preventDefault()
          event.stopPropagation()
          opened.forEach((element) => {
            element.open = false
            element.querySelector("summary")?.focus()
          })
        }}
      >
        <div data-slot="image-edit-stage">
          <div
            data-slot="image-edit-viewport"
            dir="ltr"
            ref={(element) => {
              const observer = new ResizeObserver(() =>
                set({ available: element.clientWidth, viewport: element.clientHeight }),
              )
              observer.observe(element)
              onCleanup(() => observer.disconnect())
            }}
          >
            <Show when={current()} keyed>
              {(image) => (
                <div
                  data-slot="image-edit-image"
                  style={{
                    width: state.width ? `${state.width * scale()}px` : undefined,
                    height: state.height ? `${state.height * scale()}px` : undefined,
                  }}
                >
                  <img
                    src={image.src}
                    alt={image.alt ?? language.t("ui.imagePreview.alt")}
                    draggable={false}
                    classList={{ "image-edit-loading": !state.ready }}
                    onLoad={(event) => {
                      const element = event.currentTarget
                      const canvas = work.canvas
                      set("width", element.naturalWidth)
                      set("height", element.naturalHeight)
                      if (
                        !canvas ||
                        element.naturalWidth * element.naturalHeight > 16_777_216 ||
                        element.naturalWidth > 8192 ||
                        element.naturalHeight > 8192
                      )
                        return
                      canvas.width = element.naturalWidth
                      canvas.height = element.naturalHeight
                      set("zoom", 100)
                      set("ready", true)
                    }}
                  />
                  <canvas
                    ref={(element) => {
                      work.canvas = element
                    }}
                    aria-hidden="true"
                    class="absolute inset-0 size-full opacity-45"
                    classList={{
                      "pointer-events-none": !state.painting || state.busy || state.review,
                      "touch-none cursor-crosshair": state.painting,
                    }}
                    onPointerDown={(event) => paint(event, true)}
                    onPointerMove={(event) => paint(event, false)}
                    onPointerUp={(event) => {
                      paint(event, false)
                      end(event)
                    }}
                    onPointerCancel={end}
                    onLostPointerCapture={end}
                  />
                </div>
              )}
            </Show>
          </div>
          <Show when={target() && state.ready && current()?.mime === "image/png"}>
            <fieldset
              data-slot="image-edit-tools"
              data-bottom={state.dock === "bottom" ? "" : undefined}
              disabled={state.review || state.busy || state.drawing}
            >
              <legend class="sr-only">{language.t("imageEdit.tools")}</legend>
              <button
                type="button"
                data-slot="image-edit-drag"
                title={language.t("imageEdit.moveTools")}
                aria-label={language.t("imageEdit.moveTools")}
                onClick={(event) => {
                  if (!drag.moved || event.detail === 0) set("dock", state.dock === "top" ? "bottom" : "top")
                }}
                onPointerDown={(event) => {
                  if (!event.isPrimary || event.button !== 0) return
                  drag.pointer = event.pointerId
                  drag.moved = false
                  drag.y = event.clientY
                  drag.dock = state.dock
                  event.currentTarget.setPointerCapture(event.pointerId)
                }}
                onPointerMove={(event) => {
                  if (drag.pointer !== event.pointerId || Math.abs(event.clientY - drag.y) < 6) return
                  drag.moved = true
                  const box = event.currentTarget.closest('[data-slot="image-edit-stage"]')?.getBoundingClientRect()
                  if (box) set("dock", event.clientY > box.top + box.height / 2 ? "bottom" : "top")
                }}
                onPointerUp={(event) => {
                  drag.pointer = undefined
                  if (event.currentTarget.hasPointerCapture(event.pointerId))
                    event.currentTarget.releasePointerCapture(event.pointerId)
                }}
                onPointerCancel={() => {
                  drag.pointer = undefined
                  set("dock", drag.dock)
                }}
                onLostPointerCapture={() => {
                  drag.pointer = undefined
                }}
              >
                <ImageEditIcon name="move" />
              </button>
              <button
                type="button"
                title={language.t("imageEdit.paint")}
                aria-label={language.t("imageEdit.paint")}
                aria-pressed={state.painting}
                onClick={() => set("painting", !state.painting)}
              >
                <ImageEditIcon name="hand" />
              </button>
              <For each={["brush", "eraser", "rectangle", "ellipse", "line", "arrow"] as const}>
                {(tool) => (
                  <button
                    type="button"
                    title={language.t(`imageEdit.tool.${tool}`)}
                    aria-label={language.t(`imageEdit.tool.${tool}`)}
                    aria-pressed={state.painting && state.tool === tool}
                    onClick={() => {
                      set("tool", tool)
                      set("painting", true)
                    }}
                  >
                    <ImageEditIcon name={tool} />
                  </button>
                )}
              </For>
              <button
                type="button"
                title={language.t("imageEdit.undo")}
                aria-label={language.t("imageEdit.undo")}
                disabled={!state.undo}
                onClick={undo}
              >
                <ImageEditIcon name="undo" />
              </button>
              <button
                type="button"
                title={language.t("imageEdit.clear")}
                aria-label={language.t("imageEdit.clear")}
                disabled={!state.marked && !state.undo}
                onClick={clear}
              >
                <ImageEditIcon name="clear" />
              </button>
              <details data-slot="image-edit-settings">
                <summary
                  aria-label={language.t("imageEdit.brushSize")}
                  title={language.t("imageEdit.brushSize")}
                  aria-disabled={state.review || state.busy || state.drawing}
                  onClick={(event) => {
                    if (state.review || state.busy || state.drawing) event.preventDefault()
                  }}
                >
                  <ImageEditIcon name="size" />
                </summary>
                <div data-slot="image-edit-popup">
                  <label>
                    {language.t("imageEdit.brushSize")}
                    <input
                      type="range"
                      min="4"
                      max="120"
                      step="1"
                      value={state.size}
                      aria-label={language.t("imageEdit.brushSize")}
                      dir="ltr"
                      onInput={(event) => set("size", event.currentTarget.valueAsNumber)}
                    />
                    <bdi dir="ltr">{language.t("imageEdit.pixels", { number: state.size })}</bdi>
                  </label>
                  <p>{language.t("imageEdit.maskHint")}</p>
                  <Show when={state.tool === "arrow"}>
                    <p>{language.t("imageEdit.arrowHint")}</p>
                  </Show>
                </div>
              </details>
            </fieldset>
          </Show>
          <div data-slot="image-edit-view" data-bottom={state.viewBottom ? "" : undefined}>
            <Show when={target() && state.ready && current()?.mime === "image/png"}>
              <button
                type="button"
                title={language.t("imageEdit.zoomOut")}
                aria-label={language.t("imageEdit.zoomOut")}
                disabled={state.zoom <= 50 || state.review || state.busy || state.drawing}
                onClick={() => set("zoom", Math.max(50, state.zoom - 10))}
              >
                <ImageEditIcon name="minus" />
              </button>
              <label data-slot="image-edit-zoom">
                <span class="sr-only">{language.t("imageEdit.zoom")}</span>
                <input
                  type="range"
                  min="50"
                  max="200"
                  step="10"
                  value={state.zoom}
                  dir="ltr"
                  aria-label={language.t("imageEdit.zoom")}
                  disabled={state.review || state.busy || state.drawing}
                  onInput={(event) => set("zoom", event.currentTarget.valueAsNumber)}
                />
                <bdi dir="ltr">{language.t("imageEdit.zoomPercent", { number: state.zoom })}</bdi>
              </label>
              <button
                type="button"
                title={language.t("imageEdit.zoomIn")}
                aria-label={language.t("imageEdit.zoomIn")}
                disabled={state.zoom >= 200 || state.review || state.busy || state.drawing}
                onClick={() => set("zoom", Math.min(200, state.zoom + 10))}
              >
                <ImageEditIcon name="plus" />
              </button>
              <button
                type="button"
                title={language.t("imageEdit.fit")}
                aria-label={language.t("imageEdit.fit")}
                disabled={state.review || state.busy || state.drawing}
                onClick={() => set("zoom", 100)}
              >
                <ImageEditIcon name="fit" />
              </button>
            </Show>
            <a
              href={current()?.src}
              download=""
              title={language.t("imageEdit.download")}
              aria-label={language.t("imageEdit.download")}
            >
              <ImageEditIcon name="download" />
            </a>
            <button
              type="button"
              data-slot="image-edit-move-view"
              title={language.t("imageEdit.moveView")}
              aria-label={language.t("imageEdit.moveView")}
              disabled={state.review || state.busy || state.drawing}
              onClick={() => set("viewBottom", !state.viewBottom)}
            >
              <ImageEditIcon name="move" />
            </button>
          </div>
        </div>
        <div data-slot="image-edit-footer">
          <div data-slot="image-edit-meta">
            <Show when={state.versions.length > 1}>
              <details data-slot="image-edit-versions">
                <summary>
                  {state.index === 0
                    ? language.t("imageEdit.original")
                    : language.t("imageEdit.version", { number: state.index })}
                </summary>
                <div data-slot="image-edit-popup">
                  <For each={state.versions}>
                    {(_, index) => (
                      <button
                        type="button"
                        aria-pressed={index() === state.index}
                        disabled={state.busy || state.drawing}
                        onClick={(event) => {
                          const details = event.currentTarget.closest("details")
                          if (details) details.open = false
                          details?.querySelector("summary")?.focus()
                          if (index() === state.index) return
                          clear()
                          set("ready", false)
                          set("index", index())
                        }}
                      >
                        {index() === 0
                          ? language.t("imageEdit.original")
                          : language.t("imageEdit.version", { number: index() })}
                      </button>
                    )}
                  </For>
                </div>
              </details>
            </Show>
            <details data-slot="image-edit-status" open={!target()}>
              <summary>{language.t("imageEdit.models")}</summary>
              <div data-slot="image-edit-status-body">
                <div role="status" class="break-words">
                  <Show when={!status.loading} fallback={<p>{language.t("imageEdit.status.loading")}</p>}>
                    <Show when={status()} keyed fallback={<p>{language.t("imageEdit.status.failed")}</p>}>
                      {(result) => (
                        <>
                          <p dir="auto">
                            {language.t("imageEdit.generation.label")}{" "}
                            <Show when={result.generation.model}>
                              <bdi dir="ltr" class="break-all">
                                {result.generation.model}
                              </bdi>
                              {" · "}
                            </Show>
                            {language.t(`imageEdit.generation.${result.generation.state}`)}
                          </p>
                          <p dir="auto">
                            {result.editor.state === "legacyUnavailable"
                              ? language.t("imageEdit.unavailable")
                              : result.editor.state === "configured" &&
                                  "source" in result.editor &&
                                  result.editor.source === "generation"
                                ? language.t("imageEdit.editor.automatic")
                                : result.editor.state === "unconfigured" && result.generation.state !== "unconfigured"
                                  ? language.t("imageEdit.editor.notDetected")
                                  : language.t(`imageEdit.editor.${result.editor.state}`)}
                            <Show
                              when={
                                result.editor.state === "configured"
                                  ? result.editor.target.model
                                  : result.editor.state === "unavailable"
                                    ? result.editor.model
                                    : undefined
                              }
                            >
                              {(model) => (
                                <>
                                  {" "}
                                  <bdi dir="ltr" class="break-all">
                                    {model()}
                                  </bdi>
                                </>
                              )}
                            </Show>
                          </p>
                        </>
                      )}
                    </Show>
                  </Show>
                </div>
                <button
                  class="self-start"
                  type="button"
                  disabled={status.loading || state.review || state.busy || state.drawing}
                  onClick={() => void statusActions.refetch()}
                >
                  {language.t("imageEdit.status.refresh")}
                </button>
              </div>
            </details>
          </div>
          <Show when={current()?.mime !== "image/png"}>
            <p role="status">{language.t("imageEdit.resultNotEditable")}</p>
          </Show>
          <Show
            when={
              !state.ready && (state.width > 8192 || state.height > 8192 || state.width * state.height > 16_777_216)
            }
          >
            <p role="status">{language.t("imageEdit.tooLarge")}</p>
          </Show>
          <Show when={target()} keyed>
            {(chosen) => (
              <Show when={state.ready && current()?.mime === "image/png"}>
                <div data-slot="image-edit-compose">
                  <label>
                    {language.t("imageEdit.prompt")}
                    <textarea
                      dir="auto"
                      rows={2}
                      maxLength={32000}
                      value={state.prompt}
                      readOnly={state.review}
                      disabled={state.busy}
                      onInput={(event) => {
                        work.retry = undefined
                        set("prompt", event.currentTarget.value)
                      }}
                    />
                  </label>
                  <Show when={!state.review}>
                    <button
                      type="button"
                      data-primary=""
                      disabled={state.drawing || !state.marked || !state.prompt.trim()}
                      onClick={(event) => {
                        const root = event.currentTarget.closest('[data-component="masked-image-editor"]')
                        set("failure", undefined)
                        set("review", true)
                        root?.querySelectorAll<HTMLDetailsElement>("details[open]").forEach((element) => {
                          element.open = false
                        })
                        root?.querySelector<HTMLButtonElement>('[data-slot="image-edit-actions"] > button')?.focus()
                      }}
                    >
                      {language.t("imageEdit.review")}
                    </button>
                  </Show>
                </div>
                <Show when={state.review}>
                  <div data-slot="image-edit-consent">
                    <p dir="auto">{language.t("imageEdit.consent")}</p>
                    <p dir="ltr" class="break-all">
                      <bdi dir="ltr">{chosen.model}</bdi> · <bdi dir="ltr">{chosen.endpoint}</bdi>
                    </p>
                  </div>
                  <div data-slot="image-edit-actions">
                    <button type="button" data-primary="" disabled={state.busy} onClick={() => void submit()}>
                      {language.t(
                        state.busy
                          ? "imageEdit.working"
                          : work.retry && state.failure
                            ? "imageEdit.check"
                            : "imageEdit.confirm",
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (state.busy) {
                          work.request?.abort()
                          return
                        }
                        if (work.retry) {
                          void statusActions.refetch()
                          work.retry = undefined
                        }
                        set("review", false)
                        set("failure", undefined)
                      }}
                    >
                      {language.t(state.busy ? "imageEdit.cancel" : "imageEdit.back")}
                    </button>
                  </div>
                </Show>
                <Show when={state.failure} keyed>
                  {(failure) => <p role="alert">{language.t(`imageEdit.error.${failure}`)}</p>}
                </Show>
              </Show>
            )}
          </Show>
        </div>
      </div>
    </Dialog>
  )
}

function ImageEditIcon(props: {
  name: Tool | "hand" | "undo" | "clear" | "size" | "minus" | "plus" | "fit" | "download" | "move"
}) {
  const paths = {
    brush: "m4 16 9-9 4 4-9 9H4v-4ZM12 8l4 4M14 6l2-2 4 4-2 2",
    eraser: "m4 14 9-10 7 7-9 9H9l-5-5ZM9 9l7 7M10 20h10",
    rectangle: "M4 5h16v14H4Z",
    ellipse: "M21 12a9 7 0 1 1-18 0 9 7 0 1 1 18 0",
    line: "M4 20 20 4",
    arrow: "M4 20 20 4M9 4h11v11",
    hand: "M8 12V5a2 2 0 0 1 4 0v7-8a2 2 0 0 1 4 0v8-6a2 2 0 0 1 4 0v9c0 4-2 6-6 6h-2c-3 0-4-2-6-5l-3-4c-1-2 1-3 2-2l3 3",
    undo: "M8 5 3 10l5 5M3 10h11a6 6 0 0 1 0 12",
    clear: "M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7",
    size: "M3 6h18M3 18h18M8 3v6M16 15v6",
    minus: "M5 12h14",
    plus: "M5 12h14M12 5v14",
    fit: "M9 3H3v6M15 3h6v6M3 15v6h6M21 15v6h-6",
    download: "M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5",
    move: "m9 6 3-3 3 3M12 3v18m-3-3 3 3 3-3M3 12h18m-3-3 3 3-3 3M6 9l-3 3 3 3",
  }
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d={paths[props.name]} />
    </svg>
  )
}
