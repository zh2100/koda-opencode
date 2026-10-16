import { expect } from "bun:test"
import { Effect } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer } from "./httpapi-layer"

const it = testEffect(httpApiLayer)

it.live("relay vendor payload validates and persists independent baseURL", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped({ config: { plugin: [], lsp: false, formatter: false } })
    const request = (payload: unknown) =>
      HttpClientRequest.put("/api/relay/auth/vendors/custom").pipe(
        HttpClientRequest.setHeader("x-opencode-directory", directory),
        HttpClientRequest.bodyJsonUnsafe(payload),
        HttpClient.execute,
      )
    const response = yield* request({ name: "Custom", baseURL: "http://localhost:1234/v1", revision: 0 })
    expect(response.status).toBe(200)
    expect(yield* response.json).toMatchObject({
      vendors: expect.arrayContaining([expect.objectContaining({ id: "custom", baseURL: "http://localhost:1234/v1" })]),
    })
    const preserved = yield* request({ name: "Renamed", revision: 1 })
    expect(preserved.status).toBe(200)
    expect(yield* preserved.json).toMatchObject({
      vendors: expect.arrayContaining([expect.objectContaining({ id: "custom", baseURL: "http://localhost:1234/v1" })]),
    })
    for (const baseURL of [
      "ftp://example.com",
      "https://secret@example.com",
      "https://example.com?q=secret",
      "https://example.com#fragment",
    ]) {
      const invalid = yield* request({ baseURL, revision: 2 })
      expect(invalid.status).toBe(400)
    }
  }),
)
