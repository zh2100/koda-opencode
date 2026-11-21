export * as ConfigPaths from "./paths"

import path from "path"
import { existsSync } from "fs"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import { unique } from "remeda"
import * as Effect from "effect/Effect"
import { FSUtil } from "@opencode-ai/core/fs-util"

export const files = Effect.fn("ConfigPaths.projectFiles")(function* (
  name: string,
  directory: string,
  worktree?: string,
  includeLocal = false,
) {
  const afs = yield* FSUtil.Service
  const found = (yield* afs.up({
    targets: [`${name}.jsonc`, `${name}.json`],
    start: directory,
    stop: worktree,
  })).toReversed()
  if (!includeLocal) return found
  const local = fileInDirectory(directory, name)
  return [...found.filter((file) => !local.includes(file)), ...local]
})

export const directories = Effect.fn("ConfigPaths.directories")(function* (directory: string, worktree?: string, includeLocal = false) {
  const afs = yield* FSUtil.Service
  return unique([
    Global.Path.config,
    ...(includeLocal && !Flag.OPENCODE_DISABLE_PROJECT_CONFIG ? [path.join(directory, ".opencode")] : []),
    ...(!Flag.OPENCODE_DISABLE_PROJECT_CONFIG
      ? yield* afs.up({
          targets: [".opencode"],
          start: directory,
          stop: worktree,
        })
      : []),
    ...(yield* afs.up({
      targets: [".opencode"],
      start: Global.Path.home,
      stop: Global.Path.home,
    })),
    ...(Flag.OPENCODE_CONFIG_DIR ? [Flag.OPENCODE_CONFIG_DIR] : []),
  ])
})

export function fileInDirectory(dir: string, name: string) {
  return [path.join(dir, `${name}.json`), path.join(dir, `${name}.jsonc`)]
}

// Synchronous twin of files()/directories() for callers that cannot yield FSUtil.
// Keep the flag, worktree stop, and json-then-jsonc order aligned with the Effect loader.
export function discover(name: string, directory: string, worktree?: string) {
  const selected = process.env.OPENCODE_CONFIG ? [process.env.OPENCODE_CONFIG] : []
  if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG) {
    selected.push(...walk(directory, worktree, [`${name}.jsonc`, `${name}.json`]).toReversed())
  }
  for (const dir of configDirectories(directory, worktree)) {
    if (!dir.endsWith(".opencode") && dir !== Flag.OPENCODE_CONFIG_DIR) continue
    selected.push(...fileInDirectory(dir, name))
  }
  return [...new Set(selected)]
}

function configDirectories(directory: string, worktree?: string) {
  return unique([
    Global.Path.config,
    ...(!Flag.OPENCODE_DISABLE_PROJECT_CONFIG ? walk(directory, worktree, [".opencode"]) : []),
    ...walk(Global.Path.home, Global.Path.home, [".opencode"]),
    ...(Flag.OPENCODE_CONFIG_DIR ? [Flag.OPENCODE_CONFIG_DIR] : []),
  ])
}

function walk(start: string, stop: string | undefined, targets: string[]) {
  const found: string[] = []
  let current = start
  while (true) {
    for (const target of targets) {
      const file = path.join(current, target)
      if (existsSync(file)) found.push(file)
    }
    if (stop === current) break
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return found
}
