export * as ConfigRefresh from "./refresh"

import { InstanceWork } from "@/effect/instance-work"
import type { InstanceContext } from "@/project/instance-context"
import { ConfigWrite } from "./write-error"

export const capacity = 1024
export const attempts = 2
export const retryDelay = 250
export type Step = { id: object; run: () => Promise<void>; retryable: boolean }
type Record = {
  domain: symbol
  step: symbol
  retryable: boolean
  state: "reserved" | "running" | "failed"
  ref: string
  version: number
  batch: object
}

export function make(options: { limit?: number; delay?: (ms: number) => Promise<void> } = {}) {
  const records = new Set<Record>()
  const domains = new WeakMap<InstanceContext, symbol>()
  const identities = new WeakMap<object, symbol>()
  let version = 0
  const identity = <T extends object>(map: WeakMap<T, symbol>, value: T) => {
    const previous = map.get(value)
    if (previous) return previous
    const next = Symbol()
    map.set(value, next)
    return next
  }
  function reserve(domain: InstanceContext, input: Step[], before?: () => Promise<void>) {
    const steps = input.map((step) => ({ ...step }))
    const shutdown = InstanceWork.shutdownSignal(domain)
    const domainID = identity(domains, domain)
    // Each admitted generation owns its reservation until success/covered. Counting
    // only distinct domain/step pairs lets repeated failed generations grow without bound.
    if (records.size + steps.length > (options.limit ?? capacity))
      throw ConfigWrite.fail("CONFIG_REFRESH_CAPACITY_EXHAUSTED")
    const responsibility = {}
    const batch = steps.map(
      (step): Record => ({
        domain: domainID,
        step: identity(identities, step.id),
        retryable: step.retryable,
        state: "reserved",
        ref: crypto.randomUUID(),
        version: ++version,
        batch: responsibility,
      }),
    )
    const complete = (record: Record) => {
      records.delete(record)
      if (![...records].some((item) => item.batch === record.batch)) InstanceWork.recoverHandoff(record.batch)
    }
    for (const record of batch) records.add(record)
    return {
      release: () => {
        for (const record of batch) if (record.state === "reserved") records.delete(record)
      },
      start: () =>
        InstanceWork.handoff(
          async () => {
            const ready = await Promise.resolve()
              .then(before)
              .then(
                () => true,
                () => false,
              )
            if (!ready) {
              for (const record of batch) record.state = "failed"
              throw new Error("Committed project refresh is incomplete")
            }
            // Cache invalidation precedes instance disposal; unrelated hooks cannot retire its context first.
            for (const [index, record] of batch.entries()) {
              record.state = "running"
              const step = steps[index]!
              for (let attempt = 0; attempt < attempts; attempt++) {
                const succeeded = await Promise.resolve()
                  .then(step.run)
                  .then(
                    () => true,
                    () => false,
                  )
                if (succeeded) {
                  complete(record)
                  // Only proven idempotent same-owner/same-step completion covers an older failure.
                  if (record.retryable)
                    for (const previous of records) {
                      if (
                        previous.domain === record.domain &&
                        previous.step === record.step &&
                        previous.version < record.version &&
                        previous.state === "failed"
                      )
                        complete(previous)
                    }
                  break
                }
                if (
                  !record.retryable ||
                  attempt + 1 === attempts ||
                  InstanceWork.isClosing() ||
                  InstanceWork.owner(domain).phase !== "accepting"
                )
                  break
                await waitRetry(retryDelay, shutdown, options.delay)
                if (InstanceWork.isClosing() || InstanceWork.owner(domain).phase !== "accepting") break
              }
              if (records.has(record)) record.state = "failed"
            }
            if (batch.some((record) => records.has(record))) throw new Error("Committed project refresh is incomplete")
          },
          "project",
          responsibility,
        ),
    }
  }
  // Settled records hold only opaque identities and safe counters; no task closure, config or Cause.
  return {
    reserve,
    diagnostics: () => ({
      pending: records.size,
      failed: [...records]
        .filter((record) => record.state === "failed")
        .map((record) => ({ ref: record.ref, stage: "refresh" })),
    }),
  }
}

// Closing cancels a delay that has not dispatched the next invalidation. Running steps still drain.
function waitRetry(ms: number, signal: AbortSignal, delay?: (ms: number) => Promise<void>) {
  return new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const done = () => {
      if (timer !== undefined) clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
    signal.addEventListener("abort", done, { once: true })
    if (signal.aborted) {
      done()
      return
    }
    if (delay) {
      void Promise.resolve()
        .then(() => delay(ms))
        .then(done, done)
      return
    }
    timer = setTimeout(done, ms)
  })
}
