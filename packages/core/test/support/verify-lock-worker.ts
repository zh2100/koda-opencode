import { expect } from "bun:test"
import path from "node:path"
import { runIsolatedWorker } from "./isolated-worker-runner"
import { ConfigDocument } from "@opencode-ai/core/config/document"
import { Hash } from "../../src/util/hash"

type Scenario = "t07a" | "t10"
type Event = {
  readonly scenario: Scenario
  readonly name: string
  readonly key?: string
  readonly lockfile?: string
  readonly ok?: boolean
  readonly error?: string
  readonly outcome?: "conflict" | "interrupted" | "product-failure"
}

export async function verifyLockWorker(scenario: Scenario) {
  const result = await runLockWorker(scenario)
  expect(result.classification).toBe("success")
  expect(result.exit?.exitCode).toBe(0)
  expect(result.events.map((event) => event.name)).toEqual(
    scenario === "t07a"
      ? ["holding", "wait", "interrupt-requested", "saving-terminated", "holder-released", "result"]
      : ["holding", "wait", "higher-created", "holder-released", "result"],
  )
  expect(result.events.at(-1)?.ok).toBe(true)
  expect(result.events.at(-1)?.outcome).toBe(scenario === "t10" ? "conflict" : "interrupted")
  const wait = result.events.find((event) => event.name === "wait")
  const file = path.join(result.root, "opencode.json")
  const key = ConfigDocument.key(file)
  expect(wait?.key).toBe(key)
  expect(wait?.lockfile).toBe(path.join(result.root, "state", "locks", `${Hash.fast(key)}.lock`))
  expect(result.cleanupStatus).toBe("removed")
}

export async function runLockWorker(scenario: Scenario, injection?: "invert-conflict" | "pause-before-interrupt") {
  const seen: string[] = []
  const expected =
    scenario === "t07a"
      ? ["holding", "wait", "interrupt-requested", "saving-terminated", "holder-released", "result"]
      : ["holding", "wait", "higher-created", "holder-released", "result"]
  return runIsolatedWorker({
    worker: path.join(import.meta.dir, "../fixture/stage0-lock-worker.ts"),
    payload: (root) => Buffer.from(JSON.stringify({ scenario, root, injection })).toString("base64"),
    cwd: path.resolve(import.meta.dir, ".."),
    rootPrefix: "opencode-stage0-worker-",
    outputLimit: 64 * 1024,
    lineLimit: 64 * 1024,
    startupTimeoutMs: 10000,
    scenarioTimeoutMs: 10000,
    describeScenarioTimeout: () => `last confirmed: ${seen.at(-1)}; not confirmed: ${expected[seen.length]}; cause unknown`,
    exitTimeoutMs: 3000,
    outputTimeoutMs: 3000,
    parseEvent,
    isReady: (event) => event.name === "holding",
    isResult: (event) => event.name === "result",
    injection,
    expectedOutcome: injection === "invert-conflict" ? "business-failure" : injection ? "timeout-failure" : "success",
    onEvent: (event) => {
      const productFailure = event.name === "result" && event.outcome === "product-failure" && seen.includes("holding") && !seen.includes("result")
      if (event.scenario !== scenario || (!productFailure && event.name !== expected[seen.length]))
        throw new Error("invalid stage0 lifecycle")
      seen.push(event.name)
    },
    validateExit: (events, exitCode) => {
      if (events.at(-1)?.outcome === "product-failure" && exitCode === 1) return
      if (seen.length !== expected.length || events.at(-1)?.ok !== true || events.at(-1)?.outcome !== (scenario === "t10" ? "conflict" : "interrupted") || exitCode !== 0)
        throw new Error("stage0 result/exit mismatch")
    },
    classify: (events, exitCode, timedOut) => {
      if (timedOut) return "scenario-timeout"
      if (exitCode === 0 && events.at(-1)?.name === "result" && events.at(-1)?.ok === true) return "success"
      return "business-failure"
    },
  })
}

function parseEvent(line: string): Event {
  const value: unknown = JSON.parse(line)
  if (!isRecord(value) || (value.scenario !== "t07a" && value.scenario !== "t10") || typeof value.name !== "string") {
    throw new Error("invalid stage 0 worker event")
  }
  if (value.name === "wait" && (typeof value.key !== "string" || typeof value.lockfile !== "string")) {
    throw new Error("wait event lacks identity")
  }
  if (value.name === "result" && typeof value.ok !== "boolean") throw new Error("invalid worker result")
  if (value.outcome === "product-failure" && (value.name !== "result" || value.ok !== false || typeof value.error !== "string" || !value.error))
    throw new Error("invalid product failure")
  if (Object.keys(value).some((key) => !["scenario", "name", "key", "lockfile", "ok", "error", "outcome"].includes(key)))
    throw new Error("unknown stage0 field")
  return value as Event
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
