import { expect, test } from "bun:test"
import { Effect, Schema, Stream } from "effect"
import { LLMEvent } from "@opencode-ai/llm"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionV2 } from "@opencode-ai/core/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { createLLMEventPublisher } from "@opencode-ai/core/session/runner/publish-llm-event"

const sessionID = SessionV2.ID.make("ses_tool_event_test")
const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="

const capture = () => {
  const published: Array<{ readonly type: string; readonly data: unknown }> = []
  const events = EventV2.Service.of({
    publish: (definition, data) =>
      Effect.sync(() => {
        const event = { id: EventV2.ID.create(), type: definition.type, data } as EventV2.Payload<typeof definition>
        published.push({
          type: definition.durable
            ? EventV2.versionedType(definition.type, definition.durable.version)
            : definition.type,
          data,
        })
        return event
      }),
    subscribe: () => Stream.empty,
    all: () => Stream.empty,
    durable: () => Stream.empty,
    listen: () => Effect.succeed(Effect.void),
    project: () => Effect.void,
    replay: () => Effect.void,
    replayAll: () => Effect.succeed(undefined),
    remove: () => Effect.void,
    claim: () => Effect.void,
  })
  return {
    published,
    publisher: createLLMEventPublisher(events, {
      sessionID,
      agent: "build",
      model: {
        id: ModelV2.ID.make("model"),
        providerID: ProviderV2.ID.make("provider"),
      },
    }),
  }
}

const call = LLMEvent.toolCall({ id: "call-image", name: "read", input: { path: "pixel.png" } })
const result = LLMEvent.toolResult({
  id: "call-image",
  name: "read",
  result: {
    type: "content",
    value: [
      { type: "text", text: "Image read successfully" },
      { type: "file", uri: `data:image/png;base64,${base64}`, mime: "image/png", name: "pixel.png" },
    ],
  },
  output: {
    structured: { type: "media", mime: "image/png" },
    content: [
      { type: "text", text: "Image read successfully" },
      { type: "file", uri: `data:image/png;base64,${base64}`, mime: "image/png", name: "pixel.png" },
    ],
  },
})

test("local tool success serializes media base64 once and reconstructs from structured content", async () => {
  const { published, publisher } = capture()
  await Effect.runPromise(publisher.publish(call))
  await Effect.runPromise(publisher.publish(result))

  const success = published.find((event) => event.type === "session.next.tool.success.1")
  expect(success).toBeDefined()
  const serialized = JSON.stringify(success)
  expect(serialized.split(base64)).toHaveLength(2)
  expect(success?.data).not.toHaveProperty("result")

  expect(success?.data).toMatchObject({
    content: [
      { type: "text", text: "Image read successfully" },
      { type: "file", uri: `data:image/png;base64,${base64}`, mime: "image/png" },
    ],
  })
})

test("provider-executed success retains its compatibility result", async () => {
  const { published, publisher } = capture()
  await Effect.runPromise(publisher.publish(LLMEvent.toolCall({ ...call, providerExecuted: true })))
  await Effect.runPromise(publisher.publish(LLMEvent.toolResult({ ...result, providerExecuted: true })))
  const success = published.find((event) => event.type === "session.next.tool.success.1")
  expect(success?.data).toHaveProperty("result")
})

test("provider-executed image generation becomes durable file content", async () => {
  const { published, publisher } = capture()
  await Effect.runPromise(
    publisher.publish(
      LLMEvent.toolCall({
        id: "call-generated-image",
        name: "image_generation",
        input: {},
        providerExecuted: true,
      }),
    ),
  )
  await Effect.runPromise(
    publisher.publish(
      LLMEvent.toolResult({
        id: "call-generated-image",
        name: "image_generation",
        providerExecuted: true,
        result: {
          type: "json",
          value: { result: `data:image/png;base64,${base64}` },
        },
      }),
    ),
  )
  const success = published.find((event) => event.type === "session.next.tool.success.1")
  expect(success?.data).toMatchObject({
    content: [{ type: "file", mime: "image/png", uri: `data:image/png;base64,${base64}` }],
  })
})

