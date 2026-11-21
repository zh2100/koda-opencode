import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { runIsolatedWorker } from "../support/isolated-worker-runner"

afterEach(async () => {
  const result = await runIsolatedWorker({
    worker: path.join(import.meta.dir, "../fixture/lock-wait-poc-worker.ts"),
    payload: (root) =>
      Buffer.from(JSON.stringify({ scenario: "normal", root, key: "runner-recovery" })).toString("base64"),
    rootPrefix: "opencode-runner-recovery-",
    outputLimit: 65536,
    lineLimit: 65536,
    startupTimeoutMs: 10000,
    scenarioTimeoutMs: 5000,
    exitTimeoutMs: 3000,
    outputTimeoutMs: 3000,
    expectedOutcome: "success",
    parseEvent: (line) => {
      const value: unknown = JSON.parse(line)
      if (!value || typeof value !== "object" || !("name" in value) || typeof value.name !== "string")
        throw new Error("invalid recovery event")
      return value.name
    },
    isReady: (name) => name === "holding",
    isResult: (name) => name === "result",
    validateExit: (events, code) => {
      if (code !== 0 || events.join() !== "started,holding,released,result")
        throw new Error("invalid recovery lifecycle")
    },
  })
  expect(result.classification).toBe("success")
}, 20000)

function fixture(
  input: {
    text?: string
    code?: number
    hanging?: boolean
    open?: boolean
    cancelFailure?: boolean
    readerFailure?: boolean
    cancelHang?: boolean
  } = {},
) {
  const exit = Promise.withResolvers<number>()
  const stdout = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      if (input.readerFailure) {
        controller.error(new Error("reader failed"))
        return
      }
      if (input.text) controller.enqueue(Buffer.from(input.text))
      if (!input.open) controller.close()
    },
    cancel() {
      if (input.cancelFailure) throw new Error("cancel failed")
      if (input.cancelHang) return new Promise<void>(() => {})
    },
  })
  const stderr = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      controller.close()
    },
  })
  if (!input.hanging) setTimeout(() => exit.resolve(input.code ?? 0), 5)
  return { process: { pid: 1, stdout, stderr, exited: exit.promise }, exit }
}

async function run(
  input: ReturnType<typeof fixture>,
  overrides: Partial<Parameters<typeof runIsolatedWorker<string>>[0]> = {},
) {
  return runIsolatedWorker({
    worker: "injected",
    rootPrefix: "opencode-runner-unit-",
    outputLimit: 128,
    lineLimit: 64,
    startupTimeoutMs: 30,
    scenarioTimeoutMs: 30,
    exitTimeoutMs: 30,
    outputTimeoutMs: 30,
    cleanupTimeoutMs: 3000,
    parseEvent: (line) => line,
    isReady: (event) => event === "ready",
    injection: "in-memory-process",
    dependencies: {
      spawn: () => input.process,
      terminate: async () => {
        input.exit.resolve(1)
        return { command: "injected", exitCode: 0, stdout: "", stderr: "" }
      },
    },
    ...overrides,
  })
}

test("runner ready/exit race cancels old startup and scenario deadlines", async () => {
  const result = await run(fixture({ text: "ready\nresult\n" }))
  expect(result.classification).toBe("success")
  expect(result.streams).toEqual({ stdout: "eof", stderr: "eof" })
  await Bun.sleep(70)
  expect(result.timeoutStage).toBeUndefined()
  expect(result.terminationStartedAt).toBeUndefined()
  expect(result.lifecycle.map((entry) => entry.state)).toEqual([
    "created",
    "spawned",
    "observing",
    "ready",
    "running",
    "finalizing",
    "exit-confirmed",
    "output-confirmed",
    "tree-confirmed",
    "cleanup-started",
    "finished",
  ])
})

test("runner early exit is not scenario timeout", async () => {
  const result = await run(fixture({ text: "started\n", code: 2 }))
  expect(result.classification).toBe("early-exit")
  expect(result.timeoutStage).not.toBe("scenario")
})

test("runner startup timeout terminates exactly once and cleans exactly once", async () => {
  const input = fixture({ hanging: true, open: true })
  const calls = { terminate: 0, cleanup: 0 }
  const result = await run(input, {
    dependencies: {
      spawn: () => input.process,
      terminate: async () => {
        calls.terminate++
        input.exit.resolve(1)
        return { command: "injected", exitCode: 0, stdout: "", stderr: "" }
      },
      removeRoot: async (root) => {
        calls.cleanup++
        await fs.rm(root, { recursive: true, force: true })
      },
    },
  })
  expect(result.classification).toBe("output-failure")
  expect(result.streams.stdout).toBe("cancelled-and-closed")
  expect(calls).toEqual({ terminate: 1, cleanup: 1 })
})

