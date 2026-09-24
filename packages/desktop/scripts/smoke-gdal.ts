import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import assert from "node:assert/strict"

export async function smokeGdal(home: string) {
  const prefix = process.platform === "win32" ? join(home, "Library") : home
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => /^(SystemRoot|WINDIR|TEMP|TMP|TMPDIR|LANG|LC_ALL)$/i.test(key)),
  )
  Object.assign(env, {
    PATH: join(prefix, "bin"),
    GDAL_DATA: join(prefix, "share/gdal"),
    PROJ_DATA: join(prefix, "share/proj"),
    PROJ_LIB: join(prefix, "share/proj"),
    PROJ_NETWORK: "OFF",
    GDAL_DRIVER_PATH: "disable",
    GDAL_CONFIG_FILE: process.platform === "win32" ? "NUL" : "/dev/null",
    LD_LIBRARY_PATH: join(prefix, "lib"),
    DYLD_LIBRARY_PATH: join(prefix, "lib"),
  })
  const work = await mkdtemp(join(tmpdir(), "gdal-smoke-"))
  const run = (name: string, args: string[]) => execFileSync(
    join(prefix, "bin", name + (process.platform === "win32" ? ".exe" : "")), args,
    { env, cwd: work, timeout: 30_000, encoding: "utf8" },
  )
  try {
    const versions = [run("ogrinfo", ["--version"]).trim(), run("ogr2ogr", ["--version"]).trim()]
    await writeFile(join(work, "input.geojson"), JSON.stringify({
      type: "FeatureCollection",
      features: [{ type: "Feature", properties: { name: "relocation" }, geometry: { type: "Point", coordinates: [1, 1] } }],
    }))
    run("ogr2ogr", ["-f", "GPKG", "-s_srs", "EPSG:4326", "-t_srs", "EPSG:3857", "output.gpkg", "input.geojson"])
    const summary = JSON.parse(run("ogrinfo", ["-json", "-so", "-al", "output.gpkg"]))
    assert.equal(summary.layers[0].featureCount, 1)
    run("ogr2ogr", ["-f", "GeoJSON", "projected.geojson", "output.gpkg"])
    const feature = (await Bun.file(join(work, "projected.geojson")).json()).features[0]
    assert.equal(feature.properties.name, "relocation")
    const [x, y] = feature.geometry.coordinates
    assert.ok(Math.abs(x - 111319.490793) < 0.01 && Math.abs(y - 111325.142866) < 0.01)
    for (const [format, file] of [["ESRI Shapefile", "point.shp"], ["FlatGeobuf", "point.fgb"]]) {
      run("ogr2ogr", ["-f", format!, file!, "input.geojson"])
      assert.equal(JSON.parse(run("ogrinfo", ["-json", "-so", "-al", file!])).layers[0].featureCount, 1)
    }
    const evidence = { home, versions, featureCount: 1, projectedCoordinates: [x, y], formats: ["GeoJSON", "GPKG", "ESRI Shapefile", "FlatGeobuf"], isolatedPath: env.PATH }
    console.log(JSON.stringify(evidence, null, 2))
    return evidence
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  if (!process.argv[2]) throw new Error("Usage: bun scripts/smoke-gdal.ts <prefix> [evidence.json]")
  const evidence = await smokeGdal(resolve(process.argv[2]))
  if (process.argv[3]) {
    await mkdir(resolve(process.argv[3], ".."), { recursive: true })
    await writeFile(process.argv[3], JSON.stringify(evidence, null, 2) + "\n")
  }
}
