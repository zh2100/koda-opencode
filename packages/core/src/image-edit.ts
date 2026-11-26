export * as ImageEdit from "./image-edit"

import { Effect, Schema } from "effect"
import { FetchHttpClient, Headers, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { MaxImageChars } from "@opencode-ai/schema/image-edit"
import { ImageGeneration } from "./image-generation"
import { collectBoundedResponseBody } from "./tool/http-body"

export class InvalidImage extends Schema.TaggedErrorClass<InvalidImage>()("ImageEdit.InvalidImage", {
  field: Schema.Literals(["image", "mask"]),
}) {}

export class InvalidTarget extends Schema.TaggedErrorClass<InvalidTarget>()("ImageEdit.InvalidTarget", {}) {}

export class ProviderFailure extends Schema.TaggedErrorClass<ProviderFailure>()("ImageEdit.ProviderFailure", {
  reason: Schema.Literals(["request", "status", "response", "idle", "timeout"]),
  status: Schema.optional(Schema.Number),
}) {}

const Response = Schema.Struct({ data: Schema.Array(Schema.Struct({ b64_json: Schema.String })) })

export const validate = Effect.fn("ImageEdit.validate")(function* (input: { image: string; mask: string }) {
  const image = yield* png(input.image, "image")
  const mask = yield* png(input.mask, "mask")
  if (image.width !== mask.width || image.height !== mask.height) return yield* new InvalidImage({ field: "mask" })
  let selected = false
  for (let i = 3; i < mask.rgba.length; i += 4) {
    if (mask.rgba[i] === 0) selected = true
    if (mask.rgba[i] !== 0 && mask.rgba[i] !== 255) return yield* new InvalidImage({ field: "mask" })
  }
  if (!selected) return yield* new InvalidImage({ field: "mask" })
  return { image: image.bytes, mask: mask.bytes }
})

const png = Effect.fn("ImageEdit.png")(function* (data: string, field: InvalidImage["field"]) {
  const error = new InvalidImage({ field })
  const bytes = yield* Effect.try({
    try: () => {
      if (data.length > MaxImageChars || ImageGeneration.decodeImage(data).mime !== "image/png") throw error
      const bytes = Buffer.from(data, "base64")
      // Check IHDR before invoking the pixel decoder. Reject animation and orientation metadata:
      // the browser preview and provider must operate on the same raster in the same coordinates.
      if (bytes.length < 33 || bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR") throw error
      const width = bytes.readUInt32BE(16)
      const height = bytes.readUInt32BE(20)
      if (!width || !height || width > 8192 || height > 8192 || width * height > 16_777_216) throw error
      for (let offset = 8; offset + 12 <= bytes.length; ) {
        const type = bytes.toString("ascii", offset + 4, offset + 8)
        if (type === "acTL" || type === "eXIf") throw error
        const end = offset + bytes.readUInt32BE(offset) + 12
        if (end > bytes.length) throw error
        if (type === "IEND" && end === bytes.length) return bytes
        offset = end
      }
      throw error
    },
    catch: () => error,
  })
  const adapter = yield* Effect.tryPromise(() => import("./image/photon")).pipe(Effect.mapError(() => error))
  const pixels = yield* adapter.pixels(field, bytes).pipe(Effect.mapError(() => error))
  return { bytes, ...pixels }
})

export const endpoint = (baseURL: string) =>
  Effect.try({
    try: () => {
      const url = new URL(baseURL)
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
        throw new globalThis.Error("Invalid base URL")
      url.pathname = `${url.pathname.replace(/\/+$/, "")}/images/edits`
      return url.href
    },
    catch: () => new InvalidTarget(),
  })

// The caller must resolve and confirm an explicitly configured masked-edit target and claim the attempt before dispatch.
export const dispatch = Effect.fn("ImageEdit.dispatch")(
  function* (
    target: { url: string; model: string; headers: Record<string, string>; protocol: "openai-mask" },
    input: { image: Buffer<ArrayBuffer>; mask: Buffer<ArrayBuffer>; prompt: string },
  ) {
    const http = yield* HttpClient.HttpClient
    const form = new FormData()
    form.set("image", new Blob([input.image], { type: "image/png" }), "image.png")
    form.set("mask", new Blob([input.mask], { type: "image/png" }), "mask.png")
    form.set("model", target.model)
    form.set("prompt", input.prompt)
    form.set("n", "1")
    const headers = Headers.remove(Headers.remove(Headers.fromInput(target.headers), "content-type"), "content-length")
    const response = yield* http
      .execute(HttpClientRequest.post(target.url).pipe(HttpClientRequest.setHeaders(headers), HttpClientRequest.bodyFormData(form)))
      .pipe(
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
        Effect.mapError(() => new ProviderFailure({ reason: "request" })),
      )
    if (response.status < 200 || response.status >= 300)
      return yield* new ProviderFailure({ reason: "status", status: response.status })
    const bytes = yield* collectBoundedResponseBody(
      response,
      32 * 1024 * 1024,
      () => new ProviderFailure({ reason: "response" }),
      { duration: "120 seconds", onTimeout: () => new ProviderFailure({ reason: "idle" }) },
    ).pipe(Effect.mapError((error) => error instanceof ProviderFailure ? error : new ProviderFailure({ reason: "response" })))
    const body = Schema.decodeUnknownOption(Schema.fromJsonString(Response))(new TextDecoder().decode(bytes))
    if (body._tag === "None" || body.value.data.length !== 1) return yield* new ProviderFailure({ reason: "response" })
    const result = yield* Effect.try({
      try: () => ImageGeneration.decodeImage(body.value.data[0].b64_json),
      catch: () => new ProviderFailure({ reason: "response" }),
    })
    if (!(yield* ImageGeneration.verifyReceipt(result.data, result.mime))) return yield* new ProviderFailure({ reason: "response" })
    return result
  },
  Effect.timeoutOrElse({ duration: "10 minutes", orElse: () => Effect.fail(new ProviderFailure({ reason: "timeout" })) }),
)