test("runner byte overflow preserves bounded raw prefix and confirms cancellation", async () => {
  const result = await run(fixture({ text: "中".repeat(100) }), { outputLimit: 120 })
  expect(result.classification).toBe("output-failure")
  expect(Buffer.byteLength(result.rawStdout)).toBe(120)
  expect(result.streams.stdout).toBe("cancelled-and-closed")
  expect(result.cleanupStatus).toBe("removed")
})

test("runner protocol failure cannot be overridden by successful classifier", async () => {
  const result = await run(fixture({ text: "bad\n" }), {
    parseEvent: () => {
      throw new Error("bad protocol")
    },
    classify: () => "success",
  })
  expect(result.classification).toBe("protocol-failure")
  expect(result.errors.protocol).toBe("bad protocol")
  expect(result.rawStdout).toBe("bad\n")
})

test("runner failed-open output retains root", async () => {
  const result = await run(fixture({ text: "x".repeat(200), cancelFailure: true, open: true }))
  expect(result.streams.stdout).toBe("failed-open")
  expect(result.cleanupStatus).toBe("retained")
  expect(await Bun.file(`${result.root}/missing`).exists()).toBe(false)
})

test("runner exit confirmation failure retains primary and secondary errors", async () => {
  const input = fixture({ text: "ready\n", hanging: true, open: true })
  const result = await run(input, {
    dependencies: {
      spawn: () => input.process,
      terminate: async () => ({ command: "injected", exitCode: 7, stdout: "failure", stderr: "denied" }),
    },
  })
  expect(result.classification).toBe("termination-failure")
  expect(result.errors.primary).toBe("worker scenario deadline elapsed")
  expect(result.errors.termination).toContain("7")
  expect(result.errors.exitConfirmation).toBeString()
  expect(result.cleanupStatus).toBe("retained")
  input.exit.resolve(1)
})

for (const mode of ["alive", "throw", "timeout"] as const) {
  test(`runner descendant ${mode} retains root without throwing away evidence`, async () => {
    const result = await run(fixture({ text: "ready\n" }), {
      treeTimeoutMs: 20,
      descendants: async () => {
        if (mode === "throw") throw new Error("observer failed")
        if (mode === "timeout") return new Promise(() => {})
        return { ok: false, error: "still alive" }
      },
    })
    expect(result.classification).toBe("tree-failure")
    expect(result.cleanupStatus).toBe("retained")
    expect(result.errors.descendant).toBeString()
    expect(result.descendantStatus).toBe(mode === "alive" ? "descendant-declared-but-alive" : "tree-observation-failed")
  })
}

test("runner spawn and payload failures clean once without invented events", async () => {
  for (const boundary of ["spawn", "payload"] as const) {
    const input = fixture()
    const result = await run(input, {
      payload: () => {
        if (boundary === "payload") throw new Error("payload failed")
        return ""
      },
      dependencies: {
        spawn: () => {
          throw new Error("spawn failed")
        },
      },
    })
    expect(result.classification).toBe("startup-failure")
    expect(result.events).toHaveLength(0)
    expect(result.cleanupStatus).toBe("removed")
  }
})

test("runner F08 hanging termination dependency is bounded and retains root", async () => {
  const input = fixture({ text: "ready\n", open: true, hanging: true })
  const result = await run(input, {
    dependencies: {
      spawn: () => input.process,
      terminate: () => new Promise(() => {}),
    },
  })
  expect(result.classification).toBe("termination-failure")
  expect(result.errors.termination).toBe("termination timed out")
  expect(result.errors.exitConfirmation).toBeString()
  expect(result.cleanupStatus).toBe("retained")
  input.exit.resolve(1)
})

test("runner F09 cleanup rejection preserves primary protocol error and runs once", async () => {
  const input = fixture({ text: "bad\n" })
  const calls = { cleanup: 0 }
  const result = await run(input, {
    parseEvent: () => {
      throw new Error("primary protocol")
    },
    dependencies: {
      spawn: () => input.process,
      terminate: async () => {
        input.exit.resolve(1)
        return { command: "injected", exitCode: 0, stdout: "", stderr: "" }
      },
      removeRoot: async () => {
        calls.cleanup++
        throw new Error("cleanup rejected")
      },
    },
  })
  expect(result.classification).toBe("cleanup-failure")
  expect(result.errors.primary).toBe("primary protocol")
  expect(result.errors.protocol).toBe("primary protocol")
  expect(result.errors.cleanup).toBe("cleanup rejected")
  expect(result.cleanupStatus).toBe("retained")
  expect(calls.cleanup).toBe(1)
})

