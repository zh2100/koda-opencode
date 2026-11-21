import { inflateRawSync } from "node:zlib"
import path from "path"

const OFFICE = new Set([".docx", ".xlsx", ".pptx"])
const OPEN_DOCUMENT = new Set([".odt", ".ods", ".odp"])
const READABLE_DOCUMENTS = new Set([...OFFICE, ...OPEN_DOCUMENT, ".rtf", ".epub"])
const MAX_ARCHIVE_ENTRIES = 256
const MAX_ENTRY_BYTES = 8 * 1024 * 1024
const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024
const MAX_TEXT_BYTES = 16 * 1024 * 1024

export function isOfficeDocument(filepath: string) {
  return OFFICE.has(path.extname(filepath).toLowerCase())
}

export function isReadableDocument(filepath: string) {
  return READABLE_DOCUMENTS.has(path.extname(filepath).toLowerCase())
}

export function extractOfficeText(filepath: string, bytes: Uint8Array, maxTextBytes = MAX_TEXT_BYTES) {
  const limit = textBudget(maxTextBytes)
  const ext = path.extname(filepath).toLowerCase()
  if (!OFFICE.has(ext)) return
  const files = unzip(bytes)
  if (!files) return
  try {
    if (ext === ".docx") return docxText(files.get("word/document.xml"), limit)
    if (ext === ".xlsx") return xlsxText(files, limit)
    return pptxText(files, limit)
  } catch (error) {
    if (error instanceof RangeError) return
    throw error
  }
}

export function extractDocumentText(filepath: string, bytes: Uint8Array, maxTextBytes = MAX_TEXT_BYTES) {
  const limit = textBudget(maxTextBytes)
  const ext = path.extname(filepath).toLowerCase()
  if (OFFICE.has(ext)) return extractOfficeText(filepath, bytes, limit)
  if (OPEN_DOCUMENT.has(ext)) {
    const files = unzip(bytes)
    if (!files) return
    try {
      return openDocumentText(ext, files, limit)
    } catch {
      return
    }
  }
  if (ext === ".rtf") return boundedText(rtfText(Buffer.from(bytes).toString("latin1")), limit)
  if (ext === ".epub") {
    const files = unzip(bytes)
    if (!files) return
    try {
      return epubText(files, limit)
    } catch (error) {
      if (error instanceof RangeError) return
      throw error
    }
  }
}

function unzip(data: Uint8Array) {
  try {
    const buf = Buffer.from(data)
    const eocd = findEocd(buf)
    if (eocd < 0) return
    const count = buf.readUInt16LE(eocd + 10)
    let offset = buf.readUInt32LE(eocd + 16)
    if (offset > buf.length) return
    if (count > MAX_ARCHIVE_ENTRIES) return
    const files = new Map<string, string>()
    let total = 0
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
      if (method !== 0 && method !== 8) continue
      if (method === 0 && compressed.length > MAX_ENTRY_BYTES) return
      const raw = method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: MAX_ENTRY_BYTES })
      if (raw.length > MAX_ENTRY_BYTES) return
      total += raw.length
      if (total > MAX_ARCHIVE_BYTES) return
      files.set(name.replaceAll("\\", "/"), raw.toString("utf8"))
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

function docxText(xml: string | undefined, maxTextBytes: number) {
  if (!xml) return
  const writer = textWriter(maxTextBytes)
  for (const part of xml.split(/<w:p(?:\s[^>]*)?>/).slice(1)) {
    const line = paragraph(part).trim()
    if (line.length === 0) continue
    writer.appendLine(line)
  }
  return writer.finish()
}

function paragraph(xml: string) {
  const parts: string[] = []
  const re = /<w:tab\s*\/>|<w:br\s*\/>|<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:t(?:\s[^>]*)?\/>/g
  for (const match of xml.matchAll(re)) {
    if (match[0].startsWith("<w:tab")) parts.push("\t")
    else if (match[0].startsWith("<w:br")) parts.push("\n")
    else parts.push(decodeXml(match[1] ?? ""))
  }
  return parts.join("")
}

