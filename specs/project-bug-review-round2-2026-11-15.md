# 项目第二轮扩展复查（2026-11-15）

## 结论

本轮新增确认 2 项 P2 缺陷。此前确认的 5 项对应源码未变化，保留未修复状态；当前这些复查范围累计 7 项确认未修复。不将未执行的页面/跨平台验证计为新增 bug。

本轮只读取产品代码并运行临时隔离探针，新增本报告。没有修改产品代码、提交、重启用户应用、访问生产数据或调用系统凭据库。

## SECRET-CANCEL-01 / P2：取消保存后，晚到系统凭据写入留下孤立凭据

位置：`packages/core/src/relay-secret-store.ts:168`、`:169`；`packages/core/src/relay-auth.ts:438`、`:456`、`:487`。

### 触发和证据

使用真实 RelayAuth、RelaySecretStore.makeLayer，以及可控的内存 SystemSecrets 适配器。文件与锁均使用独立临时根。

1. 创建已有假密钥的供应商。
2. 启动更换密钥，产品先持久化 preparing 引用，再调用适配器 set。
3. 适配器收到 set 后挂起，尚未写入。中断正在等待 setVendor 的 Effect fiber。
4. 中断已结束，产品恢复清理调用 delete 并删除 preparing 记录，此时 set Promise 仍未完成。
5. 放行 set，适配器真正写入新凭据。
6. 再执行一次真实普通保存，验证后续 recoverPreparing 也无法发现该引用。

结果：

- removedBeforeCompletion=true：删除早于写入完成。
- journalAfterCancel=false：中断收尾已删除 preparing 记录。
- lateSecretPresent=true，activeRefIsLate=false：晚到凭据存在，但当前配置没有引用它。
- activeKey=fake-original，secretCount=2：旧密钥仍有效，另有一个无主的新密钥。
- 后续普通保存完成，孤立引用仍保留。

正常对照：同一挂起 set 在不中断时放行并等待 setVendor 完成，activeRefIsLate=true、secretCount=1；新凭据正常被引用，旧凭据被移除。

本轮没有调用 Bun.secrets。适配器验证的是 SystemSecrets Promise 合法的异步生命周期，与操作系统实现的实际延迟无关；尚未做平台原生凭据库验收。

### 根因

Effect.tryPromise 的等待可被取消，且当前 SystemSecrets.set 没有取消契约。取消等待不能终止已经投递的写入，但外层 ensuring 立即执行 recoverPreparing。delete 在 set 真正完成前返回“不存在”，恢复记录被移除，晚到写入失去后续清理责任。

### 修复要求

- 从凭据写入投递起持有其生命周期责任。取消到来后，先等底层 set 完成，再按配置是否已经引用该 ref 决定清理。
- 对不支持取消的系统 API，投递至完成的等待必须有明确收尾策略；不能把取消视为写入失败或删除成功。
- 在已投递操作结束且引用清理完成前，不移除 preparing 记录，也不提前释放保护它的业务所有权。
- 不能仅在一个 detached 回调中删除引用；需要保证作用域退出、重启恢复和失败时责任仍可追踪。
- 回归覆盖投递前取消、投递后成功/拒绝、取消与完成同刻、清理失败、后续初始化恢复、同名实体重建，且不让清理移除仍在用的引用。

## TASK-ERROR-01 / P2：可重试的上游限流被当成项目无效并停用每日任务

位置：`packages/core/src/scheduled-task.ts:354`、`:370`、`:379`、`:385`。

### 触发和证据

真实 ScheduledTaskStore、临时 SQLite、真实任务状态流，复用仓库 recordingSession 测试适配器。项目 resolve 返回有效项目；Session.resume 在本样本中返回真实 LLMError 类型及 RateLimitReason，retryable=true、retryAfterMs=1000。未请求外部供应商。

1. 创建已启用的每日任务，下一次时间位于未来，避免自动轮询与本次手动样本交叉。
2. 调用真实 runNow，正常创建会话并接纳 prompt。
3. 在 resume 边界返回上述可重试限流错误。
4. 读取运行记录与任务启用状态。

