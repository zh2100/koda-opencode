export * as AtomicDocument from "./atomic-document"

import fs from "node:fs/promises"
import { isUtf8 } from "node:buffer"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { execFile } from "node:child_process"

export type Input = { file: string; before: string | undefined; text: string; onCommitted?: () => void; securitySource?: string }
export type Result = { committed: true; cleanupPending: boolean }
export class CommitError extends Error {
  constructor(readonly stage: "prepare" | "unknown", override readonly cause: unknown) {
    super(`Configuration document ${stage} failed`)
  }
}
type ObjectRecord = { path: string; dev?: number; ino?: number; digest?: string; done: boolean }
type HandleDuty = { handle?: fs.FileHandle; state: "open" | "closing" | "closed" | "uncertain"; closing?: Promise<boolean>; closeError?: unknown }
type Operation = {
  id: string
  state: "active" | "retryable" | "quarantined" | "unidentified"
  file?: ObjectRecord
  directory?: ObjectRecord
  handle?: HandleDuty
  creation?: "pending" | "none"
  cleanupTask?: Promise<void>
}
type Claim = { status: "completed" } | { status: "blocked" | "stale" } | { status: "task"; task: Promise<void> }
const operations = new Map<string, Operation>()
const unresolved = new Set<string>()
let cleaning = false
const identity = (file: string) => process.platform === "win32" ? file.toLowerCase() : file
const absent = (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"

// Bun 1.4.3 marks fd closed before close(fd) finishes and fulfills a repeated close without retrying it.
// Only the original FileHandle.close fulfillment is closed evidence; rejection stays uncertain and is never retried.
function closeOwned(duty: HandleDuty | undefined) {
  if (!duty || duty.state === "closed") return Promise.resolve(true)
  if (duty.state === "uncertain") return Promise.resolve(false)
  if (duty.closing) return duty.closing
  const handle = duty.state === "open" ? duty.handle : undefined
  if (!handle) {
    duty.state = "uncertain"
    return Promise.resolve(false)
  }
  duty.state = "closing"
  duty.handle = undefined
  const closing = Promise.resolve().then(() => handle.close()).then(() => {
    duty.state = "closed"
    duty.closing = undefined
    return true
  }, (error) => {
    duty.state = "uncertain"
    duty.handle = handle
    duty.closeError = error
    duty.closing = undefined
    return false
  })
  duty.closing = closing
  return closing
}

function operationPending(operation: Operation) {
  return operation.creation === "pending" || operation.state === "unidentified" || operation.state === "quarantined" || operation.file?.done === false || operation.directory?.done === false || (operation.handle !== undefined && operation.handle.state !== "closed")
}

function canRunCleanup(operation: Operation) {
  if (operation.state !== "retryable" || operation.creation === "pending") return false
  return !operation.handle || operation.handle.state === "closed" || operation.handle.state === "open"
}

function claimCleanup(operation: Operation, wait: boolean): Claim {
  if (operation.cleanupTask) return wait ? { status: "task", task: operation.cleanupTask } : { status: "blocked" }
  if (operations.get(operation.id) !== operation) return { status: "stale" }
  if (!operationPending(operation)) return { status: "completed" }
  if (!canRunCleanup(operation)) return { status: "blocked" }
  const task = Promise.resolve().then(() => runCleanup(operation))
  operation.cleanupTask = task
  return { status: "task", task }
}

async function runCleanup(operation: Operation) {
  const task = operation.cleanupTask
  try {
    if (operations.get(operation.id) !== operation || operation.state !== "retryable") return
    if (operation.handle?.state === "open" && !await closeOwned(operation.handle)) throw descriptorStillOpen(operation.handle)
    if (operation.handle && operation.handle.state !== "closed") return
    if (operation.file && !operation.file.done) await finishObject(operation.file, "file")
    if (operation.directory && !operation.directory.done && operation.file?.done !== false) await finishObject(operation.directory, "directory")
    if (operations.get(operation.id) === operation && !operationPending(operation)) operations.delete(operation.id)
  } finally {
    if (operation.cleanupTask === task) operation.cleanupTask = undefined
  }
}

async function finishObject(record: ObjectRecord, kind: "file" | "directory") {
  const current = await fs.lstat(record.path).catch((error) => { if (absent(error)) return; throw error })
  if (!current) {
    record.done = true
    return
  }
  if (record.dev !== undefined && (current.dev !== record.dev || current.ino !== record.ino)) throw new Error("Temporary document identity changed")
  if (kind === "file") {
    if (record.digest && createHash("sha256").update(await fs.readFile(record.path)).digest("hex") !== record.digest) throw new Error("Retired document version changed")
    await fs.unlink(record.path)
    record.done = true
    return
  }
  if (!current.isDirectory() || current.isSymbolicLink()) throw new Error("Temporary directory identity changed")
  if ((await fs.readdir(record.path)).length > 0) throw new Error("Temporary directory is not empty")
  const again = await fs.lstat(record.path)
  if (again.dev !== current.dev || again.ino !== current.ino || !again.isDirectory() || again.isSymbolicLink()) throw new Error("Temporary directory identity changed")
  await fs.rmdir(record.path)
  record.done = true
}

function descriptorStillOpen(duty: HandleDuty | undefined) {
  return new Error("Temporary document descriptor remains open", duty?.closeError === undefined ? undefined : { cause: duty.closeError })
}

function waitDirect(operation: Operation) {
  const claim = claimCleanup(operation, true)
  if (claim.status === "completed") return Promise.resolve()
  if (claim.status === "task") return claim.task
  return Promise.reject(new Error(claim.status === "stale" ? "Temporary document cleanup lost its record" : "Temporary document cleanup is blocked"))
}

/** Copy source security metadata into a new sibling file before its first byte is written. */
export async function publishCopy(source: string, destination: string, text: string) {
  const existing = await fs.lstat(destination).catch((error) => { if (absent(error)) return; throw error })
  if (existing) throw new CommitError("prepare", new Error("Backup already exists"))
  return publish({ file: destination, before: undefined, text, securitySource: source })
}

/** Retire only the exact legacy source captured before a successful publication. */
export async function retire(file: string, owner: { dev: number; ino: number; digest: string }) {
  // An unlinked file's inode can be immediately reused by its successor. Never
  // infer the missing version from the path we are about to remove.
  if (typeof owner.digest !== "string" || !/^[0-9a-f]{64}$/.test(owner.digest)) throw new Error("Missing or invalid captured document digest")
  const id = `retire:${identity(file)}:${owner.dev}:${owner.ino}:${owner.digest}`
  const current = operations.get(id)
  if (current?.file?.dev === owner.dev && current.file.ino === owner.ino && current.file.digest === owner.digest) return waitDirect(current)
  const operation: Operation = { id, state: "retryable", file: { path: file, ...owner, done: false } }
  operations.set(operation.id, operation)
  await waitDirect(operation)
}

// ReplaceFileW preserves the replaced file's security descriptor. Node rename on
// Windows does not provide that contract. No document bytes go through the shell.
function windowsFileOperation(script: string, from: string, to: string) {
  return new Promise<void>((resolve, reject) => execFile("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64"),
  ], { windowsHide: true, env: { ...process.env, OPENCODE_REPLACE_FROM: from, OPENCODE_REPLACE_TO: to } }, (error) => error ? reject(error) : resolve()))
}

