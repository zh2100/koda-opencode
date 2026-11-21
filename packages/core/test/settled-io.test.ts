import { expect, test } from "bun:test"
import { Cause, Effect, Exit, Fiber } from "effect"
import { SettledIO } from "../src/util/settled-io"

test("drainWithCause keeps an interrupt together with a failed irrevocable effect", async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const fiber = Effect.runFork(
    Effect.gen(function* () {
      yield* Effect.promise(async () => {
        entered.resolve()
        await release.promise
      })
      return yield* Effect.fail(new Error("secret-token"))
    }).pipe(SettledIO.drainWithCause),
  )
  await entered.promise
  Effect.runFork(Fiber.interrupt(fiber))
  await Effect.runPromise(
    Effect.promise(async () => {
      const started = Date.now()
      while (!(fiber as { _interruptedCause?: unknown })._interruptedCause) {
        if (Date.now() - started > 2000) throw new Error("interrupt was not observed")
        await Bun.sleep(1)
      }
    }),
  )
  release.resolve()
  const exit = await Fiber.await(fiber).pipe(Effect.runPromise)
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) {
    expect(Cause.hasInterrupts(exit.cause)).toBe(true)
    expect(Cause.hasFails(exit.cause)).toBe(true)
    expect(Cause.pretty(exit.cause)).toContain("secret-token")
  }
})

const safeFailure = (code: "prepare" | "unknown") => Object.assign(new Error("safe publication failure"), { code })

async function settleControlled(effect: Effect.Effect<string, Error>, cancel: boolean) {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const fiber = Effect.runFork(
    Effect.gen(function* () {
      yield* Effect.promise(async () => {
        entered.resolve()
        await release.promise
      })
      return yield* effect
    }).pipe(SettledIO.drainWithCause),
  )
  await entered.promise
  if (cancel) {
    Effect.runFork(Fiber.interrupt(fiber))
    await Effect.runPromise(
      Effect.promise(async () => {
        const started = Date.now()
        while (!(fiber as { _interruptedCause?: unknown })._interruptedCause) {
          if (Date.now() - started > 2000) throw new Error("interrupt was not observed")
          await Bun.sleep(1)
        }
      }),
    )
  }
  release.resolve()
  return Fiber.await(fiber).pipe(Effect.runPromise)
}

for (const code of ["prepare", "unknown"] as const) {
  test(`C-01 drainWithCause preserves a safe ${code} failure without cancellation`, async () => {
    const exit = await settleControlled(Effect.fail(safeFailure(code)), false)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.hasFails(exit.cause)).toBe(true)
      expect(Cause.hasInterrupts(exit.cause)).toBe(false)
      expect(Cause.squash(exit.cause)).toMatchObject({ code, message: "safe publication failure" })
    }
  })

  test(`C-01 drainWithCause keeps an interrupt together with a safe ${code} failure`, async () => {
    const exit = await settleControlled(Effect.fail(safeFailure(code)), true)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.hasFails(exit.cause)).toBe(true)
      expect(Cause.hasInterrupts(exit.cause)).toBe(true)
      expect(Cause.pretty(exit.cause)).toContain("safe publication failure")
      expect(Cause.pretty(exit.cause)).not.toContain("secret-token")
    }
  })
}

test("C-01 drainWithCause returns success when irrevocable IO succeeds", async () => {
  const exit = await settleControlled(Effect.succeed("published"), false)
  if (Exit.isFailure(exit)) throw new Error("expected published success")
  const value: unknown = exit.value
  expect(value).toBe("published")
})

test("C-01 drainWithCause keeps only the interrupt when irrevocable IO succeeds", async () => {
  const exit = await settleControlled(Effect.succeed("published"), true)
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) {
    expect(Cause.hasInterrupts(exit.cause)).toBe(true)
    expect(Cause.hasFails(exit.cause)).toBe(false)
    expect(Cause.pretty(exit.cause)).not.toContain("published")
  }
})

for (const body of ["failure", "interrupt", "success"] as const) {
  test(`exit cleanup retains ${body} together with cleanup defect`, async () => {
    const effect = body === "success" ? Effect.void : body === "failure" ? Effect.fail("body") : Effect.interrupt
    const exit = await Effect.runPromiseExit(effect.pipe(SettledIO.onExit(() => Effect.die("cleanup"))))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isSuccess(exit)) return
    expect(Cause.hasDies(exit.cause)).toBe(true)
    expect(Cause.hasInterrupts(exit.cause)).toBe(body === "interrupt")
    expect(Cause.hasFails(exit.cause)).toBe(body === "failure")
    if (body === "failure") expect(Cause.pretty(exit.cause)).toContain("body")
    expect(Cause.pretty(exit.cause)).toContain("cleanup")
  })
}
