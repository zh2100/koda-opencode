export * as TaskOrchestrator from "./task-orchestrator"

import { and, asc, eq, sql } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { AgentV2 } from "./agent"
import { Database } from "./database/database"
import { EventV2 } from "./event"
import { makeGlobalNode } from "./effect/app-node"
import { SessionV2 } from "./session"
import { SessionExecution } from "./session/execution"
import { SessionMessage } from "./session/message"
import { ProjectV2 } from "./project"
import { SessionSchema } from "./session/schema"
import { TaskOrchestratorRunTable, TaskOrchestratorStepTable, TaskOrchestratorTaskTable } from "./task-orchestrator/sql"
import { ModelV2 } from "./model"
import { Location } from "./location"
import { AbsolutePath } from "./schema"
import { Git } from "./git"
import { TaskOrchestratorParallel } from "./task-orchestrator/parallel"
import { WorkspaceOwnership } from "./workspace-ownership"
import { TaskOrchestratorReview } from "./task-orchestrator/review"
import { TaskOrchestratorRetry } from "./task-orchestrator/retry"
import { TaskOrchestratorRetryPersistence } from "./task-orchestrator/retry-persistence"
import { TaskOrchestratorPostCommit } from "./task-orchestrator/post-commit"
import { TaskOrchestratorWorkerScheduler } from "./task-orchestrator/worker-scheduler"
import { TaskOrchestratorWorkerSchedulerService } from "./task-orchestrator/worker-scheduler-service"
import { TaskOrchestratorLoop } from "./task-orchestrator/loop"
import { TaskOrchestratorChanges } from "./task-orchestrator/changes"
import { TaskOrchestratorFailure } from "./task-orchestrator/failure"
import { TesterSessionBridge } from "./tester-session-bridge"
import { ToolOutputStore } from "./tool-output-store"

export const Roles = ["planner", "worker", "reviewer", "tester", "finalizer"] as const
export type Role = (typeof Roles)[number]
export type ModelAssignments = Record<Role, ModelV2.Ref>

export const review = (output: string, retryCount: number, maxRetries: number) => {
  const result = TaskOrchestratorReview.parse(output)
  if (!result)
    return {
      action: "fail" as const,
      retryCount,
      findings: [] as TaskOrchestratorReview.Finding[],
      reason: "Reviewer output was not valid structured JSON",
    }
  const decision = TaskOrchestratorReview.decision(result, retryCount, maxRetries)
  return { ...decision, findings: result.findings }
}

export const revisionPrompt = (findings: ReadonlyArray<TaskOrchestratorReview.Finding>) =>
  [
    "Revise the implementation to address these reviewer findings:",
    ...findings.map(
      (finding) =>
        `- ${finding.message}${finding.path ? ` (${finding.path}${finding.line === undefined ? "" : `:${finding.line}`})` : ""}`,
    ),
  ].join("\n")

export const revisionPlan = TaskOrchestratorReview.plan

export const retryTransition = TaskOrchestratorRetry.transition

export const applyRetryTransition = TaskOrchestratorRetryPersistence.apply

export const applyRetryTransitionAndSchedule = TaskOrchestratorPostCommit.applyAndSchedule

export const scheduleWorkerRevision = TaskOrchestratorWorkerScheduler.schedule

export const WorkerScheduler = TaskOrchestratorWorkerSchedulerService

export const Config = Schema.Struct({
  mode: Schema.optional(Schema.Literals(["sequential", "parallel"])),
  planner: Schema.String.pipe(Schema.optional),
  worker: Schema.String,
  reviewer: Schema.String.pipe(Schema.optional),
  tester: Schema.String.pipe(Schema.optional),
  finalizer: Schema.String.pipe(Schema.optional),
  fallback: Schema.optional(Schema.String),
  timeoutMs: Schema.optional(Schema.Int),
  maxRetries: Schema.optional(Schema.Int),
})
export type Config = typeof Config.Type

export const defaultConfig = (worker: string): Config => ({
  worker,
  reviewer: worker,
  tester: worker,
  finalizer: worker,
})

