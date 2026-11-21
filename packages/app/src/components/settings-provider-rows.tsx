import { createMemo, For, type Accessor, type JSX } from "solid-js"
import "./settings-provider-rows.css"

// Snapshots replace the objects. Keep the same disclosure and focused checkbox
// mounted as long as the provider entity or model ID still exists.
export function ProviderRows<T>(props: {
  items: readonly T[]
  by: (item: T) => string
  children: (item: Accessor<T>) => JSX.Element
}) {
  const rows = createMemo(() => new Map(props.items.map((item) => [props.by(item), item] as const)))
  return <For each={Array.from(rows().keys())}>{(key) => props.children(() => rows().get(key)!)}</For>
}
