import fs from "fs"
import path from "path"
import { Schema } from "effect"
import { Hash } from "./hash"
import { LockIdentity, LockIdentityError } from "./lock-identity"

export const pathIdentityGeneration = "path-identity-v1"
export const nativeGeneration = "os-lock-v1"
export const nativeBackend = "native-file-v1"
export const keyFormat = "canonical-path-v1"

export class LockProtocolError extends Error {
  readonly reason: "permission-denied" | "identity-unresolved" | "protocol-blocked" | "protocol-invalid"

  constructor(
    reason: "permission-denied" | "identity-unresolved" | "protocol-blocked" | "protocol-invalid",
    detail: string,
  ) {
    super(detail)
    this.name = "LockProtocolError"
    this.reason = reason
  }
}

const Marker = Schema.Struct({
  schemaVersion: Schema.optional(Schema.Number),
  generation: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  backend: Schema.optional(Schema.String),
  keyFormat: Schema.optional(Schema.String),
  rootId: Schema.optional(Schema.String),
  epoch: Schema.optional(Schema.Number),
})

const Registration = Schema.Struct({
  schemaVersion: Schema.Number,
  rootId: Schema.String,
  data: Schema.String,
  config: Schema.String,
  state: Schema.String,
  cache: Schema.String,
  generation: Schema.String,
  requireManifest: Schema.Boolean,
  epoch: Schema.Number,
})

export type Registration = {
  readonly schemaVersion: 1
  readonly rootId: string
  readonly data: string
  readonly config: string
  readonly state: string
  readonly cache: string
  readonly generation: typeof nativeGeneration
  readonly requireManifest: true
  readonly epoch: number
}

export type Domain = "data" | "config" | "cache" | "state" | "external"

export type Decision = {
  readonly protocol: "legacy" | "path-identity-v1" | "os-lock-v1"
  readonly backend: "directory" | "native-file-v1"
  readonly domain: Domain
  readonly key: string
  readonly directory: string
  readonly epoch: number
  readonly rootId?: string
  readonly state: string
}

export type Paths = {
  readonly data: string
  readonly config: string
  readonly state: string
  readonly cache: string
}

export type ProtocolSnapshot = {
  readonly generation: typeof nativeGeneration
  readonly rootId: string
  readonly epoch: number
  readonly backend: typeof nativeBackend
  readonly keyFormat: typeof keyFormat
  readonly schemaVersion: 1
}

export type Context = Paths &
  (
    | { readonly registration?: undefined; readonly snapshot?: undefined }
    | { readonly registration: Registration; readonly snapshot: ProtocolSnapshot }
  )

export type Marker = {
  readonly schemaVersion?: number
  readonly generation?: string
  readonly status?: string
  readonly backend?: string
  readonly keyFormat?: string
  readonly rootId?: string
  readonly epoch?: number
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function fail(reason: LockProtocolError["reason"], target: string, detail: string): never {
  throw new LockProtocolError(reason, `${reason}: ${target}: ${detail}`)
}

function code(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error)) return
  return typeof error.code === "string" ? error.code : undefined
}

function isPermission(error: unknown) {
  const value = code(error)
  return value === "EACCES" || value === "EPERM"
}

function readJson(file: string): unknown {
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(file)
  } catch (error) {
    if (code(error) === "ENOENT") return undefined
    if (isPermission(error)) fail("permission-denied", file, error instanceof Error ? error.message : String(error))
    fail("identity-unresolved", file, "migration marker is unreadable")
  }
  if (!stat.isFile()) fail("protocol-invalid", file, "migration marker is a directory")
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch (error) {
    if (isPermission(error)) fail("permission-denied", file, error instanceof Error ? error.message : String(error))
    fail("identity-unresolved", file, "migration marker is corrupt")
  }
}

function present(record: object, field: string) {
  return Object.prototype.hasOwnProperty.call(record, field)
}

