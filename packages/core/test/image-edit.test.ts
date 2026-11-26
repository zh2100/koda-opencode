import { expect } from "bun:test"
import { Effect, Fiber, Latch, Layer, Stream } from "effect"
import { TestClock } from "effect/testing"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { ImageEdit } from "@opencode-ai/core/image-edit"
import { it } from "./lib/effect"

const result = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGOoDrD5Xx1gwwAAD8gDDo+nAZMAAAAASUVORK5CYII="
const mask = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGOoDrBhqA6w+Q8AC8wDDvid+YgAAAAASUVORK5CYII="
const target = { url: "http://image.test/v1/images/edits", model: "fixture", headers: {}, protocol: "openai-mask" } as const

for (const mode of ["idle", "success", "timeout"] as const) {
  it.effect(`masked edit response: ${mode}`, () =>
    Effect.gen(function* () {
      const sent: string[] = []
      const reading = yield* Latch.make(false)
      const response = JSON.stringify({ data: [{ b64_json: result }] })
      const stream = mode === "idle"
        ? Stream.make(new TextEncoder().encode("{")).pipe(
            Stream.concat(Stream.fromEffect(reading.open.pipe(Effect.andThen(Effect.never)))),
          )
        : Stream.fromIterable(mode === "success" ? response.match(/.{1,32}/g) ?? [] : Array(20).fill(" ")).pipe(
            Stream.mapEffect((chunk) => Effect.sleep("60 seconds").pipe(Effect.as(new TextEncoder().encode(chunk)))),
          )
      const http = HttpClient.make((request) => Effect.sync(() => {
        sent.push(request.url)
        const response = HttpClientResponse.fromWeb(request, new Response())
        return { ...response, headers: response.headers, cookies: response.cookies, stream }
      }))
      const fiber = yield* ImageEdit.dispatch(target, {
        image: Buffer.from(result, "base64"), mask: Buffer.from(mask, "base64"), prompt: "fixture",
      }).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient, http)), Effect.result, Effect.forkChild)
      if (mode === "idle") yield* reading.await
      yield* TestClock.adjust(mode === "idle" ? "119 seconds" : mode === "success" ? "240 seconds" : "599 seconds")
      expect(fiber.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust(mode === "success" ? "60 seconds" : "1 second")
      const receipt = yield* Fiber.join(fiber)
      if (mode === "success") expect(receipt).toMatchObject({ _tag: "Success", success: { data: result, mime: "image/png" } })
      if (mode !== "success") expect(receipt).toMatchObject({ _tag: "Failure", failure: { reason: mode } })
      expect(sent).toEqual([target.url])
    }),
  )
}
