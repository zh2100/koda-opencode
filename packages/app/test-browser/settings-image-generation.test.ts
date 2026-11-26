import { describe, expect, test } from "bun:test"
import type { ImageGeneration } from "@opencode-ai/schema/image-generation"
import { createRoot, createSignal } from "solid-js"
import { createImageGenerationSettings } from "../src/components/settings-image-generation-state"
import { createGeneratedApiForServer, createSdkForServer } from "../src/utils/server"

const config = {
  enabled: true,
  model: "images/local",
  api: "openai-images",
  automaticIllustrations: true,
  taskRequestLimit: 3,
} as const

function server(
  name: string,
  protocol: "v1" | "v2",
  options: {
    protocol?: Promise<"v1" | "v2">
    load?: Promise<ImageGeneration.Config>
    save?: Promise<void>
    fail?: boolean
  } = {},
) {
  const requests: { path: string; method: string; body: unknown }[] = []
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    requests.push({
      path: new URL(request.url).pathname,
      method: request.method,
      body: request.method === "GET" ? undefined : await request.json(),
    })
    if (request.method !== "GET") {
      if (options.save) await options.save
      if (options.fail) return Response.json({ message: "local save failure" }, { status: 500 })
      return Response.json(protocol === "v1" ? { image_generation: config } : config)
    }
    const value = options.load ? await options.load : config
    return Response.json(protocol === "v1" ? { image_generation: value } : value)
  }
  const http = { url: `http://${name}.test` }
  return {
    sdk: {
      protocol: options.protocol ?? Promise.resolve(protocol),
      client: createSdkForServer({ server: http, fetch: fetcher, throwOnError: true }),
      api: createGeneratedApiForServer({ server: http, fetch: fetcher }),
    },
    requests,
  }
}

function setup(initial: ReturnType<typeof server>["sdk"]) {
  return createRoot((dispose) => {
    const [current, setCurrent] = createSignal(initial)
    return { state: createImageGenerationSettings(current), setCurrent, dispose }
  })
}

async function waitFor(condition: () => boolean) {
  const deadline = Date.now() + 1000
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for local settings request")
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function settled(view: ReturnType<typeof setup>) {
  return waitFor(() => !view.state.settings.loading)
}

describe("image settings server isolation", () => {
  for (const protocol of ["v1", "v2"] as const) {
    test(`${protocol} keeps the captured server while protocol detection is pending`, async () => {
      const pending = Promise.withResolvers<"v1" | "v2">()
      const first = server("first", protocol, { protocol: pending.promise })
      const second = server("second", protocol === "v1" ? "v2" : "v1")
      const view = setup(first.sdk)
      try {
        const saving = view.state.save(first.sdk, config)
        view.setCurrent(second.sdk)
        await settled(view)
        pending.resolve(protocol)
        await saving
        expect(first.requests.filter((item) => item.method !== "GET")).toEqual([
          {
            path: protocol === "v1" ? "/global/config" : "/api/settings/image-generation",
            method: protocol === "v1" ? "PATCH" : "PUT",
            body: protocol === "v1" ? { image_generation: config } : config,
          },
        ])
        expect(second.requests.every((item) => item.method === "GET")).toBe(true)
        expect(view.state.settings()?.server).toBe(second.sdk)
      } finally {
        pending.resolve(protocol)
        view.dispose()
      }
    })

    test(`${protocol} does not replace new server settings when an old save completes`, async () => {
      const pending = Promise.withResolvers<void>()
      const first = server("first", protocol, { save: pending.promise })
      const second = server("second", protocol)
      const view = setup(first.sdk)
      try {
        await settled(view)
        const loaded = view.state.settings()
        if (!loaded || loaded.error) throw new Error("Expected loaded settings")
        const saving = view.state.save(loaded.server, { enabled: false })
        view.setCurrent(second.sdk)
        await settled(view)
        const current = view.state.settings()
        pending.resolve()
        await saving
        expect(view.state.settings()).toBe(current)
        expect(view.state.settings()?.server).toBe(second.sdk)
        expect(view.state.settings()?.config).toEqual(config)
        expect(first.requests.filter((item) => item.method !== "GET")).toHaveLength(1)
        expect(second.requests.every((item) => item.method === "GET")).toBe(true)
      } finally {
        pending.resolve()
        view.dispose()
      }
    })

    test(`${protocol} ignores stale load responses`, async () => {
      const pending = Promise.withResolvers<ImageGeneration.Config>()
      const first = server("first", protocol, { load: pending.promise })
      const second = server("second", protocol)
      const view = setup(first.sdk)
      try {
        await waitFor(() => first.requests.length === 1)
        view.setCurrent(second.sdk)
        await settled(view)
        pending.resolve({ enabled: false, model: "stale/model" })
        // Drain the old SDK response before checking the resource's current value.
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(view.state.settings()?.server).toBe(second.sdk)
        expect(view.state.settings()?.config).toEqual(config)
      } finally {
        pending.resolve({})
        view.dispose()
      }
    })

    test(`${protocol} reports a save failure without retrying`, async () => {
      const target = server("failure", protocol, { fail: true })
      const view = setup(target.sdk)
      try {
        await settled(view)
        await expect(view.state.save(target.sdk, config)).rejects.toBeDefined()
        expect(target.requests.filter((item) => item.method !== "GET")).toHaveLength(1)
      } finally {
        view.dispose()
      }
    })

    test(`${protocol} can clear model and API without changing the conversation model`, async () => {
      const target = server("clear", protocol)
      const view = setup(target.sdk)
      try {
        await settled(view)
        await view.state.save(target.sdk, { enabled: false })
        expect(target.requests.filter((item) => item.method !== "GET").map((item) => item.body)).toEqual([
          protocol === "v1" ? { image_generation: { enabled: false } } : { enabled: false },
        ])
      } finally {
        view.dispose()
      }
    })
  }
})
