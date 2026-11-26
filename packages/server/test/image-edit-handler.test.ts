import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import path from "node:path"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Global } from "@opencode-ai/core/global"
import { ModelV2 } from "@opencode-ai/core/model"
import { PermissionSaved } from "@opencode-ai/core/permission/saved"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { ImageEdit } from "@opencode-ai/protocol/groups/image-edit"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { createRoutes } from "../src/routes"

// Synthetic 2 × 1 RGBA images. The first mask pixel is transparent; the second is opaque.
const original = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGOoDrD5D8IAEMcEDQ5+L4sAAAAASUVORK5CYII="
const mask = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGOoDrBhqA6w+Q8AC8wDDvid+YgAAAAASUVORK5CYII="
const edited = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGOoDrD5Xx1gwwAAD8gDDo+nAZMAAAAASUVORK5CYII="
const partialAlpha = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGOoDrCprw6wYQAADUgCjhuu+6sAAAAASUVORK5CYII="
const wrongSize = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOoDrBhAAADWQEI7YHdVAAAAABJRU5ErkJggg=="

test("masked edit automatically follows generation settings without probing a provider", async () => {
  await using settings = await tmpdir()
  await using relay = await tmpdir()
  await using disabled = await tmpdir()
  await using unavailable = await tmpdir()
  await using unsupported = await tmpdir()
  await using unknown = await tmpdir()
  const received: string[] = []
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => {
    received.push(request.method)
    return new Response(null, { status: 500 })
  } })
  const model = "openai/gpt-image-2.5-flare"
  const generation = { enabled: true, api: "openai-images", model }
  const provider = (url: string) => ({
    openai: {
      api: { type: "aisdk", package: "@ai-sdk/openai", url },
      request: { body: { apiKey: "synthetic-key" } },
      models: { "gpt-image-2.5-flare": {}, "gpt-image-1.5": {} },
    },
  })
  const app = HttpRouter.toWebHandler(createRoutes("edit-test", [
    [Global.node, Global.layerWith({ config: settings.path })],
  ]).pipe(Layer.provide(HttpServer.layerServices)), { disableLogger: true })
  const context = Context.make(PermissionSaved.Service, {
    list: () => Effect.die("Diagnostics must not request saved permissions"),
    add: () => Effect.die("Diagnostics must not add saved permissions"),
    remove: () => Effect.die("Diagnostics must not remove saved permissions"),
  })
  const request = (directory: string) => {
    const query = new URLSearchParams({ "location[directory]": directory })
    return app.handler(new Request(`http://localhost/api/image-edit/status?${query}`, {
      headers: { authorization: `Basic ${Buffer.from("opencode:edit-test").toString("base64")}` },
    }), context)
  }
  const status = async (directory: string, expected: ImageEdit.Status["generation"]["state"]) => {
    const deadline = performance.now() + 10_000
    while (performance.now() < deadline) {
      const response = await request(directory)
      expect(response.status).toBe(200)
      const text = await response.text()
      expect(text).not.toContain("synthetic-key")
      const result = Schema.decodeUnknownSync(Schema.fromJsonString(ImageEdit.Status))(text)
      if (result.generation.state === expected) return result
      await Bun.sleep(50)
    }
    throw new Error(`Generation status did not become ${expected}`)
  }
  try {
    // Legacy global image settings still participate when the location does not override them.
    await Bun.write(path.join(settings.path, "config.json"), JSON.stringify({ image_generation: generation }))
    await Bun.write(path.join(settings.path, "opencode.json"), JSON.stringify({
      providers: provider("https://api.openai.com/v1"),
    }))
    await Bun.write(path.join(relay.path, "opencode.json"), JSON.stringify({ providers: provider(new URL("v1", upstream.url).href) }))
    await Bun.write(path.join(disabled.path, "opencode.json"), JSON.stringify({ image_generation: { ...generation, enabled: false } }))
    await Bun.write(path.join(unavailable.path, "opencode.json"), JSON.stringify({
      image_generation: { ...generation, model: "missing/image" },
      image_edit: { model: "missing/editor", protocol: "openai-mask" },
    }))
    await Bun.write(path.join(unsupported.path, "opencode.json"), JSON.stringify({
      image_generation: { ...generation, api: "google-gemini" },
      image_edit: { model, protocol: "openai-mask" },
    }))
    await Bun.write(path.join(unknown.path, "opencode.json"), JSON.stringify({
      providers: { openai: { models: { "gpt-image-2.5-flare": { api: { id: "unknown-wire-image" } } } } },
    }))
    const official = await status(settings.path, "documented")
    expect(official).toMatchObject({ generation: { model, state: "documented" }, editor: { state: "configured", source: "generation", target: { model, protocol: "openai-mask" } } })
    expect(await status(relay.path, "compatible")).toMatchObject({ generation: { model, state: "compatible" }, editor: { state: "configured", source: "generation", target: { model, endpoint: new URL("v1/images/edits", upstream.url).href } } })
    expect(await status(disabled.path, "disabled")).toEqual({ generation: { model, state: "disabled" }, editor: { state: "unconfigured" } })
    expect(await status(unavailable.path, "unavailable")).toEqual({
      generation: { model: "missing/image", state: "unavailable" }, editor: { state: "unconfigured" },
    })
    expect(await status(unsupported.path, "unsupported")).toEqual({ generation: { model, state: "unsupported" }, editor: { state: "unconfigured" } })
    expect(await status(unknown.path, "unknown")).toEqual({ generation: { model, state: "unknown" }, editor: { state: "unconfigured" } })
    await Bun.write(path.join(settings.path, "config.json"), JSON.stringify({ image_generation: { ...generation, model: "openai/gpt-image-1.5" } }))
    const changed = await status(settings.path, "documented")
    expect(changed).toMatchObject({ generation: { model: "openai/gpt-image-1.5", state: "documented" },
      editor: { state: "configured", source: "generation", target: { model: "openai/gpt-image-1.5" } } })
    if (official.editor.state !== "configured" || changed.editor.state !== "configured") throw new Error("Missing automatic editor")
    expect(changed.editor.target.binding).not.toBe(official.editor.target.binding)
    await Bun.write(path.join(settings.path, "config.json"), JSON.stringify({ image_generation: { ...generation, enabled: false } }))
    expect(await status(settings.path, "disabled")).toEqual({ generation: { model, state: "disabled" }, editor: { state: "unconfigured" } })
    if (official.editor.state !== "configured") throw new Error("Missing automatic editor")
    const query = new URLSearchParams({ "location[directory]": settings.path })
    const stale = await app.handler(new Request(`http://localhost/api/image-edit?${query}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Basic ${Buffer.from("opencode:edit-test").toString("base64")}` },
      body: JSON.stringify({ id: crypto.randomUUID(), scope: { type: "draft", id: crypto.randomUUID() },
        source: { type: "upload", image: original }, mask, prompt: "synthetic stale target", confirmed: true, target: official.editor.target }),
    }), context)
    expect(stale.status).toBe(400)
    expect(received).toEqual([])
  } finally {
    upstream.stop(true)
    await app.dispose()
  }
})

