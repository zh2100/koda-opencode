import { afterAll, beforeAll, expect, test } from "bun:test"
import { onCleanup } from "solid-js"
import { createComponent, render } from "solid-js/web"
import { Dialog, useDialogContext } from "@kobalte/core/dialog"
import { createRequire } from "node:module"
import { rmSync } from "node:fs"
import { join } from "node:path"

const compiled = join(import.meta.dir, `.dialog-provider-${crypto.randomUUID()}.compiled.ts`)
let DialogProvider: typeof import("@opencode-ai/ui/context/dialog").DialogProvider
let useDialog: typeof import("@opencode-ai/ui/context/dialog").useDialog
let bindDialog: typeof import("@opencode-ai/ui/context/dialog").bindDialog

beforeAll(async () => {
  const compiler = createRequire(import.meta.resolve("vite-plugin-solid"))
  const babel = compiler("@babel/core")
  const solid = compiler("babel-preset-solid")
  const source = await Bun.file(join(import.meta.dir, "../../ui/src/context/dialog.tsx")).text()
  const output = babel.transformSync(source, {
    filename: "dialog.tsx",
    babelrc: false,
    configFile: false,
    parserOpts: { plugins: ["typescript", "jsx"] },
    presets: [[solid, { generate: "dom", hydratable: false }]],
  }).code
  await Bun.write(compiled, output)
  const module = await import(compiled)
  DialogProvider = module.DialogProvider
  useDialog = module.useDialog
  bindDialog = module.bindDialog
})

afterAll(() => rmSync(compiled, { force: true }))

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const animation = () => new Promise((resolve) => setTimeout(resolve, 150))
async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 2000
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Dialog lifecycle did not settle")
    await tick()
  }
}

function setup() {
  const host = document.createElement("div")
  const outside = document.createElement("button")
  outside.textContent = "outside"
  host.append(outside)
  document.body.append(host)
  let api!: ReturnType<typeof useDialog>
  const roots: Array<() => void> = []
  const Root = () => {
    api = useDialog()
    return document.createTextNode("")
  }
  const dispose = render(
    () =>
      createComponent(DialogProvider, {
        get children() {
          return createComponent(Root, {})
        },
      }),
    host,
  )

  return {
    outside,
    open(id?: string, push = false, onClose?: () => void) {
      const state = { mounted: 0, disposed: 0, closed: 0, modal: () => false }
      const input = document.createElement("input")
      const Content = () => {
        state.modal = useDialogContext().modal
        state.mounted += 1
        onCleanup(() => {
          state.disposed += 1
        })
        return createComponent(Dialog.Content, {
          get children() {
            return [input, createComponent(Dialog.CloseButton, { children: "native-close" })]
          },
        })
      }
      const element = () => createComponent(Content, {})
      const opened = id === undefined ? element : bindDialog(element, id)
      api[push ? "push" : "show"](opened, () => {
        state.closed += 1
        onClose?.()
      })
      const active = api.active!
      roots.push(active.dispose)
      return { state, input, id: active.id }
    },
    close: (id?: string) => api.close(id),
    active: () => api.active,
    layers: () => document.querySelectorAll("[data-dialog-layer]").length,
    unmount: () => {
      dispose()
      host.remove()
    },
    cleanup: () => {
      dispose()
      roots.forEach((root) => root())
      host.remove()
    },
  }
}

for (const bound of [false, true]) {
  test(`MR-01 ${bound ? "bound" : "unbound"} top dialog retains real Kobalte modality`, async () => {
    const view = setup()
    try {
      const opened = view.open(bound ? "bound-modal" : undefined)
      await waitFor(() => opened.state.mounted === 1)
      expect(opened.state.modal()).toBe(true)
      view.outside.focus()
      await tick()
      expect(document.activeElement).not.toBe(view.outside)
    } finally {
      view.cleanup()
    }
  })
}

test("MR-01 bound dialog honors the native Kobalte close button", async () => {
  const view = setup()
  try {
    const opened = view.open("bound-close")
    await waitFor(() => opened.state.mounted === 1)
    document.querySelector<HTMLButtonElement>("[data-dialog-layer] button")!.click()
    await waitFor(() => view.layers() === 0)
    expect(opened.state.closed).toBe(1)
    expect(opened.state.disposed).toBe(1)
  } finally {
    view.cleanup()
  }
})

test("MR-01 stacked bound dialogs restore lower modality when the top closes", async () => {
  const view = setup()
  try {
    const lower = view.open("lower-modal")
    const upper = view.open("upper-modal", true)
    await waitFor(() => upper.state.mounted === 1)
    expect(lower.state.modal()).toBe(false)
    expect(upper.state.modal()).toBe(true)
    view.close(upper.id)
    await waitFor(() => upper.state.disposed === 1)
    expect(view.layers()).toBe(1)
    expect(lower.state.modal()).toBe(true)
  } finally {
    view.cleanup()
  }
})

