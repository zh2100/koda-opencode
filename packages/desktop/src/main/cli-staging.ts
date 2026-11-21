import { createHash } from "node:crypto"
import { createReadStream, existsSync, lstatSync, readFileSync } from "node:fs"
import { chmod, copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

export type Logger = {
  log(message: string, meta?: Record<string, unknown>): void
  error(message: string, meta?: Record<string, unknown>): void
}

export type NativeSpec = {
  readonly required: boolean
  readonly platform: string
  readonly arch: string
  readonly libc?: string
}

export type StageInput = {
  readonly source: string
  readonly stagingRoot: string
  readonly version: string
  readonly native: NativeSpec
  readonly logger: Logger
  readonly executableName: string
  readonly liveDirectories?: ReadonlyArray<string>
}

type Manifest = {
  readonly schemaVersion: number
  readonly module: string
  readonly napi: string
  readonly platform: string
  readonly arch: string
  readonly libc?: string
  readonly file: string
  readonly sha256: string
}

type Ready = {
  readonly schemaVersion: 1
  readonly fingerprint: string
  readonly version: string
  readonly executable: string
  readonly executableSha256: string
  readonly manifestSha256?: string
  readonly module?: string
  readonly moduleSha256?: string
}

const readyName = "READY"

export async function stageCli(input: StageInput) {
  const sourcePackage = await inspect(dirname(input.source), input.native, basename(input.source))
  const fingerprint = packageFingerprint(input.version, sourcePackage)
  const directory = join(input.stagingRoot, `${safe(input.version)}-${fingerprint.slice(0, 12)}`)
  const destination = join(directory, input.executableName)
  if (await reusable(directory, fingerprint, input)) {
    input.logger.log("v2 CLI staged package reused", { path: destination, version: input.version, fingerprint })
    return { binary: destination, directory, installed: false, fingerprint }
  }
  const preparing = join(input.stagingRoot, `.preparing-${process.pid}-${Date.now()}`)
  await mkdir(preparing, { recursive: true })
  try {
    await publish(preparing, input, sourcePackage, fingerprint)
    await rename(preparing, directory).catch(async () => {
      if (!(await reusable(directory, fingerprint, input))) {
        throw new Error("staged CLI package is incomplete")
      }
    })
  } catch (error) {
    await rm(preparing, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
  input.logger.log("v2 CLI package staged", { source: input.source, path: destination, version: input.version, fingerprint })
  return { binary: destination, directory, installed: true, fingerprint }
}

export async function retainLiveDirectories(parent: string, live: ReadonlyArray<string>, logger: Logger) {
  const entries = await readdir(parent, { withFileTypes: true }).catch(() => [])
  const retained = entries.filter((entry) => entry.isDirectory())
  logger.log("v2 CLI staged directories retained", {
    parent,
    retained: retained.map((entry) => entry.name),
    live: live.map((entry) => basename(entry)),
  })
  return retained.map((entry) => entry.name)
}

async function publish(preparing: string, input: StageInput, source: Awaited<ReturnType<typeof inspect>>, fingerprint: string) {
  const executable = join(preparing, input.executableName)
  await copyFile(input.source, executable)
  if (process.platform !== "win32") await chmod(executable, 0o755)
  const executableSha256 = await fileDigest(executable)
  if (executableSha256 !== source.executableSha256) throw new Error("staged CLI executable digest changed during copy")
  let manifestSha256: string | undefined
  let module: string | undefined
  let moduleSha256: string | undefined
  if (source.manifest) {
    const targetManifest = join(preparing, "process-lock-manifest.json")
    const targetModule = join(preparing, basename(source.manifest.file))
    await copyFile(source.modulePath!, targetModule)
    moduleSha256 = await fileDigest(targetModule)
    if (moduleSha256 !== source.manifest.sha256) throw new Error("staged native module digest does not match its manifest")
    await writeFile(targetManifest, source.manifestText!)
    manifestSha256 = await fileDigest(targetManifest)
    module = basename(targetModule)
  }
  const ready: Ready = {
    schemaVersion: 1,
    fingerprint,
    version: input.version,
    executable: input.executableName,
    executableSha256,
    ...(manifestSha256 ? { manifestSha256, module, moduleSha256 } : {}),
  }
  await writeFile(join(preparing, readyName), JSON.stringify(ready))
}

async function reusable(directory: string, fingerprint: string, input: StageInput) {
  if (!existsSync(directory)) return false
  const readyFile = join(directory, readyName)
  if (!existsSync(readyFile)) return false
  const ready = JSON.parse(await readFile(readyFile, "utf8")) as Partial<Ready>
  if (ready.schemaVersion !== 1 || ready.fingerprint !== fingerprint || ready.version !== input.version) return false
  const executable = join(directory, input.executableName)
  if (!ready.executableSha256 || (await fileDigest(executable)) !== ready.executableSha256) return false
  if (input.native.required && (!ready.module || !ready.moduleSha256 || !ready.manifestSha256)) return false
  if (ready.module) {
    const module = contained(directory, ready.module)
    const manifest = contained(directory, "process-lock-manifest.json")
    if ((await fileDigest(module)) !== ready.moduleSha256) return false
    if ((await fileDigest(manifest)) !== ready.manifestSha256) return false
  }
  return true
}

async function inspect(directory: string, native: NativeSpec, executableName: string) {
  const executable = contained(directory, executableName)
  const executableSha256 = await fileDigest(executable)
  const manifestPath = join(directory, "process-lock-manifest.json")
  if (!existsSync(manifestPath)) {
    if (native.required) throw new Error("declared native lock package is missing its manifest")
    return { executableSha256 }
  }
  const manifestText = await readFile(manifestPath, "utf8")
  const parsed = JSON.parse(manifestText) as Partial<Manifest>
  if (
    parsed.schemaVersion !== 1 ||
    parsed.module !== "process-lock" ||
    !parsed.file ||
    !parsed.sha256 ||
    !/^[0-9a-f]{64}$/i.test(parsed.sha256) ||
    parsed.platform !== native.platform ||
    parsed.arch !== native.arch ||
    (native.libc && parsed.libc !== native.libc)
  ) {
    throw new Error("native lock manifest does not match the target package")
  }
  const modulePath = contained(directory, parsed.file)
  if ((await fileDigest(modulePath)) !== parsed.sha256) throw new Error("native lock module digest does not match its manifest")
  return { executableSha256, manifest: parsed as Manifest, manifestText, modulePath }
}

function contained(root: string, file: string) {
  if (isAbsolute(file) || file.split(/[\\/]/).includes("..")) throw new Error("staged package path escapes its directory")
  const target = resolve(root, file)
  const parent = resolve(root)
  if (target !== parent && !target.startsWith(parent + sep)) throw new Error("staged package path escapes its directory")
  const stat = lstatSync(target)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("staged package entry must be a regular file")
  return target
}

function packageFingerprint(version: string, source: Awaited<ReturnType<typeof inspect>>) {
  const fields = [
    ["version", version],
    ["executable", source.executableSha256],
    ["manifest", source.manifestText ? digest(source.manifestText) : ""],
    ["module", source.manifest?.sha256 ?? ""],
  ]
  return digest(fields.map(([name, value]) => `${name}:${value.length}:${value}`).join("\n"))
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

async function fileDigest(file: string) {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest("hex")
}

function safe(version: string) {
  return version.replace(/[^a-zA-Z0-9._-]/g, "-")
}

export function relativeInside(parent: string, target: string) {
  const value = relative(resolve(parent), resolve(target))
  return value !== "" && !value.startsWith("..") && !isAbsolute(value)
}
