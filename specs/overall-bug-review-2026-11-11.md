# 整体未提交代码复核 — 2026-11-11

结论：本轮确认 3 处仍未修复的 MCP 弹窗异步生命周期缺陷。上轮 REVIEW-1111-01、REVIEW-1111-02 的修复保持不变。本轮仅审查和记录，没有修改业务实现、提交、推送、重启现有应用或写入生产配置。

## 范围与方法

- 复核设置、配置文档并发写入、认证与目录事务、调度取消和授权、同步与通知、文件树、Office 附件预算、桌面资源暂存及更新等高风险未提交路径。
- 新缺陷使用真实 DialogMcpV2、真实 mcp-form、真实 TanStack QueryClientProvider/useQuery，以及生产 babel-preset-solid DOM 编译器复现。替换网络响应、上下文入口、UI 外壳和 dialog.close 的观测接口；不复制组件的业务处理函数。
- 这是 DOM 组件级受控复现，不是完整应用的真实界面验收。
- 所审组件 SHA256：BB583B7483D66BA6C2DF18CBB94E2214DC3672877FEFAFBC1C28464EB381A85B。

## OR-01 / P2：旧服务器保存成功后禁用当前服务器的保存

位置：[dialog-mcp-v2.tsx:237](D:/opencode/packages/app/src/components/settings-v2/dialog-mcp-v2.tsx:237)。

触发顺序：

1. 在服务器 A 的 MCP 编辑弹窗保存，阻塞 updateMcp 的响应。
2. 同一弹窗上下文切换到服务器 B，B 的来源配置成功加载。身份切换会清空 saved，保存按钮此时可用。
3. 放行 A 的保存成功响应。
4. B 的保存按钮变为 disabled，且弹窗保持打开。

根因：保存失败、finally 和刷新关闭处有部分 identity 检查，但成功路径的 setStore("saved", true) 没有任何归属检查。它将 B 标记成已经提交；canSaveMcp 因 saved 为 true 拒绝保存。

复现断言：期望 B 保存按钮 disabled=false，实际 true。没有发生 B 的配置提交。

修复方向：

- 为保存操作捕获服务器 scope、目录、弹窗生命周期代次和操作序号。
- 成功、失败、finally 的界面写入使用同一个有效性判断。
- A 已经提交的配置仍应按 A 的 scope/目录刷新；该刷新与能否修改 B 弹窗状态分开处理。
- 补充 A→B、A→B→A，以及旧保存和当前保存交错完成的组件回归。

## OR-02 / P2：旧重载请求会给新服务器留下错误提示

位置：[dialog-mcp-v2.tsx:117](D:/opencode/packages/app/src/components/settings-v2/dialog-mcp-v2.tsx:117)。

触发顺序：

1. A 保存返回 MCP_VERSION_CONFLICT，显示重新加载按钮。
2. 点击重新加载并阻塞 A 的来源读取。
3. 切换到 B，B 的来源读取仍在进行。
4. 放行 A 的重载，再放行 B 的正常读取。
5. B 的 URL 已正常显示，弹窗却持续显示 settings.mcp.error.load 对应的“加载失败”提示。

根因：reloadLatest 没有请求身份、生命周期和操作序号检查。真实查询观察器已经切换到 B；A 的 refetch 完成后，其返回结果反映当前 B 的 pending 状态。mcpReloadSucceeded 返回 false，旧流程便把错误写入 B 的 store。B 后续自动读取成功的 effect 不会清除这条错误。

复现断言：期望 B 加载成功后无 load 错误，实际提示仍在。

修复方向：

- 在重载发出前捕获身份和操作序号，await 后先验证该重载是否仍归属于当前弹窗。
- 身份变化、销毁或新重载开始时，使旧重载失效；不能只根据观察器当前的 isSuccess 判定旧请求结果。
- 明确区分当前重载错误和其他操作错误，当前成功只清除自己拥有的错误。
- 补充 B 仍在 pending、B 已加载、重载交错及销毁的真实查询库回归。

排除的初步疑点：使用查询替身时曾观察到“A 的内容使 B 草稿发生字段冲突”。换成真实查询库后，B 已加载的该场景通过，因此没有把它列为已确认缺陷；本项只记录上述真实库下复现的残留错误。

## OR-03 / P2：已销毁弹窗的旧保存会关闭后开的弹窗

位置：[dialog-mcp-v2.tsx:146](D:/opencode/packages/app/src/components/settings-v2/dialog-mcp-v2.tsx:146)；关闭语义见 [dialog.tsx:194](D:/opencode/packages/ui/src/context/dialog.tsx:194)。

触发顺序：

1. A 弹窗保存挂起。
2. 关闭/销毁该弹窗，再打开一个新弹窗。全局 DialogProvider 的 Escape、遮罩关闭和 dialog.show 替换路径都可以销毁旧弹窗。
3. 放行旧保存，等待其刷新结束。
4. 旧组件仍调用 dialog.close；该 API 关闭的是当前栈顶弹窗。

