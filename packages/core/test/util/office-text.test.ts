import { deflateRawSync } from "node:zlib"
import { describe, expect, test } from "bun:test"
import { extractDocumentText, extractOfficeText } from "../../src/util/office-text"

function zip(entries: Record<string, string>) {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [name, text] of Object.entries(entries)) {
    const nameBuf = Buffer.from(name)
    const raw = Buffer.from(text)
    const data = deflateRawSync(raw)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    locals.push(local, nameBuf, data)
    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0)
    cen.writeUInt16LE(20, 4)
    cen.writeUInt16LE(20, 6)
    cen.writeUInt16LE(8, 10)
    cen.writeUInt32LE(data.length, 20)
    cen.writeUInt32LE(raw.length, 24)
    cen.writeUInt16LE(nameBuf.length, 28)
    cen.writeUInt32LE(offset, 42)
    central.push(cen, nameBuf)
    offset += local.length + nameBuf.length + data.length
  }
  const centralBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(Object.keys(entries).length, 8)
  eocd.writeUInt16LE(Object.keys(entries).length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBuf, eocd])
}

describe("core extractDocumentText", () => {
  test("keeps Value at column 301 after 300 repeated empty columns", () => {
    const bytes = zip({
      "content.xml": `<office:document-content><office:body><office:spreadsheet><table:table table:name="Data"><table:table-row><table:table-cell table:number-columns-repeated="300"/><table:table-cell><text:p>Value</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet></office:body></office:document-content>`,
    })
    const text = extractDocumentText("wide.ods", bytes)
    expect(text?.split("\n")[1]?.split("\t")[300]).toBe("Value")
    expect(text?.split("\n")[1]?.split("\t")).toHaveLength(301)
  })

  test("keeps repeated rows and rejects an over-budget repeat", () => {
    const rows = zip({
      "content.xml": `<office:document-content><office:body><office:spreadsheet><table:table><table:table-row table:number-rows-repeated="2"><table:table-cell><text:p>Row</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet></office:body></office:document-content>`,
    })
    expect(extractDocumentText("rows.ods", rows)).toBe("Row\nRow")
    const overflow = zip({
      "content.xml": `<office:document-content><office:body><office:spreadsheet><table:table><table:table-row><table:table-cell table:number-columns-repeated="20000000"><text:p>X</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet></office:body></office:document-content>`,
    })
    expect(extractDocumentText("overflow.ods", overflow)).toBeUndefined()
    const repeated = zip({
      "content.xml": `<office:document-content><office:body><office:spreadsheet><table:table><table:table-row table:number-rows-repeated="3000"><table:table-cell><text:p>${"中".repeat(2000)}</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet></office:body></office:document-content>`,
    })
    expect(extractDocumentText("rows.ods", repeated)).toBeUndefined()
    const columns = zip({
      "content.xml": `<office:document-content><office:body><office:spreadsheet><table:table><table:table-row>${`<table:table-cell table:number-columns-repeated="1000000"><text:p>A</text:p></table:table-cell>`.repeat(20)}</table:table-row></table:table></office:spreadsheet></office:body></office:document-content>`,
    })
    expect(extractDocumentText("columns.ods", columns)).toBeUndefined()
    const rowsXml = `<office:document-content><office:body><office:spreadsheet><table:table><table:table-row table:number-rows-repeated="3"><table:table-cell><text:p>${"R".repeat(100)}</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet></office:body></office:document-content>`
    expect(Buffer.byteLength(rowsXml)).toBeLessThan(8 * 1024 * 1024)
    const rowsBytes = zip({ "content.xml": rowsXml })
    const rowsText = extractDocumentText("separator-rows.ods", rowsBytes, 302)
    expect(rowsText).toBe(`${"R".repeat(100)}\n${"R".repeat(100)}\n${"R".repeat(100)}`)
    expect(Buffer.byteLength(rowsText ?? "", "utf8")).toBe(302)
    expect(extractDocumentText("separator-rows.ods", rowsBytes, 301)).toBeUndefined()
    const tablesXml = `<office:document-content><office:body><office:spreadsheet><table:table table:name="A"></table:table><table:table table:name="B"></table:table></office:spreadsheet></office:body></office:document-content>`
    expect(Buffer.byteLength(tablesXml)).toBeLessThan(8 * 1024 * 1024)
    const tablesBytes = zip({ "content.xml": tablesXml })
    expect(extractDocumentText("separator-tables.ods", tablesBytes, 7)).toBe("# A\n# B")
    expect(extractDocumentText("separator-tables.ods", tablesBytes, 6)).toBeUndefined()
  })

  test("rejects repeated spaces before expanding them", () => {
    const spaced = `<office:document-content><office:body><office:text><text:p>A<text:s text:c="3"/>B</text:p></office:text></office:body></office:document-content>`
    expect(Buffer.byteLength(spaced)).toBeLessThan(8 * 1024 * 1024)
    const bytes = zip({ "content.xml": spaced })
    expect(extractDocumentText("spaces.odt", bytes, 5)).toBe("A   B")
    expect(extractDocumentText("spaces.odt", bytes, 4)).toBeUndefined()
    const huge = `<office:document-content><office:body><office:text><text:p>A<text:s text:c="17000000"/>B</text:p></office:text></office:body></office:document-content>`
    expect(extractDocumentText("huge.odt", zip({ "content.xml": huge }), 32)).toBeUndefined()
    expect(extractDocumentText("huge.odp", zip({ "content.xml": huge }), 32)).toBeUndefined()
    const sheet = `<office:document-content><office:body><office:spreadsheet><table:table><table:table-row><table:table-cell><text:p>A<text:s text:c="3"/>B</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet></office:body></office:document-content>`
    expect(extractDocumentText("spaces.ods", zip({ "content.xml": sheet }), 5)).toBe("A   B")
    const blankRows = Array.from(
      { length: 50 },
      () =>
        `<table:table-row><table:table-cell><text:p><text:s text:c="16"/></text:p></table:table-cell></table:table-row>`,
    ).join("")
    const blankSheet = `<office:document-content><office:body><office:spreadsheet><table:table>${blankRows}</table:table></office:spreadsheet></office:body></office:document-content>`
    const blankCells = `<office:document-content><office:body><office:spreadsheet><table:table><table:table-row>${`<table:table-cell><text:p><text:s text:c="16"/></text:p></table:table-cell>`.repeat(50)}<table:table-cell><text:p>X</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet></office:body></office:document-content>`
    expect(Buffer.byteLength(blankSheet)).toBeLessThan(8 * 1024 * 1024)
    expect(Buffer.byteLength(blankCells)).toBeLessThan(8 * 1024 * 1024)
    expect(
      extractDocumentText("bad.odt", zip({ "content.xml": spaced.replace('text:c="3"', 'text:c="no"') })),
    ).toBeUndefined()
    const paragraphs = Array.from({ length: 50 }, () => `<text:p><text:s text:c="16"/></text:p>`).join("")
    const many = `<office:document-content><office:body><office:text>${paragraphs}</office:text></office:body></office:document-content>`
    expect(Buffer.byteLength(many)).toBeLessThan(8 * 1024 * 1024)
    const repeat = String.prototype.repeat
    let expanded = 0
    String.prototype.repeat = function (count: number) {
      if (String(this) === " ") expanded += count
      return repeat.call(this, count)
    }
    try {
      expect(extractDocumentText("blank-rows.ods", zip({ "content.xml": blankSheet }), 32)).toBeUndefined()
      expect(expanded).toBeLessThanOrEqual(32)
      expanded = 0
      expect(extractDocumentText("blank-cells.ods", zip({ "content.xml": blankCells }), 32)).toBeUndefined()
      expect(expanded).toBeLessThanOrEqual(32)
      expanded = 0
      expect(extractDocumentText("many.odt", zip({ "content.xml": many }), 32)).toBeUndefined()
      expect(expanded).toBeLessThanOrEqual(32)
      expanded = 0
      expect(extractDocumentText("many.odp", zip({ "content.xml": many }), 32)).toBeUndefined()
      expect(expanded).toBeLessThanOrEqual(32)
    } finally {
      String.prototype.repeat = repeat
    }
  })

  test("D01 rejects the reviewed 17000 shared-string workbook under the default budget", () => {
    const shared = "S".repeat(1024)
    const rows = Array.from(
      { length: 17000 },
      (_, index) => `<row r="${index + 1}"><c r="A${index + 1}" t="s"><v>0</v></c></row>`,
    ).join("")
    const bytes = zip({
      "xl/sharedStrings.xml": `<sst><si><t>${shared}</t></si></sst>`,
      "xl/worksheets/sheet1.xml": `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xr:uid="{00000000-0000-0000-0000-000000000000}"><sheetData>${rows}</sheetData></worksheet>`,
    })
    expect(bytes.byteLength).toBe(76083)
    expect(extractDocumentText("reviewed.xlsx", bytes)).toBeUndefined()
    expect(extractOfficeText("reviewed.xlsx", bytes)).toBeUndefined()
  })

  test("D02 accepts an exact shared-string budget and rejects one byte less", () => {
    const bytes = xlsx({ "A1:s": "AB", "A2:s": "CD" })
    const text = extractDocumentText("exact.xlsx", bytes, 14)
    expect(text).toBe("# Sheet1\nAB\nCD")
    expect(Buffer.byteLength(text ?? "")).toBe(14)
    expect(extractDocumentText("exact.xlsx", bytes, 13)).toBeUndefined()
    expect(extractOfficeText("exact.xlsx", bytes, 13)).toBeUndefined()
  })

  test("D03 counts Chinese and emoji cells as UTF-8 bytes", () => {
    const bytes = zip({
      "xl/worksheets/sheet1.xml": `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>中</t></is></c><c r="B1" t="inlineStr"><is><t>🙂</t></is></c></row></sheetData></worksheet>`,
    })
    const text = extractDocumentText("utf8.xlsx", bytes, 17)
    expect(text).toBe("# Sheet1\n中\t🙂")
    expect(Buffer.byteLength(text ?? "")).toBe(17)
    expect(text?.length).toBe(13)
    expect(extractDocumentText("utf8.xlsx", bytes, 16)).toBeUndefined()
  })

  test("D04 rejects rows that are individually under budget but over budget together", () => {
    const bytes = xlsx({ A1: "abc", A2: "def" })
    expect(extractDocumentText("rows.xlsx", bytes, 16)).toBe("# Sheet1\nabc\ndef")
    expect(extractDocumentText("rows.xlsx", bytes, 15)).toBeUndefined()
  })

  test("D05 charges headers and every sheet separator", () => {
    const bytes = xlsxSheets(["Sales", "Empty", "Later"], ["Ada", "", "Bob"])
    const text = extractDocumentText("sheets.xlsx", bytes, 33)
    expect(text).toBe("# Sales\nAda\n\n# Empty\n\n# Later\nBob")
    expect(Buffer.byteLength(text ?? "")).toBe(33)
    expect(extractDocumentText("sheets.xlsx", bytes, 32)).toBeUndefined()
  })

  test("D06 keeps sparse AA and XFD positions and their separator cost", () => {
    const bytes = xlsx({ AA1: "Z", XFD1: "End" })
    const text = extractDocumentText("sparse.xlsx", bytes, 16396)
    expect(text?.split("\n")[1]?.split("\t")[26]).toBe("Z")
    expect(text?.split("\n")[1]?.split("\t")[16383]).toBe("End")
    expect(Buffer.byteLength(text ?? "")).toBe(16396)
    expect(extractDocumentText("sparse.xlsx", bytes, 16395)).toBeUndefined()
  })

  test("D07 rejects illegal coordinates before allocating a wide row", () => {
    const repeat = Array.from
    let allocated = 0
    Array.from = function <T>(items: ArrayLike<T>) {
      allocated = Math.max(allocated, items.length)
      return repeat(items)
    } as typeof Array.from
    try {
      expect(extractDocumentText("xfe.xlsx", xlsx({ XFE1: "bad" }))).toBeUndefined()
      expect(extractDocumentText("long.xlsx", xlsx({ ABCD1: "bad" }))).toBeUndefined()
      expect(extractDocumentText("row.xlsx", xlsx({ A0: "bad" }))).toBeUndefined()
      expect(extractDocumentText("huge-row.xlsx", xlsx({ A1048577: "bad" }))).toBeUndefined()
      expect(allocated).toBe(0)
    } finally {
      Array.from = repeat
    }
  })

  test("D08 applies the default budget to both office entry points", () => {
    const bytes = reviewedSharedWorkbook()
    expect(extractOfficeText("reviewed.xlsx", bytes)).toBeUndefined()
    expect(extractDocumentText("reviewed.xlsx", bytes)).toBeUndefined()
  })

  test("D09 keeps normal document text and rejects a one-byte-short budget", () => {
    const docx = zip({
      "word/document.xml": `<w:document><w:body><w:p><w:r><w:t>Hi</w:t><w:tab/><w:t>中</w:t></w:r></w:p><w:p><w:r><w:t>Yo</w:t></w:r></w:p></w:body></w:document>`,
    })
    expect(extractDocumentText("note.docx", docx)).toBe("Hi\t中\nYo")
    expect(Buffer.byteLength("Hi\t中\nYo")).toBe(9)
    expect(extractDocumentText("note.docx", docx, 9)).toBe("Hi\t中\nYo")
    expect(extractDocumentText("note.docx", docx, 8)).toBeUndefined()
    const pptx = zip({
      "ppt/presentation.xml": `<p:presentation/>`,
      "ppt/slides/slide1.xml": `<p:sld><a:p><a:r><a:t>Hi</a:t></a:r></a:p><a:p><a:r><a:t>🙂</a:t></a:r></a:p></p:sld>`,
    })
    expect(extractDocumentText("deck.pptx", pptx)).toBe("# Slide 1\nHi\n🙂")
    expect(Buffer.byteLength("# Slide 1\nHi\n🙂")).toBe(17)
    expect(extractDocumentText("deck.pptx", pptx, 17)).toBe("# Slide 1\nHi\n🙂")
    expect(extractDocumentText("deck.pptx", pptx, 16)).toBeUndefined()
    const rtf = Buffer.from(String.raw`{\rtf1\ansi Hello\par world}`)
    expect(extractDocumentText("note.rtf", rtf)).toBe("Hello\nworld")
    expect(extractDocumentText("note.rtf", rtf, 11)).toBe("Hello\nworld")
    expect(extractDocumentText("note.rtf", rtf, 10)).toBeUndefined()
    const epub = zip({
      "OEBPS/a.xhtml": "<html><body><p>Hi</p></body></html>",
      "OEBPS/b.xhtml": "<html><body><p>Yo</p></body></html>",
    })
    expect(extractDocumentText("book.epub", epub)).toBe("Hi\n\nYo")
    expect(extractDocumentText("book.epub", epub, 6)).toBe("Hi\n\nYo")
    expect(extractDocumentText("book.epub", epub, 5)).toBeUndefined()
  })
})

