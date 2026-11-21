import { expect, test } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { Global } from "../src/global"
import { admit, confirm, reconcile, requireInside } from "../../../script/test-isolation.mjs"

test("I01: imported Global and its explicit service layer remain in the admitted root", async () => {
  const root = process.env.OPENCODE_TEST_ROOT!
  const admission = admit(root)
  reconcile(admission, Global.make())
  const overrides = { data: path.join(root, "layer-data"), tmp: path.join(root, "layer-tmp") }
  admit(root, { global: overrides })
  const service = await Effect.runPromise(Global.Service.pipe(Effect.provide(Global.layerWith(overrides))))
  for (const name of ["data", "config", "state", "cache", "home", "tmp"] as const)
    expect(requireInside(root, service[name])).toBe(service[name])
  expect(service.data).toBe(overrides.data)
  confirm(admission)
})
