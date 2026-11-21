import { expect } from "bun:test"
import path from "node:path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Npm } from "@opencode-ai/core/npm"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { Effect, Exit, Fiber } from "effect"
import { InstanceWork } from "../../src/effect/instance-work"
import { InstanceStore } from "../../src/project/instance-store"
import { requireInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Npm.node, EffectFlock.node])))

for (const outcome of ["success", "failure"] as const) {
  it.instance(`dispose waits for dispatched npm install: ${outcome}`, () =>
    Effect.gen(function* () {
      const ctx = yield* requireInstance
      const store = yield* InstanceStore.Service
      const npm = yield* Npm.Service
      const flock = yield* EffectFlock.Service
      const key = `npm-install:${ctx.directory}`
      const started = Promise.withResolvers<void>()
      const finish = Promise.withResolvers<void>()
      const name = `test-${crypto.randomUUID()}`
      const archive = yield* Effect.promise(() =>
        new Bun.Archive(
          {
            "package/package.json": JSON.stringify({ name, version: "1.0.0" }),
          },
          { compress: "gzip" },
        ).blob(),
      )
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch() {
          started.resolve()
          await finish.promise
          return outcome === "success" ? new Response(archive) : new Response(null, { status: 404 })
        },
      })
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          finish.resolve()
          await server.stop(true)
        }),
      )
      yield* Effect.promise(() => Bun.write(path.join(ctx.directory, ".npmrc"), "audit=false\nfetch-retries=0\n"))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(ctx.directory, "package.json"),
          JSON.stringify({
            name: "test-install",
            dependencies: { [name]: `${server.url}${name}.tgz` },
          }),
        ),
      )
      const task = yield* InstanceWork.run(npm.install(ctx.directory), "config-dependency-install").pipe(
        Effect.exit,
        Effect.forkScoped,
      )
      yield* Effect.promise(() => started.promise).pipe(Effect.timeout("10 seconds"))
      const signal = InstanceWork.shutdownSignal(ctx)
      const stopping = new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
      const close = yield* store.dispose(ctx).pipe(Effect.forkScoped)
      yield* Effect.promise(() => stopping).pipe(Effect.timeout("2 seconds"))
      expect(InstanceWork.pending(ctx)?.tasks).toContain("config-dependency-install")
      expect(yield* flock.tryAcquire(key).pipe(Effect.scoped)).toBe(false)
      const dispatches: string[] = []
      const late = yield* InstanceWork.run(Effect.sync(() => dispatches.push("install"))).pipe(Effect.exit)
      expect(Exit.isFailure(late)).toBe(true)
      expect(dispatches).toEqual([])
      finish.resolve()
      expect(Exit.isSuccess(yield* Fiber.join(task))).toBe(outcome === "success")
      yield* Fiber.join(close)
      expect(InstanceWork.pending(ctx)).toEqual({ phase: "closed", tasks: [], producers: 0 })
      expect(yield* flock.tryAcquire(key).pipe(Effect.scoped)).toBe(true)
    }),
  )
}
