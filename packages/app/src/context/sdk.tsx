import { createSimpleContext } from "@opencode-ai/ui/context"
import { type Accessor, createMemo } from "solid-js"
import { type ServerSDK, useServerSDK } from "./server-sdk"
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"
import type { GeneratedApi } from "@/utils/server"

export type DirectorySDK = {
  scope: ReturnType<ServerSDK["ensureDirSdkContext"]>["scope"]
  protocol: ReturnType<ServerSDK["ensureDirSdkContext"]>["protocol"]
  directory: string
  client: OpencodeClient
  api: GeneratedApi
  event: ReturnType<ServerSDK["ensureDirSdkContext"]>["event"]
  url: string
  createClient: ServerSDK["createClient"]
}

export const { use: useSDK, provider: SDKProvider } = createSimpleContext({
  name: "SDK",
  // Resolves the directory-scoped SDK reactively from the (possibly changing) server.
  init: (props: { directory: string | Accessor<string> }) => {
    const serverSDK = useServerSDK()
    return createMemo(() => {
      const directory = typeof props.directory === "function" ? props.directory() : props.directory
      return serverSDK().ensureDirSdkContext(directory) as DirectorySDK
    })
  },
})
