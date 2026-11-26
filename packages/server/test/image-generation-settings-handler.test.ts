import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Effect, Layer } from "effect"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { ImageGenerationGroup } from "@opencode-ai/protocol/groups/image-generation"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { AtomicDocument } from "@opencode-ai/core/config/atomic-document"
import { ImageGenerationSettings } from "@opencode-ai/core/image-generation-settings"
import { Authorization } from "../src/middleware/authorization"
import { schemaErrorLayer } from "../src/middleware/schema-error"
import { ImageGenerationHandler } from "../src/handlers/image-generation"
import { tmpdir } from "../../core/test/fixture/tmpdir"

for (const aliased of [false, true]) {
  test(`F34 real TCP image settings ${aliased ? "legacy alias rejection" : "canonical save"}`, async () => {
    await using tmp = await tmpdir()
    const directory = path.join(tmp.path, "config"), alias = path.join(tmp.path, "alias")
    const file = path.join(directory, "opencode.json"), before = '{"username":"PRIVATE-IMAGE-SENTINEL","image_generation":{"enabled":false}}'
    await fs.mkdir(directory); await fs.writeFile(file, before)
    if (aliased) await fs.symlink(directory, alias, process.platform === "win32" ? "junction" : "dir")
    const services = AppNodeBuilder.build(ImageGenerationSettings.node, [[Global.node, Global.layerWith({ config: aliased ? alias : directory, state: path.join(tmp.path, "state") })]])
    const app = HttpRouter.toWebHandler(HttpApiBuilder.layer(HttpApi.make("server").add(ImageGenerationGroup)).pipe(
      Layer.provide(ImageGenerationHandler), Layer.provide(Layer.succeed(Authorization, Authorization.of((effect) => effect))), Layer.provide(schemaErrorLayer), Layer.provide(services), Layer.provide(HttpServer.layerServices),
    ), { disableLogger: true })
    const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => app.handler(request) })
    try {
      const url = new URL("api/settings/image-generation", listener.url)
      const response = await fetch(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true, model: "local/image", api: "openai-images", automaticIllustrations:true, taskRequestLimit:3 }) })
      const body = await response.text()
      expect(body).not.toContain("PRIVATE-IMAGE-SENTINEL"); expect(body).not.toContain(tmp.path)
      expect(response.status).toBe(aliased ? 400 : 200)
      if (aliased) { expect(body).toContain("canonical configuration directory"); expect(await fs.readFile(file, "utf8")).toBe(before) }
      const loaded = await fetch(url)
      expect(loaded.status).toBe(200)
      const data = await loaded.json() as { enabled: boolean; data?: { enabled: boolean } }
      expect((data.data ?? data).enabled).toBe(!aliased)
      if (!aliased) expect(data.data ?? data).toMatchObject({automaticIllustrations:true,taskRequestLimit:3})
      expect((await fs.readdir(directory)).filter((entry) => entry.endsWith(".tmp"))).toEqual([])
    } finally { await listener.stop(true); await app.dispose() }
  })
}

test("IMG-T09 real HTTP keeps a committed save successful while stage cleanup is pending", async () => {
  await using tmp = await tmpdir()
  const directory = path.join(tmp.path, "config")
  const file = path.join(directory, "opencode.json")
  await fs.mkdir(directory)
  const rmdir = spyOn(fs, "rmdir").mockRejectedValue(Object.assign(new Error("busy"), { code: "EBUSY" }))
  const publish = spyOn(AtomicDocument, "publish")
  const services = AppNodeBuilder.build(ImageGenerationSettings.node, [[Global.node, Global.layerWith({ config: directory, state: path.join(tmp.path, "state") })]])
  const app = HttpRouter.toWebHandler(HttpApiBuilder.layer(HttpApi.make("server").add(ImageGenerationGroup)).pipe(
    Layer.provide(ImageGenerationHandler), Layer.provide(Layer.succeed(Authorization, Authorization.of((effect) => effect))), Layer.provide(schemaErrorLayer), Layer.provide(services), Layer.provide(HttpServer.layerServices),
  ), { disableLogger: true })
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => app.handler(request) })
  try {
    const response = await fetch(new URL("api/settings/image-generation", listener.url), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true, model: "local/image", api: "openai-images" }) })
    const body = await response.text()
    expect(response.status).toBe(200)
    expect(body).toContain("local/image")
    expect(await fs.readFile(file, "utf8")).toContain("local/image")
    expect((await fs.readdir(directory)).some((entry) => entry.startsWith(".opencode-stage-"))).toBe(true)
    expect(await AtomicDocument.retryCleanup()).toEqual({ remaining: 1, failed: 1 })
    expect(publish).toHaveBeenCalledTimes(1)
    const committed = await fs.readFile(file, "utf8")
    const owner = await fs.stat(file)
    rmdir.mockRestore()
    expect(await AtomicDocument.retryCleanup()).toEqual({ remaining: 0, failed: 0 })
    expect(publish).toHaveBeenCalledTimes(1)
    expect(await fs.readFile(file, "utf8")).toBe(committed)
    expect((await fs.stat(file)).ino).toBe(owner.ino)
    expect((await fs.readdir(directory)).some((entry) => entry.startsWith(".opencode-stage-"))).toBe(false)
  } finally {
    rmdir.mockRestore()
    publish.mockRestore()
    await AtomicDocument.retryCleanup()
    await listener.stop(true)
    await app.dispose()
  }
})

