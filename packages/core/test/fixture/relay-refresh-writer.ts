import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { RelayAuth } from "@opencode-ai/core/relay-auth"
import { RelayCatalog } from "@opencode-ai/core/relay-catalog"
import { RelaySecretStore } from "@opencode-ai/core/relay-secret-store"
import { Relay } from "@opencode-ai/schema/relay"
import path from "node:path"

const [data, mode] = process.argv.slice(2) as [string, string]
const global = Global.layerWith({ data, state: path.join(data, "refresh-child-state") })
const files = AppNodeBuilder.build(FSUtil.node)
const secrets = RelaySecretStore.makeLayer(undefined).pipe(Layer.provide(files), Layer.provide(global))
const layer = AppNodeBuilder.build(LayerNode.group([RelayAuth.node, RelayCatalog.node]), [
  [Global.node, global],
  [FSUtil.node, files],
  [RelaySecretStore.node, secrets],
])
const operation = Effect.gen(function* () {
  const auth = yield* RelayAuth.Service
  const catalog = yield* RelayCatalog.Service
  if (mode.startsWith("quarantine-crash-")) return yield* Effect.never
  const id = Relay.VendorID.make("review")
  if (mode === "other-vendor") {
    const other = Relay.VendorID.make("child-other")
    yield* auth.setVendor({
      id: other,
      name: "Other",
      baseURL: "https://other.invalid/v1",
      key: "fake-other",
      revision: (yield* auth.get()).revision,
    })
    const { Model } = yield* Effect.promise(() => import("@opencode-ai/schema/model"))
    yield* catalog.setVisibility({ vendorId: other, modelId: Model.ID.make("other-model"), visible: true })
    return (yield* catalog.managed()).map((item) => String(item.modelId))
  }
  if (mode === "rotate") {
    yield* auth.setVendor({ id, key: "fake-child-key", revision: (yield* auth.get()).revision })
    yield* catalog.syncVendors()
  }
  return (yield* catalog.refresh(id)).map((item) => String(item.modelId))
})
const result = await Effect.gen(function* () {
  if (mode.startsWith("quarantine-crash-"))
    yield* RelayCatalog.withCommitHook((phase) =>
      mode === `quarantine-crash-${phase}`
        ? Effect.sync(() => process.stdout.write("QUARANTINE-READY\n")).pipe(Effect.andThen(Effect.never))
        : Effect.void,
    )
  return yield* operation.pipe(Effect.provide(layer))
}).pipe(Effect.scoped, Effect.runPromise)
process.stdout.write(JSON.stringify(result))
