// Keep this import graph limited to Node builtins: Global creates directories on import.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"

export function identity(target) {
  if (typeof target !== "string" || !path.isAbsolute(target)) throw new Error("isolation: absolute path required")
  const pending = []
  let current = path.resolve(target)
  for (;;) {
    try {
      fs.lstatSync(current)
      const resolved = path.join(fs.realpathSync.native(current), ...pending)
      return process.platform === "win32" ? resolved.toLowerCase() : resolved
    } catch (error) {
      if (error.code !== "ENOENT") throw new Error("isolation: unresolved path")
      const parent = path.dirname(current)
      if (parent === current) throw new Error("isolation: no existing ancestor")
      pending.unshift(path.basename(current))
      current = parent
    }
  }
}

export function requireInside(root, target) {
  const relative = path.relative(identity(root), identity(target))
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error("isolation: path outside owned root")
  return target
}

export function configure(root) {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("OPENCODE_") || /(?:API_KEY|API_TOKEN|ACCESS_TOKEN|SECRET|PASSWORD|CREDENTIALS)$/i.test(name))
      delete process.env[name]
  }
  Object.assign(process.env, {
    OPENCODE_TEST_ROOT: root,
    OPENCODE_TEST_HOME: path.join(root, "home"),
    HOME: path.join(root, "home"),
    USERPROFILE: path.join(root, "home"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_STATE_HOME: path.join(root, "state"),
    TEMP: path.join(root, "tmp"),
    TMP: path.join(root, "tmp"),
    TMPDIR: path.join(root, "tmp"),
    OPENCODE_TEST_MANAGED_CONFIG_DIR: path.join(root, "managed"),
    OPENCODE_DB: ":memory:",
    OPENCODE_DISABLE_MODELS_FETCH: "true",
  })
  fs.mkdirSync(process.env.TEMP, { recursive: true })
}

function digest(file) {
  try {
    return createHash("sha256").update(fs.readFileSync(file)).digest("hex")
  } catch (error) {
    if (error.code === "ENOENT") return null
    throw new Error("isolation: unreadable descriptor")
  }
}

// Product schema/marker validation follows this structural and ownership check.
// Registrations must be explicitly opted into by protocol-specific test callers.
export function admit(root, options = {}) {
  if (process.env.OPENCODE_TEST_ROOT !== root) throw new Error("isolation: root ownership mismatch")
  const home = requireInside(root, process.env.OPENCODE_TEST_HOME)
  for (const name of ["HOME", "USERPROFILE", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "TEMP", "TMP", "TMPDIR", "OPENCODE_TEST_MANAGED_CONFIG_DIR"])
    requireInside(root, process.env[name])
  const registration = path.join(home, ".opencode", "opencode-resource-root.json")
  requireInside(root, registration)
  const checksum = digest(registration)
  const record = checksum === null ? undefined : JSON.parse(fs.readFileSync(registration, "utf8"))
  if (record && !options.registered) throw new Error("isolation: unexpected resource registration")
  if (checksum !== null && (!record || typeof record !== "object" || Array.isArray(record)))
    throw new Error("isolation: invalid registration")
  const paths = Object.fromEntries(["data", "config", "state", "cache"].map((name) => [
    name, requireInside(root, record ? record[name] : path.join(process.env[`XDG_${name.toUpperCase()}_HOME`], "opencode")),
  ]))
  const marker = requireInside(root, path.join(paths.state, "path-identity.json"))
  const overrides = Object.fromEntries(["OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_NATIVE_LOCK_DIR"].map((name) => [name, process.env[name]]))
  for (const value of Object.values(overrides)) if (value !== undefined) requireInside(root, value)
  if (process.env.OPENCODE_CONFIG_CONTENT !== undefined) throw new Error("isolation: unexpected inline configuration")
  if (process.env.OPENCODE_DB !== ":memory:") requireInside(root, process.env.OPENCODE_DB)
  for (const value of Object.values(options.global ?? {})) {
    if (typeof value === "string") requireInside(root, value)
  }
  if (options.global?.lockContext) {
    for (const name of ["data", "config", "state", "cache"])
      requireInside(root, options.global.lockContext[name])
  }
  return {
    root, paths, home, tmp: requireInside(root, path.join(os.tmpdir(), "opencode")),
    registration, checksum, marker, markerChecksum: digest(marker),
    env: JSON.stringify(Object.entries(process.env).filter(([name]) => name.startsWith("OPENCODE_") || ["HOME", "USERPROFILE", "TEMP", "TMP", "TMPDIR"].includes(name) || name.startsWith("XDG_")).sort()),
  }
}

export function confirm(admission) {
  const current = admit(admission.root, { registered: admission.checksum !== null })
  if (current.env !== admission.env || current.checksum !== admission.checksum || current.markerChecksum !== admission.markerChecksum)
    throw new Error("isolation: selection changed after admission")
}

export function reconcile(admission, global) {
  confirm(admission)
  for (const name of ["home", "data", "config", "state", "cache", "tmp", "bin", "log", "repos"])
    requireInside(admission.root, global[name])
  for (const name of ["data", "config", "state", "cache"])
    if (identity(global[name]) !== identity(admission.paths[name]) || identity(global.lockContext[name]) !== identity(admission.paths[name]))
      throw new Error("isolation: product selection differs from admission")
  if (identity(global.home) !== identity(admission.home) || identity(global.tmp) !== identity(admission.tmp))
    throw new Error("isolation: product auxiliary path differs from admission")
}

export function preload(prefix) {
  const parent = process.env.OPENCODE_TEST_ROOT
  if (parent) admit(parent)
  const root = fs.mkdtempSync(path.join(parent ? requireInside(parent, process.env.TEMP) : os.tmpdir(), prefix))
  configure(root)
  return admit(root)
}

// Call after a suite has selected its narrower paths and before its first product import.
export async function loadGlobal(root, options = {}) {
  const admission = admit(root, options)
  const { ResourceRoot } = await import("../packages/core/src/resource-root.ts")
  const { LockProtocol } = await import("../packages/core/src/util/lock-protocol.ts")
  const selected = ResourceRoot.select(ResourceRoot.defaultPaths(), admission.home)
  LockProtocol.resolve("test-isolation-admission", selected.context)
  confirm(admission)
  const { Global } = await import("../packages/core/src/global.ts")
  reconcile(admission, Global.make())
  return admission
}
