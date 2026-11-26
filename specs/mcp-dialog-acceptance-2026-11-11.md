# MCP 弹窗独立验收 — 2026-11-11

> 后续归因更正：AC-01 是已确认的产品焦点缺陷；AC-02 是验收用例将 DOM 消失误认为内部关闭完成。等待真实活动栈清空后，快捷键完整路径三次通过。原始执行的 10 pass、2 fail 保留，详见文末根因分析；本轮没有修改产品或原验收用例。

本轮结论：**部分通过，不能整体验收关闭**。生产构建成功；最终真实 Chromium 浏览器验收 10 pass、2 fail、0 skip、0 flaky，退出码 1。两个失败项分别是首次打开后外部程序焦点可以移出弹窗，以及保存后快捷键未能重开设置。没有修改产品实现、提交、推送或重启当前应用。

## 范围与环境

- 仓库 D:/opencode，分支 dev；验收的是当前未提交工作区。
- Windows；Node v24.19.0、Bun 1.4.3；仓库已安装的 Playwright/Chromium。
- agent-browser 不可用，改用仓库自带的 Playwright。执行前已阅读 E2E AGENTS 要求的 Playwright 官方六份指南，文档副本保留在首轮隔离根。
- 完整 App 与真实 DialogProvider/UI v2 夹具共同进行 Vite 生产构建。最终复验复用第二轮同一生产构建，没有切换到开发编译或修改产品代码。
- 最终独立端口 60333；浏览器 runner 结束后，已核实该端口没有监听者。没有操作原应用或其服务器。
- 各轮使用独立 home、XDG 数据/配置/状态/缓存、managed 和临时目录；数据库为内存，移除配置覆盖及服务器认证环境变量，禁用模型抓取与 Sentry 上传。
- 后端 API 由隔离路由提供受控数据，没有启动真实业务后端，也没有写生产配置、凭据或迁移标记。结果仅支持本机浏览器前端行为，不能代替真实后端集成、Electron 安装包或跨平台验收。

DialogProvider 被验收版本 SHA256：

    CC0897C6FE8EC4906B69CD2E8124462A5A3239FA20E0AD65BB430EAD1AA42D5A

## 最终浏览器结果

最终报告起始时间 2026-11-11T12:01:03.170Z，总耗时 161.509 秒。共 12 个用例，单 worker、零重试；没有把历史批次或重复运行计入这 12 项。

| 场景 | 结果 |
| --- | --- |
| 绑定弹窗初始打开后，阻止外部控件程序请求焦点 | 失败，AC-01 |
| 真实 Kobalte 原生标题栏关闭按钮 | 通过 |
| Escape 关闭上层后，下层恢复模态与焦点约束 | 通过 |
| 下层先关闭、随后关闭上层 | 通过 |
| 上层先关闭、随后关闭下层 | 通过 |
| 下层关闭期间 push 上层 | 通过 |
| show 使用相同 id 替换正在关闭的弹窗 | 通过 |
| Provider 卸载同时清理已打开和关闭中的根 | 通过 |
| 完整 App MCP 编辑页 Tab 焦点循环、Escape、按钮重开、保存、按钮重开读取新命令 | 通过 |
| 完整 App 旧保存挂起，关闭旧弹窗并重开同名弹窗，旧保存返回后保留新草稿 | 通过 |
| 原 MCP 来源编辑回归：保存后通过 Control+, 重开设置并重读 | 失败，AC-02 |
| 原 MCP 来源编辑回归：只读来源禁止保存、没有 PATCH | 通过 |

共享 UI 夹具使用真实 Provider、Kobalte.Content、CloseButton 和 App 样式，没有替换其生命周期逻辑。完整 App 用例进入真实侧栏 Settings → MCP → Edit；服务器响应受控。

已人工查看关键截图：保存后重开显示 node saved.js；旧回包完成后新弹窗保留 node replacement-draft.js，Save 仍可用，弹窗未被旧请求关闭。截图能支持这些界面状态，不能扩大为整页视觉或全部功能验收。

## AC-01：首次自动聚焦后，程序焦点仍可移出模态弹窗

状态：**未修复，验收不通过，P2**。

复现：

1. 从真实 Provider 打开绑定 id 的 Lower UI v2 弹窗，输入框带 autofocus。
2. 等输入框实际获得焦点；诊断确认 focused 为 Lower draft，contained=true，焦点哨兵数量为 2。
3. 对背景 Outside control 执行真实 HTMLElement.focus()。
4. 在完整断言窗口中，document.activeElement 仍在弹窗之外。弹窗仍然存在，且未执行关闭或销毁。

