import { existsSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { app } from "electron"

import { getStore } from "./store"

const scopes = ["any", "chrome", "excel"] as const
const baseConfigContent = process.env.OPENCODE_CONFIG_CONTENT

export function configureComputerUse() {
  const command = computerUseCommand()
  if (!command) {
    restoreBaseConfigContent()
    return
  }
  const preference = readComputerUse()
  if (!preference.enabled) {
    restoreBaseConfigContent()
    return
  }
  const config = {
    mcp: {
      "open-computer-use": {
        type: "local",
        command: [command, "mcp"],
        enabled: true,
        environment: preference.scope === "any" ? undefined : { OPEN_COMPUTER_USE_SCOPE: preference.scope },
      },
    },
  }
  const base = parseRecord(baseConfigContent) ?? {}
  const mcp = typeof base.mcp === "object" && base.mcp !== null ? (base.mcp as Record<string, unknown>) : {}
  process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    ...base,
    mcp: { ...mcp, "open-computer-use": config.mcp["open-computer-use"] },
  })
}

function restoreBaseConfigContent() {
  if (baseConfigContent === undefined) delete process.env.OPENCODE_CONFIG_CONTENT
  else process.env.OPENCODE_CONFIG_CONTENT = baseConfigContent
}

function parseRecord(value: string | undefined) {
  if (!value) return
  const parsed = parse(value)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return
  return parsed as Record<string, unknown>
}

function computerUseCommand() {
  const override = process.env.KODA_COMPUTER_USE_HOME
  if (override && !isAbsolute(override)) throw new Error("KODA_COMPUTER_USE_HOME must be an absolute path")
  const root = override ?? (app.isPackaged ? join(process.resourcesPath, "open-computer-use") : "")
  if (!root) return
  const arch = process.arch === "arm64" ? "arm64" : "amd64"
  const command =
    process.platform === "win32"
      ? join(root, "dist", "windows", arch, "open-computer-use.exe")
      : process.platform === "linux"
        ? join(root, "dist", "linux", arch, "open-computer-use")
        : join(root, "dist", "Open Computer Use.app", "Contents", "MacOS", "OpenComputerUse")
  if (!existsSync(command)) return
  return command
}

function readComputerUse() {
  const value = getStore().get("settings.computer-use")
  const parsed = typeof value === "string" ? parse(value) : value
  if (!parsed || typeof parsed !== "object") return { enabled: false, scope: "any" as const }
  const record = parsed as { enabled?: unknown; scope?: unknown }
  const scope = scopes.find((item) => item === record.scope) ?? "any"
  return { enabled: record.enabled === true, scope }
}

function parse(value: string) {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}
