# MCP 弹窗归属修复复核 — 2026-11-11

结论：OR-01～OR-03 的既有 16 项组件回归独立重跑通过，但共享 DialogProvider 仍有两处确定缺陷，因此这次修复不能按整体完成验收。OA-06、UI01～UI08、R3-03B、RF-07 保持原状态。

本轮没有修改业务代码，没有提交、推送或重启应用。原有修复和结果文档均保留。

## MR-01 / P2：绑定 id 与内部 id 不一致，MCP 弹窗失去模态语义

位置：[dialog.tsx:90](D:/opencode/packages/ui/src/context/dialog.tsx:90)、[dialog.tsx:102](D:/opencode/packages/ui/src/context/dialog.tsx:102)、[dialog.tsx:145](D:/opencode/packages/ui/src/context/dialog.tsx:145)。

生产 MCP 入口通过 bindDialog 提供 id。mount 却另建一个内部随机 id：

- stack 中 Active.id 使用绑定 id。
- Kobalte.modal 仍把 stack 栈顶的 id 和内部随机 id 比较。
- onOpenChange 也用内部随机 id 判断栈顶，并用该 id 调用 close。

因此绑定后的 MCP 弹窗即使在栈顶，modal 也为 false。真实 Kobalte.Content 的焦点限制、外部内容隐藏和外部指针屏蔽都依赖该值。原生 Kobalte 关闭回调则因 id 比较失败而提前返回。手工挂接的遮罩监听和全局 Escape 能关闭，不代表这些原生语义正常。

受控复现没有 mock DialogProvider、Kobalte.Content 或 Kobalte.CloseButton，只把真实 DialogProvider 源码经生产 Solid DOM 编译器编译：

1. 未绑定 id 的栈顶弹窗，真实 useDialogContext().modal() 为 true，阳性对照通过。
2. 绑定 id 的栈顶弹窗，期望 modal=true，实际 false。
3. 点击绑定弹窗的真实 Kobalte.CloseButton，等待 160ms，期望 0 层，实际仍有 1 层。

结果：1 pass、2 fail、4 assertions，退出码 1。

修复方向：在 mount 开头只确定一个有效 id，即绑定 id 或新生成 id。Active、modal、onOpenChange、InstanceContext、DOM 标识、遮罩关闭和异步关闭全部使用这一个 id。不要保留两套需反复换算的身份。

补测：真实 Content 下的绑定/未绑定、单层/叠层模态值与焦点限制，以及原生 CloseButton/onOpenChange。已有 MCP 归属回归把 UI Dialog 外壳替换成 children 透传，没有挂载真实 Content，未覆盖这条边界。

## MR-02 / P2：全局关闭锁吞掉另一实例的关闭，留下已保存但不能再次保存的弹窗

位置：[dialog.tsx:54](D:/opencode/packages/ui/src/context/dialog.tsx:54)。

close 使用 Provider 级别的 lock.value 和单一 timer。任一弹窗进入 100ms 关闭动画后，其他 id 的 close 也直接 return，且没有排队或补执行。

真实组件复现：

1. 下层 MCP 编辑弹窗开始保存，保持响应挂起。
2. push 上层 MCP 添加弹窗，填入名称和命令并开始保存。
3. 两笔保存都进入网络请求后，同时放行成功响应。
4. 两笔提交及刷新正常结束，但只有先完成的关闭请求被执行。
5. 300ms 后仍剩 1 层；残留层显示 common.save，disabled=true，没有刷新失败提示。

结果：0 pass、1 fail、2 assertions、16 filtered out，退出码 1。期望所有已成功保存并请求关闭的实例均结束，实际层数为 1。

这不是“下层不能关闭上层”的归属问题。两笔请求都有各自正确的实例 id，Provider 却将另一个实例的关闭当成重入请求丢弃。

修复方向：将 closing 状态和关闭计时器放到每个实例；只对相同 id 的重复关闭去重。不同 id 应分别执行关闭，或进入能保证执行的队列。push/show/Provider 清理要分别收尾相关实例的计时器和 dispose，不能靠一个全局计时器取消其他实例的关闭。

补测：两层保存同时成功、两种完成顺序、一个实例关闭动画期间另一个请求关闭、重复关闭同一 id，以及关闭期间 push/show。断言最终实例集合、dispose 次数、onClose 次数和计时器清理。

## 根因

这次把异步操作的归属扩展到了弹窗实例，但底层生命周期仍混用两套 id，关闭动画仍只有 Provider 级别的单一状态。上层“带 id 调用”无法弥补底层这些不一致。

原 16 项测试验证了旧请求不会写入新草稿、不会误关其他实例；没有同时验证真实 Content 的模态语义和两个合法关闭请求的完成性，因此可以全部通过并遗漏上述问题。

