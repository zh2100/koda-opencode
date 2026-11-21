import { dirname } from "node:path"

export function servicePasswordCommand(help: string) {
  if (/^\s+password\s+/m.test(help)) return ["service", "password"]
  if (/^\s+get\s+/m.test(help)) return ["service", "get", "password"]
}

export function commandEnv(binary: string, stateHome?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, OPENCODE_NATIVE_LOCK_DIR: dirname(binary) }
  if (stateHome === undefined) delete env.XDG_STATE_HOME
  else env.XDG_STATE_HOME = stateHome
  return env
}
