import { describe, expect } from "bun:test"
import path from "path"
import { DateTime, Effect, Layer, Stream } from "effect"
import { Headers } from "effect/unstable/http"
import { LLM } from "@opencode-ai/llm"
import { LLMClient } from "@opencode-ai/llm/route"
import { Prompt } from "@opencode-ai/schema/prompt"
import { Relay } from "@opencode-ai/schema/relay"
import { RelayError } from "@opencode-ai/schema/relay-error"
import { RelayModel } from "@opencode-ai/schema/relay-model"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { Global } from "@opencode-ai/core/global"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { RelayAuth } from "@opencode-ai/core/relay-auth"
import { RelayCatalog } from "@opencode-ai/core/relay-catalog"
import { RelayGate } from "@opencode-ai/core/relay-gate"
import { ScheduledTaskStore } from "@opencode-ai/core/scheduled-task"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionInput } from "@opencode-ai/schema/session-input"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const it = testEffect(Layer.empty)

const managed = (vendorId: Relay.VendorID, modelId: string, visible: boolean) =>
  RelayModel.Managed.make({
    vendorId,
    modelId: ModelV2.ID.make(modelId),
    visible,
    reasoningCapabilities: [],
    assignmentSource: "manual",
    lastSeenAt: DateTime.makeUnsafe(0),
    upstreamPresent: true,
  })

const catalogLayer = (items: RelayModel.Managed[]) =>
  Layer.succeed(
    RelayCatalog.Service,
    RelayCatalog.Service.of({
      candidates: () => Effect.succeed([]),
      managed: () => Effect.succeed(items),
      hasManaged: () => items.length > 0,
      visible: (id) => items.some((item) => RelayCatalog.modelID(item.vendorId, item.modelId) === id && item.visible),
      refresh: () => Effect.die("unused"),
      probe: () => Effect.die("unused"),
      setVisibility: () => Effect.die("unused"),
      synchronize: () => Effect.die("unexpected relay sync in this fixture"),
      syncVendors: () => Effect.die("unused"),
      apply: () => undefined,
    }),
  )

const authLayer = (resolved: Record<string, { key: string; baseURL: string }>, calls: string[]) =>
  Layer.succeed(
    RelayAuth.Service,
    RelayAuth.Service.of({
      get: () => Effect.die("unused"),
      capture: () => Effect.die("unused"),
      setVendor: () => Effect.die("unused"),
      clearVendorKey: () => Effect.die("unused"),
      deleteVendor: () => Effect.die("unused"),
      resolve: (vendorId) => {
        calls.push(vendorId)
        const item = resolved[vendorId]
        if (!item) {
          return Effect.fail(
            new RelayAuth.AuthError({
              info: RelayError.Info.make({ code: "KEY_MISSING", retryable: false, requestId: vendorId }),
            }),
          )
        }
        return Effect.succeed(item)
      },
    }),
  )

