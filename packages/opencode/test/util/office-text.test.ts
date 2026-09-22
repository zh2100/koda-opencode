import { deflateRawSync } from "node:zlib"
import { describe, expect, test } from "bun:test"
import { extractOfficeText } from "../../src/util/office-text"

function zip(entries: Record<string, string>, method: 0 | 8 = 0) {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [name, text] of Object.entries(entries)) {
    const nameBuf = Buffer.from(name)
    const raw = Buffer.from(text)
    const data = method === 8 ? deflateRawSync(raw) : raw
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    locals.push(local, nameBuf, data)
    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0)
    cen.writeUInt16LE(20, 4)
    cen.writeUInt16LE(20, 6)
    cen.writeUInt16LE(method, 10)
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

describe("extractOfficeText", () => {
  test("extracts docx paragraphs", () => {
    const bytes = zip({
      "word/document.xml":
        `<w:document><w:body><w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:t xml:space="preserve"> &amp; world</w:t></w:r></w:p><w:p><w:r><w:t>Second</w:t></w:r></w:p></w:body></w:document>`,
    })
    expect(extractOfficeText("note.docx", bytes)).toBe("Hello & world\nSecond")
  })

  test("extracts xlsx sheets and pptx slides", () => {
    const sheet = zip(
      {
        "xl/workbook.xml": `<workbook><sheets><sheet name="Sales" sheetId="1" r:id="rId1"/></sheets></workbook>`,
        "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
        "xl/sharedStrings.xml": `<sst><si><t>Ada</t></si><si><t>Bob</t></si></sst>`,
        "xl/worksheets/sheet1.xml": `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1"><v>12</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>No</t></is></c></row></sheetData></worksheet>`,
      },
      8,
    )
    expect(extractOfficeText("book.xlsx", sheet)).toBe("# Sales\nAda\t\t12\nNo")

    const slides = zip({
      "ppt/presentation.xml": `<p:presentation/>`,
      "ppt/slides/slide2.xml": `<p:sld><a:p><a:r><a:t>Later</a:t></a:r></a:p></p:sld>`,
      "ppt/slides/slide1.xml": `<p:sld><a:p><a:r><a:t>First</a:t></a:r></a:p></p:sld>`,
    })
    expect(extractOfficeText("deck.pptx", slides)).toBe("# Slide 1\nFirst\n\n# Slide 2\nLater")
  })

  test("rejects a corrupt office file", () => {
    expect(extractOfficeText("note.docx", Buffer.from("not a zip"))).toBeUndefined()
  })
})
