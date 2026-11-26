# MCP 共享弹窗生命周期修复结果 — 2026-11-11

MR-01、MR-02 已完成实现修复与本机组件自动验证。完整设置页仍待界面验收；OA-06、UI01～UI08、R3-03B、RF-07 不因本轮结果关闭。没有提交、推送或重启当前应用。

## 修改范围

- [dialog.tsx](D:/opencode/packages/ui/src/context/dialog.tsx)：仅确定一个有效实例 id。栈、Kobalte 模态判断、原生关闭回调、实例上下文、DOM 标识和遮罩监听共用该 id。
- 同文件：关闭状态与动画定时器放到各实例；同一实例重复关闭去重，不同实例分别关闭。定时器在调用关闭回调前登记，避免回调中替换弹窗留下旧定时器。
- 同文件：show 和 Provider 卸载统一清理相关定时器和实例根，每个实例只清理一次。定时器按实例对象移除，不会按复用 id 移除后开的弹窗。Provider 卸载后不再挂载新弹窗；已销毁实例的微任务不会再添加遮罩监听。
- 同文件：push 保留其他实例的关闭动画，新层级沿当前栈顶层级递增，避免移除下层后复用仍在使用的层级。
- [dialog-provider-lifecycle.test.ts](D:/opencode/packages/app/test-browser/dialog-provider-lifecycle.test.ts)：新增真实 Kobalte.Content、CloseButton、焦点及生命周期回归，使用生产 Solid DOM 编译器，不替代 Provider 的业务逻辑。
- [dialog-mcp-v2-ownership.test.ts](D:/opencode/packages/app/test-browser/dialog-mcp-v2-ownership.test.ts)：保留原有 16 项，追加两层 MCP 同时保存成功的组件回归。

未改公开 Protocol、Server HttpApi、SDK 或会话/timeline 业务代码。本轮不涉及会话性能基线要求。

## 修改前与修改后

新增 Provider 生命周期套件先在旧实现上执行：4 pass、7 fail、15 assertions，退出码 1。失败包含绑定弹窗 modal=false、原生关闭无效、并发关闭遗留实例、push 取消旧关闭及 Provider 卸载未销毁根。

修改后该套件为 11 pass、0 fail、36 assertions，退出码 0。

随后对格式化后的最终版本联合执行：

    bun test --tsconfig-override ./tsconfig.test.json --conditions=browser --preload ./happydom.ts ./test-browser/dialog-provider-lifecycle.test.ts ./test-browser/dialog-mcp-v2-ownership.test.ts --timeout 20000

从 packages/app 运行，结果为 28 pass、0 fail、113 assertions，退出码 0，7.81s。其中 Provider 生命周期 11 项，MCP 组件归属 17 项；此前单独执行的 11 项包含在本次 28 项中，不重复计数。

隔离根：[opencode-overall-audit-c1d7301ad5c64fbeb767d4e9dba97aac](C:/Users/zh2100/AppData/Local/Temp/opencode-overall-audit-c1d7301ad5c64fbeb767d4e9dba97aac)。

日志：[mcp-lifecycle-tests.log](C:/Users/zh2100/AppData/Local/Temp/opencode-overall-audit-c1d7301ad5c64fbeb767d4e9dba97aac/mcp-lifecycle-tests.log)。

## 覆盖的关键边界

- 绑定与未绑定弹窗保持真实模态，外部元素不能抢走焦点。
- 原生 Kobalte 关闭按钮有效，关闭栈顶后下层恢复模态。
- 下层先关闭和上层先关闭均完成；重复及重入关闭仅通知、销毁一次。
- 关闭动画期间 push 不会取消旧实例的关闭。
- show 替换为相同 id 后，旧定时器不会误删新实例。
- onClose 中重入 show 正常收尾。
- Provider 卸载同时收尾打开和关闭中的根，后续没有重复销毁。
- 两层 MCP 保存同时成功后，两层均关闭，刷新和旧回包归属回归保持通过。

## 检查与限制

- packages/app：bun typecheck，退出码 0。
- packages/ui：bun typecheck，退出码 0。
- 本轮三个代码/测试文件经 Prettier 格式化；涉及的已跟踪业务文件 git diff --check 通过。
- Provider 生命周期测试使用唯一临时编译文件；全部测试结束后，临时编译文件已清理。
- 本轮证据为本机 DOM 组件级自动验证，没有启动完整设置页，也没有跨平台验收。不能据此关闭历史界面及迁移项目。


## 独立浏览器验收补充 — 2026-11-11

已执行生产构建、独立端口及真实 Chromium 验收。最终 12 项为 10 pass、2 fail、0 skip，退出码 1；28 项组件回归和 App/UI 类型检查仍通过。原生关闭、并发关闭、叠层恢复、替换与清理，以及完整 App 中按钮重开/保存重读/旧回包保留新草稿已通过；首次 autofocus 后的外部程序焦点约束（AC-01）和保存后的设置快捷键重开（AC-02）未通过。

此前“外部元素不能抢走焦点”仅为组件测试证据，不能作为真实浏览器完整焦点验收通过的结论。叠层用例在等待关闭收尾和下层焦点作用域恢复后通过。MR-01 的完整焦点验收仍不能关闭；MR-02 本机浏览器覆盖的关闭与清理路径通过。历史项目保持原状态。

详见[独立验收报告](D:/opencode/specs/mcp-dialog-acceptance-2026-11-11.md)。本轮仅新增/调整验收测试和记录，没有修改产品实现、提交、推送或重启当前应用。


## 验收失败归因更正 — 2026-11-11

后续隔离浏览器诊断确认：AC-01 是真实焦点缺陷，首次 autofocus 发生后 Kobalte 的 lastFocusedElement 仍为 null；再次内部聚焦建立记录后，外部抢焦点被拦住。AC-02 的失败源于用例把 Portal/DOM 层消失当成内部栈已清空；失败按键实际到达时 active.closing=true。等待真实内部活动栈清空后，三次完整快捷键保存重开对照均通过。因此 AC-02 改列为验收时序条件错误，原用例仍需修正；未改原始 12 项的 10 pass、2 fail 历史统计。产品完整焦点验收仍未关闭。详见[验收报告的后续根因分析](D:/opencode/specs/mcp-dialog-acceptance-2026-11-11.md)。本轮仅分析并更新记录，没有修产品代码。
