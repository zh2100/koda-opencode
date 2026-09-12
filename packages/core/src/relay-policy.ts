export * as RelayPolicy from "./relay-policy"

export const ProviderID = "leidiandonghua"
export const BaseURL = "https://api.leidiandonghua.cn/v1"

export function allowsProvider(id: string) {
  return id === ProviderID
}
