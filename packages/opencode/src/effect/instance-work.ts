import { Context, Effect, Exit, Schema } from "effect"
import type { InstanceContext } from "@/project/instance-context"
import { InstanceRef } from "./instance-ref"

export type Owner = {
  phase: "accepting" | "quiescing" | "draining" | "closed"
  tasks: Set<Promise<unknown>>
  producers: Set<() => Promise<void>>
  preparing: Set<AbortController>
  shutdown: AbortController
  stopped?: Promise<void>
}
export type Permit = { owner: Owner; active: boolean }
export const WorkPermit = Context.Reference<Permit | undefined>("@opencode/InstanceWorkPermit", { defaultValue: () => undefined })
const owners = new WeakMap<InstanceContext, Owner>()
const live = new Set<Owner>()
const handoffs = new Set<Promise<unknown>>()
const names = new WeakMap<Promise<unknown>, string>()
let closing = false
let independent: Owner | undefined

export function owner(ctx?: InstanceContext): Owner {
  const existing = ctx ? owners.get(ctx) : independent
  if (existing) return existing
  const next: Owner = { phase: "accepting", tasks: new Set(), producers: new Set(), preparing: new Set(), shutdown: new AbortController() }
  live.add(next)
  if (ctx) owners.set(ctx, next)
  else independent = next
  return next
}

/** Register before dispatch. Cancelling a waiter never interrupts accepted work. */
export function run<A, E, R>(effect: Effect.Effect<A, E, R>, name = "work"): Effect.Effect<A, E, R> {
  return Effect.gen(function* () {
    const ctx = yield* InstanceRef
    const parent = yield* WorkPermit
    const target = ctx ? owner(ctx) : parent?.owner ?? owner()
    if ((closing || target.phase !== "accepting") && !(parent?.active && parent.owner === target)) {
      return yield* Effect.die(new Error("Instance is closing"))
    }
    const context = yield* Effect.context<R>()
    const permit: Permit = { owner: target, active: true }
    const completion = Promise.withResolvers<Exit.Exit<A, E>>()
    target.tasks.add(completion.promise)
    names.set(completion.promise, name)
    // Retain a completion observer before execution can synchronously fail.
    void completion.promise.finally(() => {
      permit.active = false
      target.tasks.delete(completion.promise)
    })
    void Effect.runPromiseExit(effect.pipe(Effect.provideService(WorkPermit, permit), Effect.scoped, Effect.provide(context)))
      .then(completion.resolve, (error) => completion.resolve(Exit.die(error)))
    return yield* Effect.callback<A, E>((resume) => {
      void completion.promise.then((exit) => resume(exit))
    })
  }) as Effect.Effect<A, E, R>
}

export class AdmissionClosed extends Schema.TaggedErrorClass<AdmissionClosed>()("InstanceWorkAdmissionClosed", {}) {}

/** Only preparation follows request cancellation. Admission transfers responsibility to the owner. */
export function preparing<A, E, R>(body: (admit: Effect.Effect<void, AdmissionClosed>) => Effect.Effect<A, E, R>, name = "project-config") {
  return Effect.gen(function* () {
    const ctx = yield* InstanceRef
    const target = owner(ctx)
    if (closing || target.phase !== "accepting") return yield* new AdmissionClosed({})
    const context = yield* Effect.context<R>()
    const controller = new AbortController()
    const phase = { admitted: false }
    const permit: Permit = { owner: target, active: true }
    const completion = Promise.withResolvers<Exit.Exit<A, E | AdmissionClosed>>()
    target.tasks.add(completion.promise)
    target.preparing.add(controller)
    names.set(completion.promise, name)
    const admit = Effect.gen(function* () {
      if (controller.signal.aborted) return yield* Effect.interrupt
      if (closing || target.phase !== "accepting") return yield* new AdmissionClosed({})
      phase.admitted = true
      target.preparing.delete(controller)
    })
    const task = body(admit).pipe(Effect.provideService(WorkPermit, permit), Effect.scoped, Effect.provide(context))
    void Effect.runPromiseExit(task, { signal: controller.signal }).then((exit) => {
      permit.active = false
      target.preparing.delete(controller)
      target.tasks.delete(completion.promise)
      completion.resolve(exit)
    }, (error) => {
      permit.active = false
      target.preparing.delete(controller)
      target.tasks.delete(completion.promise)
      completion.resolve(Exit.die(error))
    })
    return yield* Effect.callback<A, E | AdmissionClosed>((resume, signal) => {
      const cancel = () => { if (!phase.admitted) controller.abort() }
      signal.addEventListener("abort", cancel, { once: true })
      if (signal.aborted) cancel()
      void completion.promise.then((exit) => {
        signal.removeEventListener("abort", cancel)
        resume(exit)
      })
      return Effect.promise(async () => {
        cancel()
        if (!phase.admitted) await completion.promise
      })
    })
  })
}

