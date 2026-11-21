import { describe, expect } from "bun:test"
import fsPromises from "node:fs/promises"
import path from "path"
import { Cause, Deferred, Effect, Exit, Fiber } from "effect"
import {
  posixOps,
  withConfigReadDenied,
  type PermissionObservation,
  type PermissionOps,
} from "../fixture/config-read-permission"
import { tmpdir } from "../fixture/fixture"
import { it } from "../lib/effect"

const document = JSON.stringify({ mcp: { review: { enabled: false } } })
const tmpdirEffect = Effect.acquireRelease(
  Effect.promise(() => tmpdir()),
  (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
)
const denied = () => ({ ok: false as const, code: "EPERM" })
const readable = () => ({ ok: true as const, text: document })

type Event = "apply-started" | "apply-finished" | "restore-started" | "restore-finished" | "request"

const before = (events: readonly Event[], earlier: Event, later: Event) =>
  events.indexOf(earlier) >= 0 && events.indexOf(later) > events.indexOf(earlier)

describe("config read permission fixture", () => {
  it.live("T01 restores captured mode after one successful request", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect
      const file = path.join(tmp.path, "opencode.json")
      const events: Event[] = []
      let original = 0o640
      const ops: PermissionOps = {
        apply: () => {
          events.push("apply-started")
          events.push("apply-finished")
          return { status: 0 }
        },
        restore: (_file, captured) => {
          events.push("restore-started")
          original = captured ?? 0
          events.push("restore-finished")
          return { status: 0 }
        },
        read: async () => (events.includes("restore-finished") ? readable() : denied()),
        probe: async () => denied(),
        mode: async () => original,
      }
      let requests = 0
      const seen = yield* withConfigReadDenied({
        file,
        document,
        ops,
        use: (code) =>
          Effect.sync(() => {
            requests += 1
            events.push("request")
            expect(code).toBe("EPERM")
            return "ok"
          }),
      })
      expect(seen.value).toBe("ok")
      expect(requests).toBe(1)
      expect(original).toBe(0o640)
      expect(before(events, "apply-finished", "request")).toBe(true)
      expect(before(events, "request", "restore-started")).toBe(true)
      expect(events.filter((event) => event === "restore-started")).toHaveLength(1)
    }),
  )

  it.live("T02 restores after apply reports failure and skips the request", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect
      const file = path.join(tmp.path, "opencode.json")
      const events: Event[] = []
      const ops: PermissionOps = {
        apply: () => {
          events.push("apply-started")
          events.push("apply-finished")
          return { error: new Error("partial apply"), status: 1 }
        },
        restore: () => {
          events.push("restore-started")
          events.push("restore-finished")
          return { status: 0 }
        },
        read: async () => readable(),
      }
      const finished = yield* withConfigReadDenied({
        file,
        document,
        ops,
        use: () =>
          Effect.sync(() => {
            events.push("request")
          }),
      }).pipe(Effect.exit)
      expect(events.includes("request")).toBe(false)
      expect(events.filter((event) => event === "restore-started")).toHaveLength(1)
      expect(Exit.isFailure(finished)).toBe(true)
      if (Exit.isFailure(finished)) expect(Cause.pretty(finished.cause)).toContain("partial apply")
    }),
  )

  it.live("T03 keeps both apply and first restore errors after the second restore succeeds", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect
      const file = path.join(tmp.path, "opencode.json")
      let restores = 0
      const ops: PermissionOps = {
        apply: () => ({ error: new Error("partial apply"), status: 1 }),
        restore: () => {
          restores += 1
          return restores === 1 ? { error: new Error("first restore failed"), status: 1 } : { status: 0 }
        },
        read: async () => (restores < 2 ? denied() : readable()),
      }
      const finished = yield* withConfigReadDenied({
        file,
        document,
        ops,
        use: () => Effect.sync(() => expect(true).toBe(false)),
      }).pipe(Effect.exit)
      expect(restores).toBe(2)
      expect(Exit.isFailure(finished)).toBe(true)
      if (Exit.isFailure(finished)) {
        const rendered = Cause.pretty(finished.cause)
        expect(rendered).toContain("partial apply")
        expect(rendered).toContain("first restore failed")
      }
    }),
  )

  it.live("T04 reports the first restore error after a later restore succeeds", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect
      const file = path.join(tmp.path, "opencode.json")
      let restores = 0
      const ops: PermissionOps = {
        apply: () => ({ status: 0 }),
        restore: () => {
          restores += 1
          return restores === 1 ? { error: new Error("first restore failed"), status: 1 } : { status: 0 }
        },
        read: async () => (restores === 0 ? denied() : readable()),
        probe: async () => denied(),
      }
      const finished = yield* withConfigReadDenied({
        file,
        document,
        ops,
        use: () => Effect.void,
      }).pipe(Effect.exit)
      expect(restores).toBe(2)
      expect(Exit.isFailure(finished)).toBe(true)
      if (Exit.isFailure(finished)) expect(Cause.pretty(finished.cause)).toContain("first restore failed")
    }),
  )

  it.live("T05 stops after two failed restores and reports both", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect
      const file = path.join(tmp.path, "opencode.json")
      let restores = 0
      const ops: PermissionOps = {
        apply: () => ({ status: 0 }),
        restore: () => {
          restores += 1
          return { error: new Error(`restore failed ${restores}`), status: 1 }
        },
        read: async () => denied(),
        probe: async () => denied(),
      }
      const finished = yield* withConfigReadDenied({
        file,
        document,
        ops,
        use: () => Effect.void,
      }).pipe(Effect.exit)
      expect(restores).toBe(2)
      expect(Exit.isFailure(finished)).toBe(true)
      if (Exit.isFailure(finished)) {
        const rendered = Cause.pretty(finished.cause)
        expect(rendered).toContain("restore failed 1")
        expect(rendered).toContain("restore failed 2")
      }
    }),
  )

  it.live("T06 restores when the probe stays readable or is missing", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect
      const file = path.join(tmp.path, "opencode.json")
      const events: Event[] = []
      const readableOps: PermissionOps = {
        apply: () => {
          events.push("apply-finished")
          return { status: 0 }
        },
        restore: () => {
          events.push("restore-started")
          return { status: 0 }
        },
        read: async () => readable(),
      }
      const readableExit = yield* withConfigReadDenied({
        file,
        document,
        ops: readableOps,
        use: () =>
          Effect.sync(() => {
            events.push("request")
          }),
      }).pipe(Effect.exit)
      expect(events.includes("request")).toBe(false)
      expect(events.includes("restore-started")).toBe(true)
      expect(Exit.isFailure(readableExit)).toBe(true)
      if (Exit.isFailure(readableExit)) expect(Cause.pretty(readableExit.cause)).toContain("could not establish")

      const missing = path.join(tmp.path, "missing.json")
      let missingRestores = 0
      const missingExit = yield* withConfigReadDenied({
        file: missing,
        document,
        ops: {
          apply: () => ({ status: 0 }),
          restore: () => {
            missingRestores += 1
            return { status: 0 }
          },
          read: async () => readable(),
          probe: async () => ({ ok: false, code: "ENOENT" }),
        },
        use: () => Effect.sync(() => expect(true).toBe(false)),
      }).pipe(Effect.exit)
      expect(missingRestores).toBe(1)
      expect(Exit.isFailure(missingExit)).toBe(true)
      if (Exit.isFailure(missingExit)) expect(Cause.pretty(missingExit.cause)).toContain("ENOENT")
    }),
  )

  it.live("T07 keeps apply finished before restore when the wait is interrupted", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect
      const file = path.join(tmp.path, "opencode.json")
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const events: Event[] = []
      let late = 0
      const ops: PermissionOps = {
        apply: () =>
          new Promise((resolve) => {
            events.push("apply-started")
            void Effect.runPromise(Deferred.succeed(started, undefined)).then(() => {
              void Effect.runPromise(Deferred.await(release)).then(() => {
                events.push("apply-finished")
                resolve({ status: 0 })
              })
            })
          }),
        restore: () => {
          events.push("restore-started")
          if (!events.includes("apply-finished")) late += 1
          events.push("restore-finished")
          return { status: 0 }
        },
        read: async () => (events.includes("restore-finished") ? readable() : denied()),
        probe: async () => denied(),
      }
      const fiber = yield* withConfigReadDenied({
        file,
        document,
        ops,
        use: () => Effect.sync(() => events.push("request")),
      }).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      fiber.interruptUnsafe()
      yield* Deferred.succeed(release, undefined)
      const interrupted = yield* Fiber.await(fiber)
      expect(before(events, "apply-started", "apply-finished")).toBe(true)
      expect(before(events, "apply-finished", "restore-started")).toBe(true)
      expect(late).toBe(0)
      expect(events.filter((event) => event === "restore-started")).toHaveLength(1)
      expect(events.at(-1)).toBe("restore-finished")
      expect(Exit.isFailure(interrupted)).toBe(true)
      if (Exit.isFailure(interrupted)) expect(Cause.hasInterrupts(interrupted.cause)).toBe(true)
    }),
  )

  it.live("T08 restores when the request wait is interrupted", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect
      const file = path.join(tmp.path, "opencode.json")
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const events: Event[] = []
      const ops: PermissionOps = {
        apply: () => {
          events.push("apply-finished")
          return { status: 0 }
        },
        restore: () => {
          events.push("restore-started")
          events.push("restore-finished")
          return { status: 0 }
        },
        read: async () => (events.includes("restore-finished") ? readable() : denied()),
        probe: async () => denied(),
      }
      const fiber = yield* withConfigReadDenied({
        file,
        document,
        ops,
        use: () =>
          Effect.gen(function* () {
            events.push("request")
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
          }),
      }).pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      fiber.interruptUnsafe()
      yield* Deferred.succeed(release, undefined)
      const interrupted = yield* Fiber.await(fiber)
      expect(before(events, "apply-finished", "request")).toBe(true)
      expect(before(events, "request", "restore-started")).toBe(true)
      expect(Exit.isFailure(interrupted)).toBe(true)
      if (Exit.isFailure(interrupted)) expect(Cause.hasInterrupts(interrupted.cause)).toBe(true)
    }),
  )

  it.live("T09 keeps the request failure and the restore failure", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect
      const file = path.join(tmp.path, "opencode.json")
      const ops: PermissionOps = {
        apply: () => ({ status: 0 }),
        restore: () => ({ error: new Error("restore failed"), status: 1 }),
        read: async () => denied(),
        probe: async () => denied(),
      }
      const finished = yield* withConfigReadDenied({
        file,
        document,
        ops,
        use: () => Effect.fail(new Error("request failed")),
      }).pipe(Effect.exit)
      expect(Exit.isFailure(finished)).toBe(true)
      if (Exit.isFailure(finished)) {
        const rendered = Cause.pretty(finished.cause)
        expect(rendered).toContain("request failed")
        expect(rendered).toContain("restore failed")
      }
    }),
  )

  it.live("T10 spends the remaining budget when restore verification fails", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect
      const file = path.join(tmp.path, "opencode.json")
      let restores = 0
      let checks = 0
      const ops: PermissionOps = {
        apply: () => ({ status: 0 }),
        restore: () => {
          restores += 1
          return { status: 0 }
        },
        read: async () => {
          checks += 1
          return checks === 1 ? denied() : readable()
        },
        probe: async () => denied(),
      }
      const finished = yield* withConfigReadDenied({
        file,
        document,
        ops,
        use: () => Effect.void,
      }).pipe(Effect.exit)
      expect(restores).toBe(2)
      expect(Exit.isFailure(finished)).toBe(true)
      if (Exit.isFailure(finished)) expect(Cause.pretty(finished.cause)).toContain("not readable")
    }),
  )

  it.live("T11 restores each captured mode without a fixed fallback", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect
      const file = path.join(tmp.path, "opencode.json")
      const modes = [0o600, 0o640, 0o644, 0o664]
      for (const mode of modes) {
        let current = mode
        const restored: number[] = []
        yield* withConfigReadDenied({
          file,
          document,
          ops: {
            apply: () => ({ status: 0 }),
            restore: (_target, original) => {
              restored.push(original ?? 0)
              current = original ?? 0
              return { status: 0 }
            },
            read: async () => (current === mode ? readable() : denied()),
            probe: async () => denied(),
            mode: async () => current,
          },
          use: () => Effect.void,
        })
        expect(restored).toEqual([mode])
        expect(current).toBe(mode)
      }
    }),
  )

  it.live("T12 repeats finish without another permission call", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect
      const file = path.join(tmp.path, "opencode.json")
      let restores = 0
      const ops: PermissionOps = {
        apply: () => ({ status: 0 }),
        restore: () => {
          restores += 1
          return { status: 0 }
        },
        read: async () => readable(),
        probe: async () => denied(),
      }
      const observed = yield* withConfigReadDenied({
        file,
        document,
        ops,
        repeatFinish: true,
        use: (_code, seen) => Effect.sync(() => seen()),
      })
      expect(observed.value.stage).toBe("denied")
      expect(observed.repeated && Exit.isSuccess(observed.repeated)).toBe(true)
      expect(observed.seen().stage).toBe("restored")
      expect(observed.seen().attempts).toBe(1)
      expect(restores).toBe(1)
    }),
  )

  it.live.skip("T13 runs the POSIX mode case only on non-Windows non-root hosts", () => Effect.void)

  it.live("B01 restores after a dispatched apply even when started was not signaled", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect
      const file = path.join(tmp.path, "opencode.json")
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const events: Event[] = []
      let late = 0
      const ops: PermissionOps = {
        apply: () =>
          new Promise((resolve) => {
            events.push("apply-started")
            void Effect.runPromise(Deferred.succeed(entered, undefined)).then(() => {
              void Effect.runPromise(Deferred.await(release)).then(() => {
                events.push("apply-finished")
                resolve({ status: 0 })
              })
            })
          }),
        restore: () => {
          events.push("restore-started")
          if (!events.includes("apply-finished")) late += 1
          events.push("restore-finished")
          return { status: 0 }
        },
        read: async () =>
          events.includes("apply-finished") && !events.includes("restore-finished") ? denied() : readable(),
      }
      const fiber = yield* withConfigReadDenied({
        file,
        document,
        ops,
        use: () => Effect.sync(() => events.push("request")),
      }).pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      fiber.interruptUnsafe()
      yield* Deferred.succeed(release, undefined)
      const interrupted = yield* Fiber.await(fiber)
      yield* Effect.promise(() => Promise.resolve())
      expect(before(events, "apply-finished", "restore-started")).toBe(true)
      expect(late).toBe(0)
      expect(events.filter((event) => event === "restore-started")).toHaveLength(1)
      expect(events.includes("request")).toBe(false)
      expect(Exit.isFailure(interrupted)).toBe(true)
      if (Exit.isFailure(interrupted)) expect(Cause.hasInterrupts(interrupted.cause)).toBe(true)
    }),
  )

  it.live("B02 reports an apply failure that never signals started", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect
      const file = path.join(tmp.path, "opencode.json")
      const events: Event[] = []
      const ops: PermissionOps = {
        apply: () => {
          events.push("apply-finished")
          return { error: new Error("apply failed before started"), status: 1 }
        },
        restore: () => {
          events.push("restore-started")
          return { status: 0 }
        },
        read: async () => readable(),
      }
      const finished = yield* withConfigReadDenied({
        file,
        document,
        ops,
        use: () =>
          Effect.sync(() => {
            events.push("request")
          }),
      }).pipe(Effect.timeout("2 seconds"), Effect.exit)
      expect(events.includes("request")).toBe(false)
      expect(events.includes("restore-started")).toBe(true)
      expect(Exit.isFailure(finished)).toBe(true)
      if (Exit.isFailure(finished)) {
        const rendered = Cause.pretty(finished.cause)
        expect(rendered).toContain("apply failed before started")
        expect(rendered).not.toContain("Timeout")
      }
    }),
  )

  it.live("B03 keeps restore failures when the request is interrupted", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect
      const file = path.join(tmp.path, "opencode.json")
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let restores = 0
      const ops: PermissionOps = {
        apply: () => ({ status: 0 }),
        restore: () => {
          restores += 1
          return { error: new Error(`restore failed ${restores}`), status: 1 }
        },
        read: async () => denied(),
        probe: async () => denied(),
      }
      const fiber = yield* withConfigReadDenied({
        file,
        document,
        ops,
        use: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
          }),
      }).pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      fiber.interruptUnsafe()
      yield* Deferred.succeed(release, undefined)
      const interrupted = yield* Fiber.await(fiber)
      expect(restores).toBe(2)
      expect(Exit.isFailure(interrupted)).toBe(true)
      if (Exit.isFailure(interrupted)) {
        const rendered = Cause.pretty(interrupted.cause)
        expect(Cause.hasInterrupts(interrupted.cause)).toBe(true)
        expect(rendered).toContain("restore failed 1")
        expect(rendered).toContain("restore failed 2")
      }
    }),
  )

  it.live("B04 restores after apply throws before returning", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect
      const file = path.join(tmp.path, "opencode.json")
      let restores = 0
      const ops: PermissionOps = {
        apply: () => {
          throw new Error("apply threw")
        },
        restore: () => {
          restores += 1
          return { status: 0 }
        },
        read: async () => readable(),
      }
      const finished = yield* withConfigReadDenied({
        file,
        document,
        ops,
        use: () => Effect.sync(() => expect(true).toBe(false)),
      }).pipe(Effect.timeout("2 seconds"), Effect.exit)
      expect(restores).toBe(1)
      expect(Exit.isFailure(finished)).toBe(true)
      if (Exit.isFailure(finished)) {
        const rendered = Cause.pretty(finished.cause)
        expect(rendered).toContain("apply threw")
        expect(rendered).not.toContain("Timeout")
      }
    }),
  )

  it.live("B05 reports an apply rejection before the permission write", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect
      const file = path.join(tmp.path, "opencode.json")
      let restores = 0
      const ops: PermissionOps = {
        apply: () => Promise.reject(new Error("apply rejected")),
        restore: () => {
          restores += 1
          return { status: 0 }
        },
        read: async () => readable(),
      }
      const finished = yield* withConfigReadDenied({
        file,
        document,
        ops,
        use: () => Effect.sync(() => expect(true).toBe(false)),
      }).pipe(Effect.timeout("2 seconds"), Effect.exit)
      expect(restores).toBe(1)
      expect(Exit.isFailure(finished)).toBe(true)
      if (Exit.isFailure(finished)) {
        const rendered = Cause.pretty(finished.cause)
        expect(rendered).toContain("apply rejected")
        expect(rendered).not.toContain("Timeout")
      }
    }),
  )

  it.live("B06 keeps the apply failure that arrives after cancellation", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect
      const file = path.join(tmp.path, "opencode.json")
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const events: Event[] = []
      const ops: PermissionOps = {
        apply: () =>
          new Promise((resolve) => {
            events.push("apply-started")
            void Effect.runPromise(Deferred.succeed(entered, undefined)).then(() => {
              void Effect.runPromise(Deferred.await(release)).then(() => {
                events.push("apply-finished")
                resolve({ error: new Error("apply failed after cancel"), status: 1 })
              })
            })
          }),
        restore: () => {
          events.push("restore-started")
          return { error: new Error("restore failed after cancel"), status: 1 }
        },
        read: async () => readable(),
      }
      const fiber = yield* withConfigReadDenied({
        file,
        document,
        ops,
        use: () => Effect.sync(() => events.push("request")),
      }).pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      fiber.interruptUnsafe()
      yield* Deferred.succeed(release, undefined)
      const interrupted = yield* Fiber.await(fiber)
      yield* Effect.promise(() => Promise.resolve())
      expect(before(events, "apply-finished", "restore-started")).toBe(true)
      expect(events.includes("request")).toBe(false)
      expect(events.filter((event) => event === "restore-started")).toHaveLength(2)
      expect(Exit.isFailure(interrupted)).toBe(true)
      if (Exit.isFailure(interrupted)) {
        const rendered = Cause.pretty(interrupted.cause)
        expect(Cause.hasInterrupts(interrupted.cause)).toBe(true)
        expect(rendered).toContain("apply failed after cancel")
        expect(rendered).toContain("restore failed after cancel")
      }
    }),
  )

  it.live("B07 keeps the first restore error when the second restore succeeds after cancellation", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect
      const file = path.join(tmp.path, "opencode.json")
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let restores = 0
      const ops: PermissionOps = {
        apply: () => ({ status: 0 }),
        restore: () => {
          restores += 1
          return restores === 1 ? { error: new Error("first restore failed"), status: 1 } : { status: 0 }
        },
        read: async () => (restores < 2 ? denied() : readable()),
        probe: async () => denied(),
      }
      const fiber = yield* withConfigReadDenied({
        file,
        document,
        ops,
        use: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
          }),
      }).pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      fiber.interruptUnsafe()
      yield* Deferred.succeed(release, undefined)
      const interrupted = yield* Fiber.await(fiber)
      expect(restores).toBe(2)
      expect(Exit.isFailure(interrupted)).toBe(true)
      if (Exit.isFailure(interrupted)) {
        const rendered = Cause.pretty(interrupted.cause)
        expect(Cause.hasInterrupts(interrupted.cause)).toBe(true)
        expect(rendered).toContain("first restore failed")
      }
    }),
  )

  it.live("B08 keeps the interrupt when cancellation happens before dispatch", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect
      const file = path.join(tmp.path, "opencode.json")
      const held = yield* Deferred.make<void>()
      const ready = yield* Deferred.make<void>()
      let applies = 0
      let restores = 0
      const ops: PermissionOps = {
        apply: () => {
          applies += 1
          return { status: 0 }
        },
        restore: () => {
          restores += 1
          return { status: 0 }
        },
        read: async () => readable(),
      }
      const fiber = yield* withConfigReadDenied({
        file,
        document,
        ops,
        holdAcquire: Deferred.succeed(ready, undefined).pipe(Effect.flatMap(() => Deferred.await(held))),
        use: () => Effect.void,
      }).pipe(Effect.forkChild)
      yield* Deferred.await(ready)
      fiber.interruptUnsafe()
      yield* Deferred.succeed(held, undefined)
      const interrupted = yield* Fiber.await(fiber)
      yield* Effect.promise(() => Promise.resolve())
      expect(applies).toBe(0)
      expect(restores).toBe(0)
      expect(Exit.isFailure(interrupted)).toBe(true)
      if (Exit.isFailure(interrupted)) expect(Cause.hasInterrupts(interrupted.cause)).toBe(true)
    }),
  )

  it.live("B09 spends the second restore after a partial apply and a failed restore", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect
      const file = path.join(tmp.path, "opencode.json")
      let restores = 0
      const ops: PermissionOps = {
        apply: () => ({ error: new Error("partial apply"), status: 1 }),
        restore: () => {
          restores += 1
          return restores === 1 ? { error: new Error("first restore failed"), status: 1 } : { status: 0 }
        },
        read: async () => readable(),
      }
      const finished = yield* withConfigReadDenied({
        file,
        document,
        ops,
        use: () => Effect.sync(() => expect(true).toBe(false)),
      }).pipe(Effect.exit)
      expect(restores).toBe(2)
      expect(Exit.isFailure(finished)).toBe(true)
      if (Exit.isFailure(finished)) {
        const rendered = Cause.pretty(finished.cause)
        expect(rendered).toContain("partial apply")
        expect(rendered).toContain("first restore failed")
      }
    }),
  )

  it.live("B10 keeps thrown and rejected restore errors inside the same budget", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect
      const file = path.join(tmp.path, "opencode.json")
      let restores = 0
      const thrown = yield* withConfigReadDenied({
        file,
        document,
        ops: {
          apply: () => ({ status: 0 }),
          restore: () => {
            restores += 1
            throw new Error(`restore threw ${restores}`)
          },
          read: async () => denied(),
          probe: async () => denied(),
        },
        use: () => Effect.void,
      }).pipe(Effect.exit)
      expect(restores).toBe(2)
      expect(Exit.isFailure(thrown)).toBe(true)
      if (Exit.isFailure(thrown)) {
        const rendered = Cause.pretty(thrown.cause)
        expect(rendered).toContain("restore threw 1")
        expect(rendered).toContain("restore threw 2")
      }

      let rejected = 0
      const rejectedExit = yield* withConfigReadDenied({
        file,
        document,
        ops: {
          apply: () => ({ status: 0 }),
          restore: () => {
            rejected += 1
            return Promise.reject(new Error(`restore rejected ${rejected}`))
          },
          read: async () => denied(),
          probe: async () => denied(),
        },
        use: () => Effect.void,
      }).pipe(Effect.exit)
      expect(rejected).toBe(2)
      expect(Exit.isFailure(rejectedExit)).toBe(true)
      if (Exit.isFailure(rejectedExit)) {
        const rendered = Cause.pretty(rejectedExit.cause)
        expect(rendered).toContain("restore rejected 1")
        expect(rendered).toContain("restore rejected 2")
      }
    }),
  )

  it.live("T11 adapter passes the captured mode into posix restore", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect
      const file = path.join(tmp.path, "opencode.json")
      yield* Effect.promise(() => Bun.write(file, document))
      yield* Effect.promise(() => fsPromises.chmod(file, 0o640))
      const sampled = (yield* Effect.promise(() => fsPromises.stat(file))).mode & 0o7777
      const captured: number[] = []
      const adapter = posixOps()
      adapter.restore = async (target, original) => {
        captured.push(original ?? -1)
        await fsPromises.chmod(target, original ?? 0)
        return { status: 0 }
      }
      if (process.platform === "win32") {
        yield* withConfigReadDenied({
          file,
          document,
          ops: {
            ...adapter,
            apply: () => ({ status: 0 }),
            probe: async () => denied(),
          },
          use: () => Effect.void,
        })
        expect(captured).toEqual([sampled])
        return
      }
      yield* withConfigReadDenied({
        file,
        document,
        ops: adapter,
        use: (code) => Effect.sync(() => expect(code === "EACCES" || code === "EPERM").toBe(true)),
      })
      expect(captured).toEqual([sampled])
      expect((yield* Effect.promise(() => fsPromises.stat(file))).mode & 0o7777).toBe(sampled)
    }),
  )
})