function stringField(record: object, field: string, file: string) {
  if (!present(record, field)) return
  const value = Reflect.get(record, field)
  if (typeof value !== "string") fail("protocol-invalid", file, `${field} has an invalid type`)
  return value
}

function numberField(record: object, field: string, file: string) {
  if (!present(record, field)) return
  const value = Reflect.get(record, field)
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    fail("protocol-invalid", file, `${field} has an invalid type`)
  }
  return value
}

function decodeMarker(file: string, input: unknown): Marker | undefined {
  if (input === undefined) return
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("protocol-invalid", file, "migration marker is corrupt")
  }
  const record = input
  const marker = {
    schemaVersion: numberField(record, "schemaVersion", file),
    generation: stringField(record, "generation", file),
    status: stringField(record, "status", file),
    backend: stringField(record, "backend", file),
    keyFormat: stringField(record, "keyFormat", file),
    rootId: stringField(record, "rootId", file),
    epoch: numberField(record, "epoch", file),
  }
  if (Schema.decodeUnknownOption(Marker)(marker)._tag === "None") {
    fail("protocol-invalid", file, "migration marker is corrupt")
  }
  return marker
}

function absolutePath(file: string, field: string, value: string | undefined) {
  if (!value) fail("protocol-invalid", file, "resource registration paths are missing")
  if (!path.isAbsolute(value) && !path.win32.isAbsolute(value)) {
    fail("protocol-invalid", file, `${field} must be an absolute path`)
  }
  return value
}

export function readRegistration(file: string): Registration | undefined {
  const input = readJson(file)
  if (input === undefined) return
  const decoded = Schema.decodeUnknownOption(Registration)(input)
  if (decoded._tag === "None" || !input || typeof input !== "object" || Array.isArray(input)) {
    fail("protocol-invalid", file, "resource registration is corrupt")
  }
  const generation = stringField(input, "generation", file)
  const requireManifest = Reflect.get(input, "requireManifest")
  const schemaVersion = numberField(input, "schemaVersion", file)
  const epoch = numberField(input, "epoch", file)
  const rootId = stringField(input, "rootId", file)
  if (requireManifest !== true) fail("protocol-invalid", file, "registered roots must require a manifest")
  if (schemaVersion !== 1 || generation !== nativeGeneration || epoch === undefined || epoch < 1) {
    fail("protocol-invalid", file, "resource registration version is unknown")
  }
  if (!rootId || !uuid.test(rootId)) fail("protocol-invalid", file, "resource registration root id is invalid")
  return {
    schemaVersion: 1,
    rootId,
    data: absolutePath(file, "data", stringField(input, "data", file)),
    config: absolutePath(file, "config", stringField(input, "config", file)),
    state: absolutePath(file, "state", stringField(input, "state", file)),
    cache: absolutePath(file, "cache", stringField(input, "cache", file)),
    generation: nativeGeneration,
    requireManifest: true,
    epoch,
  }
}

function samePath(left: string, right: string) {
  const resolvedLeft = path.resolve(left)
  const resolvedRight = path.resolve(right)
  if (process.platform === "win32") return resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
  return resolvedLeft === resolvedRight
}

export function readMarker(state: string): Marker | undefined {
  const file = LockIdentity.marker(state)
  return decodeMarker(file, readJson(file))
}

