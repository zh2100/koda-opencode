import type { WslServersState } from "@opencode-ai/app/wsl/types"

export function readyWslConnections(state?: WslServersState, label = "WSL") {
  return (state?.servers ?? []).flatMap((item) => {
    if (item.runtime.kind !== "ready") return []
    return [
      {
        displayName: item.config.distro,
        label,
        type: "sidecar" as const,
        variant: "wsl" as const,
        distro: item.config.distro,
        http: {
          url: item.runtime.url,
          username: item.runtime.username ?? undefined,
          password: item.runtime.password ?? undefined,
        },
      },
    ]
  })
}

export function availableStartupServer(defaultServer: string | null | undefined, state?: WslServersState) {
  const key = defaultServer ?? "sidecar"
  if (isLegacyLocalServerKey(key)) return "sidecar"
  if (!key.startsWith("wsl:")) return key
  if (state?.servers.some((item) => item.config.id === key && item.runtime.kind === "ready")) return key
  return "sidecar"
}

function isLegacyLocalServerKey(key: string) {
  try {
    const url = new URL(key)
    const hostname = url.hostname.replace(/^\[|\]$/g, "")
    return url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(hostname)
  } catch {
    return false
  }
}
