export * as RelayPolicy from "./relay-policy"

// Historical model namespace retained for saved custom-provider selections.
export const ProviderID = "leidiandonghua"

export function allowsProvider(id: string) {
  return id === ProviderID
}
