import { expect, spyOn, test } from "bun:test"
import path from "node:path"
import { Cause, Effect, Exit, Fiber } from "effect"
import { AppNodeBuilder } from "../../src/effect/app-node-builder"
import { LayerNode } from "../../src/effect/layer-node"
import { ConfigDocument } from "../../src/config/document"
import { FSUtil } from "../../src/fs-util"
import { Global } from "../../src/global"
import { ImageGenerationSettings } from "../../src/image-generation-settings"
import { EffectFlock } from "../../src/util/effect-flock"
import { Hash } from "../../src/util/hash"
import { tmpdir } from "../fixture/tmpdir"
import { createEffectFlockTestNode } from "../support/effect-flock-test-layer"

test("stage 0 replacement preserves service identity, global tag and dependencies", () => {
  const node = createEffectFlockTestNode({ onWait: () => {} })
  expect(node.service).toBe(EffectFlock.Service)
  expect(node.name).toBe(EffectFlock.node.name)
  expect(node.tag).toBe(EffectFlock.node.tag)
  expect(node.dependencies).toEqual([Global.node, FSUtil.node])
  expect(EffectFlock.node.implementation).toBe(EffectFlock.layer)
  // Unlike AppNodeBuilder, compile also checks replacement compatibility statically.
  LayerNode.compile(LayerNode.group([ImageGenerationSettings.node, EffectFlock.node, Global.node]), [
    [EffectFlock.node, node],
  ])
})

for (const throws of [false, true]) {
  test(`stage 0 real live-owner wait and shared settings instance (observer throws: ${throws})`, async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "opencode.json")
    const events: EffectFlock.WaitObservation[] = []
    const observed = Promise.withResolvers<EffectFlock.WaitObservation>()
    const node = createEffectFlockTestNode({
      onWait: (event) => {
        events.push(event)
        observed.resolve(event)
        if (throws) throw new Error("test observer failure")
      },
    })
    const intercepted = spyOn(ConfigDocument, "withLock")
    try {
      await Effect.gen(function* () {
        const flock = yield* EffectFlock.Service
        const settings = yield* ImageGenerationSettings.Service
        const global = yield* Global.Service
        const document = yield* ConfigDocument.describe(file)
        expect(document.decision.backend).toBe("directory")
        expect(document.decision.key).toBe(ConfigDocument.key(file))
        yield* flock.acquire(ConfigDocument.key(file))
        expect(events).toEqual([])
        const saving = yield* settings.update({ enabled: false }).pipe(Effect.forkChild)
        yield* Effect.promise(() => observed.promise).pipe(Effect.timeout("5 seconds"))
        yield* Fiber.interrupt(saving).pipe(Effect.timeout("5 seconds"))
        const exit = yield* Fiber.await(saving)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(true)
        expect(intercepted.mock.calls).toHaveLength(1)
        expect(intercepted.mock.calls[0][0]).toBe(flock)
        expect(events.length).toBeGreaterThan(0)
        expect(events[0]).toEqual({
          key: ConfigDocument.key(file),
          lockfile: path.join(global.state, "locks", Hash.fast(ConfigDocument.key(file)) + ".lock"),
        })
        expect(Object.keys(events[0]).sort()).toEqual(["key", "lockfile"])
        expect((yield* Effect.scoped(flock.probe(ConfigDocument.key(file)))).status).toBe("busy")
      }).pipe(
        Effect.scoped,
        Effect.provide(
          AppNodeBuilder.build(LayerNode.group([ImageGenerationSettings.node, EffectFlock.node, Global.node]), [
            [Global.node, Global.layerWith({ config: tmp.path, state: path.join(tmp.path, "state") })],
            [EffectFlock.node, node],
          ]),
        ),
        Effect.runPromise,
      )
    } finally {
      intercepted.mockRestore()
    }
  }, 10000)
}

test("stage 0 API audit: public package export hides the internal seam", async () => {
  const publicModule = await import("@opencode-ai/core/util/effect-flock")
  const internalModule = await import("../../src/util/effect-flock")
  const { EffectFlock } = publicModule
  expect(typeof EffectFlock.Service).toBe("function")
  expect(typeof EffectFlock.layer).toBe("object")
  expect(typeof EffectFlock.node).toBe("object")
  expect(EffectFlock.Service).toBe(internalModule.EffectFlock.Service)
  expect(EffectFlock.layer).toBe(internalModule.EffectFlock.layer)
  expect(EffectFlock.node).toBe(internalModule.EffectFlock.node)
  expect(EffectFlock.LockDiagnosis).toBe(internalModule.EffectFlock.LockDiagnosis)
  expect(EffectFlock.LockTimeoutError).toBe(internalModule.EffectFlock.LockTimeoutError)
  expect(EffectFlock.LockCompromisedError).toBe(internalModule.EffectFlock.LockCompromisedError)
  expect("layerWith" in EffectFlock).toBe(false)
  expect("WaitObservation" in EffectFlock).toBe(false)
})

test("stage 0 default layer still acquires, releases and reuses the real lock", async () => {
  await using tmp = await tmpdir()
  await Effect.gen(function* () {
    const flock = yield* EffectFlock.Service
    yield* flock.withLock(Effect.void, "stage-zero-default")
    expect((yield* Effect.scoped(flock.probe("stage-zero-default"))).status).toBe("acquired")
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(EffectFlock.node, [
        [Global.node, Global.layerWith({ config: tmp.path, state: path.join(tmp.path, "state") })],
      ]),
    ),
    Effect.runPromise,
  )
})
