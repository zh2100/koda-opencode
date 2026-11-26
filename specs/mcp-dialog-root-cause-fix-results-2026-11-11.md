# MCP 弹窗根因修复与独立验收结果 — 2026-11-11

按 [实施方案](D:/opencode/specs/mcp-dialog-root-cause-implementation-plan-2026-11-11.md)完成修改。本轮 AC-01 和 AC-02 可按本机独立验收证据关闭；不代表所有设置页、所有平台或全部历史缺陷已关闭。

最终结果：生产构建 Chromium 20 pass、0 fail、0 skip；快捷键保存重开在三个独立上下文中 3 pass、0 fail；组件 30 pass、0 fail、125 个断言。App、UI、专用 E2E 类型检查均退出 0。

当前运行中的应用没有重启。主工作区 node_modules 没有重装，依赖补丁尚未应用到该运行实例。没有提交、推送、写生产配置、密钥或迁移标记。

## 1. 修改与根因

### AC-01：首次 autofocus 的恢复目标缺失

Kobalte 0.13.11 的焦点监听安装晚于 UI 包装组件的同步 autofocus，lastFocusedElement 未记录已有内部焦点。补丁在作用域激活时记录当前有效内部焦点；恢复时依次选择有效历史目标、当前内部焦点、首个 tabbable 和 Content 容器。

已移除、移出容器、禁用、断开或焦点哨兵均不会成为历史恢复目标。保留 top-layer 豁免、非模态、关闭、自动聚焦取消及卸载恢复行为。

### 实施中补出的 F06：暂停生效和监听清理之间的窗口

加严叠层回归后，上层 Upper 的同步 autofocus 被下层 Lower 的旧监听抢回，焦点停在 Open upper。仅在安装监听时检查 isPaused 不够：作用域已暂停，但响应式清理可能尚未移除监听。

最终补丁在 focusin 和 focusout 事件入口再次检查 isPaused 和 trapFocus。真实浏览器先断言 Upper 首次 autofocus，再从外部请求焦点并确认仍留在 Upper，关闭后验证 Lower 恢复约束。没有通过手动先聚焦 Upper 规避失败。

### AC-02：关闭完成的验收契约错误

Portal 内容消失不代表内部 Active 已移除。保留 100ms 收尾和 command.tsx 的 dialog.active 保护；在持久 dialog-stack 宿主增加由真实 stack.length 派生的 data-dialog-count。

正式 E2E 先确认宿主存在且唯一，再等 count=0，然后只发送一次 Control+,。关闭期间保护由真实 App 中的受控 DOM 观察边界验证：编辑内容已消失、count 仍为 1 时发送一次按键，确认未接纳；count=0 后不自动重放，之后一次真实快捷键可打开设置。

组件测试验证 closing 期间计数保留；Portal 消失窗口以 Chromium 结果为准，不用 Happy DOM 的 Portal 存在性代替真实浏览器。

## 2. 文件范围

| 文件                                                            | 本轮内容                                |
| --------------------------------------------------------------- | --------------------------------------- |
| patches/@kobalte%2Fcore@0.13.11.patch                           | 源码、默认 JS、Solid JSX 三入口同一补丁 |
| package.json、bun.lock                                          | 精确版本补丁登记；没有依赖升级          |
| packages/ui/src/context/dialog.tsx                              | 持久宿主增加内部计数                    |
| packages/app/package.json                                       | typecheck:e2e:dialog 脚本               |
| packages/app/e2e/tsconfig.dialog-lifecycle.json                 | 正式 spec、夹具及 Vite 配置纳入类型检查 |
| packages/app/e2e/utils/dialog.ts                                | 共享真实 idle/count 检查                |
| packages/app/test-browser/dialog-provider-lifecycle.test.ts     | 计数关闭、叠层与替换回归                |
| packages/app/e2e/reproduction/dialog-lifecycle/main.tsx         | 真实组件焦点矩阵夹具                    |
| packages/app/e2e/regression/dialog-lifecycle-acceptance.spec.ts | 焦点、叠层、失效目标、卸载回归          |
| packages/app/e2e/regression/mcp-source-edit.spec.ts             | 保留快捷键，改等真实 idle               |
| packages/app/e2e/regression/mcp-dialog-acceptance.spec.ts       | 按钮入口对照、关闭期间快捷键保护        |

MCP 保存实现、公开协议、SDK、会话/timeline 和生产配置不在本轮修改范围。

## 3. 先失败再修复的证据

原始验收 10 pass、2 fail 保持历史记录，不覆盖。

