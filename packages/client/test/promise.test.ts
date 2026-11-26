import { expect, test } from "bun:test"
import { isSessionNotFoundError, isUnauthorizedError, OpenCode } from "../src"

test("sessions.pending reads the durable inbox view without submitting a prompt", async () => {
  const calls: { method: string; pathname: string }[] = []
  const snapshot = { sessionID: "ses_pending_client", sequence: 12, inputs: [] }
  const client = OpenCode.make({
    baseUrl: "http://localhost",
    fetch: async (input, init) => {
      calls.push({
        method: init?.method ?? (input instanceof Request ? input.method : "GET"),
        pathname: new URL(input instanceof Request ? input.url : String(input)).pathname,
      })
      return Response.json({ data: snapshot })
    },
  })
  expect(await client.sessions.pending({ sessionID: snapshot.sessionID })).toEqual(snapshot)
  expect(calls).toEqual([{ method: "GET", pathname: "/api/session/ses_pending_client/input" }])
})

test("SSE large image events use per-subscription byte limits and retain following events", async () => {
  const image = {
    type: "session.next.tool.success",
    data: { content: [{ type: "file", mime: "image/png", uri: "data:image/png;base64," + "A".repeat(3_932_872) }] },
  }
  const wire = new TextEncoder().encode(
    `data: ${JSON.stringify(image)}\r\n\r\ndata: ${JSON.stringify(modelSwitchedEvent)}\n\n`,
  )
  for (const chunkSize of [wire.length, 4093]) {
    const client = OpenCode.make({
      baseUrl: "http://localhost",
      fetch: async () => {
        let offset = 0
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (offset === wire.length) return controller.close()
              controller.enqueue(wire.slice(offset, offset + chunkSize))
              offset = Math.min(wire.length, offset + chunkSize)
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    let ready = false
    const events = []
    for await (const event of client.events.subscribe({
      maxEventBytes: 8 * 1024 * 1024,
      onReady: () => {
        ready = true
      },
    })) {
      expect(ready).toBe(true)
      events.push(event)
    }
    expect(events).toEqual([image, modelSwitchedEvent])
    await expect(client.events.subscribe()[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      reason: "MalformedResponse",
      cause: { reason: "SseEventTooLarge", limit: 1_048_576 },
    })
  }
})

test("SSE counts UTF-8 bytes per event, handles split line endings, EOF and cancellation", async () => {
  const line = `data: ${JSON.stringify({ text: "江南" })}\r\n`
  const bytes = new TextEncoder().encode(line)
  for (const ending of ["\r\n", ""]) {
    let cancelled = false
    const client = OpenCode.make({
      baseUrl: "http://localhost",
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (const byte of new TextEncoder().encode(line + ending)) controller.enqueue(new Uint8Array([byte]))
              if (!ending) controller.close()
            },
            cancel() {
              cancelled = true
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    })
    for await (const event of client.events.subscribe({ maxEventBytes: bytes.length })) {
      expect(event).toEqual({ text: "江南" })
      break
    }
    if (ending) expect(cancelled).toBe(true)
    await expect(
      client.events
        .subscribe({ maxEventBytes: bytes.length - 1 })
        [Symbol.asyncIterator]()
        .next(),
    ).rejects.toMatchObject({ reason: "MalformedResponse" })
  }
})

test("SSE accepts many valid events in a single chunk larger than the limit", async () => {
  const wire = Array.from({ length: 100 }, () => 'data: {"ok":true}\n\n').join("")
  const client = OpenCode.make({
    baseUrl: "http://localhost",
    fetch: async () => new Response(wire, { headers: { "content-type": "text/event-stream" } }),
  })
  const events = []
  for await (const event of client.events.subscribe({ maxEventBytes: 32 })) events.push(event)
  expect(events).toHaveLength(100)
})

test("SSE ready waits for response validation, not iterator construction or a business event", async () => {
  for (const response of [
    new Response("unauthorized", { status: 401 }),
    new Response("not SSE"),
    new Response(null, { headers: { "content-type": "text/event-stream" } }),
  ]) {
    let ready = false
    const client = OpenCode.make({ baseUrl: "http://localhost", fetch: async () => response })
    const iterator = client.events
      .subscribe({
        onReady: () => {
          ready = true
        },
      })
      [Symbol.asyncIterator]()
    expect(ready).toBe(false)
    await expect(iterator.next()).rejects.toBeDefined()
    expect(ready).toBe(false)
  }
  const connected = Promise.withResolvers<void>()
  const stream = new TransformStream<Uint8Array, Uint8Array>()
  const client = OpenCode.make({
    baseUrl: "http://localhost",
    fetch: async () => new Response(stream.readable, { headers: { "content-type": "text/event-stream" } }),
  })
  const iterator = client.events.subscribe({ onReady: () => connected.resolve() })[Symbol.asyncIterator]()
  const pending = iterator.next()
  await connected.promise
  await stream.writable.getWriter().close()
  expect((await pending).done).toBe(true)
})

test("SSE rejects oversized unterminated events and releases the reader", async () => {
  let cancelled = false
  const client = OpenCode.make({
    baseUrl: "http://localhost",
    fetch: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: " + "x".repeat(100)))
          },
          cancel() {
            cancelled = true
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  })
  await expect(client.events.subscribe({ maxEventBytes: 32 })[Symbol.asyncIterator]().next()).rejects.toMatchObject({
    cause: { reason: "SseEventTooLarge", limit: 32 },
  })
  expect(cancelled).toBe(true)
})

test("SSE preserves comments, multiline data and CR-only framing", async () => {
  const client = OpenCode.make({ baseUrl: "http://localhost", fetch: async () => new Response(': keepalive\rdata: {\rdata: "ok":true}\r\r', { headers: { "content-type": "text/event-stream" } }) })
  const events = []
  for await (const event of client.events.subscribe()) events.push(event)
  expect(events).toEqual([{ ok: true }])
})

test("exposes every standard HTTP API group", () => {
  const client = OpenCode.make({ baseUrl: "http://localhost:3000" })

  expect(Object.keys(client)).toEqual([
    "health",
    "location",
    "agents",
    "sessions",
    "messages",
    "models",
    "providers",
    "integrations",
    "credentials",
    "server.relay",
    "server.scheduledTask",
    "imageGeneration",
    "imageEdit",
    "permissions",
    "files",
    "commands",
    "skills",
    "events",
    "ptys",
    "questions",
    "references",
    "projectCopies",
  ])
  expect(Object.keys(client.messages)).toEqual(["list"])
  expect(Object.keys(client.integrations)).toEqual([
    "list",
    "get",
    "connectKey",
    "connectOauth",
    "attemptStatus",
    "attemptComplete",
    "attemptCancel",
  ])
  expect(Object.keys(client.files)).toEqual(["list", "find"])
  expect(Object.keys(client.ptys)).toEqual(["list", "create", "get", "update", "remove"])
})

test("sessions.get returns the wire projection", async () => {
  const client = OpenCode.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input) => {
      expect(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).toBe(
        "http://localhost:3000/api/session/ses_test",
      )
      return Response.json(session)
    },
  })

  const result = await client.sessions.get({ sessionID: "ses_test" })

  expect(result.time.created).toBe(1_717_171_717_000)
})

