export function hasCustomAgent(items: Array<{ native?: boolean }>) {
  return items.some((item) => item.native === false)
}

export function resolveAgent<T extends { name: string }>(items: T[], name?: string) {
  return items.find((item) => item.name === name) ?? items.find((item) => item.name === "build") ?? items[0]
}

export function resolveCurrentAgent<T extends { name: string }>(items: T[], name: string | undefined, visible: boolean) {
  return resolveAgent(items, visible || name === "plan" ? name : "build")
}
