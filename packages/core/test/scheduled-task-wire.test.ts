import { ReadToolFileSystem } from "@opencode-ai/core/tool/read-filesystem"
import { SkillV2 } from "@opencode-ai/core/skill"
import { SessionTodo } from "@opencode-ai/core/session/todo"
import { Reference } from "@opencode-ai/core/reference"
import { QuestionV2 } from "@opencode-ai/core/question"
import { Pty } from "@opencode-ai/core/pty"
import { ProjectCopy } from "@opencode-ai/core/project/copy"
import { Policy } from "@opencode-ai/core/policy"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { LocationMutation } from "@opencode-ai/core/location-mutation"
import { Image } from "@opencode-ai/core/image"
import { MaskedImageEdit } from "@opencode-ai/core/masked-image-edit"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { FileSystemSearch } from "@opencode-ai/core/filesystem/search"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { FileMutation } from "@opencode-ai/core/file-mutation"
import { CommandV2 } from "@opencode-ai/core/command"
import { AISDK } from "@opencode-ai/core/aisdk"
import { LLMClient, RequestExecutor } from "@opencode-ai/llm/route"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Config } from "@opencode-ai/core/config"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionRunner } from "@opencode-ai/core/session/runner"
import { node } from "@opencode-ai/core/session/runner/llm"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { SessionStore } from "@opencode-ai/core/session/store"
import { Location } from "@opencode-ai/core/location"
import { SystemContextRegistry } from "@opencode-ai/core/system-context/registry"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SkillGuidance } from "@opencode-ai/core/skill/guidance"
import { ReferenceGuidance } from "@opencode-ai/core/reference/guidance"
import { expect } from "bun:test"
import { Cause, DateTime, Effect, Exit, Layer, LayerMap, Logger, Stream } from "effect"
import path from "node:path"
import { testEffect } from "./lib/effect"

import fs from "node:fs/promises"
import { Tools } from "@opencode-ai/core/tool/tools"
import { SettledIO } from "@opencode-ai/core/util/settled-io"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionExecutionLocal } from "@opencode-ai/core/session/execution/local"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { LLMError, TransportReason } from "@opencode-ai/llm"
import { Global } from "@opencode-ai/core/global"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ScheduledTaskStore } from "@opencode-ai/core/scheduled-task"
import { RelayAuth } from "@opencode-ai/core/relay-auth"
import { RelaySecretStore } from "@opencode-ai/core/relay-secret-store"
import { RelayCatalog } from "@opencode-ai/core/relay-catalog"
import { RelayGate } from "@opencode-ai/core/relay-gate"
import { Catalog } from "@opencode-ai/core/catalog"
import { Integration } from "@opencode-ai/core/integration"
import { Relay } from "@opencode-ai/schema/relay"
import { tmpdir } from "./fixture/tmpdir"
import { location } from "./fixture/location"
import { adjust } from "effect/testing/TestClock"