test("runner long-line checks individual lines rather than aggregated chunks", async () => {
  const result = await run(fixture({ text: "ready\na\nb\nc\n" }), { lineLimit: 5 })
  expect(result.classification).toBe("success")
  expect(result.descendantStatus).toBe("no-descendant-declared")
})

test("runner F06 reader rejection is observed and classified", async () => {
  const result = await run(fixture({ readerFailure: true }))
  expect(result.classification).toBe("output-failure")
  expect(result.errors.output).toBe("reader failed")
  expect(result.streams.stdout).toBe("failed-open")
  expect(result.cleanupStatus).toBe("retained")
})

test("runner F06 stalled cancellation remains failed-open and retains diagnostics", async () => {
  const result = await run(fixture({ text: "x".repeat(200), open: true, cancelHang: true }))
  expect(result.classification).toBe("output-failure")
  expect(result.streams.stdout).toBe("failed-open")
  expect(result.cleanupStatus).toBe("retained")
  expect(await Bun.file(`${result.root}/runner-evidence.json`).exists()).toBe(true)
})

test("runner rejected exit observation retains confirmation error", async () => {
  const input = fixture({ text: "ready\n", hanging: true })
  setTimeout(() => input.exit.reject(new Error("exit observation failed")), 5)
  const result = await run(input)
  expect(result.classification).toBe("termination-failure")
  expect(result.errors.exitConfirmation).toBe("exit observation failed")
  expect(result.cleanupStatus).toBe("retained")
})

test("runner result-to-exit has an independent cancelled budget", async () => {
  const result = await run(fixture({ text: "ready\nresult\n", open: true, hanging: true }), {
    isResult: (event) => event === "result",
    resultExitTimeoutMs: 10,
    scenarioTimeoutMs: 1000,
  })
  expect(result.timeoutStage).toBe("result-exit")
  expect(result.errors.primary).toBe("worker result exit deadline elapsed")
  expect(result.budgets.resultExit).toBe(10)
})

test("runner cleanup timeout retains root after cancellation-safe injected boundary", async () => {
  const input = fixture({ text: "ready\n" })
  const result = await run(input, {
    cleanupTimeoutMs: 1500,
    dependencies: {
      spawn: () => input.process,
      removeRoot: () => new Promise(() => {}),
    },
  })
  expect(result.classification).toBe("cleanup-failure")
  expect(result.errors.cleanup).toContain("cleanup timed out")
  expect(result.cleanupSnapshot).toBeString()
  expect(await Bun.file(result.cleanupSnapshot + "/runner-evidence.json").exists()).toBe(true)
  expect(await Bun.file(`${result.root}/runner-evidence.json`).exists()).toBe(true)
})

test("runner cleanup snapshot is unique and preserves an older snapshot", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-runner-snapshot-"))
  const oldSnapshot = `${root}-diagnostic-snapshot`
  await fs.mkdir(oldSnapshot, { recursive: true })
  await Bun.write(path.join(oldSnapshot, "old-marker"), "old")
  const result = await run(fixture({ text: "ready\n" }), {
    root,
    dependencies: {
      removeRoot: () => new Promise(() => {}),
    },
    cleanupTimeoutMs: 1000,
    startupTimeoutMs: 1000,
    scenarioTimeoutMs: 1000,
    exitTimeoutMs: 1000,
    outputTimeoutMs: 1000,
  })
  expect(result.cleanupStatus).toBe("retained")
  expect(result.cleanupSnapshot).not.toBe(oldSnapshot)
  expect(await Bun.file(path.join(oldSnapshot, "old-marker")).text()).toBe("old")
  await fs.rm(root, { recursive: true, force: true })
  await fs.rm(result.cleanupSnapshot!, { recursive: true, force: true })
}, 15000)

