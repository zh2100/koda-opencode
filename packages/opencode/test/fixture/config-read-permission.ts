import { spawn, spawnSync, type ChildProcess, type SpawnSyncReturns } from "node:child_process"
import fsPromises from "node:fs/promises"
import os from "node:os"
import { Cause, Effect, Exit } from "effect"

type ApplyResult = { error?: Error; status: number | null }
type ReadResult = { ok: true; text: string } | { ok: false; code?: string }
type Stage = "prepare" | "mutating" | "denied" | "restoring" | "restored" | "unrestored"

export type PermissionFailure = { stage: Stage; attempt: number; reason: string }

export type PermissionOps = {
  apply: (file: string) => ApplyResult | Promise<ApplyResult>
  restore: (file: string, original?: number) => ApplyResult | Promise<ApplyResult>
  read: (file: string) => Promise<ReadResult>
  probe?: (file: string) => Promise<ReadResult>
  mode?: (file: string) => Promise<number>
  snapshot?: (file: string) => Promise<string | undefined>
  verify?: (file: string, snapshot: string) => Promise<ReadResult>
}

export type PermissionObservation = {
  readonly stage: Stage
  readonly attempts: number
  readonly failures: readonly PermissionFailure[]
  readonly original?: number
  readonly snapshot?: string
}

type Lifecycle = {
  readonly file: string
  readonly document: string
  readonly ops: PermissionOps
  readonly original?: number
  readonly snapshot?: string
  stage: Stage
  dispatched: boolean
  mutation: Promise<Exit.Exit<ApplyResult, Error>> | undefined
  attempts: number
  failures: PermissionFailure[]
  finished: Exit.Exit<void, Error> | undefined
  seen: PermissionObservation
}

const attemptsLimit = 2
const permissionCode = (code: string | undefined): code is "EACCES" | "EPERM" => code === "EACCES" || code === "EPERM"

const nodeCode = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined

const reasonText = (error: unknown) => (error instanceof Error ? error.message : String(error))

const readFile = async (file: string): Promise<ReadResult> => {
  try {
    return { ok: true, text: await fsPromises.readFile(file, "utf8") }
  } catch (error) {
    return { ok: false, code: nodeCode(error) }
  }
}

const commandError = (result: SpawnSyncReturns<string>) => {
  if (result.error) return result.error
  if (result.status !== 0) return new Error(`icacls exited ${result.status ?? "null"}`)
}

const waitChild = (child: ChildProcess) =>
  new Promise<ApplyResult>((resolve) => {
    let settled = false
    const finishChild = (result: ApplyResult) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    child.once("error", (error) => finishChild({ error, status: null }))
    child.once("close", (status) => {
      const error = status === 0 ? undefined : new Error(`icacls exited ${status ?? "null"}`)
      finishChild({ error, status })
    })
  })

const runIcacls = (args: string[]) => waitChild(spawn("icacls", args, { stdio: "ignore", windowsHide: true }))

const inheritedAcl = async (file: string) => {
  const listed = spawnSync("icacls", [file], { encoding: "utf8" })
  if (commandError(listed)) return undefined
  const line = listed.stdout.split(/\r?\n/).find((item) => item.trim().length > 0) ?? ""
  if (!/\(I\)/.test(line)) return undefined
  return line
}

export const windowsOps = (identity: string): PermissionOps => ({
  apply: (file) => runIcacls([file, "/inheritance:r", "/grant:r", `${identity}:(F)`, "/deny", `${identity}:(R)`]),
  restore: (file) => runIcacls([file, "/reset"]),
  read: readFile,
  snapshot: inheritedAcl,
  verify: async (file, snapshot) => {
    const listed = spawnSync("icacls", [file], { encoding: "utf8" })
    const error = commandError(listed)
    if (error) return { ok: false, code: error.message }
    const line = listed.stdout.split(/\r?\n/).find((item) => item.trim().length > 0) ?? ""
    if (line.includes("(DENY)") || line.includes("(N)")) return { ok: false, code: "DENY" }
    if (!/\(I\)/.test(line)) return { ok: false, code: "inheritance" }
    if (snapshot.length === 0) return { ok: false, code: "snapshot" }
    return { ok: true, text: snapshot }
  },
})

export const posixOps = (): PermissionOps => ({
  apply: async (file) => {
    await fsPromises.chmod(file, 0o000)
    return { status: 0 }
  },
  restore: async (file, original) => {
    await fsPromises.chmod(file, original ?? 0)
    return { status: 0 }
  },
  read: readFile,
  mode: async (file) => (await fsPromises.stat(file)).mode & 0o7777,
})