const open = (
  root: string,
  created: SessionV2.Info[],
  catalog: Layer.Layer<RelayCatalog.Service>,
  auth: Layer.Layer<RelayAuth.Service>,
  projects?: ProjectV2.Interface["resolve"],
) =>
  AppNodeBuilder.build(LayerNode.group([ScheduledTaskStore.node, Database.node]), [
    [Database.node, Database.layerFromPath(path.join(root, "opencode.db"))],
    [Global.node, Global.layerWith({ data: root })],
    [
      ProjectV2.node,
      Layer.succeed(
        ProjectV2.Service,
        ProjectV2.Service.of({
          directories: () => Effect.die("unused"),
          resolve: projects ?? ((directory) => Effect.succeed({ id: ProjectV2.ID.make(directory), directory })),
          commit: () => Effect.void,
        }),
      ),
    ],
    [RelayGate.node, RelayGate.layerWith({ scheduledTasks: true })],
    [RelayCatalog.node, catalog],
    [RelayAuth.node, auth],
    [
      SessionV2.node,
      Layer.succeed(
        SessionV2.Service,
        SessionV2.Service.of({
          list: () => Effect.succeed(created),
          create: (input) => {
            const info = SessionV2.Info.make({
              id: SessionV2.ID.descending(),
              projectID: ProjectV2.ID.global,
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
              title: "scheduled",
              approvalMode: input.approvalMode,
              location: input.location,
              model: input.model,
            })
            created.push(info)
            return Effect.succeed(info)
          },
          get: () => Effect.die("unused"),
          setTitle: () => Effect.void,
          remove: () => Effect.void,
          messages: () => Effect.succeed([]),
          message: () => Effect.succeed(undefined),
          context: () => Effect.succeed([]),
          events: () => Stream.die("unused"),
          history: () => Effect.succeed({ events: [], hasMore: false }),
          pending: () => Effect.die("unused"),
          switchAgent: () => Effect.void,
          switchModel: () => Effect.void,
          notice: () => Effect.void,
          recordPrompt: () => Effect.die("unused"),
          prompt: (input) =>
            Effect.succeed(
              SessionInput.Admitted.make({
                admittedSeq: 0,
                id: SessionMessage.ID.make("msg_model"),
                sessionID: input.sessionID,
                prompt: Prompt.make({ text: input.prompt.text }),
                delivery: "steer",
                timeCreated: DateTime.makeUnsafe(0),
              }),
            ),
          shell: () => Effect.void,
          skill: () => Effect.void,
          compact: () => Effect.void,
          wait: () => Effect.void,
          active: Effect.succeed(new Set()),
          resume: () => Effect.void,
          interrupt: () => Effect.void,
          revert: { stage: () => Effect.die("unused"), clear: () => Effect.void, commit: () => Effect.void },
        }),
      ),
    ],
  ])

const taskInput = (
  directory: AbsolutePath,
  now: DateTime.Utc,
  model: { id: ModelV2.ID; providerID: ProviderV2.ID },
) => ({
  name: "identity",
  projectID: ProjectV2.ID.make(directory),
  location: { directory },
  prompt: Prompt.make({ text: "identity" }),
  schedule: "daily" as const,
  timezone: "UTC",
  runAt: DateTime.add(now, { hours: 2 }),
  model,
  approvalMode: "auto" as const,
  enabled: true,
})