test("runner cleanup timeout preserves a complete snapshot after partial root deletion", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-runner-partial-cleanup-"))
  const marker = path.join(root, "important-marker")
  await Bun.write(marker, "before-cleanup")
  const result = await run(fixture({ text: "ready\n" }), {
    root,
    cleanupTimeoutMs: 5000,
    startupTimeoutMs: 1000,
    scenarioTimeoutMs: 1000,
    exitTimeoutMs: 1000,
    outputTimeoutMs: 1000,
    injection: "cleanup-helper-deletes-marker-then-hangs",
    dependencies: {
      spawnCleanup: (cleanupRoot) =>
        Bun.spawn(
          [
            process.execPath,
            "-e",
            "await import('node:fs/promises').then(fs => fs.rm(process.argv[1], {force:true})); setInterval(() => {}, 60000)",
            path.join(cleanupRoot, "important-marker"),
          ],
          { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
        ),
    },
  })
  expect(result.classification).toBe("cleanup-failure")
  expect(result.cleanupStatus).toBe("retained")
  expect(await Bun.file(marker).exists()).toBe(false)
  expect(result.cleanupSnapshot).toBeString()
  expect(await Bun.file(path.join(result.cleanupSnapshot!, "important-marker")).text()).toBe("before-cleanup")
  await fs.rm(root, { recursive: true, force: true })
  await fs.rm(result.cleanupSnapshot!, { recursive: true, force: true })
}, 15000)

test("runner cleanup helper bounds a non-closing stderr after the delete phase", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-runner-stderr-cleanup-"))
  const marker = path.join(root, "delete-phase-marker")
  await Bun.write(marker, "before-cleanup")
  let spawned = false
  const result = await run(fixture({ text: "ready\n" }), {
    root,
    cleanupTimeoutMs: 5000,
    startupTimeoutMs: 1000,
    scenarioTimeoutMs: 1000,
    exitTimeoutMs: 1000,
    outputTimeoutMs: 1000,
    dependencies: {
      spawnCleanup: (cleanupRoot) => {
        spawned = true
        return Bun.spawn(
          [
            process.execPath,
            "-e",
            "await import('node:fs/promises').then(fs => fs.rm(process.argv[1], {force:true})); process.stderr.write('diagnostic'); setInterval(() => {}, 60000)",
            path.join(cleanupRoot, "delete-phase-marker"),
          ],
          { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
        )
      },
    },
  })
  expect(spawned).toBe(true)
  expect(result.classification).toBe("cleanup-failure")
  expect(result.cleanupStatus).toBe("retained")
  expect(result.errors.cleanup).toContain("cleanup timed out")
  expect(result.cleanupSnapshotComplete).toBe(true)
  expect(await Bun.file(path.join(result.cleanupSnapshot!, "delete-phase-marker")).text()).toBe("before-cleanup")
  await fs.rm(root, { recursive: true, force: true })
  await fs.rm(result.cleanupSnapshot!, { recursive: true, force: true })
}, 15000)

test("runner bounds exited cleanup helper with injected open stderr", async () => {
  let entered = false
  let cancelled = false
  const result = await run(fixture({ text: "ready\n" }), {
    cleanupTimeoutMs: 5000,
    startupTimeoutMs: 1000,
    scenarioTimeoutMs: 1000,
    exitTimeoutMs: 1000,
    outputTimeoutMs: 1000,
    injection: "cleanup-exit-7-with-independent-open-stderr",
    dependencies: {
      spawnCleanup: () => {
        entered = true
        return {
          exited: Promise.resolve(7),
          stderr: new ReadableStream<Uint8Array<ArrayBuffer>>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("delete diagnostic"))
            },
            cancel() {
              cancelled = true
            },
          }),
          kill: () => {},
        }
      },
    },
  })
  expect(entered).toBe(true)
  expect(cancelled).toBe(true)
  expect(result.classification).toBe("cleanup-failure")
  expect(result.errors.cleanup).toContain("cleanup timed out")
  expect(result.errors.cleanup).toContain("exited with 7: delete diagnostic")
  expect(result.cleanupSnapshotComplete).toBe(true)
}, 15000)

