import { describe, expect, test } from "bun:test"
import { attachmentMime, pickAttachmentFiles } from "./files"
import { pasteMode } from "./paste"

describe("attachmentMime", () => {
  test("keeps PDFs when the browser reports the mime", async () => {
    const file = new File(["%PDF-1.7"], "guide.pdf", { type: "application/pdf" })
    expect(await attachmentMime(file)).toBe("application/pdf")
  })

  test("normalizes structured text types to text/plain", async () => {
    const file = new File(['{"ok":true}\n'], "data.json", { type: "application/json" })
    expect(await attachmentMime(file)).toBe("text/plain")
  })

  test("accepts text files even with a misleading browser mime", async () => {
    const file = new File(["export const x = 1\n"], "main.ts", { type: "video/mp2t" })
    expect(await attachmentMime(file)).toBe("text/plain")
  })

  test("accepts common raster image types and extension fallbacks", async () => {
    expect(await attachmentMime(new File(["bmp"], "image.bmp", { type: "image/bmp" }))).toBe("image/bmp")
    expect(await attachmentMime(new File(["tiff"], "image.tiff", { type: "application/octet-stream" }))).toBe("image/tiff")
    expect(await attachmentMime(new File(["avif"], "image.avif", { type: "" }))).toBe("image/avif")
  })

  test("accepts Office document types and extension fallbacks", async () => {
    expect(await attachmentMime(new File([Uint8Array.of(208, 207, 17, 224)], "legacy.doc", { type: "" }))).toBe(
      "application/msword",
    )
    expect(
      await attachmentMime(
        new File([Uint8Array.of(208, 207, 17, 224)], "legacy.doc", { type: "application/msword" }),
      ),
    ).toBe("application/msword")
    expect(
      await attachmentMime(new File([Uint8Array.of(208, 207, 17, 224)], "legacy.xls", { type: "" })),
    ).toBe("application/vnd.ms-excel")
    expect(
      await attachmentMime(
        new File([Uint8Array.of(208, 207, 17, 224)], "legacy.xls", { type: "application/vnd.ms-excel" }),
      ),
    ).toBe("application/vnd.ms-excel")
    expect(
      await attachmentMime(
        new File([Uint8Array.of(80, 75, 3, 4)], "report.docx", { type: "application/octet-stream" }),
      ),
    ).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document")
    expect(
      await attachmentMime(
        new File([Uint8Array.of(80, 75, 3, 4)], "book.xlsx", {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        }),
      ),
    ).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    expect(
      await attachmentMime(new File([Uint8Array.of(80, 75, 3, 4)], "archive.xlsx", { type: "application/zip" })),
    ).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
  })

  test("accepts OpenDocument, RTF, and EPUB types", async () => {
    expect(await attachmentMime(new File(["{\\rtf1"], "note.rtf", { type: "application/octet-stream" }))).toBe(
      "application/rtf",
    )
    expect(await attachmentMime(new File([Uint8Array.of(80, 75, 3, 4)], "note.odt", { type: "application/zip" }))).toBe(
      "application/vnd.oasis.opendocument.text",
    )
    expect(await attachmentMime(new File([Uint8Array.of(80, 75, 3, 4)], "book.epub", { type: "" }))).toBe(
      "application/epub+zip",
    )
  })

  test("rejects SVG and unsupported image formats", async () => {
    expect(await attachmentMime(new File(["<svg />"], "image.svg", { type: "image/svg+xml" }))).toBeUndefined()
    expect(await attachmentMime(new File(["sheet"], "image.sheet", { type: "image/fastbidsheet" }))).toBeUndefined()
  })

  test("rejects binary files", async () => {
    const file = new File([Uint8Array.of(0, 255, 1, 2)], "blob.bin", { type: "application/octet-stream" })
    expect(await attachmentMime(file)).toBeUndefined()
  })
})

describe("pickAttachmentFiles", () => {
  test("reads the current project directory for every native picker invocation", async () => {
    const paths: string[] = []
    const accepts: unknown[] = []
    const files: File[] = []
    const file = new File(["hello"], "hello.txt", { type: "text/plain" })
    let directory = "C:\\Projects\\LoremIpsum"
    const picker = async (options?: { defaultPath?: string; accept?: string[] }, onFile?: (file: File) => Promise<unknown>) => {
      paths.push(options?.defaultPath ?? "")
      accepts.push(options?.accept)
      await onFile?.(file)
    }

    pickAttachmentFiles({
      picker,
      directory: () => directory,
      fallback: () => undefined,
      onFile: async (selected) => files.push(selected),
      onError: () => undefined,
    })
    await Promise.resolve()
    directory = "C:\\Projects\\DolorSit"
    pickAttachmentFiles({
      picker,
      directory: () => directory,
      fallback: () => undefined,
      onFile: async (selected) => files.push(selected),
      onError: () => undefined,
    })
    await Promise.resolve()
    expect(files).toEqual([file, file])
    expect(paths).toEqual(["C:\\Projects\\LoremIpsum", "C:\\Projects\\DolorSit"])
    expect(accepts).toHaveLength(2)
    expect(accepts.every((value) => Array.isArray(value))).toBe(true)
    expect(accepts[0]).toContain(".docx")
    expect(accepts[0]).toContain(".doc")
    expect(accepts[0]).toContain(".xls")
    expect(accepts[0]).toContain(".xlsx")
  })

  test("uses the browser file input when no native picker exists", async () => {
    let fallback = 0
    pickAttachmentFiles({
      directory: () => "/projects/consectetur-adipiscing",
      fallback: () => {
        fallback += 1
      },
      onFile: async () => undefined,
      onError: () => undefined,
    })
    expect(fallback).toBe(1)
  })

  test("reports native picker failures without rejecting", async () => {
    const error = new Error("picker unavailable")
    const errors: unknown[] = []
    const handled = Promise.withResolvers<void>()
    pickAttachmentFiles({
      picker: async () => Promise.reject(error),
      directory: () => "C:\\Projects\\LoremIpsum",
      fallback: () => undefined,
      onFile: async () => undefined,
      onError: (cause) => {
        errors.push(cause)
        handled.resolve()
      },
    })
    await handled.promise
    expect(errors).toEqual([error])
  })
})

describe("pasteMode", () => {
  test("uses native paste for short single-line text", () => {
    expect(pasteMode("hello world")).toBe("native")
  })

  test("uses manual paste for multiline text", () => {
    expect(
      pasteMode(`{
  "ok": true
}`),
    ).toBe("manual")
    expect(pasteMode("a\r\nb")).toBe("manual")
  })

  test("uses manual paste for large text", () => {
    expect(pasteMode("x".repeat(8000))).toBe("manual")
  })
})
