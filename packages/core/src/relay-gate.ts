export * as RelayGate from "./relay-gate"

import { makeGlobalNode } from "./effect/app-node"
import { Config, Context, Effect, Layer } from "effect"

export const Names = ["relay_core_ui", "relay_layout", "relay_skills", "relay_mcp", "scheduled_tasks"] as const
export type Name = (typeof Names)[number]

export interface Info {
  readonly relayCoreUi: boolean
  readonly relayLayout: boolean
  readonly relaySkills: boolean
  readonly relayMcp: boolean
  readonly scheduledTasks: boolean
}

export const closed: Info = {
  relayCoreUi: false,
  relayLayout: false,
  relaySkills: false,
  relayMcp: false,
  scheduledTasks: false,
}

const flag = (name: string) =>
  Config.boolean(name).pipe(
    Config.withDefault(false),
    Config.orElse(() => Config.succeed(false)),
  )

const flags = Config.all({
  relayCoreUi: flag("OPENCODE_RELAY_CORE_UI"),
  relayLayout: flag("OPENCODE_RELAY_LAYOUT"),
  relaySkills: flag("OPENCODE_RELAY_SKILLS"),
  relayMcp: flag("OPENCODE_RELAY_MCP"),
  scheduledTasks: flag("OPENCODE_SCHEDULED_TASKS"),
})

export class Service extends Context.Service<Service, Info>()("@opencode/RelayGate") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    return Service.of(yield* flags)
  }),
).pipe(Layer.orDie)

export const layerWith = (input: Partial<Info> = {}) => Layer.succeed(Service, Service.of({ ...closed, ...input }))

export const node = makeGlobalNode({ service: Service, layer, deps: [] })

const byName = {
  relay_core_ui: (info: Info) => info.relayCoreUi,
  relay_layout: (info: Info) => info.relayLayout,
  relay_skills: (info: Info) => info.relaySkills,
  relay_mcp: (info: Info) => info.relayMcp,
  scheduled_tasks: (info: Info) => info.scheduledTasks,
} as const

export function enabled(info: Info, name: Name) {
  return byName[name](info)
}
