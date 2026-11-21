import { createRelaySettingsState } from "../src/hooks/use-relay-settings"
import type { ServerRelayGetOutput } from "../../client/src/generated/types"

// These historical unit fixtures model the identity/create-receipt contract.
// Versioned sync has its own tests against the actual sync response shape.
const decorate = (auth: ServerRelayGetOutput): ServerRelayGetOutput => ({
  ...auth,
  capabilities: auth.capabilities ?? ["independent-vendors-v1", "vendor-entity-v1", "vendor-create-receipt-v1"],
  vendors: auth.vendors.map((vendor) => ({ ...vendor, entityId: vendor.entityId ?? `fixture:${vendor.id}` })),
})

type FixtureServer = { scope: string; generatedApi: { "server.relay": Record<string, unknown> } }

// Historical fixtures deliberately omit unrelated methods/fields. Keep that test seam
// at one boundary; production state and generated API remain strictly typed.
export function createTestState(input: () => FixtureServer) {
  return createRelaySettingsState(input as unknown as Parameters<typeof createRelaySettingsState>[0])
}

export function createFixtureState(input: () => FixtureServer) {
  const state = createTestState(() => {
    const server = input()
    const api = server.generatedApi["server.relay"]
    const methods = Object.fromEntries(
      (["get", "vendor", "key", "delete"] as const)
        .filter((key) => typeof api[key] === "function")
        .map((key) => [
          key,
          async (...args: unknown[]) => {
            const call = api[key] as (...args: unknown[]) => Promise<ServerRelayGetOutput>
            const auth = decorate(await call(...args))
            const request = args[0] as { createOnly?: boolean; vendorId?: string; operationId?: string } | undefined
            const vendor = auth.vendors.find((vendor) => vendor.id === request?.vendorId)
            if (key !== "vendor" || !request?.createOnly || !vendor || auth.operationReceipt) return auth
            return {
              ...auth,
              operationReceipt: {
                operationId: request.operationId!,
                kind: "vendor-create" as const,
                vendorId: vendor.id,
                entityId: vendor.entityId!,
                committedRevision: auth.revision,
              },
            }
          },
        ]),
    )
    return { ...server, generatedApi: { ...server.generatedApi, "server.relay": { ...api, ...methods } } }
  })
  return { ...state, applyAuth: (auth: ServerRelayGetOutput) => state.applyAuth(decorate(auth)) }
}
