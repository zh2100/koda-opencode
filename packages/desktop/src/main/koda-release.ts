export const KODA_VERSION = "1.0.3"
export const KODA_RELEASE_URL = "https://github.com/zh2100/koda-opencode/releases/tag/Koda"

export function newerKodaRelease(release: unknown, current = KODA_VERSION) {
  if (!release || typeof release !== "object" || !("name" in release) || typeof release.name !== "string")
    throw new Error("Invalid Koda release")
  const version = /^Koda\s+v?(\d+\.\d+\.\d+)$/i.exec(release.name.trim())?.[1]
  if (!version) throw new Error("Missing Koda release version")
  const next = version.split(".").map(Number)
  const previous = current.split(".").map(Number)
  const different = next.findIndex((part, index) => part !== previous[index])
  return different >= 0 && next[different] > previous[different] ? version : undefined
}
