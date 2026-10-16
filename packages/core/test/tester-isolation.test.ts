import { describe, expect, test } from "bun:test"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Effect } from "effect"
import { TesterIsolation } from "@opencode-ai/core/tester-isolation"

describe("TesterIsolation", () => {
  test("defines a lease with an isolated location and release operation", () => {
    const location = { directory: AbsolutePath.make("C:/tmp/tester-worktree") }
    const lease: TesterIsolation.Lease = { location, release: Effect.void }
    expect(lease.location.directory).toBe(location.directory)
    expect(Effect.isEffect(lease.release)).toBe(true)
  })

  test("exposes a scoped helper that releases after success and failure", async () => {
    const released: string[] = []
    const service: TesterIsolation.Interface = {
      acquire: () =>
        Effect.succeed({
          location: { directory: AbsolutePath.make("C:/tmp/tester-worktree") },
          release: Effect.sync(() => released.push("released")),
        }),
    }

    await Effect.runPromise(TesterIsolation.withIsolation(service, { source: serviceLocation(), name: "test" }, () => Effect.succeed("ok")))
    expect(released).toEqual(["released"])
  })
})

function serviceLocation() {
  return { directory: AbsolutePath.make("C:/repo") }
}