test("IMG-T09 real HTTP prepare failure does not replace the existing configuration", async () => {
  await using tmp = await tmpdir()
  const directory = path.join(tmp.path, "config")
  const file = path.join(directory, "opencode.json")
  const before = '{"username":"PRIVATE-IMAGE-SENTINEL","model":"chat/model"}\n'
  await fs.mkdir(directory)
  await fs.writeFile(file, before)
  const open = fs.open.bind(fs)
  const owned: { handle: fs.FileHandle; writeFile: fs.FileHandle["writeFile"] }[] = []
  const intercepted = spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args)
    if (!String(args[0]).endsWith("document.tmp")) return handle
    owned.push({ handle, writeFile: handle.writeFile })
    const write = handle.writeFile.bind(handle)
    handle.writeFile = async () => {
      await write("partial", "utf8")
      throw Object.assign(new Error("secret-token"), { code: "EIO" })
    }
    return handle
  })
  const services = AppNodeBuilder.build(ImageGenerationSettings.node, [[Global.node, Global.layerWith({ config: directory, state: path.join(tmp.path, "state") })]])
  const app = HttpRouter.toWebHandler(HttpApiBuilder.layer(HttpApi.make("server").add(ImageGenerationGroup)).pipe(
    Layer.provide(ImageGenerationHandler), Layer.provide(Layer.succeed(Authorization, Authorization.of((effect) => effect))), Layer.provide(schemaErrorLayer), Layer.provide(services), Layer.provide(HttpServer.layerServices),
  ), { disableLogger: true })
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => app.handler(request) })
  try {
    const response = await fetch(new URL("api/settings/image-generation", listener.url), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true, model: "local/image", api: "openai-images" }) })
    const body = await response.text()
    expect(response.status).toBe(400)
    expect(body).toContain("unavailable")
    expect(body).toContain("not replaced")
    expect(body).not.toContain("secret-token")
    expect(body).not.toContain("PRIVATE-IMAGE-SENTINEL")
    expect(body).not.toContain(tmp.path)
    expect(await fs.readFile(file, "utf8")).toBe(before)
    expect((await fs.readdir(directory)).filter((entry) => entry.startsWith(".opencode-stage-"))).toEqual([])
  } finally {
    intercepted.mockRestore()
    for (const item of owned) item.handle.writeFile = item.writeFile
    await listener.stop(true)
    await app.dispose()
  }
  expect(owned.length).toBeGreaterThan(0)
})

test("IMG-T09 real HTTP close rejection does not return the internal close secret", async () => {
  await using tmp = await tmpdir()
  const directory = path.join(tmp.path, "config")
  const file = path.join(directory, "opencode.json")
  const before = '{"username":"PRIVATE-IMAGE-SENTINEL"}\n'
  await fs.mkdir(directory)
  await fs.writeFile(file, before)
  const server = pathToFileURL(path.resolve(import.meta.dir, "../src/handlers/image-generation.ts")).href
  const child = Bun.spawn([process.execPath, "--eval", `
    const fs = (await import("node:fs/promises")).default
    const path = (await import("node:path")).default
    const { Effect, Layer } = await import("effect")
    const { HttpApi, HttpApiBuilder } = await import("effect/unstable/httpapi")
    const { HttpRouter, HttpServer } = await import("effect/unstable/http")
    const { ImageGenerationGroup } = await import("@opencode-ai/protocol/groups/image-generation")
    const { AppNodeBuilder } = await import("@opencode-ai/core/effect/app-node-builder")
    const { Global } = await import("@opencode-ai/core/global")
    const { ImageGenerationSettings } = await import("@opencode-ai/core/image-generation-settings")
    const { Authorization } = await import(${JSON.stringify(pathToFileURL(path.resolve(import.meta.dir, "../src/middleware/authorization.ts")).href)})
    const { schemaErrorLayer } = await import(${JSON.stringify(pathToFileURL(path.resolve(import.meta.dir, "../src/middleware/schema-error.ts")).href)})
    const { ImageGenerationHandler } = await import(${JSON.stringify(server)})
    const directory = ${JSON.stringify(directory)}
    const file = ${JSON.stringify(file)}
    const open = fs.open.bind(fs)
    fs.open = async (...args) => {
      const handle = await open(...args)
      if (String(args[0]).endsWith("document.tmp")) handle.close = async () => { throw new Error("secret-close " + file) }
      return handle
    }
    const services = AppNodeBuilder.build(ImageGenerationSettings.node, [[Global.node, Global.layerWith({ config: directory, state: ${JSON.stringify(path.join(tmp.path, "state"))} })]])
    const app = HttpRouter.toWebHandler(HttpApiBuilder.layer(HttpApi.make("server").add(ImageGenerationGroup)).pipe(
      Layer.provide(ImageGenerationHandler), Layer.provide(Layer.succeed(Authorization, Authorization.of((effect) => effect))), Layer.provide(schemaErrorLayer), Layer.provide(services), Layer.provide(HttpServer.layerServices),
    ), { disableLogger: true })
    const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => app.handler(request) })
    const response = await fetch(new URL("api/settings/image-generation", listener.url), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true, model: "local/image", api: "openai-images" }) })
    const body = await response.text()
    if (response.status !== 400 || !body.includes("unavailable") || !body.includes("not replaced") || body.includes("secret-close") || body.includes("PRIVATE-IMAGE-SENTINEL") || body.includes(${JSON.stringify(tmp.path)}) || await fs.readFile(file, "utf8") !== ${JSON.stringify(before)}) {
      throw new Error(JSON.stringify({ status: response.status, body }))
    }
    console.log("IMG_T09_CLOSE_SECRET_HIDDEN")
    await listener.stop(true)
    await app.dispose()
  `], { stdout: "pipe", stderr: "pipe" })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect(stderr).toBe("")
  expect(code).toBe(0)
  expect(stdout).toContain("IMG_T09_CLOSE_SECRET_HIDDEN")
  expect(await fs.readFile(file, "utf8")).toBe(before)
}, 30_000)

