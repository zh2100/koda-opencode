import { createHash } from "node:crypto"
import path from "node:path"
import JSZip from "jszip"
import PptxGenJS from "pptxgenjs"
import { SaxesParser } from "saxes"
import { imageSize } from "image-size"

export type Slide = { readonly title: string; readonly body: string; readonly slot?: string }
export type Asset = { uri: string; digest: string }

export async function build(slides: readonly Slide[], assets: ReadonlyMap<string, Asset>) {
  const pptx = new PptxGenJS()
  pptx.layout = "LAYOUT_WIDE"
  for (const slide of slides) {
    const page = pptx.addSlide()
    page.addText(slide.title, { x: 0.6, y: 0.4, w: 12, h: 0.9, fontSize: 32, bold: true, color: "153B54" })
    page.addText(slide.body, { x: 0.6, y: 1.6, w: slide.slot ? 5.4 : 12, h: 5.3, fontSize: 19, valign: "top" })
    if (!slide.slot) continue
    const asset = assets.get(slide.slot)
    if (!asset) throw new Error("Missing slide asset")
    const dimensions = imageSize(Buffer.from(asset.uri.slice(asset.uri.indexOf(",") + 1), "base64"))
    const mime = dimensions.type === "png" ? "image/png" : dimensions.type === "jpg" ? "image/jpeg" : undefined
    if (!mime || !asset.uri.startsWith(`data:${mime};base64,`) || !dimensions.width || !dimensions.height)
      throw new Error("Invalid slide image format or dimensions")
    const scale = Math.min(6.4 / dimensions.width, 5.2 / dimensions.height)
    const w = dimensions.width * scale,
      h = dimensions.height * scale
    page.addImage({ data: asset.uri, x: 6.35 + (6.4 - w) / 2, y: 1.6 + (5.2 - h) / 2, w, h, altText: slide.slot })
  }
  const result = await pptx.write({ outputType: "nodebuffer" })
  if (!(result instanceof Uint8Array)) throw new Error("Unexpected presentation writer output")
  return result
}

const ns = "http://schemas.openxmlformats.org/"
const office = ns + "officeDocument/2006/relationships"
const packages = ns + "package/2006/relationships"
const p = ns + "presentationml/2006/main"
const a = ns + "drawingml/2006/main"

// Only reopen this writer's output, never an arbitrary user-provided archive. Check names and
// namespace URIs, not prefixes. Slide numbers alone do not establish presentation order.
export async function verify(bytes: Uint8Array, slides: readonly Slide[], assets: ReadonlyMap<string, Asset>) {
  const zip = await JSZip.loadAsync(bytes)
  async function nodes(part: string, chain: string[], attr: string, uri = "") {
    const xml = await zip.file(part)?.async("string")
    if (!xml) throw new Error(`Missing presentation part: ${part}`)
    const stack: string[] = [],
      matches: string[] = []
    const parser = new SaxesParser({ xmlns: true })
    parser.on("opentag", (tag) => {
      stack.push(`${tag.uri}:${tag.local}`)
      if (stack.length !== chain.length || !chain.every((name, i) => name === stack[i])) return
      const value = Object.values(tag.attributes).find((v) => v.local === attr && v.uri === uri)?.value
      if (value) matches.push(value)
    })
    parser.on("closetag", () => {
      stack.pop()
    })
    parser.write(xml).close()
    return matches
  }
  async function target(part: string, id: string | undefined, type: string) {
    const xml = await zip
      .file(path.posix.join(path.posix.dirname(part), "_rels", path.posix.basename(part) + ".rels"))
      ?.async("string")
    if (!xml) throw new Error("Missing relationships")
    const found: string[] = []
    const parser = new SaxesParser({ xmlns: true })
    const stack: string[] = []
    parser.on("opentag", (tag) => {
      stack.push(`${tag.uri}:${tag.local}`)
      if (stack.length !== 2 || stack[0] !== `${packages}:Relationships` || stack[1] !== `${packages}:Relationship`)
        return
      const values = Object.fromEntries(
        Object.values(tag.attributes)
          .filter((v) => !v.uri)
          .map((v) => [v.local, v.value]),
      )
      if (id === undefined ? values.Type !== office + "/" + type : values.Id !== id) return
      if (
        values.Type !== office + "/" + type ||
        (values.TargetMode && values.TargetMode !== "Internal") ||
        !values.Target ||
        /[:\\%#?]/.test(values.Target) ||
        values.Target.startsWith("/")
      )
        throw new Error("Invalid internal relationship")
      found.push(path.posix.join(path.posix.dirname(part), values.Target))
    })
    parser.on("closetag", () => {
      stack.pop()
    })
    parser.write(xml).close()
    if (found.length !== 1) throw new Error("Missing or ambiguous relationship")
    return found[0]
  }
  const deck = await target("", undefined, "officeDocument")
  if (deck !== "ppt/presentation.xml") throw new Error("Invalid presentation entry point")
  const order = await nodes(deck, [`${p}:presentation`, `${p}:sldIdLst`, `${p}:sldId`], "id", office)
  if (order.length !== slides.length || new Set(order).size !== order.length) throw new Error("Slide order mismatch")
  const embedded: { slide: number; slot: string; media: string; digest: string }[] = []
  for (const [index, slide] of slides.entries()) {
    if (!slide.slot) continue
    const part = await target(deck, order[index], "slide")
    if (!/^ppt\/slides\/slide\d+\.xml$/.test(part)) throw new Error("Invalid slide part")
    const refs = await nodes(
      part,
      [`${p}:sld`, `${p}:cSld`, `${p}:spTree`, `${p}:pic`, `${p}:blipFill`, `${a}:blip`],
      "embed",
      office,
    )
    if (refs.length !== 1) throw new Error("Expected one embedded picture on target slide")
    const media = await target(part, refs[0], "image")
    if (!/^ppt\/media\/[^/]+\.(?:png|jpe?g)$/i.test(media)) throw new Error("Invalid picture part")
    const data = await zip.file(media)?.async("uint8array")
    const digest = data && createHash("sha256").update(data).digest("hex")
    if (!digest || digest !== assets.get(slide.slot)?.digest)
      throw new Error("Embedded picture does not match the verified receipt")
    embedded.push({ slide: index + 1, slot: slide.slot, media, digest })
  }
  return embedded
}
