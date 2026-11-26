import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import JSZip from "jszip"
import { build, verify } from "../src/presentation/pptx"

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="
const assets = new Map([
  [
    "cover",
    {
      uri: `data:image/png;base64,${png}`,
      digest: createHash("sha256").update(Buffer.from(png, "base64")).digest("hex"),
    },
  ],
])
const slides = [
  { title: "Title", body: "Cover page", slot: "cover" },
  { title: "Details", body: "No picture" },
]
test("verifies a picture actually embedded on its requested slide", async () => {
  await verify(await build(slides, assets), slides, assets)
})
for (const mode of [
  "wrong-page",
  "wrong-entry",
  "missing-relationship",
  "external",
  "orphan",
  "wrong-content",
  "reordered",
])
  test(`does not accept ${mode} as embedded`, async () => {
    const zip = await JSZip.loadAsync(await build(slides, assets))
    const rel = "ppt/slides/_rels/slide1.xml.rels"
    const page = "ppt/slides/slide1.xml"
    async function change(p: string, update: (xml: string) => string) {
      const before = await zip.file(p)?.async("string")
      if (!before) throw Error("missing test fixture part")
      const after = update(before)
      expect(after).not.toBe(before)
      zip.file(p, after)
    }
    if (mode === "wrong-entry")
      await change("_rels/.rels", (s) => s.replace('Target="ppt/presentation.xml"', 'Target="unrelated.xml"'))
    if (mode === "missing-relationship") zip.remove(rel)
    if (mode === "external")
      await change(rel, (s) =>
        s.replace(/Target="\.\.\/media\//, 'TargetMode="External" Target="https://example.invalid/'),
      )
    if (mode === "orphan") await change(page, (s) => s.replace(/<p:pic>.*?<\/p:pic>/s, ""))
    if (mode === "wrong-content") {
      const media = Object.keys(zip.files).find((k) => /^ppt\/media\/.+png$/.test(k))
      if (!media) throw Error("missing picture")
      zip.file(media, "wrong")
    }
    if (mode === "reordered")
      await change("ppt/presentation.xml", (s) => s.replace(/(<p:sldId [^>]+\/>)(<p:sldId [^>]+\/>)/, "$2$1"))
    await expect(
      verify(
        await zip.generateAsync({ type: "nodebuffer" }),
        mode === "wrong-page" ? [slides[1], slides[0]] : slides,
        assets,
      ),
    ).rejects.toThrow()
  })
