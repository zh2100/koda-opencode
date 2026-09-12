export * as RelaySecretStore from "./relay-secret-store"

import { makeGlobalNode } from "./effect/app-node"
import { Context, Effect, Layer, Schema } from "effect"
import path from "path"
import { FSUtil } from "./fs-util"
import { Global } from "./global"

export class UnavailableError extends Schema.TaggedErrorClass<UnavailableError>()("Relay.SecretStoreUnavailable", {}) {}

export interface Interface {
  readonly get: (ref: string) => Effect.Effect<string | undefined, UnavailableError>
  readonly put: (ref: string, secret: string) => Effect.Effect<void, UnavailableError>
  readonly remove: (ref: string) => Effect.Effect<void, UnavailableError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/RelaySecretStore") {}

const Stored = Schema.Record(Schema.String, Schema.String)

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

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const file = path.join((yield* Global.Service).data, "relay-secrets.json")
    const decode = Schema.decodeUnknownSync(Stored)
    const encode = Schema.encodeSync(Stored)
    const secrets = (
      globalThis as unknown as {
        Bun?: {
          secrets?: {
            get: (input: { service: string; name: string }) => Promise<string | null>
            set: (input: { service: string; name: string; value: string }) => Promise<void>
            delete: (input: { service: string; name: string }) => Promise<unknown>
          }
        }
      }
    ).Bun?.secrets

    const read = Effect.fn("RelaySecretStore.read")(function* () {
      const data = yield* fs.readJson(file).pipe(Effect.orElseSucceed(() => ({})))
      try {
        return { ...decode(data) } as Record<string, string>
      } catch {
        return {} as Record<string, string>
      }
    })

    const write = Effect.fn("RelaySecretStore.write")(function* (next: Record<string, string>) {
      yield* fs.writeJson(file, encode(next), 0o600).pipe(Effect.mapError(() => new UnavailableError()))
    })

    const fileGet = Effect.fn("RelaySecretStore.fileGet")(function* (ref: string) {
      return (yield* read())[ref]
    })

    const filePut = Effect.fn("RelaySecretStore.filePut")(function* (ref: string, secret: string) {
      const next = yield* read()
      next[ref] = secret
      yield* write(next)
    })

    const fileRemove = Effect.fn("RelaySecretStore.fileRemove")(function* (ref: string) {
      const next = yield* read()
      delete next[ref]
      yield* write(next)
    })

    if (!secrets) {
      return Service.of({
        get: fileGet,
        put: filePut,
        remove: fileRemove,
      })
    }

    return Service.of({
      get: Effect.fn("RelaySecretStore.get")(function* (ref) {
        const value = yield* Effect.tryPromise({
          try: () => secrets.get({ service: "opencode-relay", name: ref }),
          catch: () => new UnavailableError(),
        }).pipe(
          Effect.map((item) => item ?? undefined),
          Effect.catch(() => Effect.succeed(undefined)),
        )
        if (value) return value
        return yield* fileGet(ref)
      }),
      put: Effect.fn("RelaySecretStore.put")(function* (ref, secret) {
        const stored = yield* Effect.tryPromise({
          try: () => secrets.set({ service: "opencode-relay", name: ref, value: secret }).then(() => true),
          catch: () => new UnavailableError(),
        }).pipe(Effect.catch(() => Effect.succeed(false)))
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
        yield* Effect.tryPromise({
          try: () => secrets.delete({ service: "opencode-relay", name: ref }),
          catch: () => new UnavailableError(),
        }).pipe(Effect.catch(() => fileRemove(ref)))
      }),
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [FSUtil.node, Global.node],
})
