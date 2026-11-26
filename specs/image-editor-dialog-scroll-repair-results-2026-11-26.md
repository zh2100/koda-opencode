# 图片编辑弹窗布局实施与 Web 验证

日期：2026-11-26

结论：编辑器布局已实施，隔离 Chromium 下 13 项专项测试全部通过。**未构建或验收安装版 Electron，不能将本记录视为桌面安装版验收。**

## 实施范围

- `packages/app/src/components/dialog-image-edit.tsx`：保留弹窗可访问名称及默认关闭按钮，视觉隐藏标题；改为画布区、浮动工具栏及底部描述/核对区。
- `packages/app/src/components/dialog-image-edit.css`：新增实例专用样式，通过 `:has(> .image-edit-dialog)` 扩展此实例的父容器；未修改公共 Dialog 或普通 ImagePreview。
- `packages/app/src/i18n/en.ts`、`zh.ts`：新增模型详情、移动工具栏、超限原因文案；中文按钮使用“下一步：核对修改”和“确认并开始修改”。仅相对于实施前备份核对本次增量，保留工作区原有文案修改。
- `packages/app/e2e/regression/masked-image-edit.spec.ts`：适配工具菜单、实测 viewport 及按钮名称，新增布局与旁路隔离对照。

## 实际布局与行为

- 桌面弹窗最大 1280×960，窗口外留 32px；360px 窄屏外留 12px。画布使用剩余宽高等比适应，不再依赖旧 `45vh`。
- 绘图栏与查看栏是滚动画布视口的兄弟层，不随图片缩放。桌面拖柄可上下停靠，点击或键盘激活也可换位；查看栏有独立换位按钮。两组分居逻辑起始/结束侧。
- 900px 以下，两组工具改为画布外的两行，隐藏无实际用途的换位按钮，避免覆盖图片、关闭按钮及模型详情。480px 以下，描述与下一步分行。
- 绘图开关、六种工具、撤销、清空、笔刷大小均保留。实际将撤销和清空直接放在工具栏，而不是藏入“更多”；大小设置使用原生 details。
- 版本列表与模型详情使用紧凑 details；Escape 优先关闭展开项并还焦，再次 Escape 关闭弹窗。核对区保留只读描述及原确认、取消、失败查询语义。
- 下载直接使用当前版本原始 `src`，不导出遮罩、不调用模型。无可用编辑模型时仍可下载、查看原因及重新检查。

## 验证环境及命令

- Windows，Bun 1.4.3；独立 Vite/Playwright 端口 4387。
- 使用合成 PNG、GIF、模拟接口；未调用真实供应商，未重启用户应用。
- 以下命令在 `packages/app` 执行：

```cmd
bunx prettier --check src/components/dialog-image-edit.tsx src/components/dialog-image-edit.css e2e/regression/masked-image-edit.spec.ts
bun typecheck
bun typecheck:e2e:image-edit
set PLAYWRIGHT_PORT=4387&& bun run test:e2e e2e/regression/masked-image-edit.spec.ts --workers=1
```

结果：格式检查、两项类型检查均通过；Playwright **13 passed (1.8m)**。最终日志：`.tmp/image-edit-floating-final-tests-2.log`。此前失败日志保留，不作为最终通过依据。

## 专项覆盖及截图

| 验证项                                                           | 结果 |
| ---------------------------------------------------------------- | ---- |
| legacy/v2 附件选择、拖入、遮罩像素与版本保留                     | 通过 |
| 生成图的会话、工作区、摘要绑定                                   | 通过 |
| 取消后同请求 ID reconciliation，迟到回执不进入其他会话或重开实例 | 通过 |
| 模型状态、兼容能力及查询失败；无可用模型仍能下载                 | 通过 |
| LTR/RTL 工具、撤销、缩放、原图坐标、大图滚动及指针边界           | 通过 |
| 中文、多行描述、键盘核对；核对前不提交、确认后提交               | 通过 |
| 1645×1186 横图首屏、1100×740 竖图适应                            | 通过 |
| 1000×700、360×740 resize 后控件可达、无横向溢出且 bitmap 不变    | 通过 |
| 工具栏拖动、键盘换位、大小设置/Escape 不改变选区                 | 通过 |
| 有选区时原图、修改版下载文件字节与当前版本一致                   | 通过 |
| 非 PNG 普通预览与公共设置弹窗的尺寸、Escape、设置内键盘焦点      | 通过 |

