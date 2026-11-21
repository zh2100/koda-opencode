import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { RelayAuth } from "@opencode-ai/core/relay-auth"
import { RelaySecretStore } from "@opencode-ai/core/relay-secret-store"
import { Relay } from "@opencode-ai/schema/relay"
import path from "node:path"

const [data, name, mode] = process.argv.slice(2) as [string, string, string]
const go = new Promise<void>((resolve) => process.once("message", () => resolve()))
const checkpoint = { active: false, committed: false }
const filesystem = Layer.effect(
  FSUtil.Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    return FSUtil.Service.of({
      ...fs,
      rename: (source, target) =>
        Effect.gen(function* () {
          if (checkpoint.active && path.basename(target) === "relay-auth.json" && mode === "crash-before-commit")
            process.exit(86)
          if (
            checkpoint.active &&
            checkpoint.committed &&
            path.basename(target) === "relay-secrets.json" &&
            mode === "crash-cleanup"
          )
            process.exit(88)
          yield* fs.rename(source, target)
          if (!checkpoint.active || path.basename(target) !== "relay-auth.json") return
          checkpoint.committed = true
          if (mode === "crash-after-commit") process.exit(87)
        }),
    })
  }),
).pipe(Layer.provide(AppNodeBuilder.build(FSUtil.node)))
const layer = AppNodeBuilder.build(LayerNode.group([RelayAuth.node, RelaySecretStore.node]), [
  [Global.node, Global.layerWith({ data, state: `${data}/state-${name}` })],
  [FSUtil.node, filesystem],
  [
    RelaySecretStore.node,
    RelaySecretStore.makeLayer(undefined).pipe(
      Layer.provide(filesystem),
      Layer.provide(Global.layerWith({ data, state: `${data}/state-${name}` })),
    ),
  ],
])
await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const auth = yield* RelayAuth.Service
      const secrets = yield* RelaySecretStore.Service
      const initial = yield* auth.get()
      process.send?.({
        ready: true,
        revision: initial.revision,
        entities: Object.fromEntries(initial.vendors.map((vendor) => [vendor.id, vendor.entityId])),
      })
      yield* Effect.promise(() => go)
      if (mode === "delete-vendor") {
        const state = yield* auth.get()
        const rolled = yield* auth.deleteVendor({
          id: Relay.VendorID.make(name),
          revision: state.revision,
          operationId: "delete-race",
        })
        process.send?.({ done: true, revision: rolled.revision })
        return
      }
      if (mode.startsWith("create-receipt")) {
        const input = {
          id: Relay.VendorID.make(name),
          name,
          baseURL: "https://example.invalid",
          key: `key-${name}`,
          revision: 0,
          operationId: `create:${name}`,
          createOnly: true,
        }
        const state = yield* auth.setVendor(input)
        if (mode === "create-receipt-drop-response") process.exit(89)
        // A concurrent deletion may commit between confirmation and a separate credential read.
        const resolved =
          mode === "create-receipt-after-delete" || mode === "create-receipt-racing-delete"
            ? undefined
            : yield* auth.resolve(input.id)
        process.send?.({
          done: true,
          revision: state.revision,
          receipt: state.operationReceipt,
          credentialResolved: resolved?.key === input.key,
        })
        return
      }
      if (mode === "recover") {
        yield* auth.resolve(Relay.VendorID.make(name))
        process.send?.({ done: true })
        return
      }
      if (mode.startsWith("crash-")) {
        const state = yield* auth.get()
        checkpoint.active = true
        yield* auth.setVendor({
          id: Relay.VendorID.make(name),
          key: `new-key-${name}`,
          revision: state.revision,
          operationId: "rotate",
        })
        return yield* Effect.die("crash checkpoint was not reached")
      }
      if (mode === "secrets") {
        for (const index of Array.from({ length: 12 }, (_, index) => index)) {
          yield* secrets.put(`${name}:${index}`, `value-${name}-${index}`)
        }
        yield* secrets.remove(`${name}:0`)
        process.send?.({ done: true })
        return
      }
      const input = {
        id: Relay.VendorID.make(name),
        name,
        baseURL: "https://example.invalid",
        key: `key-${name}`,
        revision: 0,
      }
      const first = yield* auth.setVendor(input).pipe(Effect.result)
      if (first._tag === "Failure") {
        if (first.failure.info.code !== "REVISION_CONFLICT") return yield* Effect.die(first.failure)
        const state = yield* auth.get()
        yield* auth.setVendor({ ...input, revision: state.revision })
      }
      process.send?.({ done: true, conflict: first._tag === "Failure" })
    }),
  ).pipe(Effect.provide(layer)),
)
process.disconnect?.()
