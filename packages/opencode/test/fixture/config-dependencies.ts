import fs from "node:fs/promises"
import path from "node:path"

/** Settled metadata for tests of bootstrap/snapshots, independent of registries. */
export async function installedConfigDependencies(directory: string) {
  await fs.mkdir(path.join(directory, "node_modules"), { recursive: true })
  await fs.writeFile(path.join(directory, "package-lock.json"), JSON.stringify({
    lockfileVersion: 3,
    packages: { "": { dependencies: { "@opencode-ai/plugin": "workspace:*" } } },
  }))
}
