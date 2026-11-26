import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { mkdir, readdir, rename, stat } from "node:fs/promises"
import path from "node:path"
import pkg from "../package.json"

const [input, output] = process.argv.slice(2)
if (!input || !output) throw new Error("Usage: release-assets.ts INPUT OUTPUT")
await mkdir(output)
const targets = [
  { name: "win-x64", channel: "latest.yml", extensions: ["exe", "exe.blockmap"] },
  { name: "mac-x64", channel: "latest-mac.yml", extensions: ["dmg", "zip", "zip.blockmap"] },
  { name: "mac-arm64", channel: "latest-mac.yml", extensions: ["dmg", "zip", "zip.blockmap"] },
  { name: "linux-x64", channel: "latest-linux.yml", extensions: ["deb", "AppImage"] },
  { name: "linux-arm64", channel: "latest-linux-arm64.yml", extensions: ["deb", "AppImage"] },
]

type Entry = { url: string; sha512: string; size: number; blockMapSize?: number }
type Feed = { version: string; files: Entry[]; releaseDate: string; path: string; sha512: string }
const feeds = new Map<string, Feed>()
const checksums = new Map<string, string>()
const notes = ["### 桌面版下载", ""]
for (const target of targets) {
  const dir = path.join(input, target.name)
  const names = await readdir(dir)
  const feed: Feed = Bun.YAML.parse(await Bun.file(path.join(dir, target.channel)).text()) as Feed
  if (feed.version !== pkg.version || !feed.files.length) throw new Error(`Invalid ${target.name} feed`)
  const assets = names.filter((name) => /^Koda-desktop-[\w.-]+$/.test(name))
  for (const ext of target.extensions) {
    if (assets.filter((name) => name.endsWith(`.${ext}`)).length !== 1)
      throw new Error(`Expected one ${target.name} ${ext}`)
  }
  for (const file of feed.files) {
    if (!assets.includes(file.url)) throw new Error(`Missing referenced asset: ${file.url}`)
  }
  for (const name of assets) {
    if (checksums.has(name)) throw new Error(`Duplicate asset: ${name}`)
    const source = path.join(dir, name)
    const sha256 = createHash("sha256")
    const sha512 = createHash("sha512")
    for await (const bytes of createReadStream(source)) {
      sha256.update(bytes)
      sha512.update(bytes)
    }
    const digest = sha512.digest("base64")
    const size = (await stat(source)).size
    if (!size) throw new Error(`Empty asset: ${name}`)
    const entry = feed.files.find((f) => f.url === name)
    if (entry && (entry.sha512 !== digest || entry.size !== size)) throw new Error(`Checksum mismatch: ${name}`)
    if (!entry && !name.endsWith(".blockmap")) feed.files.push({ url: name, sha512: digest, size })
    checksums.set(name, sha256.digest("hex"))
    await rename(source, path.join(output, name))
    if (!name.endsWith(".blockmap"))
      notes.push(`- [${name}](https://github.com/zh2100/koda-opencode/releases/download/v${pkg.version}/${name})`)
  }
  const previous = feeds.get(target.channel)
  if (previous) previous.files.push(...feed.files)
  else feeds.set(target.channel, feed)
}
for (const [name, feed] of feeds) {
  // JSON is a YAML subset and can be read by electron-updater's js-yaml parser.
  await Bun.write(path.join(output, name), JSON.stringify(feed, null, 2) + "\n")
}
await Bun.write(
  path.join(output, "SHA256SUMS.txt"),
  Array.from(checksums, ([name, hash]) => `${hash}  ${name}\n`).join(""),
)
notes.push(
  "",
  "可从帮助菜单检查更新。macOS 未配置 Developer ID 签名时请使用对应架构的 DMG 手动更新。Windows x64 内含 GDAL；其他平台不内置 GDAL。",
)
await Bun.write("release-notes.md", notes.join("\n") + "\n")
