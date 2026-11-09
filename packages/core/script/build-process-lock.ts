import { createHash } from "crypto"
import fs from "fs"
import path from "path"
import { createRequire } from "module"

const root = path.resolve(import.meta.dirname, "../native/process-lock")
const built = path.join(root, "build", "Release", "process-lock.node")
const out = path.resolve(import.meta.dirname, "../native/dist")
const target = path.join(out, `process-lock-${process.platform}-${process.arch}.node`)

if (process.argv.includes("--build")) {
  const require = createRequire(import.meta.url)
  const result = Bun.spawnSync(["node", require.resolve("node-gyp/bin/node-gyp.js"), "rebuild"], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  })
  if (result.exitCode !== 0) process.exit(result.exitCode)
}

if (!fs.existsSync(built)) {
  console.error(`process-lock build output is missing: ${built}`)
  console.error("Run node-gyp build in packages/core/native/process-lock before packaging.")
  process.exit(1)
}

const node = Bun.spawnSync(["node", "--version"])
if (node.exitCode !== 0) {
  console.error("Unable to read the Node version used by node-gyp.")
  process.exit(1)
}

fs.mkdirSync(out, { recursive: true })
fs.copyFileSync(built, target)
const digest = createHash("sha256").update(fs.readFileSync(target)).digest("hex")
const source = createHash("sha256").update(fs.readFileSync(path.join(root, "binding.cc"))).digest("hex")
const manifest = {
  schemaVersion: 1,
  module: "process-lock",
  napi: "8",
  platform: process.platform,
  arch: process.arch,
  libc: process.platform === "linux" ? process.env.OPENCODE_LIBC ?? "glibc" : undefined,
  file: path.basename(target),
  sha256: digest,
  sourceSha256: source,
  toolchain: `node-gyp@11.2.0 node-addon-api@8.8.0 ${node.stdout.toString().trim()}`,
}
fs.writeFileSync(path.join(out, "process-lock-manifest.json"), JSON.stringify(manifest, null, 2))
console.log(JSON.stringify(manifest))
