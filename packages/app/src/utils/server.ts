import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { make } from "../../../client/src/generated/client"
import type { ServerConnection } from "@/context/server"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { decode64 } from "@/utils/base64"

export function authTokenFromCredentials(input: { username?: string; password: string }) {
  const encoded = base64Encode(`${input.username ?? "opencode"}:${input.password}`)
  return encoded.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(encoded.length / 4) * 4, "=")
}

export function authFromToken(token: string | null) {
  const decoded = decode64(token ?? undefined)
  if (!decoded) return
  const separator = decoded.indexOf(":")
  if (separator === -1) return
  return {
    username: decoded.slice(0, separator) || "opencode",
    password: decoded.slice(separator + 1),
  }
}

export function createSdkForServer({
  server,
  ...config
}: Omit<NonNullable<Parameters<typeof createOpencodeClient>[0]>, "baseUrl"> & {
  server: ServerConnection.HttpBase
}) {
  const auth = (() => {
    if (!server.password) return
    return {
      Authorization: `Basic ${authTokenFromCredentials({ username: server.username, password: server.password })}`,
    }
  })()

  return createOpencodeClient({
    ...config,
    headers: {
      ...(config.headers instanceof Headers ? Object.fromEntries(config.headers.entries()) : config.headers),
      ...auth,
    },
    baseUrl: server.url,
  })
}

function serverHeaders(server: ServerConnection.HttpBase) {
  if (!server.password) return
  return {
    Authorization: `Basic ${authTokenFromCredentials({
      username: server.username,
      password: server.password,
    })}`,
  }
}

export function createApiForServer(input: {
  server: ServerConnection.HttpBase
  fetch?: typeof globalThis.fetch
}) {
  return make({
    baseUrl: input.server.url,
    fetch: input.fetch,
    headers: serverHeaders(input.server),
  })
}

export function createGeneratedApiForServer(input: {
  server: ServerConnection.HttpBase
  fetch?: typeof globalThis.fetch
  directory?: string
}) {
  return make({
    baseUrl: input.server.url,
    fetch: input.fetch,
    headers: {
      ...serverHeaders(input.server),
      ...(input.directory ? { "x-opencode-directory": encodeURIComponent(input.directory) } : {}),
    },
  })
}

export type ServerApi = ReturnType<typeof make>
export type GeneratedApi = ReturnType<typeof make>
