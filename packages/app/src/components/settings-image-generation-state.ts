import type { ImageGeneration } from "@opencode-ai/schema/image-generation"
import { createResource, type Accessor } from "solid-js"
import type { ServerSDK } from "@/context/server-sdk"

type Server = Pick<ServerSDK, "protocol" | "client" | "api">

export function createImageGenerationSettings(sdk: Accessor<Server>) {
  const [settings, actions] = createResource(sdk, (server) =>
    (async () => ({
      server,
      config:
        (await server.protocol) === "v1"
          ? ((await server.client.global.config.get()).data?.image_generation ?? {})
          : await server.api.imageGeneration.get(),
    }))().then(
      (value) => ({ ...value, error: false as const }),
      () => ({ server, config: undefined, error: true as const }),
    ),
  )

  return {
    settings,
    reload: actions.refetch,
    // Require the form's loaded server, never the currently selected server after an await.
    save: async (server: Server, config: ImageGeneration.Config) => {
      if ((await server.protocol) === "v1") {
        await server.client.global.config.update({ config: { image_generation: config } })
        return
      }
      await server.api.imageGeneration.update(config)
    },
  }
}
