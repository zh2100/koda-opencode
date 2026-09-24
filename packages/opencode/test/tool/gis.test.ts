import { describe, expect, it } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { Gdal } from "@/util/gdal"
import { tmpdir } from "../fixture/fixture"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Agent } from "@/agent/agent"
import { Truncate } from "@/tool/truncate"
import { GisTool } from "@/tool/gis"
import { Tool } from "@/tool/tool"
import { MessageID, SessionID } from "@/session/schema"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const effects = testEffect(LayerNode.compile(LayerNode.group([Agent.node, Truncate.node])))

for (const denied of ["read", "edit"] as const) {
  effects.instance(`GIS honors ${denied} denial before creating output or resolving GDAL`, () => Effect.gen(function* () {
    const instance = yield* TestInstance
    const source = path.join(instance.directory, "roads.geojson")
    const destination = path.join(instance.directory, "output")
    yield* Effect.promise(() => Bun.write(source, '{"type":"FeatureCollection","features":[]}'))
    const requests: string[] = []
    const ctx: Tool.Context = {
      sessionID: SessionID.make("ses_gis"),
      messageID: MessageID.make("msg_gis"),
      agent: "build",
      abort: new AbortController().signal,
      messages: [],
      metadata: () => Effect.void,
      ask: (request) => Effect.sync(() => {
        requests.push(request.permission)
        if (request.permission === denied) throw new Error(`Denied ${denied}`)
      }),
    }
    const info = yield* GisTool
    const tool = yield* info.init()
    const result = yield* tool.execute({ operation: "convert", source, destination, format: "GPKG", sourceCRS: "EPSG:4326", targetCRS: "EPSG:3857" }, ctx).pipe(Effect.exit)
    expect(result._tag).toBe("Failure")
    expect(requests).toContain(denied)
    expect(yield* Effect.promise(() => fs.stat(destination).then(() => true, () => false))).toBe(false)
  }))
}

describe("GIS validation", () => {
  const directory = process.platform === "win32" ? "C:\\workspace" : "/workspace"

  it("accepts only supported local vector formats", () => {
    expect(Gdal.validate({ operation: "inspect", source: "roads.gpkg" }, directory)).toMatchObject({
      source: path.resolve(directory, "roads.gpkg"),
      driver: "GPKG",
    })
    expect(() => Gdal.validate({ operation: "inspect", source: "https://example.test/roads.gpkg" }, directory)).toThrow(
      "local filesystem paths only",
    )
    expect(() => Gdal.validate({ operation: "inspect", source: "/vsicurl/roads.gpkg" }, directory)).toThrow(
      "local filesystem paths only",
    )
    expect(() => Gdal.validate({ operation: "inspect", source: "PG:host=example dbname=gis" }, directory)).toThrow(
      "local filesystem paths only",
    )
    expect(() => Gdal.validate({ operation: "inspect", source: "roads.csv" }, directory)).toThrow("Supported inputs")
  })

  it("requires explicit EPSG CRSs for conversion", () => {
    expect(() => Gdal.validate({ operation: "convert", source: "roads.gpkg", destination: "out", format: "GPKG" }, directory)).toThrow(
      "explicit sourceCRS and targetCRS",
    )
    expect(() => Gdal.validate({ operation: "convert", source: "roads.gpkg", destination: "out", format: "GPKG", sourceCRS: "4326", targetCRS: "EPSG:3857" }, directory)).toThrow(
      "explicit sourceCRS and targetCRS",
    )
    expect(Gdal.validate({ operation: "convert", source: "roads.gpkg", destination: "out", format: "GeoJSON", sourceCRS: "EPSG:4326", targetCRS: "EPSG:3857" }, directory)).toMatchObject({
      destination: path.resolve(directory, "out"),
    })
  })

  it("rejects overwriting intent and unsafe options", () => {
    expect(() => Gdal.validate({ operation: "convert", source: "roads.gpkg", destination: "out", format: "GPKG", sourceCRS: "EPSG:4326", targetCRS: "EPSG:3857", layer: "-overwrite" }, directory)).toThrow(
      "not an option",
    )
    expect(() => Gdal.validate({ operation: "inspect", source: "roads.gpkg", destination: "out" }, directory)).toThrow(
      "only valid for conversion",
    )
  })

  it("rejects remote, device, VSI and malformed paths", () => {
    for (const source of ["//server/share/roads.shp", "\\\\server\\share\\roads.shp", "file:///roads.json", "WFS:https://example.test", "/vsizip/data.zip/roads.shp", "roads.gpkg\0", "roads.gpkg:stream"]) {
      expect(() => Gdal.localPath(source, directory)).toThrow()
    }
    for (const timeout of [0, -1, 120001, 1.5, NaN]) {
      expect(() => Gdal.validate({ operation: "inspect", source: "roads.gpkg", timeout }, directory)).toThrow("Timeout")
    }
  })
})