test("events.subscribe exposes the Promise event stream wire projection", async () => {
  const client = OpenCode.make({
    baseUrl: "http://localhost:3000",
    fetch: async () =>
      new Response(
        `: heartbeat\n\ndata: ${JSON.stringify({ id: "evt_connected", type: "server.connected", data: {} })}\n\n` +
          `data: ${JSON.stringify(modelSwitchedEvent)}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      ),
  })
  const events = []
  for await (const event of client.events.subscribe()) events.push(event)

  expect(events).toEqual([{ id: "evt_connected", type: "server.connected", data: {} }, modelSwitchedEvent])
  expect(events[1]?.type === "session.next.model.switched" && events[1].data.timestamp).toBe(1_717_171_717_000)
})

test("events.subscribe terminates on malformed Promise SSE data", async () => {
  const client = OpenCode.make({
    baseUrl: "http://localhost:3000",
    fetch: async () => new Response("data: {not-json}\n\n", { headers: { "content-type": "text/event-stream" } }),
  })

  expect(client.events.subscribe()[Symbol.asyncIterator]().next()).rejects.toMatchObject({
    name: "ClientError",
    reason: "MalformedResponse",
  })
})

test("session methods use the public HTTP contract", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  let historyPage = 0
  const client = OpenCode.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      requests.push({ url, init })
      if (url.includes("/event")) {
        return new Response(`data: ${JSON.stringify(modelSwitchedEvent)}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        })
      }
      if (url.includes("/history")) {
        historyPage++
        return Response.json(
          historyPage === 1 ? { data: [modelSwitchedEvent], hasMore: true } : { data: [], hasMore: false },
        )
      }
      if (url.includes("/prompt")) return Response.json(admission)
      if (url.includes("/context")) return Response.json({ data: [] })
      if (url.includes("/message/")) return Response.json({ data: modelSwitchedMessage })
      if (url.endsWith("/api/session/active")) return Response.json({ data: { ses_test: { type: "running" } } })
      if (init?.method === "POST" && url.endsWith("/api/session")) return Response.json(session)
      if (init?.method === "POST") return new Response(null, { status: 204 })
      return Response.json({ data: [session.data], cursor: { next: "next" } })
    },
  })

  const page = await client.sessions.list({ limit: 10, order: "desc" })
  const active = await client.sessions.active()
  const created = await client.sessions.create({ location: { directory: "/tmp/project" } })
  await client.sessions.switchAgent({ sessionID: "ses_test", agent: "build" })
  await client.sessions.switchModel({
    sessionID: "ses_test",
    model: { id: "claude", providerID: "anthropic" },
  })
  const admitted = await client.sessions.prompt({
    sessionID: "ses_test",
    prompt: { text: "Hello" },
    resume: false,
  })
  await client.sessions.compact({ sessionID: "ses_test" })
  await client.sessions.wait({ sessionID: "ses_test" })
  const context = await client.sessions.context({ sessionID: "ses_test" })
  const history = await client.sessions.history({ sessionID: "ses_test", after: 0, limit: 1 })
  const historyAfter = history.data.at(-1)?.durable?.seq
  const historyNext = history.hasMore
    ? await client.sessions.history({ sessionID: "ses_test", after: historyAfter, limit: 2 })
    : undefined
  const events = []
  for await (const event of client.sessions.events({ sessionID: "ses_test", after: 0 })) events.push(event)
  await client.sessions.interrupt({ sessionID: "ses_test" })
  const message = await client.sessions.message({ sessionID: "ses_test", messageID: "msg_model" })

  expect(page.cursor.next).toBe("next")
  expect(active).toEqual({ ses_test: { type: "running" } })
  expect(created.id).toBe("ses_test")
  expect(admitted.id).toBe("msg_test")
  expect(context).toEqual([])
  expect(history).toEqual({ data: [modelSwitchedEvent], hasMore: true })
  expect(historyNext).toEqual({ data: [], hasMore: false })
  expect(events).toEqual([modelSwitchedEvent])
  expect(message).toEqual(modelSwitchedMessage)
  expect(requests.map((request) => [request.init?.method, request.url])).toEqual([
    ["GET", "http://localhost:3000/api/session?limit=10&order=desc"],
    ["GET", "http://localhost:3000/api/session/active"],
    ["POST", "http://localhost:3000/api/session"],
    ["POST", "http://localhost:3000/api/session/ses_test/agent"],
    ["POST", "http://localhost:3000/api/session/ses_test/model"],
    ["POST", "http://localhost:3000/api/session/ses_test/prompt"],
    ["POST", "http://localhost:3000/api/session/ses_test/compact"],
    ["POST", "http://localhost:3000/api/session/ses_test/wait"],
    ["GET", "http://localhost:3000/api/session/ses_test/context"],
    ["GET", "http://localhost:3000/api/session/ses_test/history?limit=1&after=0"],
    ["GET", "http://localhost:3000/api/session/ses_test/history?limit=2&after=1"],
    ["GET", "http://localhost:3000/api/session/ses_test/event?after=0"],
    ["POST", "http://localhost:3000/api/session/ses_test/interrupt"],
    ["GET", "http://localhost:3000/api/session/ses_test/message/msg_model"],
  ])
  const body = requests.find((request) => request.url.endsWith("/api/session/ses_test/prompt"))?.init?.body
  if (typeof body !== "string") throw new Error("Expected JSON request body")
  expect(JSON.parse(body)).toEqual({
    prompt: { text: "Hello" },
    resume: false,
  })
})

