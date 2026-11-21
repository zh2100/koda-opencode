import { createStore, produce, reconcile } from "solid-js/store"
import type { FileNode } from "@opencode-ai/sdk/v2"

type DirectoryState = {
  expanded: boolean
  loaded?: boolean
  loading?: boolean
  error?: string
  children?: string[]
}

type TreeStoreOptions = {
  scope: () => string
  normalizeDir: (input: string) => string
  list: (input: string) => Promise<FileNode[]>
  onError: (message: string) => void
}

export function createFileTreeStore(options: TreeStoreOptions) {
  const [tree, setTree] = createStore<{
    node: Record<string, FileNode>
    dir: Record<string, DirectoryState>
  }>({
    node: {},
    dir: { "": { expanded: true } },
  })

  const inflight = new Map<string, Promise<void>>()
  const forceAgain = new Set<string>()
  const generation = new Map<string, number>()
  let lifetime = 0

  const reset = () => {
    lifetime += 1
    inflight.clear()
    forceAgain.clear()
    generation.clear()
    setTree("node", reconcile({}))
    setTree("dir", reconcile({}))
    setTree("dir", "", { expanded: true })
  }

  const ensureDir = (path: string) => {
    if (tree.dir[path]) return
    setTree("dir", path, { expanded: false })
  }

  const listDir = (input: string, opts?: { force?: boolean }): Promise<void> => {
    const dir = options.normalizeDir(input)
    ensureDir(dir)

    const current = tree.dir[dir]
    if (!opts?.force && current?.loaded) return Promise.resolve()

    const pending = inflight.get(dir)
    if (pending && !opts?.force) return pending
    if (opts?.force) {
      generation.set(dir, (generation.get(dir) ?? 0) + 1)
      inflight.delete(dir)
      forceAgain.delete(dir)
    }

    setTree(
      "dir",
      dir,
      produce((draft) => {
        draft.loading = true
        draft.error = undefined
      }),
    )

    const directory = options.scope()
    const requestLifetime = lifetime
    const requestGeneration = (generation.get(dir) ?? 0) + 1
    generation.set(dir, requestGeneration)

    const promise = options
      .list(dir)
      .then((nodes) => {
        if (options.scope() !== directory || requestLifetime !== lifetime || generation.get(dir) !== requestGeneration) return
        const prevChildren = tree.dir[dir]?.children ?? []
        const nextChildren = nodes.map((node) => options.normalizeDir(node.path))
        const nextSet = new Set(nextChildren)
        const removedDirs = prevChildren.filter((child) => {
          if (nextSet.has(child)) {
            const next = nodes.find((node) => options.normalizeDir(node.path) === child)
            return tree.node[child]?.type === "directory" && next?.type !== "directory"
          }
          return tree.node[child]?.type === "directory"
        })

        setTree(
          produce((draft) => {
            for (const removed of removedDirs) dropDirectory(draft, removed)
            for (const child of prevChildren) {
              if (nextSet.has(child) || removedDirs.includes(child)) continue
              delete draft.node[child]
            }
            for (const node of nodes) {
              draft.node[options.normalizeDir(node.path)] = { ...node, path: options.normalizeDir(node.path) }
            }
            const current = draft.dir[dir] ?? { expanded: false }
            draft.dir[dir] = {
              ...current,
              loaded: true,
              loading: false,
              error: undefined,
              children: nextChildren,
            }
          }),
        )
      })
      .catch((e) => {
        if (options.scope() !== directory || requestLifetime !== lifetime || generation.get(dir) !== requestGeneration) return
        setTree(
          "dir",
          dir,
          produce((draft) => {
            draft.loading = false
            draft.error = e.message
          }),
        )
        options.onError(e.message)
      })
      .finally(() => {
        if (requestLifetime === lifetime && generation.get(dir) === requestGeneration) inflight.delete(dir)
      })

    inflight.set(dir, promise)
    return promise
  }

  // `list: false` marks a directory expanded without fetching its children, for
  // trees whose nodes are synthesized from a filter; listing directories that
  // only exist on a diff's base branch fails and surfaces error toasts.
  const expandDir = (input: string, behavior?: { list?: boolean }) => {
    const dir = options.normalizeDir(input)
    ensureDir(dir)
    setTree("dir", dir, "expanded", true)
    if (behavior?.list === false) return
    void listDir(dir)
  }

  const collapseDir = (input: string) => {
    const dir = options.normalizeDir(input)
    ensureDir(dir)
    setTree("dir", dir, "expanded", false)
  }

  const dirState = (input: string) => {
    const dir = options.normalizeDir(input)
    return tree.dir[dir]
  }

  const children = (input: string) => {
    const dir = options.normalizeDir(input)
    const ids = tree.dir[dir]?.children
    if (!ids) return []
    const out: FileNode[] = []
    for (const id of ids) {
      const node = tree.node[id]
      if (node) out.push(node)
    }
    return out
  }

  const invalidateDir = (dir: string) => {
    forceAgain.delete(dir)
    generation.set(dir, (generation.get(dir) ?? 0) + 1)
    inflight.delete(dir)
  }

  const dropDirectory = (
    draft: { node: Record<string, FileNode>; dir: Record<string, DirectoryState> },
    dir: string,
  ) => {
    invalidateDir(dir)
    delete draft.node[dir]
    delete draft.dir[dir]
    for (const key of [...Object.keys(draft.node), ...Object.keys(draft.dir)]) {
      if (!key.startsWith(`${dir}/`)) continue
      invalidateDir(key)
      delete draft.node[key]
      delete draft.dir[key]
    }
  }

  const removeDir = (input: string) => {
    const dir = options.normalizeDir(input)
    setTree(produce((draft) => dropDirectory(draft, dir)))
  }

  return {
    listDir,
    removeDir,
    expandDir,
    collapseDir,
    dirState,
    children,
    node: (path: string) => tree.node[path],
    isLoaded: (path: string) => Boolean(tree.dir[path]?.loaded),
    reset,
  }
}
