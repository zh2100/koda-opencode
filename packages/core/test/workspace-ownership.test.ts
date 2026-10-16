import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { WorkspaceOwnership } from "@opencode-ai/core/workspace-ownership"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { it } from "./lib/effect"

const location = (directory: string, workspaceID?: string) =>
  Location.Ref.make({ directory: AbsolutePath.make(directory), ...(workspaceID ? { workspaceID: WorkspaceV2.ID.make(`wrk_${workspaceID}`) } : {}) })

describe("WorkspaceOwnership", () => {
  it.effect("serializes owners of the same workspace and releases on completion", () =>
    Effect.gen(function* () {
      const ownership = yield* WorkspaceOwnership.Service
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const secondStarted = yield* Deferred.make<void>()
      const first = yield* ownership
        .withOwnership({
          location: location("C:/repo", "workspace-1"),
          ownerID: "first",
          effect: Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
        })
        .pipe(Effect.forkChild)

      yield* Deferred.await(started)
      const second = yield* ownership
        .withOwnership({
          location: location("D:/another-path", "workspace-1"),
          ownerID: "second",
          effect: Deferred.succeed(secondStarted, undefined),
        })
        .pipe(Effect.forkChild)
      yield* Effect.yieldNow
      expect(yield* Deferred.isDone(secondStarted)).toBe(false)

      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(first)
      yield* Fiber.join(second)
      expect(yield* Deferred.isDone(secondStarted)).toBe(true)
    }).pipe(Effect.provide(WorkspaceOwnership.layer)),
  )

  it.effect("uses the normalized directory when workspace placement is implicit", () =>
    Effect.gen(function* () {
      const ownership = yield* WorkspaceOwnership.Service
      expect(ownership.key(location("C:/Repo/../Repo"))).toBe(ownership.key(location("c:/repo")))
      expect(ownership.key(location("C:/repo", "one"))).not.toBe(ownership.key(location("C:/repo", "two")))
    }).pipe(Effect.provide(WorkspaceOwnership.layer)),
  )

  it.effect("releases ownership after failure", () =>
    Effect.gen(function* () {
      const ownership = yield* WorkspaceOwnership.Service
      const key = location("C:/repo", "failure")
      const failure = yield* ownership
        .withOwnership({
          location: key,
          ownerID: "failing",
          effect: Effect.fail("expected failure"),
        })
        .pipe(Effect.flip)

      expect(failure).toBe("expected failure")
      expect(yield* ownership.withOwnership({ location: key, ownerID: "next", effect: Effect.succeed("released") })).toBe("released")
    }).pipe(Effect.provide(WorkspaceOwnership.layer)),
  )

  it.effect("releases ownership after interruption", () =>
    Effect.gen(function* () {
      const ownership = yield* WorkspaceOwnership.Service
      const started = yield* Deferred.make<void>()
      const holder = yield* ownership
        .withOwnership({
          location: location("C:/repo", "interrupt"),
          ownerID: "holder",
          effect: Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        })
        .pipe(Effect.forkChild)

      yield* Deferred.await(started)
      yield* Fiber.interrupt(holder)
      expect(yield* ownership.withOwnership({ location: location("C:/repo", "interrupt"), ownerID: "next", effect: Effect.succeed(true) })).toBe(true)
    }).pipe(Effect.provide(WorkspaceOwnership.layer)),
  )

  it.effect("runs different workspaces concurrently", () =>
    Effect.gen(function* () {
      const ownership = yield* WorkspaceOwnership.Service
      const firstStarted = yield* Deferred.make<void>()
      const secondStarted = yield* Deferred.make<void>()
      const first = yield* ownership
        .withOwnership({
          location: location("C:/repo", "first"),
          ownerID: "first",
          effect: Deferred.succeed(firstStarted, undefined),
        })
        .pipe(Effect.forkChild)
      const second = yield* ownership
        .withOwnership({
          location: location("C:/repo", "second"),
          ownerID: "second",
          effect: Deferred.succeed(secondStarted, undefined),
        })
        .pipe(Effect.forkChild)

      yield* Fiber.join(first)
      yield* Fiber.join(second)
      expect(yield* Deferred.isDone(firstStarted)).toBe(true)
      expect(yield* Deferred.isDone(secondStarted)).toBe(true)
    }).pipe(Effect.provide(WorkspaceOwnership.layer)),
  )

  it.effect("removes an interrupted waiter without blocking later owners", () =>
    Effect.gen(function* () {
      const ownership = yield* WorkspaceOwnership.Service
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const key = location("C:/repo", "waiter")
      const holder = yield* ownership
        .withOwnership({
          location: key,
          ownerID: "holder",
          effect: Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
        })
        .pipe(Effect.forkChild)

      yield* Deferred.await(started)
      const waiter = yield* ownership
        .withOwnership({ location: key, ownerID: "waiter", effect: Effect.succeed(false) })
        .pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* Fiber.interrupt(waiter)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(holder)
      expect(yield* ownership.withOwnership({ location: key, ownerID: "next", effect: Effect.succeed(true) })).toBe(true)
    }).pipe(Effect.provide(WorkspaceOwnership.layer)),
  )
})
