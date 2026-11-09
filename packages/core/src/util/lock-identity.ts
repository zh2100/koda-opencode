import fs from "fs"
import path from "path"
import { FSUtil } from "../fs-util"

export const generation = "path-identity-v1"
const markerName = "path-identity.json"

export class LockIdentityError extends Error {
  readonly reason: "permission-denied" | "identity-unresolved" | "protocol-blocked"

  constructor(reason: "permission-denied" | "identity-unresolved" | "protocol-blocked", detail: string) {
    super(detail)
    this.name = "LockIdentityError"
    this.reason = reason
  }
}

function code(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error)) return
  return typeof error.code === "string" ? error.code : undefined
}

function resolveExisting(target: string) {
  try {
    return fs.realpathSync.native(target)
  } catch (error) {
    if (isPermission(error)) fail("permission-denied", target, error)
    fail("identity-unresolved", target, error)
  }
}

function fail(reason: LockIdentityError["reason"], target: string, error?: unknown): never {
  if (error instanceof LockIdentityError) throw error
  const detail = error instanceof Error ? error.message : error ? String(error) : target
  throw new LockIdentityError(reason, `${reason}: ${target}: ${detail}`)
}

function isPermission(error: unknown) {
  const value = code(error)
  return value === "EACCES" || value === "EPERM"
}

function isAbsolute(target: string) {
  return path.isAbsolute(target) || path.win32.isAbsolute(target)
}

// A lock segment is a filesystem path only when it is absolute. Relative
// business identifiers can contain separators and stay literal.
export function pathSegment(segment: string) {
  const normalized = FSUtil.windowsPath(segment)
  return isAbsolute(normalized) ? path.resolve(normalized) : undefined
}

function existingAncestor(target: string) {
  const remainder: string[] = []
  let current = target
  while (true) {
    try {
      fs.lstatSync(current)
      return { ancestor: current, remainder }
    } catch (error) {
      if (isPermission(error)) fail("permission-denied", current, error)
      if (code(error) !== "ENOENT") fail("identity-unresolved", current, error)
      const parent = path.dirname(current)
      // A missing path may continue through several directories that do not exist yet.
      // The search stops at the nearest existing ancestor. A root that never exists
      // has no ancestor and must fail.
      if (parent === current) fail("identity-unresolved", target, error)
      remainder.unshift(path.basename(current))
      current = parent
    }
  }
}

export function marker(state: string) {
  return path.join(state, markerName)
}

export function pathIdentity(input: string) {
  const target = pathSegment(input)
  if (!target) fail("identity-unresolved", input)
  const found = existingAncestor(target)
  const ancestor = resolveExisting(found.ancestor)
  const resolved = found.remainder.length ? path.join(ancestor, ...found.remainder) : ancestor
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

export function split(input: string) {
  if (/^[A-Za-z]:[\\/]/.test(input)) return { prefix: "", value: input }
  const match = input.match(/^([A-Za-z][A-Za-z0-9_-]*):(.*)$/)
  if (!match) return { prefix: "", value: input }
  if (!pathSegment(match[2])) return { prefix: "", value: input }
  return { prefix: match[1], value: match[2] }
}

export function same(left: string, right: string) {
  return key(left) === key(right)
}

export function samePath(left: string, right: string) {
  const leftPath = pathSegment(left)
  const rightPath = pathSegment(right)
  if (!leftPath || !rightPath) return false
  return pathIdentity(leftPath) === pathIdentity(rightPath)
}

export function key(input: string) {
  const parts = split(input)
  const segment = pathSegment(parts.value)
  if (!segment) return input
  const identity = pathIdentity(segment)
  return parts.prefix ? `${parts.prefix}:${identity}` : identity
}

export * as LockIdentity from "./lock-identity"