使用有色底图、四边边框和尺寸文字复查实际图片显示，不再使用视觉空白的透明 fixture：

- `.tmp/image-edit-floating-desktop.png`：1645×1186，中文，1536×1024 横图；首屏未滚动。
- `.tmp/image-edit-floating-narrow.png`：360×740，中文；resize 后仍保留测试笔迹。
- `.tmp/image-edit-floating-portrait.png`：1100×740，英文，1024×1536 竖图。

普通预览/设置对照是在当前样式已加载的同一页面中，分别在打开编辑器之前及关闭之后进行，并断言既有默认尺寸：GIF 预览 990×666、设置容器 980×600（视口 1100×740）。它不是独立旧构建与新构建的双构建截图对照。设置页所需 `/pty/shells` 在该测试中补充模拟为空数组，未改设置页实现。

## 隔离核对

实施前备份位于 `.tmp/image-edit-floating-baseline/`。与该备份逐字符比较：

- `useImageEditor` 入口：未变（1814 字符）。
- `draw()` 至 `submit()` 之前的绘图、撤销、清空、指针处理：未变（5342 字符）。
- `submit()` 请求及结果处理：未变（3352 字符）。

未改公共组件、SDK、Protocol 或服务端；无需为本次布局改动重新生成客户端。工作区其他既有改动及未跟踪文件均保留。

## 尚未验证

- 包含本次改动的 Electron 构建、安装版默认首屏及真实 RTL 桌面交互。
- 真实供应商执行、计费及真实图片模型结果；本次仅验证模拟协议行为。
- 所有系统缩放比例、极矮窗口及全部语言组合；已通过的视口与方向不能代表穷举覆盖。

## 追加验收：生产 Web 与 Electron 渲染器（2026-11-26）

**结论：当前工作区的 Web 专项及 Electron 测试窗口的编辑器交互通过；未对 Windows 安装包放行。** 本节更新上面的桌面验证边界，不将模拟 IPC 的测试窗口视为已安装的完整客户端。

- Web：从当前源码单独构建 production 静态产物，在 `127.0.0.1:4387` 通过 Vite preview 重跑同一专项（1 worker，0 retries）。13/13 通过，53.3 秒；`bun typecheck` 和 `bun typecheck:e2e:image-edit` 均通过。覆盖首屏、下载字节、遮罩与版本、核对后才提交、取消后查询、回执隔离及非目标弹窗对照。
- 桌面：现有 `dist/win-unpacked/resources/app.asar` 早于本次 CSS，包含原编辑器但不含新 `image-edit-move-view` 标记，未用它验收新布局。另从桌面 `src/renderer/index.html` 生产构建当前渲染器，在 Electron 42.3.3 隔离 BrowserWindow（1280×800）中运行；桌面包源码版本 1.0.7。使用临时 profile、已有 preload、测试主进程、模拟 IPC 与模型状态；未启动产品主进程或 sidecar，未安装或替换 Koda。
- 中文 LTR 和阿拉伯语 RTL 各打开一张 1536×1024 PNG。首次交互前画布均为 933×622，四边位于视口内；画笔、下载、描述、核对和查看栏换位按钮均可命中。RTL 下工具位置随方向改变，图中文字未镜像；部分界面文案回退为英文，不代表阿语翻译完整性已验收。
- 两种语言中，查看栏换位未改变 bitmap，实际落笔才改变 bitmap；第一次 Escape 收起笔刷设置且保留笔迹，第二次关闭弹窗。以上桌面操作均产生 **0 次编辑提交**。桌面夹具拒绝未模拟的健康检查和后台会话查询；这些接口不在本次桌面验收范围内。
- 证据：`.tmp/image-edit-floating-acceptance/` 内的 `production.log`、`electron.log`、`electron-zh.png`、`electron-ar.png`，以及用于复现的 `config.ts`、`desktop.config.mts`、`shell.cjs`、`electron.cjs`。Web 横图、竖图和窄屏截图见上节路径。
- 发布前仍需用含改动的安装包在独立 Windows 环境复核原生标题栏命中、系统文件选择／下载和真实 preload–主进程集成。供应商执行和计费未测试，本次不发起真实请求。
