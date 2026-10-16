export * as TaskOrchestratorReview from "./review"

import { Schema } from "effect"

export const Finding = Schema.Struct({
  message: Schema.String,
  path: Schema.String.pipe(Schema.optional),
  line: Schema.Number.pipe(Schema.optional),
})

export const Result = Schema.Struct({
  approved: Schema.Boolean,
  findings: Schema.Array(Finding),
})

export type Finding = typeof Finding.Type
export type Result = typeof Result.Type

export type RevisionPlan = {
  readonly action: "continue" | "revise" | "fail"
  readonly retryCount: number
  readonly findings: ReadonlyArray<Finding>
  readonly reviewerOutput: string
  readonly workerPrompt?: string
}

export const Stored = Schema.Struct({
  kind: Schema.Literal("review"),
  reviewerOutput: Schema.String,
  approved: Schema.Boolean,
  findings: Schema.Array(Finding),
  action: Schema.Literals(["continue", "revise", "fail"]),
  retryCount: Schema.Number,
  workerPrompt: Schema.String.pipe(Schema.optional),
})

export type Stored = typeof Stored.Type

export const parse = (output: string): Result | undefined => {
  const value = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(output)
  if (value._tag === "None") return undefined
  const result = Schema.decodeUnknownOption(Result)(value.value)
  return result._tag === "Some" ? result.value : undefined
}

export const decision = (result: Result, retryCount: number, maxRetries: number) => {
  if (result.approved) return { action: "continue" as const, retryCount }
  if (retryCount >= maxRetries) return { action: "fail" as const, retryCount }
  return { action: "revise" as const, retryCount: retryCount + 1 }
}

export const plan = (output: string, retryCount: number, maxRetries: number): RevisionPlan => {
  const result = parse(output)
  if (!result) {
    return {
      action: "fail",
      retryCount,
      findings: [],
      reviewerOutput: output,
    }
  }

  const next = decision(result, Math.max(0, retryCount), Math.max(0, maxRetries))
  return {
    ...next,
    findings: result.findings,
    reviewerOutput: output,
    ...(next.action === "revise" ? { workerPrompt: revisionPrompt(result.findings) } : {}),
  }
}

export const store = (output: string, revision: RevisionPlan): Stored => ({
  kind: "review",
  reviewerOutput: revision.reviewerOutput,
  approved: revision.action === "continue",
  findings: revision.findings,
  action: revision.action,
  retryCount: revision.retryCount,
  ...(revision.workerPrompt ? { workerPrompt: revision.workerPrompt } : {}),
})

export const encode = (value: Stored) => JSON.stringify(value)

export const decode = (value: string): Stored | undefined => {
  const parsed = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(value)
  if (parsed._tag === "None") return undefined
  const decoded = Schema.decodeUnknownOption(Stored)(parsed.value)
  return decoded._tag === "Some" ? decoded.value : undefined
}

function revisionPrompt(findings: ReadonlyArray<Finding>) {
  return [
    "Revise the implementation to address these reviewer findings:",
    ...findings.map((finding) => `- ${finding.message}${finding.path ? ` (${finding.path}${finding.line === undefined ? "" : `:${finding.line}`})` : ""}`),
  ].join("\n")
}
