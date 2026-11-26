export * as SessionRunCoordinator from "./run-coordinator"

import { Deferred, Effect, Exit, Fiber, FiberSet, Scope } from "effect"
import { KeyedMutex } from "../effect/keyed-mutex"

/** Serializes execution for each key while allowing different keys to run concurrently. */
export interface Coordinator<Key, E> {
  /** Snapshots keys with an execution owned by this coordinator. */
  readonly active: Effect.Effect<ReadonlySet<Key>>
  /** Starts execution while idle or joins the active execution. */
  readonly run: (key: Key) => Effect.Effect<void, E>
  /** Registers one coalesced follow-up after newly recorded work. */
  readonly wake: (key: Key) => Effect.Effect<void>
  /** Stops active execution and waits for its cleanup. */
  readonly interrupt: (key: Key) => Effect.Effect<void>
  /** Serializes short mutations and prevents new drains; active cleanup can still finish. Not reentrant. */
  readonly withBarrier: (key: Key) => <A, E2, R>(effect: Effect.Effect<A, E2, R>) => Effect.Effect<A, E2, R>
}

type Entry<E> = {
  readonly done: Deferred.Deferred<Exit.Exit<void, E>>
  owner?: Fiber.Fiber<void, never>
  pendingWake: boolean
  stopping: boolean
}

export const make = <Key, E>(options: {
  readonly drain: (key: Key, force: boolean) => Effect.Effect<void, E>
}): Effect.Effect<Coordinator<Key, E>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const active = new Map<Key, Entry<E>>()
    const barriers = new Map<Key, { readonly done: Deferred.Deferred<void>; pendingWake: boolean }>()
    const mutations = yield* KeyedMutex.make<Key>()
    const fork = yield* FiberSet.makeRuntime<never, void, never>()

    const drain = (key: Key, force: boolean): Effect.Effect<void, E> =>
      Effect.suspend(() => {
        const barrier = barriers.get(key)
        if (barrier) return Deferred.await(barrier.done).pipe(Effect.andThen(drain(key, force)))
        return options.drain(key, force)
      })

    const makeEntry = (): Entry<E> => ({
      done: Deferred.makeUnsafe<Exit.Exit<void, E>>(),
      pendingWake: false,
      stopping: false,
    })

    // Deliver interruption as a value first. Resuming a Deferred directly with an interrupt
    // can synchronously remove a waiter while Effect walks its live listener array.
    const awaitEntry = (entry: Entry<E>) => Deferred.await(entry.done).pipe(Effect.flatMap((exit) => exit))

    const start = (key: Key, entry: Entry<E>, force: boolean, successor = false) => {
      const ready = Deferred.makeUnsafe<void>()
      const owner = fork(
        (successor ? Effect.yieldNow : Deferred.await(ready)).pipe(
          Effect.andThen(drain(key, force)),
          Effect.onExit((exit) => Effect.sync(() => settle(key, entry, exit))),
          Effect.exit,
          Effect.asVoid,
        ),
      )
      entry.owner = owner
      if (!successor) Deferred.doneUnsafe(ready, Effect.void)
    }

    const settle = (key: Key, entry: Entry<E>, exit: Exit.Exit<void, E>) => {
      const barrier = barriers.get(key)
      if (barrier) {
        barrier.pendingWake ||= entry.pendingWake
        active.delete(key)
        Deferred.doneUnsafe(entry.done, Effect.succeed(exit))
        return
      }
      if (Exit.isSuccess(exit) && !entry.stopping && entry.pendingWake) {
        entry.pendingWake = false
        start(key, entry, false, true)
        return
      }

      const successor = entry.pendingWake ? makeEntry() : undefined
      if (successor === undefined) active.delete(key)
      else {
        active.set(key, successor)
        start(key, successor, false, true)
      }
      Deferred.doneUnsafe(entry.done, Effect.succeed(exit))
    }

    const run = (key: Key): Effect.Effect<void, E> =>
      Effect.uninterruptibleMask((restore) => {
        const barrier = barriers.get(key)
        if (barrier) return restore(Deferred.await(barrier.done).pipe(Effect.andThen(run(key))))
        const entry = active.get(key)
        if (entry !== undefined) {
          if (entry.stopping) return restore(awaitEntry(entry).pipe(Effect.andThen(run(key))))
          return restore(awaitEntry(entry))
        }

        const next = makeEntry()
        active.set(key, next)
        start(key, next, true)
        return restore(awaitEntry(next))
      })

    const wake = (key: Key) =>
      Effect.sync(() => {
        const barrier = barriers.get(key)
        if (barrier) {
          barrier.pendingWake = true
          return
        }
        const entry = active.get(key)
        if (entry !== undefined) {
          entry.pendingWake = true
          return
        }

        const next = makeEntry()
        active.set(key, next)
        start(key, next, false)
      })

    const interrupt = (key: Key): Effect.Effect<void> =>
      Effect.suspend(() => {
        const entry = active.get(key)
        if (entry?.owner === undefined) return Effect.void
        entry.stopping = true
        entry.pendingWake = false
        return Fiber.interrupt(entry.owner)
      })

    const withBarrier =
      (key: Key) =>
      <A, E2, R>(effect: Effect.Effect<A, E2, R>) =>
        mutations.withLock(key)(
          Effect.acquireUseRelease(
            Effect.sync(() => {
              const barrier = { done: Deferred.makeUnsafe<void>(), pendingWake: false }
              barriers.set(key, barrier)
              return barrier
            }),
            () => effect,
            (barrier) =>
              Effect.sync(() => {
                const entry = active.get(key)
                const next = barrier.pendingWake && !entry ? makeEntry() : undefined
                // Reserve the successor before waking resume waiters, even if its drain completes synchronously.
                if (next) active.set(key, next)
                if (barrier.pendingWake && entry) entry.pendingWake = true
                barriers.delete(key)
                Deferred.doneUnsafe(barrier.done, Effect.void)
                if (next) start(key, next, false)
              }),
          ),
        )

    return { active: Effect.sync(() => new Set(active.keys())), run, wake, interrupt, withBarrier }
  })
