export * as ConfigAgent from "./agent"

import path from "path"
import { Exit, Schema } from "effect"
import { Glob } from "@opencode-ai/core/util/glob"
import { ConfigAgentV1 } from "@opencode-ai/core/v1/config/agent"
import { configEntryNameFromPath } from "./entry-name"
import * as ConfigMarkdown from "./markdown"
import { ConfigParse } from "./parse"

export async function paths(dir: string, mode = false) {
  return Glob.scan(mode ? "{mode,modes}/*.md" : "{agent,agents}/**/*.md", { cwd: dir, absolute: true, dot: true, symlink: true })
}

export async function load(dir: string, readText?: (file: string) => Promise<string>) {
  const result: Record<string, ConfigAgentV1.Info> = {}
  for (const item of await paths(dir)) {
    const md = await ConfigMarkdown.parse(item, readText).catch(() => undefined)
    if (!md) continue

    const name = configEntryNameFromPath(path.relative(dir, item), ["agent/", "agents/"])

    const config = {
      name,
      ...md.data,
      prompt: md.content.trim(),
    }
    result[config.name] = ConfigParse.schema(ConfigAgentV1.Info, config, item)
  }
  return result
}

export async function loadMode(dir: string, readText?: (file: string) => Promise<string>) {
  const result: Record<string, ConfigAgentV1.Info> = {}
  for (const item of await paths(dir, true)) {
    const md = await ConfigMarkdown.parse(item, readText).catch(() => undefined)
    if (!md) continue

    const config = {
      name: configEntryNameFromPath(path.relative(dir, item), ["mode/", "modes/"]),
      ...md.data,
      prompt: md.content.trim(),
    }
    const parsed = Schema.decodeUnknownExit(ConfigAgentV1.Info)(config, { errors: "all", propertyOrder: "original" })
    if (Exit.isSuccess(parsed)) {
      result[config.name] = {
        ...parsed.value,
        mode: "primary" as const,
      }
    }
  }
  return result
}