这不是初始 UI 尚未准备好，也不是 modal=false：用例明确等待初始输入框聚焦，且已观察到两个焦点哨兵。普通 MCP 页的 Tab 循环已通过，不能把本项扩大描述为所有键盘焦点路径失效。

根因线索：当前 Kobalte createFocusScope 的 lastFocusedElement 初值为空，仅由后续 focusin 记录；UI v2 的 onOpenAutoFocus 会同步调用输入框 focus()。如果该事件早于陷阱监听建立，首次外部 focus 时缺少可恢复的元素。此时“modal 为 true”与“可以恢复焦点”是两个不同条件。现有 Happy DOM 组件用例显式触发内部聚焦，未覆盖这条首次 autofocus 的浏览器时序。

建议修复：在共享焦点边界保证陷阱启用时记录当前有效内部焦点，并处理上层关闭后的重新激活；评估依赖修复或共享组件适配，不在业务弹窗各自添加补丁。保留当前浏览器失败断言，补充首次自动聚焦、无 autofocus、内部焦点元素删除以及叠层恢复的验证。修复前不能关闭 MR-01 的完整焦点验收。

## AC-02：MCP 保存关闭后，设置快捷键不能重开

状态：**复现未解决，验收不通过，P2；直接根因仍需定位**。

复现：

1. 从完整 App 用 Control+, 打开设置，进入 MCP，编辑 sample。
2. 保存 node "new file.js" ""；确认 PATCH 的 source/version/command 精确正确，弹窗内容消失。
3. 等全部 data-dialog-layer 移除，排除仍在关闭动画期间的快捷键拦截。
4. 再按 Control+,；设置弹窗未出现，用例最终等待 MCP tab 超时。

同一生产构建下，通过可见 Settings 按钮重开并重读保存结果的完整 App 用例通过。因此不能将本项误写为“配置没有保存”或“所有设置入口无法重开”，也不能通过将所有用例改用按钮来消除快捷键缺陷。

排查入口：[command.tsx](D:/opencode/packages/app/src/context/command.tsx) 的 suspended/dialog.active 检查、命令注册与事件监听生命周期，以及 [layout.tsx](D:/opencode/packages/app/src/pages/layout.tsx) 的 settings.open/openSettings 归属。当前证据没有证明具体是哪一个条件阻止重开，不把推测写成根因。

建议修复：先为初次快捷键打开 → MCP 替换 → 保存/取消 → 层完全关闭 → 同一快捷键重开建立独立回归；诊断暂停计数、活动实例和命令注册是否归零/保留，再修复对应所有权。不得直接绕过全局弹窗保护或去掉合法的关闭期间拦截。保留按钮重开作为对照。

## 组件与静态检查

- 本轮重新运行真实 Provider 与 MCP 归属两套组件回归：28 pass、0 fail、113 assertions，退出码 0，10.74 秒。此结果不能覆盖上述真实浏览器失败。
- packages/app：bun typecheck，退出码 0。
- packages/ui：bun typecheck，退出码 0。
- 新增验收 spec、夹具与配置：从 packages/app 使用 bun typecheck:e2e --project 临时配置检查，退出码 0。临时配置包含 Vite 导入文件清单，结束后删除；未修改常规 E2E 类型检查范围。
- 七个本轮 E2E/夹具文件的 Prettier 检查通过；产品 DialogProvider 的 git diff --check 通过。
- 组件编译临时文件、临时浏览器复验配置、临时类型配置已清理。隔离日志和截图保留。

## 验收中修正的测试问题

首轮 11 项为 6 pass、5 fail。拆分原生关闭和焦点断言后，第二轮 12 项为 8 pass、4 fail。最终 12 项为 10 pass、2 fail，三轮证据分别保留，不能累计通过数。

- 弹窗内容消失早于 Provider 100ms 关闭收尾。重新发送快捷键前，应等待实例层移除；该修正后快捷键仍失败，列为 AC-02。
- 上层内容消失时，下层焦点作用域还可能没有恢复。叠层用例改为等待只剩一个实例层、下层两个焦点哨兵恢复，再请求外部焦点；最终通过，不能继续报成叠层产品缺陷。
- 单层焦点检查补上初始输入框实际聚焦的断言与诊断附件，最终仍失败，保留 AC-01。
- 完整 App 新增用例使用 Settings 按钮验证独立入口；原有快捷键来源编辑用例继续保留，未改成按钮来掩盖失败。

## 文件与重跑

新增持久回归：

