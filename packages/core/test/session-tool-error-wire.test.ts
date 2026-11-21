import { expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer, Option } from "effect"
import { eq } from "drizzle-orm"
import { LLM, LLMClient, LLMEvent, ToolErrorProjection } from "@opencode-ai/llm"
import { Auth, RequestExecutor } from "@opencode-ai/llm/route"
import { AnthropicMessages } from "@opencode-ai/llm/protocols/anthropic-messages"
import { OpenAIResponses } from "@opencode-ai/llm/protocols/openai-responses"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionStore } from "@opencode-ai/core/session/store"
import { createLLMEventPublisher } from "@opencode-ai/core/session/runner/publish-llm-event"
import { toLLMMessages } from "@opencode-ai/core/session/runner/to-llm-message"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { tmpdir } from "./fixture/tmpdir"
import path from "node:path"

const marker = "T20-PRIVATE-DIAGNOSTIC"
const sse = (...events: unknown[]) => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")
const runtime = LLMClient.layer.pipe(Layer.provide(RequestExecutor.fetchLayer))
const anthropic = [
  ...[
    "invalid_tool_input",
    "unavailable",
    "max_uses_exceeded",
    "too_many_requests",
    "query_too_long",
    "unknown_error",
  ].map((code) => ["web_search", code] as const),
  ...[
    "invalid_tool_input",
    "url_too_long",
    "url_not_allowed",
    "url_not_accessible",
    "unsupported_content_type",
    "too_many_requests",
    "max_uses_exceeded",
    "unavailable",
    "unknown_error",
  ].map((code) => ["web_fetch", code] as const),
  ...["invalid_tool_input", "unavailable", "too_many_requests", "execution_time_exceeded", "unknown_error"].map(
    (code) => ["code_execution", code] as const,
  ),
] as const

for (const [name, code] of anthropic) {
  test(`T20 parser/storage/read/wire Anthropic ${name}/${code}`, async () => {
    await exercise({ provider: "anthropic", name, code, ref: "valid", store: true })
  }, 15000)
}
for (const name of ["__proto__", "toString", "unrecognized_tool"]) {
  test(`T20 unknown hosted call ${name} is rejected without a successor request`, async () => {
    await exercise({ provider: "anthropic", name, code: "unavailable", ref: "valid", store: true })
  }, 15000)
}
test("T20 mismatched Anthropic error type is rejected", async () => {
  await exercise({ provider: "anthropic", name: "web_search", code: "unavailable", ref: "mismatch", store: true })
}, 15000)
for (const name of ["local-error", "local-string", "local-object", "local-nested"]) {
  test(`T17/T20 ${name} persists safely and continues with tool failure semantics`, async () => {
    await exercise({ provider: "anthropic", name, ref: "valid", store: true })
  }, 15000)
}
for (const store of [true, false]) {
  for (const ref of ["valid", "missing-result", "missing-both", "mismatch", "malicious"] as const) {
    test(`T20 parser/storage/read/wire OpenAI store=${store} ref=${ref}`, async () => {
      await exercise({ provider: "openai", name: "web_search", ref, store })
    }, 15000)
  }
}

type Scenario = {
  provider: "anthropic" | "openai"
  name: string
  code?: string
  ref: "valid" | "missing-result" | "missing-both" | "mismatch" | "malicious"
  store: boolean
}