export function validateMarker(file: string, marker: Marker | undefined, registration: Registration): ProtocolSnapshot {
  if (!marker) fail("protocol-invalid", file, "registered root is missing its completed manifest")
  if (marker.status === "migrating") fail("protocol-blocked", file, "migration in progress blocks writes")
  if (marker.generation !== nativeGeneration || marker.status !== "complete") {
    fail("protocol-invalid", file, "registered root marker version is unknown or contradictory")
  }
  if (marker.schemaVersion !== 1 || marker.backend !== nativeBackend || marker.keyFormat !== keyFormat) {
    fail("protocol-invalid", file, "native generation fields are unknown or contradictory")
  }
  if (marker.epoch === undefined || marker.epoch < 1 || !marker.rootId || !uuid.test(marker.rootId)) {
    fail("protocol-invalid", file, "native generation root identity is invalid")
  }
  if (registration.rootId !== marker.rootId || registration.epoch !== marker.epoch || registration.generation !== marker.generation) {
    fail("protocol-invalid", file, "native generation does not match the registered root")
  }
  return {
    generation: nativeGeneration,
    rootId: marker.rootId,
    epoch: marker.epoch,
    backend: nativeBackend,
    keyFormat,
    schemaVersion: 1,
  }
}

export function unregistered(paths: Paths): Context {
  return paths
}

export function registered(registration: Registration, marker: Marker): Context {
  const file = LockIdentity.marker(registration.state)
  return {
    data: registration.data,
    config: registration.config,
    state: registration.state,
    cache: registration.cache,
    registration,
    snapshot: validateMarker(file, marker, registration),
  }
}

function assertContext(context: Context) {
  if (!context.registration) return
  const registration = context.registration
  const paths = [
    ["data", context.data, registration.data],
    ["config", context.config, registration.config],
    ["state", context.state, registration.state],
    ["cache", context.cache, registration.cache],
  ] as const
  for (const [field, actual, declared] of paths) {
    if (!samePath(actual, declared)) {
      fail("protocol-invalid", actual, `resource ${field} does not match the registered root`)
    }
  }
}

function domainOf(key: string, context: Context): Domain {
  const segment = LockIdentity.split(key).value
  const target = LockIdentity.pathSegment(segment)
  if (!target) return "data"
  const identity = LockIdentity.pathIdentity(target)
  const resolved = path.resolve(target)
  const roots = [
    ["data", context.data],
    ["config", context.config],
    ["cache", context.cache],
    ["state", context.state],
  ] as const
  const within = (candidate: string, root: string) => {
    const rootIdentity = LockIdentity.pathIdentity(root)
    return candidate === rootIdentity || candidate.startsWith(rootIdentity + path.sep)
  }
  const comparable = (value: string) => LockIdentity.pathIdentity(value)
  const specific = (matches: ReadonlyArray<readonly [Domain, string]>) => {
    const locations = [...new Set(matches.map(([, root]) => comparable(root)))]
    const longest = Math.max(...locations.map((location) => location.length))
    const selected = locations.filter((location) => location.length === longest)
    if (selected.length !== 1) return
    return matches.find(([, root]) => comparable(root) === selected[0])
  }
  const declared = specific(roots.filter(([, root]) => within(identity, root)))
  if (declared) return declared[0]
  const resolvedMatch = specific(roots.filter(([, root]) => within(resolved, root)))
  if (resolvedMatch) return resolvedMatch[0]
  return "external"
}

function historicalDirectory(context: Context, requested?: string) {
  return requested ? path.resolve(requested) : path.join(context.state, "locks")
}

function coordination(domain: Domain, context: Context, requested?: string) {
  const root = domain === "config" ? context.config : domain === "cache" ? context.cache : domain === "state" ? context.state : context.data
  const directory = domain === "external" ? path.join(context.state, "locks") : path.join(root, "locks")
  if (!requested) return directory
  const selected = path.resolve(requested)
  const allowed = [path.resolve(directory), path.resolve(context.state, "locks"), path.resolve(context.data, "locks")]
  if (!allowed.some((root) => selected === root || selected.startsWith(root + path.sep))) {
    fail("protocol-invalid", selected, "custom coordination directory is outside the selected resource domain")
  }
  return selected
}

