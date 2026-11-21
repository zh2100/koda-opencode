import { expect } from "bun:test"
import path from "path"
import { Deferred, Effect, Exit, Fiber, Layer, Stream } from "effect"
import { LLMClient, LLMEvent, Model, type LLMClientShape, type LLMRequest } from "@opencode-ai/llm"
import { route } from "@opencode-ai/llm/protocols/openai-chat"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { Database } from "@opencode-ai/core/database/database"
import { Global } from "@opencode-ai/core/global"
import { Config } from "@opencode-ai/core/config"
import { Location } from "@opencode-ai/core/location"
import { AgentV2 } from "@opencode-ai/core/agent"
import { EventV2 } from "@opencode-ai/core/event"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionRunner } from "@opencode-ai/core/session/runner"
import { node } from "@opencode-ai/core/session/runner/llm"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { WriteTool } from "@opencode-ai/core/tool/write"
import { SkillGuidance } from "@opencode-ai/core/skill/guidance"
import { ReferenceGuidance } from "@opencode-ai/core/reference/guidance"
import { SystemContext } from "@opencode-ai/core/system-context"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)
for (const scenario of ["ask-approve", "ask-reject", "ask-cancel", "auto", "auto-deny", "plan", "ordinary"] as const) {
  it.live(
    `scheduled authorization through real runner and write tool: ${scenario}`,
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) =>
          Effect.gen(function* () {
            const directory = AbsolutePath.make(tmp.path)
            const requests: LLMRequest[] = []
            const model = Model.make({ id: "controlled", provider: "controlled", route })
            const client = Layer.succeed(
              LLMClient.Service,
              LLMClient.Service.of({
                prepare: () => Effect.die("unused"),
                generate: () => Effect.die("unused"),
                stream: ((request: LLMRequest) => {
                  requests.push(request)
                  return Stream.fromIterable(
                    requests.length === 1
                      ? [
                          LLMEvent.stepStart({ index: 0 }),
                          LLMEvent.toolCall({
                            id: "call-write",
                            name: "write",
                            input: { path: "marker.txt", content: "authorized" },
                          }),
                          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
                          LLMEvent.finish({ reason: "tool-calls" }),
                        ]
                      : [
                          LLMEvent.stepStart({ index: 0 }),
                          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
                          LLMEvent.finish({ reason: "stop" }),
                        ],
                  )
                }) as LLMClientShape["stream"],
              }),
            )
            const layer = AppNodeBuilder.build(
              LayerNode.group([
                node,
                WriteTool.node,
                ToolRegistry.toolsNode,
                SessionProjector.node,
                Database.node,
                EventV2.node,
                AgentV2.node,
                PermissionV2.node,
                SessionStore.node,
              ]),
              [
                [Database.node, Database.layerFromPath(path.join(tmp.path, "test.db"))],
                [Global.node, Global.layerWith({ data: tmp.path })],
                [Location.node, Layer.succeed(Location.Service, location({ directory }))],
                [LayerNodePlatform.llmClient, client],
                [SessionRunnerModel.node, SessionRunnerModel.layerWith(() => Effect.succeed(model))],
                [Config.node, Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]) }))],
                [Snapshot.node, Snapshot.noopLayer],
                [
                  SkillGuidance.node,
                  Layer.succeed(SkillGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) }),
                ],
                [
                  ReferenceGuidance.node,
                  Layer.succeed(ReferenceGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) }),
                ],
              ],
            )
            yield* Effect.gen(function* () {
              const database = yield* Database.Service
              const agents = yield* AgentV2.Service
              const permissions = yield* PermissionV2.Service
              const events = yield* EventV2.Service
              const runner = yield* SessionRunner.Service
              const store = yield* SessionStore.Service
              const id = SessionV2.ID.make("ses_authorization")
              const mode = scenario.startsWith("ask")
                ? "ask"
                : scenario.startsWith("auto")
                  ? "auto"
                  : scenario === "plan"
                    ? "plan"
                    : undefined
              yield* database.db
                .insert(ProjectTable)
                .values({ id: ProjectV2.ID.global, worktree: directory, sandboxes: [] })
                .run()
                .pipe(Effect.orDie)
              yield* database.db
                .insert(SessionTable)
                .values({
                  id,
                  project_id: ProjectV2.ID.global,
                  slug: "test",
                  directory,
                  title: "test",
                  version: "test",
                  agent: "custom",
                  metadata: mode ? { scheduledApprovalMode: mode } : undefined,
                })
                .run()
                .pipe(Effect.orDie)
              yield* agents.transform((draft) =>
                draft.update(AgentV2.ID.make("custom"), (agent) => {
                  agent.permissions = [{ action: "*", resource: "*", effect: scenario === "plan" ? "allow" : "ask" }]
                  if (scenario === "auto-deny")
                    agent.permissions.push({ action: "edit", resource: "*", effect: "deny" })
                }),
              )
              expect((yield* store.get(id))?.approvalMode).toBe(mode)
              const asked = yield* Deferred.make<PermissionV2.Request>()
              const unsubscribe = yield* events.listen((event) =>
                event.type === PermissionV2.Event.Asked.type
                  ? Deferred.succeed(asked, event.data as PermissionV2.Request).pipe(Effect.asVoid)
                  : Effect.void,
              )
              yield* Effect.addFinalizer(() => unsubscribe)
              const running = yield* runner.run({ sessionID: id, force: true }).pipe(Effect.exit, Effect.forkScoped)
              if (scenario.startsWith("ask") || scenario === "ordinary") {
                const request = yield* Deferred.await(asked)
                expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "marker.txt")).exists())).toBe(false)
                if (scenario === "ask-cancel") yield* Fiber.interrupt(running)
                if (scenario !== "ask-cancel")
                  yield* permissions.reply({
                    requestID: request.id,
                    reply: scenario === "ask-reject" ? "reject" : "once",
                  })
              }
              if (scenario !== "ask-cancel") {
                const result = yield* Fiber.join(running)
                if (scenario !== "ask-reject") expect(Exit.isSuccess(result)).toBe(true)
              }
              const written = scenario === "auto" || scenario === "ask-approve" || scenario === "ordinary"
              expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "marker.txt")).exists())).toBe(written)
              if (scenario === "plan") {
                expect(requests[0]?.tools.some((tool) => tool.name === "write")).toBe(false)
                // Catalog filtering alone is insufficient: invoke the actual write leaf
                // through an intentionally permissive catalog and retain session denial.
                const registry = yield* ToolRegistry.Service
                const tools = yield* registry.materialize()
                const result = yield* tools.settle({
                  sessionID: id,
                  agent: AgentV2.ID.make("custom"),
                  assistantMessageID: SessionMessage.ID.make("msg_direct"),
                  call: {
                    type: "tool-call",
                    id: "call-direct",
                    name: "write",
                    input: { path: "direct.txt", content: "must not write" },
                  },
                })
                expect(result.result.type).toBe("error")
                expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "direct.txt")).exists())).toBe(false)
              }
              if (scenario === "auto") {
                // Auto is attached to this durable session, never to the project/agent.
                const ordinary = SessionV2.ID.make("ses_ordinary")
                yield* database.db
                  .insert(SessionTable)
                  .values({
                    id: ordinary,
                    project_id: ProjectV2.ID.global,
                    slug: "ordinary",
                    directory,
                    title: "ordinary",
                    version: "test",
                    agent: "custom",
                  })
                  .run()
                  .pipe(Effect.orDie)
                expect(
                  (yield* permissions.ask({ sessionID: ordinary, action: "edit", resources: ["other.txt"] })).effect,
                ).toBe("ask")
                expect(
                  (yield* permissions.ask({ sessionID: id, action: "external_directory", resources: ["outside"] }))
                    .effect,
                ).toBe("ask")
              }
            }).pipe(Effect.provide(layer))
            if (scenario === "auto" || scenario === "plan") {
              // Rebuild services from the same database; policy must survive the
              // original runtime, rather than relying on an in-memory closure.
              yield* Effect.gen(function* () {
                const agents = yield* AgentV2.Service
                const sessions = yield* SessionStore.Service
                const permissions = yield* PermissionV2.Service
                yield* agents.transform((draft) =>
                  draft.update(AgentV2.ID.make("custom"), (agent) => {
                    agent.permissions = [{ action: "*", resource: "*", effect: "ask" }]
                  }),
                )
                const id = SessionV2.ID.make("ses_authorization")
                expect((yield* sessions.get(id))?.approvalMode).toBe(scenario)
                expect(
                  (yield* permissions.ask({ sessionID: id, action: "edit", resources: ["resume.txt"] })).effect,
                ).toBe(scenario === "auto" ? "allow" : "deny")
              }).pipe(Effect.provide(layer))
            }
          }),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
    20000,
  )
}
