#!/usr/bin/env bun

import { Script } from "@opencode-ai/script"
import { copyFileSync, existsSync, mkdirSync } from "fs"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

const generated = await import("./generate.ts")

await Bun.build({
  target: "node",
  entrypoints: ["./src/node.ts"],
  outdir: "./dist/node",
  format: "esm",
  sourcemap: "linked",
  external: ["jsonc-parser", "@lydell/node-pty", "./native/process-lock"],
  define: {
    OPENCODE_MODELS_DEV: generated.modelsData,
    OPENCODE_VERSION: `'${Script.version}'`,
    OPENCODE_CHANNEL: `'${Script.channel}'`,
  },
  files: {
    "opencode-web-ui.gen.ts": "",
  },
})

const nativeDir = path.resolve(dir, "../core/native/dist")
const nativeName = `process-lock-${process.platform}-${process.arch}.node`
const nativeSource = path.join(nativeDir, nativeName)
if (existsSync(nativeSource)) {
  mkdirSync(path.join(dir, "dist/node"), { recursive: true })
  copyFileSync(nativeSource, path.join(dir, "dist/node", nativeName))
  copyFileSync(path.join(nativeDir, "process-lock-manifest.json"), path.join(dir, "dist/node", "process-lock-manifest.json"))
}

console.log("Build complete")