- [dialog-lifecycle-acceptance.spec.ts](D:/opencode/packages/app/e2e/regression/dialog-lifecycle-acceptance.spec.ts)
- [mcp-dialog-acceptance.spec.ts](D:/opencode/packages/app/e2e/regression/mcp-dialog-acceptance.spec.ts)
- [真实 UI 夹具](D:/opencode/packages/app/e2e/reproduction/dialog-lifecycle/main.tsx)
- [生产构建配置](D:/opencode/packages/app/e2e/reproduction/dialog-lifecycle/vite.config.ts)
- [Playwright 验收配置](D:/opencode/packages/app/e2e/reproduction/dialog-lifecycle/playwright.config.ts)

原有来源编辑用例仅补了重开前等待旧实例层收尾：[mcp-source-edit.spec.ts](D:/opencode/packages/app/e2e/regression/mcp-source-edit.spec.ts)。

从 packages/app 重跑，先建立全新的隔离环境和未占用端口，设置 OPENCODE_ACCEPTANCE_ROOT、OPENCODE_ACCEPTANCE_PORT，再运行：

    bun ./node_modules/@playwright/test/cli.js test --config e2e/reproduction/dialog-lifecycle/playwright.config.ts

配置会构建生产版本，再于独立端口预览；reuseExistingServer=false。不要指向生产数据根或复用当前服务。

## 证据

- [最终 JSON 报告](C:/Users/zh2100/AppData/Local/Temp/opencode-mcp-acceptance-fd64d596870d4dfd883c8479fe0be7ec-final/playwright-results.json)
- [最终执行日志](C:/Users/zh2100/AppData/Local/Temp/opencode-mcp-acceptance-fd64d596870d4dfd883c8479fe0be7ec-final/acceptance.log)
- [最终 HTML 报告](C:/Users/zh2100/AppData/Local/Temp/opencode-mcp-acceptance-fd64d596870d4dfd883c8479fe0be7ec-final/html-report/index.html)
- [浏览器截图、失败 trace 和视频](C:/Users/zh2100/AppData/Local/Temp/opencode-mcp-acceptance-fd64d596870d4dfd883c8479fe0be7ec-final/browser-results)
- [第二轮生产构建与组件日志](C:/Users/zh2100/AppData/Local/Temp/opencode-mcp-acceptance-fd64d596870d4dfd883c8479fe0be7ec-rerun)
- [首轮原始证据与官方指南](C:/Users/zh2100/AppData/Local/Temp/opencode-mcp-acceptance-fd64d596870d4dfd883c8479fe0be7ec)

## 状态裁定

MR-02 的并发关闭、替换、push 和清理在本机真实浏览器通过；MR-01 的绑定 id/原生关闭路径通过，但完整焦点约束仍被 AC-01 阻塞。MCP 请求与新弹窗归属的两项真实页面用例通过。不能把这些分项结论写成所有 MCP 或全部界面功能已验收。

OA-06、UI01～UI08 整组、R3-03B、RF-07 跨平台，以及其他历史后端/迁移/授权缺口均保持原状态。本轮没有替它们补做所需验收。

## 后续根因分析与 AC-02 归类更正 — 2026-11-11

**当前归类：AC-01 为已确认的产品焦点缺陷；AC-02 为验收用例的关闭完成条件错误。** 原始 12 项执行仍保留 10 pass、2 fail，不把后续独立诊断拼入原始统计。原用例和产品代码本轮均未修改，不能据此改成整体验收通过。本文上方 AC-02 的“未解决产品缺陷/直接根因待定位”是诊断前状态，以本节归因为准。

### AC-01 已确认：自动聚焦早于焦点记忆建立

从 [UI v2 onOpenAutoFocus](D:/opencode/packages/ui/src/v2/components/dialog-v2.tsx:101) 同步聚焦 autofocus 输入框。当前 Kobalte createFocusScope 的挂载自动聚焦先执行，后续作用域才安装 focusin/focusout 监听；lastFocusedElement 初始为空，安装监听时也没有从当前 activeElement 初始化它。

在同一生产构建的隔离浏览器中，仅为 bundle 响应加入只读 getter，直接记录到：

| 时点 | trapFocus | paused | lastFocusedElement | document.activeElement |
| --- | --- | --- | --- | --- |
| 初始输入框已聚焦、哨兵已建立 | true | false | null | Lower draft 输入框 |
| 外部控件调用 focus 后 | true | false | null | Outside control |
| 输入框再次真正获得焦点后 | true | false | Lower draft 输入框 | Lower draft 输入框 |
| 再次对外部控件调用 focus 后 | true | false | Lower draft 输入框 | Lower draft 输入框 |

因此，恢复焦点时调用的目标为空是直接失败原因。第二次内部聚焦触发 focusin 后，同样的抢焦点动作被拦住，完成了因果对照；不是仅凭代码推测。该诊断用例通过表示它成功证明了缺陷与对照，不表示缺陷已修复。

