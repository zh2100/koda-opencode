import { MaskedImageEdit } from "@opencode-ai/core/masked-image-edit"
import { ImageEdit } from "@opencode-ai/protocol/groups/image-edit"
import { ConflictError, InvalidRequestError, ServiceUnavailableError } from "@opencode-ai/protocol/errors"
import { Effect, Schema, Stream } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(ImageEdit.Request))
const limit = ImageEdit.MaxImageChars * 2 + 256 * 1024
const empty: { size: number; chunk: Uint8Array } = { size: 0, chunk: new Uint8Array(0) }
const invalidBody = () => new InvalidRequestError({ message: "Invalid image edit request.", kind: "image-edit-body" })

export const ImageEditHandler = HttpApiBuilder.group(Api, "server.imageEdit", (handlers) => handlers
  .handle("imageEdit.target", () => Effect.gen(function* () {
    const editor = yield* MaskedImageEdit.Service
    return yield* editor.target()
  }))
  .handle("imageEdit.status", () => Effect.gen(function* () {
    const editor = yield* MaskedImageEdit.Service
    return yield* editor.status()
  }))
  .handleRaw("imageEdit.submit", Effect.fn(function* (ctx) {
    if (ctx.request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json")
      return yield* invalidBody()
    const body = yield* ctx.request.stream.pipe(
      Stream.scan(empty, (state, chunk) => ({ size: state.size + chunk.byteLength, chunk })),
      Stream.mapEffect((item) => item.size > limit ? Effect.fail(invalidBody()) : Effect.succeed(item.chunk)),
      Stream.mkUint8Array,
      Effect.mapError(invalidBody),
    )
    const input = decode(new TextDecoder().decode(body))
    if (input._tag === "None") return yield* invalidBody()
    const editor = yield* MaskedImageEdit.Service
    return yield* editor.edit(input.value).pipe(
      Effect.catchTags({
        "MaskedImageEdit.Rejected": (error) => {
          if (error.reason === "conflict" || error.reason === "unknown")
            return Effect.fail(new ConflictError({ message: "Image edit could not be reconciled; no new request was sent.", resource: error.reason }))
          return Effect.fail(new InvalidRequestError({ message: "Image edit rejected before dispatch.", kind: `image-edit-${error.reason}` }))
        },
        "ImageEdit.InvalidImage": (error) => Effect.fail(new InvalidRequestError({ message: "Invalid PNG or mask.", kind: `image-edit-${error.field}` })),
        "ImageEdit.ProviderFailure": (error) => Effect.fail(new ServiceUnavailableError({ message: "Image provider did not return a verified result. No retry was attempted.", service: error.reason })),
      }),
    )
  })))