test("IMG-T09 real HTTP maps an ordinary publication failure safely without retrying", async () => {
  await using tmp = await tmpdir()
  const directory = path.join(tmp.path, "config")
  const file = path.join(directory, "opencode.json")
  const before = '{"username":"PRIVATE-IMAGE-SENTINEL"}\n'
  await fs.mkdir(directory)
  await fs.writeFile(file, before)
  const publish = spyOn(AtomicDocument, "publish").mockRejectedValue(new Error("ordinary-secret " + tmp.path))
  const services = AppNodeBuilder.build(ImageGenerationSettings.node, [[Global.node, Global.layerWith({ config: directory, state: path.join(tmp.path, "state") })]])
  const app = HttpRouter.toWebHandler(HttpApiBuilder.layer(HttpApi.make("server").add(ImageGenerationGroup)).pipe(
    Layer.provide(ImageGenerationHandler), Layer.provide(Layer.succeed(Authorization, Authorization.of((effect) => effect))), Layer.provide(schemaErrorLayer), Layer.provide(services), Layer.provide(HttpServer.layerServices),
  ), { disableLogger: true })
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => app.handler(request) })
  try {
    const response = await fetch(new URL("api/settings/image-generation", listener.url), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true, model: "local/image", api: "openai-images" }) })
    const body = await response.text()
    expect(response.status).toBe(400)
    expect(body).toContain("unknown")
    expect(body).toContain("reconciliation")
    expect(body).not.toContain("not replaced")
    expect(body).not.toContain("ordinary-secret")
    expect(body).not.toContain("PRIVATE-IMAGE-SENTINEL")
    expect(body).not.toContain(tmp.path)
    expect(publish).toHaveBeenCalledTimes(1)
    expect(await fs.readFile(file, "utf8")).toBe(before)
  } finally {
    publish.mockRestore()
    await listener.stop(true)
    await app.dispose()
  }
})

test("IMG-T09 real HTTP keeps unknown publication distinct from an uncommitted save", async () => {
  await using tmp = await tmpdir()
  const directory = path.join(tmp.path, "config")
  const file = path.join(directory, "opencode.json")
  await fs.mkdir(directory)
  const link = fs.link.bind(fs)
  const stat = fs.stat.bind(fs)
  let published = false
  const linkSpy = spyOn(fs, "link").mockImplementation(async (...args) => {
    await link(...args)
    published = true
    throw Object.assign(new Error("secret-token"), { code: "EPERM" })
  })
  const statSpy = spyOn(fs, "stat").mockImplementation(((target, options) => {
    if (published && String(target) === file) return Promise.reject(Object.assign(new Error("secret-token"), { code: "EPERM" }))
    return stat(target, options)
  }) as typeof fs.stat)
  const services = AppNodeBuilder.build(ImageGenerationSettings.node, [[Global.node, Global.layerWith({ config: directory, state: path.join(tmp.path, "state") })]])
  const app = HttpRouter.toWebHandler(HttpApiBuilder.layer(HttpApi.make("server").add(ImageGenerationGroup)).pipe(
    Layer.provide(ImageGenerationHandler), Layer.provide(Layer.succeed(Authorization, Authorization.of((effect) => effect))), Layer.provide(schemaErrorLayer), Layer.provide(services), Layer.provide(HttpServer.layerServices),
  ), { disableLogger: true })
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => app.handler(request) })
  try {
    const response = await fetch(new URL("api/settings/image-generation", listener.url), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true, model: "local/image", api: "openai-images" }) })
    const body = await response.text()
    expect(response.status).toBe(400)
    expect(body).toContain("unknown")
    expect(body).not.toContain("not replaced")
    expect(body).not.toContain("secret-token")
    expect(body).not.toContain(tmp.path)
    expect(await fs.readFile(file, "utf8")).toContain("local/image")
  } finally {
    linkSpy.mockRestore()
    statSpy.mockRestore()
    await listener.stop(true)
    await app.dispose()
  }
})
