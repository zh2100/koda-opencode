#!/usr/bin/env bun
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { $ } from "bun"

const packageDir = resolve(dirname(import.meta.path), "..")
const platform = process.platform
const arch = process.env.OPENCODE_ELECTRON_ARCH || process.env.npm_config_arch || process.arch
const target = `${platform}-${arch}`
const destination = join(packageDir, "resources", "gdal", target)
const required =
  platform === "win32"
    ? ["Library/bin/ogrinfo.exe", "Library/bin/ogr2ogr.exe", "Library/share/gdal", "Library/share/proj/proj.db"]
    : ["bin/ogrinfo", "bin/ogr2ogr", "share/gdal", "share/proj/proj.db"]

const archiveUrl = process.env.KODA_GDAL_ARCHIVE_URL
const archiveSha256 = process.env.KODA_GDAL_ARCHIVE_SHA256?.toLowerCase()
const vendor = join(packageDir, "vendor", "gdal", target)
const source = process.env.KODA_GDAL_HOME
  ? resolve(process.env.KODA_GDAL_HOME)
  : !archiveUrl && existsSync(vendor)
    ? vendor
    : undefined

async function validate(prefix: string) {
  for (const relative of required) {
    const path = join(prefix, relative)
    const info = await stat(path).catch(() => undefined)
    if (!info || (relative.endsWith("/gdal") ? !info.isDirectory() : !info.isFile() || info.size === 0)) {
      throw new Error(`GDAL prefix is incomplete for ${target}: missing ${relative} in ${prefix}`)
    }
  }
}

if (source && !existsSync(source)) throw new Error(`KODA_GDAL_HOME does not exist: ${source}`)
if (!source && !archiveUrl) {
  if (process.env.KODA_BUNDLE_GDAL !== "1") {
    console.warn(`Skipping optional GDAL staging for ${target}; set KODA_BUNDLE_GDAL=1 to require a bundled runtime.`)
    process.exit(0)
  }
  throw new Error(`GDAL packaging requires KODA_GDAL_HOME or KODA_GDAL_ARCHIVE_URL for ${target}.`)
}
if (!source && (!archiveSha256 || !/^[a-f0-9]{64}$/.test(archiveSha256))) {
  throw new Error("KODA_GDAL_ARCHIVE_SHA256 must be a 64-character SHA-256 checksum when downloading GDAL")
}

const temporary = await mkdtemp(join(tmpdir(), "koda-gdal-"))
try {
  let input = source
  if (!input) {
    if (new URL(archiveUrl!).protocol !== "https:") throw new Error("GDAL archive URL must use HTTPS")
    const archive = join(packageDir, ".cache", "gdal", `${archiveSha256}.tar.gz`)
    if (!existsSync(archive)) {
      const response = await fetch(archiveUrl!, { signal: AbortSignal.timeout(120_000) })
      if (!response.ok) throw new Error(`Failed to download GDAL archive: HTTP ${response.status}`)
      await mkdir(dirname(archive), { recursive: true })
      await writeFile(archive, Buffer.from(await response.arrayBuffer()))
    }
    const digest = createHash("sha256")
      .update(await readFile(archive))
      .digest("hex")
    if (digest !== archiveSha256) {
      await rm(archive, { force: true })
      throw new Error(`GDAL archive checksum mismatch: expected ${archiveSha256}, got ${digest}`)
    }
    const extracted = join(temporary, "prefix")
    await mkdir(extracted)
    await $`tar -xzf ${archive} -C ${extracted}`
    input = extracted
  }

  await validate(input!)

  if (resolve(input!) !== destination) {
    await rm(destination, { recursive: true, force: true })
    await mkdir(dirname(destination), { recursive: true })
    await cp(input!, destination, { recursive: true, dereference: true })
  }
  await validate(destination)
  if (arch === process.arch) {
    const prefix = platform === "win32" ? join(destination, "Library") : destination
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => /^(SystemRoot|WINDIR|TEMP|TMP|TMPDIR|LANG|LC_ALL)$/i.test(key)),
    )
    Object.assign(env, {
      PATH: join(prefix, "bin"),
      GDAL_DATA: join(prefix, "share", "gdal"),
      PROJ_DATA: join(prefix, "share", "proj"),
      PROJ_LIB: join(prefix, "share", "proj"),
      PROJ_NETWORK: "OFF",
      GDAL_DRIVER_PATH: "disable",
      GDAL_CONFIG_FILE: platform === "win32" ? "NUL" : "/dev/null",
      LD_LIBRARY_PATH: join(prefix, "lib"),
      DYLD_LIBRARY_PATH: join(prefix, "lib"),
    })
    for (const binary of required.slice(0, 2)) {
      execFileSync(join(destination, binary), ["--version"], { env, cwd: temporary, timeout: 30_000, stdio: "pipe" })
    }
    const sample = join(temporary, "input.geojson")
    const output = join(temporary, "output.gpkg")
    await writeFile(
      sample,
      JSON.stringify({
        type: "FeatureCollection",
        features: [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [1, 1] } }],
      }),
    )
    execFileSync(
      join(destination, required[1]),
      ["-f", "GPKG", "-s_srs", "EPSG:4326", "-t_srs", "EPSG:3857", output, sample],
      { env, cwd: temporary, timeout: 30_000 },
    )
    execFileSync(join(destination, required[0]), ["-json", "-so", "-al", output], {
      env,
      cwd: temporary,
      timeout: 30_000,
    })
  } else {
    console.warn(
      `Cross-architecture ${target}: layout validated only; test this artifact on a native runner before release`,
    )
  }
  console.log(`Prepared bundled GDAL ${target} at ${destination}`)
} finally {
  await rm(temporary, { recursive: true, force: true })
}
