import { describe, expect } from "bun:test"
import { ConfigProvider, Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { RelayGate } from "@opencode-ai/core/relay-gate"
import { RelayPolicy } from "@opencode-ai/core/relay-policy"
import { it } from "./lib/effect"

const fromConfig = (input: Record<string, unknown>) =>
  AppNodeBuilder.build(RelayGate.node).pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(input))))

const readFlags = RelayGate.Service.useSync((flags) => flags)

const officialProviders = ["anthropic", "openai", "google", "openrouter", "github-copilot", "amazon-bedrock", "opencode", "openai-compatible", "xai"]

describe("RelayGate", () => {
  it.effect("defaults all five gates closed", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({})))

      expect(flags).toEqual(RelayGate.closed)
      for (const name of RelayGate.Names) {
        expect(RelayGate.enabled(flags, name)).toBe(false)
      }
    }),
  )

  it.effect("enables each gate independently", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(
        Effect.provide(
          fromConfig({
            OPENCODE_RELAY_CORE_UI: "true",
            OPENCODE_RELAY_LAYOUT: "true",
          }),
        ),
      )

      expect(flags.relayCoreUi).toBe(true)
      expect(flags.relayLayout).toBe(true)
      expect(flags.relaySkills).toBe(false)
      expect(flags.relayMcp).toBe(false)
      expect(flags.scheduledTasks).toBe(false)
    }),
  )

  it.effect("does not inherit OPENCODE_EXPERIMENTAL", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({ OPENCODE_EXPERIMENTAL: "true" })))

      expect(flags).toEqual(RelayGate.closed)
    }),
  )

  it.effect("treats unauthorized or invalid values as closed", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(
        Effect.provide(
          fromConfig({
            OPENCODE_RELAY_CORE_UI: "maybe",
            OPENCODE_RELAY_LAYOUT: "yes-please",
            OPENCODE_RELAY_SKILLS: "",
            OPENCODE_RELAY_MCP: "2",
            OPENCODE_SCHEDULED_TASKS: "TRUE",
          }),
        ),
      )

      expect(flags.relayCoreUi).toBe(false)
      expect(flags.relayLayout).toBe(false)
      expect(flags.relaySkills).toBe(false)
      expect(flags.relayMcp).toBe(false)
      expect(flags.scheduledTasks).toBe(false)
    }),
  )

  it.effect("accepts lowercase true and 1", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(
        Effect.provide(
          fromConfig({
            OPENCODE_RELAY_CORE_UI: "true",
            OPENCODE_RELAY_LAYOUT: "1",
            OPENCODE_RELAY_SKILLS: "false",
            OPENCODE_RELAY_MCP: "0",
          }),
        ),
      )

      expect(flags.relayCoreUi).toBe(true)
      expect(flags.relayLayout).toBe(true)
      expect(flags.relaySkills).toBe(false)
      expect(flags.relayMcp).toBe(false)
      expect(flags.scheduledTasks).toBe(false)
    }),
  )

  it.effect("layerWith starts closed and applies only provided overrides", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(RelayGate.layerWith({ relayCoreUi: true })))

      expect(flags.relayCoreUi).toBe(true)
      expect(flags.relayLayout).toBe(false)
      expect(flags.relaySkills).toBe(false)
      expect(flags.relayMcp).toBe(false)
      expect(flags.scheduledTasks).toBe(false)
    }),
  )
})

describe("RelayPolicy", () => {
  it.effect("hard-filters official providers regardless of gate combination", () =>
    Effect.gen(function* () {
      const combinations: Partial<RelayGate.Info>[] = [
        {},
        { relayCoreUi: true },
        { relayCoreUi: true, relayLayout: true },
        { relayCoreUi: true, relaySkills: true },
        { relayCoreUi: true, relayMcp: true },
        { relayCoreUi: true, scheduledTasks: true },
        {
          relayCoreUi: true,
          relayLayout: true,
          relaySkills: true,
          relayMcp: true,
          scheduledTasks: true,
        },
      ]

      for (const input of combinations) {
        const flags = yield* readFlags.pipe(Effect.provide(RelayGate.layerWith(input)))
        expect(RelayPolicy.allowsProvider(RelayPolicy.ProviderID)).toBe(true)
        for (const id of officialProviders) {
          expect(RelayPolicy.allowsProvider(id)).toBe(false)
        }
        expect(flags.relayCoreUi).toBe(input.relayCoreUi === true)
      }
    }),
  )

  it.effect("does not read gates when deciding provider access", () =>
    Effect.gen(function* () {
      yield* readFlags.pipe(Effect.provide(RelayGate.layerWith({ relayCoreUi: true, scheduledTasks: true })))

      expect(RelayPolicy.allowsProvider("openai")).toBe(false)
      expect(RelayPolicy.allowsProvider("leidiandonghua")).toBe(true)
      expect(RelayPolicy.BaseURL).toBe("https://api.leidiandonghua.cn/v1")
    }),
  )
})