- [首次焦点红测](C:/Users/zh2100/AppData/Local/Temp/opencode-dialog-fix-dc5c7401ee944338b95262eacd146d37/red/red.log)：0 pass、2 fail。真实 UI v2 与旧版 Dialog 均在未预先手动聚焦输入框时允许焦点逃出；构建成功，失败来自焦点断言。
- [加严叠层后失败](C:/Users/zh2100/AppData/Local/Temp/opencode-dialog-fix-dc5c7401ee944338b95262eacd146d37/verified/browser.log)：19 pass、1 fail。Upper 输入框没有获得初始焦点，快照明确焦点停在 Lower 的 Open upper。最终共享事件入口复检后该用例通过。
- 中间 green、green-final、green-complete 各为 19 pass、1 fail，日志全部保留。新增裸 Popover 夹具依次补齐现有 top-layer 标记、明确关闭按钮 aria-label 和产品 popover-content 样式契约。未使用 force click、固定 sleep 或放宽断言；最终真实输入和关闭点击都通过。

上述中间失败不混计为最终成功，也没有删除原始 trace 或 JSON。

## 4. 最终验证

| 验证                                                           | 结果                                              | 证据                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 修复后生产构建 + Chromium 完整正式套件                         | 20 pass、0 fail、0 skip、0 flaky，88.883 秒       | [日志](C:/Users/zh2100/AppData/Local/Temp/opencode-dialog-fix-dc5c7401ee944338b95262eacd146d37/final/browser.log)、[JSON](C:/Users/zh2100/AppData/Local/Temp/opencode-dialog-fix-dc5c7401ee944338b95262eacd146d37/final/playwright-results.json)、[HTML](C:/Users/zh2100/AppData/Local/Temp/opencode-dialog-fix-dc5c7401ee944338b95262eacd146d37/final/html-report/index.html) |
| 同一生产 bundle，三个独立 browser context 保存/快捷键重开/重读 | 3 pass、0 fail，23.496 秒，retries=0              | [日志](C:/Users/zh2100/AppData/Local/Temp/opencode-dialog-fix-dc5c7401ee944338b95262eacd146d37/repeat/browser.log)、[JSON](C:/Users/zh2100/AppData/Local/Temp/opencode-dialog-fix-dc5c7401ee944338b95262eacd146d37/repeat/playwright-results.json)                                                                                                                             |
| Provider 生命周期 + MCP ownership                              | 30 pass、0 fail、125 expect，9.27 秒              | [日志](C:/Users/zh2100/AppData/Local/Temp/opencode-dialog-fix-dc5c7401ee944338b95262eacd146d37/final/components.log)                                                                                                                                                                                                                                                           |
| App bun typecheck                                              | 退出 0                                            | [日志](C:/Users/zh2100/AppData/Local/Temp/opencode-dialog-fix-dc5c7401ee944338b95262eacd146d37/final/app-typecheck.log)                                                                                                                                                                                                                                                        |
| UI bun typecheck                                               | 退出 0                                            | [日志](C:/Users/zh2100/AppData/Local/Temp/opencode-dialog-fix-dc5c7401ee944338b95262eacd146d37/final/ui-typecheck.log)                                                                                                                                                                                                                                                         |
| App bun typecheck:e2e:dialog                                   | 退出 0                                            | [日志](C:/Users/zh2100/AppData/Local/Temp/opencode-dialog-fix-dc5c7401ee944338b95262eacd146d37/final/e2e-typecheck.log)                                                                                                                                                                                                                                                        |
| Prettier                                                       | 本轮代码、清单及新类型配置全部通过                | 本轮命令输出                                                                                                                                                                                                                                                                                                                                                                   |
| 原有文件差异保护                                               | 四个文件去掉本轮精确新增后，与实施前 SHA-256 一致 | [摘要](C:/Users/zh2100/AppData/Local/Temp/opencode-dialog-fix-dc5c7401ee944338b95262eacd146d37/final/baseline-preservation.json)                                                                                                                                                                                                                                               |
| 独立端口清理                                                   | 本轮七个端口均不再监听                            | [记录](C:/Users/zh2100/AppData/Local/Temp/opencode-dialog-fix-dc5c7401ee944338b95262eacd146d37/final/port-cleanup.json)                                                                                                                                                                                                                                                        |

最终 20 项由原有 12 项、7 个焦点矩阵场景、1 个关闭期间快捷键保护组成。原有 Provider/MCP 组件 28 项加计数回归 2 项为 30 项；三次快捷键验证独立报告，不混入正式 20 项。

焦点矩阵覆盖旧版 Dialog、默认聚焦及 Tab/Shift+Tab、历史目标被移除/禁用/移出、空 Content 和遵守既有 top-layer 契约的外置 Popover；原有叠层、替换、销毁、迟到保存回包全部保留。

