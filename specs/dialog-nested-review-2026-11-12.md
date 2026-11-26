# 弹窗嵌套下拉遗漏复核 — 2026-11-12

最新状态：DR-01、DR-02 已修复并通过 Windows Chromium 隔离生产构建验收，34 pass、0 fail；组件 30 pass。见[修复与验收结果](D:/opencode/specs/dialog-nested-fix-results-2026-11-12.md)。以下为修复前的历史复核，保留原失败证据。

结论：新确认 2 项 P2 缺陷，均未修复。真实 Chromium 对照为 1 pass、2 fail、0 skip、0 flaky；没有修改产品实现、主工作区依赖或生产数据，没有提交、推送或重启当前应用。

本次只复查上一轮弹窗相关边界及历史未关闭状态，不代表全仓库没有其他缺陷。原有 20 项通过结果保留；新增失败属于原矩阵没有覆盖的真实 SelectV2 场景，不混入旧的通过统计。没有以未打补丁的对照证明缺陷引入时间，因此不认定由上一轮补丁引入。

## DR-01：内层类型菜单的 Escape 被父弹窗抢先消费

- 优先级：P2；状态：确认、未修复。
- 入口：[MCP 类型下拉](D:/opencode/packages/app/src/components/settings-v2/dialog-mcp-v2.tsx:322)。
- 根源：[DialogProvider 的 window 捕获监听](D:/opencode/packages/ui/src/context/dialog.tsx:85)。

复现步骤：打开设置 → MCP → sample 编辑；将命令改为 node keep-unsaved-draft.js，不保存；展开 Type；按一次 Escape。

预期：只关闭 Type 的 Local/Remote 列表，编辑弹窗和草稿保留。

实际：列表关闭，.settings-v2-server-dialog 也被移除。父弹窗实例销毁后不能继续编辑该份未保存草稿。独立测试先用显式 data-slot 确认列表实际显示，再按一次真实 Escape；随后等待列表移除，父弹窗可见断言失败。没有用可访问性定位失败替代此结论。

代码链路：父 Provider 在 window capture 阶段直接 close() 并 stopPropagation()。Kobalte 的 createEscapeKeyDown 位于 document 普通监听阶段，本应由最顶层 dismissable layer 处理；父监听提前关闭并拦住了这次事件。

修复方向：统一 Escape 的层级分发，让真实最顶层下拉/Popover 先处理；父弹窗只在没有子浮层接纳时关闭。优先复用 Kobalte 的现有 dismissable-layer/onOpenChange 链路，避免另建不感知子层的全局捕获逻辑。不能只检查 defaultPrevented，因为 window capture 到达时子层还没有机会处理。

最低回归：SelectV2、Select、Popover、菜单内按一次 Escape 只收起最内层；草稿保留；第二次 Escape 才关闭父弹窗；没有子层时原生关闭、叠层恢复、替换和关闭收尾均保持。

## DR-02：可见类型菜单被父模态的 aria-hidden 遮住

- 优先级：P2；状态：确认、未修复。
- 根源边界：[SelectV2 的外置 Portal](D:/opencode/packages/ui/src/v2/components/select-v2.tsx:202)。

复现步骤：打开上述 MCP 编辑弹窗，展开 Type，检查显示的 Local/Remote 列表。

实际证据：data-slot=select-v2-listbox 的元素可见，包含 role=listbox 和 role=option，Local 选项已获焦；但其 Portal 的祖先 div 带 aria-hidden=true。在 15 秒自动等待内，getByRole('listbox') 始终无法定位该列表。截图显示列表实际打开；结构证据见下方 JSON。

代码链路：SelectV2 未显式改变 Kobalte Select 默认的 modal:false，列表通过 Portal 挂到父 Dialog DOM 子树之外。父 Dialog 的 createHideOutside 仍按父 Content 为可访问范围隐藏新增外部节点；真实 SelectV2 没有建立与父模态兼容的外置分支契约。

