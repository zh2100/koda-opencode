import path from "node:path"
import fs from "node:fs/promises"
import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { Gdal } from "@/util/gdal"
import { Tool } from "./tool"
import { assertExternalDirectoryEffect } from "./external-directory"

export const Parameters = Schema.Struct({
  operation: Schema.Literals(["inspect", "convert"]),
  source: Schema.String.annotate({ description: "Local .gpkg, .geojson/.json, .shp or .fgb file path" }),
  layer: Schema.optional(Schema.String.annotate({ description: "Exact layer name; inspect first to discover layers" })),
  destination: Schema.optional(Schema.String.annotate({ description: "Conversion only: NEW directory under an existing parent. Existing paths are never overwritten." })),
  format: Schema.optional(Schema.Literals(["GPKG", "GeoJSON", "Shapefile"])),
  sourceCRS: Schema.optional(Schema.String.annotate({ description: "Conversion only: explicit EPSG:<code> confirmed by the user; never guess" })),
  targetCRS: Schema.optional(Schema.String.annotate({ description: "Conversion only: explicit EPSG:<code>" })),
  timeout: Schema.optional(Schema.Number.annotate({ description: "Timeout in milliseconds, 1-120000; default 60000" })),
})

export const GisTool = Tool.define(
  "gis",
  Effect.succeed({
    description: "Inspect local vector GIS datasets with bundled ogrinfo (JSON schema, layers, counts, extents and declared CRS; no features), or convert with bundled ogr2ogr to GPKG, GeoJSON or Shapefile. Conversion requires explicit sourceCRS and targetCRS EPSG codes, never inferred. For multi-layer inputs select a layer when writing GeoJSON or Shapefile. Writes only to a new destination directory; failed conversions may leave partial output there. No remote URLs, VSI paths, databases, SQL or arbitrary GDAL options. Requires KODA_GDAL_HOME; never uses system GDAL.",
    parameters: Parameters,
    execute: (input: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) => Effect.gen(function* () {
      const instance = yield* InstanceState.context
      const checked = Gdal.validate(input, instance.directory)
      yield* assertExternalDirectoryEffect(ctx, checked.source)
      yield* ctx.ask({ permission: "read", patterns: [path.relative(instance.worktree, checked.source)], always: ["*"], metadata: { source: checked.source } })
      const source = yield* Effect.promise(() => Gdal.sourceFiles(checked.source))
      yield* assertExternalDirectoryEffect(ctx, source.source)
      // GDAL reads Shapefile sidecars and follows source symlinks; authorize those paths too.
      const additional = source.files.filter((file) => file !== checked.source)
      if (additional.length) {
        yield* ctx.ask({ permission: "read", patterns: additional.map((file) => path.relative(instance.worktree, file)), always: ["*"], metadata: { source: source.source } })
      }
      const destination = checked.destination
        ? yield* Effect.promise(async () => path.join(await fs.realpath(path.dirname(checked.destination!)), path.basename(checked.destination!)))
        : undefined
      if (destination) {
        Gdal.localPath(destination, instance.directory)
        yield* assertExternalDirectoryEffect(ctx, checked.destination, { kind: "directory" })
        yield* assertExternalDirectoryEffect(ctx, destination, { kind: "directory" })
        yield* ctx.ask({
          permission: "edit",
          patterns: [...new Set([checked.destination!, destination])].map((dir) => path.relative(instance.worktree, path.join(dir, "*"))),
          always: ["*"],
          metadata: { destination, source: source.source, format: input.format, sourceCRS: input.sourceCRS, targetCRS: input.targetCRS },
        })
      }
      const output = yield* Effect.promise((signal) => Gdal.execute(input, source.source, destination, AbortSignal.any([ctx.abort, signal])))
      return { title: `GIS ${input.operation}: ${path.basename(source.source)}`, output, metadata: { source: source.source, destination, operation: input.operation } }
    }).pipe(Effect.orDie),
  }),
)