function reviewedSharedWorkbook() {
  const rows = Array.from(
    { length: 17000 },
    (_, index) => `<row r="${index + 1}"><c r="A${index + 1}" t="s"><v>0</v></c></row>`,
  ).join("")
  return zip({
    "xl/sharedStrings.xml": `<sst><si><t>${"S".repeat(1024)}</t></si></sst>`,
    "xl/worksheets/sheet1.xml": `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xr:uid="{00000000-0000-0000-0000-000000000000}"><sheetData>${rows}</sheetData></worksheet>`,
  })
}

function xlsx(cells: Record<string, string>) {
  const shared: string[] = []
  const rows = new Map<number, string[]>()
  for (const [ref, value] of Object.entries(cells)) {
    const match = ref.match(/^([A-Z]+)(\d+)(?::(?:s|inline))?$/)
    const column = match?.[1] ?? "A"
    const row = Number(match?.[2] ?? "1")
    const sharedRef = ref.endsWith(":s")
    const inline = ref.endsWith(":inline")
    const index = sharedRef ? shared.push(value) - 1 : -1
    const current = rows.get(row) ?? []
    current.push(
      inline
        ? `<c r="${column}${row}" t="inlineStr"><is><t>${value}</t></is></c>`
        : `<c r="${column}${row}"${sharedRef ? ` t="s"` : ""}><v>${sharedRef ? index : value}</v></c>`,
    )
    rows.set(row, current)
  }
  const body = [...rows.entries()].map(([row, items]) => `<row r="${row}">${items.join("")}</row>`).join("")
  return zip({
    "xl/sharedStrings.xml": `<sst>${shared.map((item) => `<si><t>${item}</t></si>`).join("")}</sst>`,
    "xl/worksheets/sheet1.xml": `<worksheet><sheetData>${body}</sheetData></worksheet>`,
  })
}

function xlsxSheets(names: string[], rows: string[]) {
  const entries: Record<string, string> = {
    "xl/workbook.xml": `<workbook><sheets>${names.map((name, index) => `<sheet name="${name}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("")}</sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships>${names.map((_, index) => `<Relationship Id="rId${index + 1}" Target="worksheets/sheet${index + 1}.xml"/>`).join("")}</Relationships>`,
  }
  names.forEach((_, index) => {
    const value = rows[index] ?? ""
    const body = value.length > 0 ? `<row r="1"><c r="A1" t="inlineStr"><is><t>${value}</t></is></c></row>` : ""
    entries[`xl/worksheets/sheet${index + 1}.xml`] = `<worksheet><sheetData>${body}</sheetData></worksheet>`
  })
  return zip(entries)
}