export type TaskStepStatus = "pending" | "running" | "needs_revision" | "failed" | "completed"
export type TaskStep = {
  readonly role: Role
  readonly status: TaskStepStatus
  readonly startedAt?: number
  readonly finishedAt?: number
}
export type TaskWorkerStatus = "pending" | "running" | "completed" | "failed"
export type TaskWorker = {
  readonly id: string
  readonly title: string
  readonly status: TaskWorkerStatus
  readonly startedAt?: number
  readonly finishedAt?: number
  readonly failureReason?: string
}

export interface Task {
  readonly id: string
  readonly sessionID: SessionSchema.ID
  readonly status: "pending" | "running" | "completed" | "failed" | "paused" | "aborted"
  readonly currentStep: number
  readonly steps?: ReadonlyArray<TaskStep>
  readonly workers?: ReadonlyArray<TaskWorker>
}

export interface Interface {
  readonly create: (input: {
    readonly sessionID: SessionSchema.ID
    readonly projectID: ProjectV2.ID
    readonly workspaceKey: string
    readonly prompt: string
    readonly models: Config
  }) => Effect.Effect<Task, SessionV2.Error | ExecutionUnavailable | ProjectMismatchError | WorkspaceMismatchError>
  readonly run: (taskID: string) => Effect.Effect<void, unknown>
  readonly get: (taskID: string) => Effect.Effect<Task | undefined>
  readonly control: (input: {
    readonly taskID: string
    readonly action: "pause" | "abort" | "retry"
  }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/TaskOrchestrator") {}

export class ExecutionUnavailable extends Schema.TaggedErrorClass<ExecutionUnavailable>()(
  "TaskOrchestrator.ExecutionUnavailable",
  {
    message: Schema.String,
  },
) {}

export class ProjectMismatchError extends Schema.TaggedErrorClass<ProjectMismatchError>()(
  "TaskOrchestrator.ProjectMismatchError",
  {
    sessionID: SessionSchema.ID,
    expected: ProjectV2.ID,
    actual: ProjectV2.ID,
  },
) {}

export class WorkspaceMismatchError extends Schema.TaggedErrorClass<WorkspaceMismatchError>()(
  "TaskOrchestrator.WorkspaceMismatchError",
  {
    sessionID: SessionSchema.ID,
    expected: Schema.String,
    actual: Schema.String,
  },
) {}

const modelRef = (value: string): ModelV2.Ref => {
  const parsed = ModelV2.parse(value)
  return { providerID: parsed.providerID, id: parsed.modelID }
}

const prompts: Record<Role, string> = {
  planner: "You are the planner. Break the user task into verifiable steps. Do not modify files.",
  worker: "You are the worker. Implement the current plan step using authorized tools.",
  reviewer:
    'You are the reviewer. Inspect the current result and report risks or required revisions. Do not modify files. Return only JSON: {"approved":true,"findings":[{"message":"...","path":"optional.ts","line":1}]}.',
  tester: "You are the tester. Run appropriate validation and report concrete failures. Avoid modifying source files.",
  finalizer: "You are the finalizer. Summarize the verified result, changed files, risks, and follow-up actions.",
}

const assistantText = (context: ReadonlyArray<SessionMessage.Message>, promptID?: SessionMessage.ID) => {
  const start = promptID === undefined ? 0 : Math.max(0, context.findIndex((message) => message.id === promptID) + 1)
  return context
    .slice(start)
    .findLast((message): message is SessionMessage.Assistant => message.type === "assistant")
    ?.content.filter((part): part is SessionMessage.AssistantText => part.type === "text")
    .map((part) => part.text)
    .join("")
}

const roleOutput = Effect.fnUntraced(function* (
  session: SessionV2.Interface,
  sessionID: SessionSchema.ID,
  promptID: SessionMessage.ID,
) {
  while (true) {
    const context = yield* session.context(sessionID)
    const start = Math.max(0, context.findIndex((message) => message.id === promptID) + 1)
    const assistant = context.slice(start).findLast((message) => message.type === "assistant")
    if (assistant?.type === "assistant" && assistant.time.completed !== undefined)
      return assistantText(context, promptID) ?? ""
    yield* Effect.sleep("200 millis")
  }
})

const WorkerSnapshot = Schema.Struct({ id: Schema.String, title: Schema.String })
const workerSnapshot = (value: string) => {
  const json = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(value)
  if (json._tag === "None") return undefined
  const parsed = Schema.decodeUnknownOption(WorkerSnapshot)(json.value)
  return parsed._tag === "Some" ? parsed.value : undefined
}

const workerStatus = (status: string): TaskWorker["status"] => {
  if (status === "pending") return "pending"
  if (status === "completed") return "completed"
  if (status === "failed" || status === "timed_out" || status === "needs_revision") return "failed"
  return "running"
}

const failureSummary = (cause: unknown) => TaskOrchestratorFailure.describe(cause).text

const roleLabel = (role: Role) => role.charAt(0).toUpperCase() + role.slice(1)

const outputExcerpt = (text: string, limit = 4_000) =>
  text.length <= limit ? text : `${text.slice(0, limit)}\n\n[truncated ${text.length - limit} characters]`

const rolePrompt = (role: Role, prompt: string, prior: ReadonlyArray<readonly [Role, string]> = []) =>
  [
    prompts[role],
    "This is a fresh orchestration step. Produce only the new result required by your role.",
    "User task:",
    prompt,
    ...(prior.length
      ? ["Completed orchestration steps:", ...prior.map(([item, output]) => `${item}:\n${output}`)]
      : []),
  ].join("\n\n")

export const RoleAgents: Record<Role, string> = {
  planner: "orchestrator-readonly",
  worker: "build",
  reviewer: "orchestrator-readonly",
  tester: "orchestrator-tester",
  finalizer: "orchestrator-readonly",
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db
    const session = yield* SessionV2.Service
    const execution = yield* SessionExecution.Service
    const ownership = yield* WorkspaceOwnership.Service
    const scheduler = yield* TaskOrchestratorWorkerSchedulerService.Service
    const tester = yield* TesterSessionBridge.Service
    const git = yield* Git.Service
    const controls = new Map<string, "pause" | "abort" | "retry">()
    const audits = new Map<string, ReadonlyArray<string>>()
    const privateSessions = new Map<string, SessionSchema.ID>()
    const activeSessions = new Map<string, Set<SessionSchema.ID>>()
    const completedSteps = new Map<string, Array<readonly [Role, string]>>()

    const get = Effect.fn("TaskOrchestrator.get")(function* (taskID: string) {
      const row = yield* db
        .select()
        .from(TaskOrchestratorTaskTable)
        .where(eq(TaskOrchestratorTaskTable.id, taskID))
        .get()
        .pipe(Effect.orDie)
      if (!row) return undefined
      const steps = yield* db
        .select()
        .from(TaskOrchestratorStepTable)
        .where(eq(TaskOrchestratorStepTable.task_id, taskID))
        .orderBy(asc(TaskOrchestratorStepTable.ordinal))
        .all()
        .pipe(Effect.orDie)
      const workers =
        row.mode === "parallel"
          ? yield* db
              .select()
              .from(TaskOrchestratorRunTable)
              .where(and(eq(TaskOrchestratorRunTable.task_id, taskID), eq(TaskOrchestratorRunTable.role, "worker")))
              .orderBy(sql`rowid`)
              .all()
              .pipe(Effect.orDie)
          : []
      return {
        id: row.id,
        sessionID: row.session_id,
        status: row.status,
        currentStep: row.current_step,
        failureReason: row.failure_reason ?? undefined,
        steps: steps.map((step) => ({
          role: step.role,
          status: step.status,
          startedAt: step.started_at ?? undefined,
          finishedAt: step.finished_at ?? undefined,
        })),
        workers: workers.map((run) => {
          const snapshot = workerSnapshot(run.input_snapshot)
          return {
            id: snapshot?.id ?? run.id,
            title: snapshot?.title ?? "",
            status: workerStatus(run.status),
            startedAt: run.started_at || undefined,
            finishedAt: run.finished_at ?? undefined,
            failureReason: run.failure_reason ?? undefined,
          }
        }),
      }
    })

    const create = Effect.fn("TaskOrchestrator.create")(function* (input: Parameters<Interface["create"]>[0]) {
      const info = yield* session.get(input.sessionID)
      if (info.projectID !== input.projectID) {
        return yield* new ProjectMismatchError({
          sessionID: input.sessionID,
          expected: info.projectID,
          actual: input.projectID,
        })
      }
      const expectedWorkspaceKey = ownership.key(info.location)
      if (input.workspaceKey !== expectedWorkspaceKey) {
        return yield* new WorkspaceMismatchError({
          sessionID: input.sessionID,
          expected: expectedWorkspaceKey,
          actual: input.workspaceKey,
        })
      }
      const now = Date.now()
      const id = crypto.randomUUID()
      yield* db
        .insert(TaskOrchestratorTaskTable)
        .values({
          id,
          session_id: input.sessionID,
          project_id: input.projectID,
          workspace_key: input.workspaceKey,
          prompt: input.prompt,
          status: "pending",
          mode: input.models.mode ?? "sequential",
          current_step: 0,
          created_at: now,
          updated_at: now,
          timeout_ms: input.models.timeoutMs ?? 900000,
          max_retries: input.models.maxRetries ?? 1,
        })
        .run()
        .pipe(Effect.orDie)
      for (const [ordinal, role] of Roles.entries()) {
        yield* db
          .insert(TaskOrchestratorStepTable)
          .values({
            id: crypto.randomUUID(),
            task_id: id,
            ordinal,
            role,
            model: input.models[role] ?? input.models.worker,
            status: "pending",
            retry_count: 0,
          })
          .run()
          .pipe(Effect.orDie)
      }
      yield* session.recordPrompt({ sessionID: input.sessionID, prompt: { text: input.prompt } }).pipe(Effect.ignore)
      return { id, sessionID: input.sessionID, status: "pending" as const, currentStep: 0 }
    })

    const run = Effect.fn("TaskOrchestrator.run")(function* (taskID: string) {
      const task = yield* db
        .select()
        .from(TaskOrchestratorTaskTable)
        .where(eq(TaskOrchestratorTaskTable.id, taskID))
        .get()
        .pipe(Effect.orDie)
      if (!task) return
      yield* Effect.logInfo("orchestrator run loaded", { taskID, sessionID: task.session_id, status: task.status })
      const info = yield* session.get(task.session_id)
      const steps = yield* db
        .select()
        .from(TaskOrchestratorStepTable)
        .where(eq(TaskOrchestratorStepTable.task_id, taskID))
        .all()
        .pipe(Effect.orDie)
      const modelFor = (role: Role) => {
        const model = steps.find((step) => step.role === role)?.model
        return model ? modelRef(model) : undefined
      }

      if (task.mode === "parallel") {
        const applyPatch = (directory: AbsolutePath, patch: string) =>
          Effect.gen(function* () {
            const repository = yield* git.repo.discover(directory)
            if (!repository) return yield* Effect.fail(new Error(`No git repository for ${directory}`))
            yield* git.change.apply({
              repository,
              path: repository.worktree,
              changes: Git.ChangeSet.make(patch),
            })
          })

        const capturePatch = (directory: AbsolutePath) =>
          Effect.gen(function* () {
            const repository = yield* git.repo.discover(directory)
            if (!repository) return undefined
            const patch = yield* git.change.capture({ repository, path: directory })
            return patch.trim() ? patch : undefined
          })

        const ask = (sessionID: SessionSchema.ID, prompt: string) =>
          Effect.gen(function* () {
            const admitted = yield* session.prompt({
              sessionID,
              prompt: { text: prompt },
              delivery: "queue",
              resume: false,
            })
            yield* session.resume(sessionID)
            return yield* roleOutput(session, sessionID, admitted.id)
          })

        const isolated = <A, E, R>(input: {
          readonly name: string
          readonly title: string
          readonly agent: string
          readonly model?: ModelV2.Ref
          readonly patches?: ReadonlyArray<string>
          readonly run: (sessionID: SessionSchema.ID, directory: AbsolutePath) => Effect.Effect<A, E, R>
        }) =>
          tester.use({
            source: info,
            name: input.name,
            title: input.title,
            agent: input.agent,
            model: input.model,
            run: (sessionID) => {
              const active = activeSessions.get(taskID) ?? new Set<SessionSchema.ID>()
              active.add(sessionID)
              activeSessions.set(taskID, active)
              return Effect.gen(function* () {
                const created = yield* session.get(sessionID)
                const directory = created.location.directory
                yield* Effect.forEach(
                  input.patches ?? [],
                  (patch) => (patch.trim() ? applyPatch(directory, patch) : Effect.void),
                  { discard: true },
                )
                return yield* input.run(sessionID, directory)
              }).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    active.delete(sessionID)
                    if (!active.size) activeSessions.delete(taskID)
                  }),
                ),
              )
            },
          })

        const runner: TaskOrchestratorParallel.Runner = {
          plan: ({ prompt }) =>
            isolated({
              name: `${taskID}:planner:${crypto.randomUUID()}`,
              title: "Collaboration planner",
              agent: RoleAgents.planner,
              model: modelFor("planner"),
              run: (sessionID) => ask(sessionID, prompt),
            }),
          discuss: ({ role, prompt }) =>
            isolated({
              name: `${taskID}:${role}:${crypto.randomUUID()}`,
              title: `Collaboration ${role}`,
              agent: RoleAgents[role],
              model: modelFor(role),
              run: (sessionID) => ask(sessionID, prompt),
            }),
          work: ({ name, prompt, patch }) =>
            isolated({
              name,
              title: `Collaboration worker ${name.split(":").at(-1) ?? ""}`.trim(),
              agent: RoleAgents.worker,
              model: modelFor("worker"),
              patches: patch ? [patch] : undefined,
              run: (sessionID, directory) =>
                Effect.scoped(
                  Effect.gen(function* () {
                    yield* ToolOutputStore.limitSession(sessionID, {
                      maxLines: ToolOutputStore.WORKER_MAX_LINES,
                      maxBytes: ToolOutputStore.WORKER_MAX_BYTES,
                    })
                    const output = yield* ask(sessionID, prompt)
                    return { output, patch: yield* capturePatch(directory) }
                  }),
                ),
            }),
          review: ({ name, prompt, patch }) =>
            isolated({
              name,
              title: `Collaboration review ${name.split(":").at(-2) ?? ""}`.trim(),
              agent: RoleAgents.reviewer,
              model: modelFor("reviewer"),
              patches: patch.trim() ? [patch] : undefined,
              run: (sessionID) => ask(sessionID, prompt),
            }),
          test: ({ prompt, patches }) =>
            isolated({
              name: `${taskID}:tester:${crypto.randomUUID()}`,
              title: "Collaboration tester",
              agent: RoleAgents.tester,
              model: modelFor("tester"),
              patches,
              run: (sessionID) => ask(sessionID, prompt),
            }),
          finalize: ({ prompt }) =>
            isolated({
              name: `${taskID}:finalizer:${crypto.randomUUID()}`,
              title: "Collaboration finalizer",
              agent: RoleAgents.finalizer,
              model: modelFor("finalizer"),
              run: (sessionID) => ask(sessionID, prompt),
            }).pipe(
              Effect.tap((output) => {
                const model = modelFor("finalizer") ?? modelFor("worker") ?? info.model
                if (!model) return Effect.void
                return session
                  .notice({
                    sessionID: task.session_id,
                    text: `Finalizer completed.\n\n${output}`,
                    agent: RoleAgents.finalizer,
                    model,
                  })
                  .pipe(Effect.ignore)
              }),
            ),
          notice: (text) => {
            const model = modelFor("finalizer") ?? modelFor("worker") ?? info.model
            if (!model) return Effect.void
            return session.notice({
              sessionID: task.session_id,
              text,
              agent: RoleAgents.finalizer,
              model,
            })
          },
          merge: (patch) => applyPatch(AbsolutePath.make(info.location.directory), patch),
          control: (id) => controls.get(id),
        }

        yield* TaskOrchestratorParallel.run({ db, taskID, runner }).pipe(
          Effect.tap(() => Effect.logInfo("orchestrator parallel finished", { taskID })),
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              const control = controls.get(taskID)
              const status = control === "pause" ? "paused" : control === "abort" ? "aborted" : "failed"
              yield* db
                .update(TaskOrchestratorTaskTable)
                .set({ status, failure_reason: String(cause), updated_at: Date.now() })
                .where(eq(TaskOrchestratorTaskTable.id, taskID))
                .run()
                .pipe(Effect.orDie)
              const model = modelFor("finalizer") ?? modelFor("worker") ?? info.model
              if (model)
                yield* session
                  .notice({
                    sessionID: task.session_id,
                    text: `Collaboration failed: ${failureSummary(cause)}`,
                    agent: RoleAgents.finalizer,
                    model,
                  })
                  .pipe(Effect.ignore)
              yield* Effect.logError("orchestrator parallel failed", { taskID, cause })
            }),
          ),
        )
        return
      }

      // SessionExecution owns the workspace while each role session runs. Do not
      // hold the same lock around the orchestrator: role output resumes a Session
      // whose runner must acquire that lock before it can produce a result.
      yield* TaskOrchestratorLoop.run({
        db,
        taskID,
        runner: {
          output: ({ role, prompt }) =>
            Effect.gen(function* () {
              const selectedRole = role as Role
              const selected = steps.find((item) => item.role === role)
              const target =
                privateSessions.get(taskID) ??
                (yield* session.create({
                  location: info.location,
                  model: info.model,
                  agent: AgentV2.ID.make(RoleAgents[selectedRole]),
                })).id
              if (!privateSessions.has(taskID)) privateSessions.set(taskID, target)
              yield* session.switchAgent({ sessionID: target, agent: RoleAgents[selectedRole] })
              if (selected) yield* session.switchModel({ sessionID: target, model: modelRef(selected.model) })
              const model = selected ? modelRef(selected.model) : info.model
              const admitted = yield* session.prompt({
                sessionID: target,
                prompt: { text: rolePrompt(selectedRole, prompt, completedSteps.get(taskID) ?? []) },
                delivery: "queue",
                resume: false,
              })
              yield* session.resume(target)
              const output = yield* roleOutput(session, target, admitted.id)
              completedSteps.set(taskID, [...(completedSteps.get(taskID) ?? []), [selectedRole, output]])
              if (model)
                yield* session
                  .notice({
                    sessionID: task.session_id,
                    text:
                      selectedRole === "reviewer"
                        ? "Reviewer completed."
                        : `${roleLabel(selectedRole)} completed.\n\n${selectedRole === "finalizer" ? output : outputExcerpt(output)}`,
                    agent: RoleAgents[selectedRole],
                    model,
                  })
                  .pipe(Effect.ignore)
              return output
            }),
          schedule: (input) => scheduler.schedule(input),
          test: ({ prompt }) =>
            tester.use({
              source: info,
              name: `${taskID}:tester`,
              run: (sessionID) =>
                Effect.gen(function* () {
                  const admitted = yield* session.prompt({
                    sessionID,
                    prompt: { text: rolePrompt("tester", prompt, completedSteps.get(taskID) ?? []) },
                    delivery: "queue",
                    resume: false,
                  })
                  yield* session.resume(sessionID)
                  const isolated = yield* session.get(sessionID)
                  const changes = yield* TaskOrchestratorChanges.collect({
                    directory: isolated.location.directory,
                    run: (_command, directory) =>
                      Effect.tryPromise(async () => {
                        const result = Bun.spawn(["git", "status", "--porcelain"], {
                          cwd: directory,
                          stdout: "pipe",
                        })
                        return await new Response(result.stdout).text()
                      }),
                  }).pipe(Effect.orElseSucceed(() => []))
                  audits.set(sessionID, changes)
                  const output = yield* roleOutput(session, sessionID, admitted.id)
                  const model = modelFor("tester") ?? modelFor("worker") ?? info.model
                  if (model)
                    yield* session
                      .notice({
                        sessionID: task.session_id,
                        text: `Tester completed.\n\n${outputExcerpt(output)}`,
                        agent: RoleAgents.tester,
                        model,
                      })
                      .pipe(Effect.ignore)
                  return output
                }),
            }),
          notice: ({ role, text }) => {
            const selected = steps.find((item) => item.role === role)
            const model = selected ? modelRef(selected.model) : (modelFor("worker") ?? info.model)
            if (!model) return Effect.void
            return session
              .notice({ sessionID: task.session_id, text, agent: RoleAgents[role], model })
              .pipe(Effect.ignore)
          },
          audit: ({ changes }) => Effect.sync(() => audits.set(taskID, changes)),
          changes: (sessionID) => audits.get(sessionID) ?? [],
          control: (id) => controls.get(id),
          interrupt: () => Effect.forEach([...privateSessions.values()], execution.interrupt, { discard: true }),
        },
      }).pipe(
        Effect.tap(() => Effect.logInfo("orchestrator loop finished", { taskID })),
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const failure = String(cause)
            const now = Date.now()
            yield* db
              .update(TaskOrchestratorStepTable)
              .set({ status: "failed", failure_reason: failure, finished_at: now })
              .where(
                and(eq(TaskOrchestratorStepTable.task_id, taskID), eq(TaskOrchestratorStepTable.status, "running")),
              )
              .run()
              .pipe(Effect.orDie)
            yield* db
              .update(TaskOrchestratorTaskTable)
              .set({ status: "failed", failure_reason: failure, updated_at: now })
              .where(eq(TaskOrchestratorTaskTable.id, taskID))
              .run()
              .pipe(Effect.orDie)
            const model = modelFor("finalizer") ?? modelFor("worker") ?? info.model
            if (model)
              yield* session
                .notice({
                  sessionID: task.session_id,
                  text: `Collaboration failed: ${failureSummary(cause)}`,
                  agent: RoleAgents.finalizer,
                  model,
                })
                .pipe(Effect.ignore)
            yield* Effect.logError("orchestrator loop failed", { taskID, cause })
          }),
        ),
      )
    })

    const control = Effect.fn("TaskOrchestrator.control")(function* (input: Parameters<Interface["control"]>[0]) {
      const status = input.action === "abort" ? "aborted" : input.action === "pause" ? "paused" : "pending"
      controls.set(input.taskID, input.action)
      if (input.action !== "retry") {
        const row = yield* db
          .select()
          .from(TaskOrchestratorTaskTable)
          .where(eq(TaskOrchestratorTaskTable.id, input.taskID))
          .get()
          .pipe(Effect.orDie)
        if (row) yield* session.interrupt(row.session_id)
        const privateSessionID = privateSessions.get(input.taskID)
        if (privateSessionID) yield* execution.interrupt(privateSessionID)
        yield* Effect.forEach([...(activeSessions.get(input.taskID) ?? [])], execution.interrupt, { discard: true })
      }
      yield* db
        .update(TaskOrchestratorTaskTable)
        .set({ status, updated_at: Date.now() })
        .where(eq(TaskOrchestratorTaskTable.id, input.taskID))
        .run()
        .pipe(Effect.asVoid, Effect.orDie)
    })

    // Do not enable execution until tool-level role restrictions and a shared
    // workspace ownership boundary cover ordinary Sessions as well as tasks.
    return Service.of({ create, run, get, control })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [
    Database.node,
    SessionV2.node,
    SessionExecution.node,
    WorkspaceOwnership.node,
    TaskOrchestratorWorkerSchedulerService.node,
    TesterSessionBridge.node,
    Git.node,
  ],
})