test("masked edit routes send only the confirmed bytes, reconcile without dispatch, and keep versions isolated", async () => {
  await using project = await tmpdir()
  await using other = await tmpdir()
  const received: { path: string; method: string; auth: string | null; form: FormData }[] = []
  const waiting = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request): Promise<Response> {
      const url = new URL(request.url)
      const pathname = url.pathname
      if (pathname !== "/v1/images/edits" || request.method !== "POST") {
        received.push({ path: pathname, method: request.method, auth: null, form: new FormData() })
        return new Response(null, { status: 404 })
      }
      const form = await request.formData()
      received.push({ path: pathname, method: request.method, auth: request.headers.get("authorization"), form })
      if (form.get("prompt") === "hold") {
        waiting.resolve()
        await release.promise
      }
      if (form.get("prompt") === "redirect") return Response.redirect(new URL("/result", url))
      if (form.get("prompt") === "return a URL") return Response.json({ data: [{ url: new URL("/result", url) }] })
      if (form.get("prompt") === "invalid receipt") return Response.json({ data: [{ b64_json: "iVBORw0KGgo=" }] })
      return Response.json({ data: [{ b64_json: edited }] })
    },
  })
  const database = Database.layerFromPath(path.join(project.path, "receipts.sqlite"))
  const openApp = () => HttpRouter.toWebHandler(
    createRoutes("edit-test", [[Database.node, database]]).pipe(Layer.provide(HttpServer.layerServices)),
    { disableLogger: true },
  )
  const app = openApp()
  const context = Context.make(PermissionSaved.Service, {
    list: () => Effect.die("Masked editing must not request saved permissions"),
    add: () => Effect.die("Masked editing must not add saved permissions"),
    remove: () => Effect.die("Masked editing must not remove saved permissions"),
  })
  const send = (pathname: string, body?: object, directory = project.path, auth = true, workspace?: string, server = app) => {
    const url = new URL(pathname, "http://localhost")
    url.searchParams.set("location[directory]", directory)
    if (workspace) url.searchParams.set("location[workspace]", workspace)
    return server.handler(new Request(url, {
      method: body ? "POST" : "GET",
      headers: {
        "content-type": "application/json",
        ...(auth ? { authorization: `Basic ${Buffer.from("opencode:edit-test").toString("base64")}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    }), context)
  }
  const route = "/api/image-edit"
  try {
    await Bun.write(path.join(project.path, "opencode.json"), JSON.stringify({
      image_generation: { enabled: true, model: "fixture/image", api: "openai-images" },
      providers: {
        fixture: {
          api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: new URL("v1", upstream.url).href },
          request: { body: { apiKey: "loopback-fixture-key" } },
          models: { image: { api: { id: "gpt-image-2.5-flare" } } },
        },
      },
    }))
    expect((await send(`${route}/target`, undefined, project.path, false)).status).toBe(401)
    expect((await send(`${route}/status`, undefined, project.path, false)).status).toBe(401)
    expect(await (await send(`${route}/target`, undefined, other.path)).json()).toBeNull()
    // The location's provider catalog is populated by the background plugin boot.
    const target = await (async () => {
      const deadline = performance.now() + 10_000
      while (performance.now() < deadline) {
        const response = await send(`${route}/target`)
        expect(response.status).toBe(200)
        const text = await response.text()
        expect(text).not.toContain("loopback-fixture-key")
        const target = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.NullOr(ImageEdit.Target)))(text)
        if (target) return target
        await Bun.sleep(50)
      }
      throw new Error("Configured loopback editor did not become available")
    })()
    expect(target).toMatchObject({ model: "fixture/image", endpoint: new URL("v1/images/edits", upstream.url).href })
    expect(await (await send(`${route}/status`)).json()).toEqual({
      generation: { model: "fixture/image", state: "compatible" },
      editor: { state: "configured", target, source: "generation" },
    })
    const input = {
      id: crypto.randomUUID(), scope: { type: "draft", id: crypto.randomUUID() }, source: { type: "upload", image: original },
      target, confirmed: true, mask, prompt: "hold",
    } satisfies ImageEdit.Request
    expect((await send(route, { ...input, confirmed: false })).status).toBe(400)
    expect((await send(route, { ...input, reconcile: true })).status).toBe(409)
    expect((await send(route, { ...input, target: { ...target, binding: "stale" } })).status).toBe(400)
    for (const invalid of [original, partialAlpha, wrongSize, "iVBORw0KGgo="])
      expect((await send(route, { ...input, mask: invalid })).status).toBe(400)
    expect(received).toHaveLength(0)

    const first = send(route, input)
    await Promise.race([waiting.promise, first.then((response) => { throw new Error(`Finished before dispatch: ${response.status}`) })])
    expect((await send(route, input)).status).toBe(409)
    expect((await send(route, { ...input, reconcile: true })).status).toBe(409)
    release.resolve()
    const receipt = { id: input.id, mime: "image/png", data: edited }
    expect(await (await first).json()).toEqual(receipt)
    expect(await (await send(route, { ...input, reconcile: true })).json()).toEqual(receipt)
    expect((await send(route, { ...input, prompt: "different" })).status).toBe(409)
    expect((await send(route, input, other.path)).status).toBe(409)
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ path: "/v1/images/edits", method: "POST", auth: "Bearer loopback-fixture-key" })
    const form = received[0].form
    expect([...form.keys()].sort()).toEqual(["image", "mask", "model", "n", "prompt"])
    expect(form.get("model")).toBe("gpt-image-2.5-flare")
    expect(form.get("n")).toBe("1")
    expect(form.get("prompt")).toBe("hold")
    for (const entry of [{ field: "image", data: original }, { field: "mask", data: mask }]) {
      const file = form.get(entry.field)
      if (!(file instanceof Blob)) throw new Error(`Missing multipart ${entry.field}`)
      expect(file.type).toBe("image/png")
      expect(Buffer.from(await file.arrayBuffer()).toString("base64")).toBe(entry.data)
    }

    const next = { ...input, id: crypto.randomUUID(), source: { type: "edit", id: input.id }, prompt: "next" }
    expect((await send(route, { ...next, scope: { type: "draft", id: crypto.randomUUID() } })).status).toBe(400)
    expect(await (await send(route, next)).json()).toEqual({ ...receipt, id: next.id })
    const previous = received[1].form.get("image")
    if (!(previous instanceof Blob)) throw new Error("Missing previous image")
    expect(Buffer.from(await previous.arrayBuffer()).toString("base64")).toBe(edited)
    for (const prompt of ["redirect", "return a URL", "invalid receipt"]) {
      const attempt = { ...input, id: crypto.randomUUID(), prompt }
      expect((await send(route, attempt)).status).toBe(503)
      expect((await send(route, { ...attempt, reconcile: true })).status).toBe(409)
    }
    expect(received.map((request) => request.path)).toEqual(Array(5).fill("/v1/images/edits"))

    const sessionID = SessionV2.ID.make(`ses_masked_${crypto.randomUUID()}`)
    const otherID = SessionV2.ID.make(`ses_masked_${crypto.randomUUID()}`)
    for (const id of [sessionID, otherID]) {
      expect((await send("/api/session", { id, location: { directory: project.path } })).status).toBe(200)
    }
    const messageID = SessionMessage.ID.create()
    const callID = "masked-test-generation"
    const projector = LayerNode.compile(LayerNode.group([EventV2.node, SessionProjector.node]), [
      [Database.node, database],
    ])
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const events = yield* EventV2.Service
      const step = { sessionID, assistantMessageID: messageID, timestamp: DateTime.makeUnsafe(1) }
      const tool = { ...step, callID, provider: { executed: false } }
      yield* events.publish(SessionEvent.Step.Started, {
        ...step, agent: "build", model: { providerID: ProviderV2.ID.make("fixture"), id: ModelV2.ID.make("image") },
      })
      yield* events.publish(SessionEvent.Tool.Input.Started, { ...tool, name: "image_generation" })
      yield* events.publish(SessionEvent.Tool.Called, { ...tool, tool: "image_generation", input: {} })
      yield* events.publish(SessionEvent.Tool.Success, {
        ...tool, structured: {}, content: [{ type: "file", mime: "image/png", uri: `data:image/png;base64,${original}` }],
      })
    }).pipe(Effect.provide(projector))))
    const generated = {
      ...input, id: crypto.randomUUID(), prompt: "edit the projected image", scope: { type: "session", id: sessionID },
      source: { type: "generated", messageID, callID, digest: createHash("sha256").update(Buffer.from(original, "base64")).digest("hex") },
    } satisfies ImageEdit.Request
    const history = `/api/session/${sessionID}/message`
    const before = await send(history)
    expect(before.status).toBe(200)
    const visible = await before.json()
    expect((await send(route, { ...generated, scope: { type: "session", id: otherID } })).status).toBe(400)
    expect((await send(route, generated, project.path, true, "wrk_masked_other")).status).toBe(400)
    expect((await send(route, { ...generated, source: { ...generated.source, digest: "0".repeat(64) } })).status).toBe(400)
    expect((await send(route, { ...generated, source: { ...generated.source, callID: "other-call" } })).status).toBe(400)
    expect(received).toHaveLength(5)
    expect(await (await send(route, generated)).json()).toEqual({ ...receipt, id: generated.id })
    const projectedImage = received[5]?.form.get("image")
    if (!(projectedImage instanceof Blob)) throw new Error("Missing projected image")
    expect(Buffer.from(await projectedImage.arrayBuffer()).toString("base64")).toBe(original)
    expect(await (await send(history)).json()).toEqual(visible)
    expect(await (await send(`/api/session/${sessionID}/input`)).json()).toMatchObject({ data: { inputs: [] } })

    await app.dispose()
    await upstream.stop(true)
    const reopened = openApp()
    try {
      expect(await (await send(route, { ...generated, reconcile: true }, project.path, true, undefined, reopened)).json())
        .toEqual({ ...receipt, id: generated.id })
      expect(received.map((request) => request.path)).toEqual(Array(6).fill("/v1/images/edits"))
    } finally {
      await reopened.dispose()
    }
  } finally {
    release.resolve()
    await upstream.stop(true)
    await app.dispose()
  }
}, 30_000)
