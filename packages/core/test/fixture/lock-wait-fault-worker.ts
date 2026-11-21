import fs from "node:fs/promises"
import { descendantProbe, listsDescendant } from "../support/descendant-probe"

const input = parseInput(process.argv[2])

function parseInput(encoded: string | undefined) {
  if (!encoded) throw new Error("missing fault payload")
  const value: unknown = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"))
  if (!value || typeof value !== "object") throw new Error("fault payload is not an object")
  const record = value as Record<string, unknown>
  const modes = [
    "early-exit",
    "malformed",
    "duplicate-result",
    "result-hang",
    "no-result",
    "overflow",
    "overflow-exit-race",
    "descendant",
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
    "immediate-exit",
  ] as const
  if (!modes.includes(record.mode as (typeof modes)[number])) throw new Error("invalid fault mode")
  if (typeof record.root !== "string" || record.root.length === 0) throw new Error("invalid fault root")
  return { mode: record.mode as (typeof modes)[number], root: record.root }
}

const emit = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`)
if (input.mode === "immediate-exit") process.exit(2)

if (input.mode === "early-exit") {
  emit({ scenario: "fault", name: "started", mode: input.mode, pid: process.pid })
  process.exit(2)
}

if (input.mode === "malformed") {
  process.stdout.write("not-json\n")
  process.exit(2)
}

emit({ scenario: "fault", name: "started", mode: input.mode, pid: process.pid })
if (input.mode === "startup-hang") await new Promise(() => {})
if (input.mode === "duplicate-started") emit({ scenario: "fault", name: "started", pid: process.pid })
if (input.mode === "out-of-order") emit({ scenario: "fault", name: "result", ok: true })
emit({ scenario: "fault", name: "holding", mode: input.mode })
if (input.mode === "missing-field") {
  emit({ scenario: "fault", name: "result" })
  process.exit(0)
}
if (input.mode === "unknown-field") {
  emit({ scenario: "fault", name: "result", ok: true, unknown: true })
  process.exit(0)
}
if (input.mode === "invalid-pid") {
  emit({ scenario: "fault", name: "descendant-started", pid: "invalid" })
  process.exit(0)
}
if (input.mode === "holding-exit") process.exit(2)
if (input.mode === "wrong-scenario") emit({ scenario: "other", name: "result", ok: true })
if (input.mode === "unknown-event") emit({ scenario: "fault", name: "unknown" })
if (input.mode === "wrong-type") emit({ scenario: "fault", name: "result", ok: "yes" })
if (input.mode === "duplicate-holding") emit({ scenario: "fault", name: "holding" })
if (input.mode === "result-mismatch") {
  emit({ scenario: "fault", name: "result", ok: true })
  process.exit(2)
}
if (input.mode === "after-result") {
  emit({ scenario: "fault", name: "result", ok: true })
  emit({ scenario: "fault", name: "holding" })
  process.exit(0)
}
if (input.mode === "stderr-overflow") {
  process.stderr.write("x".repeat(70 * 1024))
  process.exit(0)
}
if (input.mode === "long-line") {
  process.stdout.write("x".repeat(40 * 1024))
  process.exit(0)
}

if (input.mode === "duplicate-result") {
  emit({ scenario: "fault", name: "result", mode: input.mode, ok: true })
  emit({ scenario: "fault", name: "result", mode: input.mode, ok: true })
  process.exit(0)
}

if (input.mode === "no-result") process.exit(0)

if (input.mode === "overflow" || input.mode === "overflow-exit-race") {
  process.stdout.write("x".repeat(70 * 1024))
  if (input.mode === "overflow-exit-race") {
    while (!(await Bun.file(`${input.root}/release`).exists())) await Bun.sleep(10)
  }
  process.exit(0)
}

if (input.mode === "result-hang") {
  emit({ scenario: "fault", name: "result", mode: input.mode, ok: true })
  await new Promise(() => {})
}

if (input.mode === "descendant") {
  const descendant = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 60_000)"], {
    stdout: "ignore",
    stderr: "ignore",
  })
  emit({ scenario: "fault", name: "descendant-started", mode: input.mode, pid: descendant.pid })
  await fs.writeFile(`${input.root}/descendant.pid`, String(descendant.pid))
  const command = descendantProbe(descendant.pid)
  const observer = Bun.spawn(command, {
    stdout: "pipe",
    stderr: "pipe",
  })
  const observed = await Promise.all([
    new Response(observer.stdout).text(),
    new Response(observer.stderr).text(),
    observer.exited,
  ])
  await fs.writeFile(
    `${input.root}/descendant-before.json`,
    JSON.stringify({
      command: command.join(" "),
      stdout: observed[0],
      stderr: observed[1],
      exitCode: observed[2],
      at: Date.now(),
    }),
  )
  if (observed[2] !== 0 || !listsDescendant(observed[0], descendant.pid))
    throw new Error("descendant process check failed")
  let alive = true
  try {
    process.kill(descendant.pid, 0)
  } catch {
    alive = false
  }
  if (!alive) throw new Error("descendant exited before ready")
  emit({ scenario: "fault", name: "descendant-ready", mode: input.mode, pid: descendant.pid })
  await new Promise(() => {})
}
