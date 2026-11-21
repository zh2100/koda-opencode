import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { runIsolatedWorker } from "../support/isolated-worker-runner"
import { descendantProbe, listsDescendant } from "../support/descendant-probe"

type FaultMode =
  | "early-exit"
  | "malformed"
  | "duplicate-result"
  | "result-hang"
  | "no-result"
  | "overflow"
  | "overflow-exit-race"
  | "descendant"
  | "startup-hang"
  | "holding-exit"
  | "wrong-scenario"
  | "unknown-event"
  | "wrong-type"
  | "duplicate-started"
  | "duplicate-holding"
  | "out-of-order"
  | "result-mismatch"
  | "after-result"
  | "stderr-overflow"
  | "long-line"
  | "missing-field"
  | "unknown-field"
  | "invalid-pid"
  | "immediate-exit"
type Event = {
  readonly scenario: "fault"
  readonly name: string
  readonly mode?: FaultMode
  readonly ok?: boolean
  readonly pid?: number
}

test("A3 fault protocol rejects malformed lifecycles and recovers with a healthy worker", async () => {
  for (const mode of [
    "early-exit",
    "immediate-exit",
    "malformed",
    "duplicate-result",
    "no-result",
    "overflow",
  ] as const) {
    const result = await runFault(mode)
    expect(result.classification, mode).not.toBe("success")
    expect(result.cleanupStatus, mode).toBe("removed")
    expect((await runHealthy()).classification).toBe("success")
  }

  const resultHang = await runFault("result-hang")
  expect(resultHang.classification).toBe("result-exit-timeout")
  expect(resultHang.cleanupStatus).toBe("removed")
  expect((await runHealthy()).classification).toBe("success")

  const descendant = await runFault("descendant")
  expect(descendant.classification).toBe("scenario-timeout")
  expect(descendant.cleanupStatus).toBe("removed")
  expect(descendant.descendantStatus).toBe("descendant-declared-and-gone")
  expect(descendant.events.some((event) => event.name === "descendant-ready")).toBe(true)
  if (process.platform === "win32") expect(descendant.termination?.exitCode).toBe(0)
  else expect(descendant.termination?.command).toBe(`kill -KILL -- -${descendant.pid}`)

  const healthy = await runHealthy()
  expect(healthy.classification).toBe("success")

  const startup = await runStartupFailure()
  expect(startup.classification).toBe("early-exit")
  expect(startup.events).toHaveLength(0)
  expect(startup.cleanupStatus).toBe("removed")
  expect((await runHealthy()).classification).toBe("success")

  const termination = await runTerminationFailure()
  expect(termination.classification).toBe("termination-failure")
  expect(termination.errors.termination).toContain("exited with 7")
  expect(termination.cleanupStatus).toBe("retained")
  expect(await directoryExists(termination.root)).toBe(true)
  expect((await runHealthy()).classification).toBe("success")

  const cleanup = await runCleanupFailure()
  expect(cleanup.classification).toBe("cleanup-failure")
  expect(cleanup.errors.protocol).toBeString()
  expect(cleanup.errors.cleanup).toBe("injected cleanup failure")
  expect(cleanup.cleanupStatus).toBe("retained")
  expect(await directoryExists(cleanup.root)).toBe(true)
  expect((await runHealthy()).classification).toBe("success")
}, 60000)

test.skipIf(process.platform !== "win32")("overflow preserves the output failure when taskkill loses the exit race", async () => {
  const result = await runFault("overflow-exit-race")
  expect(result.termination?.exitCode).toBe(128)
  expect(result.termination?.helperExitConfirmed).toBe(true)
  expect(result.exit?.exitCode).toBe(0)
  expect(result.classification).toBe("output-failure")
  expect(result.cleanupStatus).toBe("removed")
  expect(await directoryExists(result.root)).toBe(false)
}, 30000)