## 本轮独立验证

| 项目 | 结果 |
| --- | --- |
| dialog-mcp-v2-ownership.test.ts | 16 pass、0 fail、75 assertions，退出码 0 |
| App bun typecheck | 退出码 0 |
| UI bun typecheck | 退出码 0 |
| 绑定 id 的真实 Kobalte 复现 | 1 pass、2 fail，退出码 1 |
| 两层真实 MCP 组件同时保存 | 0 pass、1 fail，退出码 1 |
| 本轮涉及业务文件 git diff --check | 通过 |

既有 16 项回归使用的隔离根：C:/Users/zh2100/AppData/Local/Temp/opencode-overall-audit-aed974c1022449b282ec1b21fc181b1a。

两处补充复现使用独立测试进程，均未启动完整应用。Windows DOM 组件证据不能代替真实设置页、焦点操作或跨平台验收。

## 证据

隔离证据目录：C:/Users/zh2100/AppData/Local/Temp/opencode-mcp-ownership-review-b2a0869c37564aba848b185b0d4be7da。

- [绑定 id 复现脚本](C:/Users/zh2100/AppData/Local/Temp/opencode-mcp-ownership-review-b2a0869c37564aba848b185b0d4be7da/review-dialog-binding.test.ts)
- [绑定 id 复现日志](C:/Users/zh2100/AppData/Local/Temp/opencode-mcp-ownership-review-b2a0869c37564aba848b185b0d4be7da/binding.log)
- [双保存复现脚本](C:/Users/zh2100/AppData/Local/Temp/opencode-mcp-ownership-review-b2a0869c37564aba848b185b0d4be7da/review-dialog-owned-saves.test.ts)
- [双保存复现日志](C:/Users/zh2100/AppData/Local/Temp/opencode-mcp-ownership-review-b2a0869c37564aba848b185b0d4be7da/owned-saves.log)

复现时 DialogProvider SHA256：D2751A80BB0A5931179355B0259FE110E6CAC4E3EB6A0C2A0E8267E8BEC586C9。

脚本副本保存在隔离目录；仓库中的临时测试和编译副本已删除。重跑时须将脚本临时放回 App 的 test-browser，并从 packages/app 运行对应命令。


## 后续修复 — 2026-11-11

MR-01、MR-02 已完成实现修复和本机组件验证。新增 Provider 生命周期回归在旧实现上为 4 pass、7 fail；修复后联合 MCP 归属回归为 28 pass、0 fail、113 assertions。App、UI 的 bun typecheck 均退出 0。详细范围与证据见[修复结果](D:/opencode/specs/mcp-dialog-lifecycle-fix-results-2026-11-11.md)。原始复核证据保留。完整设置页与历史未完成项仍待验收；未提交、未推送、未重启应用。


## 独立浏览器验收补充 — 2026-11-11

已执行生产构建、独立端口及真实 Chromium 验收。最终 12 项为 10 pass、2 fail、0 skip，退出码 1；28 项组件回归和 App/UI 类型检查仍通过。原生关闭、并发关闭、叠层恢复、替换与清理，以及完整 App 中按钮重开/保存重读/旧回包保留新草稿已通过；首次 autofocus 后的外部程序焦点约束（AC-01）和保存后的设置快捷键重开（AC-02）未通过。

此前“外部元素不能抢走焦点”仅为组件测试证据，不能作为真实浏览器完整焦点验收通过的结论。叠层用例在等待关闭收尾和下层焦点作用域恢复后通过。MR-01 的完整焦点验收仍不能关闭；MR-02 本机浏览器覆盖的关闭与清理路径通过。历史项目保持原状态。

详见[独立验收报告](D:/opencode/specs/mcp-dialog-acceptance-2026-11-11.md)。本轮仅新增/调整验收测试和记录，没有修改产品实现、提交、推送或重启当前应用。


## 验收失败归因更正 — 2026-11-11

后续隔离浏览器诊断确认：AC-01 是真实焦点缺陷，首次 autofocus 发生后 Kobalte 的 lastFocusedElement 仍为 null；再次内部聚焦建立记录后，外部抢焦点被拦住。AC-02 的失败源于用例把 Portal/DOM 层消失当成内部栈已清空；失败按键实际到达时 active.closing=true。等待真实内部活动栈清空后，三次完整快捷键保存重开对照均通过。因此 AC-02 改列为验收时序条件错误，原用例仍需修正；未改原始 12 项的 10 pass、2 fail 历史统计。产品完整焦点验收仍未关闭。详见[验收报告的后续根因分析](D:/opencode/specs/mcp-dialog-acceptance-2026-11-11.md)。本轮仅分析并更新记录，没有修产品代码。
