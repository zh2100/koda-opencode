import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

type StreamState = "pending" | "eof" | "cancelled-and-closed" | "failed-open"
type CleanupStatus = "removed" | "retained" | "not-attempted"
type CleanupPhase = "create" | "copy" | "delete" | "reclaim"
type CleanupProcess = Pick<Bun.Subprocess<"ignore", "ignore", "pipe">, "exited" | "stderr" | "kill">
type TreeObserverEvidence = {
  pid: number
  command: string
  stdout: string
  stderr: string
  streams: { stdout: StreamState; stderr: StreamState }
  exitConfirmed: boolean
  exitCode?: number
  abortRequested: boolean
  killRequested: boolean
}
type CleanupDetails = {
  phase: CleanupPhase
  root: "untouched" | "deletion-unconfirmed" | "removed"
  snapshot: "creation-unconfirmed" | "empty" | "copy-incomplete" | "complete" | "reclaim-incomplete" | "removed"
  workBudgetMs: number
  settleBudgetMs: number
  elapsedMs: number
  helpers: {
    phase: CleanupPhase
    exitConfirmed: boolean
    stderr: StreamState
    rawStderr: string
    exitCode?: number
    killRequested: boolean
    error?: string
  }[]
}
type TimeoutStage = "startup" | "ready" | "scenario" | "result-exit" | "termination" | "output" | "tree" | "cleanup"
type LifecycleState =
  | "created"
  | "spawned"
  | "observing"
  | "ready"
  | "running"
  | "finalizing"
  | "exit-confirmed"
  | "output-confirmed"
  | "tree-confirmed"
  | "cleanup-started"
  | "finished"

export type WorkerClassification =
  | "success"
  | "business-failure"
  | "startup-failure"
  | "protocol-failure"
  | "early-exit"
  | "early-exit-after-ready"
  | "scenario-timeout"
  | "termination-failure"
  | "output-failure"
  | "tree-failure"
  | "cleanup-failure"
  | "unknown-failure"
  | "result-exit-timeout"

export type WorkerExpectedOutcome = "success" | "business-failure" | "protocol-failure" | "timeout-failure"

export type WorkerEvidence<T> = {
  readonly root: string
  readonly pid?: number
  readonly events: readonly T[]
  readonly rawStdout: string
  readonly rawStderr: string
  readonly exit?: { readonly exitCode: number | null; readonly signal: "unavailable" }
  readonly readyAt?: number
  readonly deadlineAt?: number
  readonly timeoutStage?: TimeoutStage
  readonly terminationStartedAt?: number
  readonly termination?: {
    readonly command: string
    readonly exitCode?: number
    readonly stdout: string
    readonly stderr: string
    readonly error?: string
    readonly helperExitConfirmed?: boolean
  }
  readonly errors: {
    readonly primary?: string
    readonly protocol?: string
    readonly output?: string
    readonly termination?: string
    readonly exitConfirmation?: string
    readonly descendant?: string
    readonly cleanup?: string
  }
  readonly descendantStatus?:
    | "no-descendant-declared"
    | "descendant-declared-and-gone"
    | "descendant-declared-but-alive"
    | "tree-observation-failed"
  readonly descendantEvidence?: {
    readonly command?: string
    readonly stdout?: string
    readonly stderr?: string
  }
  readonly cleanupStatus: CleanupStatus
  readonly cleanupSnapshot?: string
  readonly cleanupSnapshotComplete?: boolean
  readonly cleanupDetails?: CleanupDetails
  readonly treeObservers: readonly TreeObserverEvidence[]
  readonly observations: readonly { readonly name: string; readonly at: number; readonly detail: string }[]
  readonly streams: { readonly stdout: StreamState; readonly stderr: StreamState }
  readonly classification: WorkerClassification
  readonly expectedOutcome?: WorkerExpectedOutcome
  readonly injection?: string
  readonly lifecycle: readonly { readonly state: LifecycleState; readonly at: number; readonly reason: string }[]
  readonly budgets: {
    readonly startup: number
    readonly ready: number
    readonly scenario: number
    readonly resultExit: number
    readonly exit: number
    readonly output: number
    readonly tree: number
    readonly cleanup: number
  }
}

type TerminationEvidence = NonNullable<WorkerEvidence<unknown>["termination"]>
type WorkerProcess = Pick<Bun.Subprocess, "pid" | "exited" | "stdout" | "stderr">

type Dependencies = {
  readonly spawn?: (command: string[], options: { cwd?: string; stdout: "pipe"; stderr: "pipe" }) => WorkerProcess
  readonly now?: () => number
  readonly removeRoot?: (root: string) => Promise<void>
  readonly terminate?: (pid: number, timeoutMs: number) => Promise<TerminationEvidence>
  readonly spawnTaskkill?: (pid: number) => Bun.Subprocess<"ignore", "pipe", "pipe">
  readonly spawnCleanup?: (
    root: string,
  ) => Pick<Bun.Subprocess<"ignore", "ignore", "pipe">, "exited" | "stderr" | "kill">
  readonly spawnCleanupPhase?: (phase: CleanupPhase, command: string[]) => CleanupProcess
}