export function registerProducer(ctx: InstanceContext, stop: () => Promise<void>) {
  const target = owner(ctx)
  if (closing || target.phase !== "accepting") throw new Error("Instance is closing")
  target.producers.add(stop)
  return () => target.producers.delete(stop)
}

async function stop(target: Owner) {
  target.phase = "quiescing"
  target.shutdown.abort()
  for (const controller of target.preparing) controller.abort()
  const producers = await Promise.allSettled([...target.producers].map((producer) => Promise.resolve().then(producer)))
  target.producers.clear()
  target.phase = "draining"
  while (target.tasks.size) await Promise.all([...target.tasks])
  target.phase = "closed"
  live.delete(target)
  if (producers.some((result) => result.status === "rejected")) throw new Error("Instance producer shutdown is incomplete")
}

export function drain(ctx: InstanceContext) {
  const target = owner(ctx)
  return target.stopped ??= stop(target)
}
export async function drainAll() {
  closing = true
  const owners = await Promise.allSettled([...live].map((target) => target.stopped ??= stop(target)))
  while (handoffs.size) await Promise.allSettled([...handoffs])
  if (owners.some((result) => result.status === "rejected") || unrecovered > 0) {
    throw new Error("Configuration refresh remains incomplete")
  }
}
const diagnostics: Array<{ ref: string; source: "general" | "project"; phase: "handoff"; recovered?: boolean }> = []
const responsibilities = new WeakMap<object, { ref?: string; recovered: boolean; failed: boolean }>()
let historicalFailures = 0
let unrecovered = 0
let overflow = false
export async function waitHandoffs() {
  while (handoffs.size) await Promise.allSettled([...handoffs])
  return handoffDiagnostics()
}
export function isClosing() { return closing }
export function shutdownSignal(ctx: InstanceContext) { return owner(ctx).shutdown.signal }
export function handoffDiagnostics() {
  return { active: handoffs.size, unrecovered, historicalFailures, overflow, failures: diagnostics.map((item) => ({ ...item })) }
}
export function recoverHandoff(responsibility: object) {
  const failed = responsibilities.get(responsibility)
  if (!failed || failed.recovered) return
  failed.recovered = true
  if (failed.failed) unrecovered = Math.max(0, unrecovered - 1)
  const diagnostic = diagnostics.find((item) => item.ref === failed.ref)
  if (diagnostic) diagnostic.recovered = true
}
export function handoff(task: () => Promise<void>, source: "general" | "project" = "general", responsibility?: object) {
  // Register before dispatch so later same-step success can cover a failure before its observer runs.
  const responsibilityState = source === "project" && responsibility ? { recovered: false, failed: false, ref: undefined as string | undefined } : undefined
  if (responsibility && responsibilityState) responsibilities.set(responsibility, responsibilityState)
  // Settle records failures before removing activity or exposing rejection to callers.
  const pending = Promise.resolve().then(task).then(() => {
    handoffs.delete(pending)
  }, () => {
    if (!responsibilityState?.recovered) unrecovered = Math.min(Number.MAX_SAFE_INTEGER, unrecovered + 1)
    historicalFailures = Math.min(Number.MAX_SAFE_INTEGER, historicalFailures + 1)
    const ref = crypto.randomUUID()
    if (responsibilityState) { responsibilityState.failed = true; responsibilityState.ref = ref }
    diagnostics.push({ ref, source, phase: "handoff", ...(responsibilityState?.recovered ? { recovered: true } : {}) })
    if (diagnostics.length > 1024) { diagnostics.shift(); overflow = true }
    handoffs.delete(pending)
    throw new Error("Configuration refresh remains incomplete")
  })
  handoffs.add(pending)
  // An ignored consumer cannot turn an already-owned failure into an unhandled rejection.
  void pending.catch(() => undefined)
  return pending
}
export function assertReadable(ctx: InstanceContext, permit?: Permit) {
  const target = owners.get(ctx)
  if (target && target.phase !== "accepting" && !(permit?.active && permit.owner === target)) throw new Error("Stale instance context")
}
/** Called before a public runtime can build services or dispatch new work. */
export function assertEntry(ctx?: InstanceContext, permit?: Permit) {
  const target = ctx ? owners.get(ctx) : permit?.owner
  if ((closing || (target && target.phase !== "accepting")) && !(permit?.active && (!target || permit.owner === target))) {
    throw new Error("Instance is closing")
  }
}
export function pending(ctx: InstanceContext) {
  const target = owners.get(ctx)
  return target && { phase: target.phase, producers: target.producers.size, tasks: [...target.tasks].map((task) => names.get(task)) }
}
export * as InstanceWork from "./instance-work"
