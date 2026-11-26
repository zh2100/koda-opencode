# 目录与设置再次审查 — 2026-11-13

本轮只检查并更新方案，没有修改业务代码、提交、重启应用或操作生产数据。以当前未提交实现为基线，复验 RV-01～RV-03，并检查认证提交、HTTP 确认、删除重试和实际模型消费者；确认共 6 项未修复缺陷，其中 RV-04～RV-06 是本轮新增的独立复现记录。RV-04 的风险曾在旧方案中提及，本次补齐具体失败出口与真实 HTTP 证据，不把它说成首次发现这个风险。

本报告不声明检查了工作区所有未提交文件。历史通过证据保留；R3-03B、RF-07 跨平台、历史完整界面验收保持原状态，不把未验收直接算成新缺陷。后续实施按[修复方法与回归矩阵](D:/opencode/specs/bug-fix-workflow-and-regression-matrix-2026-11-13.md)及[总方案](D:/opencode/specs/all-bugs-fix-implementation-plan-2026-11-12.md)。

## 1. 当前缺陷清单

| 编号/优先级 | 影响 | 本轮结论与位置 |
| --- | --- | --- |
| RV-01 / P2 | 清 key 或同 ID 重建后，旧 probe 仍显示连接成功 | 复现仍在；[成功出口](D:/opencode/packages/core/src/relay-catalog.ts:598)没有 HTTP 后身份核验；真实 HTTP 返回 200/count=1 |
| RV-02 / P2 | 模型刷新已经提交，却被无须执行的清理报成失败 | 复现仍在；[额外清理](D:/opencode/packages/core/src/relay-catalog.ts:676)又等待 auth 锁，2 秒后报 refresh cleanup；磁盘已有新模型且自身 token 缺失 |
| RV-03 / P2 | 清 key 已成功，但旧 ACK 被拒收时原密钥草稿残留，可被下一次保存重交 | 复现仍在；[清密钥收尾](D:/opencode/packages/app/src/hooks/use-relay-settings.ts:842)将草稿确认绑定于整份 Auth 接纳 |
| RV-04 / P2 | 保存、清 key、删除已经提交，后续目录同步失败却返回一般 503，调用者无法区分提交结果 | 新增真实 HTTP 证据；[保存](D:/opencode/packages/server/src/handlers/relay.ts:47)、[清 key](D:/opencode/packages/server/src/handlers/relay.ts:61)、[删除](D:/opencode/packages/server/src/handlers/relay.ts:75)均有相同出口 |
| RV-05 / P2 | 受身份保护的删除原样重试返回 409，已提交结果无法幂等确认 | 新增 Core/HTTP 证据；[删除](D:/opencode/packages/core/src/relay-auth.ts:621)先核验已不存在实体，再调用 replay |
| RV-06 / P2 | 一次目录同步失败导致插件退出订阅，恢复后模型列表仍不再更新 | 新增真实插件证据；[事件处理](D:/opencode/packages/core/src/plugin/provider/leidiandonghua.ts:28)让单次处理失败终止整个 Stream.runForEach |

RV-01～RV-03 的完整根因沿用[上一轮复核](D:/opencode/specs/relay-followup-bug-review-2026-11-13.md)，本轮没有重复编号或覆盖其证据。

## 2. RV-04：认证已提交与目录同步失败混为一个失败

复现使用实际 webHandler、文件凭据后端和隔离数据：先成功创建供应商并建立服务；随后仅把测试目录文件改为非法 JSON，再通过真实 HTTP 分别保存名称、清 key、删除供应商。每个用例结束恢复夹具文件状态并释放服务。

三种请求均返回 HTTP 503，message=SECRET_STORE_UNAVAILABLE、service=secret-store。但紧接着真实 GET auth 能读到已提交结果：名称已更改、hasKey=false，或供应商已不存在；auth revision 各自只推进一次。故障实际来自目录同步，并非三笔认证事务没有提交。

正常对照：同样三种操作在无目录故障时均返回 200；真正的认证 revision 冲突仍返回 409、磁盘配置不变。没有将“任何失败都应成功”作为断言。

根因是 Handler 中 auth.mutate → Effect.tap(catalog.syncVendors) → mapError 将两个完成阶段合并。认证提交成功后缺少可交给客户端的“已保存、目录待刷新”结果。目录读取损坏被映射为 secret-store 错误也让失败阶段不透明。

修改方向：区分认证提交和目录接纳。未提交仍返回原错误；确认已提交但目录接纳失败，返回提交确认与明确的待同步状态，客户端只重试 models.sync，不再次写认证。不能只加 Effect.ignore 后把完整页面标成成功；也不能回滚已提交凭据或绕过损坏文档读取保护。此项需要公开状态、生成客户端和真实页面的配套修改，详见实施方法 S6。

## 3. RV-05：删除自己的前置条件使原样重试失效

复现：创建供应商后，以其 entityId、当前 revision 和固定 operationId 发 DELETE，首次 200；原样再次发送完全相同的 payload，实际得到 HTTP 409 REQUEST_CONFLICT。同一个真实 Auth 服务的 Core 调用也复现。期间没有其他写入，revision 保持首次删除后的值。

