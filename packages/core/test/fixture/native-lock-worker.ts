import fs from "fs/promises"
import { Flock } from "@opencode-ai/core/util/flock"
import { LockProtocol } from "@opencode-ai/core/util/lock-protocol"

type Msg = {
  key: string
  context: LockProtocol.Context
  holdMs: number
  ready: string
  active: string
  done: string
}

const msg = JSON.parse(await Bun.file(process.argv[2] ?? "").text()) as Msg
await fs.writeFile(msg.ready, String(process.pid))
await Flock.withLock(
  msg.key,
  async () => {
    await fs.writeFile(msg.active, String(process.pid), { flag: "wx" })
    await new Promise((resolve) => setTimeout(resolve, msg.holdMs))
    await fs.appendFile(msg.done, "1\n")
    await fs.rm(msg.active, { force: true })
  },
  { context: msg.context, timeoutMs: 15_000, baseDelayMs: 20, maxDelayMs: 80 },
)
