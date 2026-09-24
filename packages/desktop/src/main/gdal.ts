import { existsSync, statSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import { app } from "electron"

export function configureGdalRuntime() {
  if (!app.isPackaged && !process.env.KODA_GDAL_HOME) return

  if (process.env.KODA_GDAL_HOME && !isAbsolute(process.env.KODA_GDAL_HOME)) {
    throw new Error("KODA_GDAL_HOME must be an absolute bundled GDAL prefix")
  }
  const home = process.env.KODA_GDAL_HOME
    ? resolve(process.env.KODA_GDAL_HOME)
    : join(process.resourcesPath, "gdal", `${process.platform}-${process.arch}`)
  if (!isAbsolute(home)) throw new Error("KODA_GDAL_HOME must be an absolute bundled GDAL prefix")
  if (!process.env.KODA_GDAL_HOME && !existsSync(home)) return

  const prefix = process.platform === "win32" ? join(home, "Library") : home
  const executable = process.platform === "win32" ? ".exe" : ""
  const required = [
    join(prefix, "bin", `ogrinfo${executable}`),
    join(prefix, "bin", `ogr2ogr${executable}`),
    join(prefix, "share", "gdal"),
    join(prefix, "share", "proj", "proj.db"),
  ]
  const missing = required.find((path, index) => {
    const info = statSync(path, { throwIfNoEntry: false })
    return index === 2 ? !info?.isDirectory() : !info?.isFile() || info.size === 0
  })
  if (missing) throw new Error(`Bundled GDAL runtime is incomplete: missing ${missing}; system GDAL is not used`)

  process.env.KODA_GDAL_HOME = home
}