对照：不携带 expectedEntityId 的旧调用可以命中 replay 并成功。现有“幂等删除”回归使用了这条旧路径，没有证明新版受保护请求能够重试。

根因：requireEntity 在 replay 前执行。第一次删除后实体已不存在，第二次必然在进入缓存或 pendingCleanup 处理前失败。该保护应拒绝操作后继实体，但不能拒绝对已提交旧命令的精确确认。

修改方向：区分“执行新删除”与“确认已提交删除”。仅在操作类型、供应商、原 entityId、原请求 revision 和 operationId 精确匹配已有提交记录时允许确认/补原清理；否则继续正常身份和 revision 核验。不能把通用 replay 无条件移到 requireEntity 前，也不能去掉 expectedEntityId。

本轮证据只证明同一服务存活期间的原样重试缺陷，不自动扩展为所有认证命令的跨进程、跨重启永久幂等承诺。旧待清理记录没有操作归属元数据，不能凭 operationId 猜测其实体。S5 单列保证范围、记录绑定、清理与重建对照。

## 4. RV-06：发布成功不等于消费者处理成功

复现执行真实 LeidiandonghuaPlugin.effect、PluginHost、Catalog、EventV2 和 RelayCatalog。实际 setVisibility 提交产生更新事件；仅在插件第一次 syncVendors 的调用边界暂时写入损坏目录，使用真实读取产生错误，并在该次调用收尾恢复原文件。之后再实际提交第二个模型更新，等待消费者模型目录出现该模型。

正常对照没有故障，两次事件处理均进入 syncVendors，第二个模型可见。故障样本仅进入一次，第二个更新虽已提交，插件模型仍不存在；有界等待失败。

根因：Stream.runForEach 的回调直接返回 sync/reload 错误，forkScoped 子纤程失败后整个订阅结束。RelayCatalog 的通知成功只证明事件发布进入总线，不代表插件已经处理；发布端 pending 已清，单独恢复文件也不会重建死掉的订阅。

修改方向：在单次事件处理内保留非中断失败和有限重试，保持订阅接收后续事件；保留未处理最新代次，不让旧重试清除新责任。耗尽后允许新事件或显式 Retry refresh 触发恢复；明确补齐“发布端 idle 但消费者之前失败”的显式重新通知路径。普通读取/自动同步仍不发布无变化事件，服务退出仍保持中断并停止重试。不得靠永久忽略错误、无限高速重试或重启应用修复。

## 5. 隔离证据、夹具错误与范围

证据根：C:/relay-reaudit-20261113-01。源码执行根：C:/obf-20261112；Bun 1.4.3，Windows。每个包使用本轮独立 home/data/config/state/cache/managed/tmp；内存 DB、假凭据、本地或注入的上游。关键实现的主副本摘要逐字节一致，见 source-hashes.json、source-hashes-final.json，包含认证/目录/凭据、App hook、Schema/Protocol/Handler，最终另核对真实插件文件。

| 验证 | 结果 | 日志（相对证据根） |
| --- | --- | --- |
| 旧 Core 缺陷复验 | 1 pass / 3 fail，退出码 1 | core/logs/prior-core.log |
| 旧 App 缺陷复验 | 1 pass / 1 fail，退出码 1 | app/logs/prior-app.log |
| 旧真实 HTTP probe | 0 pass / 1 fail，退出码 1 | server/logs/prior-http.log |
| 新删除重试 Core | 1 pass / 1 fail，退出码 1 | core/logs/new-core.log |
| 新 HTTP，含三种无故障操作及真正未提交的冲突对照 | 4 pass / 4 fail，退出码 1 | server/logs/new-server-final-controls.log |
| 真实插件故障恢复与正常对照 | 1 pass / 1 fail，退出码 1 | core/logs/plugin-recovery-fixture-corrected.log |

以上 fail 是“期望正确行为”的断言失败，属于缺陷证据，不是已修复；多次运行和同一缺陷的不同变体不能相加当成独立缺陷数。

保留两类初版夹具错误：新 HTTP 初版假定空目录必有目录文件，触发 ENOENT；已改成按原先有无文件恢复，再得到三个已提交却返回 503 的产品失败。插件初版未从测试 Layer 导出 Event 服务，触发 Service not found；修正后正常对照通过、故障样本失败。这两次初版失败不计为产品缺陷，原日志未覆盖。

新增诊断仅在隔离副本，分别为 Core 的 relay-reaudit-review-20261113.test.ts、relay-plugin-reaudit-20261113.test.ts 和 Server 的 relay-reaudit-review-20261113.test.ts。执行命令使用证据根 run.ps1；迁入正式套件后应停止包内重复临时样本。没有执行完整联合回归、类型检查或真实页面，因此不能引用历史通过结果声称本轮六项已验收。

本轮所有测试命令已退出；测试创建的上游、作用域和服务由夹具收尾。主工作区业务文件和暂存区保持原状。方案更新只涉及本报告、总实施方案及修复方法矩阵。