test("middleware errors remain declared client errors", async () => {
  const client = OpenCode.make({
    baseUrl: "http://localhost:3000",
    fetch: async () =>
      Response.json({ _tag: "UnauthorizedError", message: "Authentication required" }, { status: 401 }),
  })

  try {
    await client.sessions.create({})
    throw new Error("Expected request to fail")
  } catch (error) {
    expect(isUnauthorizedError(error)).toBe(true)
  }
})

test("sessions.history decodes SessionNotFoundError", async () => {
  const client = OpenCode.make({
    baseUrl: "http://localhost:3000",
    fetch: async () =>
      Response.json(
        { _tag: "SessionNotFoundError", sessionID: "ses_missing", message: "Session not found" },
        { status: 404 },
      ),
  })

  try {
    await client.sessions.history({ sessionID: "ses_missing" })
    throw new Error("Expected request to fail")
  } catch (error) {
    expect(isSessionNotFoundError(error)).toBe(true)
  }
})

const session = {
  data: {
    id: "ses_test",
    projectID: "project",
    cost: 0,
    tokens: {
      input: 1,
      output: 2,
      reasoning: 3,
      cache: { read: 4, write: 5 },
    },
    time: {
      created: 1_717_171_717_000,
      updated: 1_717_171_717_000,
    },
    title: "Test",
    location: { directory: "/tmp/project" },
  },
}