export const windowsIdentity = () => {
  const info = os.userInfo()
  const domain = "domain" in info && typeof info.domain === "string" ? info.domain : ""
  return `${domain ? `${domain}\\` : ""}${info.username}`
}

const publish = (ctx: Lifecycle) => {
  ctx.seen = {
    stage: ctx.stage,
    attempts: ctx.attempts,
    failures: [...ctx.failures],
    original: ctx.original,
    snapshot: ctx.snapshot,
  }
}

const record = (ctx: Lifecycle, error: unknown) => {
  ctx.failures.push({ stage: ctx.stage, attempt: ctx.attempts, reason: reasonText(error) })
  publish(ctx)
}

const settled = <A>(promise: Promise<A>) =>
  promise.then(
    (value) => ({ ok: true as const, value }),
    (cause) => ({ ok: false as const, error: cause instanceof Error ? cause : new Error(String(cause)) }),
  )

// Interpret returned statuses before sharing the outcome with normal and cancellation paths.
const operationError = (result: ApplyResult, action: string, file: string) =>
  result.error ??
  (result.status === 0 ? undefined : new Error(`could not ${action} ${file}: status ${result.status ?? "null"}`))

const restoreAttempt = async (ctx: Lifecycle) => {
  ctx.stage = "restoring"
  ctx.attempts += 1
  publish(ctx)
  // Verification is part of this attempt: throws and rejections must consume the same retry budget.
  const result = await settled(
    Promise.resolve().then(async () => {
      const error = operationError(await ctx.ops.restore(ctx.file, ctx.original), "restore config read", ctx.file)
      if (error) throw error
      const readable = await ctx.ops.read(ctx.file)
      if (!readable.ok || readable.text !== ctx.document) {
        throw new Error(`restored file is not readable: ${ctx.file}`)
      }
      if (ctx.ops.mode && ctx.original !== undefined) {
        const mode = await ctx.ops.mode(ctx.file)
        if (mode !== (ctx.original & 0o7777)) {
          throw new Error(`restored mode differs for ${ctx.file}`)
        }
      }
      if (ctx.ops.verify && ctx.snapshot !== undefined) {
        const verified = await ctx.ops.verify(ctx.file, ctx.snapshot)
        if (!verified.ok) throw new Error(`restored acl differs for ${ctx.file}`)
      }
    }),
  )
  if (!result.ok) {
    record(ctx, result.error)
    return false
  }
  ctx.stage = "restored"
  publish(ctx)
  return true
}

const ownMutation = (ctx: Lifecycle) => {
  ctx.dispatched = true
  ctx.stage = "mutating"
  publish(ctx)
  const mutation = settled(Promise.resolve().then(() => ctx.ops.apply(ctx.file))).then((result) => {
    if (!result.ok) return Exit.fail(result.error)
    const error = operationError(result.value, "deny config read", ctx.file)
    return error ? Exit.fail(error) : Exit.succeed(result.value)
  })
  ctx.mutation = mutation
  return mutation
}

const runFinish = async (ctx: Lifecycle, includeMutation: boolean) => {
  if (ctx.finished) return ctx.finished
  if (!ctx.dispatched) {
    ctx.finished = Exit.void
    publish(ctx)
    return ctx.finished
  }
  const mutation = ctx.mutation ? await ctx.mutation : undefined
  while (ctx.stage !== "restored" && ctx.attempts < attemptsLimit) {
    const restored = await restoreAttempt(ctx)
    if (restored) break
  }
  if (ctx.stage !== "restored") ctx.stage = "unrestored"
  const reasons: Array<Cause.Cause<Error>> = []
  if (includeMutation && mutation && Exit.isFailure(mutation)) reasons.push(mutation.cause)
  if (ctx.failures.length) {
    reasons.push(
      Cause.fail(new Error(ctx.failures.map((item) => `${item.stage}#${item.attempt}: ${item.reason}`).join("; "))),
    )
  }
  ctx.finished = reasons.length
    ? Exit.failCause(reasons.reduce((left, right) => Cause.combine(left, right)))
    : Exit.void
  publish(ctx)
  return ctx.finished
}

const finish = (ctx: Lifecycle, includeMutation: boolean) => {
  const pending = runFinish(ctx, includeMutation).then(
    (exit) => exit,
    (cause) => Exit.fail(cause instanceof Error ? cause : new Error(String(cause))),
  )
  let settledExit: Exit.Exit<void, Error> | undefined
  void pending.then((exit) => {
    settledExit = exit
  })
  return Effect.sync(() => settledExit).pipe(
    Effect.flatMap((exit) => (exit ? Effect.succeed(exit) : Effect.yieldNow.pipe(Effect.as(undefined)))),
    Effect.repeat({ until: (exit) => exit !== undefined }),
  )
}

