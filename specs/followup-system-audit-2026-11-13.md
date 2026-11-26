# 后续系统检查：新增两项缺陷（2026-11-13）

本轮确认两项仍需修复的缺陷：FUP-01（P1，定时循环一次异常后退出）与 FUP-02（P2，并发刷新忙状态丢失）。这是新一轮独立发现，不撤销 RV-05-R1 已补修的结论，也不把历史平台待验收项重新包装成新缺陷。

本轮仅检查、在隔离副本创建诊断测试、运行回归并记录；没有修改主项目或隔离副本的业务实现，没有修改主项目正式测试，没有提交、推送、重启当前应用或操作生产配置、凭据、锁及迁移标记。

## FUP-01：一次 tick 通知异常会终止后续自动调度（P1）

位置：[scheduled-task.ts:672](D:/opencode/packages/core/src/scheduled-task.ts:672)。相关路径为 tick 中的 advance → publish → execute。

根因：repeat 包住未隔离错误的 tick，错误处理放在整个 repeat 外部。一次 tick 异常会使 repeat 结束；外部 ignore 不能让已结束的循环恢复，缺陷通道也不能由普通 typed-error 忽略处理可靠接住。服务没有再次启动该循环的监督机制。EventV2 发布中的数据库操作使用 orDie，实际事件持久化异常可能进入这条通道。

受控复现：

1. 在隔离 SQLite 中建立已到期任务，启动真实 ScheduledTaskStore 的自动调度循环。
2. 只对第一次 pending run 的 EventV2.publish 注入一次 defect，随后适配器恢复正常；没有持续阻止通知，没有修改业务循环或时间。
3. 服务仍能创建第二个已到期且启用的任务。
4. 等待真实 31 秒，超过生产代码的 30 秒 tick 周期。
5. 第二个任务仍 enabled=true，运行记录为空，没有创建会话；pending 通知尝试数始终为 1。
6. 同路径关闭故障注入的对照，在下个周期有 completed 记录，pending 通知尝试为 2、会话为 2。

故障样本先后两次均失败（应完成后续任务的断言失败）；正常对照通过。并非第一项任务是否应重放的问题：第一项可按现有策略收尾，后续独立任务仍应继续被调度。

验证边界：使用真实调度周期、SQLite 和服务生命周期；事件发布故障与 Session 由受控适配器提供，不声称本轮复现了真实磁盘权限故障或执行了真实模型请求。

最小修改方向：

- 把每轮 tick 的错误处理放在持续循环内，区分取消与非取消 Cause；取消继续传播并结束作用域，非取消失败保留脱敏诊断、以既定间隔进入后续轮次。
- 对单任务失败保留认领收尾，检查是否需要隔离同一轮的其余任务；不要重放已提交的会话或 Prompt，不要把任意失败改成成功。
- 正式回归至少覆盖：一次事件发布异常后下一任务仍自动执行；通知/恢复读取异常的后续轮次；未发生异常的对照；作用域退出后不再调度；原任务运行记录不被重复执行。

## FUP-02：跨供应商刷新会丢失仍在请求中的忙状态（P2）

位置：[use-relay-settings.ts:320](D:/opencode/packages/app/src/hooks/use-relay-settings.ts:320)、[use-relay-settings.ts:327](D:/opencode/packages/app/src/hooks/use-relay-settings.ts:327)。两套实际组件分别在 [settings-providers.tsx:227](D:/opencode/packages/app/src/components/settings-providers.tsx:227) 和 [providers.tsx:243](D:/opencode/packages/app/src/components/settings-v2/providers.tsx:243) 使用 store.fetching === vendor.id 决定按钮禁用及刷新文案。

根因：内部虽然按供应商保存动作归属，公开响应式状态 fetching/testing 仍各只有一个供应商 ID。A 开始后 B 开始会覆盖这个槽位；B 完成时直接清为空，不能表达 A 尚在运行。结果归属检查可以保护最终数据，却没有保护请求进行中的页面状态。

受控复现：

1. 打开包含 A、B 两个供应商的设置状态，开始 A 的模型刷新并挂住其响应。
2. 开始 B 的模型刷新，确认 A、B 请求均已发出。
3. 仅放行 B，并等待 B 完成，A 仍未完成。
4. 实际 fetching=undefined，A 对应的按钮禁用条件为 false，刷新文案也恢复。事实上 B 开始覆盖槽位时 A 就已失去忙状态。
5. 只有 A、没有 B 的相同对照中，fetching 保持 A，符合预期。