function xlsxText(files: Map<string, string>, maxTextBytes: number) {
  const shared = sharedStrings(files.get("xl/sharedStrings.xml"))
  const names = sheetNames(files)
  const sheets = [...files.keys()]
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort((a, b) => sheetNumber(a) - sheetNumber(b))
  if (sheets.length === 0 && !files.has("xl/workbook.xml")) return
  const writer = textWriter(maxTextBytes)
  for (const name of sheets) {
    writer.appendBlock([`# ${names.get(name) ?? `Sheet${sheetNumber(name)}`}`, ...sheetRows(files.get(name) ?? "", shared, writer.remaining)])
  }
  return writer.finish()
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

function sheetRows(xml: string, shared: string[], remaining: () => number) {
  const rows: string[] = []
  for (const match of xml.matchAll(/<row\b[^>]*(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const cells = new Map<number, { value: string; bytes: number }>()
    let valueBytes = 0
    for (const cell of match[1]?.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/gs) ?? []) {
      const attrs = cell[1] ?? ""
      const ref = attrs.match(/\br="([A-Z]+)(\d+)"/)
      const column = columnIndex(ref?.[1] ?? "")
      const row = Number(ref?.[2] ?? "")
      if (!ref || !Number.isSafeInteger(row) || row < 1 || row > 1048576) throw new RangeError("Invalid XLSX cell")
      const value = cellValue(attrs, cell[2] ?? "", shared)
      if (value === "") continue
      const bytes = utf8Bytes(value)
      const previous = cells.get(column)
      if (previous) valueBytes -= previous.bytes
      valueBytes += bytes
      if (!Number.isSafeInteger(valueBytes)) throw new RangeError("Office text exceeds output budget")
      cells.set(column, { value, bytes })
    }
    if (cells.size === 0) continue
    const width = Math.max(...cells.keys()) + 1
    const separators = width - 1
    const next = valueBytes + separators
    if (!Number.isSafeInteger(next) || next > remaining()) throw new RangeError("Office text exceeds output budget")
    const fields = Array.from({ length: width }, (_, index) => cells.get(index)?.value ?? "")
    rows.push(fields.join("\t"))
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
  if (!/^[A-Z]{1,3}$/.test(letters)) throw new RangeError("Invalid XLSX column")
  let index = 0
  for (const char of letters) {
    index = index * 26 + (char.charCodeAt(0) - 64)
    if (!Number.isSafeInteger(index)) throw new RangeError("Invalid XLSX column")
  }
  const column = index - 1
  if (column > 16383) throw new RangeError("Invalid XLSX column")
  return column
}

function pptxText(files: Map<string, string>, maxTextBytes: number) {
  const slides = [...files.keys()]
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => slideNumber(a) - slideNumber(b))
  if (slides.length === 0 && !files.has("ppt/presentation.xml")) return
  const writer = textWriter(maxTextBytes)
  for (const name of slides) {
    const lines = (files.get(name) ?? "")
      .split(/<a:p(?:\s[^>]*)?>/)
      .slice(1)
      .map((part) => tagged(part, "a:t").join(""))
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
    writer.appendBlock([`# Slide ${slideNumber(name)}`, ...lines])
  }
  return writer.finish()
}

function textWriter(maxTextBytes: number) {
  const budget = { remaining: textBudget(maxTextBytes) }
  let text = ""
  const charge = (value: string, separator: string) => {
    const cost = utf8Bytes(separator) + utf8Bytes(value)
    if (!Number.isSafeInteger(cost) || cost > budget.remaining) throw new RangeError("Office text exceeds output budget")
    budget.remaining -= cost
    text += separator + value
  }
  return {
    remaining: () => budget.remaining,
    appendLine(value: string) {
      charge(value, text.length > 0 ? "\n" : "")
    },
    appendBlock(lines: string[]) {
      let cost = text.length > 0 ? 2 : 0
      for (const [index, line] of lines.entries()) {
        const next = cost + utf8Bytes(line) + (index > 0 ? 1 : 0)
        if (!Number.isSafeInteger(next)) throw new RangeError("Office text exceeds output budget")
        cost = next
      }
      if (cost > budget.remaining) throw new RangeError("Office text exceeds output budget")
      budget.remaining -= cost
      text += `${text.length > 0 ? "\n\n" : ""}${lines.join("\n")}`
    },
    finish() {
      if (utf8Bytes(text) + budget.remaining !== maxTextBytes) throw new RangeError("Office text budget diverged")
      return text.length > 0 ? text : undefined
    },
  }
}

function boundedText(value: string | undefined, maxTextBytes: number) {
  if (value === undefined) return
  try {
    const writer = textWriter(maxTextBytes)
    writer.appendLine(value)
    return writer.finish()
  } catch (error) {
    if (error instanceof RangeError) return
    throw error
  }
}

function openDocumentText(ext: string, files: Map<string, string>, maxTextBytes = MAX_TEXT_BYTES) {
  const xml = files.get("content.xml")
  if (!xml) return
  if (ext === ".ods") return spreadsheetDocumentText(xml, maxTextBytes, { remaining: textBudget(maxTextBytes) })
  const budget = { remaining: textBudget(maxTextBytes) }
  const scratch = { remaining: textBudget(maxTextBytes) }
  const lines: string[] = []
  for (const item of xml.matchAll(/<(?:text:h|text:p)\b[^>]*>[\s\S]*?<\/(?:text:h|text:p)>/g)) {
    const line = xmlText(item[0], scratch)
    if (line.length === 0) continue
    pushLine(lines, line, budget)
  }
  return lines.length > 0 ? lines.join("\n") : undefined
}

function spreadsheetDocumentText(xml: string, maxTextBytes = MAX_TEXT_BYTES, expansion = { remaining: textBudget(maxTextBytes) }) {
  const budget = { remaining: textBudget(maxTextBytes) }
  const tables = [...xml.matchAll(/<table:table\b([^>]*)>([\s\S]*?)<\/table:table>/g)]
  const lines: string[] = []
  for (const table of tables) {
    const name = table[1]?.match(/\btable:name="([^"]+)"/)?.[1]
    if (name) pushLine(lines, `# ${decodeXml(name)}`, budget)
    const rows = [...(table[2] ?? "").matchAll(/<table:table-row\b([^>]*)>([\s\S]*?)<\/table:table-row>|<table:table-row\b([^>]*)\/>/g)]
    for (const row of rows) {
      const repeat = odsRepeat(row[1]?.match(/\btable:number-rows-repeated="(\d+)"/)?.[1] ?? row[3]?.match(/\btable:number-rows-repeated="(\d+)"/)?.[1])
      const cells = odsCells(row[2] ?? "", budget, expansion)
      if (cells.replaceAll("\t", "").length === 0) continue
      for (let index = 0; index < repeat; index++) pushLine(lines, cells, budget)
    }
  }
  return lines.length > 0 ? lines.join("\n") : undefined
}

function odsCells(row: string, budget: { remaining: number }, expansion: { remaining: number }) {
  const cells = [...row.matchAll(/<table:(?:table-cell|covered-table-cell)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/table:(?:table-cell|covered-table-cell)>)/g)]
  const values: string[] = []
  let rowBytes = 0
  for (const cell of cells) {
    const repeat = odsRepeat(cell[1]?.match(/\btable:number-columns-repeated="(\d+)"/)?.[1])
    const value = xmlText(cell[2] ?? "", expansion)
    const valueBytes = utf8Bytes(value)
    const nextBytes = rowBytes + valueBytes * repeat
    const expanded = nextBytes + Math.max(0, values.length + repeat - 1)
    if (!Number.isSafeInteger(expanded) || expanded > budget.remaining) throw new Error("Office text exceeds output budget")
    for (let index = 0; index < repeat; index++) values.push(value)
    rowBytes = nextBytes
  }
  while (values.at(-1) === "") values.pop()
  return values.join("\t")
}

