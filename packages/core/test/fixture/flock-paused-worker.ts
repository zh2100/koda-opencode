import path from "node:path"
import { Flock } from "@opencode-ai/core/util/flock"
const root = process.argv[2]!
const context = {
  data: path.join(root, "data"),
  config: path.join(root, "config"),
  state: path.join(root, "state"),
  cache: path.join(root, "cache"),
}
const lease = await Flock.acquire("review-live", { context, staleMs: 150 })
console.log("HOLDING " + process.pid)
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
await lease.release()
