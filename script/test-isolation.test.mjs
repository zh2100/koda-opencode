import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import assert from "node:assert/strict"
import { test } from "node:test"
import { spawnSync } from "node:child_process"
import { admit, configure, confirm, preload, requireInside } from "./test-isolation.mjs"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-admission-"))
const sibling = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-admission-outside-"))
test.after(() => {
  // Both directories were created and retained by this module.
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(sibling, { recursive: true, force: true })
})

test("I01: admits normal roots and explicitly supplied layer paths", () => {
  configure(root)
  assert.equal(admit(root, { global: { data: path.join(root, "layer") } }).home, path.join(root, "home"))
})

for (const name of ["OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_DB", "TEMP", "TMP", "XDG_STATE_HOME"]) {
  test(`I02: rejects ${name} before the product entry sentinel`, () => {
    configure(root)
    const before = fs.readdirSync(sibling)
    process.env[name] = path.join(sibling, "missing", "target")
    let entered = false
    assert.throws(() => { admit(root); entered = true })
    assert.equal(entered, false)
    assert.deepEqual(fs.readdirSync(sibling), before)
  })
}

test("I02: rejects external, malformed and unexpected registrations", () => {
  configure(root)
  const descriptor = path.join(process.env.OPENCODE_TEST_HOME, ".opencode", "opencode-resource-root.json")
  fs.mkdirSync(path.dirname(descriptor), { recursive: true })
  for (const text of ["{", "null", JSON.stringify({ data: sibling, config: sibling, state: sibling, cache: sibling })]) {
    fs.writeFileSync(descriptor, text)
    assert.throws(() => admit(root))
    assert.throws(() => admit(root, { registered: true }))
    assert.deepEqual(fs.readdirSync(sibling), [])
  }
  fs.unlinkSync(descriptor)
})

test("I02: rejects a junction/symlink and nonexistent descendants through it", () => {
  configure(root)
  const alias = path.join(root, "alias")
  fs.symlinkSync(sibling, alias, process.platform === "win32" ? "junction" : "dir")
  assert.throws(() => requireInside(root, path.join(alias, "missing", "child")))
  fs.unlinkSync(alias)
})

test("I03: environment and registry drift invalidate admission", () => {
  configure(root)
  const first = admit(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "other")
  assert.throws(() => confirm(first))
  configure(root)
  const second = admit(root)
  const descriptor = path.join(process.env.OPENCODE_TEST_HOME, ".opencode", "opencode-resource-root.json")
  fs.writeFileSync(descriptor, "{}")
  assert.throws(() => confirm(second))
  fs.unlinkSync(descriptor)
})

test("I03: a preload reselects and admits its owned child", () => {
  configure(root)
  const selected = preload("child-")
  requireInside(root, selected.root)
  confirm(selected)
})

test("I02: product marker validation rejects unknown and inconsistent protocols before Global", () => {
  const owned = path.join(root, "product")
  fs.mkdirSync(owned)
  configure(owned)
  const state = path.join(process.env.XDG_STATE_HOME, "opencode")
  fs.mkdirSync(state, { recursive: true })
  const marker = path.join(state, "path-identity.json")
  const sentinel = path.join(owned, "entered")
  const entry = path.join(owned, "entry.mjs")
  const source = new URL("../packages/core/src/", import.meta.url)
  fs.writeFileSync(entry, [
    `import fs from "node:fs"`,
    `import { admit, confirm, reconcile } from ${JSON.stringify(import.meta.url.replace("test-isolation.test.mjs", "test-isolation.mjs"))}`,
    `const a = admit(process.env.OPENCODE_TEST_ROOT, { registered: true })`,
    `const { ResourceRoot } = await import(${JSON.stringify(new URL("resource-root.ts", source).href)})`,
    `const { LockProtocol } = await import(${JSON.stringify(new URL("util/lock-protocol.ts", source).href)})`,
    `const selected = ResourceRoot.select(ResourceRoot.defaultPaths(), a.home)`,
    `LockProtocol.resolve("test-admission", selected.context)`,
    `confirm(a)`,
    `fs.writeFileSync(${JSON.stringify(sentinel)}, "entered")`,
    `const { Global } = await import(${JSON.stringify(new URL("global.ts", source).href)})`,
    `reconcile(a, Global.make())`,
  ].join("\n"))
  for (const value of ["{", { generation: "unknown" }, { generation: "path-identity-v1", status: 123 }, { generation: "path-identity-v1", status: "migrating" }]) {
    fs.writeFileSync(marker, typeof value === "string" ? value : JSON.stringify(value))
    const result = spawnSync("bun", [entry], { env: process.env, encoding: "utf8", windowsHide: true })
    assert.notEqual(result.status, 0, result.stderr)
    assert.equal(fs.existsSync(sentinel), false)
    assert.equal(fs.existsSync(path.join(owned, "data", "opencode")), false)
  }
  const descriptor = path.join(process.env.OPENCODE_TEST_HOME, ".opencode", "opencode-resource-root.json")
  fs.mkdirSync(path.dirname(descriptor), { recursive: true })
  const registration = {
    schemaVersion: 1, rootId: "12345678-1234-4234-8234-123456789012", generation: "os-lock-v1", epoch: 1, requireManifest: true,
    ...Object.fromEntries(["data", "config", "state", "cache"].map((name) => [name, path.join(process.env[`XDG_${name.toUpperCase()}_HOME`], "opencode")])),
  }
  fs.writeFileSync(descriptor, JSON.stringify(registration))
  const manifest = { schemaVersion: 1, rootId: registration.rootId, generation: "os-lock-v1", epoch: 1, status: "complete", backend: "native-file-v1", keyFormat: "canonical-path-v1" }
  fs.writeFileSync(marker, JSON.stringify({ ...manifest, epoch: 2 }))
  const rejected = spawnSync("bun", [entry], { env: process.env, encoding: "utf8", windowsHide: true })
  assert.notEqual(rejected.status, 0)
  assert.equal(fs.existsSync(sentinel), false)
  // Resolve selects the backend without loading .node or acquiring a business lock.
  fs.writeFileSync(marker, JSON.stringify(manifest))
  const accepted = spawnSync("bun", [entry], { env: process.env, encoding: "utf8", windowsHide: true })
  assert.equal(accepted.status, 0, accepted.stderr)
  assert.equal(fs.readFileSync(sentinel, "utf8"), "entered")
})