const admission = {
  data: {
    admittedSeq: 0,
    id: "msg_test",
    sessionID: "ses_test",
    prompt: { text: "Hello" },
    delivery: "steer",
    timeCreated: 1_717_171_717_000,
  },
}

const modelSwitchedMessage = {
  id: "msg_model",
  type: "model-switched",
  time: { created: 1_717_171_717_000 },
  model: { id: "claude", providerID: "anthropic" },
}

const modelSwitchedEvent = {
  id: "evt_model",
  type: "session.next.model.switched",
  durable: { aggregateID: "ses_test", seq: 1, version: 1 },
  data: {
    timestamp: 1_717_171_717_000,
    sessionID: "ses_test",
    messageID: "msg_model",
    model: { id: "claude", providerID: "anthropic" },
  },
}

test("relay clients encode creation/identity guards and preserve sync null versus zero", async () => {
  const requests: Array<{ url: string; body: unknown }> = []
  let revision: number | null = null
  const client = OpenCode.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
      requests.push({ url, body })
      if (url.endsWith("/sync"))
        return Response.json({
          auth: { vendors: [], revision: 0 },
          candidates: [],
          managed: [],
          catalogRevision: revision,
          notice: { status: "idle" },
        })
      return Response.json({
        vendors: [],
        revision: 1,
        catalogSync: { status: "pending", retryable: true },
        operationReceipt: {
          operationId: "create",
          kind: "vendor-create",
          vendorId: "review",
          entityId: "entity",
          committedRevision: 1,
        },
      })
    },
  })
  const relay = client["server.relay"]
  const created = await relay.vendor({
    vendorId: "review",
    revision: 0,
    createOnly: true,
    operationId: "create",
    name: "Review",
  })
  expect(created.operationReceipt?.operationId).toBe("create")
  expect(created.catalogSync).toEqual({ status: "pending", retryable: true })
  expect(requests[0]?.body).toMatchObject({ createOnly: true, operationId: "create" })
  await relay.probe({ vendorId: "review", expectedEntityId: "entity", expectedVendorRevision: 1 })
  expect(requests[1]?.body).toMatchObject({ expectedEntityId: "entity", expectedVendorRevision: 1 })
  expect((await relay.sync({ retryNotice: true })).catalogRevision).toBeNull()
  revision = 0
  expect((await relay.sync()).catalogRevision).toBe(0)
  expect(requests[2]).toEqual({ url: "http://localhost:3000/api/relay/models/sync", body: { retryNotice: true } })
})
