export * as TaskOrchestratorParallel from "./parallel"

import { and, asc, eq, sql } from "drizzle-orm"
import { Effect, Exit, Schema } from "effect"
import { TaskOrchestratorFailure } from "./failure"
import { Database } from "../database/database"
import type { Role } from "../task-orchestrator"
import { TaskOrchestratorReview } from "./review"
import {
  TaskOrchestratorMessageTable,
  TaskOrchestratorRunTable,
  TaskOrchestratorStepTable,
  TaskOrchestratorTaskTable,
} from "./sql"

export const MessageKind = Schema.Literals([
  "plan",
  "critique",
  "submission",
  "review",
  "revision",
  "merge",
  "test",
  "final",
])
export type MessageKind = typeof MessageKind.Type

export type Message = {
  readonly role: Role
  readonly kind: MessageKind
  readonly content: string
  readonly createdAt: number
}

export const PlanTask = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  instruction: Schema.String,
  files: Schema.optional(Schema.Array(Schema.String)),
  acceptance: Schema.optional(Schema.String),
})
export type PlanTask = typeof PlanTask.Type

export const Plan = Schema.Struct({
  summary: Schema.String,
  tasks: Schema.Array(PlanTask),
})
export type Plan = typeof Plan.Type

export type WorkResult = {
  readonly output: string
  readonly patch?: string
}

export interface Runner {
  readonly plan: (input: {
    readonly prompt: string
    readonly messages: ReadonlyArray<Message>
  }) => Effect.Effect<string, unknown>
  readonly discuss: (input: {
    readonly role: "reviewer" | "tester"
    readonly prompt: string
    readonly messages: ReadonlyArray<Message>
  }) => Effect.Effect<string, unknown>
  readonly work: (input: {
    readonly name: string
    readonly prompt: string
    readonly messages: ReadonlyArray<Message>
    readonly patch?: string
  }) => Effect.Effect<WorkResult, unknown>
  readonly review: (input: {
    readonly name: string
    readonly prompt: string
    readonly messages: ReadonlyArray<Message>
    readonly patch: string
  }) => Effect.Effect<string, unknown>
  readonly test: (input: {
    readonly prompt: string
    readonly messages: ReadonlyArray<Message>
    readonly patches: ReadonlyArray<string>
  }) => Effect.Effect<string, unknown>
  readonly finalize: (input: {
    readonly prompt: string
    readonly messages: ReadonlyArray<Message>
    readonly test: string
  }) => Effect.Effect<string, unknown>
  readonly merge: (patch: string) => Effect.Effect<void, unknown>
  readonly notice?: (text: string) => Effect.Effect<void, unknown>
  readonly control?: (taskID: string) => "pause" | "abort" | "retry" | undefined
}

const decodeJson = (output: string) => {
  const direct = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(output.trim())
  if (direct._tag === "Some") return direct.value
  const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
  if (fenced) {
    const decoded = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(fenced.trim())
    if (decoded._tag === "Some") return decoded.value
  }
  const start = output.indexOf("{")
  const end = output.lastIndexOf("}")
  if (start === -1 || end <= start) return
  const decoded = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(output.slice(start, end + 1))
  return decoded._tag === "Some" ? decoded.value : undefined
}

export const parsePlan = (output: string, prompt: string): Plan => {
  const decoded = Schema.decodeUnknownOption(Plan)(decodeJson(output))
  if (decoded._tag === "Some") {
    const seen = new Set<string>()
    const tasks = decoded.value.tasks
      .map((task, index) => ({
        ...task,
        id: task.id.trim() || `task-${index + 1}`,
        title: task.title.trim(),
        instruction: task.instruction.trim(),
      }))
      .filter((task) => {
        if (!task.instruction || seen.has(task.id)) return false
        seen.add(task.id)
        return true
      })
      .slice(0, 6)
    if (tasks.length) return { summary: decoded.value.summary, tasks }
  }
  return {
    summary: "Implement the requested task.",
    tasks: [{ id: "task-1", title: "Implement task", instruction: prompt }],
  }
}

