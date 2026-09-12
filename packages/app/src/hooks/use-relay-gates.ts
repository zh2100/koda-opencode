import { createMemo } from "solid-js"
import { useGlobal } from "@/context/global"
import { ServerConnection, useServer } from "@/context/server"

const closed = {
  relayCoreUi: false,
  relayLayout: false,
  relaySkills: false,
  relayMcp: false,
  scheduledTasks: false,
}


export function useRelayGates() {
  const server = useServer()
  const global = useGlobal()
  return createMemo(() => {
    const conn = server.current
    if (!conn) return closed
    const health = global.servers.health[ServerConnection.key(conn)]
    if (!health) return closed
    if (!("gates" in health) || !health.gates) return closed
    return health.gates
  })
}