结果：上游 retryable=true；运行 failed，但 error.code=PROJECT_INVALID、error.retryable=false；任务 enabledAfter=false。项目本身始终有效。正常 resume 对照为 completed，任务 enabledAfter=true。

类型链已核对：SessionRunner.RunError 包含 LLMError，runner 的失败流会沿 failCause 返回，SessionExecution 和 Session.resume 不将此类失败改成项目错误。所以该边界符合产品可到达的错误契约。本轮未从真实 HTTP 429 跑完整模型调用。

### 根因

fail() 只识别 error.info.code 或 ScheduledTask.Paused。LLMError 使用 reason，不满足这两种形状，于是默认 PROJECT_INVALID；后面的条件把该默认分类视为永久前置条件失效，调用 disable，取消后续调度。

### 修复要求

- 显式区分项目/模型/密钥前置条件错误与上游执行错误。未知执行错误不能默认分类为 PROJECT_INVALID 并停用。
- 将 LLMError.reason 与 retryable 映射到已有合适公开错误；必要时按协议规范扩展错误类型并生成客户端。
- 本次运行可以终结为 failed，但临时错误应保留原 enabled 和后续计划，不因此自动立即重放已接纳 prompt 或工具副作用。
- 永久项目不存在、模型不可用、密钥缺失的既有停用规则要保留并用对照验证。
- 补 RateLimit、Transport、ProviderInternal、真正项目错误、未知错误的任务/运行/事件/磁盘对账。是否自动重试本次执行需单独明确策略，不能混入本修复。

## 此前五项状态

| 编号 | 优先级 | 状态 |
| --- | --- | --- |
| OBS-01 | P1 | 名称保存后旧模型刷新冲突，无最新补刷；未修复 |
| ACC-F02 | P1 | 项目保存与加载文件不一致；未修复 |
| AUTH-REPLAY-01 | P2 | 清理回执被兼容删除误认为成功；未修复 |
| UI-VIS-01 | P2 | 名称回包使已提交模型勾选丢失同步；未修复 |
| SECRET-SCHEMA-01 | P2 | 凭据结构错误绕过 typed 错误并带原文诊断；未修复 |

前次证据见 `specs/acc-followup-bug-review-2026-11-15.md` 和 `specs/project-bug-review-2026-11-15.md`。没有重复跑旧样本或把旧结果标为本轮新执行。

## 基线与证据

HEAD：6b051f12a21094df1adef83f9fddfcbb765b319e。阶段 A 登记的 36 个文件摘要未漂移；前次扩展复查的 settings hook、secret store、scheduled task 三个文件摘要也未漂移；Git index 摘要保持不变。

证据根：`C:\Users\zh2100\AppData\Local\Temp\project-review-next-0f18d33689f14f36b97441eeaecb6cba`。

- `baseline.json`、`final-source-check.json`：基线核对。
- `isolate.ps1`：在产品模块加载前隔离 home、XDG、TEMP/TMP、数据库并清理继承覆盖。
- `secret-cancel-probe.ts`、`secret-cancel-probe.log`、`secret-cancel/result.json`。
- `secret-control.ts`、`secret-control.log`、`secret-control/result.json`。
- `task-error-probe.ts`、`task-error-probe.log`、`task/result.json`。
- `task-control.ts`、`task-control.log`、`task-control/result.json`。

四个脚本退出码均为 0，表示复现/对照执行结束；其中两个观测到缺陷，不能将其计为产品修复测试通过。调度探针的 Session 适配器源码取自现有测试 helper，实际服务与数据库使用产品实现。

本轮未修改产品源码，未重复全量测试或类型检查。完整页面、RF-07 跨平台和 R3-03B 产品迁移/打包等未关闭项保持原状态。调度停用与推进之间的其他并发边界未完成确定性复现，本轮不额外列为已确认缺陷。累计七项仅表示这些复查已确认的问题，不代表项目不存在其他缺陷。
