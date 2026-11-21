import { expect } from "bun:test"
import path from "node:path"
import { DateTime, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { Prompt } from "@opencode-ai/schema/prompt"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Catalog } from "@opencode-ai/core/catalog"
import { Config } from "@opencode-ai/core/config"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { EventV2 } from "@opencode-ai/core/event"
import { Global } from "@opencode-ai/core/global"
import { Integration } from "@opencode-ai/core/integration"
import { Location } from "@opencode-ai/core/location"
import { ModelV2 } from "@opencode-ai/core/model"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { sessionPermissions } from "@opencode-ai/core/session-policy"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { RelayAuth } from "@opencode-ai/core/relay-auth"
import { RelayCatalog } from "@opencode-ai/core/relay-catalog"
import { RelayGate } from "@opencode-ai/core/relay-gate"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { SessionStore } from "@opencode-ai/core/session/store"
import { ScheduledTaskStore } from "@opencode-ai/core/scheduled-task"
import { ImageGenerationTool } from "@opencode-ai/core/tool/image-generation"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const png = "iVBORw0KGgo="
const providerID = ProviderV2.ID.make("local")
const modelID = ModelV2.ID.make("image")
const imageModel = ModelV2.Info.make({
  ...ModelV2.Info.empty(providerID, modelID),
  api: {
    type: "aisdk",
    package: "@ai-sdk/openai-compatible",
    id: ModelV2.ID.make("upstream-image"),
    url: "http://image.test/v1",
    settings: {},
  },
  request: { headers: {}, body: { apiKey: "test-image-key" } },
})

type Mode = "ask" | "auto" | "plan" | undefined
type Scenario = {
  name: string
  mode: Mode
  permissions: Array<{ action: string; resource: string; effect: "allow" | "ask" | "deny" }>
  reply?: "once" | "reject"
  requests: number
  exposed: boolean
  pending?: boolean
}

const scenarios: Scenario[] = [
  {
    name: "ask allow",
    mode: "ask",
    permissions: [{ action: "*", resource: "*", effect: "ask" }],
    reply: "once",
    requests: 1,
    exposed: true,
  },
  {
    name: "ask deny",
    mode: "ask",
    permissions: [{ action: "*", resource: "*", effect: "ask" }],
    reply: "reject",
    requests: 0,
    exposed: true,
  },
  {
    name: "ask pending",
    mode: "ask",
    permissions: [{ action: "*", resource: "*", effect: "ask" }],
    requests: 0,
    exposed: true,
    pending: true,
  },
  {
    name: "plan",
    mode: "plan",
    permissions: [{ action: "*", resource: "*", effect: "allow" }],
    requests: 0,
    exposed: false,
  },
  {
    name: "explicit deny",
    mode: undefined,
    permissions: [{ action: "image_generation", resource: "*", effect: "deny" }],
    requests: 0,
    exposed: false,
  },
  {
    name: "allow",
    mode: undefined,
    permissions: [{ action: "image_generation", resource: "*", effect: "allow" }],
    requests: 1,
    exposed: true,
  },
  {
    name: "auto plus ask",
    mode: "auto",
    permissions: [{ action: "image_generation", resource: "*", effect: "ask" }],
    requests: 1,
    exposed: true,
  },
  {
    name: "auto plus deny",
    mode: "auto",
    permissions: [
      { action: "*", resource: "*", effect: "ask" },
      { action: "image_generation", resource: "*", effect: "deny" },
    ],
    requests: 0,
    exposed: false,
  },
]

const it = testEffect(Layer.empty)

for (const scenario of scenarios) {
  it.live(`real permission authorizes image generation: ${scenario.name}`, () => run(scenario), 15000)
  it.live(`scheduled session image authorization: ${scenario.name}`, () => runScheduled(scenario), 20000)
}

function runScheduled(scenario: Scenario) {
  return run({ ...scenario, scheduled: true })
}

