import { Dialog } from "@kobalte/core/dialog"
import { afterAll, beforeAll, expect, mock, test } from "bun:test"
import { createSignal, type JSX } from "solid-js"
import { render } from "solid-js/web"
import { QueryClient } from "@tanstack/solid-query"
import { createRequire } from "node:module"
import { rmSync } from "node:fs"
import { join } from "node:path"

const pass = (props: { children?: JSX.Element }) => props.children
mock.module("@opencode-ai/ui/v2/dialog-v2", () => ({
  Dialog: (props: { children?: JSX.Element }) =>
    createComponent(Dialog.Content, {
      get children() {
        return props.children
      },
    }),
  DialogBody: pass,
  DialogFooter: pass,
  DialogHeader: pass,
  DialogTitle: pass,
}))
mock.module("@opencode-ai/ui/v2/divider-v2", () => ({ DividerV2: () => document.createTextNode("") }))
mock.module("@opencode-ai/ui/v2/select-v2", () => ({ SelectV2: () => document.createTextNode("") }))
mock.module("@opencode-ai/ui/v2/button-v2", () => ({
  ButtonV2: (props: { children?: JSX.Element; disabled?: boolean; onClick?: () => void }) => {
    const button = document.createElement("button")
    createEffect(() => {
      button.textContent = String(props.children ?? "")
      button.disabled = !!props.disabled
    })
    button.addEventListener("click", () => props.onClick?.())
    return button
  },
}))
mock.module("@opencode-ai/ui/v2/text-input-v2", () => ({
  TextInputV2: (props: { value?: string; disabled?: boolean; onInput?: (event: Event) => void }) => {
    const input = document.createElement("input")
    createEffect(() => {
      input.value = props.value ?? ""
      input.disabled = !!props.disabled
    })
    input.oninput = (event) => props.onInput?.(event)
    return input
  },
}))
mock.module("@/context/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
mock.module("@/utils/toast", () => ({ showToast: () => {} }))

const [scope, setScope] = createSignal("A")
const [directory, setDirectory] = createSignal("/project")
let update: (scope: string, directory: string) => Promise<unknown> = async () => ({})
let read: (label: string) => Promise<McpSource> = async (label) => source(label)
const updates: string[] = []
let updateStarted = 0
const refreshes: string[] = []

type McpSource = { source: string; version: string; writable: boolean; config: { type: string; url: string } }

mock.module("@/context/sdk", () => ({
  useSDK: () => () => ({
    get directory() {
      return directory()
    },
    client: {
      config: {
        updateMcp: () => update(scope(), directory()),
        mcpSource: async () => ({ data: await read(scope()) }),
      },
    },
  }),
}))
mock.module("@/context/server-sdk", () => ({
  useServerSDK: () => () => ({
    get scope() {
      return scope()
    },
  }),
}))
mock.module("@/context/server-sync", () => ({
  useServerSync: () => () => ({ updateConfig: () => update(scope(), directory()) }),
}))

const compiler = createRequire(import.meta.resolve("vite-plugin-solid"))
const babel = compiler("@babel/core")
const solid = compiler("babel-preset-solid")
const sourceDir = join(import.meta.dir, "../src/components/settings-v2")
const compiled = join(sourceDir, "dialog-mcp-v2.compiled.ts")
const compiledDialog = join(sourceDir, "dialog-context.compiled.ts")

let DialogMcpV2: (props: { mode: "add" | "edit"; name?: string }) => JSX.Element
let QueryClientProvider: (props: { client: QueryClient; children?: JSX.Element }) => JSX.Element
let DialogProvider: (props: { children?: JSX.Element }) => JSX.Element
let Openers: (props: { initial?: "edit" | "add" }) => JSX.Element
let createComponent: typeof import("solid-js/web").createComponent
let createEffect: typeof import("solid-js").createEffect

const retarget = (source: string) =>
  source
    .replaceAll('from "solid-js/web"', 'from "solid-js/web/dist/web.js"')
    .replaceAll('from "solid-js/store"', 'from "solid-js/store/dist/store.js"')
    .replaceAll('from "solid-js"', 'from "solid-js/dist/solid.js"')

const compile = (filename: string, source: string) => {
  const output = babel.transformSync(source, {
    filename,
    babelrc: false,
    configFile: false,
    parserOpts: { plugins: ["typescript", "jsx"] },
    presets: [[solid, { generate: "dom", hydratable: false }]],
  }).code
  return retarget(output)
}

beforeAll(async () => {
  rmSync(compiled, { force: true })
  rmSync(compiledDialog, { force: true })
  const dialogSource = await Bun.file(join(import.meta.dir, "../../ui/src/context/dialog.tsx")).text()
  const componentSource = await Bun.file(
    join(import.meta.dir, "../src/components/settings-v2/dialog-mcp-v2.tsx"),
  ).text()
  await Bun.write(compiledDialog, compile("dialog.tsx", dialogSource))
  const component = `${compile("dialog-mcp-v2.tsx", componentSource).replace(
    'from "@opencode-ai/ui/context/dialog"',
    `from ${JSON.stringify(compiledDialog)}`,
  )}
import { createEffect as mcpCreateEffect } from "solid-js/dist/solid.js"
import { createComponent as mcpCreateComponent } from "solid-js/web/dist/web.js"
import { bindDialog as mcpBindDialog, useDialog as mcpUseDialog, DialogProvider as mcpDialogProvider } from ${JSON.stringify(compiledDialog)}
export { mcpDialogProvider as DialogProvider }
function opener(kind) {
  return (props) => {
    const button = document.createElement("button")
    button.dataset.open = kind
    button.type = "button"
    button.style.position = "relative"
    button.style.zIndex = "1000"
    button.textContent = kind
    button.addEventListener("click", () => props.onOpen())
    return button
  }
}
const ShowOpener = opener("show")
const PushOpener = opener("push")
export function McpOpeners(props) {
  const dialog = mcpUseDialog()
  queueMicrotask(() => {
    if (!props.initial) return
    const initialID = Math.random().toString(36).slice(2)
    dialog.show(mcpBindDialog(() => mcpCreateComponent(DialogMcpV2, props.initial === "add" ? { mode: "add", dialogID: initialID } : { mode: "edit", name: "sample", dialogID: initialID }), initialID))
  })
  return [
    mcpCreateComponent(ShowOpener, { onOpen: () => { const id = Math.random().toString(36).slice(2); dialog.show(mcpBindDialog(() => mcpCreateComponent(DialogMcpV2, { mode: "edit", name: "sample", dialogID: id }), id)) } }),
    mcpCreateComponent(PushOpener, { onOpen: () => { const id = Math.random().toString(36).slice(2); dialog.push(mcpBindDialog(() => mcpCreateComponent(DialogMcpV2, { mode: "add", dialogID: id }), id)) } }),
  ]
}
`
  await Bun.write(compiled, component)
  const module = await import(compiled)
  DialogMcpV2 = module.DialogMcpV2
  Openers = module.McpOpeners
  QueryClientProvider = (await import("@tanstack/solid-query")).QueryClientProvider
  DialogProvider = module.DialogProvider
  createComponent = (await import("solid-js/web/dist/web.js")).createComponent
  createEffect = (await import("solid-js/dist/solid.js")).createEffect
})

afterAll(() => {
  if (process.env.KEEP_MCP_COMPILED === "1") return
  rmSync(compiled, { force: true })
  rmSync(compiledDialog, { force: true })
})

const source = (label: string): McpSource => ({
  source: `/${label}.json`,
  version: label,
  writable: true,
  config: { type: "remote", url: `https://${label}.test` },
})

const waitFor = async (check: () => boolean) => {
  const end = Date.now() + 2000
  while (!check()) {
    if (Date.now() > end) throw new Error("test readiness timed out")
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const settled = () => new Promise((resolve) => setTimeout(resolve, 150))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const dialogRoot = () => document.body

function button(host: ParentNode, label: string) {
  const result = [...dialogRoot().querySelectorAll("button")].find((item) => item.textContent === label)
  expect(result).toBeDefined()
  return result!
}

function urlInput(host: ParentNode) {
  return [...dialogRoot().querySelectorAll("input")].find((item) => item.value.startsWith("https://"))
}

function resetNetwork() {
  setScope("A")
  setDirectory("/project")
  updateStarted = 0
  updates.length = 0
  refreshes.length = 0
  update = async (label) => {
    updates.push(label)
    return {}
  }
  read = async (label) => source(label)
}

function mount(options?: { name?: string }) {
  resetNetwork()
  const host = document.createElement("div")
  document.body.append(host)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  const original = client.invalidateQueries.bind(client)
  client.invalidateQueries = (async (filters, invalidateOptions) => {
    refreshes.push(JSON.stringify(filters ?? {}))
    return original(filters, invalidateOptions)
  }) as typeof client.invalidateQueries
  const dispose = render(
    () =>
      createComponent(QueryClientProvider, {
        client,
        get children() {
          return createComponent(DialogProvider, {
            get children() {
              return createComponent(Openers, { initial: options?.name ? "edit" : "edit" })
            },
          })
        },
      }),
    host,
  )
  return {
    host,
    client,
    dispose: () => {
      dispose()
      client.clear()
      host.remove()
      document.body
        .querySelectorAll("[data-dialog-layer],[data-component='dialog-overlay']")
        .forEach((node) => node.remove())
    },
  }
}

function mountStack() {
  resetNetwork()
  const host = document.createElement("div")
  document.body.append(host)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  const dispose = render(
    () =>
      createComponent(QueryClientProvider, {
        client,
        get children() {
          return createComponent(DialogProvider, {
            get children() {
              return createComponent(Openers, { initial: "edit" })
            },
          })
        },
      }),
    host,
  )
  return {
    host,
    dispose: () => {
      dispose()
      client.clear()
      host.remove()
      document.body
        .querySelectorAll("[data-dialog-layer],[data-component='dialog-overlay']")
        .forEach((node) => node.remove())
    },
  }
}

function layers(host: ParentNode) {
  return [...dialogRoot().querySelectorAll("[data-dialog-layer]")]
}

function clickOverlay() {
  const overlay = dialogRoot().querySelector("[data-component='dialog-overlay']")
  expect(overlay).toBeDefined()
  overlay!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
}

function dialogText() {
  return [...dialogRoot().querySelectorAll("[data-dialog-layer]")].map((node) => node.textContent ?? "").join("")
}

test("OR-01 old successful save must not disable another server dialog", async () => {
  const pending = deferred<unknown>()
  const view = mount()
  update = (label) => {
    updateStarted += 1
    updates.push(label)
    return pending.promise
  }
  try {
    await waitFor(() => urlInput(view.host)?.value === "https://A.test")
    expect(button(view.host, "common.save").disabled).toBe(false)
    button(view.host, "common.save").click()
    await waitFor(() => updateStarted === 1)
    setScope("B")
    await waitFor(() => urlInput(view.host)?.value === "https://B.test")
    expect(button(view.host, "common.save").disabled).toBe(false)
    pending.resolve({})
    await settled()
    expect(layers(view.host)).toHaveLength(1)
    expect(button(view.host, "common.save").disabled).toBe(false)
    expect(updates).toEqual(["A"])
    expect(refreshes.some((item) => item.includes("A"))).toBe(true)
  } finally {
    view.dispose()
  }
})

test("OR-01 returning to the first server does not inherit the stale saved flag", async () => {
  const pending = deferred<unknown>()
  const view = mount()
  update = (label) => {
    updateStarted += 1
    updates.push(label)
    return pending.promise
  }
  try {
    await waitFor(() => urlInput(view.host)?.value === "https://A.test")
    button(view.host, "common.save").click()
    await waitFor(() => updateStarted === 1)
    setScope("B")
    await waitFor(() => urlInput(view.host)?.value === "https://B.test")
    setScope("A")
    await waitFor(() => urlInput(view.host)?.value === "https://A.test")
    pending.resolve({})
    await settled()
    expect(button(view.host, "common.save").disabled).toBe(false)
    expect(dialogText()).not.toContain("settings.mcp.error.load")
  } finally {
    view.dispose()
  }
})

test("OR-01 an older save completing after the current save does not own the dialog", async () => {
  const older = deferred<unknown>()
  const current = deferred<unknown>()
  let calls = 0
  const view = mount()
  update = (label) => {
    updateStarted += 1
    updates.push(label)
    calls += 1
    return calls === 1 ? older.promise : current.promise
  }
  try {
    await waitFor(() => urlInput(view.host)?.value === "https://A.test")
    button(view.host, "common.save").click()
    await waitFor(() => updateStarted === 1)
    setScope("B")
    await waitFor(() => urlInput(view.host)?.value === "https://B.test")
    button(view.host, "common.save").click()
    await waitFor(() => updateStarted === 2)
    older.resolve({})
    await settled()
    expect(layers(view.host)).toHaveLength(1)
    expect(button(view.host, "common.saving").disabled).toBe(true)
    current.resolve({})
    await waitFor(() => layers(view.host).length === 0)
    await settled()
    expect(updates).toEqual(["A", "B"])
  } finally {
    view.dispose()
  }
})

test("OR-02 old reload must not leave a load error on the new server while it loads", async () => {
  const pending = deferred<McpSource>()
  const loadingB = deferred<McpSource>()
  let reads = 0
  const view = mount()
  update = async () => {
    throw { code: "MCP_VERSION_CONFLICT" }
  }
  read = async (label) => {
    if (label === "B") return loadingB.promise
    if (label === "A" && ++reads > 1) return pending.promise
    return source(label)
  }
  try {
    await waitFor(() => urlInput(view.host)?.value === "https://A.test")
    button(view.host, "common.save").click()
    await waitFor(() => dialogText()?.includes("settings.mcp.reload"))
    button(view.host, "settings.mcp.reload").click()
    await tick()
    setScope("B")
    await tick()
    pending.resolve(source("A-new"))
    await settled()
    loadingB.resolve(source("B"))
    await waitFor(() => urlInput(view.host)?.value === "https://B.test")
    expect(dialogText()).not.toContain("settings.mcp.error.load")
    expect(button(view.host, "common.save").disabled).toBe(false)
  } finally {
    view.dispose()
  }
})

test("OR-02 old reload must not overwrite a server that has already loaded", async () => {
  const pending = deferred<McpSource>()
  let reads = 0
  const view = mount()
  update = async () => {
    throw { code: "MCP_VERSION_CONFLICT" }
  }
  read = async (label) => {
    if (label === "A" && ++reads > 1) return pending.promise
    return source(label)
  }
  try {
    await waitFor(() => urlInput(view.host)?.value === "https://A.test")
    button(view.host, "common.save").click()
    await waitFor(() => dialogText()?.includes("settings.mcp.reload"))
    button(view.host, "settings.mcp.reload").click()
    await tick()
    setScope("B")
    await waitFor(() => urlInput(view.host)?.value === "https://B.test")
    pending.resolve(source("A-new"))
    await settled()
    expect(urlInput(view.host)?.value).toBe("https://B.test")
    expect(dialogText()).not.toContain("settings.mcp.error.load")
    expect(button(view.host, "common.save").disabled).toBe(false)
  } finally {
    view.dispose()
  }
})

test("OR-02 an older reload must not replace the current reload result", async () => {
  const older = deferred<McpSource>()
  const newer = deferred<McpSource>()
  let reads = 0
  const view = mount()
  update = async () => {
    throw { code: "MCP_VERSION_CONFLICT" }
  }
  read = async (label) => {
    if (reads === 1) return older.promise
    if (reads > 1) return newer.promise
    return source(label)
  }
  try {
    await waitFor(() => urlInput(view.host)?.value === "https://A.test")
    button(view.host, "common.save").click()
    await waitFor(() => dialogText()?.includes("settings.mcp.reload"))
    reads = 1
    button(view.host, "settings.mcp.reload").click()
    await tick()
    reads = 2
    button(view.host, "settings.mcp.reload").click()
    await tick()
    older.reject(new Error("old reload failed"))
    await settled()
    expect(dialogText()).not.toContain("settings.mcp.error.load")
    newer.resolve(source("A-new"))
    await waitFor(() => urlInput(view.host)?.value === "https://A-new.test")
    expect(dialogText()).not.toContain("settings.mcp.error.load")
  } finally {
    view.dispose()
  }
})

test("OR-02 a disposed reload must not write into a replacement dialog", async () => {
  const pending = deferred<McpSource>()
  let reads = 0
  const first = mount()
  update = async () => {
    throw { code: "MCP_VERSION_CONFLICT" }
  }
  read = async (label) => {
    if (++reads > 1) return pending.promise
    return source(label)
  }
  await waitFor(() => urlInput(first.host)?.value === "https://A.test")
  button(first.host, "common.save").click()
  await waitFor(() => dialogText()?.includes("settings.mcp.reload"))
  button(first.host, "settings.mcp.reload").click()
  await tick()
  first.dispose()
  read = async (label) => source(label)
  const replacement = mount()
  try {
    await waitFor(() => urlInput(replacement.host)?.value === "https://A.test")
    pending.reject(new Error("disposed reload failed"))
    await settled()
    expect(dialogText()).not.toContain("settings.mcp.error.load")
    expect(button(replacement.host, "common.save").disabled).toBe(false)
  } finally {
    replacement.dispose()
  }
})

test("OR-03 a disposed save must not close the replacement dialog", async () => {
  const pending = deferred<unknown>()
  const first = mount()
  update = (label) => {
    updates.push(label)
    return pending.promise
  }
  await waitFor(() => urlInput(first.host)?.value === "https://A.test")
  button(first.host, "common.save").click()
  await tick()
  first.dispose()
  const replacement = mount()
  try {
    await waitFor(() => urlInput(replacement.host)?.value === "https://A.test")
    const draft = [...dialogRoot().querySelectorAll("input")].find((item) => item.value === "sample")
    expect(draft).toBeDefined()
    draft!.value = "replacement-draft"
    draft!.dispatchEvent(new Event("input", { bubbles: true }))
    pending.resolve({})
    await settled()
    expect(layers(replacement.host)).toHaveLength(1)
    expect(draft!.value).toBe("replacement-draft")
    expect(refreshes.some((item) => item.includes("A"))).toBe(true)
  } finally {
    replacement.dispose()
  }
})

test("OR-03 Escape during save closes only that dialog", async () => {
  const pending = deferred<unknown>()
  const view = mountStack()
  update = () => pending.promise
  try {
    await waitFor(() => urlInput(view.host)?.value === "https://A.test")
    button(view.host, "common.save").click()
    await tick()
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
    await waitFor(() => layers(view.host).length === 0)
    pending.resolve({})
    await settled()
    expect(layers(view.host)).toHaveLength(0)
  } finally {
    view.dispose()
  }
})

test("OR-03 overlay close during save does not close a later dialog", async () => {
  const pending = deferred<unknown>()
  const view = mountStack()
  update = () => pending.promise
  try {
    await waitFor(() => urlInput(view.host)?.value === "https://A.test")
    button(view.host, "common.save").click()
    await tick()
    clickOverlay()
    await waitFor(() => layers(view.host).length === 0)
    await settled()
    dialogRoot().querySelector<HTMLButtonElement>("[data-open='show']")?.click()
    await waitFor(() => urlInput(view.host)?.value === "https://A.test")
    pending.resolve({})
    await settled()
    expect(layers(view.host)).toHaveLength(1)
    expect(urlInput(view.host)?.value).toBe("https://A.test")
  } finally {
    view.dispose()
  }
})

test("OR-03 dialog.show replacement stays open when the old save finishes", async () => {
  const pending = deferred<unknown>()
  const view = mountStack()
  update = () => pending.promise
  try {
    await waitFor(() => urlInput(view.host)?.value === "https://A.test")
    button(view.host, "common.save").click()
    await tick()
    dialogRoot().querySelector<HTMLButtonElement>("[data-open='show']")?.click()
    await waitFor(() => layers(view.host).length === 1 && urlInput(view.host)?.value === "https://A.test")
    pending.resolve({})
    await settled()
    expect(layers(view.host)).toHaveLength(1)
  } finally {
    view.dispose()
  }
})

test("OR-03 reopening the same server name is a new dialog", async () => {
  const pending = deferred<unknown>()
  const view = mountStack()
  update = () => pending.promise
  try {
    await waitFor(() => urlInput(view.host)?.value === "https://A.test")
    button(view.host, "common.save").click()
    await tick()
    clickOverlay()
    await waitFor(() => layers(view.host).length === 0)
    await settled()
    dialogRoot().querySelector<HTMLButtonElement>("[data-open='show']")?.click()
    await waitFor(() => layers(view.host).length === 1)
    pending.resolve({})
    await settled()
    expect(layers(view.host)).toHaveLength(1)
    expect(button(view.host, "common.save").disabled).toBe(false)
  } finally {
    view.dispose()
  }
})

test("OR-03 a finished lower dialog must not close a stacked dialog", async () => {
  const pending = deferred<unknown>()
  const view = mountStack()
  update = () => {
    updateStarted += 1
    return pending.promise
  }
  try {
    await waitFor(() => urlInput(view.host)?.value === "https://A.test")
    button(view.host, "common.save").click()
    await waitFor(() => updateStarted === 1)
    dialogRoot().querySelector<HTMLButtonElement>("[data-open='push']")?.click()
    await waitFor(() => layers(view.host).length === 2)
    pending.resolve({})
    await settled()
    expect(layers(view.host)).toHaveLength(1)
    expect(dialogText()).toContain("settings.mcp.add")
    expect(dialogText()).not.toContain("settings.mcp.edit")
  } finally {
    view.dispose()
  }
})

test("control: current successful save closes its own dialog and refreshes its scope", async () => {
  const view = mount()
  try {
    await waitFor(() => urlInput(view.host)?.value === "https://A.test")
    button(view.host, "common.save").click()
    await waitFor(() => layers(view.host).length === 0)
    await settled()
    expect(updates).toEqual(["A"])
    expect(refreshes.filter((item) => item.includes('"A"'))).toHaveLength(2)
  } finally {
    view.dispose()
  }
})

test("control: current successful reload reconciles the current document", async () => {
  let count = 0
  const view = mount()
  update = async () => {
    throw { code: "MCP_VERSION_CONFLICT" }
  }
  read = async (label) => source(++count > 1 ? `${label}-new` : label)
  try {
    await waitFor(() => urlInput(view.host)?.value === "https://A.test")
    button(view.host, "common.save").click()
    await waitFor(() => dialogText()?.includes("settings.mcp.reload"))
    button(view.host, "settings.mcp.reload").click()
    await waitFor(() => urlInput(view.host)?.value === "https://A-new.test")
    expect(dialogText()).not.toContain("settings.mcp.error.load")
    expect(button(view.host, "common.save").disabled).toBe(false)
  } finally {
    view.dispose()
  }
})

test("control: current reload failure keeps its own load error", async () => {
  let reads = 0
  const view = mount()
  update = async () => {
    throw { code: "MCP_VERSION_CONFLICT" }
  }
  read = async (label) => {
    if (++reads > 1) throw new Error("reload failed")
    return source(label)
  }
  try {
    await waitFor(() => urlInput(view.host)?.value === "https://A.test")
    button(view.host, "common.save").click()
    await waitFor(() => dialogText()?.includes("settings.mcp.reload"))
    button(view.host, "settings.mcp.reload").click()
    await waitFor(() => dialogText()?.includes("settings.mcp.error.load") ?? false)
    expect(button(view.host, "common.save").disabled).toBe(true)
  } finally {
    view.dispose()
  }
})

test("MR-02 concurrent owned saves both close their own dialogs", async () => {
  const lower = deferred<unknown>()
  const upper = deferred<unknown>()
  const view = mountStack()
  update = () => {
    updateStarted += 1
    return updateStarted === 1 ? lower.promise : upper.promise
  }
  try {
    await waitFor(() => urlInput(view.host)?.value === "https://A.test")
    button(view.host, "common.save").click()
    await waitFor(() => updateStarted === 1)
    dialogRoot().querySelector<HTMLButtonElement>("[data-open='push']")!.click()
    await waitFor(() => layers(view.host).length === 2)
    const added = layers(view.host).at(-1)!
    const inputs = [...added.querySelectorAll("input")]
    inputs[0]!.value = "added"
    inputs[0]!.dispatchEvent(new Event("input", { bubbles: true }))
    inputs[1]!.value = "echo"
    inputs[1]!.dispatchEvent(new Event("input", { bubbles: true }))
    const save = [...added.querySelectorAll("button")].find((b) => b.textContent === "common.save")!
    save.click()
    await waitFor(() => updateStarted === 2)
    lower.resolve({})
    upper.resolve({})
    await new Promise((r) => setTimeout(r, 300))
    expect(layers(view.host)).toHaveLength(0)
  } finally {
    view.dispose()
  }
})
