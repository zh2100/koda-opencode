import { describe, expect, test } from "bun:test"
import { decodeDataUrl, decodeDataUrlBytes } from "../../src/util/data-url"

describe("decodeDataUrl", () => {
  test("decodes base64 data URLs", () => {
    const body = '{\n  "ok": true\n}\n'
    const url = `data:text/plain;base64,${Buffer.from(body).toString("base64")}`
    expect(decodeDataUrl(url)).toBe(body)
  })

  test("decodes plain data URLs", () => {
    expect(decodeDataUrl("data:text/plain,hello%20world")).toBe("hello world")
  })

  test("keeps binary bytes intact", () => {
    expect(Buffer.from(decodeDataUrlBytes("data:application/octet-stream;base64,AP+A"))).toEqual(
      Buffer.from([0, 255, 128]),
    )
  })
})