function nativeDecision(file: string, marker: Marker, context: Context, key: string, requested?: string): Decision {
  if (!context.registration || !context.snapshot) {
    fail("protocol-invalid", file, "native generation requires a registered root")
  }
  const current = validateMarker(file, marker, context.registration)
  if (
    current.rootId !== context.snapshot.rootId ||
    current.epoch !== context.snapshot.epoch ||
    current.generation !== context.snapshot.generation
  ) {
    fail("protocol-invalid", file, "adopted protocol snapshot changed; reselect the resource root")
  }
  const parts = LockIdentity.split(key)
  const canonical = LockIdentity.pathSegment(parts.value) ? LockIdentity.key(key) : key
  const domain = domainOf(key, context)
  if (LockIdentity.pathSegment(parts.value) && domain === "external") {
    fail("protocol-invalid", key, "external targets are not in the migrated resource inventory")
  }
  return {
    protocol: "os-lock-v1",
    backend: "native-file-v1",
    domain,
    key: canonical,
    directory: path.join(path.dirname(coordination(domain, context, requested)), "locks-native-v1"),
    epoch: current.epoch,
    rootId: current.rootId,
    state: context.state,
  }
}

function legacyDecision(context: Context, key: string, requested?: string): Decision {
  return {
    protocol: "legacy",
    backend: "directory",
    domain: domainOf(key, context),
    key,
    directory: historicalDirectory(context, requested),
    epoch: 0,
    state: context.state,
  }
}

export function resolve(key: string, context: Context, requested?: string): Decision {
  assertContext(context)
  const file = LockIdentity.marker(context.state)
  const marker = decodeMarker(file, readJson(file))
  if (context.registration) {
    if (!marker) fail("protocol-invalid", file, "registered root is missing its completed manifest")
    if (marker.generation !== nativeGeneration) {
      fail("protocol-invalid", file, "adopted protocol snapshot changed; reselect the resource root")
    }
    return nativeDecision(file, marker, context, key, requested)
  }
  if (marker?.status === "migrating") fail("protocol-blocked", file, "migration in progress blocks writes")
  if (!marker) return legacyDecision(context, key, requested)
  if (marker.generation === pathIdentityGeneration && (marker.status === undefined || marker.status === "complete")) {
    if (marker.backend || marker.keyFormat || marker.rootId || marker.epoch !== undefined || marker.schemaVersion !== undefined) {
      fail("protocol-invalid", file, "path identity marker contains contradictory fields")
    }
    const parts = LockIdentity.split(key)
    return {
      protocol: "path-identity-v1",
      backend: "directory",
      domain: domainOf(key, context),
      key: LockIdentity.pathSegment(parts.value) ? LockIdentity.key(key) : key,
      directory: historicalDirectory(context, requested),
      epoch: 0,
      state: context.state,
    }
  }
  if (marker.generation === nativeGeneration) return nativeDecision(file, marker, context, key, requested)
  fail("protocol-invalid", file, "migration marker version is unknown or contradictory")
}

export function file(decision: Decision) {
  return path.join(decision.directory, `${Hash.fast(decision.key)}.lock`)
}

export function confirmCurrent(key: string, context: Context, requested: string | undefined, granted: Decision) {
  const current = resolve(key, context, requested)
  if (
    current.protocol !== granted.protocol ||
    current.backend !== granted.backend ||
    current.domain !== granted.domain ||
    current.key !== granted.key ||
    current.directory !== granted.directory ||
    current.epoch !== granted.epoch ||
    current.rootId !== granted.rootId ||
    current.state !== granted.state
  ) {
    fail("protocol-blocked", LockIdentity.marker(context.state), "protocol changed while waiting for the lock")
  }
}

export function fromIdentity(error: unknown): LockProtocolError {
  if (error instanceof LockProtocolError) return error
  if (error instanceof LockIdentityError) {
    return new LockProtocolError(error.reason === "permission-denied" ? "permission-denied" : "identity-unresolved", error.message)
  }
  return new LockProtocolError("identity-unresolved", error instanceof Error ? error.message : String(error))
}

export * as LockProtocol from "./lock-protocol"