async function fixture() {
  const tmp = await tmpdir()
  const bundle = Gdal.runtime(tmp.path)
  await fs.mkdir(bundle.env.GDAL_DATA!, { recursive: true })
  await Bun.write(path.join(bundle.env.PROJ_DATA!, "proj.db"), "fixture")
  await Bun.write(bundle.ogrinfo, "fixture")
  await Bun.write(bundle.ogr2ogr, "fixture")
  const source = path.join(tmp.path, "roads.gpkg")
  await Bun.write(source, "fixture")
  return { tmp, bundle, source }
}

describe("GIS runtime", () => {
  it("uses only the configured prefix and platform-specific bundled layout", () => {
    expect(() => Gdal.runtime("")).toThrow("KODA_GDAL_HOME")
    expect(() => Gdal.runtime("relative")).toThrow("KODA_GDAL_HOME")
    const home = path.resolve("bundle")
    const windows = Gdal.runtime(home, "win32")
    expect(windows.ogrinfo).toBe(path.join(home, "Library", "bin", "ogrinfo.exe"))
    expect(windows.env.GDAL_DATA).toBe(path.join(home, "Library", "share", "gdal"))
    expect(windows.env.PROJ_DATA).toBe(path.join(home, "Library", "share", "proj"))
    const unix = Gdal.runtime(home, "linux")
    expect(unix.ogr2ogr).toBe(path.join(home, "bin", "ogr2ogr"))
    expect(unix.env.LD_LIBRARY_PATH).toBe(path.join(home, "lib"))
    expect(unix.env.PROJ_NETWORK).toBe("OFF")
    expect(unix.env.GDAL_DRIVER_PATH).toBe("disable")
    expect(unix.env.PATH).toBe(path.join(home, "bin"))
  })

  it("runs real inspect argument construction and bounds the summary", async () => {
    const { tmp, bundle, source } = await fixture()
    await using cleanup = tmp
    const commands: Gdal.Command[] = []
    const result = await Gdal.execute({ operation: "inspect", source, layer: "roads & buildings" }, source, undefined, new AbortController().signal, async (command) => {
      commands.push(command)
      return { stdout: "x".repeat(40000), stderr: "" }
    }, bundle)
    expect(commands[0].executable).toBe(bundle.ogrinfo)
    expect(commands[0].args).toEqual(["-json", "-so", "-al", "-ro", "-if", "GPKG", source, "roads & buildings"])
    expect(commands[0].timeout).toBe(60000)
    expect(result).toContain("summary truncated")
    expect(result.length).toBeLessThan(33000)
  })

  it("converts into a new directory without overwrite arguments and rejects a second use", async () => {
    const { tmp, bundle, source } = await fixture()
    await using cleanup = tmp
    for (const format of ["GPKG", "GeoJSON", "Shapefile"] as const) {
      const destination = path.join(tmp.path, format)
      const input: Gdal.Request = { operation: "convert", source, destination, format, sourceCRS: "EPSG:4326", targetCRS: "EPSG:3857", layer: "roads" }
      const commands: Gdal.Command[] = []
      const runner: Gdal.Runner = async (command) => {
        commands.push(command)
        expect((await fs.stat(destination)).isDirectory()).toBe(true)
        return { stdout: "", stderr: "" }
      }
      await Gdal.execute(input, source, destination, new AbortController().signal, runner, bundle)
      expect(commands[0].args).toEqual(["-if", "GPKG", "-f", Gdal.formats[format].driver, "-s_srs", "EPSG:4326", "-t_srs", "EPSG:3857", "-nln", "output", path.join(destination, Gdal.formats[format].filename), source, "roads"])
      await expect(Gdal.execute(input, source, destination, new AbortController().signal, runner, bundle)).rejects.toThrow()
      expect(commands.length).toBe(1)
    }
  })

  it("fails closed when the runtime is missing or the operation is aborted", async () => {
    const { tmp, bundle, source } = await fixture()
    await using cleanup = tmp
    const runner: Gdal.Runner = async () => { throw new Error("runner must not run") }
    await expect(Gdal.execute({ operation: "inspect", source }, source, undefined, AbortSignal.abort(), runner, bundle)).rejects.toThrow()
    await fs.unlink(bundle.ogrinfo)
    await expect(Gdal.execute({ operation: "inspect", source }, source, undefined, new AbortController().signal, runner, bundle)).rejects.toThrow("System GDAL is not used")
  })

  it("preserves the reserved destination after a failed conversion", async () => {
    const { tmp, bundle, source } = await fixture()
    await using cleanup = tmp
    const destination = path.join(tmp.path, "failed")
    const input: Gdal.Request = { operation: "convert", source, format: "GPKG", destination, sourceCRS: "EPSG:4326", targetCRS: "EPSG:3857" }
    await expect(Gdal.execute(input, source, destination, new AbortController().signal, async () => { throw new Error("bad CRS") }, bundle)).rejects.toThrow("Partial output may remain")
    expect((await fs.stat(destination)).isDirectory()).toBe(true)
  })
})