const it = testEffect(Layer.empty)
const marker = "TASK-WIRE-PRIVATE-DIAGNOSTIC"
const scenarios = [
  "rate-limit",
  "resolver-store-failure",
  "ordinary-model-missing",
  "store-failure",
  "store-fallback",
  "store-missing",
  "defect",
  "mixed-cause",
  "cleanup-failure",
] as const
for (const scenario of scenarios) {
  it.effect(
    `T08/T09/T11/T12/T13 real scheduler session runner: ${scenario}`,
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) =>
          Effect.gen(function* () {
            const directory = AbsolutePath.make(tmp.path)
            const values = new Map<string, string>()
            const control = { failed: false, missing: false, requests: 0 }
            const server = yield* Effect.acquireRelease(
              Effect.sync(() =>
                Bun.serve({
                  hostname: "127.0.0.1",
                  port: 0,
                  async fetch(request) {
                    // Count only task turns. Automatic titling can use the same streaming endpoint.
                    const body=await request.text()
                    const title=body.includes('Generate a concise session title')
                    if (!title) control.requests++
                    if (!title && scenario === "rate-limit" && control.requests <= 3)
                      return Response.json(
                        { error: { message: marker, type: "rate_limit_error" } },
                        { status: 429, headers: { "retry-after-ms": "0" } },
                      )
                    return new Response(
                      'data: {"choices":[{"delta":{"content":"safe"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
                      { headers: { "content-type": "text/event-stream" } },
                    )
                  },
                }),
              ),
              (server) => Effect.promise(() => server.stop(true)),
            )
            const fault = scenario === "defect" || scenario === "mixed-cause" || scenario === "cleanup-failure"
            const ordinary = fault || scenario === "rate-limit" || scenario === "ordinary-model-missing"
            const vendor = Relay.VendorID.make("scheduled-wire")
            const id = ordinary
              ? ModelV2.ID.make("controlled")
              : RelayCatalog.modelID(vendor, ModelV2.ID.make("controlled"))
            const providerID = ordinary ? ProviderV2.ID.openai : ProviderV2.ID.leidiandonghua
            const model = ModelV2.Info.make({
              id,
              providerID,
              name: "Controlled",
              ...(ordinary ? {} : { family: ModelV2.Family.make(vendor) }),
              api: {
                type: "aisdk",
                package: "@ai-sdk/openai-compatible",
                id: ModelV2.ID.make("controlled"),
                url: server.url.href,
                settings: {},
              },
              capabilities: { tools: true, input: ["text"], output: ["text"] },
              request: { headers: {}, body: {} },
              variants: [],
              time: { released: 0 },
              cost: [],
              status: "active",
              enabled: true,
              limit: { context: 10000, output: 100 },
            })
            const catalog = Layer.mock(Catalog.Service, {
              model: {
                available: () =>
                  Effect.sync(() => {
                    if (scenario === "resolver-store-failure") control.failed = true
                    return scenario === "ordinary-model-missing" ? [] : [model]
                  }),
                default: () => Effect.succeed(model),
                get: () => Effect.succeed(model),
                all: () => Effect.succeed([model]),
                small: () => Effect.succeed(model),
              },
              provider: {
                get: () => Effect.succeed(undefined),
                all: () => Effect.succeed([]),
                available: () => Effect.succeed([]),
              },
            })
            const integrations = Layer.mock(Integration.Service, {
              attempt: {
                status: () => Effect.die("unused"),
                complete: () => Effect.die("unused"),
                cancel: () => Effect.die("unused"),
              },
              connection: {
                active: () => Effect.succeed(undefined),
                resolve: () => Effect.die("unused"),
                key: () => Effect.die("unused"),
                oauth: () => Effect.die("unused"),
                update: () => Effect.die("unused"),
                remove: () => Effect.die("unused"),
              },
            })
            const relayCatalog = Layer.mock(RelayCatalog.Service, {
              managed: () =>
                Effect.succeed(
                  ordinary
                    ? []
                    : [
                        {
                          vendorId: vendor,
                          modelId: ModelV2.ID.make("controlled"),
                          visible: true,
                          reasoningCapabilities: [],
                          assignmentSource: "manual",
                          lastSeenAt: DateTime.makeUnsafe(0),
                          upstreamPresent: true,
                        },
                      ],
                ),
              visible: () => true,
              hasManaged: () => true,
              apply: () => {},
            })
            const secrets = RelaySecretStore.makeLayer({
              get: async ({ name }) => {
                if (control.failed) throw new Error(marker)
                return control.missing ? null : (values.get(name) ?? null)
              },
              set: async ({ name, value }) => {
                values.set(name, value)
              },
              delete: async ({ name }) => values.delete(name),
            }).pipe(
              Layer.provide(AppNodeBuilder.build(FSUtil.node)),
              Layer.provide(Global.layerWith({ data: tmp.path })),
            )
            const authLayer = AppNodeBuilder.build(RelayAuth.node, [
              [Global.node, Global.layerWith({ data: tmp.path })],
              [RelaySecretStore.node, secrets],
            ])
            const client = fault
              ? Layer.succeed(
                  LLMClient.Service,
                  LLMClient.Service.of({
                    prepare: () => Effect.die("unused"),
                    generate: () => Effect.die("unused"),
                    stream: () =>
                      Stream.fromEffect(
                        scenario === "defect"
                          ? Effect.die(new Error(marker))
                          : (scenario === "mixed-cause"
                              ? Effect.interrupt
                              : Effect.fail(
                                  new LLMError({
                                    module: "controlled",
                                    method: "stream",
                                    reason: new TransportReason({ message: marker }),
                                  }),
                                )
                            ).pipe(SettledIO.ensuring(Effect.die(new Error(marker)))),
                      ),
                  }),
                )
              : LLMClient.layer.pipe(Layer.provide(RequestExecutor.fetchLayer))
            const systemContext = AppNodeBuilder.build(SystemContextRegistry.node)
            const models = SessionRunnerModel.locationLayer.pipe(
              Layer.provide(catalog),
              Layer.provide(integrations),
              Layer.provide(relayCatalog),
              Layer.provide(authLayer),
            )
            const replacements = [
              [Database.node, Database.layerFromPath(path.join(tmp.path, "task.db"))],
              [Global.node, Global.layerWith({ data: tmp.path })],
              [Snapshot.node, Snapshot.noopLayer],
              [LayerNodePlatform.llmClient, client],
              [SessionRunnerModel.node, models],
              [RelayCatalog.node, relayCatalog],
              [RelaySecretStore.node, secrets],
              [RelayAuth.node, authLayer],
              [RelayGate.node, Layer.succeed(RelayGate.Service, { ...RelayGate.closed, scheduledTasks: true })],
              [
                Project.node,
                Layer.mock(Project.Service, { resolve: () => Effect.succeed({ id: Project.ID.global, directory }) }),
              ],
              [SystemContextRegistry.node, systemContext],
              [Location.node, Layer.succeed(Location.Service, location({ directory }))],
              [
                SkillGuidance.node,
                Layer.mock(SkillGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) }),
              ],
              [
                ReferenceGuidance.node,
                Layer.mock(ReferenceGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) }),
              ],
              [Config.node, Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]) }))],
              [PermissionV2.node, Layer.mock(PermissionV2.Service, {})],
              [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
            ] satisfies LayerNode.Replacements
            const runner = AppNodeBuilder.build(node, replacements)
            // Unused Location services fail on access; the runner, storage, ownership and coordinator remain real.
            const locations = Layer.effect(
              LocationServiceMap.Service,
              LayerMap.make((ref: Location.Ref) =>
                Layer.mergeAll(
                  runner,
                  Layer.mock(Tools.Service, {}),
                  Layer.mock(AgentV2.Service, {}),
                  Layer.mock(AISDK.Service, {
                    hook: { sdk: () => Effect.die("unused"), language: () => Effect.die("unused") },
                  }),
                  catalog,
                  Layer.mock(CommandV2.Service, {}),
                  Layer.mock(Config.Service, {}),
                  Layer.mock(FileMutation.Service, {}),
                  Layer.mock(FileSystem.Service, {}),
                  Layer.mock(FileSystemSearch.Service, {}),
                  Layer.mock(Watcher.Service, {}),
                  Layer.mock(Image.Service, {}),
                  Layer.mock(MaskedImageEdit.Service, {}),
                  integrations,
                  Layer.succeed(Location.Service, location({ directory })),
                  Layer.mock(LocationMutation.Service, {}),
                  Layer.mock(PermissionV2.Service, {}),
                  Layer.mock(PluginV2.Service, {}),
                  Layer.mock(Policy.Service, { hasStatements: () => false }),
                  Layer.mock(ProjectCopy.Service, {}),
                  Layer.mock(Pty.Service, {}),
                  Layer.mock(QuestionV2.Service, {}),
                  Layer.mock(Reference.Service, {}),
                  Layer.mock(ReferenceGuidance.Service, {}),
                  Layer.mock(SessionRunnerModel.Service, {}),
                  Layer.mock(SessionTodo.Service, {}),
                  Layer.mock(SkillV2.Service, {}),
                  Layer.mock(SkillGuidance.Service, {}),
                  Layer.mock(Snapshot.Service, {}),
                  Layer.mock(SystemContextRegistry.Service, {}),
                  Layer.mock(ReadToolFileSystem.Service, {}),
                  Layer.mock(ToolRegistry.Service, {}),
                  Layer.mock(ToolOutputStore.Service, {}),
                ),
              ),
            )
            const execution = AppNodeBuilder.build(SessionExecutionLocal.node, [
              ...replacements,
              [LocationServiceMap.node, locations],
            ])
            const layer = AppNodeBuilder.build(
              LayerNode.group([
                ScheduledTaskStore.node,
                SessionV2.node,
                SessionStore.node,
                EventV2.node,
                Database.node,
                RelayAuth.node,
                SessionProjector.node,
              ]),
              [...replacements, [SessionExecution.node, execution]],
            )
            const logs: string[] = []
            const logger = Logger.layer([
              Logger.make((options) => {
                logs.push(JSON.stringify({ message: options.message, cause: options.cause }))
              }),
            ])
            yield* Effect.gen(function* () {
              const { db } = yield* Database.Service
              const tasks = yield* ScheduledTaskStore.Service
              const auth = yield* RelayAuth.Service
              const sessions = yield* SessionV2.Service
              const events = yield* EventV2.Service
              const observed: unknown[] = []
              yield* events.listen((event) =>
                Effect.sync(() => {
                  observed.push(event.data)
                }),
              )
              yield* db
                .insert(ProjectTable)
                .values({ id: Project.ID.global, worktree: directory, sandboxes: [] })
                .run()
                .pipe(Effect.orDie)
              if (!ordinary) {
                yield* auth.setVendor({
                  id: vendor,
                  name: "Controlled",
                  baseURL: server.url.href,
                  key: "fake-only",
                  revision: 0,
                })
                if (scenario === "store-fallback")
                  yield* Effect.promise(() =>
                    fs.writeFile(path.join(tmp.path, "relay-secrets.json"), JSON.stringify(Object.fromEntries(values))),
                  )
                if (scenario === "store-failure" || scenario === "store-fallback") control.failed = true
                if (scenario === "store-missing") control.missing = true
              }
              const task = yield* tasks.create({
                name: scenario,
                projectID: Project.ID.global,
                location: { directory },
                prompt: Prompt.make({ text: "safe" }),
                schedule: "daily",
                timezone: "UTC",
                runAt: DateTime.add(yield* DateTime.now, { hours: 1 }),
                model: { id, providerID },
                approvalMode: "ask",
                enabled: true,
              })
              if (fault) {
                const exit = yield* tasks.runNow(task.id).pipe(Effect.exit)
                expect(Exit.isFailure(exit)).toBe(true)
                if (Exit.isSuccess(exit)) throw new Error("expected original failure cause")
                expect(Cause.hasDies(exit.cause)).toBe(true)
                expect(Cause.hasInterrupts(exit.cause)).toBe(scenario === "mixed-cause")
                if (scenario === "cleanup-failure") expect(Cause.hasFails(exit.cause)).toBe(true)
                expect(Cause.pretty(exit.cause)).toContain(marker)
                const run = (yield* tasks.runs(task.id))[0]!
                expect(run.status).toBe("interrupted")
                expect((yield* tasks.list())[0]?.enabled).toBe(true)
                expect(JSON.stringify(run)).not.toContain(marker)
                expect(JSON.stringify(observed)).not.toContain(marker)
                expect(JSON.stringify(yield* db.select().from(EventTable).all().pipe(Effect.orDie))).not.toContain(
                  marker,
                )
                expect(JSON.stringify(yield* sessions.context(run.sessionId!))).not.toContain(marker)
                return
              }
              const run = yield* tasks.runNow(task.id)
              const expected =
                scenario === "rate-limit"
                  ? "UPSTREAM_RATE_LIMITED"
                  : scenario === "store-failure"
                    ? "SECRET_STORE_UNAVAILABLE"
                    : scenario === "store-missing"
                      ? "KEY_MISSING"
                      : "MODEL_UNAVAILABLE"
              expect(run.status).toBe(scenario === "store-fallback" ? "completed" : "failed")
              if (scenario !== "store-fallback") expect(run.error?.code).toBe(expected)
              expect((yield* tasks.list())[0]?.enabled).toBe(scenario !== "store-missing")
              expect(JSON.stringify(observed)).not.toContain(marker)
              const saved = yield* db.select().from(EventTable).all().pipe(Effect.orDie)
              expect(JSON.stringify(saved)).not.toContain(marker)
              expect(JSON.stringify(yield* tasks.runs(task.id))).not.toContain(marker)
              if (run.sessionId) expect(JSON.stringify(yield* sessions.context(run.sessionId))).not.toContain(marker)
              expect(control.requests).toBe(scenario === "rate-limit" ? 3 : scenario === "store-fallback" ? 1 : 0)
              if (scenario === "rate-limit") {
                yield* adjust("1 second")
                expect((yield* tasks.runNow(task.id)).status).toBe("completed")
                expect((yield* tasks.list())[0]?.nextRun).toEqual(task.nextRun)
                expect(control.requests).toBe(4)
              }
            }).pipe(Effect.provide(layer), Effect.provide(logger), Effect.scoped)
            expect(logs.join("\n")).not.toContain(marker)
            if (
              fault ||
              scenario === "rate-limit" ||
              scenario === "resolver-store-failure" ||
              scenario === "ordinary-model-missing"
            )
              expect(logs.join("\n")).toContain("Failed to drain Session")
          }),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
    20000,
  )
}
