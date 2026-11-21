import { afterAll, expect, spyOn } from "bun:test"
import { Relay } from "@opencode-ai/schema/relay"
import { Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer } from "./httpapi-layer"

// XDG/home/database isolation comes from test/preload.ts. Bun's OS credential
// store is not XDG-scoped, so force the real service's temporary-file fallback.
const secrets = [
  spyOn(Bun.secrets, "get").mockRejectedValue(new Error("test: OS secrets disabled")),
  spyOn(Bun.secrets, "set").mockRejectedValue(new Error("test: OS secrets disabled")),
  spyOn(Bun.secrets, "delete").mockRejectedValue(new Error("test: OS secrets disabled")),
]
afterAll(() => secrets.forEach((spy) => spy.mockRestore()))

const it = testEffect(httpApiLayer)

it.live("reads, persists, and clears relay vendor auth through the default v1 route tree", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped({ config: { plugin: [], lsp: false, formatter: false } })
    const request = Effect.fn(function* (input: HttpClientRequest.HttpClientRequest) {
      const response = yield* input.pipe(
        HttpClientRequest.setHeader("x-opencode-directory", directory),
        HttpClient.execute,
      )
      const body = yield* response.text
      expect(response.status, body).toBe(200)
      expect(body).not.toContain("dummy-not-a-real-api-key")
      return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Relay.AuthState))(body)
    })

    const initial = yield* request(HttpClientRequest.get("/api/relay/auth"))
    expect(initial.vendors).toEqual([])
    expect(initial.capabilities).toContain("independent-vendors-v1")

    const saved = yield* request(
      HttpClientRequest.put("/api/relay/auth/vendors/chatgpt").pipe(
        HttpClientRequest.bodyJsonUnsafe({
          name: "Independent ChatGPT",
          baseURL: "https://independent.invalid/v1",
          key: "dummy-not-a-real-api-key",
          revision: initial.revision,
          createOnly: true,
          operationId: crypto.randomUUID(),
        }),
      ),
    )
    expect(saved.vendors.find((vendor) => vendor.id === "chatgpt")).toMatchObject({
      hasKey: true,
      builtin: false,
      baseURL: "https://independent.invalid/v1",
    })
    expect(saved.revision).toBe(initial.revision + 1)
    const entity = saved.vendors.find((vendor) => vendor.id === "chatgpt")!.entityId
    expect(entity).toBeDefined()

    const persisted = yield* request(HttpClientRequest.get("/api/relay/auth"))
    expect(saved.operationReceipt).toMatchObject({
      entityId: entity,
      vendorId: "chatgpt",
      committedRevision: saved.revision,
    })
    expect(persisted).toEqual({ revision: saved.revision, vendors: saved.vendors, capabilities: saved.capabilities })
    expect(persisted.vendors.find((vendor) => vendor.id === "chatgpt")).toMatchObject({ hasKey: true })

    const cleared = yield* request(
      HttpClientRequest.make("DELETE")("/api/relay/auth/vendors/chatgpt/key").pipe(
        HttpClientRequest.bodyJsonUnsafe({ revision: persisted.revision, expectedEntityId: entity }),
      ),
    )
    expect(cleared.vendors.find((vendor) => vendor.id === "chatgpt")).toMatchObject({
      hasKey: false,
      builtin: false,
      entityId: entity,
    })
    expect(cleared.revision).toBe(persisted.revision + 1)
    expect(cleared.catalogSync).toEqual({ status: "synced", retryable: false })
    expect(yield* request(HttpClientRequest.get("/api/relay/auth"))).toEqual({
      revision: cleared.revision,
      vendors: cleared.vendors,
      capabilities: cleared.capabilities,
    })
  }),
)
