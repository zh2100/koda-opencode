export * as WorkspaceOwnership from "./workspace-ownership"

import { Context, Effect, Layer } from "effect"
import path from "node:path"
import { Location } from "./location"
import { KeyedMutex } from "./effect/keyed-mutex"
import { makeGlobalNode } from "./effect/app-node"

export interface Interface {
  /** Serializes all model execution that can mutate the same workspace. */
  readonly withOwnership: <A, E, R>(input: {
    readonly location: Location.Ref
    readonly ownerID: string
    readonly effect: Effect.Effect<A, E, R>
  }) => Effect.Effect<A, E, R>
  readonly key: (location: Location.Ref) => string
}

export class Service extends Context.Service<Service, Interface>()("@opencode/WorkspaceOwnership") {}

const normalizeDirectory = (directory: string) => {
  const windowsPath = process.platform === "win32" || /^[A-Za-z]:[\\/]/.test(directory) || directory.startsWith("\\\\")
  if (!windowsPath) return path.resolve(directory)
  return path.win32.resolve(directory).replaceAll("\\", "/").toLowerCase()
}

export const workspaceKey = (location: Location.Ref) =>
  location.workspaceID === undefined ? `directory:${normalizeDirectory(location.directory)}` : `workspace:${location.workspaceID}`

export const layer = Layer.effect(
  Service,
  Effect.sync(() => {
    const mutex = KeyedMutex.makeUnsafe<string>()
    const key = workspaceKey

    const withOwnership = <A, E, R>(input: {
      readonly location: Location.Ref
      readonly ownerID: string
      readonly effect: Effect.Effect<A, E, R>
    }) => mutex.withLock(key(input.location))(input.effect)

    return Service.of({ withOwnership, key })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
