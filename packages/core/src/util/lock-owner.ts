import os from "os"
import { Option, Schema } from "effect"

const Metadata = Schema.fromJsonString(
  Schema.Struct({
    token: Schema.String,
    pid: Schema.Number,
    hostname: Schema.String,
    createdAt: Schema.String,
  }),
)

type Diagnosis = {
  reason: "metadata-missing" | "metadata-corrupt" | "remote-owner" | "live-owner" | "exited-owner" | "permission-denied"
  hostname?: string
  pid?: number
}

// Age cannot distinguish a crashed owner from a suspended process.
export function diagnose(raw: string | undefined, hostname = os.hostname()): Diagnosis {
  if (raw === undefined) return { reason: "metadata-missing" }
  const parsed = Schema.decodeUnknownOption(Metadata)(raw)
  if (Option.isNone(parsed) || !Number.isSafeInteger(parsed.value.pid) || parsed.value.pid <= 0) {
    return { reason: "metadata-corrupt" }
  }
  const meta = parsed.value
  const owner = { hostname: meta.hostname, pid: meta.pid }
  if (meta.hostname !== hostname) return { reason: "remote-owner", ...owner }
  try {
    process.kill(meta.pid, 0)
    return { reason: "live-owner", ...owner }
  } catch (error) {
    const exited = error && typeof error === "object" && "code" in error && error.code === "ESRCH"
    return { reason: exited ? "exited-owner" : "permission-denied", ...owner }
  }
}

export * as LockOwner from "./lock-owner"
