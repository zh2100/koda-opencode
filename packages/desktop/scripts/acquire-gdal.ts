#!/usr/bin/env bun
import { execFileSync } from "node:child_process"
import { cp, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { createHash } from "node:crypto"
import { smokeGdal } from "./smoke-gdal"

// Native runners only. The original conda-pack archive remains the source of truth.
const arch = process.env.OPENCODE_ELECTRON_ARCH || process.arch
if (arch !== process.arch || (process.platform === "win32" && arch !== "x64")) {
  throw new Error("Acquisition requires a supported native runner; Windows ARM64 is not supported")
}
const target = `${process.platform}-${arch}`
const work = resolve(process.env.KODA_GDAL_WORK || join(dirname(import.meta.path), "../.cache/gdal", target))
const source = process.env.KODA_GDAL_SOURCE ? resolve(process.env.KODA_GDAL_SOURCE) : join(work, "source")
const archive = join(work, "gdal-3.10.3-conda-pack.tar.gz")
const unpacked = join(work, "unpacked")
const moved = join(work, "relocated prefix with spaces")
const mamba = process.env.MICROMAMBA_EXE || "micromamba"
const pack = process.env.CONDA_PACK_EXE || "conda-pack"
const run = (exe: string, args: string[]) => execFileSync(exe, args, { stdio: "inherit", timeout: 1_200_000 })
await mkdir(work, { recursive: true })
if (!process.env.KODA_GDAL_SOURCE) {
  if (existsSync(source)) throw new Error(`Use a fresh work directory, or explicitly set KODA_GDAL_SOURCE: ${source}`)
  run(mamba, ["--no-rc", "create", "-y", "-r", join(work, "mamba"), "-p", source, "-c", "conda-forge", "--strict-channel-priority",
    ...(process.env.KODA_GDAL_LOCK ? ["--file", resolve(process.env.KODA_GDAL_LOCK)] : ["gdal=3.10.3", "libgdal-core=3.10.3", "proj=9.6.2", "python=3.12"]),
  ])
}
const records = await Promise.all((await readdir(join(source, "conda-meta"))).filter((x) => x.endsWith(".json")).sort().map((x) => Bun.file(join(source, "conda-meta", x)).json()))
const notices = join(source, "licenses")
await mkdir(notices, { recursive: true })
const inventory = []
for (const record of records) {
  const cache = record.extracted_package_dir
  if (!cache || !existsSync(join(cache, "info/about.json"))) throw new Error(`Package cache missing: ${record.name}`)
  const about = await Bun.file(join(cache, "info/about.json")).json()
  const destination = join(notices, `${record.name}-${record.version}-${record.build}`)
  await mkdir(destination, { recursive: true })
  await cp(join(cache, "info/about.json"), join(destination, "about.json"))
  await cp(join(cache, "info/recipe"), join(destination, "recipe"), { recursive: true }).catch(() => {})
  const hasLicense = existsSync(join(cache, "info/licenses"))
  if (hasLicense) await cp(join(cache, "info/licenses"), join(destination, "texts"), { recursive: true })
  inventory.push({ name: record.name, version: record.version, build: record.build, license: record.license || about.license, licenseFiles: hasLicense, url: record.url, sha256: record.sha256 })
}
for (const name of ["libgdal-core", "proj", ...(process.platform === "win32" ? ["vc14_runtime", "ucrt"] : [])]) {
  if (!inventory.find((x) => x.name === name)?.licenseFiles) throw new Error(`Missing required runtime license texts: ${name}`)
}
await writeFile(join(notices, "inventory.json"), JSON.stringify(inventory, null, 2) + "\n")
await writeFile(join(work, "explicit.txt"), "@EXPLICIT\n" + records.map((x) => {
  if (!x.url || !x.md5) throw new Error(`Missing explicit lock metadata: ${x.name}`)
  return `${x.url}#${x.md5}`
}).join("\n") + "\n")
run(pack, ["-p", source, "-o", archive, "--force", "--quiet"])
await rm(unpacked, { recursive: true, force: true })
await rm(moved, { recursive: true, force: true })
await mkdir(unpacked)
run("tar", ["-xzf", archive, "-C", unpacked])
const python = join(unpacked, process.platform === "win32" ? "python.exe" : "bin/python")
run(python, [join(unpacked, process.platform === "win32" ? "Scripts/conda-unpack-script.py" : "bin/conda-unpack")])
await smokeGdal(unpacked)
if (process.platform === "win32") {
  // Only the native CLI closure is shipped. Python/scripts are prefix-bound after conda-unpack.
  for (const directory of ["Library/bin", "Library/share", "licenses"]) {
    await cp(join(unpacked, directory), join(moved, directory), { recursive: true })
  }
} else {
  await cp(unpacked, moved, { recursive: true })
}
// Prevent an accidentally embedded original path from satisfying the smoke test.
await rename(source, source + ".smoke-hidden")
await rename(unpacked, unpacked + ".smoke-hidden")
try {
  const evidence = await smokeGdal(moved)
  await writeFile(join(work, "smoke.json"), JSON.stringify({ ...evidence, archiveSha256: createHash("sha256").update(Buffer.from(await Bun.file(archive).arrayBuffer())).digest("hex"), inventory }, null, 2) + "\n")
} finally {
  await rename(source + ".smoke-hidden", source)
  await rename(unpacked + ".smoke-hidden", unpacked)
}
if (process.platform !== "win32") {
  console.log(`Experimental Unix relocation smoke passed. Archive and evidence: ${work}. Signing/glibc/release review still required; not staged.`)
} else {
  const vendor = resolve(dirname(import.meta.path), "../vendor/gdal", target)
  await rm(vendor, { recursive: true, force: true })
  await cp(moved, vendor, { recursive: true })
  await smokeGdal(vendor)
  console.log(`Native Windows payload: ${vendor}. Bundle only after license review with KODA_BUNDLE_GDAL=1.`)
}
