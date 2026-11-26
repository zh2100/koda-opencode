import { mkdir } from "node:fs/promises"
import { join } from "node:path"

export async function prepareDefaultProject(home: string) {
  const directory = join(home, "Koda")
  await mkdir(directory, { recursive: true })
  return directory
}
