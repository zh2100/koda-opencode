import { expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer, ManagedRuntime } from "effect"
import { InstanceWork } from "../../src/effect/instance-work"
import { RuntimeShutdown } from "../../src/effect/runtime-shutdown"
import { InstanceRef } from "../../src/effect/instance-ref"
import { Project } from "../../src/project/project"
import { testEffect } from "../lib/effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { attach, makeRuntime } from "../../src/effect/run-service"
import { Context } from "effect"
import path from "node:path"
import { Flock } from "@opencode-ai/core/util/flock"
import { tmpdirScoped } from "../fixture/fixture"
import { EffectBridge } from "../../src/effect/bridge"

const it = testEffect(LayerNode.compile(CrossSpawnSpawner.node))

const context = () => ({ directory: crypto.randomUUID(), worktree: "/test", project: { id: "global" } as Project.Info })

it.live("cancelling the waiter retains accepted work until its real completion", () => Effect.gen(function* () {
  const ctx = context()
  const started = yield* Deferred.make<void>()
  const finish = yield* Deferred.make<void>()
  let finished = false
  const fiber = yield* InstanceWork.run(Effect.gen(function* () {
    yield* Deferred.succeed(started, undefined)
    yield* Deferred.await(finish)
    finished = true
  })).pipe(Effect.provideService(InstanceRef, ctx), Effect.forkScoped)
  yield* Deferred.await(started)
  yield* Fiber.interrupt(fiber)
  expect(InstanceWork.owner(ctx).tasks.size).toBe(1)
  const drained = InstanceWork.drain(ctx)
  expect(finished).toBe(false)
  expect(InstanceWork.owner(ctx).phase).not.toBe("closed")
  yield* Deferred.succeed(finish, undefined)
  yield* Effect.promise(() => drained)
  expect(finished).toBe(true)
  expect(InstanceWork.owner(ctx).phase).toBe("closed")
}))

it.live("quiescing rejects new jobs but permits necessary children of accepted work", () => Effect.gen(function* () {
  const ctx = context()
  const started = yield* Deferred.make<void>()
  const child = yield* Deferred.make<void>()
  let written = false
  const parent = yield* InstanceWork.run(Effect.gen(function* () {
    yield* Deferred.succeed(started, undefined)
    yield* Deferred.await(child)
    yield* InstanceWork.run(Effect.sync(() => { written = true }))
  })).pipe(Effect.provideService(InstanceRef, ctx), Effect.forkScoped)
  yield* Deferred.await(started)
  const drained = InstanceWork.drain(ctx)
  const rejected = yield* InstanceWork.run(Effect.void).pipe(Effect.provideService(InstanceRef, ctx), Effect.exit)
  expect(rejected._tag).toBe("Failure")
  yield* Deferred.succeed(child, undefined)
  yield* Fiber.join(parent)
  yield* Effect.promise(() => drained)
  expect(written).toBe(true)
}))

it.live("producer stops before draining and shutdown waits for actual ManagedRuntime finalizers", () => Effect.gen(function* () {
  const ctx = context()
  const release = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  let stop = 0
  InstanceWork.registerProducer(ctx, async () => { stop++ })
  const runtime = ManagedRuntime.make(Layer.effectDiscard(Effect.addFinalizer(() => Effect.promise(() => {
    entered.resolve()
    return release.promise
  }))))
  yield* Effect.promise(() => runtime.runPromise(Effect.void))
  const shutdown = RuntimeShutdown.makeShutdown(() => InstanceWork.drain(ctx), () => runtime.dispose(), 25)
  const first = shutdown.dispose()
  expect(shutdown.dispose()).toBe(first)
  const error = first.catch((error) => error)
  yield* Effect.promise(() => entered.promise)
  yield* Effect.promise(() => error)
  expect(stop).toBe(1)
  expect(shutdown.state.actualClosed).toBe(false)
  expect(shutdown.state.timedOut).toBe(true)
  release.resolve()
  yield* Effect.promise(() => runtime.dispose())
  // Observe the original close continuation, without starting another close.
  yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)))
  expect(shutdown.state.actualClosed).toBe(true)
  expect(shutdown.dispose()).toBe(first)
}))