function run(scenario: Scenario & { scheduled?: boolean }) {
  return Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) =>
      Effect.gen(function* () {
        const directory = AbsolutePath.make(tmp.path)
        const requests: Array<{ url: string; body: unknown }> = []
        const http = Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.sync(() => {
              const body =
                request.body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(request.body.body)) : undefined
              requests.push({ url: request.url, body })
              return HttpClientResponse.fromWeb(request, Response.json({ data: [{ b64_json: png }] }))
            }),
          ),
        )
        const layer = AppNodeBuilder.build(
          LayerNode.group([
            Database.node,
            EventV2.node,
            AgentV2.node,
            PermissionV2.node,
            SessionStore.node,
            SessionProjector.node,
            SessionV2.node,
            ScheduledTaskStore.node,
            ToolRegistry.node,
            ToolRegistry.toolsNode,
            ImageGenerationTool.node,
          ]),
          [
            [Database.node, Database.layerFromPath(path.join(tmp.path, "test.db"))],
            [
              Global.node,
              Global.layerWith({
                data: tmp.path,
                config: path.join(tmp.path, "config"),
                state: path.join(tmp.path, "state"),
                cache: path.join(tmp.path, "cache"),
              }),
            ],
            [Location.node, Layer.succeed(Location.Service, location({ directory }))],
            [LayerNodePlatform.httpClient, http],
            [
              Config.node,
              Layer.succeed(
                Config.Service,
                Config.Service.of({
                  entries: () =>
                    Effect.succeed([
                      new Config.Document({
                        type: "document",
                        info: new Config.Info({
                          image_generation: { enabled: true, model: "local/image", api: "openai-images" },
                        }),
                      }),
                    ]),
                }),
              ),
            ],
            [
              Catalog.node,
              Layer.mock(Catalog.Service, {
                model: {
                  get: () => Effect.succeed(imageModel),
                  all: () => Effect.succeed([imageModel]),
                  available: () => Effect.succeed([imageModel]),
                  default: () => Effect.succeed(undefined),
                  small: () => Effect.succeed(undefined),
                },
                provider: {
                  get: () => Effect.succeed(undefined),
                  all: () => Effect.succeed([]),
                  available: () => Effect.succeed([]),
                },
              }),
            ],
            [
              Integration.node,
              Layer.mock(Integration.Service, {
                connection: {
                  active: () => Effect.succeed(undefined),
                  resolve: () => Effect.succeed(undefined),
                  key: () => Effect.die("unused"),
                  oauth: () => Effect.die("unused"),
                  update: () => Effect.die("unused"),
                  remove: () => Effect.die("unused"),
                },
                attempt: {
                  status: () => Effect.die("unused"),
                  complete: () => Effect.die("unused"),
                  cancel: () => Effect.die("unused"),
                },
              }),
            ],
            [
              ProjectV2.node,
              Layer.succeed(
                ProjectV2.Service,
                ProjectV2.Service.of({
                  directories: () => Effect.succeed([]),
                  resolve: () => Effect.succeed({ id: ProjectV2.ID.global, directory }),
                  commit: () => Effect.void,
                }),
              ),
            ],
            [SessionExecution.node, SessionExecution.noopLayer],
            [RelayAuth.node, Layer.mock(RelayAuth.Service, { resolve: () => Effect.die("unused") })],
            [
              RelayCatalog.node,
              Layer.mock(RelayCatalog.Service, {
                managed: () => Effect.succeed([]),
                hasManaged: () => false,
                visible: () => false,
                apply: () => {},
              }),
            ],
            [RelayGate.node, RelayGate.layerWith({ scheduledTasks: true })],
          ],
        )
        yield* Effect.gen(function* () {
          const store = yield* SessionStore.Service
          const sessions = yield* SessionV2.Service
          const tasks = yield* ScheduledTaskStore.Service
          const agents = yield* AgentV2.Service
          const events = yield* EventV2.Service
          const permissions = yield* PermissionV2.Service
          const registry = yield* ToolRegistry.Service
          yield* agents.transform((draft) =>
            draft.update(AgentV2.ID.make("custom"), (agent) => {
              agent.permissions = scenario.permissions
            }),
          )
          const created = scenario.scheduled
            ? yield* Effect.gen(function* () {
                const task = yield* tasks.create({
                  name: "image",
                  projectID: ProjectV2.ID.global,
                  location: { directory },
                  prompt: Prompt.make({ text: "generate" }),
                  schedule: "once",
                  timezone: "UTC",
                  runAt: DateTime.subtract(yield* DateTime.now, { minutes: 1 }),
                  model: { id: modelID, providerID },
                  approvalMode: scenario.mode ?? "ask",
                  enabled: true,
                })
                const run = yield* tasks.runNow(task.id)
                const runs = yield* tasks.runs(task.id)
                expect(runs.some((item) => item.id === run.id)).toBe(true)
                const sessionID = run.sessionId
                if (!sessionID) return yield* Effect.die("scheduled run did not record a session")
                return yield* sessions.get(sessionID)
              })
            : yield* sessions.create({
                id: SessionV2.ID.make("ses_image_auth"),
                location: { directory },
                agent: AgentV2.ID.make("custom"),
                model: { id: modelID, providerID },
                ...(scenario.mode ? { approvalMode: scenario.mode } : {}),
              })
          const stored = yield* store.get(created.id)
          expect(stored?.approvalMode).toBe(scenario.scheduled ? (scenario.mode ?? "ask") : scenario.mode)
          expect(stored?.agent).toBe(
            scenario.scheduled
              ? scenario.mode === "plan"
                ? AgentV2.ID.make("plan")
                : undefined
              : AgentV2.ID.make("custom"),
          )
          const agentID = stored?.agent ?? AgentV2.ID.make("custom")
          const agent = yield* agents.get(agentID)
          const rules = sessionPermissions(stored?.approvalMode, agent?.permissions ?? [])
          const materialized = yield* registry.materialize(rules)
          expect(materialized.definitions.some((tool) => tool.name === "image_generation")).toBe(scenario.exposed)
          const asked = yield* Deferred.make<PermissionV2.Request>()
          const unsubscribe = yield* events.listen((event) =>
            event.type === PermissionV2.Event.Asked.type
              ? Deferred.succeed(asked, event.data as PermissionV2.Request).pipe(Effect.asVoid)
              : Effect.void,
          )
          yield* Effect.addFinalizer(() => unsubscribe)
          const running = yield* materialized
            .settle({
              sessionID: created.id,
              agent: agentID,
              assistantMessageID: SessionMessage.ID.make("msg_image"),
              call: {
                type: "tool-call",
                id: "call-image",
                name: "image_generation",
                input: { prompt: "a local test image" },
              },
            })
            .pipe(Effect.exit, Effect.forkScoped)
          if (scenario.reply) {
            const request = yield* Deferred.await(asked).pipe(Effect.timeout("3 seconds"))
            expect(requests).toHaveLength(0)
            yield* permissions.reply({ requestID: request.id, reply: scenario.reply })
          }
          if (scenario.pending) {
            yield* Deferred.await(asked).pipe(Effect.timeout("3 seconds"))
            expect(requests).toHaveLength(0)
            yield* Fiber.interrupt(running)
            expect(requests).toHaveLength(0)
            return
          }
          const exit = yield* Fiber.join(running)
          expect(requests).toHaveLength(scenario.requests)
          if (scenario.requests === 1) {
            expect(Exit.isSuccess(exit)).toBe(true)
            expect(requests[0]?.url).toBe("http://image.test/v1/images/generations")
            expect(requests[0]?.body).toMatchObject({ model: "upstream-image" })
          }
          if (scenario.requests === 0) {
            const denied = Exit.isSuccess(exit) ? exit.value.result.type === "error" : Exit.isFailure(exit)
            expect(denied).toBe(true)
          }
        }).pipe(Effect.provide(layer), Effect.scoped)
      }),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )
}