async function runFault(mode: FaultMode) {
  const seen: string[] = []
  let release = ""
  let exited: Promise<number> | undefined
  return runIsolatedWorker({
    worker: path.join(import.meta.dir, "../fixture/lock-wait-fault-worker.ts"),
    payload: (root) => {
      release = path.join(root, "release")
      return Buffer.from(JSON.stringify({ mode, root })).toString("base64")
    },
    dependencies: mode !== "overflow-exit-race" ? undefined : {
      spawn(command, options) {
        const child = Bun.spawn(command, options)
        exited = child.exited
        return child
      },
      async terminate(pid) {
        await fs.writeFile(release, "")
        await exited
        const helper = Bun.spawn(["taskkill", "/pid", String(pid), "/T", "/F"], { stdout: "pipe", stderr: "pipe" })
        const [exitCode, stdout, stderr] = await Promise.all([helper.exited, new Response(helper.stdout).text(), new Response(helper.stderr).text()])
        return { command: `taskkill /pid ${pid} /T /F`, exitCode, stdout, stderr, helperExitConfirmed: true }
      },
    },
    cwd: path.resolve(import.meta.dir, ".."),
    rootPrefix: "opencode-lock-fault-",
    outputLimit: 64 * 1024,
    lineLimit: 32 * 1024,
    startupTimeoutMs: mode === "startup-hang" ? 1500 : 10000,
    scenarioTimeoutMs: 1500,
    exitTimeoutMs: 3000,
    outputTimeoutMs: 3000,
    parseEvent,
    isReady: (event) => event.name === "holding",
    isResult: (event) => event.name === "result",
    expectedOutcome: mode === "result-hang" || mode === "descendant" ? "timeout-failure" : "protocol-failure",
    ...(mode === "result-hang" || mode === "descendant" ? {} : { injection: `fault-${mode}` }),
    onEvent: (event) => {
      const allowed =
        seen.length === 0
          ? ["started"]
          : seen.at(-1) === "started"
            ? ["holding"]
            : seen.at(-1) === "holding"
              ? ["result", "descendant-started"]
              : seen.at(-1) === "descendant-started"
                ? ["descendant-ready"]
                : []
      if (!allowed.includes(event.name)) throw new Error(`unexpected event ${event.name} after ${seen.at(-1)}`)
      if (event.name === "result" && typeof event.ok !== "boolean") throw new Error("invalid result status")
      seen.push(event.name)
    },
    validateExit: (events, exitCode) => {
      const result = events.at(-1)
      if (result?.name !== "result") throw new Error("worker exited without result")
      if (result.ok !== (exitCode === 0)) throw new Error("result and exit code disagree")
    },
    descendants: mode === "descendant" ? waitForDescendant : undefined,
  })
}

test("A3 F02-F06 explicit lifecycle and protocol matrix", async () => {
  for (const mode of [
    "startup-hang",
    "holding-exit",
    "wrong-scenario",
    "unknown-event",
    "wrong-type",
    "duplicate-started",
    "duplicate-holding",
    "out-of-order",
    "result-mismatch",
    "after-result",
    "stderr-overflow",
    "long-line",
    "missing-field",
    "unknown-field",
    "invalid-pid",
  ] as const) {
    const result = await runFault(mode)
    expect(result.classification, mode).toBe(
      mode === "startup-hang"
        ? "startup-failure"
        : mode === "holding-exit"
          ? "early-exit-after-ready"
          : mode === "stderr-overflow" || mode === "long-line"
            ? "output-failure"
            : "protocol-failure",
    )
    expect(result.cleanupStatus, mode).toBe("removed")
    expect((await runHealthy()).classification).toBe("success")
  }
}, 90000)

test("A3 F01 rejects absent, corrupt and incomplete payloads", async () => {
  for (const payload of [
    undefined,
    "!!!",
    Buffer.from("{").toString("base64"),
    Buffer.from(JSON.stringify({ scenario: "normal" })).toString("base64"),
    Buffer.from(JSON.stringify({ scenario: "normal", root: "unused" })).toString("base64"),
  ]) {
    const result = await runIsolatedWorker({
      worker: path.join(import.meta.dir, "../fixture/lock-wait-poc-worker.ts"),
      payload,
      cwd: path.resolve(import.meta.dir, ".."),
      rootPrefix: "opencode-f01-",
      outputLimit: 64 * 1024,
      lineLimit: 64 * 1024,
      startupTimeoutMs: 10000,
      scenarioTimeoutMs: 1000,
      exitTimeoutMs: 3000,
      outputTimeoutMs: 3000,
      parseEvent: parseHealthyEvent,
      isReady: (event) => event.name === "holding",
      expectedOutcome: "protocol-failure",
      injection: "invalid-payload",
    })
    expect(result.classification).toBe("early-exit")
    expect(result.events).toHaveLength(0)
    expect(result.rawStderr.length).toBeGreaterThan(0)
    expect(result.cleanupStatus).toBe("removed")
    expect((await runHealthy()).classification).toBe("success")
  }
}, 60000)

