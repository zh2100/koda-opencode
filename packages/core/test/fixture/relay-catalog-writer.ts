import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { RelayAuth } from "@opencode-ai/core/relay-auth"
import { RelayCatalog } from "@opencode-ai/core/relay-catalog"
import { RelaySecretStore } from "@opencode-ai/core/relay-secret-store"
import { Model } from "@opencode-ai/schema/model"
import { Relay } from "@opencode-ai/schema/relay"

const [data, name] = process.argv.slice(2) as [string, string]
const layer = AppNodeBuilder.build(LayerNode.group([RelayCatalog.node, RelayAuth.node]), [
  [Global.node, Global.layerWith({ data, state: `${data}/state-${name}` })],
  [RelaySecretStore.node, RelaySecretStore.memoryLayer],
])
await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const auth = yield* RelayAuth.Service
      const catalog = yield* RelayCatalog.Service
      process.stdout.write("ready\n")
      const line = yield* Effect.promise(
        () =>
          new Promise<string>((resolve) => {
            process.stdin.resume()
            process.stdin.once("data", (value) => resolve(String(value)))
          }),
      )
      if (!line.includes("go")) return yield* Effect.die("missing go")
      const state = yield* auth.get()
      const vendor = state.vendors.find((item) => item.id === Relay.VendorID.chatgpt)
      // Both workers may observe an empty root. A creation conflict means the sibling
      // already installed this shared fixture; re-read instead of overwriting it.
      if (!vendor) {
        yield* auth
          .setVendor({
            id: Relay.VendorID.chatgpt,
            name: "Independent",
            baseURL: "https://provider.test/v1",
            key: "sk-shared",
            revision: state.revision,
          })
          .pipe(Effect.catch((error) => (error.info.code === "REVISION_CONFLICT" ? Effect.void : Effect.fail(error))))
      }
      const next = yield* auth.get()
      yield* catalog.setVisibility({
        vendorId: Relay.VendorID.chatgpt,
        modelId: Model.ID.make(name),
        visible: true,
      })
      process.stdout.write(`done ${next.revision}\n`)
    }),
  ).pipe(Effect.provide(layer)),
)
process.exit(0)
