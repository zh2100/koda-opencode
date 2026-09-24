import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"

const drivers: Record<string, string> = {
  ".gpkg": "GPKG",
  ".geojson": "GeoJSON",
  ".json": "GeoJSON",
  ".shp": "ESRI Shapefile",
  ".fgb": "FlatGeobuf",
}

export const formats = {
  GPKG: { driver: "GPKG", filename: "output.gpkg" },
  GeoJSON: { driver: "GeoJSON", filename: "output.geojson" },
  Shapefile: { driver: "ESRI Shapefile", filename: "output.shp" },
} as const

export type Request = {
  operation: "inspect" | "convert"
  source: string
  layer?: string
  destination?: string
  format?: keyof typeof formats
  sourceCRS?: string
  targetCRS?: string
  timeout?: number
}

export function localPath(value: string, directory: string) {
  const normalized = value.replaceAll("\\", "/")
  const withoutDrive = normalized.replace(/^[A-Za-z]:\//, "/")
  if (
    !value.trim() ||
    /[\x00-\x1f]/.test(value) ||
    normalized.startsWith("//") ||
    /(^|\/)vsi[^/]*(\/|$)/i.test(normalized) ||
    /[:=]/.test(withoutDrive) ||
    (/^[A-Za-z]:/.test(value) && process.platform !== "win32")
  ) {
    throw new Error("GIS accepts local filesystem paths only, not remote, VSI, device paths, or connection strings")
  }
  return path.resolve(directory, value)
}

export function validate(input: Request, directory: string) {
  const source = localPath(input.source, directory)
  const driver = drivers[path.extname(source).toLowerCase()]
  if (!driver) throw new Error("Supported inputs: .gpkg, .geojson, .json (GeoJSON), .shp, .fgb")
  if (input.layer !== undefined && (!input.layer.trim() || /^-/.test(input.layer) || /[\x00-\x1f]/.test(input.layer))) {
    throw new Error("Layer must be a nonempty name, not an option")
  }
  const timeout = input.timeout ?? 60_000
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 120_000) {
    throw new Error("Timeout must be an integer between 1 and 120000 milliseconds")
  }
  if (input.operation === "inspect") {
    if ([input.destination, input.format, input.sourceCRS, input.targetCRS].some((value) => value !== undefined)) {
      throw new Error("Destination, format and CRS parameters are only valid for conversion")
    }
    return { source, driver, timeout, destination: undefined }
  }
  if (input.operation !== "convert") throw new Error("Unknown GIS operation")
  if (!input.destination || !input.format || !Object.hasOwn(formats, input.format)) {
    throw new Error("Conversion requires a new destination directory and format (GPKG, GeoJSON or Shapefile)")
  }
  if (![input.sourceCRS, input.targetCRS].every((value) => value && /^EPSG:[1-9][0-9]{0,6}$/.test(value))) {
    throw new Error("Conversion requires explicit sourceCRS and targetCRS as EPSG:<positive code>; CRS is never guessed")
  }
  return { source, driver, timeout, destination: localPath(input.destination, directory) }
}

export function runtime(home = process.env.KODA_GDAL_HOME, platform = process.platform) {
  if (!home || !path.isAbsolute(home)) {
    throw new Error("Bundled GDAL unavailable: KODA_GDAL_HOME must point to an absolute bundled runtime prefix; system GDAL is not used")
  }
  localPath(home, home)
  const prefix = platform === "win32" ? path.join(home, "Library") : home
  const bin = path.join(prefix, "bin")
  // Do not inherit GDAL/PROJ configuration, plugins, credentials or library search paths.
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => /^(SystemRoot|WINDIR|TEMP|TMP|TMPDIR|LANG|LC_ALL)$/i.test(key)),
  )
  Object.assign(env, {
    PATH: bin,
    GDAL_DATA: path.join(prefix, "share", "gdal"),
    PROJ_DATA: path.join(prefix, "share", "proj"),
    PROJ_LIB: path.join(prefix, "share", "proj"),
    PROJ_NETWORK: "OFF",
    GDAL_DRIVER_PATH: "disable",
    GDAL_PAM_ENABLED: "NO",
    OGR_SQLITE_JOURNAL: "DELETE",
    GDAL_CONFIG_FILE: platform === "win32" ? "NUL" : "/dev/null",
    ...(platform === "win32" ? {} : {
      LD_LIBRARY_PATH: path.join(home, "lib"),
      DYLD_LIBRARY_PATH: path.join(home, "lib"),
    }),
  })
  return {
    ogrinfo: path.join(bin, platform === "win32" ? "ogrinfo.exe" : "ogrinfo"),
    ogr2ogr: path.join(bin, platform === "win32" ? "ogr2ogr.exe" : "ogr2ogr"),
    env,
  }
}