export const renderPlan = (label: string, plan: Plan) =>
  [
    `${label}: ${plan.summary}`,
    ...plan.tasks.map((task, index) =>
      [
        `${index + 1}. ${task.title} (${task.id})`,
        `   ${truncate(task.instruction, 240)}`,
        ...(task.files?.length ? [`   files: ${task.files.join(", ")}`] : []),
      ].join("\n"),
    ),
  ].join("\n\n")

const truncate = (value: string, limit: number) =>
  value.length <= limit ? value : `${value.slice(0, limit)}\n\n[...truncated ${value.length - limit} characters]`

export const parseReview = (output: string) => {
  const parsed = TaskOrchestratorReview.parseStrict(output)
  return parsed ?? { approved: false, findings: [{ message: "Reviewer output was not valid structured JSON" }] }
}

const WorkerSnapshot = Schema.Struct({ id: Schema.String })
const workerID = (value: string) => {
  const json = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(value)
  if (json._tag === "None") return undefined
  const parsed = Schema.decodeUnknownOption(WorkerSnapshot)(json.value)
  return parsed._tag === "Some" ? parsed.value.id : undefined
}

const WorkerResult = Schema.Struct({ output: Schema.String, patch: Schema.String })
const workerResult = (output: string, patch?: string) =>
  JSON.stringify({ output, patch: patch ?? "" } satisfies typeof WorkerResult.Type)
const parseWorkerResult = (value: string | null) => {
  if (!value) return undefined
  const json = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(value)
  if (json._tag === "None") return undefined
  const parsed = Schema.decodeUnknownOption(WorkerResult)(json.value)
  return parsed._tag === "Some" ? parsed.value : undefined
}

export const renderMessages = (messages: ReadonlyArray<Message>, limit = 8) =>
  messages
    .slice(-limit)
    .map((message) => `[${message.role}/${message.kind}]\n${truncate(message.content, 4000)}`)
    .join("\n\n")

export const plannerPrompt = (prompt: string) =>
  [
    "You are the collaboration planner.",
    "Decompose the user task into 1-6 independent, file-disjoint implementation tasks that can run concurrently.",
    "Do not create dependencies between tasks. Keep the plan decision-complete.",
    "Return only JSON with this shape:",
    '{"summary":"...","tasks":[{"id":"t1","title":"...","instruction":"...","files":["src/..."],"acceptance":"..."}]}',
    "User task:",
    prompt,
  ].join("\n\n")

export const critiquePrompt = (prompt: string, plan: Plan) =>
  [
    "You are participating in a parallel planning review.",
    "Review the proposed plan for missing requirements, unsafe assumptions, integration risks, and validation gaps.",
    "Do not modify files. Do not rewrite the whole plan. Return concise, actionable findings.",
    "User task:",
    prompt,
    "Proposed plan:",
    JSON.stringify(plan, null, 2),
  ].join("\n\n")

export const revisionPlannerPrompt = (prompt: string, plan: Plan, messages: ReadonlyArray<Message>) =>
  [
    "You are the collaboration planner.",
    "Revise the plan using the parallel review discussion.",
    "Keep tasks independent and file-disjoint. Return only the same JSON shape as before.",
    "User task:",
    prompt,
    "Original plan:",
    JSON.stringify(plan, null, 2),
    "Discussion:",
    renderMessages(messages),
  ].join("\n\n")