test("runner closes a real hanging tree observer after the tree deadline", async () => {
  const before: { pid: number; stdout: string; exitCode: number }[] = []
  const result = await run(fixture({ text: "ready\n" }), {
    startupTimeoutMs: 1000,
    treeTimeoutMs: 3000,
    exitTimeoutMs: 1000,
    outputTimeoutMs: 1000,
    onTreeObserverReady: async (pid) => {
      if (process.platform !== "win32") return
      const check = Bun.spawn(["tasklist", "/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
        stdout: "pipe",
        stderr: "pipe",
      })
      const stdout = await new Response(check.stdout).text()
      before.push({ pid, stdout, exitCode: await check.exited })
    },
    descendants: async (_root, context) => {
      await context.observe([
        process.execPath,
        "-e",
        "process.stdout.write('ready:' + process.pid); process.stderr.write('observer-ready'); setInterval(() => {}, 60000)",
      ])
      return { ok: true }
    },
  })
  expect(result.classification).toBe("tree-failure")
  expect(result.descendantStatus).toBe("tree-observation-failed")
  expect(result.errors.descendant).toContain("descendant observation timed out")
  expect(result.observations.some((item) => item.name === "tree-observers-closed" && item.detail === "1")).toBe(true)
  expect(result.cleanupStatus).toBe("retained")
  const observer = result.treeObservers[0]!
  expect(observer.stdout).toBe(`ready:${observer.pid}`)
  expect(observer.stderr).toBe("observer-ready")
  expect(observer.abortRequested).toBe(true)
  expect(observer.killRequested).toBe(true)
  expect(observer.exitConfirmed).toBe(true)
  expect(Object.values(observer.streams).every((state) => state === "eof" || state === "cancelled-and-closed")).toBe(
    true,
  )
  if (process.platform === "win32") {
    expect(before).toHaveLength(1)
    expect(before[0]?.exitCode).toBe(0)
    expect(before[0]?.stdout).toContain(`"${observer.pid}"`)
    const check = Bun.spawn(["tasklist", "/FI", `PID eq ${observer.pid}`, "/FO", "CSV", "/NH"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const output = await new Response(check.stdout).text()
    expect(await check.exited).toBe(0)
    expect(output).not.toContain(`"${observer.pid}"`)
  }
})

test("runner observes a healthy tree helper without requesting a kill", async () => {
  const result = await run(fixture({ text: "ready\n" }), {
    treeTimeoutMs: 1000,
    exitTimeoutMs: 1000,
    outputTimeoutMs: 1000,
    descendants: async (_root, context) => {
      const result = await context.observe([
        process.execPath,
        "-e",
        "process.stdout.write('ready'); process.stderr.write('diagnostic')",
      ])
      return { ok: result.exitCode === 0 }
    },
  })
  expect(result.classification).toBe("success")
  expect(result.treeObservers[0]).toMatchObject({
    stdout: "ready",
    stderr: "diagnostic",
    exitConfirmed: true,
    killRequested: false,
    streams: { stdout: "eof", stderr: "eof" },
  })
})

test("runner F08 terminator helper timeout kills and confirms the helper", async () => {
  const input = fixture({ text: "ready\n", open: true, hanging: true })
  const result = await run(input, {
    injection: "taskkill-helper-replaced-with-real-hanging-bun-process",
    dependencies: {
      spawn: () => input.process,
      spawnTaskkill: () =>
        Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 60000)"], {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        }),
    },
    exitTimeoutMs: 300,
  })
  expect(result.classification).toBe("termination-failure")
  expect(result.termination?.helperExitConfirmed).toBe(true)
  expect(result.errors.termination).toBe("taskkill did not exit")
  expect(result.cleanupStatus).toBe("retained")
  input.exit.resolve(1)
})

for (const phase of ["create", "copy", "delete", "reclaim"] as const) {
  test(`runner records interrupted cleanup ${phase} and starts no later phase`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-cleanup-phase-"))
    await Bun.write(path.join(root, "marker"), "original")
    const entered: string[] = []
    const result = await run(fixture({ text: "ready\n" }), {
      root,
      cleanupTimeoutMs: 3000,
      startupTimeoutMs: 1000,
      scenarioTimeoutMs: 1000,
      exitTimeoutMs: 1000,
      outputTimeoutMs: 1000,
      dependencies: {
        spawnCleanupPhase: (current, command) => {
          entered.push(current)
          if (current !== phase) return Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "pipe" })
          return Bun.spawn(
            [process.execPath, "-e", "process.stderr.write('phase-ready'); setInterval(() => {}, 60000)"],
            { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
          )
        },
      },
    })
    expect(result.classification).toBe("cleanup-failure")
    expect(entered.at(-1)).toBe(phase)
    expect(result.cleanupDetails?.phase).toBe(phase)
    const helper = result.cleanupDetails?.helpers.at(-1)
    expect(helper?.rawStderr).toBe("phase-ready")
    expect(helper?.killRequested).toBe(true)
    expect(helper?.exitConfirmed).toBe(true)
    expect(["eof", "cancelled-and-closed"]).toContain(helper!.stderr)
    expect(result.cleanupDetails?.elapsedMs).toBeLessThan(4500)
    expect(result.cleanupSnapshotComplete).toBe(phase === "delete")
    expect(result.cleanupDetails?.root).toBe(
      phase === "reclaim" ? "removed" : phase === "delete" ? "deletion-unconfirmed" : "untouched",
    )
    expect(
      await fs.stat(root).then(
        () => true,
        () => false,
      ),
    ).toBe(phase !== "reclaim")
    await fs.rm(root, { recursive: true, force: true })
    if (result.cleanupSnapshot) await fs.rm(result.cleanupSnapshot, { recursive: true, force: true })
  }, 15000)
}