describe("ScheduledTask model identity", () => {
  it.live("M01 runs an ordinary OpenAI model while Relay has managed entries", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const created: SessionV2.Info[] = []
          const resolved: string[] = []
          const directory = AbsolutePath.make(tmp.path)
          const result = yield* Effect.gen(function* () {
            const tasks = yield* ScheduledTaskStore.Service
            const task = yield* tasks.create(
              taskInput(directory, DateTime.toUtc(yield* DateTime.now), {
                id: ModelV2.ID.make("gpt-4.1"),
                providerID: ProviderV2.ID.openai,
              }),
            )
            const finished = yield* tasks.runNow(task.id)
            return { status: finished.status, enabled: (yield* tasks.list())[0]?.enabled, model: created[0]?.model }
          }).pipe(
            Effect.provide(
              open(
                tmp.path,
                created,
                catalogLayer([managed(Relay.VendorID.chatgpt, "gpt-4.1", true)]),
                authLayer({ chatgpt: { key: "relay-secret", baseURL: "https://relay.example" } }, resolved),
              ),
            ),
          )
          expect(result.status).toBe("completed")
          expect(result.enabled).toBe(true)
          expect(result.model?.providerID).toBe(ProviderV2.ID.openai)
          expect(resolved).toEqual([])
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("M02 keeps an ordinary model with the same id off the Relay credential", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const created: SessionV2.Info[] = []
          const resolved: string[] = []
          const directory = AbsolutePath.make(tmp.path)
          const shared = ModelV2.ID.make("shared-model")
          const result = yield* Effect.gen(function* () {
            const tasks = yield* ScheduledTaskStore.Service
            const task = yield* tasks.create(
              taskInput(directory, DateTime.toUtc(yield* DateTime.now), {
                id: shared,
                providerID: ProviderV2.ID.openai,
              }),
            )
            return yield* tasks.runNow(task.id)
          }).pipe(
            Effect.provide(
              open(
                tmp.path,
                created,
                catalogLayer([managed(Relay.VendorID.chatgpt, "shared-model", true)]),
                authLayer({ chatgpt: { key: "relay-secret", baseURL: "https://relay.example" } }, resolved),
              ),
            ),
          )
          expect(result.status).toBe("completed")
          expect(created[0]?.model?.providerID).toBe(ProviderV2.ID.openai)
          expect(resolved).toEqual([])
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("M03 runs a visible Relay model with its vendor credential", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const created: SessionV2.Info[] = []
          const resolved: string[] = []
          const directory = AbsolutePath.make(tmp.path)
          const result = yield* Effect.gen(function* () {
            const tasks = yield* ScheduledTaskStore.Service
            const task = yield* tasks.create(
              taskInput(directory, DateTime.toUtc(yield* DateTime.now), {
                id: RelayCatalog.modelID(Relay.VendorID.chatgpt, "gpt-relay"),
                providerID: ProviderV2.ID.leidiandonghua,
              }),
            )
            return yield* tasks.runNow(task.id)
          }).pipe(
            Effect.provide(
              open(
                tmp.path,
                created,
                catalogLayer([managed(Relay.VendorID.chatgpt, "gpt-relay", true)]),
                authLayer({ chatgpt: { key: "relay-secret", baseURL: "https://relay.example" } }, resolved),
              ),
            ),
          )
          expect(result.status).toBe("completed")
          expect(created[0]?.model?.providerID).toBe(ProviderV2.ID.leidiandonghua)
          expect(resolved).toEqual([Relay.VendorID.chatgpt])
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("M04 pauses a hidden or missing Relay model", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const created: SessionV2.Info[] = []
          const directory = AbsolutePath.make(tmp.path)
          const result = yield* Effect.gen(function* () {
            const tasks = yield* ScheduledTaskStore.Service
            const hidden = yield* tasks.create(
              taskInput(directory, DateTime.toUtc(yield* DateTime.now), {
                id: RelayCatalog.modelID(Relay.VendorID.chatgpt, "hidden"),
                providerID: ProviderV2.ID.leidiandonghua,
              }),
            )
            const missing = yield* tasks.create({
              ...taskInput(directory, DateTime.toUtc(yield* DateTime.now), {
                id: RelayCatalog.modelID(Relay.VendorID.chatgpt, "missing"),
                providerID: ProviderV2.ID.leidiandonghua,
              }),
              name: "missing",
            })
            return {
              hidden: (yield* tasks.runNow(hidden.id)).error?.code,
              missing: (yield* tasks.runNow(missing.id)).error?.code,
              enabled: (yield* tasks.list()).map((task) => task.enabled),
            }
          }).pipe(
            Effect.provide(
              open(
                tmp.path,
                created,
                catalogLayer([managed(Relay.VendorID.chatgpt, "hidden", false)]),
                authLayer({}, []),
              ),
            ),
          )
          expect(result.hidden).toBe("MODEL_UNAVAILABLE")
          expect(result.missing).toBe("MODEL_UNAVAILABLE")
          expect(result.enabled).toEqual([false, false])
          expect(created).toHaveLength(0)
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("M05 resolves a custom vendor from the encoded model id", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const created: SessionV2.Info[] = []
          const resolved: string[] = []
          const directory = AbsolutePath.make(tmp.path)
          const vendor = Relay.VendorID.make("acme")
          const result = yield* Effect.gen(function* () {
            const tasks = yield* ScheduledTaskStore.Service
            const task = yield* tasks.create(
              taskInput(directory, DateTime.toUtc(yield* DateTime.now), {
                id: RelayCatalog.modelID(vendor, "local-model"),
                providerID: ProviderV2.ID.leidiandonghua,
              }),
            )
            return yield* tasks.runNow(task.id)
          }).pipe(
            Effect.provide(
              open(
                tmp.path,
                created,
                catalogLayer([managed(vendor, "local-model", true)]),
                authLayer({ acme: { key: "custom-secret", baseURL: "https://acme.example" } }, resolved),
              ),
            ),
          )
          expect(result.status).toBe("completed")
          expect(resolved).toEqual(["acme"])
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("M06 pauses when the Relay key is missing or the project is invalid", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const created: SessionV2.Info[] = []
          const directory = AbsolutePath.make(tmp.path)
          const result = yield* Effect.gen(function* () {
            const tasks = yield* ScheduledTaskStore.Service
            const missingKey = yield* tasks.create(
              taskInput(directory, DateTime.toUtc(yield* DateTime.now), {
                id: RelayCatalog.modelID(Relay.VendorID.chatgpt, "gpt-relay"),
                providerID: ProviderV2.ID.leidiandonghua,
              }),
            )
            const invalid = yield* tasks.create({
              ...taskInput(directory, DateTime.toUtc(yield* DateTime.now), {
                id: ModelV2.ID.make("gpt-4.1"),
                providerID: ProviderV2.ID.openai,
              }),
              name: "invalid-project",
              projectID: ProjectV2.ID.make("other-project"),
            })
            return {
              key: (yield* tasks.runNow(missingKey.id)).error?.code,
              project: (yield* tasks.runNow(invalid.id)).error?.code,
            }
          }).pipe(
            Effect.provide(
              open(
                tmp.path,
                created,
                catalogLayer([managed(Relay.VendorID.chatgpt, "gpt-relay", true)]),
                authLayer({}, []),
              ),
            ),
          )
          expect(result.key).toBe("KEY_MISSING")
          expect(result.project).toBe("PROJECT_INVALID")
          expect(created).toHaveLength(0)
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("M07 leaves an ordinary unavailable model to the runner path", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const created: SessionV2.Info[] = []
          const directory = AbsolutePath.make(tmp.path)
          const result = yield* Effect.gen(function* () {
            const tasks = yield* ScheduledTaskStore.Service
            const task = yield* tasks.create(
              taskInput(directory, DateTime.toUtc(yield* DateTime.now), {
                id: ModelV2.ID.make("missing-openai"),
                providerID: ProviderV2.ID.openai,
              }),
            )
            const finished = yield* tasks.runNow(task.id)
            return { status: finished.status, code: finished.error?.code, enabled: (yield* tasks.list())[0]?.enabled }
          }).pipe(
            Effect.provide(
              open(
                tmp.path,
                created,
                catalogLayer([managed(Relay.VendorID.chatgpt, "missing-openai", false)]),
                authLayer({}, []),
              ),
            ),
          )
          expect(result.status).toBe("completed")
          expect(result.code).toBeUndefined()
          expect(result.enabled).toBe(true)
          expect(created[0]?.model?.providerID).toBe(ProviderV2.ID.openai)
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("M08 resolves the model from the task location", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const directory = AbsolutePath.make(path.join(tmp.path, "task-location"))
          const other = AbsolutePath.make(path.join(tmp.path, "open-location"))
          const catalogs = {
            [directory]: "https://task.example/v1",
            [other]: "https://open.example/v1",
          }
          const session = SessionV2.Info.make({
            id: SessionV2.ID.make("ses_task_location"),
            projectID: ProjectV2.ID.make(directory),
            title: "task",
            model: { id: ModelV2.ID.make("task-model"), providerID: ProviderV2.ID.openai },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
            location: { directory },
          })
          const selected = catalogs[session.location.directory]
          if (!selected) return yield* Effect.die("task location catalog missing")
          const catalog = ModelV2.Info.make({
            id: session.model?.id ?? ModelV2.ID.make("task-model"),
            providerID: ProviderV2.ID.openai,
            name: "Task location model",
            api: { id: ModelV2.ID.make("task-model"), type: "aisdk", package: "@ai-sdk/openai", url: selected },
            capabilities: { tools: true, input: ["text"], output: ["text"] },
            request: { headers: {}, body: {} },
            variants: [],
            time: { released: 0 },
            cost: [],
            status: "active",
            enabled: true,
            limit: { context: 100, output: 20 },
          })
          const resolved = yield* SessionRunnerModel.resolve(session, catalog)
          const request = LLM.request({ model: resolved, prompt: "Hello from the task location" })
          const prepared = yield* LLMClient.prepare(request)
          const headers = yield* resolved.route.auth.apply({
            request,
            method: "POST",
            url: `${selected}/chat/completions`,
            body: "{}",
            headers: Headers.empty,
          })
          expect(String(resolved.provider)).toBe(ProviderV2.ID.openai)
          expect(resolved.route.endpoint.baseURL).toBe("https://task.example/v1")
          expect(JSON.stringify(prepared).includes("https://task.example/v1")).toBe(true)
          expect(JSON.stringify(prepared).includes("relay.example")).toBe(false)
          expect(JSON.stringify(prepared).includes("relay-secret")).toBe(false)
          expect(headers.authorization).not.toBe("Bearer relay-secret")
          expect(catalogs[other]).toBe("https://open.example/v1")
        }),
      () => Effect.void,
    ),
  )
})