export const workerPrompt = (input: {
  prompt: string
  plan: Plan
  task: PlanTask
  messages: ReadonlyArray<Message>
  patch?: string
}) =>
  [
    `You are worker ${input.task.id}: ${input.task.title}.`,
    "Implement only the assigned subtask. Do not modify files outside its declared scope.",
    "The other workers are editing other files in isolated worktrees; stay within your assigned area.",
    "This worktree has no installed dependencies. Do not run package managers, installs, or dependency setup; report validation gaps instead.",
    "Keep context small: read only targeted files and line ranges, avoid generated bundles, lockfiles, and dumping entire files.",
    "User task:",
    input.prompt,
    "Shared plan:",
    renderPlan("Plan", input.plan),
    "Your subtask:",
    input.task.instruction,
    ...(input.task.files?.length ? ["Files:", input.task.files.join("\n")] : []),
    ...(input.task.acceptance ? ["Acceptance criteria:", input.task.acceptance] : []),
    "Discussion:",
    renderMessages(input.messages),
    ...(input.patch
      ? ["Your previous patch is applied to this worktree. Address the review findings.", truncate(input.patch, 8_000)]
      : []),
  ].join("\n\n")

export const reviewPrompt = (input: {
  prompt: string
  task: PlanTask
  output: string
  patch: string
  messages: ReadonlyArray<Message>
}) =>
  [
    "You are reviewing one parallel worker submission.",
    "Inspect the applied worktree and the patch. Focus on correctness, acceptance criteria, and integration risk.",
    "Do not modify files.",
    'Return only JSON: {"approved":true,"findings":[{"message":"...","path":"optional.ts","line":1}]}.',
    "User task:",
    input.prompt,
    "Subtask:",
    JSON.stringify(input.task, null, 2),
    "Worker report:",
    truncate(input.output, 8_000),
    "Discussion:",
    renderMessages(input.messages),
    "Patch:",
    truncate(input.patch || "(no file changes)", 8_000),
  ].join("\n\n")

export const testerPrompt = (prompt: string, plan: Plan, messages: ReadonlyArray<Message>) =>
  [
    "You are the integrated tester. Run appropriate validation against the merged worktree.",
    "Do not modify source files. Report concrete failures and residual risks.",
    "This worktree has no installed dependencies. Do not run package managers, installs, or dependency setup; report that validation could not run instead.",
    "User task:",
    prompt,
    "Plan:",
    JSON.stringify(plan, null, 2),
    "Discussion:",
    renderMessages(messages),
  ].join("\n\n")

export const finalizerPrompt = (input: {
  prompt: string
  plan: Plan
  messages: ReadonlyArray<Message>
  test: string
}) =>
  [
    "You are the finalizer. Summarize the verified result for the user.",
    "Include what changed, review findings that were resolved, validation results, and remaining risks.",
    "User task:",
    input.prompt,
    "Plan:",
    JSON.stringify(input.plan, null, 2),
    "Discussion:",
    renderMessages(input.messages, 16),
    "Test result:",
    input.test,
  ].join("\n\n")

const require = <A, E, R>(effect: Effect.Effect<A, E, R>, timeoutMs: number, label: string) =>
  effect.pipe(
    Effect.timeoutOrElse({
      duration: timeoutMs,
      orElse: () => Effect.fail(new Error(`${label} exceeded timeout of ${timeoutMs}ms`)),
    }),
  )

