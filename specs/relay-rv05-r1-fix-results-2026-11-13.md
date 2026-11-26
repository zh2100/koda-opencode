# RV-05-R1 补修结果（2026-11-13）

结论：RV-05-R1 已补修，并通过本机自动验证。新建供应商在任何回执密钥、供应商密钥或配置写入前，拒绝复用本服务已提交删除的 operationId。取消后和清理失败后的待清理责任均可保留，原样删除重试能够完成清理。该结论不扩大到历史界面、跨平台和迁移待验收项。

## 1. 实现与边界

- `packages/core/src/relay-auth.ts:520`：在 createOnly 必须提供操作编号的检查后，立即检查 deletedCommands。发现已属于删除命令的编号时返回 REQUEST_CONFLICT。
- 创建回执的原样重试、正常新编号创建、精确删除确认及后继实体保护保留。没有把通用 replay 的返回结果当作创建确认，没有扩大不可取消区域。
- 删除确认仍限同一服务生命周期；没有增加跨进程或重启后的永久确认承诺。公开契约及 SDK 无变化，无需重新生成。

## 2. 新增正式回归

`packages/core/test/relay-delete-replay.test.ts:277` 增加四个场景，覆盖两种删除状态（实际 rename 后取消、系统凭据清理失败）和两种碰撞目标（同 ID、另一 ID）。使用真实认证提交与实际 rename 屏障，凭据删除失败通过受控系统适配器触发；原文件凭据后端回归继续保留。

每个场景验证：

1. 同一删除 operationId 的 createOnly 返回 REQUEST_CONFLICT。
2. Auth revision、供应商状态、认证文件原文及凭据集合不变，原 pendingCleanup 引用保留；不会创建回执密钥文件。
3. 恢复删除能力后，原样重试原删除能够清掉旧凭据及待清理记录，不增加 revision。
4. 全新 operationId 可以创建供应商；原样重试新建保留原回执和 revision。
5. 再次原样重试旧删除不会改变新实体、配置或新凭据。

`packages/server/test/relay-commit-handler.test.ts:168` 扩展真实 HTTP 回归：同 ID/不同 ID 的碰撞均返回 409 REQUEST_CONFLICT，配置和回执文件不变，错误不包含测试密钥。使用新编号创建及原样重试后，旧删除确认仍保护后继实体。

修复前正式新增样本实际失败：取消场景错误放行；清理失败场景虽被旧 cached 检查拒绝，但已创建回执密钥文件。因此本次检查位于新建分支入口，不能只补在旧 cached 检查旁。

## 3. 关联测试时序修正

首次联合回归为 60 pass / 1 fail。B118 的创建回执竞争者在确认后单独调用 resolve；另一进程可以在两次操作之间合法删除供应商，此时 KEY_MISSING 是正确结果，夹具却把它当成创建确认失败。

补修前主目录对照重复三次也得到 2 pass / 1 fail，同样为 KEY_MISSING；补修版本未改夹具时三次通过。此证据说明旧夹具依赖不稳定时序，不能只依靠重跑通过。

处理仅限测试：

- `packages/core/test/fixture/relay-writer.ts:84` 增加明确的 create-receipt-racing-delete 模式，执行同一个真实创建确认，不再额外假设确认后凭据仍存在。普通 create-receipt 模式继续执行 resolve，并保留非竞争场景的凭据验证。
- `packages/core/test/relay-cross-process.test.ts:155` 使用竞争确认模式，保留原回执、实体、revision 与不得重建的断言，并新增删除完成后文件凭据为空的断言。
- 修正后同一真实竞争连续三次通过；最终完整交付回归也通过。没有修改生产 resolve、忽略产品错误或放宽删除后数据断言。

## 4. 实际验证结果

证据根：`C:/relay-rv05-r1-fix-20261113`。源码先在 `C:/obf-20261112` 验证，再逐文件交付至 `D:/opencode`。各包独立 home/data/config/state/cache/managed/tmp，内存数据库及测试凭据，不使用生产数据。

| 验证 | 实际结果 | 日志（相对证据根） |
| --- | --- | --- |
| 正式删除套件，修复前 | 6 pass / 4 fail，退出码 1 | core/logs/red-delete.log |
| 正式删除套件，补修后 | 10 pass / 0 fail，退出码 0 | core/logs/green-delete.log |
| 初次 Core 联合，保留失败 | 60 pass / 1 fail，退出码 1 | core/logs/core-regressions.log |
| 未补修主目录的旧竞争夹具对照 | 2 pass / 1 fail，退出码 1 | core/logs/baseline-cross-process-race.log |
| 补修代码但旧夹具的对照 | 3 pass / 0 fail，退出码 0 | core/logs/fixed-cross-process-race.log |
| 修正竞争夹具后连续三次 | 3 pass / 0 fail，退出码 0 | core/logs/cross-process-fixture-fixed.log |
| 实际交付目录 Core，认证/创建/删除/取消/跨进程/完成边界 | 61 pass / 0 fail，411 断言，退出码 0 | core/logs/delivery-core-regressions.log |
| 实际交付目录 Server 真实 HTTP | 8 pass / 0 fail，102 断言，退出码 0 | server/logs/delivery-http-regressions.log |
| 实际交付目录 Core、Server 完整 bun typecheck | 均退出码 0 | core/logs/delivery-core-typecheck.log、server/logs/delivery-server-typecheck.log |

Core 与 Server 在隔离源码的首次类型检查也通过。最终使用 CLI 单项测试上限 15000ms，测试内部的取消/同步屏障及原显式超时未放宽。不同批次有重复样本，不累计成去重用例数。目标五文件 Prettier 检查和 git diff --check 通过。

交付前逐文件比较主目录原摘要；交付后五个代码/测试文件与已验证源码摘要一致，不匹配 0，见 `delivered-files.json`。只交付这五个文件，并新增本结果、给两份历史报告追加最新状态；没有覆盖其他未提交改动，没有创建源码备份。

本轮没有提交、推送、重启应用或操作生产配置/凭据/锁/迁移标记。没有重新执行界面、跨平台、已安装包和真实迁移验收；R3-03B、RF-07 及历史 UI 待验收状态不变。本次补修防止清理责任继续丢失，不代表扫描或修复了生产中的历史孤立凭据。