test("runner stops cleanup when helper exit and reader cancellation cannot be confirmed", async () => {
  const phases: string[] = []
  const result = await run(fixture({ text: "ready\n" }), {
    cleanupTimeoutMs: 100,
    startupTimeoutMs: 1000,
    scenarioTimeoutMs: 1000,
    exitTimeoutMs: 1000,
    outputTimeoutMs: 1000,
    dependencies: {
      spawnCleanupPhase: (phase) => {
        phases.push(phase)
        return {
          exited: new Promise<number>(() => {}),
          kill: () => {},
          stderr: new ReadableStream<Uint8Array<ArrayBuffer>>({ cancel: () => new Promise<void>(() => {}) }),
        }
      },
    },
  })
  expect(phases).toEqual(["create"])
  expect(result.classification).toBe("cleanup-failure")
  expect(result.cleanupDetails?.helpers[0]?.exitConfirmed).toBe(false)
  expect(result.errors.cleanup).toContain("exit not confirmed")
  expect(await Bun.file(path.join(result.root, "runner-evidence.json")).exists()).toBe(false)
  await fs.rm(result.root, { recursive: true, force: true })
}, 15000)

for (const phase of ["copy", "reclaim"] as const) {
  test(`runner preserves actual partial snapshot ${phase} evidence`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-partial-snapshot-"))
    await Bun.write(path.join(root, "first"), "first-original")
    await Bun.write(path.join(root, "second"), "second-original")
    const phases: string[] = []
    const result = await run(fixture({ text: "ready\n" }), {
      root,
      startupTimeoutMs: 1000,
      scenarioTimeoutMs: 1000,
      exitTimeoutMs: 1000,
      outputTimeoutMs: 1000,
      cleanupTimeoutMs: 3000,
      dependencies: {
        spawnCleanupPhase: (current, command) => {
          phases.push(current)
          if (current !== phase) return Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "pipe" })
          const script =
            phase === "copy"
              ? "const fs = await import('node:fs/promises'); const path = await import('node:path'); await fs.copyFile(path.join(process.argv[1], 'first'), path.join(process.argv[2], 'first')); process.stderr.write('partial-copy-ready'); setInterval(() => {}, 60000)"
              : "const fs = await import('node:fs/promises'); const path = await import('node:path'); await fs.rm(path.join(process.argv[1], 'first')); process.stderr.write('partial-reclaim-ready'); setInterval(() => {}, 60000)"
          return Bun.spawn([process.execPath, "-e", script, ...command.slice(3)], {
            stdin: "ignore",
            stdout: "ignore",
            stderr: "pipe",
          })
        },
      },
    })
    expect(result.classification).toBe("cleanup-failure")
    expect(phases.at(-1)).toBe(phase)
    expect(result.cleanupSnapshotComplete).toBe(false)
    expect(result.cleanupDetails?.snapshot).toBe(phase === "copy" ? "copy-incomplete" : "reclaim-incomplete")
    expect(result.cleanupDetails?.helpers.at(-1)).toMatchObject({
      exitConfirmed: true,
      killRequested: true,
      rawStderr: `partial-${phase}-ready`,
    })
    expect(await Bun.file(path.join(result.cleanupSnapshot!, "first")).exists()).toBe(phase === "copy")
    expect(await Bun.file(path.join(result.cleanupSnapshot!, "second")).exists()).toBe(phase === "reclaim")
    expect(await Bun.file(path.join(result.cleanupSnapshot!, phase === "copy" ? "first" : "second")).text()).toBe(
      phase === "copy" ? "first-original" : "second-original",
    )
    expect(
      await fs.stat(root).then(
        () => true,
        () => false,
      ),
    ).toBe(phase === "copy")
    await fs.rm(root, { recursive: true, force: true })
    await fs.rm(result.cleanupSnapshot!, { recursive: true, force: true })
  }, 15000)
}