诊断重复得到同一失败，单供应商对照通过。影响为错误的刷新进度与可重复触发请求；本轮没有证据表明此处导致配置丢失。testing 共用同一机制，但两套当前页面没有 probe 按钮，不把它额外计成已复现的界面缺陷。

验证边界：真实共享状态实现的受控并发样本，加两套页面按钮谓词源码核对；本轮没有启动独立页面或获取浏览器截图，不将其标为真实界面验收。

最小修改方向：

- 用按供应商、动作类型隔离的响应式忙状态表示并发请求，两套布局使用同一个查询入口。
- 每次开始和结束按自身动作编号登记/移除，旧请求结束不能清除新请求；同供应商存在多个有效请求时，须定义全部结束或仅最新请求的明确策略，不能靠单个全局槽位推断。
- 切服务器、实体替换、销毁时按原生命周期清理，旧 finally 不能影响新上下文；保留现有 statusOwner 的结果归属规则。
- 正式回归覆盖 A/B 正反序完成、B 失败而 A 未完成、同供应商重入、切服务器与销毁，并补两套页面的按钮禁用与刷新文案检查。

## 执行证据

证据根：`C:/opencode-followup-audit-20261113`；诊断源码：`C:/obf-20261112`。四个相关源码文件在主目录、隔离副本及本轮开始记录的 SHA256 一致，最终不匹配 0，见 source-hashes.json。各包隔离 home/data/config/state/cache/managed/tmp，测试假数据及内存/临时数据库。

| 批次 | 实际结果 | 日志（相对证据根） |
| --- | --- | --- |
| 并发刷新首次诊断 | 0 pass / 1 fail，退出码 1 | app/logs/app-busy.log |
| 并发刷新加单供应商对照 | 1 pass / 1 fail，退出码 1 | app/logs/app-busy-controls.log |
| 自动调度故障诊断 | 0 pass / 1 fail，退出码 1，真实等待 31 秒 | core/logs/scheduler-loop.log |
| 同一路径无故障对照 | 1 pass / 0 fail，退出码 0 | core/logs/scheduler-control.log |
| 最终诊断再次注入单次异常 | 0 pass / 1 fail，退出码 1，真实等待 31 秒 | core/logs/scheduler-loop-repeat.log |
| 既有调度及取消回归 | 34 pass / 0 fail，退出码 0 | core/logs/existing-scheduler-regressions.log |
| 既有设置生命周期及完成回归 | 25 pass / 0 fail，退出码 0 | app/logs/existing-settings-regressions.log |

诊断文件：

- `C:/obf-20261112/packages/app/test-browser/followup-audit.test.ts`
- `C:/obf-20261112/packages/core/test/followup-scheduler-audit.test.ts`

现有测试通过与新诊断失败同时成立，不累加为去重用例数。现有调度的通知 defect 回归只验证手动 runNow 的当前收尾及后续手动调用，未验证后台持续循环；设置回归主要验证最终数据与结果归属，未验证跨行忙状态。这是本轮两项漏测的具体原因。

修复建议顺序：先 FUP-01 的自动调度可用性，再 FUP-02 的刷新状态。将诊断迁入正式测试后再实施，保留红绿证据及取消对照；不能根据既有通过数量直接关闭。

本轮针对配置/目录刷新状态、认证提交与后台调度等高风险边界继续审查，没有逐一全面审查工作区全部 416 条 Git 状态记录。R3-03B、RF-07、完整历史界面及目标打包产物仍按原文档保持状态，不视为本轮通过或新增确认缺陷。

## 后续修复（2026-11-13）

以上为修复前检查快照。FUP-01、FUP-02 已实施；自动验证、真实 31 秒轮询复验和首次失败处理见 [本批修复结果](D:/opencode/specs/followup-fix-results-2026-11-13.md)。FUP-02 真实页面仍待验收，历史未关闭项保持原状态，不能把本节替代为全部验收完成。

## FUP-02 页面补验完成（2026-11-13）

后续在主工作区两套实际设置页完成并发刷新与关闭重开验收，并验证现代设置页实际服务器选择器的旧回包隔离。最终 9 项通过，0 失败、0 跳过；E2E 类型检查通过。FUP-02 可按该本机页面范围关闭，历史完整 UI 和其他未覆盖平台仍保持原状态。详见 [页面验收记录](D:/opencode/specs/followup-ui-acceptance-2026-11-13.md)。以上旧检查及修复前失败保留为历史证据。