export type Command = {
  executable: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  signal: AbortSignal
  timeout: number
}

export type Runner = (command: Command) => Promise<{ stdout: string; stderr: string }>

export const run: Runner = (command) => {
  command.signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = execFile(command.executable, command.args, {
      cwd: command.cwd,
      env: command.env,
      signal: command.signal,
      timeout: command.timeout,
      maxBuffer: 1024 * 1024,
      killSignal: "SIGKILL",
      shell: false,
      windowsHide: true,
      encoding: "utf8",
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`GDAL failed (aborted, timed out, output limit, or process error): ${String(error.code ?? error.name)}\n${stderr.slice(0, 4096)}`))
        return
      }
      resolve({ stdout, stderr })
    })
    child.stdin?.end()
  })
}

export async function sourceFiles(source: string) {
  const canonical = localPath(await fs.realpath(source), path.dirname(source))
  if (!(await fs.stat(canonical)).isFile()) throw new Error("GIS source must be a regular file")
  if (path.extname(canonical).toLowerCase() !== path.extname(source).toLowerCase()) {
    throw new Error("GIS source symlink must preserve its format extension")
  }
  if (path.extname(source).toLowerCase() !== ".shp") return { source: canonical, files: [canonical] }
  const stem = path.basename(canonical, path.extname(canonical)).toLowerCase() + "."
  const files = (await fs.readdir(path.dirname(canonical)))
    .filter((name) => name.toLowerCase().startsWith(stem))
    .map((name) => path.join(path.dirname(canonical), name))
  for (const file of files) {
    if (!(await fs.lstat(file)).isFile()) throw new Error("Shapefile sidecars must be regular files, not symlinks")
  }
  return { source: canonical, files }
}

export async function execute(input: Request, source: string, destination: string | undefined, signal: AbortSignal, runner: Runner = run, bundle = runtime()) {
  const checked = validate({ ...input, source, destination }, path.dirname(source))
  const executable = input.operation === "inspect" ? bundle.ogrinfo : bundle.ogr2ogr
  for (const file of [executable, path.join(bundle.env.PROJ_DATA!, "proj.db")]) {
    if (!(await fs.stat(file).catch(() => undefined))?.isFile()) {
      throw new Error(`Bundled GDAL runtime is incomplete: missing ${file}. System GDAL is not used.`)
    }
  }
  if (!(await fs.stat(bundle.env.GDAL_DATA!).catch(() => undefined))?.isDirectory()) {
    throw new Error("Bundled GDAL runtime is incomplete: missing GDAL data directory")
  }
  signal.throwIfAborted()
  const output = destination && input.format ? path.join(destination, formats[input.format].filename) : undefined
  const args = input.operation === "inspect"
    ? ["-json", "-so", "-al", "-ro", "-if", checked.driver, source, ...(input.layer ? [input.layer] : [])]
    : ["-if", checked.driver, "-f", formats[input.format!].driver, "-s_srs", input.sourceCRS!, "-t_srs", input.targetCRS!,
        ...(input.layer || input.format !== "GPKG" ? ["-nln", "output"] : []), output!, source, ...(input.layer ? [input.layer] : [])]
  // Atomic, non-recursive mkdir rejects existing directories, files and symlinks.
  // Leave partial output on failure for inspection; never delete user data on an error path.
  if (destination) await fs.mkdir(destination)
  const result = await runner({ executable, args, cwd: path.dirname(source), env: bundle.env, signal, timeout: checked.timeout })
    .catch((error: unknown) => {
      throw new Error(`${error instanceof Error ? error.message.slice(0, 8192) : "GDAL failed"}${destination ? `\nPartial output may remain in ${destination}; retry with a new destination directory.` : ""}`)
    })
  if (input.operation === "convert") {
    return JSON.stringify({ destination, output, sourceCRS: input.sourceCRS, targetCRS: input.targetCRS, warnings: result.stderr.slice(0, 4096) }, null, 2)
  }
  // Summary-only ogrinfo excludes features. Bound the response separately from the process buffer.
  if (Buffer.byteLength(result.stdout) > 32 * 1024) {
    return result.stdout.slice(0, 32 * 1024) + "\n[GIS summary truncated; inspect a selected layer for a smaller summary]"
  }
  return result.stdout + (result.stderr ? `\nWarnings: ${result.stderr.slice(0, 4096)}` : "")
}

export * as Gdal from "./gdal"
