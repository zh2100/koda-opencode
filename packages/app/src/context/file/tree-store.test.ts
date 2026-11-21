import { describe, expect, test } from "bun:test"
import type { FileNode } from "@opencode-ai/sdk/v2"
import { createFileTreeStore } from "./tree-store"

const node = (path: string, type: FileNode["type"] = "file"): FileNode =>
  ({ path, name: path.split("/").pop() ?? path, type, absolute: path, ignored: false }) as FileNode

function tree(list: (dir: string) => Promise<FileNode[]>, scope = () => "local") {
  return createFileTreeStore({
    scope,
    normalizeDir: (input) => input.replaceAll("\\", "/").replace(/\/+$/, ""),
    list,
    onError: () => undefined,
  })
}

describe("createFileTreeStore parent deletion", () => {
  test("reloads a directory rediscovered by a parent snapshot", async () => {
    const reads: string[] = []
    const files = new Map<string, FileNode[]>([
      ["", [node("dir", "directory")]],
      ["dir", [node("dir/old.ts")]],
    ])
    const store = tree(async (dir) => {
      reads.push(dir)
      return files.get(dir) ?? []
    })

    await store.listDir("")
    await store.listDir("dir")
    files.set("", [])
    await store.listDir("", { force: true })
    files.set("", [node("dir", "directory")])
    files.set("dir", [node("dir/new.ts")])
    await store.listDir("", { force: true })
    await store.listDir("dir")

    expect(store.children("dir").map((item) => item.path)).toEqual(["dir/new.ts"])
    expect(reads.filter((dir) => dir === "dir")).toHaveLength(2)
    expect(store.isLoaded("dir")).toBe(true)
  })

  test("keeps a rebuilt directory when an older listing returns after the new one", async () => {
    let releaseOld: (nodes: FileNode[]) => void = () => undefined
    const old = new Promise<FileNode[]>((resolve) => {
      releaseOld = resolve
    })
    const listings = new Map<string, FileNode[]>([
      ["", [node("dir", "directory")]],
      ["dir", [node("dir/old.ts")]],
    ])
    let dirCalls = 0
    const store = tree(async (dir) => {
      if (dir !== "dir") return listings.get(dir) ?? []
      dirCalls += 1
      if (dirCalls === 1) return old
      return listings.get(dir) ?? []
    })

    await store.listDir("")
    const stale = store.listDir("dir")
    listings.set("", [])
    await store.listDir("", { force: true })
    listings.set("", [node("dir", "directory")])
    listings.set("dir", [node("dir/new.ts")])
    await store.listDir("", { force: true })
    await store.listDir("dir", { force: true })
    releaseOld([node("dir/stale.ts")])
    await stale

    expect(store.children("dir").map((item) => item.path)).toEqual(["dir/new.ts"])
  })

  test("invalidates descendants and leaves a similar prefix untouched", async () => {
    const files = new Map<string, FileNode[]>([
      ["", [node("dir", "directory"), node("dir-other", "directory")]],
      ["dir", [node("dir/nested", "directory"), node("dir/file.ts")]],
      ["dir/nested", [node("dir/nested/deep.ts")]],
      ["dir-other", [node("dir-other/keep.ts")]],
    ])
    const store = tree(async (dir) => files.get(dir) ?? [])

    await store.listDir("")
    await store.listDir("dir")
    await store.listDir("dir/nested")
    await store.listDir("dir-other")
    files.set("", [node("dir-other", "directory")])
    await store.listDir("", { force: true })

    expect(store.node("dir")).toBeUndefined()
    expect(store.dirState("dir")).toBeUndefined()
    expect(store.dirState("dir/nested")).toBeUndefined()
    expect(store.node("dir/nested/deep.ts")).toBeUndefined()
    expect(store.children("dir-other").map((item) => item.path)).toEqual(["dir-other/keep.ts"])
  })

  test("drops a directory replaced by a file and ignores a stale scope response", async () => {
    let scope = "local"
    let release: (nodes: FileNode[]) => void = () => undefined
    const pending = new Promise<FileNode[]>((resolve) => {
      release = resolve
    })
    let calls = 0
    const store = tree(async (dir) => {
      if (dir !== "") return []
      calls += 1
      if (calls === 1) return [node("dir", "directory")]
      return pending
    }, () => scope)

    await store.listDir("")
    const refresh = store.listDir("", { force: true })
    scope = "remote"
    release([node("dir", "file")])
    await refresh

    expect(store.node("dir")?.type).toBe("directory")
    expect(store.dirState("dir")).toBeUndefined()
  })

  test("reloads A after reset to B and back when the old listing returns", async () => {
    let releaseOld: (nodes: FileNode[]) => void = () => undefined
    const old = new Promise<FileNode[]>((resolve) => {
      releaseOld = resolve
    })
    const files = new Map<string, FileNode[]>([["", [node("old.ts")]]])
    let reads = 0
    const store = tree(async () => {
      reads += 1
      if (reads === 1) return old
      return files.get("") ?? []
    })

    const stale = store.listDir("")
    store.reset()
    files.set("", [node("other.ts")])
    await store.listDir("")
    store.reset()
    files.set("", [node("new.ts")])
    await store.listDir("")
    releaseOld([node("old.ts")])
    await stale

    expect(store.children("").map((item) => item.path)).toEqual(["new.ts"])
    expect(reads).toBe(3)
  })
})
