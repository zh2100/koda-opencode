export * as ImageGeneration from "./image-generation"

import { Effect, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/unstable/http"
import { apiForProvider, type Api } from "@opencode-ai/schema/image-generation"
import { collectBoundedResponseBody } from "./tool/http-body"

export { apiForProvider }
export type Protocol = Api

export const name = "image_generation"
export const description = `Generate one image from a detailed text prompt using the user's independently configured image model. The conversation model is not changed. Use only when the user requests an image. This may incur charges. Do not retry a failed generation automatically, probe models, or substitute another model. If unconfigured or unsupported, explain the error and ask the user to configure an image model in Settings > Models.`
export const Input = Schema.Struct({
  prompt: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32000)).annotate({
    description: "A detailed description of the image requested by the user",
  }),
})
export const Output = Schema.Struct({
  model: Schema.String,
  images: Schema.Array(Schema.Struct({ data: Schema.String, mime: Schema.String })),
})
export class Error extends Schema.TaggedErrorClass<Error>()("ImageGeneration.Error", { message: Schema.String }) {}

export type Target = {
  model: string
  baseURL: string
  headers: Record<string, string>
  api?: Protocol
}

const ImageItem = Schema.Struct({
  b64_json: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
})
const ResponseBody = Schema.Struct({
  data: Schema.Array(ImageItem),
})
const GeminiPart = Schema.Struct({
  inlineData: Schema.optional(
    Schema.Struct({ mimeType: Schema.optional(Schema.String), data: Schema.optional(Schema.String) }),
  ),
  inline_data: Schema.optional(
    Schema.Struct({ mime_type: Schema.optional(Schema.String), data: Schema.optional(Schema.String) }),
  ),
})
const GeminiBody = Schema.Struct({
  candidates: Schema.optional(
    Schema.Array(
      Schema.Struct({
        content: Schema.optional(Schema.Struct({ parts: Schema.optional(Schema.Array(GeminiPart)) })),
      }),
    ),
  ),
})
const DashScopeBody = Schema.Struct({
  output: Schema.optional(
    Schema.Struct({
      choices: Schema.optional(
        Schema.Array(
          Schema.Struct({
            message: Schema.optional(Schema.Struct({ content: Schema.optional(Schema.Array(Schema.Unknown)) })),
          }),
        ),
      ),
    }),
  ),
})
const ChatImage = Schema.Struct({
  type: Schema.optional(Schema.String),
  image_url: Schema.optional(Schema.Union([Schema.String, Schema.Struct({ url: Schema.optional(Schema.String) })])),
  b64_json: Schema.optional(Schema.String),
})
const ChatBody = Schema.Struct({
  choices: Schema.optional(
    Schema.Array(
      Schema.Struct({
        message: Schema.optional(
          Schema.Struct({
            content: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.Unknown)])),
            images: Schema.optional(Schema.Array(Schema.Unknown)),
          }),
        ),
      }),
    ),
  ),
  data: Schema.optional(Schema.Array(ImageItem)),
})
const MAX_BYTES = 32 * 1024 * 1024
const bodyIdle = {
  duration: "120 seconds",
  onTimeout: () =>
    new Error({
      message:
        "Image response timed out after 120 seconds without data. Check the provider before retrying; the request may have incurred charges. No retry was attempted.",
    }),
} as const

const post = (http: HttpClient.HttpClient, url: string, headers: Record<string, string>, body: unknown) =>
  http
    .execute(
      HttpClientRequest.post(url).pipe(HttpClientRequest.setHeaders(headers), HttpClientRequest.bodyJsonUnsafe(body)),
    )
    .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }))

/** Never pass provider credentials to the image URL returned by an upstream service. */
export const generate = Effect.fn("ImageGeneration.generate")(
  function* (target: Target, input: typeof Input.Type) {
    const http = yield* HttpClient.HttpClient
    const protocol = target.api ?? "openai-images"
    if (protocol === "google-gemini") return yield* gemini(http, target, input.prompt)
    if (protocol === "alibaba-dashscope") return yield* dashscope(http, target, input.prompt)
    if (protocol === "openai-chat") return yield* chat(http, target, input.prompt)
    const imagesURL = yield* url(target.baseURL)
    const native = /api\.openai\.com/i.test(imagesURL) && /gpt-image/i.test(target.model)
    const images = yield* post(http, imagesURL, target.headers, {
      model: target.model,
      prompt: input.prompt,
      n: 1,
      ...(native ? {} : { response_format: "b64_json" }),
    })
    return { model: target.model, images: yield* openAIImages(images, protocol) }
  },
  Effect.timeoutOrElse({
    // Multi-megabyte base64 responses can take several minutes on slow connections.
    duration: "10 minutes",
    orElse: () =>
      Effect.fail(
        new Error({
          message:
            "Image generation timed out after 10 minutes. Check the provider before retrying; the request may have incurred charges. No retry was attempted.",
        }),
      ),
  }),
  Effect.mapError((error) =>
    error instanceof Error
      ? error
      : new Error({ message: "Image request failed. Check the provider before retrying; no fallback was attempted." }),
  ),
)

