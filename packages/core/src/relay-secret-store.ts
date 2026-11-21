export * as RelaySecretStore from "./relay-secret-store"

import { makeGlobalNode } from "./effect/app-node"
import { Context, Effect, Layer, Result, Schema } from "effect"
import path from "path"
import { FSUtil } from "./fs-util"
import { randomUUID } from "crypto"
import { EffectFlock } from "./util/effect-flock"
import { Global } from "./global"
import { SettledIO } from "./util/settled-io"

export class UnavailableError extends Schema.TaggedErrorClass<UnavailableError>()("Relay.SecretStoreUnavailable", {
  reason: Schema.optional(Schema.String),
}) {}

export interface Interface {
  readonly get: (ref: string) => Effect.Effect<string | undefined, UnavailableError>
  readonly put: (ref: string, secret: string) => Effect.Effect<void, UnavailableError>
  readonly remove: (ref: string) => Effect.Effect<void, UnavailableError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/RelaySecretStore") {}

export interface SystemSecrets {
  readonly get: (input: { service: string; name: string }) => Promise<string | null>
  readonly set: (input: { service: string; name: string; value: string }) => Promise<void>
  readonly delete: (input: { service: string; name: string }) => Promise<unknown>
}

const Stored = Schema.Record(Schema.String, Schema.String)

export const systemSecrets = () =>
  (
    globalThis as unknown as {
      Bun?: { secrets?: SystemSecrets }
    }
  ).Bun?.secrets

export const memoryLayer = Layer.sync(Service, () => {
  const values = new Map<string, string>()
  return Service.of({
    get: Effect.fn("RelaySecretStore.get")(function* (ref) {
      return values.get(ref)
    }),
    put: Effect.fn("RelaySecretStore.put")(function* (ref, secret) {
      values.set(ref, secret)
    }),
    remove: Effect.fn("RelaySecretStore.remove")(function* (ref) {
      values.delete(ref)
    }),
  })
})

export const makeLayer = (secrets: SystemSecrets | undefined) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const data = (yield* Global.Service).data
      const file = path.join(data, "relay-secrets.json")
      const flock = yield* EffectFlock.Service
      const locked = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | UnavailableError, R> =>
        Effect.scoped(
          Effect.gen(function* () {
            yield* flock.acquire("relay-secrets", path.join(data, "locks")).pipe(
              Effect.mapError(
                (error) =>
                  new UnavailableError({
                    reason: error._tag === "LockTimeoutError" ? error.diagnosis?.reason : undefined,
                  }),
              ),
            )
            const files = yield* fs.readDirectory(data).pipe(Effect.mapError(() => new UnavailableError()))
            for (const name of files.filter((name) => /^relay-secrets\.json\.[0-9a-f-]{36}\.tmp$/.test(name))) {
              yield* fs.remove(path.join(data, name)).pipe(SettledIO.drain, Effect.mapError(() => new UnavailableError()))
            }
            return yield* effect
          }),
        )
      const decode = Schema.decodeUnknownEffect(Stored)
      const encode = Schema.encodeSync(Stored)

