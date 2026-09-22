import { inflateRawSync } from "node:zlib"
import path from "path"

const OFFICE = new Set([".docx", ".xlsx", ".pptx"])

export function isOfficeDocument(filepath: string) {
  return OFFICE.has(path.extname(filepath).toLowerCase())
}

export function extractOfficeText(filepath: string, bytes: Uint8Array) {
  const ext = path.extname(filepath).toLowerCase()
  if (!OFFICE.has(ext)) return
  const files = unzip(bytes)
  if (!files) return
  if (ext === ".docx") return docxText(files.get("word/document.xml"))
  if (ext === ".xlsx") return xlsxText(files)
  return pptxText(files)
}

function unzip(data: Uint8Array) {
  try {
    const buf = Buffer.from(data)
    const eocd = findEocd(buf)
    if (eocd < 0) return
    const count = buf.readUInt16LE(eocd + 10)
    let offset = buf.readUInt32LE(eocd + 16)
    if (offset > buf.length) return
    const files = new Map<string, string>()
    for (let i = 0; i < count; i++) {
      if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== 0x02014b50) return
      const method = buf.readUInt16LE(offset + 10)
      const size = buf.readUInt32LE(offset + 20)
      const nameLen = buf.readUInt16LE(offset + 28)
      const extraLen = buf.readUInt16LE(offset + 30)
      const commentLen = buf.readUInt16LE(offset + 32)
      const local = buf.readUInt32LE(offset + 42)
      const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString("utf8")
      offset += 46 + nameLen + extraLen + commentLen
      if (name.endsWith("/") || local + 30 > buf.length) continue
      const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
      if (dataStart + size > buf.length) continue
      const compressed = buf.subarray(dataStart, dataStart + size)
      const raw = method === 0 ? compressed : method === 8 ? inflateRawSync(compressed) : undefined
      if (raw) files.set(name.replaceAll("\\", "/"), raw.toString("utf8"))
    }
    return files
  } catch {
    return
  }
}

function findEocd(buf: Buffer) {
  const min = Math.max(0, buf.length - 22 - 0xffff)
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i
  }
  return -1
}

function decodeXml(value: string) {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCodePoint(Number(num)))
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&")
}

function tagged(xml: string, tag: string) {
  const out: string[] = []
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g")
  for (const match of xml.matchAll(re)) out.push(decodeXml(match[1] ?? ""))
  return out
}

function docxText(xml: string | undefined) {
  if (!xml) return
  const lines = xml
    .split(/<w:p(?:\s[^>]*)?>/)
    .slice(1)
    .map((part) => paragraph(part).trim())
    .filter((line) => line.length > 0)
  return lines.join("\n")
}

function paragraph(xml: string) {
  const parts: string[] = []
  const re = /<w:tab\s*\/>|<w:br\s*\/>|<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g
  for (const match of xml.matchAll(re)) {
    if (match[0].startsWith("<w:tab")) parts.push("\t")
    else if (match[0].startsWith("<w:br")) parts.push("\n")
    else parts.push(decodeXml(match[1] ?? ""))
  }
  return parts.join("")
}

function xlsxText(files: Map<string, string>) {
  const shared = sharedStrings(files.get("xl/sharedStrings.xml"))
  const names = sheetNames(files)
  const sheets = [...files.keys()]
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort((a, b) => sheetNumber(a) - sheetNumber(b))
  if (sheets.length === 0 && !files.has("xl/workbook.xml")) return
  return sheets
    .map((name) => {
      const title = names.get(name) ?? `Sheet${sheetNumber(name)}`
      const rows = sheetRows(files.get(name) ?? "", shared)
      return [`# ${title}`, ...rows].join("\n")
    })
    .join("\n\n")
}

function sharedStrings(xml: string | undefined) {
  if (!xml) return []
  return xml
    .replace(/<rPh[\s\S]*?<\/rPh>/g, "")
    .split(/<si[\s>]/)
    .slice(1)
    .map((item) => tagged(item, "t").join(""))
}

function sheetNames(files: Map<string, string>) {
  const names = new Map<string, string>()
  const book = files.get("xl/workbook.xml")
  const rels = files.get("xl/_rels/workbook.xml.rels")
  if (!book || !rels) return names
  const targets = new Map<string, string>()
  for (const match of rels.matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
    const target = match[2]
    if (!target) continue
    targets.set(match[1] ?? "", target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`)
  }
  for (const match of book.matchAll(/<sheet\b[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)) {
    const target = targets.get(match[2] ?? "")
    if (target) names.set(target, decodeXml(match[1] ?? ""))
  }
  return names
}

function sheetNumber(name: string) {
  return Number(name.match(/sheet(\d+)\.xml$/)?.[1] ?? 0)
}

function sheetRows(xml: string, shared: string[]) {
  const rows: string[] = []
  for (const match of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = new Map<number, string>()
    for (const cell of match[1]?.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g) ?? []) {
      const attrs = cell[1] ?? ""
      const body = cell[2] ?? ""
      const ref = attrs.match(/\br="([A-Z]+)\d+"/)?.[1]
      if (!ref) continue
      const value = cellValue(attrs, body, shared)
      if (value !== "") cells.set(columnIndex(ref), value)
    }
    if (cells.size === 0) continue
    const width = Math.max(...cells.keys()) + 1
    rows.push(Array.from({ length: width }, (_, index) => cells.get(index) ?? "").join("\t"))
  }
  return rows
}

function cellValue(attrs: string, body: string, shared: string[]) {
  const type = attrs.match(/\bt="([^"]+)"/)?.[1]
  if (type === "inlineStr") return tagged(body, "t").join("")
  const raw = body.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? ""
  if (type === "s") return shared[Number(raw)] ?? ""
  if (type === "b") return raw === "1" ? "TRUE" : "FALSE"
  return decodeXml(raw)
}

function columnIndex(letters: string) {
  let index = 0
  for (const char of letters) index = index * 26 + (char.charCodeAt(0) - 64)
  return index - 1
}

function pptxText(files: Map<string, string>) {
  const slides = [...files.keys()]
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => slideNumber(a) - slideNumber(b))
  if (slides.length === 0 && !files.has("ppt/presentation.xml")) return
  return slides
    .map((name) => {
      const xml = files.get(name) ?? ""
      const lines = xml
        .split(/<a:p(?:\s[^>]*)?>/)
        .slice(1)
        .map((part) => tagged(part, "a:t").join(""))
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
      return [`# Slide ${slideNumber(name)}`, ...lines].join("\n")
    })
    .join("\n\n")
}

function slideNumber(name: string) {
  return Number(name.match(/slide(\d+)\.xml$/)?.[1] ?? 0)
}
