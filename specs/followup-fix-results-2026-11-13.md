# FUP-01 / FUP-02 修复结果（2026-11-13）

本批修复上一轮检查确认的两项缺陷。只改调度循环的异常边界、供应商忙状态及相关正式回归；没有改公开协议或 SDK，没有提交、推送、改版本、重启当前应用/服务器或操作生产配置、凭据、锁与迁移标记。保留工作区其他未提交修改。

## 1. 根因与修改

| 编号 | 根因 | 本次修改 | 状态 |
| --- | --- | --- | --- |
| FUP-01 / P1 | tick 失败先退出 repeat，循环外 ignore 不能恢复持续轮询；单任务的认领后通知缺陷还能阻断同轮其他任务 | 对每个认领边界及每轮 tick 分别捕获 Cause；非取消失败仅记录任务关联号及 Cause 标签，继续同轮其他任务或按原 30 秒间隔进入下一轮；包含中断的 Cause 原样传播 | 自动验证通过 |
| FUP-02 / P2 | testing、fetching 各自只保存一个供应商 ID，无法表达不同行同时刷新 | 改为每种动作、每个供应商各自的响应式布尔状态；两套布局统一使用 isBusy；scope、实体替换和销毁清理自己的状态 | 自动验证通过 / 界面待验收 |

调度保留 withClaim/abandoned 的既有收尾，失败认领仍为 interrupted，不伪装成执行成功；不重放 Session/Prompt。服务首次构建时的 migrate/recover 失败边界保持原样。后台轮询仍为 30 秒，不新增生产测试开关，也不进行无间隔重试。

同一供应商同一动作仍以最新请求拥有忙状态。较旧请求先结束不得清除新请求；最新请求结束后即解除忙状态，即使较旧请求仍未返回。这与既有 U05/H04 规则一致。其他供应商不受该请求的收尾影响。销毁先失效生命周期，再清除忙状态，晚到 finally 不会重新写入。

## 2. 正式回归映射

- Core 在原 scheduled-task.test.ts 补 4 项真实服务测试，使用 Effect TestClock 推进原生产轮询：认领后的 pending 通知 defect、恢复通知 defect、通知中断、无故障对照。验证同轮继续、后续轮次继续、失败认领终态、不重放，以及作用域退出后留下的到期任务不再执行。中断对照必须停止后续轮次。
- App 新增 relay-settings-busy.test.ts 共 16 项，直接调用 createRelaySettingsState：testing/fetching 分别覆盖 A 先完成、B 先完成、B 失败、同供应商旧/新先完成、scope、实体替换、dispose。请求通过独立 Promise 屏障控制，finally 释放全部屏障。
- 原 state/lifecycle 用例的单槽断言改成等价 isBusy 查询，不放宽真假或乱序断言。两套页面的禁用与刷新文案都读取同一个 isBusy 查询。

## 3. 修复前失败与过程中问题

证据根：C:/fup-fix-20261113。所有包使用独立 home/data/config/state/cache/managed/tmp，测试使用临时/内存数据库与录制 Session，不调用真实模型或生产凭据。

| 批次 | 实际结果 | 日志（相对证据根） |
| --- | --- | --- |
| App 第一次运行（测试定义误插入 gate 内） | 0 tests，退出码 0；属于夹具错误，不作为验证通过 | app/logs/red-busy.log |
| 修正测试布局后，在旧实现执行 | 8 pass / 8 fail，共 16 项；退出码 1 | app/logs/red-busy-executed.log |
| Core 旧实现 | 2 pass / 2 fail，共 4 项；通知缺陷、恢复缺陷失败，取消与正常对照通过；退出码 1 | core/logs/red-scheduler.log |
| App 定向修复后 | 16 pass / 0 fail，退出码 0 | app/logs/green-busy.log |
| Core 定向修复后 | 4 pass / 0 fail，退出码 0 | core/logs/green-scheduler.log |

Core 首次类型检查发现新增正式/隔离诊断适配器的泛型 data 在使用 in 前缺少 object/null 收窄，退出码 2。已修正测试类型，没有更改产品公开错误类型；完整复跑退出码 0，原失败日志保留于 core/logs/typecheck.log，复跑见 typecheck-final.log。隔离诊断文件不交付到主目录。

## 4. 最终验证

| 范围 | 结果 | 日志（相对证据根） |
| --- | --- | --- |
| 隔离源码 Core：调度、取消、真实 runner 授权、模型身份 | 53 pass / 0 fail，退出码 0 | core/logs/regression-scheduler.log |
| 隔离源码 App：设置 7 个正式套件 | 122 pass / 0 fail，退出码 0 | app/logs/regression-settings.log |
| 真实间隔诊断：注入一次 pending 发布缺陷，等待实际 31 秒 | 1 pass / 0 fail，退出码 0；下一任务 completed，Session 1 次 | core/logs/realtime-scheduler.log |
| 隔离源码 Core / App 完整 bun typecheck | 均退出码 0 | core/logs/typecheck-final.log；app/logs/typecheck.log |

正式 Core 命令（从 packages/core 运行）：

```powershell
bun test --timeout 15000 ./test/scheduled-task.test.ts ./test/scheduled-task-cancel.test.ts ./test/scheduled-authorization.test.ts ./test/scheduled-model-identity.test.ts
bun typecheck
```

正式 App 命令（从 packages/app 运行）：

