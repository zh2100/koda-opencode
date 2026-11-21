import { expect, test } from "bun:test"
import path from "node:path"
import { runIsolatedWorker, type WorkerClassification } from "../support/isolated-worker-runner"

type Scenario = "normal" | "failure" | "hang"
type EventName = "started" | "holding" | "released" | "result"
type Event = {
  readonly scenario: Scenario
  readonly name: EventName
  readonly ok?: boolean
  readonly error?: string
  readonly pid?: number
}

const START_TIMEOUT = 10000
const SCENARIO_TIMEOUT = 5000
const EXIT_TIMEOUT = 3000
const OUTPUT_TIMEOUT = 3000
const OUTPUT_LIMIT = 64 * 1024

test("A3 child process POC validates protocol, business failure, and hard timeout", async () => {
  const normal = await run("normal")
  expect(normal.events.map((event) => event.name)).toEqual(["started", "holding", "released", "result"])
  expect(normal.exit).toEqual({ exitCode: 0, signal: "unavailable" })
  expect(normal.classification).toBe("success")
  expect(normal.cleanupStatus).toBe("removed")

  const failure = await run("failure")
  expect(failure.events.at(-1)).toEqual({
    scenario: "failure",
    name: "result",
    ok: false,
    error: "poc-business-failure",
  })
  expect(failure.exit).toEqual({ exitCode: 1, signal: "unavailable" })
  expect(failure.classification).toBe("business-failure")
  expect(failure.cleanupStatus).toBe("removed")

  const timeout = await run("hang")
  expect(timeout.events.map((event) => event.name)).toEqual(["started", "holding"])
  expect(timeout.classification).toBe("scenario-timeout")
  expect(timeout.terminationStartedAt).toBeNumber()
  expect(timeout.exit?.exitCode).not.toBe(0)
  expect(timeout.cleanupStatus).toBe("removed")
}, 120000)

async function run(scenario: Scenario) {
  const seen: string[] = []
  const result = await runIsolatedWorker({
    worker: path.join(import.meta.dir, "../fixture/lock-wait-poc-worker.ts"),
    payload: (root) => Buffer.from(JSON.stringify({ scenario, root, key: "poc" })).toString("base64"),
    cwd: path.resolve(import.meta.dir, ".."),
    rootPrefix: "opencode-lock-poc-",
    outputLimit: OUTPUT_LIMIT,
    lineLimit: OUTPUT_LIMIT,
    startupTimeoutMs: START_TIMEOUT,
    scenarioTimeoutMs: SCENARIO_TIMEOUT,
    exitTimeoutMs: EXIT_TIMEOUT,
    outputTimeoutMs: OUTPUT_TIMEOUT,
    parseEvent,
    isReady: (event) => event.name === "holding",
    expectedOutcome:
      scenario === "normal" ? "success" : scenario === "failure" ? "business-failure" : "timeout-failure",
    isResult: (event) => event.name === "result",
    onEvent: (event) => {
      const expected =
        scenario === "failure" ? ["started", "holding", "result"] : ["started", "holding", "released", "result"]
      if (event.scenario !== scenario || event.name !== expected[seen.length])
        throw new Error("unexpected POC lifecycle event")
      seen.push(event.name)
    },
    validateExit: (events, exitCode) => {
      const result = events.at(-1)
      if (result?.name !== "result" || result.ok !== (exitCode === 0))
        throw new Error("POC result and exit code disagree")
    },
    classify: (events, exitCode, timedOut): WorkerClassification => {
      if (timedOut) return "scenario-timeout"
      if (events.at(-1)?.name === "result" && events.at(-1)?.ok === false) return "business-failure"
      if (exitCode === 0) return "success"
      return "unknown-failure"
    },
  })
  return result
}

function parseEvent(line: string): Event {
  const value: unknown = JSON.parse(line)
  if (!isRecord(value) || !isScenario(value.scenario) || !isEventName(value.name))
    throw new Error("worker event has invalid fields")
  if (Object.keys(value).some((key) => !["scenario", "name", "ok", "error", "pid"].includes(key)))
    throw new Error("unknown POC field")
  if (value.name === "started" && typeof value.pid !== "number") throw new Error("worker started event has invalid pid")
  if (value.name === "result" && typeof value.ok !== "boolean") throw new Error("worker result has invalid status")
  if (value.name === "result" && value.ok === false && typeof value.error !== "string")
    throw new Error("worker failure has no error")
  return {
    scenario: value.scenario,
    name: value.name,
    ...(typeof value.pid === "number" ? { pid: value.pid } : {}),
    ...(typeof value.ok === "boolean" ? { ok: value.ok } : {}),
    ...(typeof value.error === "string" ? { error: value.error } : {}),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isScenario(value: unknown): value is Scenario {
  return value === "normal" || value === "failure" || value === "hang"
}

function isEventName(value: unknown): value is EventName {
  return value === "started" || value === "holding" || value === "released" || value === "result"
}
