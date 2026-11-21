import pkg from "../../package.json"
import semver from "semver"

export const KODA_VERSION = pkg.version
export const KODA_RELEASE_URL = "https://github.com/zh2100/koda-opencode/releases/latest"

export function isNewerKodaVersion(version: string, current = KODA_VERSION) {
  return semver.valid(version) !== null && semver.valid(current) !== null && semver.gt(version, current)
}

export function newerKodaRelease(release: unknown, current = KODA_VERSION) {
  if (!release || typeof release !== "object" || !("name" in release) || typeof release.name !== "string")
    throw new Error("Invalid Koda release")
  const version = /^Koda\s+v?(\d+\.\d+\.\d+)$/i.exec(release.name.trim())?.[1]
  if (!version) throw new Error("Missing Koda release version")
  return isNewerKodaVersion(version, current) ? version : undefined
}