type Options<T> = {
  readonly worker: string
  readonly payload?: string | ((root: string) => string)
  readonly cwd?: string
  readonly rootPrefix: string
  readonly outputLimit: number
  readonly lineLimit: number
  readonly startupTimeoutMs: number
  readonly readyTimeoutMs?: number
  readonly resultExitTimeoutMs?: number
  readonly scenarioTimeoutMs: number
  readonly describeScenarioTimeout?: () => string
  readonly exitTimeoutMs: number
  readonly outputTimeoutMs: number
  readonly treeTimeoutMs?: number
  readonly cleanupTimeoutMs?: number
  readonly root?: string
  readonly parseEvent: (line: string) => T
  readonly onEvent?: (event: T) => void
  readonly isReady?: (event: T) => boolean
  readonly isResult?: (event: T) => boolean
  readonly validateExit?: (events: readonly T[], exitCode: number | null) => void
  readonly classify?: (events: readonly T[], exitCode: number | null, timedOut: boolean) => WorkerClassification
  readonly expectedOutcome?: WorkerExpectedOutcome
  readonly injection?: string
  readonly descendants?: (
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
  ) => Promise<{
    readonly ok: boolean
    readonly status?:
      | "no-descendant-declared"
      | "descendant-declared-and-gone"
      | "descendant-declared-but-alive"
      | "tree-observation-failed"
    readonly error?: string
    readonly evidence?: {
      readonly command?: string
      readonly stdout?: string
      readonly stderr?: string
    }
  }>
  readonly dependencies?: Dependencies
  readonly onTreeObserverReady?: (pid: number) => Promise<void>
}

