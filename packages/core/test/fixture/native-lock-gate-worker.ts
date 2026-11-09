import fs from "fs/promises"
import { Flock } from "@opencode-ai/core/util/flock"
import { LockProtocol } from "@opencode-ai/core/util/lock-protocol"

type Msg = {
  key: string
  context: LockProtocol.Context
  ready: string
  release: string
}

const msg = JSON.parse(await Bun.file(process.argv[2] ?? "").text()) as Msg
const lease = await Flock.acquire(msg.key, { context: msg.context, timeoutMs: 5_000 })
await fs.writeFile(msg.ready, String(process.pid))
const stop = Date.now() + 15_000
while (Date.now() < stop) {
  try {
    await fs.access(msg.release)
    break
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
await lease.release()