function replaceWindows(from: string, to: string) {
  return windowsFileOperation("$ErrorActionPreference='Stop'; [System.IO.File]::Replace($env:OPENCODE_REPLACE_FROM,$env:OPENCODE_REPLACE_TO,[System.Management.Automation.Language.NullString]::Value,$false)", from, to)
}

function protectedDescriptor() {
  return "$me=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $dacl=[System.Security.AccessControl.DirectorySecurity]::new(); $dacl.SetAccessRuleProtection($true,$false); $dacl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($me,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))"
}

// The directory ACL is supplied to the create call. A later chmod cannot revoke a handle opened against a wide directory.
function createProtectedStage(stage: string) {
  if (process.platform !== "win32") return fs.mkdir(stage, 0o700)
  const script = `$ErrorActionPreference='Stop'; ${protectedDescriptor()}; [System.IO.Directory]::CreateDirectory($env:OPENCODE_REPLACE_TO,$dacl) | Out-Null`
  return windowsFileOperation(script, path.dirname(stage), stage)
}

// Invalid bytes must match neither a valid document containing U+FFFD nor an absent file.
async function readVersion(file: string) {
  const bytes = await fs.readFile(file)
  return isUtf8(bytes) ? bytes.toString("utf8") : null
}

/** Caller holds ConfigDocument's existing lock throughout read, publish and receipt. */
export async function publish(input: Input): Promise<Result> {
  await retryCleanup()
  const logical = path.resolve(input.file)
  const parent = await fs.realpath(path.dirname(logical))
  const link = await fs.lstat(logical).catch((error) => { if (absent(error)) return; throw error })
  const target = link ? await fs.realpath(logical) : path.join(parent, path.basename(logical))
  if (unresolved.has(identity(target))) throw new CommitError("unknown", new Error("Previous publication requires reconciliation"))
  const previous = await fs.stat(target).catch((error) => { if (absent(error)) return; throw error })
  if (previous && (!previous.isFile() || previous.nlink > 1 || !(previous.mode & 0o222))) throw new CommitError("prepare", new Error("Unsupported or read-only target"))
  const before = previous ? await readVersion(target) : undefined
  if (before !== input.before) throw new CommitError("prepare", new Error("Configuration version changed"))
  const stage = path.join(path.dirname(target), `.opencode-stage-${randomUUID()}`)
  const operation: Operation = { id: stage, state: "active", creation: "pending" }
  operations.set(operation.id, operation)
  const temporary = path.join(stage, "document.tmp")
  let handle: fs.FileHandle | undefined
  let owner: { dev: number; ino: number } | undefined
  try {
    await createProtectedStage(stage)
    const stageStat = await fs.lstat(stage).catch(() => undefined)
    if (!stageStat?.isDirectory() || stageStat.isSymbolicLink()) {
      operation.state = "unidentified"
      throw new Error("Temporary directory identity is unconfirmed")
    }
    operation.directory = { path: stage, dev: stageStat.dev, ino: stageStat.ino, done: false }
    handle = await fs.open(temporary, "wx", 0o600)
    operation.handle = { handle, state: "open" }
    const stat = await handle.stat()
    owner = { dev: stat.dev, ino: stat.ino }
    operation.file = { path: temporary, dev: stat.dev, ino: stat.ino, done: false }
    operation.creation = undefined
    if (previous && process.platform !== "win32") {
      await handle.chown(previous.uid, previous.gid)
      await handle.chmod(previous.mode & 0o777)
    }
    if (process.platform === "win32") {
      // Copy an existing DACL, or install a current-user DACL, before any document bytes.
      const descriptorSource = input.securitySource ?? (previous ? target : undefined)
      const script = descriptorSource
        ? "$ErrorActionPreference='Stop'; $acl=[System.IO.File]::GetAccessControl($env:OPENCODE_REPLACE_FROM); $copy=[System.Security.AccessControl.FileSecurity]::new(); $copy.SetSecurityDescriptorSddlForm($acl.GetSecurityDescriptorSddlForm('Access, Owner, Group'),'Access, Owner, Group'); [System.IO.File]::SetAccessControl($env:OPENCODE_REPLACE_TO,$copy)"
        : `$ErrorActionPreference='Stop'; $me=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $copy=[System.Security.AccessControl.FileSecurity]::new(); $copy.SetAccessRuleProtection($true,$false); $copy.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($me,'FullControl','Allow')); [System.IO.File]::SetAccessControl($env:OPENCODE_REPLACE_TO,$copy)`
      await windowsFileOperation(script, descriptorSource ?? temporary, temporary)
    }
    if (!previous && process.platform !== "win32" && input.securitySource) {
      const sourceStat = await fs.stat(input.securitySource)
      await handle.chown(sourceStat.uid, sourceStat.gid)
      await handle.chmod(sourceStat.mode & 0o777)
    }
    await handle.writeFile(input.text, "utf8")
    await handle.sync()
    if (!await closeOwned(operation.handle)) throw descriptorStillOpen(operation.handle)
    if (await readVersion(temporary) !== input.text) throw new Error("Temporary document validation failed")
    if (identity(await fs.realpath(path.dirname(logical))) !== identity(parent)) throw new Error("Configuration parent changed")
    if (link && identity(await fs.realpath(logical)) !== identity(target)) throw new Error("Configuration link changed")
    const current = await fs.stat(target).catch((error) => { if (absent(error)) return; throw error })
    if (previous && (!current || current.dev !== previous.dev || current.ino !== previous.ino || await readVersion(target) !== input.before)) throw new Error("Configuration version changed")
    try {
      if (!previous) await fs.link(temporary, target) // atomic no-replace publication
      else if (process.platform === "win32") await replaceWindows(temporary, target)
      else await fs.rename(temporary, target)
    } catch (error) {
      // A helper process can exit after publication but before acknowledging it.
      // Confirm ownership rather than reporting an uncommitted save or retrying.
      let outcomeMissing = false
      const outcome = await fs.stat(target).catch((error) => {
        outcomeMissing = absent(error)
        return undefined
      })
      const text = outcome ? await readVersion(target).catch(() => undefined) : undefined
      if (outcome === undefined && !outcomeMissing) {
        unresolved.add(identity(target))
        operation.state = "quarantined"
        throw new CommitError("unknown", error)
      }
      if (outcome?.dev === owner?.dev && outcome.ino === owner?.ino && text === input.text) {
        // Publication is confirmed even if the helper acknowledgement failed.
      } else if ((!previous && outcomeMissing) || (previous && outcome?.dev === previous.dev && outcome.ino === previous.ino && text === input.before) || (!previous && outcome && (outcome.dev !== owner?.dev || outcome.ino !== owner?.ino))) {
        throw error
      } else {
        unresolved.add(identity(target))
        operation.state = "quarantined"
        throw new CommitError("unknown", error)
      }
    }
    operation.state = "retryable"
  } catch (cause) {
    // Recover identity from the still-owned handle, never from an untrusted pathname.
    if (!operation.file && operation.handle?.state === "open" && operation.handle.handle) {
      const stat = await operation.handle.handle.stat().catch(() => undefined)
      if (stat) operation.file = { path: temporary, dev: stat.dev, ino: stat.ino, done: false }
      if (!stat) operation.state = "unidentified"
    }
    await closeOwned(operation.handle)
    if (!handle && operation.creation === "pending" && !operation.directory) {
      const current = await fs.lstat(stage).catch((error) => absent(error) ? null : undefined)
      if (current === null) {
        operation.creation = "none"
        operation.directory = undefined
        if (!operationPending(operation)) operations.delete(operation.id)
      }
      if (current !== null) operation.state = "unidentified"
    }
    if (operation.directory && !operation.file) {
      const entries = await fs.readdir(operation.directory.path).catch(() => undefined)
      if (entries && entries.length > 0) operation.state = "unidentified"
    }
    if (cause instanceof CommitError && cause.stage === "unknown") throw cause
    if (operation.state === "active") {
      operation.state = "retryable"
      operation.creation = undefined
    }
    if (operation.state === "retryable") await waitDirect(operation).catch(() => undefined)
    throw new CommitError("prepare", cause)
  }
  const claim = claimCleanup(operation, true)
  // Receipts and cleanup cannot change the already committed filesystem result.
  try { input.onCommitted?.() } catch { /* publication remains committed */ }
  if (claim.status === "task") await claim.task.catch(() => undefined)
  return { committed: true, cleanupPending: operationPending(operation) }
}

export async function retryCleanup() {
  if (cleaning) return counts()
  cleaning = true
  const claimed: Promise<void>[] = []
  try {
    for (const operation of [...operations.values()]) {
      const claim = claimCleanup(operation, false)
      if (claim.status === "task") claimed.push(claim.task.catch(() => undefined))
    }
    await Promise.all(claimed)
  } finally {
    cleaning = false
  }
  return counts()
}

function counts() {
  const open = [...operations.values()]
  return {
    remaining: open.filter(operationPending).length,
    failed: open.filter((operation) => operation.state === "quarantined" || operation.state === "unidentified" || (operation.state === "retryable" && operationPending(operation))).length,
  }
}