export async function runIsolatedWorker<T>(options: Options<T>): Promise<WorkerEvidence<T>> {
  const now = options.dependencies?.now ?? Date.now
  const root = options.root ?? (await fs.mkdtemp(path.join(os.tmpdir(), options.rootPrefix)))
  const errors: {
    primary?: string
    protocol?: string
    output?: string
    termination?: string
    exitConfirmation?: string
    descendant?: string
    cleanup?: string
  } = {}
  const events: T[] = []
  const ready = deferred()
  const started = deferred()
  const result = deferred()
  const observationFailure = deferred<string>()
  const raw = { stdout: "", stderr: "" }
  const streams = { stdout: "pending" as StreamState, stderr: "pending" as StreamState }
  let child: WorkerProcess | undefined
  let exit: { exitCode: number | null; signal: "unavailable" } | undefined
  let readyAt: number | undefined
  let deadlineAt: number | undefined
  let timeoutStage: TimeoutStage | undefined
  let terminationStartedAt: number | undefined
  let termination: TerminationEvidence | undefined
  let timedOut = false
  let protocolFailed = false
  let outputFailed = false
  let childExited = false
  let cleanupStatus: CleanupStatus = "not-attempted"
  let cleanupSnapshot: string | undefined
  let cleanupSnapshotComplete = false
  let cleanupDetails: CleanupDetails | undefined
  const treeObservers: TreeObserverEvidence[] = []
  let descendantsOk = true
  let descendantStatus: WorkerEvidence<T>["descendantStatus"]
  let descendantEvidence: WorkerEvidence<T>["descendantEvidence"]
  let earlyExit = false
  let resultSeen = false
  let finalized: Promise<WorkerEvidence<T>> | undefined
  const lifecycle: { state: LifecycleState; at: number; reason: string }[] = []
  const observations: { name: string; at: number; detail: string }[] = []
  const observe = (name: string, detail: string) => {
    observations.push({ name, at: now(), detail })
  }
  transition("created", "root allocated")

  try {
    const parsePayload =
      options.payload === undefined
        ? []
        : [typeof options.payload === "function" ? options.payload(root) : options.payload]
    child = (options.dependencies?.spawn ?? Bun.spawn)([process.execPath, options.worker, ...parsePayload], {
      cwd: options.cwd,
      detached: process.platform !== "win32",
      stdout: "pipe",
      stderr: "pipe",
    })
    transition("spawned", "spawn returned a process handle")
  } catch (error) {
    errors.primary = stringify(error)
    return finalizeOnce()
  }

  const exitPromise = child.exited.then(
    (exitCode) => {
      childExited = true
      exit = { exitCode, signal: "unavailable" }
      observe("child-exited", String(exitCode))
      return exit
    },
    (error) => {
      errors.exitConfirmation = stringify(error)
      throw error
    },
  )
  void exitPromise.catch(() => undefined)
  if (!(child.stdout instanceof ReadableStream) || !(child.stderr instanceof ReadableStream)) {
    errors.primary = "worker stdout/stderr was not piped"
    return finalizeOnce()
  }
  const stdoutController = new AbortController()
  const stderrController = new AbortController()
  const stdoutPromise = readStream(
    child.stdout,
    options.outputLimit,
    options.lineLimit,
    stdoutController.signal,
    options.outputTimeoutMs,
    (text) => {
      raw.stdout = text
    },
    (line) => {
      try {
        const event = options.parseEvent(line.text)
        events.push(event)
        options.onEvent?.(event)
        observe("event", line.text)
        started.resolve(undefined)
        if (options.isResult?.(event)) {
          resultSeen = true
          observe("result-seen", "validated terminal event")
          result.resolve(undefined)
        }
        if (options.isReady?.(event) && readyAt === undefined) {
          readyAt = now()
          ready.resolve(undefined)
        }
      } catch (error) {
        protocolFailed = true
        errors.protocol ??= stringify(error)
        observationFailure.resolve(errors.protocol)
        throw error
      }
    },
  )
  const stderrPromise = readStream(
    child.stderr,
    options.outputLimit,
    options.lineLimit,
    stderrController.signal,
    options.outputTimeoutMs,
    (text) => {
      raw.stderr = text
    },
    () => {},
  )
  const stdoutSettled = stdoutPromise.then(
    (text) => {
      raw.stdout = text
      streams.stdout = "eof"
      observe("stdout-closed", "eof")
      return text
    },
    (error) => {
      streams.stdout = error instanceof ClosedReaderError ? "cancelled-and-closed" : "failed-open"
      observe("stdout-closed", streams.stdout)
      outputFailed = true
      errors.output ??= stringify(error)
      observationFailure.resolve(errors.output)
      throw error
    },
  )
  const stderrSettled = stderrPromise.then(
    (text) => {
      raw.stderr = text
      streams.stderr = "eof"
      observe("stderr-closed", "eof")
      return text
    },
    (error) => {
      streams.stderr = error instanceof ClosedReaderError ? "cancelled-and-closed" : "failed-open"
      observe("stderr-closed", streams.stderr)
      outputFailed = true
      errors.output ??= stringify(error)
      observationFailure.resolve(errors.output)
      throw error
    },
  )
  // Observe rejections immediately, including while the scenario is still running.
  void stdoutSettled.catch(() => undefined)
  void stderrSettled.catch(() => undefined)
  transition("observing", "exit and output observers registered")

  try {
    await waitUntilReady(options.startupTimeoutMs, exitPromise, stdoutSettled, stderrSettled, started.promise, () => {
      timeoutStage = "startup"
      deadlineAt = now()
    })
    await waitUntilReady(
      options.readyTimeoutMs ?? options.startupTimeoutMs,
      exitPromise,
      stdoutSettled,
      stderrSettled,
      ready.promise,
      () => {
        timeoutStage = "ready"
        deadlineAt = now()
      },
    )
    transition("ready", "ready event validated")
    transition("running", "scenario budget started")
    if (options.scenarioTimeoutMs > 0) {
      const scenario = await waitForScenario(
        options.scenarioTimeoutMs,
        exitPromise,
        observationFailure.promise,
        result.promise,
      )
      if (scenario === "result") {
        try {
          await bounded(
            Promise.race([
              exitPromise,
              observationFailure.promise.then(() => {
                throw new Error("worker observation failed")
              }),
            ]),
            options.resultExitTimeoutMs ?? options.exitTimeoutMs,
            "worker result exit deadline elapsed",
          )
        } catch (error) {
          if (!protocolFailed && !outputFailed) {
            timedOut = true
            timeoutStage = "result-exit"
            deadlineAt = now()
          }
          throw error
        }
      }
      if (scenario === "timeout") {
        timedOut = true
        timeoutStage = "scenario"
        deadlineAt = now()
        errors.primary = "worker scenario deadline elapsed"
        if (options.describeScenarioTimeout) errors.primary += `; ${options.describeScenarioTimeout()}`
        await terminateOnce()
      }
      if (scenario === "failure") throw new Error("worker observation failed")
    }
    if (!childExited) await waitForExit(exitPromise, options.exitTimeoutMs)
  } catch (error) {
    errors.primary ??= stringify(error)
    if (
      errors.primary.includes("exited before ready") ||
      errors.primary.includes("stdout ended before ready") ||
      errors.primary.includes("stderr ended before ready")
    ) {
      earlyExit = true
    }
    if (errors.primary.includes("did not exit")) {
      timeoutStage ??= "termination"
      errors.exitConfirmation = errors.primary
    }
    if ((earlyExit || protocolFailed || outputFailed) && !childExited) {
      await waitForExit(exitPromise, Math.min(options.exitTimeoutMs, 100)).catch(() => undefined)
    }
  }

  return finalizeOnce()

  function finalizeOnce() {
    finalized ??= finalize()
    return finalized
  }

  async function finalize(): Promise<WorkerEvidence<T>> {
    transition("finalizing", errors.primary ?? "worker completed")
    if (child && !childExited) await terminateOnce()
    if (!child) {
      const cleanup = await removeRoot(
        root,
        options.dependencies?.removeRoot,
        options.cleanupTimeoutMs ?? options.exitTimeoutMs,
        options.dependencies?.spawnCleanup,
        options.dependencies?.spawnCleanupPhase,
      )
      cleanupStatus = cleanup.status
      cleanupSnapshot = cleanup.snapshot
      cleanupSnapshotComplete = cleanup.snapshotComplete
      cleanupDetails = cleanup.details
      errors.cleanup = cleanup.error
      return makeEvidence(errors.cleanup ? "cleanup-failure" : "startup-failure")
    }
    // A handle without observable pipes is retained even after termination.
    if (!(child.stdout instanceof ReadableStream) || !(child.stderr instanceof ReadableStream)) {
      cleanupStatus = "retained"
      return makeEvidence("startup-failure")
    }
    if (childExited) transition("exit-confirmed", "child.exited fulfilled")
    try {
      await bounded(
        Promise.allSettled([stdoutSettled, stderrSettled]),
        options.outputTimeoutMs,
        "worker output did not finish",
      )
    } catch (error) {
      errors.output ??= stringify(error)
      outputFailed = true
      timeoutStage ??= "output"
      stdoutController.abort()
      stderrController.abort()
      await bounded(
        Promise.allSettled([stdoutSettled, stderrSettled]),
        options.outputTimeoutMs,
        "reader cancellation did not finish",
      ).catch((error) => {
        errors.output += `; ${stringify(error)}`
      })
    }
    if ([streams.stdout, streams.stderr].every((state) => state === "eof" || state === "cancelled-and-closed"))
      transition("output-confirmed", "both readers closed")
    if (!childExited) {
      errors.exitConfirmation ??= "worker exit was not confirmed"
      timeoutStage ??= "termination"
    }
    if (options.descendants) {
      const controller = new AbortController()
      const pending = new Set<Promise<unknown>>()
      const helpers: Bun.Subprocess<"ignore", "pipe", "pipe">[] = []
      try {
        const result = await bounded(
          options.descendants(root, {
            signal: controller.signal,
            observe: (command) => {
              if (controller.signal.aborted) return Promise.reject(new Error("tree observation cancelled"))
              const helper = Bun.spawn(command, { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
              helpers.push(helper)
              const output: TreeObserverEvidence = {
                pid: helper.pid,
                command: command.join(" "),
                stdout: "",
                stderr: "",
                streams: { stdout: "pending", stderr: "pending" },
                exitConfirmed: false,
                abortRequested: false,
                killRequested: false,
              }
              treeObservers.push(output)
              const ready = deferred()
              const exited = helper.exited.then((code) => {
                output.exitConfirmed = true
                output.exitCode = code
                return code
              })
              const reads = Promise.allSettled([
                readStream(
                  helper.stdout,
                  options.outputLimit,
                  options.lineLimit,
                  controller.signal,
                  options.outputTimeoutMs,
                  (text) => {
                    output.stdout = text
                    if (text.includes(`ready:${helper.pid}`)) ready.resolve()
                  },
                  () => {},
                ),
                readStream(
                  helper.stderr,
                  options.outputLimit,
                  options.lineLimit,
                  controller.signal,
                  options.outputTimeoutMs,
                  (text) => {
                    output.stderr = text
                  },
                  () => {},
                ),
              ])
              const operation = Promise.all([exited, reads]).then(([exitCode, streams]) => {
                streams.forEach((item, index) => {
                  output.streams[index === 0 ? "stdout" : "stderr"] =
                    item.status === "fulfilled"
                      ? "eof"
                      : item.reason instanceof ClosedReaderError
                        ? "cancelled-and-closed"
                        : "failed-open"
                })
                if (
                  streams.some(
                    (item) =>
                      item.status === "rejected" &&
                      !(
                        item.reason instanceof ClosedReaderError &&
                        item.reason.message === "worker output drain cancelled"
                      ),
                  )
                )
                  throw new Error("tree observer output failed")
                observe("tree-observer-exited", `${command.join(" ")} exit=${exitCode}`)
                return { ...output, exitCode, at: now() }
              })
              pending.add(operation)
              void operation.catch(() => undefined)
              if (options.onTreeObserverReady) {
                const handshake = bounded(
                  ready.promise,
                  options.startupTimeoutMs,
                  "tree observer ready not confirmed",
                ).then(() => options.onTreeObserverReady!(helper.pid))
                pending.add(handshake)
                void handshake.catch(() => undefined)
              }
              return operation
            },
          }),
          options.treeTimeoutMs ?? options.exitTimeoutMs,
          "descendant observation timed out",
        )
        descendantsOk = result.ok
        descendantStatus =
          result.status ?? (result.ok ? "descendant-declared-and-gone" : "descendant-declared-but-alive")
        descendantEvidence = result.evidence
        if (!result.ok) errors.descendant = result.error ?? "descendant exit was not confirmed"
      } catch (error) {
        descendantsOk = false
        descendantStatus = "tree-observation-failed"
        errors.descendant = stringify(error)
        timeoutStage ??= "tree"
      } finally {
        controller.abort()
        helpers.forEach((helper, index) => {
          treeObservers[index]!.abortRequested = true
          if (helper.exitCode !== null) return
          treeObservers[index]!.killRequested = true
          helper.kill()
        })
        try {
          await bounded(
            Promise.all(helpers.map((helper) => helper.exited)),
            options.exitTimeoutMs,
            "tree observer exit not confirmed",
          )
          const settled = await bounded(
            Promise.allSettled([...pending]),
            options.outputTimeoutMs,
            "tree observer output not closed",
          )
          const failed = settled.find((item) => item.status === "rejected")
          if (failed?.status === "rejected") throw failed.reason
          observe("tree-observers-closed", String(helpers.length))
        } catch (error) {
          descendantsOk = false
          descendantStatus = "tree-observation-failed"
          errors.descendant = [errors.descendant, stringify(error)].filter(Boolean).join("; ")
        }
      }
    }
    descendantStatus ??= "no-descendant-declared"
    if (descendantsOk) transition("tree-confirmed", descendantStatus)
    const closed = (state: StreamState) => state === "eof" || state === "cancelled-and-closed"
    // taskkill may look up the PID after the worker has exited on its own.
    // Keep the helper's raw evidence; reconcile only the exact missing-target diagnostic.
    if (
      process.platform === "win32" &&
      termination?.command === `taskkill /pid ${child.pid} /T /F` &&
      termination.exitCode === 128 &&
      termination.helperExitConfirmed &&
      !termination.error &&
      termination.stderr.trim() === `ERROR: The process "${child.pid}" not found.` &&
      childExited && !errors.exitConfirmation && closed(streams.stdout) && closed(streams.stderr) && descendantsOk
    ) delete errors.termination
    if (!timedOut && !protocolFailed && !outputFailed && readyAt !== undefined && childExited && options.validateExit) {
      try {
        options.validateExit(events, exit?.exitCode ?? null)
      } catch (error) {
        earlyExit = events.length > 0 && !resultSeen && exit?.exitCode !== 0
        protocolFailed = !earlyExit
        errors.protocol = stringify(error)
        errors.primary ??= errors.protocol
      }
    }

    const infrastructure = defaultClassification({
      events,
      exitCode: exit?.exitCode ?? null,
      timedOut,
      protocolFailed,
      outputFailed,
      childExited,
      descendantsOk,
      earlyExit,
      errors,
    })
    const classification =
      infrastructure === "early-exit" && readyAt !== undefined
        ? "early-exit-after-ready"
        : infrastructure === "scenario-timeout" && resultSeen
          ? "result-exit-timeout"
          : ["success", "business-failure", "unknown-failure"].includes(infrastructure)
            ? (options.classify?.(events, exit?.exitCode ?? null, timedOut) ?? infrastructure)
            : infrastructure
    const canCleanup =
      childExited &&
      closed(streams.stdout) &&
      closed(streams.stderr) &&
      descendantsOk &&
      errors.exitConfirmation === undefined &&
      errors.termination === undefined
    if (canCleanup) {
      transition("cleanup-started", "exit, output and tree confirmed")
      const cleanup = await removeRoot(
        root,
        options.dependencies?.removeRoot,
        options.cleanupTimeoutMs ?? options.exitTimeoutMs,
        options.dependencies?.spawnCleanup,
        options.dependencies?.spawnCleanupPhase,
      )
      cleanupStatus = cleanup.status
      cleanupSnapshot = cleanup.snapshot
      cleanupSnapshotComplete = cleanup.snapshotComplete
      cleanupDetails = cleanup.details
      if (cleanup.error) errors.cleanup = cleanup.error
    } else {
      cleanupStatus = "retained"
    }
    if (errors.cleanup) return makeEvidence("cleanup-failure")
    return makeEvidence(classification)
  }

  async function terminateOnce() {
    if (terminationStartedAt !== undefined || child === undefined || childExited) return
    terminationStartedAt = now()
    observe("termination-started", String(child.pid))
    try {
      termination = options.dependencies?.terminate
        ? await bounded(
            options.dependencies.terminate(child.pid, options.exitTimeoutMs),
            options.exitTimeoutMs,
            "termination timed out",
          )
        : await terminateProcess(child.pid, options.exitTimeoutMs, options.dependencies?.spawnTaskkill)
      if (termination.exitCode !== undefined && termination.exitCode !== 0) {
        errors.termination = `termination command exited with ${termination.exitCode}`
      }
      errors.termination ??= termination.error
    } catch (error) {
      errors.termination = stringify(error)
      timeoutStage ??= "termination"
    }
    if (!childExited) {
      try {
        await waitForExit(exitPromise, options.exitTimeoutMs)
      } catch (error) {
        errors.exitConfirmation = stringify(error)
        timeoutStage ??= "termination"
      }
    }
  }

  async function makeEvidence(finalClassification: WorkerClassification): Promise<WorkerEvidence<T>> {
    transition("finished", `${finalClassification}; root ${cleanupStatus}`)
    const evidence: WorkerEvidence<T> = {
      root,
      ...(child === undefined ? {} : { pid: child.pid }),
      events,
      rawStdout: raw.stdout,
      rawStderr: raw.stderr,
      ...(exit === undefined ? {} : { exit }),
      ...(readyAt === undefined ? {} : { readyAt }),
      ...(deadlineAt === undefined ? {} : { deadlineAt }),
      ...(timeoutStage === undefined ? {} : { timeoutStage }),
      ...(terminationStartedAt === undefined ? {} : { terminationStartedAt }),
      ...(termination === undefined ? {} : { termination }),
      errors,
      ...(descendantStatus === undefined ? {} : { descendantStatus }),
      ...(descendantEvidence === undefined ? {} : { descendantEvidence }),
      cleanupStatus,
      cleanupDetails,
      treeObservers,
      ...(cleanupSnapshot === undefined ? {} : { cleanupSnapshot }),
      ...(cleanupSnapshot === undefined ? {} : { cleanupSnapshotComplete }),
      observations: [...observations],
      streams,
      classification: finalClassification,
      lifecycle,
      budgets: {
        startup: options.startupTimeoutMs,
        ready: options.readyTimeoutMs ?? options.startupTimeoutMs,
        scenario: options.scenarioTimeoutMs,
        resultExit: options.resultExitTimeoutMs ?? options.exitTimeoutMs,
        exit: options.exitTimeoutMs,
        output: options.outputTimeoutMs,
        tree: options.treeTimeoutMs ?? options.exitTimeoutMs,
        cleanup: options.cleanupTimeoutMs ?? options.exitTimeoutMs,
      },
      ...(options.expectedOutcome === undefined ? {} : { expectedOutcome: options.expectedOutcome }),
      ...(options.injection === undefined ? {} : { injection: options.injection }),
    }
    if (process.env.A3_EVIDENCE_DIR) {
      await fs.mkdir(process.env.A3_EVIDENCE_DIR, { recursive: true })
      await Bun.write(
        path.join(process.env.A3_EVIDENCE_DIR, `${path.basename(root)}.json`),
        JSON.stringify(evidence, null, 2),
      )
    }
    if (
      cleanupStatus === "retained" &&
      !cleanupDetails?.helpers.some(
        (helper) => !helper.exitConfirmed || helper.stderr === "failed-open" || helper.stderr === "pending",
      )
    ) {
      // Never recreate deleted directories or write while an unconfirmed helper may mutate them.
      const targets = [root, cleanupSnapshot].filter((target): target is string => target !== undefined)
      await Promise.all(
        targets.map(async (target) => {
          if (
            !(await fs.stat(target).then(
              (entry) => entry.isDirectory(),
              () => false,
            ))
          )
            return
          await fs.writeFile(path.join(target, "runner-evidence.json"), JSON.stringify(evidence, null, 2))
        }),
      )
    }
    return evidence
  }

  function transition(state: LifecycleState, reason: string) {
    const order: LifecycleState[] = [
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
    ]
    const previous = lifecycle.at(-1)
    if (previous && order.indexOf(state) <= order.indexOf(previous.state))
      throw new Error(`invalid lifecycle transition ${previous.state} -> ${state}`)
    lifecycle.push({ state, at: now(), reason })
  }
}

async function waitUntilReady(
  timeoutMs: number,
  exit: Promise<{ readonly exitCode: number | null; readonly signal: "unavailable" }>,
  stdout: Promise<string>,
  stderr: Promise<string>,
  ready: Promise<void>,
  onTimeout: () => void,
) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout()
      reject(new Error("worker did not become ready"))
    }, timeoutMs)
  })
  try {
    await Promise.race([
      timeout,
      exit.then(() => Promise.reject(new Error("worker exited before ready"))),
      stdout.then(() => Promise.reject(new Error("worker stdout ended before ready"))),
      stderr.then(() => new Promise<never>(() => {})),
      ready,
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function waitForScenario(
  timeoutMs: number,
  exit: Promise<{ readonly exitCode: number | null; readonly signal: "unavailable" }>,
  failure: Promise<string>,
  result: Promise<void>,
): Promise<"exit" | "timeout" | "failure" | "result"> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs)
  })
  try {
    return await Promise.race([
      deadline,
      exit.then(() => "exit" as const),
      failure.then(() => "failure" as const),
      result.then(() => "result" as const),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function waitForExit(exit: Promise<unknown>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("worker did not exit")), timeoutMs)
  })
  try {
    await Promise.race([exit, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function readStream(
  stream: ReadableStream<Uint8Array>,
  byteLimit: number,
  lineLimit: number,
  signal: AbortSignal,
  timeoutMs: number,
  onText: (text: string) => void,
  onLine: (line: { readonly text: string; readonly raw: string }) => void,
) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const chunks: Uint8Array[] = []
  let size = 0
  let pending = ""
  const aborted = deferred()
  const abort = () => aborted.resolve(undefined)
  signal.addEventListener("abort", abort, { once: true })
  try {
    while (true) {
      const chunk = await Promise.race([
        reader.read(),
        aborted.promise.then(() => {
          throw new Error("worker output drain cancelled")
        }),
      ])
      if (chunk.value) {
        chunks.push(chunk.value.subarray(0, Math.max(0, byteLimit - size)))
        onText(Buffer.concat(chunks).toString("utf8"))
        size += chunk.value.byteLength
        if (size > byteLimit) throw new Error("worker output exceeded byte limit")
        pending += decoder.decode(chunk.value, { stream: true })
        const lines = pending.split("\n")
        pending = lines.pop() ?? ""
        if (Buffer.byteLength(pending) > lineLimit) throw new Error("worker line exceeded limit")
        for (const line of lines.filter(Boolean)) {
          if (Buffer.byteLength(line) > lineLimit) throw new Error("worker line exceeded limit")
          onLine({ text: line, raw: `${line}\n` })
        }
      }
      if (chunk.done) {
        pending += decoder.decode()
        if (Buffer.byteLength(pending) > lineLimit) throw new Error("worker line exceeded limit")
        if (pending) onLine({ text: pending, raw: pending })
        return Buffer.concat(chunks).toString("utf8")
      }
    }
  } catch (error) {
    await bounded(reader.cancel(error), timeoutMs, "reader cancellation failed")
    throw new ClosedReaderError(stringify(error))
  } finally {
    signal.removeEventListener("abort", abort)
    reader.releaseLock()
  }
}

class ClosedReaderError extends Error {}

async function bounded<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function terminateProcess(
  pid: number,
  timeoutMs: number,
  spawnTaskkill?: Dependencies["spawnTaskkill"],
): Promise<TerminationEvidence> {
  if (process.platform !== "win32" && !spawnTaskkill) {
    // POSIX workers own their process group, including children with no inherited pipes.
    process.kill(-pid, "SIGKILL")
    return { command: `kill -KILL -- -${pid}`, stdout: "", stderr: "" }
  }
  const killer = spawnTaskkill
    ? spawnTaskkill(pid)
    : Bun.spawn(["taskkill", "/pid", String(pid), "/T", "/F"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const raw = { stdout: "", stderr: "" }
  const stdout = new AbortController()
  const stderr = new AbortController()
  const output = Promise.allSettled([
    readStream(
      killer.stdout,
      65536,
      65536,
      stdout.signal,
      timeoutMs,
      (text) => {
        raw.stdout = text
      },
      () => {},
    ),
    readStream(
      killer.stderr,
      65536,
      65536,
      stderr.signal,
      timeoutMs,
      (text) => {
        raw.stderr = text
      },
      () => {},
    ),
  ])
  let timer: ReturnType<typeof setTimeout> | undefined
  const timerPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("taskkill did not exit")), timeoutMs)
  })
  try {
    const result = await Promise.race([Promise.all([killer.exited, output]), timerPromise])
    return {
      command: spawnTaskkill ? "injected-taskkill-helper" : `taskkill /pid ${pid} /T /F`,
      exitCode: result[0],
      stdout: raw.stdout,
      stderr: raw.stderr,
      helperExitConfirmed: true,
      ...(result[1].some((item) => item.status === "rejected") ? { error: "taskkill output observation failed" } : {}),
    }
  } catch (error) {
    killer.kill()
    const confirmed = await bounded(
      killer.exited.then(() => true),
      timeoutMs,
      "taskkill helper exit not confirmed",
    ).catch(() => false)
    stdout.abort()
    stderr.abort()
    await bounded(output, timeoutMs, "taskkill output cancellation timed out").catch(() => undefined)
    return {
      command: spawnTaskkill ? "injected-taskkill-helper" : `taskkill /pid ${pid} /T /F`,
      stdout: raw.stdout,
      stderr: raw.stderr,
      error: stringify(error),
      helperExitConfirmed: confirmed,
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function removeRoot(
  root: string,
  removeRootDependency?: (root: string) => Promise<void>,
  timeoutMs = 3000,
  spawnCleanup?: Dependencies["spawnCleanup"],
  spawnPhase?: Dependencies["spawnCleanupPhase"],
) {
  const started = Date.now()
  const deadline = started + timeoutMs
  const settleBudgetMs = 1000
  const snapshot = `${root}-diagnostic-${crypto.randomUUID()}`
  const details: CleanupDetails = {
    phase: "create",
    root: "untouched",
    snapshot: "creation-unconfirmed",
    workBudgetMs: timeoutMs,
    settleBudgetMs,
    elapsedMs: 0,
    helpers: [],
  }
  const remaining = () => {
    const budget = deadline - Date.now()
    if (budget <= 0) throw new Error("cleanup timed out")
    return budget
  }
  const execute = async (phase: CleanupPhase, script: string, paths: string[]) => {
    const budget = remaining()
    details.phase = phase
    const command = [process.execPath, "-e", script, ...paths]
    const evidence: CleanupDetails["helpers"][number] = {
      phase,
      exitConfirmed: false,
      stderr: "pending",
      rawStderr: "",
      killRequested: false,
    }
    details.helpers.push(evidence)
    await runCleanupHelper(
      () =>
        spawnPhase?.(phase, command) ??
        (phase === "delete" && spawnCleanup
          ? spawnCleanup(root)
          : Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "pipe" })),
      budget,
      settleBudgetMs,
      evidence,
    )
  }
  try {
    await execute("create", "const fs = await import('node:fs/promises'); await fs.mkdir(process.argv[1])", [snapshot])
    details.snapshot = "empty"
    remaining()
    details.snapshot = "copy-incomplete"
    await execute(
      "copy",
      "const fs = await import('node:fs/promises'); await fs.cp(process.argv[1], process.argv[2], {recursive:true, force:true})",
      [root, snapshot],
    )
    details.snapshot = "complete"
    remaining()
    details.phase = "delete"
    details.root = "deletion-unconfirmed"
    // Injected removeRoot boundaries must settle without further destructive work.
    if (removeRootDependency) await bounded(removeRootDependency(root), remaining(), "cleanup timed out")
    if (!removeRootDependency)
      await execute(
        "delete",
        "const fs = await import('node:fs/promises'); await fs.rm(process.argv[1], {recursive:true, force:true})",
        [root],
      )
    details.root = "removed"
    remaining()
    details.snapshot = "reclaim-incomplete"
    await execute(
      "reclaim",
      "const fs = await import('node:fs/promises'); await fs.rm(process.argv[1], {recursive:true, force:true})",
      [snapshot],
    )
    details.snapshot = "removed"
    return { status: "removed" as const, snapshot: undefined, snapshotComplete: false, details }
  } catch (error) {
    return {
      status: "retained" as const,
      error: stringify(error),
      snapshot,
      snapshotComplete: details.snapshot === "complete",
      details,
    }
  } finally {
    details.elapsedMs = Date.now() - started
  }
}

async function runCleanupHelper(
  spawn: () => CleanupProcess,
  timeoutMs: number,
  settleBudgetMs: number,
  evidence: CleanupDetails["helpers"][number],
) {
  const helper = spawn()
  const controller = new AbortController()
  const exited = helper.exited.then((code) => {
    evidence.exitConfirmed = true
    evidence.exitCode = code
    return code
  })
  const read = readStream(
    helper.stderr,
    65536,
    65536,
    controller.signal,
    settleBudgetMs,
    (text) => {
      evidence.rawStderr = text
    },
    () => {},
  ).then(
    (text) => {
      evidence.stderr = "eof"
      return text
    },
    (error: unknown) => {
      evidence.stderr = error instanceof ClosedReaderError ? "cancelled-and-closed" : "failed-open"
      throw error
    },
  )
  // Both observers are registered before waiting for either one.
  void exited.catch(() => undefined)
  void read.catch(() => undefined)
  try {
    const result = await bounded(Promise.all([exited, read]), timeoutMs, "cleanup timed out")
    if (result[0] !== 0) throw new Error(`cleanup helper exited with ${result[0]}: ${evidence.rawStderr}`)
  } catch (error) {
    const settleDeadline = Date.now() + settleBudgetMs
    const errors = [stringify(error)]
    if (!evidence.exitConfirmed) {
      evidence.killRequested = true
      try {
        helper.kill()
      } catch (failure) {
        errors.push(`cleanup kill failed: ${stringify(failure)}`)
      }
    }
    controller.abort()
    const confirmed = await Promise.allSettled([
      bounded(exited, Math.max(0, settleDeadline - Date.now()), "cleanup helper exit not confirmed"),
      bounded(read, Math.max(0, settleDeadline - Date.now()), "cleanup helper output not confirmed"),
    ])
    confirmed.forEach((item) => {
      if (item.status === "rejected" && !(item.reason instanceof ClosedReaderError)) errors.push(stringify(item.reason))
    })
    if (!evidence.exitConfirmed) errors.push("cleanup helper exit not confirmed")
    if (evidence.stderr === "pending" || evidence.stderr === "failed-open")
      errors.push("cleanup helper output not confirmed")
    if (evidence.exitCode !== undefined && evidence.exitCode !== 0)
      errors.push(`cleanup helper exited with ${evidence.exitCode}: ${evidence.rawStderr}`)
    evidence.error = [...new Set(errors)].join("; ")
    throw new Error(evidence.error)
  }
}

function defaultClassification(input: {
  readonly events: readonly unknown[]
  readonly exitCode: number | null
  readonly timedOut: boolean
  readonly protocolFailed: boolean
  readonly outputFailed: boolean
  readonly childExited: boolean
  readonly descendantsOk: boolean
  readonly earlyExit: boolean
  readonly errors: { readonly primary?: string; readonly exitConfirmation?: string; readonly termination?: string }
}): WorkerClassification {
  if (!input.childExited || input.errors.exitConfirmation || input.errors.termination) return "termination-failure"
  if (!input.descendantsOk) return "tree-failure"
  if (input.protocolFailed) return "protocol-failure"
  if (input.outputFailed) return "output-failure"
  if (input.earlyExit) return "early-exit"
  if (input.timedOut) return "scenario-timeout"
  if (input.errors.primary) return "startup-failure"
  if (input.exitCode === 0 && input.events.length > 0) return "success"
  if (input.exitCode !== 0) return "business-failure"
  return "unknown-failure"
}

function stringify(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function deferred<T = void>() {
  let resolvePromise: ((value: T) => void) | undefined
  const promise = new Promise<T>((promiseResolve) => {
    resolvePromise = promiseResolve
  })
  return { promise, resolve: (value: T) => resolvePromise?.(value) }
}
