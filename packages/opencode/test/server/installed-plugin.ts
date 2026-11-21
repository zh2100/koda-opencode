import fsPromises from "node:fs/promises"
import path from "node:path"

export async function installedPlugin(dir: string) {
  const modules = path.join(dir, "node_modules")
  await fsPromises.mkdir(modules, { recursive: true })
  await fsPromises.writeFile(path.join(dir, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: {
    "": { dependencies: { "@opencode-ai/plugin": "workspace:*" } },
  } }))
}