async function exercise(scenario: Scenario) {
  await using tmp = await tmpdir()
  const sent: unknown[] = []
  const id = scenario.provider === "anthropic" ? "srvtoolu_safe" : "ws_safe"
  const local = scenario.name.startsWith("local-")
  const known = local || ["web_search", "web_fetch", "code_execution"].includes(scenario.name)
  const block = `${known ? scenario.name : "web_search"}_tool_result`
  const body = local
    ? sse(
        { type: "message_start", message: {} },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id, name: scenario.name, input: {} },
        },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "tool_use" } },
      )
    : scenario.provider === "anthropic"
      ? sse(
          { type: "message_start", message: { usage: { input_tokens: 1 } } },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "server_tool_use", id, name: scenario.name },
          },
          { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } },
          { type: "content_block_stop", index: 0 },
          {
            type: "content_block_start",
            index: 1,
            content_block: {
              type: block,
              tool_use_id: id,
              content: {
                type: scenario.ref === "mismatch" ? "web_fetch_tool_result_error" : `${block}_error`,
                error_code: scenario.code,
                message: marker,
                cause: { token: marker },
              },
            },
          },
          { type: "content_block_stop", index: 1 },
          { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
        )
      : sse(
          {
            type: "response.output_item.added",
            item: {
              type: "web_search_call",
              id,
              status: "failed",
              action: { type: "search", query: "safe" },
              error: { message: marker, cause: { token: marker } },
            },
          },
          {
            type: "response.output_item.done",
            item: {
              type: "web_search_call",
              id,
              status: "failed",
              action: { type: "search", query: "safe" },
              error: { message: marker, cause: { token: marker } },
            },
          },
          { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
        )
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      sent.push(JSON.parse(await request.text()))
      const next =
        scenario.provider === "anthropic"
          ? sse({ type: "message_start", message: {} }, { type: "message_delta", delta: { stop_reason: "end_turn" } })
          : sse({ type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } })
      return new Response(sent.length === 1 ? body : next, { headers: { "content-type": "text/event-stream" } })
    },
  })
  try {
    const model = (scenario.provider === "anthropic" ? AnthropicMessages.route : OpenAIResponses.route)
      .with({ endpoint: { baseURL: server.url.href }, auth: Auth.bearer("fake-test-only") })
      .model({ id: "model" })
    const initial = await Effect.runPromiseExit(
      LLMClient.generate(LLM.request({ model, prompt: "safe" })).pipe(Effect.provide(runtime)),
    )
    if (Exit.isFailure(initial)) return await Effect.runPromise(Effect.failCause(initial.cause))
    const parsed = initial.value
    expect(parsed.events.some((event) => event.type === "tool-result" && event.result.type === "error")).toBe(!local)
    const layer = AppNodeBuilder.build(
      LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionStore.node]),
      [[Database.node, Database.layerFromPath(path.join(tmp.path, "opencode.db"))]],
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const events = yield* EventV2.Service
        const store = yield* SessionStore.Service
        const directory = AbsolutePath.make(tmp.path)
        const sessionID = SessionV2.ID.make("ses_t20")
        yield* db
          .insert(ProjectTable)
          .values({ id: ProjectV2.ID.global, worktree: directory, sandboxes: [] })
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(SessionTable)
          .values({
            id: sessionID,
            project_id: ProjectV2.ID.global,
            directory,
            slug: "t20",
            title: "t20",
            version: "test",
          })
          .run()
          .pipe(Effect.orDie)
        const live: unknown[] = []
        yield* events.listen((event) =>
          Effect.sync(() => {
            live.push(event.data)
          }),
        )
        const publisher = createLLMEventPublisher(events, {
          sessionID,
          agent: "build",
          model: { id: ModelV2.ID.make(model.id), providerID: ProviderV2.ID.make(model.provider) },
        })
        for (const original of parsed.events) {
          if (!known && original.type === "tool-result") {
            yield* publisher.publish(LLMEvent.toolError({ id: original.id, name: scenario.name, message: marker }))
            continue
          }
          const event =
            original.type === "tool-result"
              ? LLMEvent.toolResult({
                  ...original,
                  providerMetadata: {
                    ...(scenario.ref === "missing-both" || scenario.ref === "missing-result"
                      ? {}
                      : original.providerMetadata),
                    diagnostic: { token: marker },
                    ...(scenario.ref === "mismatch"
                      ? { openai: { itemId: "ws_other" } }
                      : scenario.ref === "malicious"
                        ? { openai: { itemId: `https://bad/${marker}` } }
                        : {}),
                  },
                })
              : original.type === "tool-call" && scenario.ref === "missing-both"
                ? LLMEvent.toolCall({ ...original, providerMetadata: undefined })
                : original
          yield* publisher.publish(event)
        }
        if (local) {
          yield* publisher.publish(
            scenario.name === "local-error"
              ? LLMEvent.toolError({
                  id,
                  name: scenario.name,
                  message: marker,
                  providerMetadata: { diagnostic: { token: marker } },
                })
              : LLMEvent.toolResult({
                  id,
                  name: scenario.name,
                  result: {
                    type: "error",
                    value:
                      scenario.name === "local-string"
                        ? marker
                        : scenario.name === "local-object"
                          ? { message: marker }
                          : { nested: { value: marker } },
                  },
                  providerMetadata: { diagnostic: { token: marker } },
                }),
          )
        }
        const stored = yield* db
          .select()
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, sessionID))
          .all()
          .pipe(Effect.orDie)
        const context = yield* store.context(sessionID)
        expect(JSON.stringify(live)).not.toContain(marker)
        expect(JSON.stringify(stored)).not.toContain(marker)
        expect(JSON.stringify(context)).not.toContain(marker)
        const messages = toLLMMessages(context, model)
        const rejected =
          !known ||
          (scenario.provider === "anthropic" && scenario.ref === "mismatch") ||
          scenario.code === "unknown_error" ||
          (scenario.provider === "openai" && ["missing-both", "mismatch", "malicious"].includes(scenario.ref))
        const exit = yield* LLMClient.generate(
          LLM.request({ model, messages, providerOptions: { openai: { store: scenario.store } } }),
        ).pipe(Effect.provide(runtime), Effect.exit)
        expect(exit._tag).toBe(rejected ? "Failure" : "Success")
        expect(sent.length).toBe(rejected ? 1 : 2)
        expect(JSON.stringify(sent)).not.toContain(marker)
        if (rejected) {
          expect(
            Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined,
          ).toMatchObject({ _tag: "LLM.Error", reason: { _tag: "InvalidRequest" } })
          expect(
            messages
              .flatMap((message) => message.content)
              .some((part) => part.type === "tool-result" && ToolErrorProjection.blocked(part.result)),
          ).toBe(true)
          return
        }
        if (local) {
          const wire = sent[1] as { messages: Array<{ content: Array<{ type: string; is_error?: boolean }> }> }
          expect(
            wire.messages
              .flatMap((message) => message.content)
              .some((part) => part.type === "tool_result" && part.is_error === true),
          ).toBe(true)
          expect(JSON.stringify(wire)).toContain("Tool execution failed")
          return
        }
        if (scenario.provider === "anthropic") {
          const wire = sent[1] as { messages: Array<{ content: unknown[] }> }
          expect(wire.messages.flatMap((message) => message.content)).toContainEqual({
            type: block,
            tool_use_id: id,
            content: { type: `${block}_error`, error_code: scenario.code },
          })
        } else {
          const wire = sent[1] as { input: Array<{ type: string; id?: string }> }
          expect(wire.input.some((item) => item.type === "function_call_output")).toBe(false)
          expect(wire.input.filter((item) => item.type === "item_reference")).toEqual(
            scenario.store ? [{ type: "item_reference", id }] : [],
          )
        }
      }).pipe(Effect.provide(layer)),
    )
  } finally {
    await server.stop(true)
  }
}
