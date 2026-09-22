import path from "path"
import { isOfficeDocument } from "./office-text"

const NAVY = "1F4E79"
const HEADING = "2E74B5"
const HEADING3 = "1F4D78"
const LINE = "D0D7DE"
const INK = "243447"
const PAPER = "F4F7FB"
const FONT = "Calibri"

export async function buildOfficeFile(filepath: string, content: string) {
  const ext = path.extname(filepath).toLowerCase()
  if (!isOfficeDocument(filepath)) return
  if (ext === ".docx") return buildDocx(content)
  if (ext === ".xlsx") return buildXlsx(content)
  return buildPptx(content)
}

async function buildDocx(content: string) {
  const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, HeadingLevel, BorderStyle, WidthType, ShadingType, AlignmentType, LevelFormat, VerticalAlign } =
    await import("docx")
  const children = docxBlocks(content, { Paragraph, TextRun, Table, TableRow, TableCell, HeadingLevel, BorderStyle, WidthType, ShadingType, AlignmentType, VerticalAlign })
  const doc = new Document({
    styles: {
      default: {
        document: {
          run: { font: FONT, size: 21, color: INK },
          paragraph: { spacing: { before: 60, after: 80, line: 276, lineRule: "auto" } },
        },
      },
    },
    numbering: {
      config: [
        {
          reference: "bullets",
          levels: [
            {
              level: 0,
              format: LevelFormat.BULLET,
              text: "•",
              alignment: AlignmentType.LEFT,
              style: { paragraph: { indent: { left: 720, hanging: 360 } } },
            },
          ],
        },
        {
          reference: "steps",
          levels: [
            {
              level: 0,
              format: LevelFormat.DECIMAL,
              text: "%1.",
              alignment: AlignmentType.LEFT,
              style: { paragraph: { indent: { left: 720, hanging: 360 } } },
            },
          ],
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: 11906, height: 16838 },
            margin: { top: 1134, right: 1134, bottom: 1134, left: 1134 },
          },
        },
        children,
      },
    ],
  })
  return Buffer.from(await Packer.toBuffer(doc))
}

function docxBlocks(content: string, api: Record<string, any>) {
  const lines = content.split(/\r?\n/)
  const blocks: unknown[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ""
    if (isTableRow(line)) {
      const rows: string[][] = []
      while (i < lines.length && isTableRow(lines[i] ?? "")) {
        const current = lines[i] ?? ""
        if (!isTableRule(current)) rows.push(tableCells(current))
        i++
      }
      i--
      if (rows.length > 0) blocks.push(wordTable(rows, api))
      continue
    }
    if (line.trim().length === 0) continue
    blocks.push(docxParagraph(line, api))
  }
  if (blocks.length === 0) blocks.push(new api.Paragraph(""))
  return blocks
}

function docxParagraph(line: string, api: Record<string, any>) {
  const heading = /^(#{1,3})\s+(.+)$/.exec(line)
  if (heading) {
    const level = heading[1]?.length ?? 1
    return new api.Paragraph({
      heading: level === 1 ? api.HeadingLevel.HEADING_1 : level === 2 ? api.HeadingLevel.HEADING_2 : api.HeadingLevel.HEADING_3,
      spacing: { before: level === 1 ? 280 : 200, after: 80 },
      border:
        level === 1
          ? { bottom: { style: api.BorderStyle.SINGLE, size: 8, color: HEADING, space: 1 } }
          : undefined,
      children: [
        new api.TextRun({
          text: heading[2] ?? "",
          bold: true,
          font: FONT,
          color: level === 3 ? HEADING3 : HEADING,
          size: level === 1 ? 32 : level === 2 ? 26 : 24,
        }),
      ],
    })
  }
  const bullet = /^[-*•]\s+(.+)$/.exec(line)
  if (bullet) {
    return new api.Paragraph({
      numbering: { reference: "bullets", level: 0 },
      children: [new api.TextRun({ text: bullet[1] ?? "", font: FONT, size: 21, color: INK })],
    })
  }
  const numbered = /^\d+[.)]\s+(.+)$/.exec(line)
  if (numbered) {
    return new api.Paragraph({
      numbering: { reference: "steps", level: 0 },
      children: [new api.TextRun({ text: numbered[1] ?? "", font: FONT, size: 21, color: INK })],
    })
  }
  return new api.Paragraph({
    children: [new api.TextRun({ text: line, font: FONT, size: 21, color: INK })],
  })
}

