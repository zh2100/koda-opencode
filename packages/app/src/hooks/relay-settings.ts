const ERROR_KEYS = [
  "KEY_MISSING",
  "KEY_REJECTED",
  "UPSTREAM_UNREACHABLE",
  "UPSTREAM_TIMEOUT",
  "UPSTREAM_RATE_LIMITED",
  "UPSTREAM_INVALID_RESPONSE",
  "REVISION_CONFLICT",
  "SECRET_STORE_UNAVAILABLE",
] as const

type RelayErrorKey =
  | `settings.relay.error.${(typeof ERROR_KEYS)[number]}`
  | "common.requestFailed"
  | "provider.custom.error.baseURL.required"
  | "provider.custom.error.baseURL.format"

export function vendorIdFromName(name: string, existing: readonly string[] = []) {
  const id = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  const base = id || `vendor-${Date.now()}`
  let suffix = 2
  let unique = base
  while (existing.includes(unique)) unique = `${base}-${suffix++}`
  return unique
}

export function vendorURLValid(value: string) {
  const input = value.trim()
  return (
    /^https?:\/\/(?:\[[0-9a-fA-F:]+\]|[^\s\/?#@:\\]+)(?::[0-9]{1,5})?(?:\/[^\s?#\\]*)?$/i.test(input) &&
    URL.canParse(input)
  )
}

export function relayErrorKey(error: unknown): RelayErrorKey {
  const message = error && typeof error === "object" && "message" in error ? String(error.message) : ""
  if (message === "provider.custom.error.baseURL.required" || message === "provider.custom.error.baseURL.format")
    return message
  if ((ERROR_KEYS as readonly string[]).includes(message)) return `settings.relay.error.${message}` as RelayErrorKey
  return "common.requestFailed"
}