const applyMutation = (ctx: Lifecycle) =>
  Effect.uninterruptible(
    Effect.suspend(() => {
      const settledMutation = ownMutation(ctx)
      // Carry the outcome out of the masked wait so a pending interrupt is not replaced by a failure here.
      return Effect.callback<Exit.Exit<ApplyResult, Error>>((resume) => {
        void settledMutation.then((result) => resume(Effect.succeed(result)))
      })
    }),
  )

const applyDenial = (ctx: Lifecycle) =>
  Effect.gen(function* () {
    const applied = yield* applyMutation(ctx)
    yield* applied
    const probe = yield* Effect.promise(() => (ctx.ops.probe ?? ctx.ops.read)(ctx.file))
    if (probe.ok) return yield* Effect.fail(new Error("could not establish a config read denial"))
    if (!permissionCode(probe.code)) {
      return yield* Effect.fail(new Error(`config read probe failed with ${probe.code ?? "unknown"}`))
    }
    ctx.stage = "denied"
    publish(ctx)
    return probe.code
  })

const acquire = (input: { file: string; document: string; ops: PermissionOps }) =>
  Effect.gen(function* () {
    yield* Effect.promise(() => Bun.write(input.file, input.document))
    const original = input.ops.mode ? yield* Effect.promise(() => input.ops.mode!(input.file)) : undefined
    const snapshot = input.ops.snapshot ? yield* Effect.promise(() => input.ops.snapshot!(input.file)) : undefined
    if (input.ops.snapshot && snapshot === undefined) {
      return yield* Effect.fail(new Error(`could not capture the inherited acl for ${input.file}`))
    }
    const ctx: Lifecycle = {
      file: input.file,
      document: input.document,
      ops: input.ops,
      original,
      snapshot,
      stage: "prepare",
      dispatched: false,
      mutation: undefined,
      attempts: 0,
      failures: [],
      finished: undefined,
      seen: { stage: "prepare", attempts: 0, failures: [], original, snapshot },
    }
    return ctx
  })

const causeOf = (exit: Exit.Exit<unknown, unknown>) => (Exit.isFailure(exit) ? exit.cause : undefined)

const renderedCause = (cause: Cause.Cause<unknown>) =>
  cause.reasons
    .map((reason) =>
      reason._tag === "Fail" || reason._tag === "Die"
        ? reasonText(reason._tag === "Fail" ? reason.error : reason.defect)
        : "",
    )
    .filter((item) => item.length > 0)
    .join("\n")

const attach = (interrupt: Cause.Cause<unknown>, rendered: string) =>
  Cause.map(interrupt, (error) => {
    const carrier = error instanceof Error ? error : new Error(reasonText(error))
    if (!carrier.message.includes(rendered)) carrier.message = `${carrier.message}\n${rendered}`
    return carrier
  })

const merge = (body: Exit.Exit<unknown, unknown>, cleaned: Exit.Exit<void, Error>) => {
  const left = causeOf(body)
  const right = causeOf(cleaned)
  if (left && right && Cause.hasInterrupts(left)) {
    const rendered = [renderedCause(left), renderedCause(right)].filter((item) => item.length > 0).join("\n")
    return Cause.combine(attach(left, rendered), right)
  }
  if (left && right) return Cause.combine(left, right)
  return left ?? right
}

const release = <A, E>(ctx: Lifecycle, body: Exit.Exit<A, E>, repeatFinish: boolean | undefined) =>
  Effect.gen(function* () {
    const includeMutation = Exit.isFailure(body) && Cause.hasInterrupts(body.cause)
    const cleaned = yield* finish(ctx, includeMutation)
    const repeated = repeatFinish ? yield* finish(ctx, includeMutation) : undefined
    const cause = merge(body, cleaned)
    if (cause) return yield* Effect.failCause(cause)
    if (Exit.isFailure(body)) return yield* Effect.failCause(body.cause)
    return { value: body.value, seen: () => ctx.seen, repeated }
  })

export const withConfigReadDenied = <A, E>(input: {
  file: string
  document: string
  ops: PermissionOps
  use: (code: "EACCES" | "EPERM", seen: () => PermissionObservation) => Effect.Effect<A, E>
  repeatFinish?: boolean
  holdAcquire?: Effect.Effect<void>
}) =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      if (input.holdAcquire) yield* restore(input.holdAcquire)
      const ctx = yield* acquire(input)
      return yield* restore(applyDenial(ctx).pipe(Effect.flatMap((code) => input.use(code, () => ctx.seen)))).pipe(
        Effect.exit,
        Effect.flatMap((body) => release(ctx, body, input.repeatFinish)),
      )
    }),
  )