      const read = Effect.fn("RelaySecretStore.read")(function* () {
        const data = yield* fs.readJson(file).pipe(
          Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed({})),
          Effect.mapError(() => new UnavailableError()),
        )
        return { ...(yield* decode(data).pipe(Effect.mapError(() => new UnavailableError()))) }
      })

      const write = Effect.fn("RelaySecretStore.write")(function* (next: Record<string, string>) {
        const temporary = `${file}.${randomUUID()}.tmp`
        yield* fs.writeWithDirs(temporary, JSON.stringify(encode(next), null, 2), 0o600).pipe(
          SettledIO.drain,
          Effect.andThen(fs.rename(temporary, file).pipe(SettledIO.drain)),
          SettledIO.ensuring(fs.remove(temporary, { force: true }).pipe(SettledIO.drain)),
          Effect.mapError(() => new UnavailableError()),
        )
      })

      const fileGet = Effect.fn("RelaySecretStore.fileGet")((ref: string) =>
        locked(
          Effect.gen(function* () {
            const value = (yield* read())[ref]
            if (value !== undefined && !value.trim()) return yield* new UnavailableError()
            return value
          }),
        ),
      )

      const filePut = Effect.fn("RelaySecretStore.filePut")((ref: string, secret: string) =>
        locked(
          Effect.gen(function* () {
            const next = yield* read()
            next[ref] = secret
            yield* write(next)
          }),
        ),
      )

      const fileRemove = Effect.fn("RelaySecretStore.fileRemove")((ref: string) =>
        locked(
          Effect.gen(function* () {
            const next = yield* read()
            if (!(ref in next)) return
            delete next[ref]
            yield* write(next)
          }),
        ),
      )

      const systemMissing = (error: unknown) => {
        const reason = error && typeof error === "object" && "code" in error ? String(error.code) : ""
        const message = error instanceof Error ? error.message : ""
        return reason === "NotFound" || /not found|does not exist|no such secret/i.test(message)
      }

      const systemRemove = (ref: string) =>
        Effect.tryPromise({
          try: () => secrets!.delete({ service: "opencode-relay", name: ref }),
          catch: (error) => error,
        }).pipe(
          SettledIO.drain,
          Effect.catch((error) => (systemMissing(error) ? Effect.void : Effect.fail(new UnavailableError()))),
          Effect.flatMap((result) => {
            if (result === undefined || result === null || result === true || result === false || systemMissing(result))
              return Effect.void
            return Effect.fail(new UnavailableError())
          }),
        )

      if (!secrets) {
        return Service.of({
          get: fileGet,
          put: filePut,
          remove: fileRemove,
        })
      }

      return Service.of({
        get: Effect.fn("RelaySecretStore.get")(function* (ref) {
          const result = yield* Effect.tryPromise({
            try: () => secrets.get({ service: "opencode-relay", name: ref }),
            // Only an explicit adapter code confirms absence. Never retain the raw error.
            catch: (error) => error && typeof error === "object" && "code" in error && error.code === "NotFound"
              ? "missing" as const : "unavailable" as const,
          }).pipe(Effect.result)
          if (Result.isSuccess(result) && result.success?.trim()) return result.success
          const fallback = yield* fileGet(ref)
          if (fallback !== undefined) return fallback
          if (Result.isSuccess(result) ? result.success !== null : result.failure !== "missing")
            return yield* new UnavailableError()
          return undefined
        }),
        put: Effect.fn("RelaySecretStore.put")(function* (ref, secret) {
          const stored = yield* Effect.tryPromise({
            try: () => secrets.set({ service: "opencode-relay", name: ref, value: secret }).then(() => true),
            catch: () => new UnavailableError(),
          }).pipe(SettledIO.drain, Effect.catch(() => Effect.succeed(false)))
          if (!stored) {
            yield* filePut(ref, secret)
            return
          }
          const value = yield* Effect.tryPromise({
            try: () => secrets.get({ service: "opencode-relay", name: ref }),
            catch: () => new UnavailableError(),
          }).pipe(
            Effect.map((item) => item ?? undefined),
            Effect.catch(() => Effect.succeed(undefined)),
          )
          if (value !== secret) yield* filePut(ref, secret)
        }),
        remove: Effect.fn("RelaySecretStore.remove")(function* (ref) {
          const systemResult = yield* Effect.result(systemRemove(ref))
          const fileResult = yield* Effect.result(fileRemove(ref))
          if (Result.isFailure(systemResult) || Result.isFailure(fileResult)) return yield* new UnavailableError()
        }),
      })
    }),
  ).pipe(Layer.provide(EffectFlock.layer))

export const testing = {
  layer: undefined as Layer.Layer<Service> | undefined,
}

const layer = Layer.unwrap(Effect.sync(() => testing.layer ?? makeLayer(systemSecrets())))

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [FSUtil.node, Global.node],
})