根因：identity 是服务器、目录、模式、名称组成的值，没有包含组件是否已销毁。旧组件销毁后，它的异步 Promise 仍会继续；只比较 identity 无法证明它仍拥有关闭弹窗的权限。通用 dialog.close 又没有绑定原弹窗的 id。

复现断言：新弹窗出现后，旧保存结束不应调用 close，实际调用 1 次。结合真实 DialogProvider 的栈顶关闭语义，新弹窗可能被关闭，尚未保存的输入随之丢失。

修复方向：

- onCleanup 使该组件生命周期令牌失效；保存、刷新重试、错误回写和关闭全部检查此令牌。
- 异步关闭还应确认弹窗归属，或使用只能关闭原实例的 id/句柄，避免关闭新弹窗或后叠加的弹窗。
- 不把“服务器和名称相同”当成“还是原来的弹窗”。
- 补充保存期间 Escape/遮罩关闭、dialog.show 替换、同名重开和叠加弹窗的回归。

## 共通根因与测试缺口

目前防护分散在 catch、finally 和刷新结束处，保存成功、重新加载和组件销毁没有使用统一的操作所有权规则。已有 mcp-form 测试验证了草稿、参数与冲突纯函数，但没有覆盖真实弹窗、查询观察器和 DialogProvider 的异步交互。

建议按“组件生命周期 → 身份代次 → 操作序号 → 弹窗归属”统一检查所有异步出口，并先保留本轮失败场景作为回归，再实施修复。已经提交的配置刷新与当前弹窗的 UI 写入应分别处理。

## 本轮验证

| 范围 | 本轮结果 |
| --- | --- |
| 新增真实组件复现，含正常路径对照 | 2 pass、3 fail、20 assertions，退出码 1；3 条失败分别对应 OR-01～OR-03 |
| App 首批 8 文件联合回归 | 118 pass，2 个测试文件因全局 mock 缺失 ServerConnection 导出而加载失败，退出码 1 |
| App server-sync 与 notification 独立进程重跑 | 46 pass、0 fail、111 assertions，退出码 0 |
| Core 认证、目录事务、跨进程、调度取消/授权、图片设置、附件，共 8 文件 | 95 pass、0 fail、484 assertions，退出码 0 |
| OpenCode 配置并发、配置、HTTP、权限夹具、附件，共 5 文件 | 222 pass、2 skip、0 fail、851 assertions，退出码 0 |
| Desktop 更新、版本、CLI 暂存/启动和打包配置，共 5 文件 | 42 pass、0 fail、123 assertions，退出码 0 |
| App、Core、OpenCode 的 bun typecheck | 均为退出码 0 |

App 首批失败的原因是 submit.test.ts 的全局 mock.module("@/context/server") 仅提供 useServer，污染后加载的真实 server-sync/notification 依赖。独立进程通过不能表述为该联合批次通过。这是验证隔离问题，本轮没有将其计入上述 3 个产品缺陷。

OpenCode 两个 skip 是 Windows 上不适用的 POSIX 权限用例，不计为跨平台通过。类型检查首次审批超时后重试成功，最终没有被该项阻塞。

## 证据

- [最终复现脚本](C:/Users/zh2100/AppData/Local/Temp/opencode-overall-review-mcp-20261111/review-overall-mcp.test.ts)
- [最终复现日志](C:/Users/zh2100/AppData/Local/Temp/opencode-overall-review-mcp-20261111/probe.log)
- App 首批日志：C:/Users/zh2100/AppData/Local/Temp/opencode-overall-audit-938925760b8c467c99a11d8460761e92/regression.log
- Core 日志：C:/Users/zh2100/AppData/Local/Temp/opencode-overall-audit-edd7eb3143524420acdfb3a594dfdf1e/regression.log
- OpenCode 日志：C:/Users/zh2100/AppData/Local/Temp/opencode-overall-audit-76d1b8fac24e4ba9811878cdcb20dbf4/regression.log
- Desktop 日志：C:/Users/zh2100/AppData/Local/Temp/opencode-overall-audit-f34445a58ba6429aa6d3534037f714dd/desktop.log

复现脚本保存在隔离目录；要重跑需临时放回 packages/app/test-browser 并从 App 包目录运行，脚本会在原组件旁生成编译副本。审查结束时仓库中的这两个临时文件均已移除。

## 状态边界

- 本轮 3 项：已确认、未修复。
- 真实界面、RF-07 跨平台、R3-03B 整体验收、已安装产品与真实迁移等历史未完成范围，没有因本轮回归通过而关闭。
- 本轮没有覆盖所有组合和平台，不能据此把整个项目标为无 bug。