function wordTable(rows: string[][], api: Record<string, any>) {
  const width = Math.max(...rows.map((row) => row.length))
  const cols = Array.from({ length: width }, (_, index) => Math.max(6, ...rows.map((row) => visualWidth(row[index] ?? ""))))
  const total = cols.reduce((sum, item) => sum + item, 0) || 1
  const columnWidths = cols.map((item) => Math.max(800, Math.round((item / total) * 9360)))
  const thin = { style: api.BorderStyle.SINGLE, size: 4, color: LINE }
  return new api.Table({
    width: { size: 100, type: api.WidthType.PERCENTAGE },
    columnWidths,
    rows: rows.map(
      (row, index) =>
        new api.TableRow({
          tableHeader: index === 0,
          children: Array.from({ length: width }, (_, col) => {
            const header = index === 0
            return new api.TableCell({
              width: { size: columnWidths[col], type: api.WidthType.DXA },
              verticalAlign: api.VerticalAlign.CENTER,
              shading: { type: api.ShadingType.CLEAR, fill: header ? NAVY : index % 2 === 0 ? PAPER : "FFFFFF" },
              margins: { top: 60, bottom: 60, left: 100, right: 100 },
              borders: { top: thin, bottom: thin, left: thin, right: thin },
              children: [
                new api.Paragraph({
                  children: [
                    new api.TextRun({
                      text: row[col] ?? "",
                      bold: header,
                      font: FONT,
                      size: 21,
                      color: header ? "FFFFFF" : INK,
                    }),
                  ],
                }),
              ],
            })
          }),
        }),
    ),
  })
}

async function buildXlsx(content: string) {
  const ExcelJS = await import("exceljs")
  const workbook = new ExcelJS.Workbook()
  workbook.creator = "Koda"
  for (const sheet of parseSheets(content)) {
    const ws = workbook.addWorksheet(sheetName(sheet.name, workbook.worksheets.length), {
      views: [{ state: "frozen", ySplit: 1 }],
    })
    const width = Math.max(1, ...sheet.rows.map((row) => row.length))
    ws.columns = Array.from({ length: width }, (_, index) => ({
      width: Math.min(42, Math.max(12, ...sheet.rows.map((row) => visualWidth(row[index] ?? ""))) + 3),
    }))
    sheet.rows.forEach((row, rowIndex) => {
      const values = Array.from({ length: width }, (_, col) => coerce(row[col] ?? "", rowIndex))
      const added = ws.addRow(values)
      added.height = 22
      added.eachCell({ includeEmpty: true }, (cell, col) => {
        if (col > width) return
        const header = rowIndex === 0
        cell.border = {
          top: { style: "thin", color: { argb: `FF${LINE}` } },
          left: { style: "thin", color: { argb: `FF${LINE}` } },
          bottom: { style: "thin", color: { argb: `FF${LINE}` } },
          right: { style: "thin", color: { argb: `FF${LINE}` } },
        }
        cell.alignment = { vertical: "middle", wrapText: true, horizontal: header ? "center" : undefined }
        cell.font = header
          ? { name: FONT, size: 11, bold: true, color: { argb: "FFFFFFFF" } }
          : { name: FONT, size: 11, color: { argb: `FF${INK}` } }
        cell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: header ? `FF${NAVY}` : rowIndex % 2 === 0 ? `FF${PAPER}` : "FFFFFFFF" },
        }
      })
    })
    if (sheet.rows.length > 1) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: sheet.rows.length, column: width } }
  }
  if (workbook.worksheets.length === 0) workbook.addWorksheet("Sheet1")
  return Buffer.from(await workbook.xlsx.writeBuffer())
}