describe("permission result boundaries", () => {
  for (const stage of ["read", "mode", "verify"] as const) {
    for (const kind of ["throw", "reject"] as const) {
      for (const persistent of [false, true]) {
        it.live(`C01 ${stage} ${kind} ${persistent ? "twice" : "once"} stays inside the restore budget`, () =>
          Effect.gen(function* () {
            const tmp = yield* tmpdirEffect
            const file = path.join(tmp.path, "opencode.json")
            const marker = `${stage} verification ${kind}`
            let restores = 0
            let checks = 0
            let observe: (() => PermissionObservation) | undefined
            const check = () => {
              checks += 1
              if (!persistent && checks > 1) return
              if (kind === "throw") throw new Error(marker)
              return Promise.reject(new Error(marker))
            }
            const ops: PermissionOps = {
              apply: () => ({ status: 0 }),
              restore: () => {
                restores += 1
                return { status: 0 }
              },
              probe: async () => denied(),
              read: () => {
                const failure = stage === "read" ? check() : undefined
                return failure ?? Promise.resolve(readable())
              },
            }
            if (stage === "mode") {
              ops.mode = () => {
                const failure = restores > 0 ? check() : undefined
                return failure ?? Promise.resolve(0o640)
              }
            }
            if (stage === "verify") {
              ops.snapshot = async () => "inherited test acl"
              ops.verify = () => check() ?? Promise.resolve(readable())
            }
            const finished = yield* withConfigReadDenied({
              file,
              document,
              ops,
              use: (_code, seen) =>
                Effect.sync(() => {
                  observe = seen
                }),
            }).pipe(Effect.exit)
            expect(restores).toBe(2)
            expect(checks).toBe(2)
            expect(observe?.().stage).toBe(persistent ? "unrestored" : "restored")
            expect(observe?.().failures).toHaveLength(persistent ? 2 : 1)
            expect(Exit.isFailure(finished)).toBe(true)
            if (Exit.isFailure(finished)) expect(Cause.pretty(finished.cause)).toContain(marker)
          }),
        )
      }
    }
  }

  const outcomes = [
    { label: "nonzero status", result: { status: 1 }, marker: "status 1" },
    { label: "null status", result: { status: null }, marker: "status null" },
    {
      label: "error with zero status",
      result: { status: 0, error: new Error("explicit apply error") },
      marker: "explicit apply error",
    },
  ]
  for (const outcome of outcomes) {
    for (const cancelled of [false, true]) {
      it.live(`C02 ${outcome.label} is preserved ${cancelled ? "after cancellation" : "without cancellation"}`, () =>
        Effect.gen(function* () {
          const tmp = yield* tmpdirEffect
          const file = path.join(tmp.path, "opencode.json")
          const entered = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          let restores = 0
          let requests = 0
          const running = withConfigReadDenied({
            file,
            document,
            ops: {
              apply: () =>
                Effect.gen(function* () {
                  yield* Deferred.succeed(entered, undefined)
                  if (cancelled) yield* Deferred.await(release)
                  return outcome.result
                }).pipe(Effect.runPromise),
              restore: () => {
                restores += 1
                return { status: 0 }
              },
              read: async () => readable(),
              probe: async () => denied(),
            },
            use: () => Effect.sync(() => (requests += 1)),
          })
          const fiber = yield* running.pipe(Effect.forkChild)
          yield* Deferred.await(entered)
          if (cancelled) {
            fiber.interruptUnsafe()
            yield* Deferred.succeed(release, undefined)
          }
          const finished = yield* Fiber.await(fiber)
          expect(restores).toBe(1)
          expect(requests).toBe(0)
          expect(Exit.isFailure(finished)).toBe(true)
          if (Exit.isFailure(finished)) {
            expect(Cause.hasInterrupts(finished.cause)).toBe(cancelled)
            expect(finished.cause.reasons.some((reason) => reason._tag === "Fail")).toBe(true)
            expect(Cause.pretty(finished.cause)).toContain(outcome.marker)
          }
        }),
      )
    }
  }

  it.live("C03 keeps cancellation, status-only apply failure and both cleanup failures", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect
      const file = path.join(tmp.path, "opencode.json")
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let restores = 0
      const fiber = yield* withConfigReadDenied({
        file,
        document,
        ops: {
          apply: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(release)
              return { status: 1 }
            }).pipe(Effect.runPromise),
          restore: () => ({ status: 1, error: new Error(`cleanup failure ${++restores}`) }),
          read: async () => readable(),
        },
        use: () => Effect.die("request must not execute"),
      }).pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      fiber.interruptUnsafe()
      yield* Deferred.succeed(release, undefined)
      const finished = yield* Fiber.await(fiber)
      expect(restores).toBe(2)
      expect(Exit.isFailure(finished)).toBe(true)
      if (Exit.isFailure(finished)) {
        expect(Cause.hasInterrupts(finished.cause)).toBe(true)
        const rendered = Cause.pretty(finished.cause)
        expect(rendered).toContain("status 1")
        expect(rendered).toContain("cleanup failure 1")
        expect(rendered).toContain("cleanup failure 2")
      }
    }),
  )

  it.live("C04 retries a rejected verification after request cancellation and retains both causes", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect
      const file = path.join(tmp.path, "opencode.json")
      const entered = yield* Deferred.make<void>()
      const held = yield* Deferred.make<void>()
      let restores = 0
      let checks = 0
      const fiber = yield* withConfigReadDenied({
        file,
        document,
        ops: {
          apply: () => ({ status: 0 }),
          restore: () => {
            restores += 1
            return { status: 0 }
          },
          probe: async () => denied(),
          read: () =>
            ++checks === 1 ? Promise.reject(new Error("verification after cancellation")) : Promise.resolve(readable()),
        },
        use: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(held)
          }),
      }).pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      fiber.interruptUnsafe()
      const finished = yield* Fiber.await(fiber)
      expect(restores).toBe(2)
      expect(checks).toBe(2)
      expect(Exit.isFailure(finished)).toBe(true)
      if (Exit.isFailure(finished)) {
        expect(Cause.hasInterrupts(finished.cause)).toBe(true)
        expect(Cause.pretty(finished.cause)).toContain("verification after cancellation")
      }
    }),
  )
})