export const run = Effect.fn("TaskOrchestratorParallel.run")(function* (input: {
  readonly db: Database.Interface["db"]
  readonly taskID: string
  readonly runner: Runner
}) {
  const task = yield* input.db
    .select()
    .from(TaskOrchestratorTaskTable)
    .where(eq(TaskOrchestratorTaskTable.id, input.taskID))
    .get()
    .pipe(Effect.orDie)
  if (!task || task.status === "aborted" || task.status === "completed" || task.status === "paused") return
  yield* input.db
    .update(TaskOrchestratorTaskTable)
    .set({ status: "running", updated_at: Date.now() })
    .where(eq(TaskOrchestratorTaskTable.id, input.taskID))
    .run()
    .pipe(Effect.orDie)

  const steps = yield* input.db
    .select()
    .from(TaskOrchestratorStepTable)
    .where(eq(TaskOrchestratorStepTable.task_id, input.taskID))
    .orderBy(asc(TaskOrchestratorStepTable.ordinal))
    .all()
    .pipe(Effect.orDie)
  const stepsByRole = new Map(steps.map((step) => [step.role, step]))
  const storedMessages = yield* input.db
    .select()
    .from(TaskOrchestratorMessageTable)
    .where(eq(TaskOrchestratorMessageTable.task_id, input.taskID))
    .orderBy(asc(TaskOrchestratorMessageTable.created_at), sql`rowid`)
    .all()
    .pipe(Effect.orDie)
  const messages: Message[] = storedMessages.map((message) => ({
    role: message.role,
    kind: message.kind,
    content: message.content,
    createdAt: message.created_at,
  }))
  const timeout = task.timeout_ms
  const maxRetries = Math.max(0, task.max_retries)

  const append = (role: Role, kind: MessageKind, content: string) =>
    Effect.gen(function* () {
      const message = { role, kind, content, createdAt: Date.now() }
      yield* input.db
        .insert(TaskOrchestratorMessageTable)
        .values({
          id: crypto.randomUUID(),
          task_id: input.taskID,
          role,
          kind,
          content,
          created_at: message.createdAt,
        })
        .run()
        .pipe(Effect.orDie)
      messages.push(message)
      return message
    })

  const setStep = (role: Role, status: "running" | "completed" | "failed", output?: string, failure?: string) => {
    const step = stepsByRole.get(role)
    if (!step) return Effect.void
    return input.db
      .update(TaskOrchestratorStepTable)
      .set({
        status,
        ...(status === "running" ? { started_at: Date.now(), finished_at: null } : { finished_at: Date.now() }),
        failure_reason: status === "failed" ? (failure ?? null) : null,
        output: status === "running" ? null : (output ?? null),
      })
      .where(eq(TaskOrchestratorStepTable.id, step.id))
      .run()
      .pipe(Effect.orDie, Effect.asVoid)
  }

  const setCurrentStep = (ordinal: number) =>
    input.db
      .update(TaskOrchestratorTaskTable)
      .set({ current_step: ordinal, updated_at: Date.now() })
      .where(eq(TaskOrchestratorTaskTable.id, input.taskID))
      .run()
      .pipe(Effect.orDie)

  const setWorkerRun = (
    runID: string,
    status: "running" | "completed" | "failed",
    extra: { readonly output?: string; readonly patch?: string; readonly failure?: string } = {},
  ) =>
    input.db
      .update(TaskOrchestratorRunTable)
      .set({
        status,
        ...(status === "running" ? { started_at: Date.now(), finished_at: null } : { finished_at: Date.now() }),
        output: status === "completed" ? workerResult(extra.output ?? "", extra.patch) : null,
        failure_reason: status === "failed" ? (extra.failure ?? null) : null,
      })
      .where(eq(TaskOrchestratorRunTable.id, runID))
      .run()
      .pipe(Effect.orDie, Effect.asVoid)

  const notify = (text: string) => (input.runner.notice?.(text) ?? Effect.void).pipe(Effect.ignore)

  const stop = () =>
    Effect.gen(function* () {
      const control = input.runner.control?.(input.taskID)
      if (control !== "pause" && control !== "abort") return false
      yield* input.db
        .update(TaskOrchestratorTaskTable)
        .set({ status: control === "pause" ? "paused" : "aborted", updated_at: Date.now() })
        .where(eq(TaskOrchestratorTaskTable.id, input.taskID))
        .run()
        .pipe(Effect.orDie)
      return true
    })

  if (yield* stop()) return

  const plannerStep = stepsByRole.get("planner")
  const savedPlan = plannerStep?.status === "completed" ? plannerStep.output : undefined
  let plan: Plan
  if (savedPlan) {
    plan = parsePlan(savedPlan, task.prompt)
    yield* setCurrentStep(0)
    yield* notify("Resuming collaboration from the saved plan.")
  } else {
    yield* setStep("planner", "running")
    yield* setCurrentStep(0)
    yield* notify("Collaboration started: planning the task.")
    const draftOutput = yield* require(input.runner.plan({
      prompt: plannerPrompt(task.prompt),
      messages: messages.slice(),
    }), timeout, "Planner")
    plan = parsePlan(draftOutput, task.prompt)
    yield* append("planner", "plan", draftOutput)
    yield* notify(renderPlan("Plan draft ready", plan))
    yield* notify("Reviewer and tester are reviewing the draft plan.")

    const critiques = yield* Effect.all(
      (["reviewer", "tester"] as const).map((role) =>
        require(input.runner.discuss({
          role,
          prompt: critiquePrompt(task.prompt, plan),
          messages: messages.slice(),
        }), timeout, `${role} critique`).pipe(Effect.map((content) => ({ role, content }))),
      ),
      { concurrency: 2 },
    )
    for (const critique of critiques) yield* append(critique.role, "critique", critique.content)
    yield* notify("Plan review finished. Planner is revising the plan with the findings.")

    const revisedOutput = yield* require(input.runner.plan({
      prompt: revisionPlannerPrompt(task.prompt, plan, messages.slice()),
      messages: messages.slice(),
    }), timeout, "Planner revision")
    plan = parsePlan(revisedOutput, task.prompt)
    yield* append("planner", "plan", revisedOutput)
    yield* notify(renderPlan("Plan ready", plan))
    yield* setStep("planner", "completed", revisedOutput)
  }

  if (yield* stop()) return
  const workerStep = stepsByRole.get("worker")
  const workerRuns = new Map<string, string>()
  const reused = new Map<string, { readonly output: string; readonly patch?: string }>()
  const existingRuns = workerStep
    ? yield* input.db
        .select()
        .from(TaskOrchestratorRunTable)
        .where(and(eq(TaskOrchestratorRunTable.task_id, input.taskID), eq(TaskOrchestratorRunTable.role, "worker")))
        .orderBy(sql`rowid`)
        .all()
        .pipe(Effect.orDie)
    : []
  const runByWorker = new Map<string, (typeof existingRuns)[number]>()
  for (const run of existingRuns) {
    const id = workerID(run.input_snapshot)
    if (id) runByWorker.set(id, run)
  }
  if (workerStep) {
    for (const subtask of plan.tasks) {
      const existing = runByWorker.get(subtask.id)
      const saved = existing?.status === "completed" ? parseWorkerResult(existing.output) : undefined
      if (existing && saved) {
        workerRuns.set(subtask.id, existing.id)
        reused.set(subtask.id, { output: saved.output, patch: saved.patch || undefined })
        continue
      }
      const runID = existing?.id ?? crypto.randomUUID()
      workerRuns.set(subtask.id, runID)
      if (existing) {
        yield* input.db
          .update(TaskOrchestratorRunTable)
          .set({ status: "pending", output: null, failure_reason: null, finished_at: null, started_at: 0 })
          .where(eq(TaskOrchestratorRunTable.id, runID))
          .run()
          .pipe(Effect.orDie)
        continue
      }
      yield* input.db
        .insert(TaskOrchestratorRunTable)
        .values({
          id: runID,
          task_id: input.taskID,
          step_id: workerStep.id,
          model: workerStep.model,
          role: "worker",
          input_snapshot: JSON.stringify({ id: subtask.id, title: subtask.title }),
          status: "pending",
          started_at: 0,
        })
        .run()
        .pipe(Effect.orDie)
    }
  }
  const pending = plan.tasks.filter((subtask) => !reused.has(subtask.id))
  yield* setStep("worker", "running")
  yield* setCurrentStep(1)
  if (reused.size) yield* notify(`Reusing ${reused.size} completed worker${reused.size === 1 ? "" : "s"}.`)
  if (pending.length) {
    yield* notify(`Starting ${pending.length} parallel worker${pending.length === 1 ? "" : "s"}.`)
  }
  const outcomes = yield* Effect.all(
    pending.map((subtask) => {
      const runID = workerRuns.get(subtask.id)
      const work = (retry: boolean) =>
        input.runner.work({
          name: `${input.taskID}:${subtask.id}${retry ? ":retry" : ""}`,
          prompt: workerPrompt({ prompt: task.prompt, plan, task: subtask, messages: messages.slice() }),
          messages: messages.slice(),
        }).pipe(
          Effect.timeoutOrElse({
            duration: timeout,
            orElse: () => Effect.fail(new Error(`Worker ${subtask.id} exceeded timeout of ${timeout}ms`)),
          }),
        )
      const finish = (cause: unknown) => {
        const failure = TaskOrchestratorFailure.describe(cause)
        return Effect.gen(function* () {
          if (runID) yield* setWorkerRun(runID, "failed", { failure: failure.text })
          yield* notify(`Worker ${subtask.id} failed: ${failure.text}`)
          return { ok: false as const, subtask, failure: failure.text }
        })
      }
      return Effect.gen(function* () {
        if (runID) yield* setWorkerRun(runID, "running")
        yield* notify(`Worker ${subtask.id} started: ${subtask.title}`)
        const first = yield* Effect.exit(work(false))
        const result = Exit.isSuccess(first) || !TaskOrchestratorFailure.describe(first).retryable
          ? first
          : yield* Effect.gen(function* () {
              yield* notify(`Worker ${subtask.id} retrying after a transient provider failure.`)
              yield* Effect.sleep("1 second")
              return yield* Effect.exit(work(true))
            })
        if (Exit.isFailure(result)) return yield* finish(result)
        if (runID) yield* setWorkerRun(runID, "completed", { output: result.value.output, patch: result.value.patch })
        yield* notify(`Worker ${subtask.id} completed.`)
        return { ok: true as const, subtask, output: result.value.output, patch: result.value.patch }
      })
    }),
    { concurrency: 3 },
  )
  if (yield* stop()) return
  const fresh = outcomes.flatMap((outcome) => (outcome.ok ? [outcome] : []))
  for (const result of fresh) yield* append("worker", "submission", result.output)
  const failed = outcomes.filter((outcome) => !outcome.ok)
  if (failed.length) {
    const failure = `Worker ${failed.map((item) => item.subtask.id).join(", ")} failed`
    yield* notify(failure)
    yield* setStep("worker", "failed", undefined, failure)
    yield* input.db
      .update(TaskOrchestratorTaskTable)
      .set({ status: "failed", failure_reason: failure, updated_at: Date.now() })
      .where(eq(TaskOrchestratorTaskTable.id, input.taskID))
      .run()
      .pipe(Effect.orDie)
    return
  }
  const submitted = plan.tasks.flatMap((subtask) => {
    const saved = reused.get(subtask.id)
    if (saved) return [{ subtask, output: saved.output, patch: saved.patch }]
    const result = fresh.find((item) => item.subtask.id === subtask.id)
    return result ? [{ subtask, output: result.output, patch: result.patch }] : []
  })
  yield* setStep("worker", "completed", submitted.map((result) => result.output).join("\n\n"))

  if (yield* stop()) return
  yield* setStep("reviewer", "running")
  yield* setCurrentStep(2)
  yield* notify("Workers finished: reviewing submissions.")
  const reviewed = yield* Effect.all(
    submitted.map((submission) =>
      Effect.gen(function* () {
        let output = submission.output
        let patch = submission.patch
        let approved = false
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          const reviewOutput = yield* require(input.runner.review({
            name: `${input.taskID}:${submission.subtask.id}:review:${attempt}`,
            prompt: reviewPrompt({
              prompt: task.prompt,
              task: submission.subtask,
              output,
              patch: patch ?? "",
              messages: messages.slice(),
            }),
            messages: messages.slice(),
            patch: patch ?? "",
          }), timeout, `Reviewer ${submission.subtask.id}`)
          yield* append("reviewer", "review", reviewOutput)
          const decision = parseReview(reviewOutput)
          approved = decision.approved
          yield* notify(
            approved
              ? `Reviewer approved ${submission.subtask.id}.`
              : `Reviewer requested changes for ${submission.subtask.id}: ${decision.findings.map((item) => item.message).join("; ") || "no details"}`,
          )
          if (approved || attempt === maxRetries) break
          yield* notify(`Worker ${submission.subtask.id} started revision ${attempt + 1}.`)
          const revised = yield* require(input.runner.work({
            name: `${input.taskID}:${submission.subtask.id}:revision:${attempt}`,
            prompt: workerPrompt({
              prompt: task.prompt,
              plan,
              task: submission.subtask,
              messages: messages.slice(),
              patch,
            }),
            messages: messages.slice(),
            patch,
          }), timeout, `Worker revision ${submission.subtask.id}`)
          output = revised.output
          patch = revised.patch ?? patch
          const runID = workerRuns.get(submission.subtask.id)
          if (runID) yield* setWorkerRun(runID, "completed", { output, patch })
          yield* append("worker", "revision", output)
        }
        return { ...submission, output, patch, approved }
      }),
    ),
    { concurrency: 3 },
  )
  if (reviewed.some((item) => !item.approved)) {
    const failure = "Reviewer rejected a parallel submission after the retry limit"
    yield* notify(failure)
    yield* setStep("reviewer", "failed", undefined, failure)
    yield* input.db
      .update(TaskOrchestratorTaskTable)
      .set({ status: "failed", failure_reason: failure, updated_at: Date.now() })
      .where(eq(TaskOrchestratorTaskTable.id, input.taskID))
      .run()
      .pipe(Effect.orDie)
    return
  }
  yield* setStep("reviewer", "completed", reviewed.map((item) => item.output).join("\n\n"))

  if (yield* stop()) return
  const approved: Array<{ readonly subtask: PlanTask; readonly patch: string }> = []
  for (const item of reviewed) {
    const patch = item.patch?.trim()
    if (patch) approved.push({ subtask: item.subtask, patch })
  }
  for (const item of approved) {
    yield* require(input.runner.merge(item.patch), timeout, `Merge ${item.subtask.id}`)
  }
  yield* append("worker", "merge", `Merged ${approved.length} worker patch${approved.length === 1 ? "" : "es"}.`)
  yield* notify(`Merged ${approved.length} worker patch${approved.length === 1 ? "" : "es"}.`)

  yield* setStep("tester", "running")
  yield* setCurrentStep(3)
  yield* notify("Review passed: testing the merged result.")
  const testOutput = yield* require(input.runner.test({
    prompt: testerPrompt(task.prompt, plan, messages.slice()),
    messages: messages.slice(),
    patches: approved.map((item) => item.patch),
  }), timeout, "Tester")
  yield* append("tester", "test", testOutput)
  yield* setStep("tester", "completed", testOutput)

  if (yield* stop()) return
  yield* setStep("finalizer", "running")
  yield* setCurrentStep(4)
  yield* notify("Testing finished: preparing the final answer.")
  const finalOutput = yield* require(input.runner.finalize({
    prompt: finalizerPrompt({ prompt: task.prompt, plan, messages: messages.slice(), test: testOutput }),
    messages: messages.slice(),
    test: testOutput,
  }), timeout, "Finalizer")
  yield* append("finalizer", "final", finalOutput)
  yield* setStep("finalizer", "completed", finalOutput)
  yield* setCurrentStep(5)

  yield* input.db
    .update(TaskOrchestratorTaskTable)
    .set({ status: "completed", updated_at: Date.now() })
    .where(eq(TaskOrchestratorTaskTable.id, input.taskID))
    .run()
    .pipe(Effect.orDie)
})
