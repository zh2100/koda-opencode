import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import assert from "node:assert/strict"
import { configure, admit } from "../../../../../script/test-isolation.mjs"
const root = await fs.mkdtemp(path.join(os.tmpdir(), "project-refresh-http-"))
configure(root)
admit(root)
const { Server } = await import("../../../src/server/server")
const { Config } = await import("../../../src/config/config")
const { ProjectConfig } = await import("../../../src/config/project-write")
const { InstanceWork } = await import("../../../src/effect/instance-work")
const { AppRuntime } = await import("../../../src/effect/app-runtime")
const { Global } = await import("@opencode-ai/core/global")
const mode = process.argv[2]
const project = path.join(root, "project")
for (const directory of [project, Global.Path.config, path.join(project, ".opencode")]) {
  await fs.mkdir(path.join(directory, "node_modules"), { recursive: true })
  await fs.writeFile(
    path.join(directory, "package-lock.json"),
    JSON.stringify({
      lockfileVersion: 3,
      packages: { "": { dependencies: { "@opencode-ai/plugin": "workspace:*" } } },
    }),
  )
}
process.env.npm_config_offline = "true"
process.env.npm_config_fetch_retries = "0"
const file = path.join(project, "opencode.json")
await fs.writeFile(
  file,
  '{"$schema":"https://opencode.ai/config.json","username":"before","formatter":false,"lsp":false}',
)
let calls = 0,
  admitted = 0
const off = Config.onConfigReload(
  (directory) => {
    if (directory !== project) return
    calls++
    if (mode === "terminal" || calls === 1) throw Error("PRIVATE-HTTP-REFRESH")
  },
  { idempotent: mode === "transient" },
)
const observe = ProjectConfig.observe(project, (phase) => {
  if (phase === "admitted") admitted++
})
const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
let shutdownFailed = false
try {
  const headers = { "content-type": "application/json", "x-opencode-directory": project }
  const saved = await fetch(new URL("config", listener.url), {
    method: "PATCH",
    headers,
    body: JSON.stringify({ username: "after" }),
  })
  assert.equal(saved.status, 200)
  await saved.arrayBuffer()
  const state = await InstanceWork.waitHandoffs()
  assert.equal(state.active, 0)
  assert.equal(state.unrecovered, mode === "terminal" ? 1 : 0)
  assert.equal(admitted, 1)
  assert.equal(calls, mode === "terminal" ? 1 : 2)
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).username, "after")
  const loaded = await fetch(new URL("config", listener.url), { headers })
  assert.equal(loaded.status, 200)
  assert.equal(((await loaded.json()) as { username: string }).username, "after")
  assert.equal(admitted, 1)
  assert.equal(calls, mode === "terminal" ? 1 : 2)
  assert.equal(JSON.stringify(state).includes("PRIVATE-HTTP-REFRESH"), false)
} finally {
  observe()
  off()
  await listener.stop(true)
  await AppRuntime.dispose().catch(() => {
    shutdownFailed = true
  })
}
assert.equal(shutdownFailed, mode === "terminal")
console.log("REFRESH_HTTP_RESULT " + JSON.stringify({ mode, calls, admitted, shutdownFailed }))
