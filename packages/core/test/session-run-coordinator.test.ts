import { describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { SessionRunCoordinator } from "@opencode-ai/core/session/run-coordinator"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

describe("SessionRunCoordinator", () => {
  it.live("settles every joined resume waiter when the owner is interrupted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        })
        const first = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* Deferred.await(started)
        const joined = yield* Effect.all(
          Array.from({ length: 3 }, () =>
            coordinator.run("session").pipe(Effect.forkChild({ startImmediately: true })),
          ),
        )
        yield* coordinator.interrupt("session")
        const exits = yield* Effect.all([first, ...joined].map((fiber) => Fiber.await(fiber))).pipe(
          Effect.timeout("5 seconds"),
        )
        expect(exits).toHaveLength(4)
        expect(exits.every((exit) => Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause))).toBe(true)
        expect(yield* coordinator.active).toEqual(new Set())
      }),
    ),
  )

  it.effect("does not interrupt an active drain or start another drain just by taking a barrier", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const finish = yield* Deferred.make<void>()
        let runs = 0
        let interrupted = false
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () =>
            Effect.sync(() => {
              runs++
            }).pipe(
              Effect.andThen(Deferred.succeed(started, undefined)),
              Effect.andThen(Deferred.await(finish)),
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  interrupted = true
                }),
              ),
            ),
        })
        const resumed = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* Deferred.await(started)
        expect(yield* coordinator.withBarrier("session")(Effect.succeed("rechecked"))).toBe("rechecked")
        expect(interrupted).toBe(false)
        expect(runs).toBe(1)
        yield* Deferred.succeed(finish, undefined)
        yield* Fiber.join(resumed)
        expect(runs).toBe(1)
      }),
    ),
  )

  it.effect("joins a synchronous wake drain when releasing waiting resumes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const forces: boolean[] = []
        const coordinator = yield* SessionRunCoordinator.make<string, never>({
          drain: (_key, force) =>
            Effect.sync(() => {
              forces.push(force)
            }),
        })
        const mutation = yield* coordinator
          .withBarrier("session")(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))))
          .pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        const resumed = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* coordinator.wake("session")
        yield* Deferred.succeed(release, undefined)
        yield* Effect.all([Fiber.join(mutation), Fiber.join(resumed)])
        expect(forces).toEqual([false])
      }),
    ),
  )

  it.effect("retains explicit resume semantics when no wake was registered behind a barrier", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const forces: boolean[] = []
        const coordinator = yield* SessionRunCoordinator.make<string, never>({
          drain: (_key, force) =>
            Effect.sync(() => {
              forces.push(force)
            }),
        })
        const mutation = yield* coordinator
          .withBarrier("session")(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))))
          .pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        const resumed = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* Effect.yieldNow
        expect(forces).toEqual([])
        yield* Deferred.succeed(release, undefined)
        yield* Effect.all([Fiber.join(mutation), Fiber.join(resumed)])
        expect(forces).toEqual([true])
      }),
    ),
  )

  it.effect("cancelled mutation and resume waiters do not release the current barrier or start work", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        let mutations = 0
        let runs = 0
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () =>
            Effect.sync(() => {
              runs++
            }),
        })
        const owner = yield* coordinator
          .withBarrier("session")(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))))
          .pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        const mutation = yield* coordinator
          .withBarrier("session")(
            Effect.sync(() => {
              mutations++
            }),
          )
          .pipe(Effect.forkChild)
        const resumed = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* Fiber.interrupt(mutation)
        yield* Fiber.interrupt(resumed)
        yield* Effect.yieldNow
        expect(mutations).toBe(0)
        expect(runs).toBe(0)
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(owner)
        expect(runs).toBe(0)
        yield* coordinator.withBarrier("session")(
          Effect.sync(() => {
            mutations++
          }),
        )
        yield* coordinator.run("session")
        expect(mutations).toBe(1)
        expect(runs).toBe(1)
      }),
    ),
  )

  it.effect("preserves an advisory wake when the mutation fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const forces: boolean[] = []
        const coordinator = yield* SessionRunCoordinator.make<string, never>({
          drain: (_key, force) =>
            Effect.sync(() => {
              forces.push(force)
            }).pipe(Effect.andThen(Deferred.succeed(started, undefined))),
        })
        const exit = yield* coordinator
          .withBarrier("session")(coordinator.wake("session").pipe(Effect.andThen(Effect.fail("mutation failed"))))
          .pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        yield* Deferred.await(started)
        expect(forces).toEqual([false])
      }),
    ),
  )

  it.effect("holds idle resumes and coalesces wakes until a mutation releases its barrier", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const started = yield* Deferred.make<void>()
        const finish = yield* Deferred.make<void>()
        const forces: boolean[] = []
        const coordinator = yield* SessionRunCoordinator.make<string, never>({
          drain: (_key, force) =>
            Effect.sync(() => forces.push(force)).pipe(
              Effect.andThen(Deferred.succeed(started, undefined)),
              Effect.andThen(Deferred.await(finish)),
            ),
        })
        const mutation = yield* coordinator
          .withBarrier("session")(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))))
          .pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        const resumed = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* coordinator.wake("session")
        yield* coordinator.wake("session")
        yield* Effect.yieldNow
        expect(forces).toEqual([])
        expect(Array.from(yield* coordinator.active)).toEqual([])

        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(mutation)
        yield* Deferred.await(started)
        yield* Deferred.succeed(finish, undefined)
        yield* Fiber.join(resumed)
        expect(forces).toEqual([false])
      }),
    ),
  )

  it.effect("serializes same-key mutations without blocking another key", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const order: string[] = []
        const coordinator = yield* SessionRunCoordinator.make({
          drain: (key: string) =>
            Effect.sync(() => {
              order.push(`drain:${key}`)
            }),
        })
        const first = yield* coordinator
          .withBarrier("session")(
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(
                Effect.sync(() => {
                  order.push("first")
                }),
              ),
            ),
          )
          .pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        const second = yield* coordinator
          .withBarrier("session")(
            Effect.sync(() => {
              order.push("second")
            }),
          )
          .pipe(Effect.forkChild)
        yield* coordinator.withBarrier("other")(coordinator.run("independent"))
        expect(order).toEqual(["drain:independent"])
        yield* Deferred.succeed(release, undefined)
        yield* Effect.all([Fiber.join(first), Fiber.join(second)])
        expect(order).toEqual(["drain:independent", "first", "second"])
      }),
    ),
  )

  it.effect("allows active cleanup to finish but holds its successor during mutation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const cleanup = yield* Deferred.make<void>()
        const cleaned = yield* Deferred.make<void>()
        const releaseCleanup = yield* Deferred.make<void>()
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const successor = yield* Deferred.make<void>()
        let runs = 0
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () =>
            Effect.suspend(() => {
              runs++
              if (runs > 1) return Deferred.succeed(successor, undefined)
              return Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.onInterrupt(() =>
                  Deferred.succeed(cleanup, undefined).pipe(Effect.andThen(Deferred.await(releaseCleanup))),
                ),
              )
            }),
        })
        yield* coordinator.wake("session")
        yield* Deferred.await(started)
        const mutation = yield* coordinator
          .withBarrier("session")(
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(coordinator.interrupt("session")),
              Effect.andThen(Deferred.succeed(cleaned, undefined)),
              Effect.andThen(Deferred.await(release)),
            ),
          )
          .pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        yield* Deferred.await(cleanup)
        yield* coordinator.wake("session")
        yield* Deferred.succeed(releaseCleanup, undefined)
        yield* Deferred.await(cleaned)
        expect(runs).toBe(1)
        expect(Array.from(yield* coordinator.active)).toEqual([])
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(mutation)
        yield* Deferred.await(successor)
        expect(runs).toBe(2)
      }),
    ),
  )

  it.effect("defers a naturally completing drain's pending wake without holding its joined waiter", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const finish = yield* Deferred.make<void>()
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const successor = yield* Deferred.make<void>()
        let runs = 0
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () =>
            Effect.suspend(() =>
              ++runs === 1
                ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(finish)))
                : Deferred.succeed(successor, undefined),
            ),
        })
        const resumed = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* Deferred.await(started)
        yield* coordinator.wake("session")
        const mutation = yield* coordinator
          .withBarrier("session")(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))))
          .pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        yield* Deferred.succeed(finish, undefined)
        yield* Fiber.join(resumed)
        expect(runs).toBe(1)
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(mutation)
        yield* Deferred.await(successor)
        expect(runs).toBe(2)
      }),
    ),
  )

  it.effect("releases barriers after failure, defect and interruption without starting work by itself", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let runs = 0
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () =>
            Effect.sync(() => {
              runs++
            }),
        })
        yield* coordinator.withBarrier("session")(Effect.fail("failure")).pipe(Effect.exit)
        yield* coordinator.withBarrier("session")(Effect.die("defect")).pipe(Effect.exit)
        const entered = yield* Deferred.make<void>()
        const mutation = yield* coordinator
          .withBarrier("session")(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)))
          .pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        yield* Fiber.interrupt(mutation)
        expect(runs).toBe(0)
        yield* coordinator.run("session")
        expect(runs).toBe(1)
      }),
    ),
  )

  it.effect("joins concurrent resumes for one key", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>()
        let runs = 0
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () => Effect.sync(() => runs++).pipe(Effect.andThen(Deferred.await(gate))),
        })

        const first = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* Effect.yieldNow
        const second = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* Effect.yieldNow

        expect(runs).toBe(1)
        yield* Deferred.succeed(gate, undefined)
        yield* Effect.all([Fiber.join(first), Fiber.join(second)])
        expect(runs).toBe(1)
      }),
    ),
  )

  it.effect("joins a wake-started execution without forcing a successor", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const gate = yield* Deferred.make<void>()
        const forces: boolean[] = []
        const coordinator = yield* SessionRunCoordinator.make<string, never>({
          drain: (_key, force) =>
            Effect.sync(() => forces.push(force)).pipe(
              Effect.andThen(Deferred.succeed(started, undefined)),
              Effect.andThen(Deferred.await(gate)),
            ),
        })

        yield* coordinator.wake("session")
        yield* Deferred.await(started)
        const resumed = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* Deferred.succeed(gate, undefined)
        yield* Fiber.join(resumed)

        expect(forces).toEqual([false])
      }),
    ),
  )

  it.effect("starts execution when woken while idle", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const drained = yield* Deferred.make<void>()
        const coordinator = yield* SessionRunCoordinator.make({ drain: () => Deferred.succeed(drained, undefined) })

        yield* coordinator.wake("session")
        yield* Deferred.await(drained)
      }),
    ),
  )

  it.effect("snapshots only active executions", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>()
        const secondStarted = yield* Deferred.make<void>()
        const firstGate = yield* Deferred.make<void>()
        const secondGate = yield* Deferred.make<void>()
        const coordinator = yield* SessionRunCoordinator.make({
          drain: (key: string) =>
            Deferred.succeed(key === "first" ? firstStarted : secondStarted, undefined).pipe(
              Effect.andThen(Deferred.await(key === "first" ? firstGate : secondGate)),
            ),
        })

        expect(Array.from(yield* coordinator.active)).toEqual([])
        const first = yield* coordinator.run("first").pipe(Effect.forkChild)
        yield* Deferred.await(firstStarted)
        expect(Array.from(yield* coordinator.active)).toEqual(["first"])

        const second = yield* coordinator.run("second").pipe(Effect.forkChild)
        yield* Deferred.await(secondStarted)
        expect(Array.from(yield* coordinator.active)).toEqual(["first", "second"])

        yield* Deferred.succeed(firstGate, undefined)
        yield* Fiber.join(first)
        expect(Array.from(yield* coordinator.active)).toEqual(["second"])
        yield* Deferred.succeed(secondGate, undefined)
        yield* Fiber.join(second)
        expect(Array.from(yield* coordinator.active)).toEqual([])
      }),
    ),
  )

  it.effect("cleans active executions after failure and defect", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const failure = new Error("failed")
        const defect = new Error("defect")
        const coordinator = yield* SessionRunCoordinator.make({
          drain: (key: string) => (key === "failure" ? Effect.fail(failure) : Effect.die(defect)),
        })

        const failed = yield* coordinator.run("failure").pipe(Effect.exit)
        expect(Exit.isFailure(failed) && Cause.hasFails(failed.cause)).toBeTrue()
        expect(Array.from(yield* coordinator.active)).toEqual([])

        const died = yield* coordinator.run("defect").pipe(Effect.exit)
        expect(Exit.isFailure(died) && Cause.hasDies(died.cause)).toBeTrue()
        expect(Array.from(yield* coordinator.active)).toEqual([])
      }),
    ),
  )

  it.effect("cleans active executions when its scope closes", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const coordinator = yield* Effect.scoped(
        Effect.gen(function* () {
          const coordinator = yield* SessionRunCoordinator.make({
            drain: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
          })
          yield* coordinator.wake("session")
          yield* Deferred.await(started)
          expect(Array.from(yield* coordinator.active)).toEqual(["session"])
          return coordinator
        }),
      )

      expect(Array.from(yield* coordinator.active)).toEqual([])
    }),
  )

  it.effect("coalesces wakes received during active execution", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>()
        const firstGate = yield* Deferred.make<void>()
        const secondStarted = yield* Deferred.make<void>()
        let runs = 0
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () =>
            Effect.sync(() => ++runs).pipe(
              Effect.flatMap((run) =>
                run === 1
                  ? Deferred.succeed(firstStarted, undefined).pipe(Effect.andThen(Deferred.await(firstGate)))
                  : Deferred.succeed(secondStarted, undefined),
              ),
            ),
        })

        const resumed = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* Deferred.await(firstStarted)
        yield* Effect.all([coordinator.wake("session"), coordinator.wake("session"), coordinator.wake("session")], {
          concurrency: "unbounded",
        })
        yield* Deferred.succeed(firstGate, undefined)
        yield* Deferred.await(secondStarted)
        yield* Fiber.join(resumed)

        expect(runs).toBe(2)
      }),
    ),
  )

  it.effect("runs again when woken during the follow-up", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstGate = yield* Deferred.make<void>()
        const secondStarted = yield* Deferred.make<void>()
        const secondGate = yield* Deferred.make<void>()
        const thirdStarted = yield* Deferred.make<void>()
        let runs = 0
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () =>
            Effect.sync(() => ++runs).pipe(
              Effect.flatMap((run) =>
                run === 1
                  ? Deferred.await(firstGate)
                  : run === 2
                    ? Deferred.succeed(secondStarted, undefined).pipe(Effect.andThen(Deferred.await(secondGate)))
                    : Deferred.succeed(thirdStarted, undefined),
              ),
            ),
        })

        const resumed = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* coordinator.wake("session")
        yield* Deferred.succeed(firstGate, undefined)
        yield* Deferred.await(secondStarted)
        yield* coordinator.wake("session")
        yield* Deferred.succeed(secondGate, undefined)
        yield* Deferred.await(thirdStarted)
        yield* Fiber.join(resumed)

        expect(runs).toBe(3)
      }),
    ),
  )

  it.effect("does nothing when interrupted while idle", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const coordinator = yield* SessionRunCoordinator.make({ drain: () => Effect.void })
        yield* coordinator.interrupt("session")
      }),
    ),
  )

  it.effect("interrupts active execution and clears its pending wake", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const interrupted = yield* Deferred.make<void>()
        let runs = 0
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () =>
            Effect.sync(() => ++runs).pipe(
              Effect.andThen(Deferred.succeed(started, undefined)),
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
            ),
        })

        const resumed = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* Deferred.await(started)
        yield* coordinator.wake("session")
        yield* coordinator.interrupt("session")
        yield* Deferred.await(interrupted)

        const exit = yield* Fiber.await(resumed)
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBeTrue()
        expect(Array.from(yield* coordinator.active)).toEqual([])
        expect(runs).toBe(1)
      }),
    ),
  )

  it.effect("runs a wake registered during interruption cleanup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>()
        const cleanupStarted = yield* Deferred.make<void>()
        const cleanupGate = yield* Deferred.make<void>()
        const secondStarted = yield* Deferred.make<void>()
        let runs = 0
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () =>
            Effect.sync(() => ++runs).pipe(
              Effect.flatMap((run) =>
                run === 1
                  ? Deferred.succeed(firstStarted, undefined).pipe(
                      Effect.andThen(Effect.never),
                      Effect.onInterrupt(() =>
                        Deferred.succeed(cleanupStarted, undefined).pipe(Effect.andThen(Deferred.await(cleanupGate))),
                      ),
                    )
                  : Deferred.succeed(secondStarted, undefined),
              ),
            ),
        })

        yield* coordinator.wake("session")
        yield* Deferred.await(firstStarted)
        const interrupt = yield* coordinator.interrupt("session").pipe(Effect.forkChild)
        yield* Deferred.await(cleanupStarted)
        yield* coordinator.wake("session")
        yield* Deferred.succeed(cleanupGate, undefined)
        yield* Fiber.join(interrupt)
        yield* Deferred.await(secondStarted)

        expect(runs).toBe(2)
      }),
    ),
  )

  it.effect("starts a resume registered during interruption cleanup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>()
        const cleanupStarted = yield* Deferred.make<void>()
        const cleanupGate = yield* Deferred.make<void>()
        const secondStarted = yield* Deferred.make<void>()
        const forces: boolean[] = []
        const coordinator = yield* SessionRunCoordinator.make<string, never>({
          drain: (_key, force) => {
            forces.push(force)
            return forces.length === 1
              ? Deferred.succeed(firstStarted, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.onInterrupt(() =>
                    Deferred.succeed(cleanupStarted, undefined).pipe(Effect.andThen(Deferred.await(cleanupGate))),
                  ),
                )
              : Deferred.succeed(secondStarted, undefined)
          },
        })

        yield* coordinator.wake("session")
        yield* Deferred.await(firstStarted)
        const interrupt = yield* coordinator.interrupt("session").pipe(Effect.forkChild)
        yield* Deferred.await(cleanupStarted)
        const resumed = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* Deferred.succeed(cleanupGate, undefined)
        yield* Effect.all([Fiber.join(interrupt), Fiber.join(resumed)])
        yield* Deferred.await(secondStarted)

        expect(forces).toEqual([false, true])
      }),
    ),
  )

  it.effect("starts one follow-up when a wake races with failure", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>()
        const secondStarted = yield* Deferred.make<void>()
        const failure = new Error("failed")
        let runs = 0
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () =>
            Effect.sync(() => ++runs).pipe(
              Effect.flatMap((run) =>
                run === 1
                  ? Deferred.await(gate).pipe(Effect.andThen(Effect.fail(failure)))
                  : Deferred.succeed(secondStarted, undefined),
              ),
            ),
        })

        const resumed = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* coordinator.wake("session")
        yield* Deferred.succeed(gate, undefined)

        expect(yield* Fiber.join(resumed).pipe(Effect.flip)).toBe(failure)
        yield* Deferred.await(secondStarted)
        expect(runs).toBe(2)
      }),
    ),
  )

  it.effect("does not cancel execution when a joined waiter is interrupted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>()
        let runs = 0
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () => Effect.sync(() => runs++).pipe(Effect.andThen(Deferred.await(gate))),
        })

        const first = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* Effect.yieldNow
        const second = yield* coordinator.run("session").pipe(Effect.forkChild)
        yield* Fiber.interrupt(second)
        yield* Deferred.succeed(gate, undefined)
        yield* Fiber.join(first)

        expect(runs).toBe(1)
      }),
    ),
  )

  it.effect("runs different keys concurrently", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>()
        const bothStarted = yield* Deferred.make<void>()
        let active = 0
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () =>
            Effect.sync(() => ++active).pipe(
              Effect.tap(() => (active === 2 ? Deferred.succeed(bothStarted, undefined) : Effect.void)),
              Effect.andThen(Deferred.await(gate)),
            ),
        })

        const first = yield* coordinator.run("first").pipe(Effect.forkChild)
        const second = yield* coordinator.run("second").pipe(Effect.forkChild)
        yield* Deferred.await(bothStarted)
        yield* Deferred.succeed(gate, undefined)
        yield* Effect.all([Fiber.join(first), Fiber.join(second)])
      }),
    ),
  )

  it.effect("trampolines synchronous self-waking execution", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const limit = 20_000
        const completed = yield* Deferred.make<void>()
        let runs = 0
        let wake: (key: string) => Effect.Effect<void> = () => Effect.void
        const coordinator = yield* SessionRunCoordinator.make<string, never>({
          drain: (key) =>
            Effect.sync(() => ++runs).pipe(
              Effect.tap((run) => (run < limit ? wake(key) : Deferred.succeed(completed, undefined))),
              Effect.asVoid,
            ),
        })
        wake = coordinator.wake

        yield* coordinator.wake("session")
        yield* Deferred.await(completed)

        expect(runs).toBe(limit)
      }),
    ),
  )
})