for (const order of ["lower-first", "upper-first"] as const) {
  test(`MR-02 different instances finish closing independently: ${order}`, async () => {
    const view = setup()
    try {
      const lower = view.open("lower-close")
      const upper = view.open("upper-close", true)
      await waitFor(() => upper.state.mounted === 1)
      const closing = order === "lower-first" ? [lower, upper] : [upper, lower]
      closing.forEach((item) => view.close(item.id))
      await waitFor(() => view.layers() === 0)
      for (const item of closing) {
        expect(item.state.closed).toBe(1)
        expect(item.state.disposed).toBe(1)
      }
    } finally {
      view.cleanup()
    }
  })
}

test("MR-02 duplicate and reentrant close notify and dispose once", async () => {
  const view = setup()
  try {
    const opened = view.open("duplicate-close", false, () => view.close("duplicate-close"))
    await waitFor(() => opened.state.mounted === 1)
    view.close(opened.id)
    view.close(opened.id)
    await waitFor(() => view.layers() === 0)
    expect(opened.state.closed).toBe(1)
    expect(opened.state.disposed).toBe(1)
  } finally {
    view.cleanup()
  }
})

test("MR-02 push does not cancel an older instance's pending close", async () => {
  const view = setup()
  try {
    const lower = view.open("push-lower")
    await waitFor(() => lower.state.mounted === 1)
    view.close(lower.id)
    const upper = view.open("push-upper", true)
    await waitFor(() => lower.state.disposed === 1)
    expect(view.layers()).toBe(1)
    expect(view.active()?.id).toBe(upper.id)
    expect(upper.state.disposed).toBe(0)
    expect(upper.state.modal()).toBe(true)
  } finally {
    view.cleanup()
  }
})

test("MR-02 show disposes a closing instance once without closing a same-id replacement", async () => {
  const view = setup()
  try {
    const older = view.open("reused-id")
    await waitFor(() => older.state.mounted === 1)
    view.close(older.id)
    const replacement = view.open("reused-id")
    await animation()
    expect(older.state.disposed).toBe(1)
    expect(view.layers()).toBe(1)
    expect(replacement.state.disposed).toBe(0)
    expect(replacement.state.closed).toBe(0)
  } finally {
    view.cleanup()
  }
})

test("MR-02 reentrant show during onClose cannot be removed by the old timer", async () => {
  const view = setup()
  try {
    const older = view.open("reentrant-id", false, () => view.open("reentrant-id"))
    await waitFor(() => older.state.mounted === 1)
    view.close(older.id)
    await animation()
    expect(older.state.closed).toBe(1)
    expect(older.state.disposed).toBe(1)
    expect(view.layers()).toBe(1)
  } finally {
    view.cleanup()
  }
})

test("MR-02 provider cleanup disposes open and closing roots once and clears pending closes", async () => {
  const view = setup()
  try {
    const lower = view.open("cleanup-lower")
    const upper = view.open("cleanup-upper", true)
    await waitFor(() => upper.state.mounted === 1)
    view.close(lower.id)
    view.unmount()
    expect(lower.state.disposed).toBe(1)
    expect(upper.state.disposed).toBe(1)
    expect(view.layers()).toBe(0)
    await animation()
    expect(lower.state.disposed).toBe(1)
    expect(upper.state.disposed).toBe(1)
  } finally {
    view.cleanup()
  }
})

test("C01 internal count includes the closing instance until admission settles", async () => {
  const view = setup()
  try {
    const stack = () => document.querySelector('[data-component="dialog-stack"]')
    expect(stack()?.getAttribute("data-dialog-count")).toBe("0")
    const opened = view.open("counted-close")
    await waitFor(() => opened.state.mounted === 1)
    expect(stack()?.getAttribute("data-dialog-count")).toBe("1")
    view.close(opened.id)
    expect(view.active()?.closing).toBe(true)
    expect(stack()?.getAttribute("data-dialog-count")).toBe("1")
    await waitFor(() => opened.state.disposed === 1)
    expect(stack()?.getAttribute("data-dialog-count")).toBe("0")
    expect(view.active()).toBeUndefined()
  } finally {
    view.cleanup()
  }
})

test("C02 stacked count follows independent close and replacement", async () => {
  const view = setup()
  try {
    const lower = view.open("counted-lower")
    const upper = view.open("counted-upper", true)
    await waitFor(() => upper.state.mounted === 1)
    const stack = () => document.querySelector('[data-component="dialog-stack"]')
    expect(stack()?.getAttribute("data-dialog-count")).toBe("2")
    view.close(lower.id)
    expect(stack()?.getAttribute("data-dialog-count")).toBe("2")
    await waitFor(() => lower.state.disposed === 1)
    expect(stack()?.getAttribute("data-dialog-count")).toBe("1")
    const replacement = view.open("counted-replacement")
    expect(upper.state.disposed).toBe(1)
    expect(stack()?.getAttribute("data-dialog-count")).toBe("1")
    view.close(replacement.id)
    await waitFor(() => replacement.state.disposed === 1)
    expect(stack()?.getAttribute("data-dialog-count")).toBe("0")
  } finally {
    view.cleanup()
  }
})