function odsRepeat(value: string | undefined) {
  if (!value) return 1
  if (!/^[1-9]\d*$/.test(value)) throw new Error("Invalid ODS repeat count")
  const repeat = Number(value)
  if (!Number.isSafeInteger(repeat)) throw new Error("Invalid ODS repeat count")
  return repeat
}

function pushLine(lines: string[], value: string, budget: { remaining: number }) {
  const separator = lines.length > 0 ? 1 : 0
  const cost = utf8Bytes(value) + separator
  if (!Number.isSafeInteger(cost) || cost > budget.remaining) throw new Error("Office text exceeds output budget")
  budget.remaining -= cost
  lines.push(value)
}

function utf8Bytes(value: string) {
  return new TextEncoder().encode(value).byteLength
}

function textBudget(value: number) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_TEXT_BYTES) throw new Error("Office text exceeds output budget")
  return value
}

function xmlText(value: string, expansion: { remaining: number } = { remaining: MAX_TEXT_BYTES }) {
  let text = ""
  let last = 0
  let expanded = 0
  for (const space of value.matchAll(/<text:s\b([^>]*?)\/>/g)) {
    text += plainXml(value.slice(last, space.index))
    const count = space[1]?.match(/\btext:c="([^"]*)"/)?.[1]
    const repeat = count === undefined ? 1 : spaceRepeat(count)
    expanded += repeat
    if (!Number.isSafeInteger(expanded) || expanded > expansion.remaining) throw new Error("Office text exceeds output budget")
    text += " ".repeat(repeat)
    last = (space.index ?? 0) + space[0].length
  }
  text += plainXml(value.slice(last))
  expansion.remaining -= expanded
  return trimLineSpace(text)
}