```powershell
bun test --tsconfig-override ./tsconfig.test.json --conditions=browser --preload ./happydom.ts ./test-browser/relay-settings-state.test.ts ./test-browser/relay-settings-lifecycle.test.ts ./test-browser/relay-settings-protocol.test.ts ./test-browser/relay-settings-completion.test.ts ./test-browser/relay-settings-drafts.test.ts ./test-browser/relay-settings-bugs.test.ts ./test-browser/relay-settings-busy.test.ts
bun typecheck
```

主目录最终批次与交付核对见后续追加；不同批次不累加成去重用例数。真实间隔诊断仅在隔离副本执行，其业务源码与交付版本摘要一致。

## 5. 验收边界

本轮没有启动独立页面或进行浏览器操作。两套布局的实际并发按钮禁用和刷新文案仍待真实页面验收，不能将源代码谓词核对或共享状态测试算作界面通过。

历史完整 UI、R3-03B、RF-07 跨平台以及目标打包产物保持原状态。本批有限出口只覆盖上述两项自动验证，不代表工作区所有缺陷已消除。
## 6. 主工作区交付后的最终批次

在 D:/opencode 的包目录运行上述正式命令，继续使用 C:/fup-fix-20261113 下的隔离运行数据。

| 最终批次 | 实际结果 | 日志（相对证据根） |
| --- | --- | --- |
| Core 四套正式回归 | 53 pass / 0 fail / 0 skip，259 个断言，退出码 0 | core/logs/main-regression-scheduler.log |
| App 七套正式回归 | 122 pass / 0 fail / 0 skip，674 个断言，退出码 0 | app/logs/main-regression-settings.log |
| Core 完整 bun typecheck | 退出码 0 | core/logs/main-typecheck.log |
| App 完整 bun typecheck | 退出码 0 | app/logs/main-typecheck.log |

最终 Core 正式测试额外留下到期任务再退出作用域，推进 90 秒后确认没有后续认领、发布或 Session 创建；不使用“已经没有到期任务”的空对照证明退出。

交付前 9 个已记录目标文件与本轮起始主目录摘要一致。本轮逐文件交付 8 个源码/测试文件，并新增本结果、追加检查报告及矩阵，共涉及 11 个文件。8 个交付文件与验证副本 SHA256 一致；最终清单见 C:/fup-fix-20261113/delivery-hashes.json。

对交付前记录的 420 个已有修改/未跟踪/删除文件逐项核对，非目标差异为 0；新出现的非目标文件为 0；Git index 文件摘要完全一致，未改变暂存状态。记录见 workspace-before-delivery.json、index-before-delivery.txt、delivery-verification.json。

一次交付核对误加 core.autocrlf=false，使原本无差异的 tool/registry.ts 被报告为新修改。此为核对方法变化，不是源码变化：该文件与隔离基线逐字节一致，使用与基线相同的 Git 配置后 diff 为空。没有覆盖该文件。

本轮没有修改 Session/Timeline 产品源码，不触发会话性能基线要求。没有修改公开协议，不需要生成 SDK。FUP-01 自动验证通过；FUP-02 自动验证通过、两套真实页面待验收；历史项保持原状态。

### 本轮交付源码与测试摘要

| 文件 | SHA256 |
| --- | --- |
| packages/core/src/scheduled-task.ts | FDC4AD254520A4A5CDD14E48BD2A28BC24208ACFCDCFEAA53AB3F57B405A8CFE |
| packages/core/test/scheduled-task.test.ts | 4DCC41B2DB7C3117E37AB7B1258BF8594D0D49685B103C8F76330B9773193FBF |
| packages/app/src/hooks/use-relay-settings.ts | D5717570496AC267D9F89301E7C0129FF1E6E66C0E0EB32FC58FAD642B915BE4 |
| packages/app/src/components/settings-providers.tsx | 2D940478A1A322F3D2FBE149957F6CC08D24432937463129DC634E03C616A647 |
| packages/app/src/components/settings-v2/providers.tsx | 5237BFCF053B338FBA6D76848BAB699A31D4E73646BF5232BE25894D7D4F6030 |
| packages/app/test-browser/relay-settings-state.test.ts | 693FAEB1D4BB29B79C94EE1A96E51F2AB402B839F880FBF3067B9390FE3182F6 |
| packages/app/test-browser/relay-settings-lifecycle.test.ts | 93BDF10A5F3286C8029C00074A0329ED4E65A4141572D77757AF39042E602E55 |
| packages/app/test-browser/relay-settings-busy.test.ts | 55192D4ADC483A74AB64F86E9EDEF3CDFD72A6466C9F6CF9A5327F0FC5CD06A4 |

## 7. 后续真实页面验收（2026-11-13）

第 1～6 节的“界面待验收”为补验前快照。FUP-02 已在主工作区两套布局完成并发刷新和关闭重开验收，现代布局另通过实际服务器选择器的旧回包隔离。最终 9 passed、0 failed、0 skipped，退出码 0；Relay E2E 类型检查退出码 0。FUP-02 可按上述本机页面范围验收关闭。历史完整 UI、经典布局全局切服务器、R3-03B、RF-07 与目标打包产物不扩大关闭。

详见 [FUP-02 页面验收记录](D:/opencode/specs/followup-ui-acceptance-2026-11-13.md)，其中保留首次脚本失败、合法版本冲突的断言修正、最终 trace 和截图。没有修改业务源码，没有提交或重启原有应用，测试服务已清理。
