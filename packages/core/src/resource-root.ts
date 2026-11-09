import fs from "fs"
import os from "os"
import path from "path"
import { LockIdentity } from "./util/lock-identity"
import { LockProtocol } from "./util/lock-protocol"

export const descriptorName = "opencode-resource-root.json"

export type Paths = {
  readonly data: string
  readonly config: string
  readonly state: string
  readonly cache: string
}

export type Selection = {
  readonly paths: Paths
  readonly context: LockProtocol.Context
  readonly adopted: boolean
}

function descriptor(home: string) {
  return path.join(home, ".opencode", descriptorName)
}

export function currentHome() {
  return process.env.OPENCODE_TEST_HOME ?? os.homedir()
}

export function select(fallback: Paths, home: string): Selection {
  const file = descriptor(home)
  const registration = LockProtocol.readRegistration(file)
  if (!registration) return { paths: fallback, context: LockProtocol.unregistered(fallback), adopted: false }
  const paths = {
    data: registration.data,
    config: registration.config,
    state: registration.state,
    cache: registration.cache,
  }
  const marker = LockIdentity.marker(paths.state)
  const record = LockProtocol.readMarker(paths.state)
  const context = LockProtocol.registered(registration, record ?? failMissing(marker))
  return { paths, context, adopted: true }
}

function failMissing(marker: string): never {
  throw new Error(`protocol-invalid: ${marker}: registered root is missing its completed manifest`)
}

export function defaultPaths(home = currentHome()): Paths {
  const app = "opencode"
  const env = process.env
  return {
    data: path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), app),
    config: path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), app),
    state: path.join(env.XDG_STATE_HOME || path.join(home, ".local", "state"), app),
    cache: path.join(env.XDG_CACHE_HOME || path.join(home, ".cache"), app),
  }
}

export function resolveContext(home = currentHome(), fallback?: Paths): LockProtocol.Context {
  return select(fallback ?? defaultPaths(home), home).context
}

export function remember(home: string, registration: LockProtocol.Registration) {
  const file = descriptor(home)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(registration, null, 2))
  fs.renameSync(temporary, file)
}

export * as ResourceRoot from "./resource-root"