function openAIImages(images: HttpClientResponse.HttpClientResponse, protocol: string) {
  return Effect.gen(function*(){
    if (images.status < 200 || images.status >= 300) return yield* failed(images.status, protocol)
    const bytes = yield* collectBoundedResponseBody(
      images,
      MAX_BYTES,
      () => new globalThis.Error("Image response too large"),
      bodyIdle,
    )
    const body = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ResponseBody))(
      new TextDecoder().decode(bytes),
    ).pipe(
      Effect.mapError(
        () =>
          new Error({
            message: "Image provider returned an unsupported response; expected an OpenAI Images data array.",
          }),
      ),
    )
    return yield* imageItems(body.data)
  })
}

export function endpoint(baseURL: string, kind: "images" | "chat" | "gemini" | "dashscope" = "images", model?: string) {
  const parsed = new URL(baseURL)
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  )
    throw new globalThis.Error("Invalid base URL")
  const root = parsed.pathname.replace(/\/+$/, "")
  const path =
    kind === "chat"
      ? "chat/completions"
      : kind === "gemini"
        ? `models/${encodeURIComponent(model ?? "")}:generateContent`
        : kind === "dashscope"
          ? "services/aigc/multimodal-generation/generation"
          : "images/generations"
  parsed.pathname = `${root}/${path}`
  return parsed.toString()
}

const url = (baseURL: string, kind: "images" | "chat" | "gemini" | "dashscope" = "images", model?: string) =>
  Effect.try({
    try: () => endpoint(baseURL, kind, model),
    catch: () =>
      new Error({
        message: "Invalid image provider URL. Configure an HTTP(S) API base URL without a query or credentials.",
      }),
  })

const failed = (status: number, protocol: string) =>
  new Error({
    message: `Image generation failed for protocol ${protocol} (HTTP ${status}). Check the configured image API. No other protocol was attempted.`,
  })

function gemini(http: HttpClient.HttpClient, target: Target, prompt: string) {
  return Effect.gen(function* () {
    const response = yield* post(http, yield* url(target.baseURL, "gemini", target.model), target.headers, {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ["IMAGE"] },
    })
    if (response.status < 200 || response.status >= 300) return yield* failed(response.status, "google-gemini")
    const bytes = yield* collectBoundedResponseBody(
      response,
      MAX_BYTES,
      () => new globalThis.Error("Image response too large"),
      bodyIdle,
    )
    const body = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(GeminiBody))(
      new TextDecoder().decode(bytes),
    ).pipe(Effect.mapError(() => new Error({ message: "Image provider returned an unsupported Gemini response." })))
    const images = (body.candidates?.[0]?.content?.parts ?? []).flatMap((part) => {
      const data = part.inlineData?.data ?? part.inline_data?.data
      return data ? [{ data, mime: part.inlineData?.mimeType ?? part.inline_data?.mime_type }] : []
    })
    if (images.length !== 1)
      return yield* new Error({ message: "Gemini returned no inline base64 image. URL responses are not fetched." })
    return { model: target.model, images: yield* Effect.forEach(images, (image) => decodeItem(image.data, image.mime)) }
  })
}

function dashscope(http: HttpClient.HttpClient, target: Target, prompt: string) {
  return Effect.gen(function* () {
    const response = yield* post(http, yield* url(target.baseURL, "dashscope"), target.headers, {
      model: target.model,
      input: { messages: [{ role: "user", content: [{ text: prompt }] }] },
      parameters: { n: 1, watermark: false },
    })
    if (response.status < 200 || response.status >= 300) return yield* failed(response.status, "alibaba-dashscope")
    const bytes = yield* collectBoundedResponseBody(
      response,
      MAX_BYTES,
      () => new globalThis.Error("Image response too large"),
      bodyIdle,
    )
    const body = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(DashScopeBody))(
      new TextDecoder().decode(bytes),
    ).pipe(Effect.mapError(() => new Error({ message: "Image provider returned an unsupported DashScope response." })))
    const images = (body.output?.choices?.[0]?.message?.content ?? []).flatMap((part) => {
      const item = Schema.decodeUnknownOption(Schema.Struct({ image: Schema.optional(Schema.String) }))(part)
      const value = item._tag === "Some" ? item.value.image : undefined
      const match = value?.match(dataUrl)
      return match ? [match] : []
    })
    if (images.length !== 1)
      return yield* new Error({ message: "DashScope returned no inline base64 image. URL responses are not fetched." })
    return { model: target.model, images: yield* Effect.forEach(images, (match) => decodeItem(match[2], match[1])) }
  })
}

