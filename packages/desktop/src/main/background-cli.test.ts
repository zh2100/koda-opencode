import { describe, expect, test } from "bun:test"
import { commandEnv, servicePasswordCommand } from "./background-cli-compat"

describe("background CLI password compatibility", () => {
  test("uses the dedicated password command when available", () => {
    expect(
      servicePasswordCommand(`SUBCOMMANDS\n  start      Start\n  password   Get or set the server password\n`),
    ).toEqual(["service", "password"])
  })

  test("uses service configuration for older published CLIs", () => {
    expect(
      servicePasswordCommand(`SUBCOMMANDS\n  start      Start\n  get        Get service configuration\n  set        Set service configuration\n`),
    ).toEqual(["service", "get", "password"])
  })

  test("points a launched CLI at the native module beside its executable", () => {
    const binary = "C:\\staged\\opencode-cli.exe"
    const previous = process.env.XDG_STATE_HOME
    const previousReview = process.env.REVIEW_UNRELATED
    process.env.REVIEW_UNRELATED = "kept"
    try {
      const env = commandEnv(binary, "C:\\state")
      expect(env.OPENCODE_NATIVE_LOCK_DIR).toBe("C:\\staged")
      expect(env.XDG_STATE_HOME).toBe("C:\\state")
      expect(env.REVIEW_UNRELATED).toBe("kept")
      expect(process.env.XDG_STATE_HOME).toBe(previous)
      expect(process.env.REVIEW_UNRELATED).toBe("kept")
      const omitted = commandEnv(binary)
      expect(omitted.XDG_STATE_HOME).toBeUndefined()
      expect(omitted.REVIEW_UNRELATED).toBe("kept")
      expect(omitted.OPENCODE_NATIVE_LOCK_DIR).toBe("C:\\staged")
      expect(process.env.XDG_STATE_HOME).toBe(previous)
    } finally {
      if (previous === undefined) delete process.env.XDG_STATE_HOME
      else process.env.XDG_STATE_HOME = previous
      if (previousReview === undefined) delete process.env.REVIEW_UNRELATED
      else process.env.REVIEW_UNRELATED = previousReview
    }
  })

  test("returns no command for an incompatible CLI", () => {
    expect(servicePasswordCommand("SUBCOMMANDS\n  start      Start\n")).toBeUndefined()
  })
})
