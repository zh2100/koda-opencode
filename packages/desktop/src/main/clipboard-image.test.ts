import { expect, test } from "bun:test"
import { clipboardImageBuffer } from "./clipboard-image"

test("transfers only PNG bytes from a pooled buffer view", () => {
  const pool = Buffer.from([99, 98, 137, 80, 78, 71, 13, 10, 26, 10, 97])
  const png = pool.subarray(2, 10)
  const result = clipboardImageBuffer(png)
  expect(result.byteLength).toBe(8)
  expect(Array.from(new Uint8Array(result))).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
  pool.fill(0)
  expect(new Uint8Array(result)[0]).toBe(137)
})