test("binary failure emits no success event", async () => {
  const { published, publisher } = capture()
  await Effect.runPromise(publisher.publish(call))
  await Effect.runPromise(
    publisher.publish(
      LLMEvent.toolResult({
        id: call.id,
        name: call.name,
        result: { type: "error", value: "Cannot read binary file" },
      }),
    ),
  )
  expect(published.some((event) => event.type === "session.next.tool.success.1")).toBe(false)
  expect(published.some((event) => event.type === "session.next.tool.failed.1")).toBe(true)
})

test("old success event data containing result still decodes", () => {
  const decoded = Schema.decodeUnknownSync(SessionEvent.Tool.Success.data)({
    sessionID,
    timestamp: Date.now(),
    assistantMessageID: SessionMessage.ID.create(),
    callID: "call-old",
    structured: { type: "media", mime: "image/png" },
    content: [{ type: "file", uri: `data:image/png;base64,${base64}`, mime: "image/png" }],
    result: { type: "content", value: [{ type: "file", uri: `data:image/png;base64,${base64}`, mime: "image/png" }] },
    provider: { executed: false },
  })
  expect(decoded.result).toMatchObject({ type: "content" })
})

test("step finish records settlement without publishing step ended", async () => {
  const { published, publisher } = capture()
  await Effect.runPromise(publisher.publish(LLMEvent.stepStart({ index: 0 })))
  await Effect.runPromise(publisher.publish(LLMEvent.stepFinish({ index: 0, reason: "stop" })))

  expect(published.some((event) => event.type === "session.next.step.ended.2")).toBe(false)
  expect(publisher.stepSettlement()).toMatchObject({ finish: "stop" })
})

for (const value of [
  "TEST-PRIVATE-result",
  { message: "TEST-PRIVATE-result", nested: { token: "TEST-PRIVATE-result" } },
]) {
  test(`T17 local error result is rebuilt safely (${typeof value})`, async () => {
    const { published, publisher } = capture()
    await Effect.runPromise(publisher.publish(call))
    await Effect.runPromise(
      publisher.publish(
        LLMEvent.toolResult({
          id: call.id,
          name: call.name,
          result: { type: "error", value },
          providerMetadata: { test: { token: "TEST-PRIVATE-metadata" } },
        }),
      ),
    )
    const failed = published.find((event) => event.type === "session.next.tool.failed.1")!
    expect(failed).toBeDefined()
    expect(JSON.stringify(failed)).not.toContain("TEST-PRIVATE")
    expect(failed.data).toMatchObject({ result: { type: "error", value: "Tool execution failed" } })
    Schema.decodeUnknownSync(SessionEvent.Tool.Failed.data)(
      Schema.encodeSync(SessionEvent.Tool.Failed.data)(failed.data as typeof SessionEvent.Tool.Failed.data.Type),
    )
  })
}

test("T15 provider and tool errors never publish diagnostic text", async () => {
  const { published, publisher } = capture()
  await Effect.runPromise(publisher.publish(call))
  await Effect.runPromise(
    publisher.publish(
      LLMEvent.toolError({
        id: call.id,
        name: call.name,
        message: "TEST-PRIVATE-tool",
        providerMetadata: { test: { token: "TEST-PRIVATE-metadata" } },
      }),
    ),
  )
  await Effect.runPromise(
    publisher.publish(
      LLMEvent.providerError({
        message: "TEST-PRIVATE-provider",
        providerMetadata: { test: { token: "TEST-PRIVATE-metadata" } },
      }),
    ),
  )
  expect(JSON.stringify(published)).not.toContain("TEST-PRIVATE")
  expect(published.some((event) => event.type === "session.next.step.failed.2")).toBe(true)
})