修复方向：在焦点作用域启用/重新启用时，从当前有效的内部 activeElement 初始化恢复目标，并为目标不存在或已断开提供有效候选。通过可追踪的依赖升级或仓库持久补丁修复；不直接修改 node_modules，也不在每个业务弹窗各自补一套陷阱。单纯延迟调用同一输入框的 focus 仍可能不发出新的 focusin，不能作为充分修复。保持首次 autofocus 的真实浏览器回归。

### AC-02 已确认：DOM 移除不等于内部活动栈已清空

具体时序：

1. [DialogProvider.close](D:/opencode/packages/ui/src/context/dialog.tsx:67) 先登记 100ms 定时器，再同步 setClosing(true)。
2. Kobalte 的 open 变为 false，Portal 中的内容连同 data-dialog-layer 包装层提前移除。
3. 内部 stack 中的 Active 仍然存在，closing=true；要等定时器执行才从 stack 移除。
4. [来源编辑用例](D:/opencode/packages/app/e2e/regression/mcp-source-edit.spec.ts:94) 仅等待 data-dialog-layer 数量为零，便发送 Control+,。
5. [命令入口](D:/opencode/packages/app/src/context/command.tsx:398) 看到 dialog.active，按现有规则直接返回。该次按键不会在关闭完成后重放，因此随后等待设置出现会超时。

三次保持原操作顺序的隔离诊断为 2 pass、1 fail。失败时第二次快捷键的准确状态：

    suspended: false
    active: { id: "9znvbgfjgqp", closing: true }
    signature: "comma:1"

此时没有第二次 settings-call。所有被记录的设置回调 dead 均为 false；没有证据支持“暂停计数泄漏”“命令未注册”或“已销毁回调残留”这三种先前候选原因。

随后只在临时诊断用例中改为等待实际 dialog.active === null，再发送一次快捷键。三次全部通过（3 pass、0 fail，23.9 秒），且保留了打开 MCP、保存、重开并核对命令的完整路径。未移除快捷键保护、未重复发送状态变更按键、未添加固定 sleep，也没有修改产品实现。

需要更正此前判断：等待 data-dialog-layer 为零并没有排除关闭期间拦截；将该失败直接列为“保存后快捷键无法重开”的产品缺陷过早。

修复方向：为持久的 dialog-stack 宿主提供由真实内部 stack 派生的稳定关闭就绪契约，例如活动数量或 idle 状态；E2E 等该契约进入 idle 后再发快捷键。临时诊断 getter 仅用于定位，不应作为正式产品全局变量接入。保留关闭期间拦截；是否要支持动画期间排队重开属于另一个交互行为选择，不是本次已证明的持久失效。

### 本轮分析证据与操作边界

- [焦点因果对照与首次快捷键诊断](C:/Users/zh2100/AppData/Local/Temp/opencode-mcp-cause-6f5f9ff22e794026a6192474ccd33394/cause.log)：焦点诊断通过；该批另一项因预期第二次回调未进入而失败，不混写为产品已通过。
- [原关闭等待条件三次对照](C:/Users/zh2100/AppData/Local/Temp/opencode-mcp-cause-6f5f9ff22e794026a6192474ccd33394-repeat/cause.log)：2 pass、1 fail，保留失败时 active.closing=true 的记录。
- [等待实际内部关闭完成后的三次对照](C:/Users/zh2100/AppData/Local/Temp/opencode-mcp-cause-6f5f9ff22e794026a6192474ccd33394-settled/cause.log)：3 pass、0 fail。
- 诊断脚本副本、trace、JSON 和截图保留在各隔离根；仓库临时脚本与配置已删除。
- 只在浏览器请求返回的脚本文本中加入诊断，不修改源码或磁盘上的生产 bundle。没有提交、推送、重启当前应用或操作生产配置。

## 根因修复后的正式复验 — 2026-11-11

原始 10 pass、2 fail 保留为历史证据。按根因方案实施后，新的独立生产构建 Chromium 正式套件为 20 pass、0 fail、0 skip；另用相同 bundle 在三个独立上下文执行快捷键保存重开，3 pass、0 fail。Provider/MCP 组件 30 pass，App、UI、专用 E2E 类型检查退出 0。

AC-01 和 AC-02 可按本机局部证据关闭；实施中新增的叠层暂停窗口也已有失败和修复后通过记录。完整修改、安装及测试证据见[实施结果](D:/opencode/specs/mcp-dialog-root-cause-fix-results-2026-11-11.md)。OA-06、UI01～UI08、R3-03B、RF-07 等历史状态保持原样。未提交、未推送、未重启当前应用；主工作区 node_modules 未重装，当前运行实例还没有加载本轮依赖补丁。
