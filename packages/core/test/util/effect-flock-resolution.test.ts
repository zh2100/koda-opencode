import { expect, test } from "bun:test"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const publicSpecifier = "@opencode-ai/core/util/effect-flock"
const publicModule = await import(publicSpecifier)
const internalModule = await import("../../src/util/effect-flock")
const require = createRequire(import.meta.url)

const publicKeys = Object.keys(publicModule.EffectFlock).sort()
const expectedKeys = [
  "LockCompromisedError",
  "LockDiagnosis",
  "LockDiagnosisReason",
  "LockTimeoutError",
  "Service",
  "layer",
  "node",
].sort()

test("A2 package resolution selects the public EffectFlock facade", () => {
  expect(import.meta.resolve(publicSpecifier)).toBe(
    new URL("../../src/util/effect-flock-public.ts", import.meta.url).href,
  )
  expect(require.resolve(publicSpecifier)).toBe(
    fileURLToPath(new URL("../../src/util/effect-flock-public.ts", import.meta.url)),
  )
  expect(publicKeys).toEqual(expectedKeys)
  expect("layerWith" in publicModule.EffectFlock).toBe(false)
  expect("WaitObservation" in publicModule.EffectFlock).toBe(false)
})

test("A2 internal implementation remains reachable only through an explicit source path", () => {
  expect(import.meta.resolve("../../src/util/effect-flock")).toContain("/src/util/effect-flock")
  expect(publicModule.EffectFlock.Service).toBe(internalModule.EffectFlock.Service)
  expect(publicModule.EffectFlock.layer).toBe(internalModule.EffectFlock.layer)
  expect(publicModule.EffectFlock.node).toBe(internalModule.EffectFlock.node)
})
