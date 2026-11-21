import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { makeGlobalNode, Node } from "@opencode-ai/core/effect/app-node"
import { GlobalBus } from "@/bus/global"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { WorkspaceContext } from "@/control-plane/workspace-context"
import { InstanceWork } from "@/effect/instance-work"
import { InstanceRef } from "@/effect/instance-ref"
import { disposeInstance as runDisposers } from "@/effect/instance-registry"
import { FSUtil } from "@opencode-ai/core/fs-util"
import path from "path"
import { McpEditError } from "@/config/mcp-edit"
import { onConfigReload } from "@/config/config"
import { Context, Deferred, Duration, Effect, Exit, Layer, Scope } from "effect"
import { type InstanceContext } from "./instance-context"
import { InstanceBootstrap } from "./bootstrap-service"
import * as Project from "./project"

export interface LoadInput {
  directory: string
  worktree?: string
  project?: Project.Info
}

export interface Interface {
  readonly load: (input: LoadInput) => Effect.Effect<InstanceContext, McpEditError>
  readonly reload: (input: LoadInput) => Effect.Effect<InstanceContext, McpEditError>
  readonly dispose: (ctx: InstanceContext) => Effect.Effect<void>
  readonly disposeDirectory: (directory: string) => Effect.Effect<void>
  readonly disposeAll: () => Effect.Effect<void>
  readonly provide: <A, E, R>(input: LoadInput, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/InstanceStore") {}

export const use = serviceUse(Service)

interface Entry {
  readonly deferred: Deferred.Deferred<InstanceContext, McpEditError>
  ctx?: InstanceContext
  phase?: "loading" | "ready" | "cleaning" | "failed-cleanup"
  cleanup?: Promise<void>
  replacing?: boolean
}

const layer: Layer.Layer<Service, never, Project.Service | InstanceBootstrap.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const project = yield* Project.Service
    const bootstrap = yield* InstanceBootstrap.Service
    const scope = yield* Scope.Scope
    // Cleanup outlives individual waiters, but must keep the runtime's log sink
    // (CLI stdout is reserved for command results and JSON protocol frames).
    const runCleanup = Effect.runPromiseWith(yield* Effect.context<never>())
    const cache = new Map<string, Entry>()

    const boot = (input: LoadInput & { directory: string }, entry: Entry) =>
      Effect.gen(function* () {
        const ctx: InstanceContext =
          input.project && input.worktree
            ? {
                directory: input.directory,
                worktree: input.worktree,
                project: input.project,
              }
            : yield* project.fromDirectory(input.directory).pipe(
                Effect.map((result) => ({
                  directory: input.directory,
                  worktree: result.sandbox,
                  project: result.project,
                })),
              )
        entry.ctx = ctx
        yield* InstanceWork.run(bootstrap.run, "bootstrap").pipe(Effect.provideService(InstanceRef, ctx))
        return ctx
      }).pipe(Effect.withSpan("InstanceStore.boot"))

    const completeLoad = (directory: string, input: LoadInput, entry: Entry) =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(boot({ ...input, directory }, entry))
        if (Exit.isFailure(exit)) {
          entry.phase = "cleaning"
          entry.cleanup = (entry.ctx ? InstanceWork.drain(entry.ctx).then(() => runDisposers(directory, entry.ctx, true)) : Promise.resolve()).then(() => {
            if (cache.get(directory) === entry) cache.delete(directory)
          }, (error) => {
            entry.phase = "failed-cleanup"
            throw error
          })
          // The observer's budget never cancels the underlying close operation.
          yield* observeClose(entry.cleanup).pipe(
            Effect.catchCause(() => Effect.logWarning("failed instance cleanup remains owned", { directory })),
          )
        } else entry.phase = "ready"
        yield* Deferred.done(entry.deferred, exit).pipe(Effect.asVoid)
      })

    const emitDisposed = (input: { directory: string; project?: string }) =>
      Effect.sync(() =>
        GlobalBus.emit("event", {
          directory: input.directory,
          project: input.project,
          workspace: WorkspaceContext.workspaceID,
          payload: {
            type: "server.instance.disposed",
            properties: {
              directory: input.directory,
            },
          },
        }),
      )

    const disposeContext = Effect.fn("InstanceStore.disposeContext")(function* (ctx: InstanceContext) {
      yield* Effect.logInfo("disposing instance", { directory: ctx.directory, work: InstanceWork.pending(ctx) })
      yield* Effect.promise(() => InstanceWork.drain(ctx))
      yield* Effect.logInfo("instance work drained", InstanceWork.pending(ctx))
      yield* Effect.promise(() => runDisposers(ctx.directory, ctx))
      yield* emitDisposed({ directory: ctx.directory, project: ctx.project.id })
    })

    const closeEntry = (directory: string, entry: Entry, ctx: InstanceContext) => {
      if (entry.cleanup) return entry.cleanup
      entry.phase = "cleaning"
      entry.cleanup = runCleanup(disposeContext(ctx)).then(() => {
        if (cache.get(directory) === entry) cache.delete(directory)
      }, (error) => {
        entry.phase = "failed-cleanup"
        throw error
      })
      return entry.cleanup
    }
    const observations = new WeakMap<Promise<void>, Promise<void>>()
    const observeClose = (task: Promise<void>, ctx?: InstanceContext) => Effect.promise(() => {
      const previous = observations.get(task)
      if (previous) return previous
      const observed = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Instance cleanup is incomplete: ${JSON.stringify(ctx ? InstanceWork.pending(ctx) : {})}`)), 10_000)
        void task.then(() => { clearTimeout(timer); resolve() }, (error) => { clearTimeout(timer); reject(error) })
      })
      observations.set(task, observed)
      return observed
    })
    const disposeEntry = Effect.fnUntraced(function* (directory: string, entry: Entry, ctx: InstanceContext) {
      if (cache.get(directory) !== entry) return
      yield* observeClose(closeEntry(directory, entry, ctx), ctx).pipe(
        Effect.tapDefect(() => Effect.logWarning("instance cleanup remains incomplete", InstanceWork.pending(ctx))),
      )
    })

    const load = (input: LoadInput): Effect.Effect<InstanceContext, McpEditError> => {
      const directory = FSUtil.resolve(input.directory)
      return Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const existing = cache.get(directory)
          if (existing) {
            if (existing.cleanup) {
              const closed = yield* restore(observeClose(existing.cleanup)).pipe(Effect.exit)
              if (Exit.isFailure(closed) || cache.get(directory) === existing) {
                return yield* Effect.fail(new McpEditError({ code: "MCP_SOURCE_READ_FAILED", ref: crypto.randomUUID() }))
              }
              return yield* restore(load(input))
            }
            const ready = yield* restore(Deferred.await(existing.deferred)).pipe(Effect.exit)
            if (ready._tag === "Failure") {
              if (cache.get(directory) === existing) {
                return yield* Effect.fail(new McpEditError({ code: "MCP_SOURCE_READ_FAILED", ref: crypto.randomUUID() }))
              }
            } else {
              return ready.value
            }
          }

          const entry: Entry = { deferred: Deferred.makeUnsafe<InstanceContext, McpEditError>(), phase: "loading" }
          cache.set(directory, entry)
          yield* Effect.gen(function* () {
            yield* Effect.logInfo("creating instance", { directory: directory })
            yield* completeLoad(directory, input, entry)
          }).pipe(Effect.forkIn(scope, { startImmediately: true }))
          return yield* restore(Deferred.await(entry.deferred))
        }),
      ).pipe(Effect.withSpan("InstanceStore.load"))
    }

    const reload = (input: LoadInput): Effect.Effect<InstanceContext, McpEditError> => {
      const directory = FSUtil.resolve(input.directory)
      return Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const previous = cache.get(directory)
          if (previous?.replacing && previous.phase === "loading") return yield* restore(Deferred.await(previous.deferred))
          const entry: Entry = { deferred: Deferred.makeUnsafe<InstanceContext, McpEditError>(), phase: "loading", replacing: true }
          cache.set(directory, entry)
          yield* Effect.gen(function* () {
            yield* Effect.logInfo("reloading instance", { directory: directory })
            if (previous) {
              const ready = yield* Deferred.await(previous.deferred).pipe(Effect.exit)
              const cleanup = previous.cleanup ?? (Exit.isSuccess(ready) ? closeEntry(directory, previous, ready.value) : Promise.resolve())
              const closed = yield* observeClose(cleanup).pipe(Effect.exit)
              if (Exit.isFailure(closed)) {
                entry.phase = "failed-cleanup"
                entry.cleanup = cleanup.then(() => { if (cache.get(directory) === entry) cache.delete(directory) })
                void entry.cleanup.catch(() => undefined)
                yield* Deferred.fail(entry.deferred, new McpEditError({ code: "MCP_SOURCE_READ_FAILED", ref: crypto.randomUUID() }))
                return
              }
            }
            yield* completeLoad(directory, input, entry)
          }).pipe(Effect.forkIn(scope, { startImmediately: true }))
          return yield* restore(Deferred.await(entry.deferred))
        }),
      ).pipe(Effect.withSpan("InstanceStore.reload"))
    }

    const dispose = Effect.fn("InstanceStore.dispose")(function* (ctx: InstanceContext) {
      const entry = cache.get(ctx.directory)
      if (!entry) return yield* disposeContext(ctx)

      const exit = yield* Deferred.await(entry.deferred).pipe(Effect.exit)
      if (Exit.isFailure(exit)) {
        if (entry.cleanup) yield* observeClose(entry.cleanup)
        return
      }
      if (exit.value !== ctx) return
      yield* disposeEntry(ctx.directory, entry, ctx).pipe(Effect.asVoid)
    })

    const disposeDirectory = Effect.fn("InstanceStore.disposeDirectory")(function* (input: string) {
      const directory = FSUtil.resolve(input)
      const entry = cache.get(directory)
      if (!entry) return
      const exit = yield* Deferred.await(entry.deferred).pipe(Effect.exit)
      if (Exit.isFailure(exit)) {
        if (entry.cleanup) yield* observeClose(entry.cleanup)
        return
      }
      yield* disposeEntry(directory, entry, exit.value).pipe(Effect.asVoid)
    })

    const disposeAllOnce = Effect.fnUntraced(function* () {
      yield* Effect.logInfo("disposing all instances")
      yield* Effect.forEach(
        [...cache.entries()],
        (item) =>
          Effect.gen(function* () {
            const exit = yield* Deferred.await(item[1].deferred).pipe(Effect.exit)
            if (Exit.isFailure(exit)) {
              yield* Effect.logWarning("instance dispose failed", { key: item[0], cause: exit.cause })
              if (item[1].cleanup) yield* observeClose(item[1].cleanup)
              return
            }
            yield* disposeEntry(item[0], item[1], exit.value)
          }),
        { discard: true },
      )
    })

    const cachedDisposeAll = yield* Effect.cachedWithTTL(disposeAllOnce(), Duration.zero)
    const disposeAll = Effect.fn("InstanceStore.disposeAll")(function* () {
      return yield* cachedDisposeAll
    })

    const provide = <A, E, R>(input: LoadInput, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      load(input).pipe(
        Effect.mapError((error) => error as E),
        Effect.flatMap((ctx) => effect.pipe(Effect.provideService(InstanceRef, ctx))),
      )

    const stopReload = onConfigReload((directory, owner) => {
      const wanted = directory
        ? new Set([directory, FSUtil.resolve(directory), path.resolve(directory)])
        : undefined
      const matched = [...cache.entries()].filter(([key, entry]) => {
        if (owner && entry.ctx !== owner) return false
        if (!wanted) return true
        return wanted.has(key) || wanted.has(FSUtil.resolve(key)) || wanted.has(path.resolve(key))
      })
      return Effect.runPromise(
        Effect.forEach(
          matched,
          ([key, entry]) =>
            Deferred.await(entry.deferred).pipe(
              Effect.flatMap((ctx) => disposeEntry(key, entry, ctx)),
              Effect.asVoid,
            ),
          { discard: true },
        ),
      )
    }, { idempotent: true })
    yield* Effect.addFinalizer(() => Effect.sync(stopReload))
    yield* Effect.addFinalizer(() => disposeAll())

    return Service.of({
      load,
      reload,
      dispose,
      disposeDirectory,
      disposeAll,
      provide,
    })
  }),
)

export const bootstrapNode = LayerNode.unbound(InstanceBootstrap.Service, Node.tags.values.global)

export const node = makeGlobalNode({
  service: Service,
  layer: layer,
  deps: [Project.node, bootstrapNode],
})

export * as InstanceStore from "./instance-store"
