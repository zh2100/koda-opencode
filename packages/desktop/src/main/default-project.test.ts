import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { prepareDefaultProject } from "./default-project"

test("creates a default project and preserves existing files on reuse", async () => {
  const home = await mkdtemp(join(tmpdir(), "koda-default-"))
  try {
    const directory = await prepareDefaultProject(home)
    expect(directory).toBe(join(home, "Koda"))
    await writeFile(join(directory, "keep.txt"), "keep")
    expect(await prepareDefaultProject(home)).toBe(directory)
    expect(await readFile(join(directory, "keep.txt"), "utf8")).toBe("keep")
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test("rejects a conflicting file without overwriting it", async () => {
  const home = await mkdtemp(join(tmpdir(), "koda-default-"))
  try {
    await writeFile(join(home, "Koda"), "keep")
    await expect(prepareDefaultProject(home)).rejects.toThrow()
    expect(await readFile(join(home, "Koda"), "utf8")).toBe("keep")
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
