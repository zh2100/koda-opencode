import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { admit, configure } from "./test-isolation.mjs"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-owned-test-"))
const rgName = process.platform === "win32" ? "rg.exe" : "rg"
const rgSource = path.join(os.homedir(), ".cache", "opencode", "bin", rgName)
const rgSeed = path.join(root, "seed", rgName)
if (fs.existsSync(rgSource)) {
  fs.mkdirSync(path.dirname(rgSeed), { recursive: true })
  fs.copyFileSync(rgSource, rgSeed)
  // Expose only the staged executable, never the host's cache or configuration.
  process.env.PATH += path.delimiter + path.dirname(rgSeed)
}
configure(root)
admit(root)
const args = process.argv.slice(2)
if (!args.length) throw new Error("usage: node script/test-isolated.mjs <bun arguments>")
console.log(`Test isolation root: ${root}`)
const child = spawn("bun", args, { env: process.env, stdio: "inherit", windowsHide: true })
child.on("error", () => { process.exitCode = 1 })
child.on("exit", (code) => { process.exitCode = code ?? 1 })
