import { InstanceWork } from "./instance-work"
import { Effect, ScopedCache, Scope } from "effect"
import type { InstanceContext } from "@/project/instance-context"
import { InstanceRef, WorkspaceRef } from "./instance-ref"
import { registerDisposer } from "./instance-registry"
import { WorkspaceContext } from "@/control-plane/workspace-context"

const TypeId = "~opencode/InstanceState"

export interface InstanceState<A, E = never, R = never> {
  readonly [TypeId]: typeof TypeId
  readonly cache: ScopedCache.ScopedCache<string, A, E, R>
  readonly invalidateOwned: (ctx: InstanceContext) => Effect.Effect<void>
}

export const context = Effect.gen(function* () {
  const ctx = yield* InstanceRef
  if (!ctx) return yield* Effect.die(new Error("InstanceRef not provided"))
  return ctx
})

export const workspaceID = Effect.gen(function* () {
  return (yield* WorkspaceRef) ?? WorkspaceContext.workspaceID
})

export const directory = Effect.map(context, (ctx) => ctx.directory)

export const make = <A, E = never, R = never>(
  init: (ctx: InstanceContext) => Effect.Effect<A, E, R | Scope.Scope>,
): Effect.Effect<InstanceState<A, E, Exclude<R, Scope.Scope>>, never, R | Scope.Scope> =>
  Effect.gen(function* () {
    const owners = new Map<string, InstanceContext>()
    const closing = new Map<string, Promise<void>>()
    const cache = yield* ScopedCache.make<string, A, E, R>({
      capacity: Number.POSITIVE_INFINITY,
      lookup: () =>
        Effect.gen(function* () {
          const ctx = yield* context
          owners.set(ctx.directory, ctx)
          return yield* init(ctx)
        }),
    })

    const off = registerDisposer((directory, owner) => {
      if (owner && owners.get(directory) !== owner) return Promise.resolve()
      const previous = closing.get(directory)
      if (previous) return previous
      const task = Effect.runPromise(ScopedCache.invalidate(cache, directory)).then(() => {
        owners.delete(directory)
        closing.delete(directory)
      })
      closing.set(directory, task)
      return task
    }, { owned: true })
    yield* Effect.addFinalizer(() => Effect.sync(off))

    return {
      [TypeId]: TypeId,
      cache,
      invalidateOwned: (ctx) => Effect.suspend(() => owners.get(ctx.directory) === ctx ? ScopedCache.invalidate(cache, ctx.directory) : Effect.void),
    }
  })

export const get = <A, E, R>(self: InstanceState<A, E, R>) =>
  Effect.gen(function* () {
    const ctx = yield* context
    InstanceWork.assertReadable(ctx, yield* InstanceWork.WorkPermit)
    return yield* ScopedCache.get(self.cache, ctx.directory)
  })

export const use = <A, E, R, B>(self: InstanceState<A, E, R>, select: (value: A) => B) => Effect.map(get(self), select)

export const useEffect = <A, E, R, B, E2, R2>(
  self: InstanceState<A, E, R>,
  select: (value: A) => Effect.Effect<B, E2, R2>,
) => Effect.flatMap(get(self), select)

export const has = <A, E, R>(self: InstanceState<A, E, R>) =>
  Effect.gen(function* () {
    const ctx = yield* context
    InstanceWork.assertReadable(ctx, yield* InstanceWork.WorkPermit)
    return yield* ScopedCache.has(self.cache, ctx.directory)
  })

export const invalidate = <A, E, R>(self: InstanceState<A, E, R>) =>
  Effect.gen(function* () {
    const ctx = yield* context
    InstanceWork.assertReadable(ctx, yield* InstanceWork.WorkPermit)
    return yield* ScopedCache.invalidate(self.cache, ctx.directory)
  })

// A committed handoff may outlive request/instance admission. It can only retire
// the cache owned by its captured context, never a replacement with the same path.
export const invalidateOwned = <A, E, R>(self: InstanceState<A, E, R>, ctx: InstanceContext) => self.invalidateOwned(ctx)

export const invalidateAll = <A, E, R>(self: InstanceState<A, E, R>) => ScopedCache.invalidateAll(self.cache)

export * as InstanceState from "./instance-state"