it.live("cancelled real lock owner drains before runtime disposal and blocks an independent contender", () => Effect.gen(function* () {
  const dir = yield* tmpdirScoped()
  const ctx = context()
  const lockContext = { data: dir, state: dir, config: dir, cache: dir }
  const key = `acc-work-${crypto.randomUUID()}`
  const started = yield* Deferred.make<void>()
  const finish = yield* Deferred.make<void>()
  const blocked = Promise.withResolvers<void>()
  let raw = false
  yield* Effect.addFinalizer(() => Deferred.succeed(finish, undefined).pipe(Effect.asVoid))
  const holder = yield* InstanceWork.run(Effect.acquireRelease(
    Effect.promise(() => Flock.acquire(key, { context: lockContext })),
    (lease) => Effect.promise(() => lease.release()),
  ).pipe(Effect.andThen(Deferred.succeed(started, undefined)), Effect.andThen(Deferred.await(finish)))).pipe(
    Effect.provideService(InstanceRef, ctx), Effect.forkScoped,
  )
  yield* Deferred.await(started)
  yield* Fiber.interrupt(holder)
  const runtime = ManagedRuntime.make(Layer.effectDiscard(Effect.addFinalizer(() => Effect.sync(() => { raw = true }))))
  yield* Effect.promise(() => runtime.runPromise(Effect.void))
  const shutdown = RuntimeShutdown.makeShutdown(() => InstanceWork.drain(ctx), () => runtime.dispose())
  const closed = shutdown.dispose()
  const contender = Flock.acquire(key, { context: lockContext, onWait: () => blocked.resolve(), timeoutMs: 2000, baseDelayMs: 10, maxDelayMs: 30 })
  yield* Effect.promise(() => blocked.promise)
  expect(raw).toBe(false)
  expect(shutdown.state.rawDisposeStarted).toBe(false)
  yield* Deferred.succeed(finish, undefined)
  const lease = yield* Effect.promise(() => contender)
  yield* Effect.promise(() => lease.release())
  yield* Effect.promise(() => closed)
  expect(raw).toBe(true)
  expect(shutdown.state.actualClosed).toBe(true)
}))

it.live("captured EffectBridge keeps active ownership while draining and rejects reuse after completion", () => Effect.gen(function* () {
  const ctx = context()
  const ready = yield* Deferred.make<EffectBridge.Shape>()
  const proceed = yield* Deferred.make<void>()
  let children = 0
  const parent = yield* InstanceWork.run(Effect.gen(function* () {
    const bridge = yield* EffectBridge.make()
    const permit = yield* InstanceWork.WorkPermit
    expect(yield* bridge.run(InstanceWork.WorkPermit)).toBe(permit)
    const bound = bridge.bind(() => Effect.runSync(attach(InstanceWork.WorkPermit)))
    expect(bound()).toBe(permit)
    yield* Deferred.succeed(ready, bridge)
    yield* Deferred.await(proceed)
    yield* bridge.run(InstanceWork.run(Effect.sync(() => { children++ })))
  })).pipe(Effect.provideService(InstanceRef, ctx), Effect.forkScoped)
  const bridge = yield* Deferred.await(ready)
  const drained = InstanceWork.drain(ctx)
  yield* Deferred.succeed(proceed, undefined)
  yield* Fiber.join(parent)
  yield* Effect.promise(() => drained)
  expect(children).toBe(1)
  const stale = yield* bridge.run(InstanceWork.run(Effect.void).pipe(Effect.exit))
  expect(stale._tag).toBe("Failure")
}))

it.live("closed instance refuses a new public runtime call before building its service", () => Effect.gen(function* () {
  const ctx = context()
  let built = 0
  class Target extends Context.Service<Target, { value: number }>()("@test/ClosedWorkTarget") {}
  const runtime = makeRuntime(Target, Layer.effect(Target, Effect.sync(() => {
    built++
    return { value: 1 }
  })))
  yield* Effect.promise(() => InstanceWork.drain(ctx))
  const result = yield* Effect.sync(() => runtime.runSync((service) => Effect.succeed(service.value))).pipe(
    Effect.provideService(InstanceRef, ctx), Effect.exit,
  )
  expect(result._tag).toBe("Failure")
  expect(built).toBe(0)
}))

