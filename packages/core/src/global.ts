import path from "path"
import fs from "fs/promises"
import os from "os"
import { Context, Effect, Layer } from "effect"
import { Flock } from "./util/flock"
import { Flag } from "./flag/flag"
import { makeGlobalNode } from "./effect/app-node"
import { ResourceRoot } from "./resource-root"
import { LockProtocol } from "./util/lock-protocol"

const selected = ResourceRoot.select(ResourceRoot.defaultPaths(), process.env.OPENCODE_TEST_HOME ?? os.homedir())
const data = selected.paths.data
const cache = selected.paths.cache
const config = selected.paths.config
const state = selected.paths.state
const tmp = path.join(os.tmpdir(), "opencode")

const paths = {
  get home() {
    return process.env.OPENCODE_TEST_HOME ?? os.homedir()
  },
  data,
  bin: path.join(cache, "bin"),
  log: path.join(data, "log"),
  repos: path.join(data, "repos"),
  cache,
  config,
  state,
  tmp,
}

export const Path = paths
export const lockContext = selected.context

Flock.setGlobal(selected.context)

await Promise.all([
  fs.mkdir(Path.data, { recursive: true }),
  fs.mkdir(Path.config, { recursive: true }),
  fs.mkdir(Path.state, { recursive: true }),
  fs.mkdir(Path.tmp, { recursive: true }),
  fs.mkdir(Path.log, { recursive: true }),
  fs.mkdir(Path.bin, { recursive: true }),
  fs.mkdir(Path.repos, { recursive: true }),
])

export class Service extends Context.Service<Service, Interface>()("@opencode/Global") {}

export interface Interface {
  readonly home: string
  readonly data: string
  readonly cache: string
  readonly config: string
  readonly state: string
  readonly tmp: string
  readonly bin: string
  readonly log: string
  readonly repos: string
  readonly lockContext: LockProtocol.Context
}

function lockContextFor(input: Partial<Interface>): LockProtocol.Context {
  if (input.lockContext) return input.lockContext
  const config = input.config ?? Flag.OPENCODE_CONFIG_DIR ?? Path.config
  const overrides = Boolean(input.data || input.state || input.cache || config !== Path.config)
  if (!overrides) return lockContext
  const paths = {
    data: input.data ?? Path.data,
    config,
    state: input.state ?? Path.state,
    cache: input.cache ?? Path.cache,
  }
  if (input.home) return ResourceRoot.select(paths, input.home).context
  if (lockContext.registration) {
    throw new Error("resource root override does not match the adopted registration")
  }
  return LockProtocol.unregistered(paths)
}

export function make(input: Partial<Interface> = {}): Interface {
  const context = lockContextFor(input)
  return {
    ...input,
    home: input.home ?? Path.home,
    tmp: input.tmp ?? Path.tmp,
    bin: input.bin ?? path.join(context.cache, "bin"),
    log: input.log ?? path.join(context.data, "log"),
    repos: input.repos ?? path.join(context.data, "repos"),
    data: context.data,
    cache: context.cache,
    config: context.config,
    state: context.state,
    lockContext: context,
  }
}

const layer = Layer.effect(
  Service,
  Effect.sync(() => Service.of(make())),
)

export const node = makeGlobalNode({ service: Service, layer: layer, deps: [] })

export const layerWith = (input: Partial<Interface>) =>
  Layer.effect(
    Service,
    Effect.sync(() => Service.of(make(input))),
  )

export * as Global from "./global"
