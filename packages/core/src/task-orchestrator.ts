export * as TaskOrchestrator from "./task-orchestrator"

import { asc, eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { AgentV2 } from "./agent"
import { Database } from "./database/database"
import { EventV2 } from "./event"
import { makeGlobalNode } from "./effect/app-node"
import { SessionV2 } from "./session"
import { SessionMessage } from "./session/message"
import { ProjectV2 } from "./project"
import { SessionSchema } from "./session/schema"
import { TaskOrchestratorRunTable, TaskOrchestratorStepTable, TaskOrchestratorTaskTable } from "./task-orchestrator/sql"
import { ModelV2 } from "./model"
import { Location } from "./location"
import { WorkspaceOwnership } from "./workspace-ownership"
import { TaskOrchestratorReview } from "./task-orchestrator/review"
import { TaskOrchestratorRetry } from "./task-orchestrator/retry"
import { TaskOrchestratorRetryPersistence } from "./task-orchestrator/retry-persistence"
import { TaskOrchestratorPostCommit } from "./task-orchestrator/post-commit"
import { TaskOrchestratorWorkerScheduler } from "./task-orchestrator/worker-scheduler"
import { TaskOrchestratorWorkerSchedulerService } from "./task-orchestrator/worker-scheduler-service"
import { TaskOrchestratorLoop } from "./task-orchestrator/loop"
import { TaskOrchestratorChanges } from "./task-orchestrator/changes"
import { TesterSessionBridge } from "./tester-session-bridge"

export const Roles = ["planner", "worker", "reviewer", "tester", "finalizer"] as const
export type Role = (typeof Roles)[number]
export type ModelAssignments = Record<Role, ModelV2.Ref>

export const review = (output: string, retryCount: number, maxRetries: number) => {
  const result = TaskOrchestratorReview.parse(output)
  if (!result) return { action: "fail" as const, retryCount, findings: [] as TaskOrchestratorReview.Finding[], reason: "Reviewer output was not valid structured JSON" }
  const decision = TaskOrchestratorReview.decision(result, retryCount, maxRetries)
  return { ...decision, findings: result.findings }
}

export const revisionPrompt = (findings: ReadonlyArray<TaskOrchestratorReview.Finding>) =>
  [
    "Revise the implementation to address these reviewer findings:",
    ...findings.map((finding) => `- ${finding.message}${finding.path ? ` (${finding.path}${finding.line === undefined ? "" : `:${finding.line}`})` : ""}`),
  ].join("\n")

export const revisionPlan = TaskOrchestratorReview.plan

export const retryTransition = TaskOrchestratorRetry.transition

export const applyRetryTransition = TaskOrchestratorRetryPersistence.apply

export const applyRetryTransitionAndSchedule = TaskOrchestratorPostCommit.applyAndSchedule

export const scheduleWorkerRevision = TaskOrchestratorWorkerScheduler.schedule

export const WorkerScheduler = TaskOrchestratorWorkerSchedulerService

export const Config = Schema.Struct({
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

export interface Task {
  readonly id: string
  readonly sessionID: SessionSchema.ID
  readonly status: "pending" | "running" | "completed" | "failed" | "paused" | "aborted"
  readonly currentStep: number
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
  readonly control: (input: { readonly taskID: string; readonly action: "pause" | "abort" | "retry" }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/TaskOrchestrator") {}

export class ExecutionUnavailable extends Schema.TaggedErrorClass<ExecutionUnavailable>()("TaskOrchestrator.ExecutionUnavailable", {
  message: Schema.String,
}) {}

export class ProjectMismatchError extends Schema.TaggedErrorClass<ProjectMismatchError>()("TaskOrchestrator.ProjectMismatchError", {
  sessionID: SessionSchema.ID,
  expected: ProjectV2.ID,
  actual: ProjectV2.ID,
}) {}

export class WorkspaceMismatchError extends Schema.TaggedErrorClass<WorkspaceMismatchError>()("TaskOrchestrator.WorkspaceMismatchError", {
  sessionID: SessionSchema.ID,
  expected: Schema.String,
  actual: Schema.String,
}) {}

const modelRef = (value: string): ModelV2.Ref => {
  const parsed = ModelV2.parse(value)
  return { providerID: parsed.providerID, id: parsed.modelID }
}

const prompts: Record<Role, string> = {
  planner: "You are the planner. Break the user task into verifiable steps. Do not modify files.",
  worker: "You are the worker. Implement the current plan step using authorized tools.",
  reviewer: "You are the reviewer. Inspect the current result and report risks or required revisions. Do not modify files.",
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
  yield* session.active.pipe(Effect.repeat({ until: (active) => !active.has(sessionID) }))
  return assistantText(yield* session.context(sessionID), promptID) ?? ""
})

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
    const ownership = yield* WorkspaceOwnership.Service
    const scheduler = yield* TaskOrchestratorWorkerSchedulerService.Service
    const tester = yield* TesterSessionBridge.Service
    const controls = new Map<string, "pause" | "abort" | "retry">()
    const audits = new Map<string, ReadonlyArray<string>>()
    const privateSessions = new Map<string, SessionSchema.ID>()
    const completedSteps = new Map<string, Array<readonly [Role, string]>>()

    const get = Effect.fn("TaskOrchestrator.get")(function* (taskID: string) {
      const row = yield* db.select().from(TaskOrchestratorTaskTable).where(eq(TaskOrchestratorTaskTable.id, taskID)).get().pipe(Effect.orDie)
      return row && { id: row.id, sessionID: row.session_id, status: row.status, currentStep: row.current_step }
    })

    const create = Effect.fn("TaskOrchestrator.create")(function* (input: Parameters<Interface["create"]>[0]) {
      const info = yield* session.get(input.sessionID)
      if (info.projectID !== input.projectID) {
        return yield* new ProjectMismatchError({ sessionID: input.sessionID, expected: info.projectID, actual: input.projectID })
      }
      const expectedWorkspaceKey = ownership.key(info.location)
      if (input.workspaceKey !== expectedWorkspaceKey) {
        return yield* new WorkspaceMismatchError({ sessionID: input.sessionID, expected: expectedWorkspaceKey, actual: input.workspaceKey })
      }
      const now = Date.now()
      const id = crypto.randomUUID()
      yield* db.insert(TaskOrchestratorTaskTable).values({
        id,
        session_id: input.sessionID,
        project_id: input.projectID,
        workspace_key: input.workspaceKey,
        prompt: input.prompt,
        status: "pending",
        current_step: 0,
        created_at: now,
        updated_at: now,
        timeout_ms: input.models.timeoutMs ?? 300000,
        max_retries: input.models.maxRetries ?? 1,
      }).run().pipe(Effect.orDie)
      for (const [ordinal, role] of Roles.entries()) {
        yield* db.insert(TaskOrchestratorStepTable).values({
          id: crypto.randomUUID(),
          task_id: id,
          ordinal,
          role,
          model: input.models[role] ?? input.models.worker,
          status: "pending",
          retry_count: 0,
        }).run().pipe(Effect.orDie)
      }
      return { id, sessionID: input.sessionID, status: "pending" as const, currentStep: 0 }
    })

    const run = Effect.fn("TaskOrchestrator.run")(function* (taskID: string) {
      const task = yield* db.select().from(TaskOrchestratorTaskTable).where(eq(TaskOrchestratorTaskTable.id, taskID)).get().pipe(Effect.orDie)
      if (!task) return
      const info = yield* session.get(task.session_id)
      yield* ownership.withOwnership({
        location: info.location,
        ownerID: taskID,
        effect: TaskOrchestratorLoop.run({
          db,
          taskID,
          runner: {
            output: ({ role, prompt }) => Effect.gen(function* () {
              const selectedRole = role as Role
              const step = yield* db.select().from(TaskOrchestratorStepTable).where(eq(TaskOrchestratorStepTable.task_id, taskID)).all().pipe(Effect.orDie)
              const selected = step.find((item) => item.role === role)
              const visible = selectedRole === "finalizer"
              const target = visible
                ? task.session_id
                : privateSessions.get(taskID) ??
                  (yield* session.create({ location: info.location, model: info.model, agent: AgentV2.ID.make(RoleAgents[selectedRole]) })).id
              if (!visible && !privateSessions.has(taskID)) privateSessions.set(taskID, target)
              yield* session.switchAgent({ sessionID: target, agent: RoleAgents[selectedRole] })
              if (selected) yield* session.switchModel({ sessionID: target, model: modelRef(selected.model) })
              const admitted = yield* session.prompt({
                sessionID: target,
                prompt: { text: rolePrompt(selectedRole, prompt, visible ? completedSteps.get(taskID) ?? [] : []) },
                delivery: "queue",
                resume: false,
              })
              yield* session.resume(target).pipe(Effect.forkDetach)
              const output = yield* roleOutput(session, target, admitted.id)
              if (!visible) completedSteps.set(taskID, [...(completedSteps.get(taskID) ?? []), [selectedRole, output]])
              return output
            }),
            schedule: (input) => scheduler.schedule(input),
            test: ({ prompt }) => tester.use({
              source: info,
              name: `${taskID}:tester`,
              run: (sessionID) => Effect.gen(function* () {
                const admitted = yield* session.prompt({
                  sessionID,
                  prompt: { text: rolePrompt("tester", prompt) },
                  delivery: "queue",
                  resume: false,
                })
                yield* session.resume(sessionID).pipe(Effect.forkDetach)
                const isolated = yield* session.get(sessionID)
                const changes = yield* TaskOrchestratorChanges.collect({
                  directory: isolated.location.directory,
                  run: (_command, directory) => Effect.tryPromise(async () => {
                    const result = Bun.spawn(["git", "status", "--porcelain"], { cwd: directory, stdout: "pipe" })
                    return await new Response(result.stdout).text()
                  }),
                }).pipe(Effect.orElseSucceed(() => []))
                audits.set(sessionID, changes)
                return yield* roleOutput(session, sessionID, admitted.id)
              }),
            }),
            audit: ({ changes }) => Effect.sync(() => audits.set(taskID, changes)),
            changes: (sessionID) => audits.get(sessionID) ?? [],
            control: (id) => controls.get(id),
          },
        }),
      })
    })

    const control = Effect.fn("TaskOrchestrator.control")(function* (input: Parameters<Interface["control"]>[0]) {
      const status = input.action === "abort" ? "aborted" : input.action === "pause" ? "paused" : "pending"
      controls.set(input.taskID, input.action)
      if (input.action !== "retry") {
        const row = yield* db.select().from(TaskOrchestratorTaskTable).where(eq(TaskOrchestratorTaskTable.id, input.taskID)).get().pipe(Effect.orDie)
        if (row) yield* session.interrupt(row.session_id)
      }
      yield* db.update(TaskOrchestratorTaskTable).set({ status, updated_at: Date.now() }).where(eq(TaskOrchestratorTaskTable.id, input.taskID)).run().pipe(Effect.asVoid, Effect.orDie)
    })

    // Do not enable execution until tool-level role restrictions and a shared
    // workspace ownership boundary cover ordinary Sessions as well as tasks.
    return Service.of({ create, run, get, control })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, SessionV2.node, WorkspaceOwnership.node, TaskOrchestratorWorkerSchedulerService.node, TesterSessionBridge.node],
})
