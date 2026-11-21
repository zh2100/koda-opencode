import { afterAll, beforeAll, expect, test } from "bun:test"
import { createContext, createEffect, createMemo, createSignal, onCleanup, useContext, type Accessor, type JSX } from "solid-js"
import { createComponent, render } from "solid-js/web"
import { QueryClient, useQueryClient } from "@tanstack/solid-query"
import { createRequire } from "node:module"
import { rmSync } from "node:fs"
import { join } from "node:path"

type Connection = { key: string; http: { url: string } }
const a = { key: "a", http: { url: "https://a.invalid" } }
const b = { key: "b", http: { url: "https://b.invalid" } }
const [active, setActive] = createSignal<Connection | undefined>(a)
const [selected, setSelected] = createSignal<Connection | undefined>(b)
const [modern, setModern] = createSignal(false)
const clients = new Map([a, b].map((server) => [server.key, new QueryClient()]))
const sdk = createContext<Accessor<Connection>>()
const sync = createContext<Accessor<Connection>>()
const calls: string[] = []
const unmounted: number[] = []
let next = 0
const provider = (context: typeof sdk) => (props: { server?: Accessor<Connection>; children?: JSX.Element }) =>
  createComponent(context.Provider, { value: createMemo(() => props.server?.() ?? active()!), get children() { return props.children } })

export const useServer = () => ({ get current() { return active() } })
export const ServerConnection = { key: (server: Connection) => server.key }
export const useGlobal = () => ({
  settings: { server: { selected } },
  ensureServerCtx: (server: Connection) => ({ queryClient: clients.get(server.key) }),
})
export const useSettings = () => ({ general: { newLayoutDesigns: modern } })
export const ServerSDKProvider = provider(sdk)
export const ServerSyncProvider = provider(sync)
export const ModelsProvider = (props: { children?: JSX.Element }) => props.children
export const ServerHealthIndicator = () => null
export const ServerRow = () => null
export const Button = () => null
export const DropdownMenu = {}
export const Icon = () => null

const compiled = join(import.meta.dir, "../src/components/settings-server-scope.acc.compiled.ts")
let Scope: (props: { children?: JSX.Element }) => JSX.Element
beforeAll(async () => {
  const compiler = createRequire(import.meta.resolve("vite-plugin-solid"))
  const source = await Bun.file(join(import.meta.dir, "../src/components/settings-server-picker.tsx")).text()
  let output = compiler("@babel/core").transformSync(source, {
    filename: "settings-server-picker.tsx", babelrc: false, configFile: false,
    parserOpts: { plugins: ["typescript", "jsx"] },
    presets: [[compiler("babel-preset-solid"), { generate: "dom", hydratable: false }]],
  }).code.replaceAll('from "solid-js/web"', 'from "solid-js/web/dist/web.js"').replaceAll('from "solid-js"', 'from "solid-js/dist/solid.js"')
  // Redirect only this compiled subject. Global mock.module replacements leak
  // across Bun test files and can hide the real settings hooks' SDK exports.
  for (const module of ["@/context/server", "@/context/global", "@/context/settings", "@/context/server-sdk", "@/context/server-sync", "@/context/models", "@/components/server/server-row", "@opencode-ai/ui/button", "@opencode-ai/ui/dropdown-menu", "@opencode-ai/ui/icon"]) {
    output = output.replaceAll(`from "${module}"`, `from ${JSON.stringify(import.meta.path)}`)
  }
  await Bun.write(compiled, output)
  Scope = (await import(compiled)).SettingsServerScope
})
afterAll(() => { rmSync(compiled, { force: true }); clients.forEach((client) => client.clear()) })

function mount() {
  calls.length = 0
  setActive(a)
  setSelected(b)
  const root = document.createElement("div")
  const dispose = render(() => createComponent(Scope, { get children() {
    const fromSdk = useContext(sdk)!
    const fromSync = useContext(sync)!
    const query = useQueryClient()
    const generation = ++next
    const button = document.createElement("button")
    onCleanup(() => unmounted.push(generation))
    createEffect(() => { button.textContent = `${fromSdk().key}:${fromSync().key}` })
    button.onclick = () => { calls.push(`${fromSdk().http.url}:${fromSync().key}:${query === clients.get(fromSdk().key)}`) }
    button.dataset.generation = String(generation)
    return button
  } }), root)
  return { root, dispose, click: () => root.querySelector("button")!.click() }
}

test("classic switch retargets SDK, sync and QueryClient without reopening", () => {
  setModern(false)
  const ui = mount()
  try {
    ui.click()
    setActive(b)
    expect(ui.root.textContent).toBe("b:b")
    ui.click()
    expect(calls).toEqual(["https://a.invalid:a:true", "https://b.invalid:b:true"])
  } finally { ui.dispose() }
})

test("modern selection is independent from the global active server", () => {
  setModern(true)
  const ui = mount()
  try {
    expect(ui.root.textContent).toBe("b:b")
    ui.click()
    setSelected(a)
    expect(ui.root.textContent).toBe("a:a")
    expect(active()).toBe(a)
    expect(calls).toEqual(["https://b.invalid:b:true"])
  } finally { ui.dispose() }
})

test("A to B to A creates a new local generation and preserves shared query state", () => {
  setModern(false)
  clients.get("a")!.setQueryData(["shared"], "preserved")
  const ui = mount()
  try {
    const first = ui.root.querySelector("button")!.dataset.generation
    setActive(b)
    setActive(a)
    expect(ui.root.querySelector("button")!.dataset.generation).not.toBe(first)
    expect(unmounted).toContain(Number(first))
    expect(clients.get("a")!.getQueryData(["shared"])).toBe("preserved")
  } finally { ui.dispose() }
})

test("missing selection removes the old subtree; a same-key new connection remounts it", () => {
  setModern(false)
  const ui = mount()
  try {
    const first = ui.root.querySelector("button")!.dataset.generation
    setActive(undefined)
    expect(ui.root.textContent).toBe("")
    setActive({ ...a, http: { url: "https://replacement.invalid" } })
    expect(ui.root.querySelector("button")!.dataset.generation).not.toBe(first)
    ui.click()
    expect(calls).toEqual(["https://replacement.invalid:a:true"])
  } finally { ui.dispose() }
})
