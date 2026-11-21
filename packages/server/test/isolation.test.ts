import { expect, test } from "bun:test"
import { Global } from "@opencode-ai/core/global"
import { admit, reconcile, requireInside } from "../../../script/test-isolation.mjs"

test("server preloads an isolated home and paths before importing product services", () => {
  expect(process.env.OPENCODE_TEST_HOME).toBeDefined()
  expect(Global.Path.home).toBe(process.env.OPENCODE_TEST_HOME!)
  const root = process.env.OPENCODE_TEST_ROOT!
  reconcile(admit(root), Global.make())
  for (const target of [Global.Path.home, Global.Path.data, Global.Path.config, Global.Path.cache, Global.Path.state])
    expect(requireInside(root, target)).toBe(target)
})
