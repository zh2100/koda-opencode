import { afterAll, beforeAll, expect, test } from "bun:test"
import { createEffect, createSignal, onCleanup, type JSX } from "solid-js"
import { createComponent, render } from "solid-js/web"
import { createRequire } from "node:module"
import { rmSync } from "node:fs"
import { join } from "node:path"

type Connection = { type: "http"; http: { url: string; username?: string; password?: string }; displayName?: string }
const initial: Connection = { type: "http", http: { url: "https://same.invalid", username: "first", password: "fake-first" } }
const [list, setList] = createSignal<Connection[]>([initial])
const released: string[] = []
let serial = 0
export const ServerConnection = { key: (conn: Connection) => conn.http.url }
export const RECENTLY_CLOSED_DISPLAY_LIMIT = 5
export const createServerProjects = () => ({})
export const useServer = () => ({ get list() { return list() }, scope: (key: string) => key, projects: { forServer: () => ({ list: () => [], recentlyClosed: () => [] }) } })
export const useServerHealth = () => ({})
export const createServerSdkContext = (conn: Connection) => {
  const id = ++serial
  onCleanup(() => released.push(String(id)))
  return { id, username: conn.http.username, url: conn.http.url }
}
export const createServerSyncContext = () => ({ data: { project: [] } })

const files = [join(import.meta.dir, "../../ui/src/context/helper.acc.compiled.ts"), join(import.meta.dir, "../src/context/global.acc.compiled.ts")]
let Provider: (props: { children?: JSX.Element }) => JSX.Element
let useGlobal: () => { ensureServerCtx: (conn: Connection) => { sdk: { id: number; username: string }; queryClient: object } }
beforeAll(async () => {
  const compiler = createRequire(import.meta.resolve("vite-plugin-solid"))
  const compile = (source: string, name: string) => compiler("@babel/core").transformSync(source, {
    filename: name, babelrc: false, configFile: false, parserOpts: { plugins: ["typescript", "jsx"] },
    presets: [[compiler("babel-preset-solid"), { generate: "dom", hydratable: false }]],
  }).code.replaceAll('from "solid-js/web"', 'from "solid-js/web/dist/web.js"').replaceAll('from "solid-js/store"', 'from "solid-js/store/dist/store.js"').replaceAll('from "solid-js"', 'from "solid-js/dist/solid.js"')
  await Bun.write(files[0], compile(await Bun.file(join(import.meta.dir, "../../ui/src/context/helper.tsx")).text(), "helper.tsx"))
  let source = compile(await Bun.file(join(import.meta.dir, "../src/context/global.tsx")).text(), "global.tsx")
    .replaceAll('from "@opencode-ai/ui/context"', `from ${JSON.stringify(files[0])}`)
  for (const module of ["./server", "./server-sdk", "./server-sync", "@/utils/server-health"]) {
    source = source.replaceAll(`from "${module}"`, `from ${JSON.stringify(import.meta.path)}`)
  }
  await Bun.write(files[1], source)
  const global = await import(files[1])
  Provider = global.GlobalProvider
  useGlobal = global.useGlobal
})
afterAll(() => files.forEach((file) => rmSync(file, { force: true })))

test("same-key credential replacement refreshes the shared context; display name only preserves it", () => {
  setList([initial])
  const root = document.createElement("div")
  let id = 0
  const dispose = render(() => createComponent(Provider, { get children() {
    const global = useGlobal()
    const output = document.createElement("div")
    createEffect(() => {
      const ctx = global.ensureServerCtx(list()[0])
      id = ctx.sdk.id
      output.textContent = ctx.sdk.username
    })
    return output
  } }), root)
  try {
    const first = id
    setList([{ ...initial, displayName: "renamed" }])
    expect(id).toBe(first)
    setList([{ ...initial, http: { ...initial.http, username: "second", password: "fake-second" } }])
    expect(root.textContent).toBe("second")
    expect(id).not.toBe(first)
    expect(released).toContain(String(first))
  } finally { dispose() }
})
