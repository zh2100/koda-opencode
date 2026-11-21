export * as ImageGenerationSettings from "./image-generation-settings"

import path from "path"
import { isUtf8 } from "node:buffer"
import { ImageGeneration } from "@opencode-ai/schema/image-generation"
import { Cause, Context, Effect, Layer, Option, Schema } from "effect"
import { applyEdits, modify, parse, parseTree, type ParseError } from "jsonc-parser"
import { makeGlobalNode } from "./effect/app-node"
import { FSUtil } from "./fs-util"
import { Global } from "./global"
import { EffectFlock } from "./util/effect-flock"
import { SettledIO } from "./util/settled-io"
import { AtomicDocument } from "./config/atomic-document"
import { ConfigDocument } from "./config/document"

export class Error extends Schema.TaggedErrorClass<Error>()("ImageGenerationSettings.Error", {
  message: Schema.String,
  code: Schema.Literals(["alias", "conflict", "invalid", "unavailable", "unknown"]),
}) {}

export interface Interface {
  readonly get: () => Effect.Effect<ImageGeneration.Config, Error>
  readonly update: (config: ImageGeneration.Config) => Effect.Effect<ImageGeneration.Config, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ImageGenerationSettings") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const flock = yield* EffectFlock.Service
    const global = yield* Global.Service
    const files = ["config.json", "opencode.json", "opencode.jsonc"].map((name) => path.join(global.config, name))
    // readFileString's TextDecoder strips BOM, but publication compares the exact previous UTF-8 text.
    const readText = (file: string) => fs.readFile(file).pipe(Effect.map((bytes) => Buffer.from(bytes).toString("utf8")))
    const read = Effect.fnUntraced(function* () {
      return yield* Effect.forEach(files, (file) =>
        readText(file).pipe(
          Effect.map((text) => ({ file, text })),
          Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)),
        ),
      ).pipe(Effect.map((items) => items.filter((item) => item !== undefined)))
    })
    const get = Effect.fn("ImageGenerationSettings.get")(
      function* () {
        const documents = yield* read()
        return yield* Effect.try({
          try: () =>
            documents.reduce<ImageGeneration.Config>((config, item) => readSettings(item.text) ?? config, {}),
          catch: () => new Error({ code: "unavailable", message: "Could not read image generation settings." }),
        })
      },
      Effect.catch(() => Effect.fail(new Error({ code: "unavailable", message: "Could not read image generation settings." }))),
    )

    const update = (config: ImageGeneration.Config): Effect.Effect<ImageGeneration.Config, Error> =>
      Effect.gen(function* () {
        const discovered = yield* read().pipe(Effect.mapError(() => new Error({ code: "unavailable", message: "Could not read image generation settings." })))
        const file = discovered.at(-1)?.file ?? files[1]
        return yield* ConfigDocument.withLock(
          flock,
          file,
          Effect.gen(function* () {
            // Re-discover after the lease. A higher-priority file created while waiting is the save target.
            const current = yield* read().pipe(Effect.mapError(() => new Error({ code: "unavailable", message: "Could not read image generation settings." })))
            if ((current.at(-1)?.file ?? files[1]) !== file) {
              return yield* new Error({ code: "conflict", message: "Image generation settings target changed. Save again to the current file." })
            }
            const bytes = yield* fs.readFile(file).pipe(
              Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)),
              Effect.mapError(() => new Error({ code: "unavailable", message: "Could not read image generation settings." })),
            )
            if (bytes !== undefined && !isUtf8(bytes)) {
              return yield* new Error({ code: "invalid", message: "Configuration document is not valid UTF-8." })
            }
            const before = bytes === undefined ? undefined : Buffer.from(bytes).toString("utf8")
            const text = yield* Effect.try({
              try: () => {
                // get() must be able to read each lower-priority document before reaching the saved one.
                current.slice(0, -1).forEach((item) => readSettings(item.text))
                return patchDocument(before ?? "{}\n", config)
              },
              catch: () => new Error({ code: "invalid", message: "Invalid image generation settings or configuration document." }),
            })
            yield* Effect.tryPromise({
              try: () => AtomicDocument.publish({ file, before, text }),
              catch: (cause) => cause instanceof AtomicDocument.CommitError && cause.stage === "prepare"
                ? new Error({ code: "unavailable", message: "Could not save image generation settings. The existing configuration was not replaced." })
                : new Error({ code: "unknown", message: "Image generation settings publication requires reconciliation." }),
            }).pipe(SettledIO.drainWithCause, Effect.mapError((cause) => cause instanceof Error ? cause : new Error({ code: "unknown", message: "Image generation settings publication requires reconciliation." })))
            return config
          }),
        ).pipe(
          Effect.provideService(Global.Service, global),
          Effect.catchTag("ConfigDocumentAliasUnsupported", () => Effect.fail(new Error({ code: "alias", message: "Use the canonical configuration directory to save image generation settings." }))),
          Effect.mapError((error) => error instanceof Error ? error : new Error({ code: "unavailable", message: "Could not save image generation settings. The existing configuration was not replaced." })),
          Effect.catchCause((cause) => {
            if (Cause.hasInterrupts(cause)) return Effect.failCause(cause)
            const error = Cause.findErrorOption(cause)
            if (Option.isSome(error)) return Effect.fail(error.value)
            return Effect.fail(new Error({ code: "unknown", message: "Image generation settings publication requires reconciliation." }))
          }),
        )
      })
    return Service.of({ get, update })
  }),
)

function parseDocument(text: string) {
  const errors: ParseError[] = []
  const input: unknown = parse(text.replace(/^\uFEFF/, ""), errors, { allowTrailingComma: true })
  const document = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown))(input)
  if (errors.length || Option.isNone(document)) throw new globalThis.Error("Invalid configuration document")
  return document.value
}

function readSettings(text: string) {
  const settings = parseDocument(text).image_generation
  return settings === undefined ? undefined : Schema.decodeUnknownSync(ImageGeneration.Config)(settings)
}

export function patchDocument(text: string, config: ImageGeneration.Config) {
  const bom = text.startsWith("\uFEFF") ? "\uFEFF" : ""
  const source = text.slice(bom.length)
  const errors: ParseError[] = []
  const root = parseTree(source, errors, { allowTrailingComma: true })
  if (errors.length || root?.type !== "object") throw new globalThis.Error("Invalid configuration document")
  // modify edits the first matching property, while parse reads the last.
  if ((root.children ?? []).filter((property) => property.children?.[0]?.value === "image_generation").length > 1)
    throw new globalThis.Error("Duplicate top-level image_generation property")
  Schema.decodeUnknownSync(ImageGeneration.Config)(config)
  if (config.enabled && (!config.model || !config.api))
    throw new globalThis.Error("An enabled image tool requires an explicit model and provider API")
  return (
    bom +
    applyEdits(
      source,
      modify(source, ["image_generation"], config, {
        formattingOptions: { insertSpaces: true, tabSize: 2, eol: source.includes("\r\n") ? "\r\n" : "\n" },
      }),
    )
  )
}

export const node = makeGlobalNode({ service: Service, layer, deps: [FSUtil.node, Global.node, EffectFlock.node] })
