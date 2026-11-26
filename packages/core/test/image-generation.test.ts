import { describe, expect, test } from "bun:test"
import { Cause, Duration, Effect, Exit, Fiber, Layer, Stream } from "effect"
import { TestClock } from "effect/testing"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { ImageGeneration } from "@opencode-ai/core/image-generation"
import { ImageGenerationSettings } from "@opencode-ai/core/image-generation-settings"
import { testEffect } from "./lib/effect"

const png = "iVBORw0KGgo="

function http(body: unknown, status = 200, requests: HttpClientRequest.HttpClientRequest[] = []) {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
      Effect.sync(() => {
        requests.push(request)
        return HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body), { status }))
      }),
    ),
  )
}

const it = testEffect(Layer.empty)

describe("ImageGeneration", () => {
  test("selects OpenAI Images automatically for Grok image models", () => {
    expect(ImageGeneration.apiForProvider({ npm: "@ai-sdk/openai-compatible", modelID: "grok-imagine-image" })).toBe(
      "openai-images",
    )
    expect(
      ImageGeneration.apiForProvider({ npm: "@ai-sdk/openai-compatible", modelID: "grok-imagine-image-2.0" }),
    ).toBe("openai-images")
    expect(ImageGeneration.apiForProvider({ npm: "@ai-sdk/openai-compatible", modelID: "gpt-image-1" })).toBe(
      "openai-images",
    )
    expect(ImageGeneration.apiForProvider({ npm: "@ai-sdk/openai-compatible", modelID: "dall-e-3" })).toBe(
      "openai-images",
    )
    expect(ImageGeneration.apiForProvider({ npm: "@ai-sdk/google", modelID: "gemini-2.5-flash-image" })).toBe(
      "google-gemini",
    )
    expect(ImageGeneration.apiForProvider({ npm: "@ai-sdk/google", modelID: "gemini-2.5-flash" })).toBe("google-gemini")
    expect(ImageGeneration.apiForProvider({ npm: "@ai-sdk/openai-compatible", modelID: "vendor-image" })).toBe(
      "openai-chat",
    )
  })

  test("recognizes only supported image magic bytes", () => {
    expect(ImageGeneration.decodeImage(png)).toEqual({ data: png, mime: "image/png" })
    expect(ImageGeneration.decodeImage(Buffer.from([255, 216, 255]).toString("base64")).mime).toBe("image/jpeg")
    expect(ImageGeneration.decodeImage(Buffer.from("RIFF0000WEBP").toString("base64")).mime).toBe("image/webp")
    expect(() => ImageGeneration.decodeImage(Buffer.from("GIF89a").toString("base64"))).toThrow()
    expect(() => ImageGeneration.decodeImage(Buffer.from("not an image").toString("base64"))).toThrow()
  })

  test("validates large base64 without regexp stack exhaustion and rejects non-canonical padding", () => {
    const data = Buffer.concat([Buffer.from(png, "base64"), Buffer.alloc(1024 * 1024)]).toString("base64")
    expect(ImageGeneration.decodeImage(data).mime).toBe("image/png")
    expect(() => ImageGeneration.decodeImage("iVBORw0KGgp=")).toThrow()
    expect(() => ImageGeneration.decodeImage(`${png}====`)).toThrow()
  })

  test("rejects unsafe endpoint shapes", () => {
    expect(ImageGeneration.endpoint("http://127.0.0.1/v1/")).toBe("http://127.0.0.1/v1/images/generations")
    expect(ImageGeneration.endpoint("http://127.0.0.1/v1/", "chat")).toBe("http://127.0.0.1/v1/chat/completions")
    expect(ImageGeneration.endpoint("https://generativelanguage.googleapis.com/v1beta", "gemini", "gemini/image")).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini%2Fimage:generateContent",
    )
    expect(ImageGeneration.endpoint("https://dashscope.aliyuncs.com/api/v1", "dashscope")).toBe(
      "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
    )
    for (const url of [
      "file:///tmp/image",
      "https://key:secret@example.test/v1",
      "https://example.test/v1?key=test",
      "https://example.test/v1#fragment",
    ])
      expect(() => ImageGeneration.endpoint(url)).toThrow()
  })

  it.effect("fails the selected images protocol when the images route is missing", () => {
    const requests: HttpClientRequest.HttpClientRequest[] = []
    return Effect.gen(function* () {
      const failed = yield* ImageGeneration.generate(
        {
          model: "grok-imagine-image",
          api: "openai-images",
          baseURL: "http://image.test/v1",
          headers: { Authorization: "Bearer test" },
        },
        { prompt: "a local test image" },
      ).pipe(Effect.exit)
      expect(Exit.isFailure(failed)).toBe(true)
      if (Exit.isFailure(failed)) {
        const error = Cause.squash(failed.cause)
        expect(error).toBeInstanceOf(ImageGeneration.Error)
        expect(String(error)).toContain("openai-images")
        expect(String(error)).not.toContain("Bearer test")
        expect(String(error)).not.toContain("missing")
      }
      expect(requests.map((request) => request.url)).toEqual(["http://image.test/v1/images/generations"])
    }).pipe(
      Effect.provide(
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.sync(() => {
              requests.push(request)
              const missing = request.url.endsWith("/images/generations")
              return HttpClientResponse.fromWeb(
                request,
                missing
                  ? new Response("missing", { status: 404 })
                  : Response.json({
                      choices: [
                        {
                          message: {
                            content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${png}` } }],
                          },
                        },
                      ],
                    }),
              )
            }),
          ),
        ),
      ),
    )
  })

  it.effect("does not call chat completions when the images route returns another error", () => {
    const requests: string[] = []
    return ImageGeneration.generate(
      { model: "grok-imagine-image", baseURL: "http://image.test/v1", headers: { Authorization: "Bearer test" } },
      { prompt: "a local test image" },
    ).pipe(
      Effect.provide(
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.sync(() => {
              requests.push(request.url)
              return HttpClientResponse.fromWeb(request, new Response("{}", { status: 429 }))
            }),
          ),
        ),
      ),
      Effect.flip,
      Effect.tap((error) =>
        Effect.sync(() => {
          expect(error.message).toContain("HTTP 429")
          expect(error.message).toContain("openai-images")
          expect(requests).toEqual(["http://image.test/v1/images/generations"])
        }),
      ),
    )
  })

  it.effect("uses the Gemini generateContent protocol and inline image data", () => {
    const requests: HttpClientRequest.HttpClientRequest[] = []
    return ImageGeneration.generate(
      {
        model: "gemini-image",
        api: "google-gemini",
        baseURL: "https://generativelanguage.googleapis.com/v1beta",
        headers: { "x-goog-api-key": "test" },
      },
      { prompt: "a local test image" },
    ).pipe(
      Effect.provide(
        http(
          { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: png } }] } }] },
          200,
          requests,
        ),
      ),
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result).toEqual({ model: "gemini-image", images: [{ data: png, mime: "image/png" }] })
          expect(requests.map((request) => request.url)).toEqual([
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-image:generateContent",
          ])
          const request = requests[0]
          if (request?.body._tag !== "Uint8Array") throw new Error("Expected JSON request body")
          expect(JSON.parse(new TextDecoder().decode(request.body.body))).toEqual({
            contents: [{ role: "user", parts: [{ text: "a local test image" }] }],
            generationConfig: { responseModalities: ["IMAGE"] },
          })
        }),
      ),
    )
  })

  it.effect("uses the DashScope protocol and rejects URL-only image data", () => {
    const requests: HttpClientRequest.HttpClientRequest[] = []
    return ImageGeneration.generate(
      {
        model: "qwen-image",
        api: "alibaba-dashscope",
        baseURL: "https://dashscope.aliyuncs.com/api/v1",
        headers: { Authorization: "Bearer test" },
      },
      { prompt: "a local test image" },
    ).pipe(
      Effect.provide(
        http(
          { output: { choices: [{ message: { content: [{ image: "https://upstream.test/image.png" }] } }] } },
          200,
          requests,
        ),
      ),
      Effect.flip,
      Effect.tap((error) =>
        Effect.sync(() => {
          expect(error.message).toContain("no inline base64 image")
          expect(requests).toHaveLength(1)
          expect(requests[0]?.url).toBe(
            "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
          )
        }),
      ),
    )
  })

  it.effect("uses chat completions directly when that protocol is selected", () => {
    const requests: HttpClientRequest.HttpClientRequest[] = []
    return ImageGeneration.generate(
      {
        model: "relay-image",
        api: "openai-chat",
        baseURL: "http://image.test/v1",
        headers: { Authorization: "Bearer test" },
      },
      { prompt: "a local test image" },
    ).pipe(
      Effect.provide(
        http(
          {
            choices: [
              { message: { content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${png}` } }] } },
            ],
          },
          200,
          requests,
        ),
      ),
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.images).toEqual([{ data: png, mime: "image/png" }])
          expect(requests.map((request) => request.url)).toEqual(["http://image.test/v1/chat/completions"])
        }),
      ),
    )
  })

  it.effect("sends one local base64 request and returns an attachment", () =>
    Effect.gen(function* () {
      const result = yield* ImageGeneration.generate(
        { model: "local-image", baseURL: "http://image.test/v1", headers: { Authorization: "Bearer test" } },
        { prompt: "a local test image" },
      )
      expect(result).toEqual({ model: "local-image", images: [{ data: png, mime: "image/png" }] })
    }).pipe(Effect.provide(http({ data: [{ b64_json: png }] }))),
  )

  it.effect("rejects URL-only responses without making a second request", () => {
    const requests: HttpClientRequest.HttpClientRequest[] = []
    return ImageGeneration.generate(
      { model: "local-image", baseURL: "http://image.test/v1", headers: { Authorization: "Bearer test" } },
      { prompt: "a local test image" },
    ).pipe(
      Effect.provide(http({ data: [{ url: "https://upstream.test/image.png" }] }, 200, requests)),
      Effect.flip,
      Effect.tap((error) =>
        Effect.sync(() => {
          expect(error.message).toBe(
            "Image provider returned no base64 image data. This image API requires b64_json responses; URL-only responses are not supported. No retry was attempted.",
          )
          expect(requests).toHaveLength(1)
          expect(requests[0]?.url).toBe("http://image.test/v1/images/generations")
        }),
      ),
    )
  })

  it.effect("sends the selected model once and never retries HTTP errors", () => {
    const requests: HttpClientRequest.HttpClientRequest[] = []
    return ImageGeneration.generate(
      { model: "explicit-image", baseURL: "http://image.test/v1", headers: { Authorization: "Bearer test" } },
      { prompt: "test prompt" },
    ).pipe(
      Effect.provide(http({}, 429, requests)),
      Effect.flip,
      Effect.tap((error) =>
        Effect.sync(() => {
          expect(error.message).toContain("HTTP 429")
          expect(requests).toHaveLength(1)
          const request = requests[0]
          expect(request?.headers.authorization).toBe("Bearer test")
          if (request?.body._tag !== "Uint8Array") throw new Error("Expected JSON request body")
          expect(JSON.parse(new TextDecoder().decode(request.body.body))).toEqual({
            model: "explicit-image",
            prompt: "test prompt",
            n: 1,
            response_format: "b64_json",
          })
        }),
      ),
    )
  })

  it.effect("does not expose an upstream error body or credentials", () => {
    const requests: HttpClientRequest.HttpClientRequest[] = []
    return ImageGeneration.generate(
      { model: "local-image", baseURL: "http://image.test/v1", headers: { Authorization: "Bearer private-key" } },
      { prompt: "private prompt" },
    ).pipe(
      Effect.provide(http({ error: "private-key private prompt https://private.test" }, 500, requests)),
      Effect.flip,
      Effect.tap((error) =>
        Effect.sync(() => {
          expect(error.message).toContain("HTTP 500")
          expect(error.message).not.toContain("private")
          expect(requests).toHaveLength(1)
        }),
      ),
    )
  })

  for (const body of [
    "not json",
    JSON.stringify({ data: [{ b64_json: "not base64" }] }),
    JSON.stringify({ data: [{ b64_json: png }, { b64_json: png }] }),
    JSON.stringify({ data: [] }),
    JSON.stringify({ data: [{ b64_json: Buffer.from("<svg/>").toString("base64") }] }),
  ]) {
    it.effect(`rejects malformed or unsupported response: ${body}`, () => {
      const requests: string[] = []
      return ImageGeneration.generate(
        { model: "local-image", baseURL: "http://image.test/v1", headers: {} },
        { prompt: "test" },
      ).pipe(
        Effect.provide(
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.sync(() => {
                requests.push(request.url)
                return HttpClientResponse.fromWeb(request, new Response(body))
              }),
            ),
          ),
        ),
        Effect.flip,
        Effect.tap((error) =>
          Effect.sync(() => {
            expect(error).toBeInstanceOf(ImageGeneration.Error)
            expect(requests).toHaveLength(1)
          }),
        ),
      )
    })
  }

  for (const declared of [true, false]) {
    it.effect(`rejects oversized responses ${declared ? "with" : "without"} Content-Length`, () => {
      const requests: string[] = []
      return ImageGeneration.generate(
        { model: "local-image", baseURL: "http://image.test/v1", headers: {} },
        { prompt: "test" },
      ).pipe(
        Effect.provide(
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.sync(() => {
                requests.push(request.url)
                return HttpClientResponse.fromWeb(
                  request,
                  new Response(declared ? "" : new Uint8Array(32 * 1024 * 1024 + 1), {
                    headers: declared ? { "content-length": String(32 * 1024 * 1024 + 1) } : {},
                  }),
                )
              }),
            ),
          ),
        ),
        Effect.flip,
        Effect.tap((error) =>
          Effect.sync(() => {
            expect(error).toBeInstanceOf(ImageGeneration.Error)
            expect(requests).toHaveLength(1)
          }),
        ),
      )
    })
  }

  it.effect("times out a stalled request without retrying", () =>
    Effect.gen(function* () {
      const requests: string[] = []
      const layer = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => Effect.sync(() => requests.push(request.url)).pipe(Effect.andThen(Effect.never))),
      )
      const fiber = yield* ImageGeneration.generate(
        { model: "local-image", baseURL: "http://image.test/v1", headers: {} },
        { prompt: "test" },
      ).pipe(Effect.provide(layer), Effect.flip, Effect.forkChild)
      yield* TestClock.adjust(Duration.minutes(10))
      expect((yield* Fiber.join(fiber)).message).toContain("timed out")
      expect(requests).toHaveLength(1)
    }),
  )

  it.effect("does not cut off a progressing image response at 240 seconds", () =>
    Effect.gen(function* () {
      const requests: string[] = []
      const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
      const layer = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            requests.push(request.url)
            const response = HttpClientResponse.fromWeb(request, Response.json({}))
            return {
              ...response,
              headers: response.headers,
              cookies: response.cookies,
              stream: Stream.fromIterable(['{"data":[', '{"b64_json":"', pixel, '"}', "]}"]).pipe(
                Stream.mapEffect((part) => Effect.sleep("60 seconds").pipe(Effect.as(new TextEncoder().encode(part)))),
              ),
            }
          }),
        ),
      )
      const fiber = yield* ImageGeneration.generate(
        { model: "local-image", baseURL: "http://image.test/v1", headers: {} },
        { prompt: "test" },
      ).pipe(Effect.provide(layer), Effect.forkChild)
      yield* TestClock.adjust(Duration.seconds(240))
      expect(requests).toHaveLength(1)
      yield* TestClock.adjust(Duration.minutes(1))
      const result = yield* Fiber.join(fiber)
      expect(result.images).toEqual([{ data: pixel, mime: "image/png" }])
      expect(yield* ImageGeneration.verifyReceipt(result.images[0].data, result.images[0].mime)).toBe(true)
      expect(requests).toHaveLength(1)
    }),
  )

  for (const partial of [false, true]) {
    it.effect(
      `times out an idle image body ${partial ? "after a chunk" : "before the first chunk"} without retrying`,
      () =>
        Effect.gen(function* () {
          const requests: string[] = []
          const layer = Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.sync(() => {
                requests.push(request.url)
                const response = HttpClientResponse.fromWeb(request, Response.json({}))
                return {
                  ...response,
                  headers: response.headers,
                  cookies: response.cookies,
                  stream: partial
                    ? Stream.make(new TextEncoder().encode('{"data":[')).pipe(Stream.concat(Stream.never))
                    : Stream.never,
                }
              }),
            ),
          )
          const fiber = yield* ImageGeneration.generate(
            { model: "local-image", baseURL: "http://image.test/v1", headers: {} },
            { prompt: "test" },
          ).pipe(Effect.provide(layer), Effect.flip, Effect.forkChild)
          yield* TestClock.adjust(Duration.seconds(120))
          yield* TestClock.adjust(Duration.seconds(120))
          expect((yield* Fiber.join(fiber)).message).toContain("120 seconds without data")
          expect(requests).toHaveLength(1)
        }),
    )
  }

  it.effect("enforces the total deadline even while image bytes keep arriving", () =>
    Effect.gen(function* () {
      const layer = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            const response = HttpClientResponse.fromWeb(request, Response.json({}))
            return {
              ...response,
              headers: response.headers,
              cookies: response.cookies,
              stream: Stream.fromIterable(Array.from({ length: 20 }, () => new TextEncoder().encode(" "))).pipe(
                Stream.mapEffect((part) => Effect.sleep("60 seconds").pipe(Effect.as(part))),
              ),
            }
          }),
        ),
      )
      const fiber = yield* ImageGeneration.generate(
        { model: "local-image", baseURL: "http://image.test/v1", headers: {} },
        { prompt: "test" },
      ).pipe(Effect.provide(layer), Effect.flip, Effect.forkChild)
      yield* TestClock.adjust(Duration.minutes(10))
      expect((yield* Fiber.join(fiber)).message).toContain("after 10 minutes")
    }),
  )

  it.live("never follows redirects with provider credentials", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const requests: string[] = []
        const server = Bun.serve({
          port: 0,
          hostname: "127.0.0.1",
          fetch(request) {
            requests.push(new URL(request.url).pathname)
            return new Response(null, { status: 307, headers: { location: "/private" } })
          },
        })
        return { server, requests }
      }),
      ({ server, requests }) =>
        ImageGeneration.generate(
          { model: "local-image", baseURL: server.url.toString(), headers: { Authorization: "Bearer test" } },
          { prompt: "test" },
        ).pipe(
          Effect.provide(FetchHttpClient.layer),
          Effect.flip,
          Effect.tap(() => Effect.sync(() => expect(requests).toEqual(["/images/generations"]))),
        ),
      ({ server }) => Effect.promise(() => server.stop(true)),
    ),
  )

  test("patches JSONC without probing the configured model", () => {
    const source = '{\n  // Keep this comment\n  "model": "chat/model"\n}\n'
    const output = ImageGenerationSettings.patchDocument(source, {
      enabled: true,
      api: "openai-images",
      model: "image/provider-model",
    })
    expect(output).toContain("Keep this comment")
    expect(JSON.parse(output.replace("// Keep this comment\n", "")).image_generation).toEqual({
      enabled: true,
      api: "openai-images",
      model: "image/provider-model",
    })
  })
})
