import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

export type AcquireResult = { status: "busy" } | { status: "acquired"; token: string; release: () => ReleaseResult }
export type ReleaseResult = "released" | "already-released"

export class NativeLockError extends Error {
  readonly reason: "module-unavailable" | "permission-denied" | "filesystem" | "invalid"

  constructor(reason: "module-unavailable" | "permission-denied" | "filesystem" | "invalid", detail: string) {
    super(detail)
    this.name = "NativeLockError"
    this.reason = reason
  }
}

type Binding = {
  tryAcquire(file: string): AcquireResult
}

type NativeBinding = {
  tryAcquire(file: string): { status: "busy" } | { status: "acquired"; token: string }
  release(token: string): ReleaseResult
}

const loaded = new Map<string, Binding>()

export function packagedDir() {
  const candidates = [
    process.execPath,
    process.argv[1] ? path.resolve(process.argv[1]) : "",
  ].filter((file) => file.length > 0)
  const beside = candidates
    .map((file) => path.dirname(file))
    .find((dir) => fs.existsSync(path.join(dir, artifactName)))
  if (beside) return beside
  const source = path.resolve(fileURLToPath(new URL("../../native/dist", import.meta.url)))
  if (fs.existsSync(path.join(source, artifactName))) return source
  return path.dirname(fileURLToPath(import.meta.url))
}

export function modulePath(resourceDir = process.env.OPENCODE_NATIVE_LOCK_DIR ?? packagedDir()) {
  const name = `process-lock-${process.platform}-${process.arch}.node`
  const file = path.resolve(resourceDir, name)
  const root = path.resolve(resourceDir)
  if (file !== root && !file.startsWith(root + path.sep)) {
    throw new NativeLockError("invalid", "native lock module path escapes the resource directory")
  }
  return file
}

export function load(resourceDir?: string): Binding {
  const file = modulePath(resourceDir)
  const cached = loaded.get(file)
  if (cached) return cached
  if (!fs.existsSync(file)) throw new NativeLockError("module-unavailable", `native lock module is missing: ${file}`)
  const loader = { require: require } as { require(id: string): NativeBinding }
  const value = loader.require(file)
  if (!value || typeof value.tryAcquire !== "function" || typeof value.release !== "function") {
    throw new NativeLockError("invalid", "native lock module does not export the required interface")
  }
  const bound: Binding = {
    tryAcquire: (target) => {
      const result = value.tryAcquire(target)
      if (result.status === "busy") return result
      return {
        status: "acquired",
        token: result.token,
        // Tokens are local to one module instance, so release through that same instance.
        release: () => {
          try {
            return value.release(result.token)
          } catch (error) {
            throw nativeError(error)
          }
        },
      }
    },
  }
  loaded.set(file, bound)
  return bound
}

function nativeError(error: unknown): NativeLockError {
  const record = error && typeof error === "object" ? error : undefined
  const code = record && "code" in record ? String(record.code) : ""
  const operation = record && "operation" in record ? String(record.operation) : ""
  const message = error instanceof Error ? error.message : String(error)
  const detail = operation ? `${operation} ${code}: ${message}` : message
  if (code === "5" || code === "EACCES" || code === "EPERM" || /permission/i.test(message)) {
    return new NativeLockError("permission-denied", detail)
  }
  if (/missing|not configured|does not export/i.test(message)) return new NativeLockError("module-unavailable", detail)
  return new NativeLockError("filesystem", detail)
}

export function handoff<A>(
  pending: Promise<A>,
  resume: (effect: { status: "acquired"; value: A } | { status: "failed"; cause: unknown }) => void,
) {
  let settled = false
  pending.then(
    (value) => {
      if (settled) return
      settled = true
      resume({ status: "acquired", value })
    },
    (cause) => {
      if (settled) return
      settled = true
      resume({ status: "failed", cause })
    },
  )
  return {
    cancel() {
      settled = true
    },
    async late(release?: (value: A) => Promise<void>) {
      const value = await pending.catch(() => undefined)
      if (!value) return
      if (settled) {
        if (release) await release(value)
        return
      }
      settled = true
      return value
    },
  }
}

export function tryAcquire(file: string, resourceDir?: string): AcquireResult {
  try {
    return load(resourceDir).tryAcquire(file)
  } catch (error) {
    if (error instanceof NativeLockError) throw error
    throw nativeError(error)
  }
}

export const artifactName = `process-lock-${process.platform}-${process.arch}.node`
export const manifestName = "process-lock-manifest.json"

export * as NativeFileLock from "./native-file-lock"
