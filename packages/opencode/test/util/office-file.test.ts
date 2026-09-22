import { describe, expect, test } from "bun:test"
import { buildOfficeFile } from "../../src/util/office-file"
import { extractOfficeText } from "../../src/util/office-text"

describe("buildOfficeFile", () => {
  test("writes a docx that can be read back", async () => {
    const bytes = await buildOfficeFile("manual.docx", "# 说明书\n- 打开电源\n1. 检查指示灯\n| 项目 | 说明 |\n| --- | --- |\n| 电源 | 打开 |")
    expect(bytes).toBeDefined()
    expect(extractOfficeText("manual.docx", bytes!)).toBe("说明书\n打开电源\n检查指示灯\n项目\n说明\n电源\n打开")
  })

  test("writes an xlsx sheet and a pptx slide", async () => {
    const sheet = await buildOfficeFile("table.xlsx", "# 报价\n名称\t数量\n零件\t2")
    expect(extractOfficeText("table.xlsx", sheet!)).toBe("# 报价\n名称\t数量\n零件\t2")

    const deck = await buildOfficeFile("deck.pptx", "# 概述\n先看目标\n再看步骤")
    expect(extractOfficeText("deck.pptx", deck!)).toBe("# Slide 1\n概述\n先看目标\n再看步骤")
  })
})