async function buildPptx(content: string) {
  const PptxGenJS = (await import("pptxgenjs")).default
  const pptx = new PptxGenJS()
  pptx.defineLayout({ name: "WIDE", width: 13.333, height: 7.5 })
  pptx.layout = "WIDE"
  pptx.theme = { headFontFace: FONT, bodyFontFace: FONT }
  for (const slide of parseSlides(content)) {
    const page = pptx.addSlide()
    page.background = { color: PAPER }
    page.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.333, h: 1.42, fill: { color: NAVY } })
    page.addText(slide[0] ?? "", {
      x: 0.55,
      y: 0.28,
      w: 12.2,
      h: 0.86,
      fontFace: FONT,
      fontSize: 28,
      bold: true,
      color: "FFFFFF",
      margin: 0,
      valign: "middle",
    })
    const body = slide.slice(1)
    page.addText(
      body.length > 0
        ? body.map((line) => ({ text: line, options: { bullet: { code: "2022" }, breakLine: true } }))
        : [{ text: "" }],
      {
        x: 0.55,
        y: 1.78,
        w: 12.2,
        h: 5.15,
        fontFace: FONT,
        fontSize: 18,
        color: INK,
        fill: { color: "FFFFFF" },
        line: { color: LINE, width: 0.75 },
        margin: 16,
        valign: "top",
        paraSpaceAfter: 10,
      },
    )
  }
  return Buffer.from((await pptx.write({ outputType: "nodebuffer" })) as ArrayBuffer)
}

function parseSheets(content: string) {
  const sheets: { name: string; rows: string[][] }[] = []
  let current = { name: "Sheet1", rows: [] as string[][] }
  let named = false
  for (const line of content.split(/\r?\n/)) {
    const heading = /^#\s+(.+)$/.exec(line)
    if (heading) {
      if (named || current.rows.length > 0) sheets.push(current)
      current = { name: heading[1]?.trim() || `Sheet${sheets.length + 1}`, rows: [] }
      named = true
      continue
    }
    if (line.length === 0) continue
    current.rows.push(line.split("\t"))
  }
  if (named || current.rows.length > 0 || sheets.length === 0) sheets.push(current)
  return sheets
}

function parseSlides(content: string) {
  const slides: string[][] = []
  let current: string[] | undefined
  for (const line of content.split(/\r?\n/)) {
    const heading = /^#\s+(.+)$/.exec(line)
    if (heading) {
      if (current) slides.push(current.filter((item) => item.length > 0))
      current = [heading[1]?.trim() || `Slide ${slides.length + 1}`]
      continue
    }
    if (!current) current = []
    const bullet = /^[-*•]\s+(.+)$/.exec(line)
    const text = (bullet?.[1] ?? line).trim()
    if (text.length > 0) current.push(text)
  }
  if (current) slides.push(current.filter((item) => item.length > 0))
  if (slides.length === 0) slides.push(["Slide 1"])
  return slides.map((slide) => (slide.length > 0 ? slide : ["Slide"]))
}

function coerce(value: string, row: number) {
  if (row > 0 && /^-?\d+(\.\d+)?$/.test(value)) return Number(value)
  return value
}

function isTableRow(line: string) {
  return /^\s*\|.+\|\s*$/.test(line)
}

function isTableRule(line: string) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line)
}

function tableCells(line: string) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim())
}

function visualWidth(value: string) {
  let width = 0
  for (const char of value) width += char.charCodeAt(0) > 255 ? 2 : 1
  return width
}

function sheetName(name: string, index: number) {
  const cleaned = name.replace(/[:\\/?*[\]]/g, " ").trim().slice(0, 31)
  return cleaned || `Sheet${index + 1}`
}