it.live("actual AppRuntime and independent runtimes reject all new entries as shutdown begins", () => Effect.gen(function* () {
  const dir = yield* tmpdirScoped()
  const script = `
    console.log("ACC_RUNTIME_IMPORT_BEGIN");
    const { Effect, Context, Layer } = await import("effect");
    const { AppRuntime } = await import("./src/effect/app-runtime.ts");
    console.log("ACC_RUNTIME_IMPORT_COMPLETE");
    const { makeRuntime } = await import("./src/effect/run-service.ts");
    const closing = AppRuntime.dispose();
    let dispatched = 0;
    const work = Effect.sync(() => { dispatched++ });
    for (const name of ["runSync", "runPromise", "runPromiseExit", "runFork", "runCallback"]) {
      try { await AppRuntime[name](work); throw new Error("entry accepted: " + name) }
      catch (error) { if (!String(error).includes("Instance is closing")) throw error }
    }
    class Target extends Context.Service()("@test/ShutdownTarget") {}
    const runtime = makeRuntime(Target, Layer.effect(Target, Effect.sync(() => { dispatched++; return {} })));
    try { await runtime.runPromise(() => work); throw new Error("independent runtime accepted") }
    catch (error) { if (!String(error).includes("Instance is closing")) throw error }
    await closing;
    if (dispatched !== 0) throw new Error("work was dispatched after shutdown");
    console.log("ACC_SHUTDOWN_ENTRY_OK");
  `
  const child = yield* Effect.acquireRelease(Effect.sync(() => Bun.spawn([process.execPath, "--eval", script], {
    cwd: path.resolve(import.meta.dir, "../.."),
    env: { ...process.env, OPENCODE_TEST_HOME: dir, XDG_DATA_HOME: path.join(dir, "data"), XDG_CONFIG_HOME: path.join(dir, "config"), XDG_STATE_HOME: path.join(dir, "state"), XDG_CACHE_HOME: path.join(dir, "cache"), OPENCODE_TEST_MANAGED_CONFIG_DIR: path.join(dir, "managed") },
    stdout: "pipe", stderr: "pipe",
  })), (child) => Effect.promise(async () => {
    if (child.exitCode === null) child.kill()
    await child.exited
  }))
  const [code, stdout, stderr] = yield* Effect.promise(() => Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])).pipe(Effect.timeout("150 seconds"))
  expect(stderr).not.toContain("entry accepted")
  expect(code).toBe(0)
  expect(stdout).toContain("ACC_RUNTIME_IMPORT_COMPLETE")
  expect(stdout).toContain("ACC_SHUTDOWN_ENTRY_OK")
}), 180000)

it.live("F22/F24 preparation cancellation drains real cleanup before releasing ownership", () => Effect.gen(function* () {
  const ctx = context()
  const started = yield* Deferred.make<void>()
  const cleaning = yield* Deferred.make<void>()
  const finish = yield* Deferred.make<void>()
  let published = 0
  const fiber = yield* InstanceWork.preparing((admit) => Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
    yield* Deferred.succeed(started, undefined)
    yield* restore(Effect.never)
    yield* admit
    published++
  })).pipe(Effect.ensuring(Effect.gen(function* () {
    yield* Deferred.succeed(cleaning, undefined)
    yield* Deferred.await(finish)
  })))).pipe(Effect.provideService(InstanceRef, ctx), Effect.forkScoped)
  yield* Deferred.await(started)
  const cancelled = yield* Fiber.interrupt(fiber).pipe(Effect.forkScoped)
  yield* Deferred.await(cleaning)
  expect(cancelled.pollUnsafe()).toBeUndefined()
  expect(InstanceWork.owner(ctx).tasks.size).toBe(1)
  expect(published).toBe(0)
  yield* Deferred.succeed(finish, undefined)
  yield* Fiber.join(cancelled)
  expect(InstanceWork.owner(ctx).tasks.size).toBe(0)
}))
it.live("F22/F30 admitted work survives request cancellation and is drained by its owner", () => Effect.gen(function* () {
  const ctx = context()
  const admitted = yield* Deferred.make<void>()
  const finish = yield* Deferred.make<void>()
  let published = 0
  const fiber = yield* InstanceWork.preparing((admit) => Effect.uninterruptible(Effect.gen(function* () {
    yield* admit
    yield* Deferred.succeed(admitted, undefined)
    yield* Deferred.await(finish)
    published++
  }))).pipe(Effect.provideService(InstanceRef, ctx), Effect.forkScoped)
  yield* Deferred.await(admitted)
  yield* Fiber.interrupt(fiber)
  expect(InstanceWork.owner(ctx).tasks.size).toBe(1)
  const drained = InstanceWork.drain(ctx)
  expect(published).toBe(0)
  yield* Deferred.succeed(finish, undefined)
  yield* Effect.promise(() => drained)
  expect(published).toBe(1)
  expect(InstanceWork.owner(ctx).tasks.size).toBe(0)
}))
it.live("F30 closing cancels a preparing job and never admits publication", () => Effect.gen(function* () {
  const ctx = context()
  const started = yield* Deferred.make<void>()
  let published = 0
  const fiber = yield* InstanceWork.preparing((admit) => Effect.gen(function* () {
    yield* Deferred.succeed(started, undefined)
    yield* Effect.never
    yield* admit
    published++
  })).pipe(Effect.provideService(InstanceRef, ctx), Effect.forkScoped)
  yield* Deferred.await(started)
  yield* Effect.promise(() => InstanceWork.drain(ctx))
  expect((yield* Fiber.await(fiber))._tag).toBe("Failure")
  expect(published).toBe(0)
  expect(InstanceWork.owner(ctx).phase).toBe("closed")
}))
