export function normalizeReasoningDelta(
  state: Record<string, string>,
  id: string,
  text: string,
  repeated: Record<string, string> = {},
) {
  const current = state[id] ?? ""
  if (!text) return ""
  // Providers may send cumulative blocks or repeat the last block. Only remove
  // a prefix when the provider clearly sent a cumulative value; arbitrary
  // overlap is valid for normal incremental text (for example repeated words).
  if (text.startsWith(current)) {
    const delta = text.slice(current.length)
    state[id] = text
    repeated[id] = ""
    return delta
  }
  if (text === current || repeated[id] === text) {
    repeated[id] = text
    return ""
  }
  const delta = text
  state[id] = current + delta
  repeated[id] = text
  return delta
}