修复方向：在共享浮层边界建立父模态与外置子层的可访问范围关系，或采用经过验证的模态子层模式；需同步验证焦点恢复、指针交互和关闭时解除登记。不要移除所有背景 aria-hidden，也不要仅给测试夹具加标记而遗漏真实 SelectV2。

最低回归：真实 MCP 类型列表可按 role/option 访问并用键盘选择；关闭子层后父弹窗继续可访问；背景仍正确隐藏；父弹窗关闭后隐藏标记无泄漏。其他 Select/Popover 入口需独立覆盖，尚未据本次结果断言它们全部失败。

## 为什么上一轮未覆盖

上一轮 F07 使用裸 Kobalte Popover，夹具显式带 top-layer 标记，并通过关闭按钮退出。实际 MCP 的 SelectV2 没有同样的外置分支标记，也没有测试下拉展开后按 Escape。因此旧 20 项通过可以保留，但不能证明真实嵌套控件的 Escape 与可访问性完整正确。

## 验证与证据

使用上一轮已验证的独立生产 bundle 和最新补丁；本次不替换 bundle 内容、不注入诊断全局变量。三个用例分别在独立 browser context 运行，workers=1、retries=0。

| 用例                                        | 结果                               |
| ------------------------------------------- | ---------------------------------- |
| 类型列表打开后 Escape，编辑弹窗和草稿应保留 | fail：编辑弹窗已被移除             |
| 没有内层列表时 Escape，编辑弹窗应关闭       | pass                               |
| 可见类型列表应暴露 listbox 角色             | fail：Portal 祖先 aria-hidden=true |

最终统计：1 pass、2 fail、0 skip、0 flaky，61.826 秒，进程退出码 1。

- [完整日志](C:/Users/zh2100/AppData/Local/Temp/opencode-dialog-review-20261112-23263e88b86fb-confirmed/review.log)
- [Playwright JSON](C:/Users/zh2100/AppData/Local/Temp/opencode-dialog-review-20261112-23263e88b86fb-confirmed/playwright-results.json)
- [可见列表的隐藏祖先、原始列表和活动元素](C:/Users/zh2100/AppData/Local/Temp/opencode-dialog-review-20261112-23263e88b86fb-confirmed/visible-list-accessibility.json)
- [本轮源码摘要](C:/Users/zh2100/AppData/Local/Temp/opencode-dialog-review-20261112-23263e88b86fb-confirmed/source-proof.json)
- [归档复现用例](C:/Users/zh2100/AppData/Local/Temp/opencode-dialog-review-20261112-23263e88b86fb-confirmed/dialog-nested-review.spec.ts)
- [归档独立配置](C:/Users/zh2100/AppData/Local/Temp/opencode-dialog-review-20261112-23263e88b86fb-confirmed/playwright.nested-review.config.ts)
- [独立端口释放记录](C:/Users/zh2100/AppData/Local/Temp/opencode-dialog-review-20261112-23263e88b86fb-confirmed/port-cleanup.json)

首次尝试是 1 pass、1 fail，停在可访问角色前置检查，未执行到 Escape，保留在 C:/Users/zh2100/AppData/Local/Temp/opencode-dialog-review-20261112-23263e88b86fb；它不能单独证明 DR-01。随后将两项缺陷分开验证，才形成上述结论。

本次 API 使用受控浏览器路由，数据和凭据均为隔离样本；不连接真实后端。隔离配置和测试已归档，从源码副本删除。主工作区只新增本复核文档，未修改业务代码；相关 UI、MCP 和补丁源文件与独立副本逐字节一致。

## 历史未关闭范围

- R3-03B 整体仍未关闭：包括旧写入者隔离、真实离线迁移及跨平台/安装包验收。NL-01、NL-02 的既有本机关闭结论不变。
- OA-06/UI01～UI08 的完整供应商和模型设置界面验收仍未关闭。
- RF-07 的 Linux/macOS、root 真实跳过统计及真实 HTTP 传输取消仍待验证。

这些历史待验收范围不全部等同于新确认的产品缺陷。上一轮补丁也尚未安装到当前运行应用；本次新增失败是在已经加载该补丁的独立生产构建中确认。
