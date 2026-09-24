import { describe, expect, test } from "bun:test"
import path from "node:path"
import { buildOfficeFile } from "../../src/util/office-file"
import { extractOfficeText } from "../../src/util/office-text"
import { tmpdir } from "../fixture/fixture"

describe("buildOfficeFile", () => {
  test("writes a docx that can be read back", async () => {
    const bytes = await buildOfficeFile(
      "manual.docx",
      "# 说明书\n- 打开电源\n1. 检查指示灯\n| 项目 | 说明 |\n| --- | --- |\n| 电源 | 打开 |",
    )
    expect(bytes).toBeDefined()
    expect(extractOfficeText("manual.docx", bytes!)).toBe("说明书\n打开电源\n检查指示灯\n项目\n说明\n电源\n打开")
  })

  test("writes xlsx sheets and pptx slides that can be read back", async () => {
    const sheet = await buildOfficeFile(
      "table.xlsx",
      "# 报价\n名称\t数量\n零件 & 配件\t2\n\n# 明细\n字段\t值\n状态\t已确认",
    )
    expect(extractOfficeText("table.xlsx", sheet!)).toBe(
      "# 报价\n名称\t数量\n零件 & 配件\t2\n\n# 明细\n字段\t值\n状态\t已确认",
    )

    const deck = await buildOfficeFile("deck.pptx", "# 概述\n先看目标\n再看步骤\n\n# 结果\n完成交付")
    expect(extractOfficeText("deck.pptx", deck!)).toBe(
      "# Slide 1\n概述\n先看目标\n再看步骤\n\n# Slide 2\n结果\n完成交付",
    )
  })

  test.each(["DOCX", "XLSX", "PPTX"])("round trips a %s file on disk", async (ext) => {
    await using tmp = await tmpdir()
    const filepath = path.join(tmp.path, `报告 final.${ext}`)
    const text = '中文 & <tag> "quoted"'
    const bytes = await buildOfficeFile(filepath, `# Title\r\n${text}`)
    expect(bytes).toBeDefined()
    await Bun.write(filepath, bytes!)
    const saved = new Uint8Array(await Bun.file(filepath).arrayBuffer())
    expect(saved).toEqual(new Uint8Array(bytes!))
    expect(extractOfficeText(filepath, saved)).toBe(
      ext === "DOCX" ? `Title\n${text}` : ext === "XLSX" ? `# Title\n${text}` : `# Slide 1\nTitle\n${text}`,
    )
  })
})