## 5. 可重复安装与真实入口

- 仓库仍为 bun.lock v1，packageManager 仍为 bun@1.3.14。Bun 1.3.14 在独立完整源码副本执行 frozen lockfile-only 校验退出 0，锁文件摘要不变：[日志](C:/Users/zh2100/AppData/Local/Temp/opencode-dialog-fix-dc5c7401ee944338b95262eacd146d37/verified/ci-root-lock-check.log)。
- 最终补丁使用 CI 同版本 Bun 1.3.14，在 C:/ocdf-ci-clean-dc5c7401 的全新目录、全新缓存中冻结安装成功，26 packages，10.04 秒：[日志](C:/ocdf-ci-clean-dc5c7401/install.log)。
- 本机 Bun 1.4.3 在独立完整副本 C:/ocdf-dc5c7401 中进行 App/UI 过滤的冻结、离线安装成功，实际测试不共享主工作区依赖实体。
- 最小验证项目最初由 Bun 1.4.3 生成 v2 锁文件，直接交给 Bun 1.3.14 会报 UnknownLockfileVersion。这只涉及临时项目；已改用 1.3.14 生成该项目自己的 v1 锁，再在另一全新目录冻结安装。不能据此认定仓库锁文件不兼容。
- 组件测试的实际默认入口为 dist/dialog/index.js：[解析记录](C:/Users/zh2100/AppData/Local/Temp/opencode-dialog-fix-dc5c7401ee944338b95262eacd146d37/final/default-entry.json)。
- 最终生产构建实际包含 dist/dialog/index.jsx 与 dist/chunk/7A3GDF4Y.jsx：[构建模块记录](C:/Users/zh2100/AppData/Local/Temp/opencode-dialog-fix-dc5c7401ee944338b95262eacd146d37/final/resolved-kobalte-modules.json)。仅隔离构建的审计插件读取 Rollup 模块 id，不修改产品逻辑或 bundle 文本；临时配置已归档并从工作副本移除。
- 干净安装和最终运行依赖的源码、JS、JSX 三文件逐字节相同：[摘要](C:/Users/zh2100/AppData/Local/Temp/opencode-dialog-fix-dc5c7401ee944338b95262eacd146d37/final/install-entry-proof.json)。
- 最终补丁已剔除 Bun 重复 patch 工作流带入的两个空缓存标记，仅包含三个源码文件；清理前后实际运行文件摘要一致。最终 patch SHA-256：07885ca56566ef4e91d558685b109db8ee92d119d7a2a6baf95916a704e681a4。

## 6. 截图复核

已实际查看以下截图，保存后的命令和替换弹窗草稿均与断言相符：

- [首次焦点约束](C:/Users/zh2100/AppData/Local/Temp/opencode-dialog-fix-dc5c7401ee944338b95262eacd146d37/final/browser-results/dialog-lifecycle-acceptanc-41ac9-outside-control-requests-it-chromium/bound-dialog-focus.png)
- [保存重开后 node saved.js](C:/Users/zh2100/AppData/Local/Temp/opencode-dialog-fix-dc5c7401ee944338b95262eacd146d37/final/browser-results/mcp-dialog-acceptance-real-7a99f-us-closes-saves-and-reloads-chromium/mcp-saved-reopened.png)
- [迟到保存后仍保留 node replacement-draft.js](C:/Users/zh2100/AppData/Local/Temp/opencode-dialog-fix-dc5c7401ee944338b95262eacd146d37/final/browser-results/mcp-dialog-acceptance-real-d5d5d-eplacement-dialog-and-draft-chromium/mcp-late-save-preserved-draft.png)

## 7. 验收边界与交付状态

本机为 Windows NT 10.0.26300.0，Chromium 使用真实前端生产构建；完整 App 的 HTTP/API 由独立 browser context 内路由控制。未连接生产后端，因此本轮结果不外推真实后端落盘、Linux/macOS 或已安装 Electron 包。

AC-01 共享焦点缺陷、实施中补出的叠层暂停窗口及 AC-02 关闭等待契约在上述范围通过。OA-06、UI01～UI08、R3-03B、RF-07 等历史项保持原状态，不因本轮局部验收整体关闭。

所有独立服务已结束，证据保留在 C:/Users/zh2100/AppData/Local/Temp/opencode-dialog-fix-dc5c7401ee944338b95262eacd146d37。主工作区源文件已交付；当前运行实例还使用原依赖。之后正常安装依赖会自动应用持久补丁，本轮未执行该安装或重启。
