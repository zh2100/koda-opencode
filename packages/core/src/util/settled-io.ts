import { Cause, Effect, Exit } from "effect"

// An interrupt cannot revoke a filesystem or credential Promise already dispatched.
// Capture failure while masked as well: restoring a failing effect directly can
// let a catch handler start fallback work before the pending interrupt is observed.
// Opt-in boundary for an already dispatched, irrevocable IO effect. Existing drain callers keep their behavior.
export function drainWithCause<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return Effect.uninterruptibleMask((restore) => {
    const dispatched = Promise.withResolvers<Exit.Exit<A, E>>()
    return restore(Effect.void).pipe(
      Effect.andThen(Effect.context<R>()),
      Effect.flatMap((context) => Effect.sync(() => {
        // Detach the already admitted effect so a parent interrupt cannot replace its exit.
        Effect.runFork(effect.pipe(
          Effect.provideContext(context),
          Effect.exit,
          Effect.tap((exit) => Effect.sync(() => dispatched.resolve(exit))),
        ))
      })),
      Effect.andThen(Effect.promise(() => dispatched.promise)),
      Effect.flatMap((exit) => restore(Effect.void).pipe(
        Effect.exit,
        Effect.flatMap((restored) => {
          if (Exit.isSuccess(restored)) return exit
          if (Exit.isSuccess(exit)) return restored
          return Effect.failCause(Cause.combine(exit.cause, restored.cause))
        }),
      )),
    )
  })
}

export function drain<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return Effect.uninterruptibleMask((restore) =>
    restore(Effect.void).pipe(
      Effect.andThen(Effect.exit(effect)),
      Effect.flatMap((exit) => restore(Effect.void).pipe(Effect.andThen(exit))),
    ),
  )
}

// Effect.onExit replaces a failed body's cause when its finalizer fails. Preserve
// both the interrupt/body failure and the safe cleanup error instead.
export function ensuring<E2, R2>(cleanup: Effect.Effect<void, E2, R2>) {
  return onExit(() => cleanup)
}

export function onExit<E2, R2>(cleanup: (exit: Exit.Exit<unknown, unknown>) => Effect.Effect<void, E2, R2>) {
  return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.onExit((exit) =>
        cleanup(exit).pipe(
          Effect.catchCause((cause) =>
            Effect.failCause<E | E2>(Exit.isFailure(exit) ? Cause.combine(exit.cause, cause) : cause),
          ),
        ),
      ),
    )
}

export * as SettledIO from "./settled-io"