async function waitForDescendant(
  root: string,
  context: {
    readonly signal: AbortSignal
    readonly observe: (command: string[]) => Promise<{
      readonly command: string
      readonly stdout: string
      readonly stderr: string
      readonly exitCode: number
      readonly at: number
    }>
  },
) {
  try {
    const pid = Number(await Bun.file(path.join(root, "descendant.pid")).text())
    const observations: { command: string; stdout: string; stderr: string; exitCode: number; at: number }[] = [
      await Bun.file(path.join(root, "descendant-before.json")).json(),
    ]
    for (let attempt = 0; attempt < 20; attempt++) {
      if (context.signal.aborted) throw new Error("descendant observation cancelled")
      const output = await context.observe(descendantProbe(pid))
      observations.push(output)
      if (output.exitCode !== 0)
        return {
          ok: false,
          status: "tree-observation-failed" as const,
          error: "descendant process check failed",
          evidence: { stdout: JSON.stringify(observations) },
        }
      if (!listsDescendant(output.stdout, pid))
        return {
          ok: true,
          status: "descendant-declared-and-gone" as const,
          evidence: { stdout: JSON.stringify(observations) },
        }
      await Bun.sleep(50)
    }
    return {
      ok: false,
      status: "descendant-declared-but-alive" as const,
      error: `descendant ${pid} is still alive`,
      evidence: { stdout: JSON.stringify(observations) },
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function runHealthy() {
  return runIsolatedWorker({
    worker: path.join(import.meta.dir, "../fixture/lock-wait-poc-worker.ts"),
    payload: (root) => Buffer.from(JSON.stringify({ scenario: "normal", root, key: "health" })).toString("base64"),
    cwd: path.resolve(import.meta.dir, ".."),
    rootPrefix: "opencode-lock-health-",
    outputLimit: 64 * 1024,
    lineLimit: 64 * 1024,
    startupTimeoutMs: 10000,
    scenarioTimeoutMs: 5000,
    exitTimeoutMs: 3000,
    outputTimeoutMs: 3000,
    parseEvent: parseHealthyEvent,
    isReady: (event) => event.name === "holding",
    expectedOutcome: "success",
  })
}

async function runStartupFailure() {
  return runIsolatedWorker({
    worker: path.join(import.meta.dir, "../fixture/does-not-exist.ts"),
    cwd: path.resolve(import.meta.dir, ".."),
    rootPrefix: "opencode-lock-startup-",
    outputLimit: 64 * 1024,
    lineLimit: 64 * 1024,
    startupTimeoutMs: 3000,
    scenarioTimeoutMs: 1000,
    exitTimeoutMs: 3000,
    outputTimeoutMs: 3000,
    parseEvent,
    expectedOutcome: "protocol-failure",
    injection: "spawn-missing-worker",
  })
}

async function runTerminationFailure() {
  return runIsolatedWorker({
    worker: path.join(import.meta.dir, "../fixture/lock-wait-fault-worker.ts"),
    payload: (root) => Buffer.from(JSON.stringify({ mode: "result-hang", root })).toString("base64"),
    cwd: path.resolve(import.meta.dir, ".."),
    rootPrefix: "opencode-lock-termination-",
    outputLimit: 64 * 1024,
    lineLimit: 64 * 1024,
    startupTimeoutMs: 10000,
    scenarioTimeoutMs: 1500,
    exitTimeoutMs: 3000,
    outputTimeoutMs: 3000,
    parseEvent,
    isReady: (event) => event.name === "holding",
    expectedOutcome: "timeout-failure",
    injection: "terminator-nonzero-but-real-tree-kill",
    dependencies: {
      terminate: async (pid, timeoutMs) => {
        if (process.platform !== "win32") {
          process.kill(-pid, "SIGKILL")
          return { command: "injected-group-kill", exitCode: 7, stdout: "", stderr: "" }
        }
        const killer = Bun.spawn(["taskkill", "/pid", String(pid), "/T", "/F"], { stdout: "pipe", stderr: "pipe" })
        const result = await Promise.race([
          Promise.all([killer.exited, new Response(killer.stdout).text(), new Response(killer.stderr).text()]),
          Bun.sleep(timeoutMs).then(() => Promise.reject(new Error("injected taskkill timeout"))),
        ])
        return { command: "injected-taskkill", exitCode: 7, stdout: result[1], stderr: result[2] }
      },
    },
  })
}

async function runCleanupFailure() {
  return runIsolatedWorker({
    worker: path.join(import.meta.dir, "../fixture/lock-wait-fault-worker.ts"),
    payload: (root) => Buffer.from(JSON.stringify({ mode: "malformed", root })).toString("base64"),
    cwd: path.resolve(import.meta.dir, ".."),
    rootPrefix: "opencode-lock-cleanup-",
    outputLimit: 64 * 1024,
    lineLimit: 64 * 1024,
    startupTimeoutMs: 3000,
    scenarioTimeoutMs: 1000,
    exitTimeoutMs: 3000,
    outputTimeoutMs: 3000,
    parseEvent,
    expectedOutcome: "protocol-failure",
    injection: "remove-root-failure",
    dependencies: { removeRoot: async () => Promise.reject(new Error("injected cleanup failure")) },
  })
}

async function directoryExists(target: string) {
  try {
    await fs.stat(target)
    return true
  } catch {
    return false
  }
}

function parseEvent(line: string): Event {
  const value: unknown = JSON.parse(line)
  if (!isRecord(value) || value.scenario !== "fault" || typeof value.name !== "string")
    throw new Error("invalid fault event")
  if (Object.keys(value).some((key) => !["scenario", "name", "mode", "ok", "pid"].includes(key)))
    throw new Error("unknown fault field")
  if (!["started", "holding", "result", "descendant-started", "descendant-ready"].includes(value.name))
    throw new Error("unknown fault event")
  if (
    ["started", "descendant-started", "descendant-ready"].includes(value.name) &&
    (!Number.isSafeInteger(value.pid) || Number(value.pid) <= 0)
  )
    throw new Error("invalid fault pid")
  if (value.name === "result" && typeof value.ok !== "boolean") throw new Error("invalid fault result")
  if (value.mode !== undefined && typeof value.mode !== "string") throw new Error("invalid fault mode")
  return value as Event
}

function parseHealthyEvent(line: string) {
  const value: unknown = JSON.parse(line)
  if (!isRecord(value) || value.scenario !== "normal" || typeof value.name !== "string")
    throw new Error("invalid healthy event")
  return value as { readonly scenario: "normal"; readonly name: string }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
