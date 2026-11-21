import { expect } from "bun:test"
import { Effect, Schema } from "effect"
import { Relay } from "@opencode-ai/schema/relay"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer } from "./httpapi-layer"

const it = testEffect(httpApiLayer)

it.live("relay vendor payload validates and persists independent baseURL", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped({ config: { plugin: [], lsp: false, formatter: false } })
    const state = yield* HttpClientRequest.get("/api/relay/auth").pipe(
      HttpClient.execute,
      Effect.flatMap((response) => response.text),
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Relay.AuthState))),
    )
    const request = (payload: unknown) =>
      HttpClientRequest.put("/api/relay/auth/vendors/custom").pipe(
        HttpClientRequest.setHeader("x-opencode-directory", directory),
        HttpClientRequest.bodyJsonUnsafe(payload),
        HttpClient.execute,
      )
    const response = yield* request({ name: "Custom", baseURL: "http://localhost:1234/v1", revision: state.revision })
    expect(response.status).toBe(200)
    expect(yield* response.json).toMatchObject({
      vendors: expect.arrayContaining([expect.objectContaining({ id: "custom", baseURL: "http://localhost:1234/v1" })]),
    })
    const preserved = yield* request({ name: "Renamed", revision: state.revision + 1 })
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
      const invalid = yield* request({ baseURL, revision: state.revision + 2 })
      expect(invalid.status).toBe(400)
    }
  }),
)