function chat(http: HttpClient.HttpClient, target: Target, prompt: string) {
  return Effect.gen(function* () {
    const response = yield* post(http, yield* url(target.baseURL, "chat"), target.headers, {
      model: target.model,
      messages: [{ role: "user", content: prompt }],
      stream: false,
    })
    if (response.status < 200 || response.status >= 300) return yield* failed(response.status, "openai-chat")
    const bytes = yield* collectBoundedResponseBody(
      response,
      MAX_BYTES,
      () => new globalThis.Error("Image response too large"),
      bodyIdle,
    )
    return { model: target.model, images: yield* chatImages(new TextDecoder().decode(bytes)) }
  })
}

function imageItems(data: ReadonlyArray<{ b64_json?: string; url?: string }>) {
  return Effect.gen(function* () {
    if (data.length !== 1)
      return yield* new Error({ message: "Image provider returned no image or an unexpected number of images." })
    return yield* Effect.forEach(data, (item) => decodeItem(item.b64_json))
  })
}

function decodeItem(base64: string | undefined, mime?: string) {
  if (base64 !== undefined)
    return Effect.try({
      try: () => {
        const image = decodeImage(base64)
        if (mime && image.mime !== mime.replace("image/jpg", "image/jpeg"))
          throw new globalThis.Error("Image MIME mismatch")
        return image
      },
      catch: () => new Error({ message: "Image provider returned invalid or unsupported image data." }),
    })
  // Do not fetch upstream-controlled URLs with the server's network authority.
  return Effect.fail(
    new Error({
      message:
        "Image provider returned no base64 image data. This image API requires b64_json responses; URL-only responses are not supported. No retry was attempted.",
    }),
  )
}

const dataUrl = /data:(image\/(?:png|jpeg|jpg|webp));base64,([A-Za-z0-9+/=]+)/

function chatImages(text: string) {
  return Effect.gen(function* () {
    const body = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ChatBody))(text).pipe(
      Effect.mapError(() => new Error({ message: "Image provider returned an unsupported chat response." })),
    )
    if (body.data) return yield* imageItems(body.data)
    const message = body.choices?.[0]?.message
    const parts = [...(Array.isArray(message?.content) ? message.content : []), ...(message?.images ?? [])]
    const embedded = parts.flatMap((part) => {
      const image = Schema.decodeUnknownOption(ChatImage)(part)
      if (image._tag === "None") return []
      const raw = typeof image.value.image_url === "string" ? image.value.image_url : image.value.image_url?.url
      const match = raw?.match(dataUrl)
      return [
        ...(image.value.b64_json ? [{ data: image.value.b64_json, mime: undefined }] : []),
        ...(match ? [{ data: match[2], mime: match[1] }] : []),
      ]
    })
    const markdown =
      typeof message?.content === "string"
        ? [...message.content.matchAll(new RegExp(dataUrl, "g"))].map((item) => ({ data: item[2], mime: item[1] }))
        : []
    const found = embedded.length ? embedded : markdown
    if (found.length !== 1)
      return yield* new Error({ message: "Image provider returned no base64 image in the chat response." })
    return yield* Effect.forEach(found, (image) => decodeItem(image.data, image.mime))
  })
}

export function decodeImage(data: string) {
  // Avoid a repeated-group regexp on multi-megabyte payloads (regexp stack exhaustion).
  if (!data || data.length > MAX_BYTES || data.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(data))
    throw new globalThis.Error("Invalid base64 image")
  const bytes = Buffer.from(data, "base64")
  if (bytes.toString("base64") !== data) throw new globalThis.Error("Invalid base64 image")
  const mime = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ? "image/png"
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      ? "image/jpeg"
      : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP"
        ? "image/webp"
        : undefined
  if (!mime) throw new globalThis.Error("Unsupported image format")
  return { data, mime }
}

/** Validate at the publication boundary, including results from replacement tools. Keep the original pixels. */
export const verifyReceipt = Effect.fn("ImageGeneration.verifyReceipt")(
  function* (data: string, mime: string | undefined) {
    const inspected = yield* Effect.tryPromise(async () => {
      if (decodeImage(data).mime !== mime) return false
      const { imageSize } = await import("image-size")
      const dimensions = imageSize(Buffer.from(data, "base64"))
      return !!dimensions.width && !!dimensions.height && dimensions.width * dimensions.height <= 16_777_216
    }).pipe(Effect.orElseSucceed(() => false))
    if (!inspected || !mime) return false
    const adapter = yield* Effect.tryPromise(() => import("./image/photon"))
    const normalize = yield* adapter.make
    yield* normalize(
      "generated-image",
      { content: data, uri: "generated-image", mime, encoding: "base64" },
      {
        autoResize: false,
        maxWidth: 16384,
        maxHeight: 16384,
        maxBase64Bytes: MAX_BYTES,
      },
    )
    return true
  },
  Effect.orElseSucceed(() => false),
)
