import { expect, test } from "bun:test"
import { Context, Effect, Layer, Schema } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { SessionInput } from "@opencode-ai/core/session/input"
import { PermissionSaved } from "@opencode-ai/core/permission/saved"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { createRoutes } from "../src/routes"

test("pending inputs are durable, authenticated and readable without Session placement or execution", async () => {
  await using tmp = await tmpdir()
  const app = HttpRouter.toWebHandler(createRoutes("pending-test").pipe(Layer.provide(HttpServer.layerServices)), {
    disableLogger: true,
  })
  const send = (pathname: string, body?: object, authenticated = true) =>
    app.handler(
      new Request(new URL(pathname, "http://localhost"), {
        method: body ? "POST" : "GET",
        headers: {
          "content-type": "application/json",
          ...(authenticated
            ? { authorization: `Basic ${Buffer.from("opencode:pending-test").toString("base64")}` }
            : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      }),
      Context.make(PermissionSaved.Service, {
        list: () => Effect.die("Inbox reads must not request saved permissions"),
        add: () => Effect.die("Inbox reads must not add saved permissions"),
        remove: () => Effect.die("Inbox reads must not remove saved permissions"),
      }),
    )
  const sessionID = "ses_pending_wire_test"
  const pathname = `/api/session/${sessionID}/input`
  try {
    expect((await send(pathname, undefined, false)).status).toBe(401)
    expect((await send(pathname)).status).toBe(404)
    expect((await send("/api/session", { id: sessionID, location: { directory: tmp.path } })).status).toBe(200)
    const first = await send(pathname)
    expect(first.status).toBe(200)
    const empty = Schema.decodeUnknownSync(Schema.Struct({ data: SessionInput.Pending }))(await first.json()).data
    expect(empty.inputs).toEqual([])

    expect(
      (
        await send(`/api/session/${sessionID}/prompt`, {
          id: "msg_pending_wire_test",
          prompt: { text: "Persist without provider work" },
          delivery: "queue",
          resume: false,
        })
      ).status,
    ).toBe(200)
    const read = await send(pathname)
    expect(read.status).toBe(200)
    const pending = Schema.decodeUnknownSync(Schema.Struct({ data: SessionInput.Pending }))(await read.json()).data
    expect(pending.sequence).toBeGreaterThan(empty.sequence)
    expect(pending.inputs).toMatchObject([
      { id: "msg_pending_wire_test", sessionID, delivery: "queue", prompt: { text: "Persist without provider work" } },
    ])
    expect(await (await send(pathname)).json()).toEqual(
      Schema.encodeSync(Schema.Struct({ data: SessionInput.Pending }))({ data: pending }),
    )
  } finally {
    await app.dispose()
  }
}, 60000)
