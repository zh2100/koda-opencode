import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { TesterIsolation } from "@opencode-ai/core/tester-isolation"
import { TesterSession } from "@opencode-ai/core/tester-session"

describe("TesterSession", () => {
  test("creates the session in the lease location and releases it", async () => {
    const released: string[] = []
    let createdDirectory = ""
    const location = { directory: AbsolutePath.make("C:/repo") }
    const isolation: TesterIsolation.Interface = {
      acquire: () =>
        Effect.succeed({
          location: { directory: AbsolutePath.make("C:/repo-tester") },
          release: Effect.sync(() => released.push("released")),
        }),
    }
    const create: SessionV2.Interface["create"] = (input) =>
      Effect.sync(() => {
        createdDirectory = input.location.directory
        return { id: SessionSchema.ID.make("ses_tester") } as never
      })

    const result = await Effect.runPromise(
      TesterSession.withTesterSession({
        isolation,
        create,
        source: { location },
        name: "tester",
        run: (sessionID) => Effect.succeed(sessionID),
      }),
    )

    expect(createdDirectory).toBe("C:/repo-tester")
    expect(String(result)).toBe("ses_tester")
    expect(released).toEqual(["released"])
  })

  test("releases the isolated session after the test fails", async () => {
    const released: string[] = []
    const isolation: TesterIsolation.Interface = {
      acquire: () =>
        Effect.succeed({
          location: { directory: AbsolutePath.make("C:/repo-tester") },
          release: Effect.sync(() => released.push("released")),
        }),
    }
    const create: SessionV2.Interface["create"] = () => Effect.succeed({ id: SessionSchema.ID.make("ses_tester") } as never)

    const exit = await Effect.runPromiseExit(
      TesterSession.withTesterSession({
        isolation,
        create,
        source: { location: { directory: AbsolutePath.make("C:/repo") } },
        name: "tester",
        run: () => Effect.fail("test failed"),
      }),
    )

    expect(exit._tag).toBe("Failure")
    expect(released).toEqual(["released"])
  })

  test("keeps the isolated lease until the test callback completes", async () => {
    let released = false
    const isolation: TesterIsolation.Interface = {
      acquire: () =>
        Effect.succeed({
          location: { directory: AbsolutePath.make("C:/repo-tester") },
          release: Effect.sync(() => {
            released = true
          }),
        }),
    }
    const create: SessionV2.Interface["create"] = () => Effect.succeed({ id: SessionSchema.ID.make("ses_tester") } as never)

    await Effect.runPromise(
      TesterSession.withTesterSession({
        isolation,
        create,
        source: { location: { directory: AbsolutePath.make("C:/repo") } },
        name: "tester",
        run: () =>
          Effect.sync(() => {
            expect(released).toBe(false)
          }),
      }),
    )

    expect(released).toBe(true)
  })
})