function plainXml(value: string) {
  return decodeXml(value.replace(/<text:tab\s*\/>/g, "\t").replace(/<text:line-break\s*\/>/g, "\n").replace(/<[^>]+>/g, ""))
}

function spaceRepeat(value: string) {
  if (!/^[1-9]\d*$/.test(value)) throw new Error("Invalid text space count")
  const repeat = Number(value)
  if (!Number.isSafeInteger(repeat)) throw new Error("Invalid text space count")
  return repeat
}

function trimLineSpace(value: string) {
  let out = ""
  let pending = ""
  for (const char of value) {
    if (char === " " || char === "\t") {
      pending += char
      continue
    }
    if (char === "\n") {
      pending = ""
      out += "\n"
      continue
    }
    out += pending
    pending = ""
    out += char
  }
  return out.trim()
}

function epubText(files: Map<string, string>, maxTextBytes: number) {
  const writer = textWriter(maxTextBytes)
  const chapters = [...files.entries()]
    .filter(([name]) => /\.(?:x?html?)$/i.test(name))
    .sort(([a], [b]) => a.localeCompare(b))
  for (const [, value] of chapters) {
    const chapter = xmlText(
      value
        .replace(/<script\b[\s\S]*?<\/script>/gi, "")
        .replace(/<style\b[\s\S]*?<\/style>/gi, "")
        .replace(/<\/(?:h[1-6]|p|div|li|br)\s*>/gi, "\n"),
    )
      .replace(/[ \t]+/g, " ")
      .replace(/\n+/g, "\n")
      .trim()
    if (chapter.length === 0) continue
    writer.appendBlock([chapter])
  }
  return writer.finish()
}

function rtfText(value: string) {
  const output: string[] = []
  const bytes: number[] = []
  const groups: Array<{ ignored: boolean; codepage: number; fallback: number }> = []
  const destinations = /^(?:fonttbl|colortbl|stylesheet|info|pict|object|header\d*|footer\d*)$/
  let ignored = false
  let codepage = 1252
  let fallback = 1
  let skipFallback = 0

  const flush = () => {
    if (bytes.length === 0) return
    output.push(decodeRtfBytes(bytes, codepage))
    bytes.length = 0
  }

  for (let index = 0; index < value.length; index++) {
    const char = value[index]
    if (char === "{") {
      flush()
      groups.push({ ignored, codepage, fallback })
      const control = value.slice(index + 1).match(/^\\\*?([a-z]+)\d* ?/i)
      if (control && destinations.test(control[1] ?? "")) ignored = true
      continue
    }
    if (char === "}") {
      flush()
      const previous = groups.pop()
      ignored = previous?.ignored ?? false
      codepage = previous?.codepage ?? 1252
      fallback = previous?.fallback ?? 1
      continue
    }
    if (ignored) continue
    if (skipFallback > 0 && char !== "\\" && char !== "{" && char !== "}") {
      skipFallback -= 1
      continue
    }
    if (char !== "\\") {
      flush()
      output.push(char)
      continue
    }

    const next = value[index + 1]
    if (next === "\\" || next === "{" || next === "}") {
      flush()
      output.push(next)
      index += 1
      continue
    }
    if (next === "'") {
      const hex = value.slice(index + 2, index + 4)
      if (/^[0-9a-f]{2}$/i.test(hex)) bytes.push(Number.parseInt(hex, 16))
      index += 3
      continue
    }
    const control = value.slice(index + 1).match(/^([a-z]+)(-?\d+)? ?/i)
    if (!control) {
      index += 1
      continue
    }
    const word = control[1]?.toLowerCase()
    const number = control[2] ? Number(control[2]) : undefined
    index += control[0].length
    flush()
    if (word === "par" || word === "line") output.push("\n")
    if (word === "tab") output.push("\t")
    if (word === "ansicpg" && number !== undefined) codepage = number
    if (word === "uc" && number !== undefined) fallback = number
    if (word === "u" && number !== undefined) {
      output.push(String.fromCodePoint(number < 0 ? number + 65536 : number))
      skipFallback = fallback
    }
  }

  flush()
  return output.join("").replace(/\r\n?/g, "\n").trim() || undefined
}

function decodeRtfBytes(bytes: number[], codepage: number) {
  const data = Uint8Array.from(bytes)
  if (codepage === 65001) return new TextDecoder("utf-8").decode(data)
  if (codepage === 936) return new TextDecoder("gb18030" as "utf-8").decode(data)
  return new TextDecoder("windows-1252").decode(data)
}

function slideNumber(name: string) {
  return Number(name.match(/slide(\d+)\.xml$/)?.[1] ?? 0)
}
