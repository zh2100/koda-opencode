# Bug 修复实施结果 — 2026-11-12

对应方案：[Bug 修复详细实施方案](D:/opencode/specs/all-bugs-fix-implementation-plan-2026-11-12.md)。

**BF-01～BF-05 的实现已落地，相关自动回归通过，并完成两套布局的部分真实界面验收；不等于全部历史 Bug 或方案全部验收矩阵关闭。** 原方案保持为实施依据，未将其中的待验收项目批量改为完成。

未提交、未暂存、未推送、未改版本。未重启当前应用；只启动并停止本轮隔离实例。没有写生产配置、系统凭据、锁或迁移标记，没有启用迁移 apply。

## 1. 本轮修复与根因

| 编号 | 根因 | 当前实现 |
| --- | --- | --- |
| BF-01 | 新增在初始读取前选 ID，服务端又允许更新同 ID；实例 Map 无法确认另一进程已提交的创建 | 读取有效认证状态后选 ID，发送 createOnly；锁内先核验持久化 receipt、revision 和冲突，再写凭据；丢响应后原命令可跨进程确认，不重建后继实体 |
| B0 / BF-03 | ID、URL 和供应商 revision 不能证明删除重建后仍为原实体；只保护回写，未保护后续发送 | auth 初始化锁内补齐并持久化 entityId；所有新客户端保护动作携带期望身份；probe/refresh 同时核验供应商 revision；旧实体在发送前或服务端入口被拒绝 |
| BF-02 | 全量快照接纳与保存命令确认共用一个判断，规范化值产生伪冲突，也可能覆盖保存期间的新输入 | 将成功 ACK 的提交确认与权威快照接纳分开；按字段命令与编辑代次保护输入，旧成功不回退新 auth；清密钥同样保护改出又改回的输入 |
| BF-04 | 事务仅在本次写磁盘时安装内存；客户端发送顺序又被误当作目录版本 | 独立判断磁盘提交、内存安装、身份失效与外部投影变化；真实 POST /api/relay/models/sync 原子捕获 auth、目录与版本；逐供应商、逐阶段接纳，并保留空结果水位 |
| BF-05 | 通知使用目录版本作为身份，零版本/同版本变化及失败耗尽会丢责任 | 使用服务作用域内的独立通知序号；旧完成不清新责任；耗尽保留责任；显式 retryNotice 恢复，普通同步不重置预算 |

两套供应商页已增加正常“重新加载设置”入口，直接调用实际 sync 接口；不必先制造错误才能刷新。旧服务器缺少保护能力时保留只读显示，并禁用相应写入。初始能力读取期间仍允许输入，实际写入须通过协商和身份核验。

## 2. 实施复核补出的边界

1. **同一响应的新实体目录被自身失效误拦截。** 在安装响应携带的身份变化之前记录本地保护资格；只放行该响应自身的合法身份转换，不放开请求期间已经发生的本地修改。先保留失败，再修复，对应 C113 页面状态回归由红转绿。
2. **目录行缺少持久化实体归属。** 新目录写事务保存 vendorEntities；在同步、刷新和勾选共用的事务入口淘汰退休实体的候选、勾选及请求预留。其他进程已为新实体提交的目录保留，不再按本进程的旧 auth 猜归属。两个失败对照修复后通过。
3. **运行期间私有签名键丢失。** 存在创建记录时，运行中的认证读取/写边界也核验私有键；不能借 rollback 丢弃记录或继续提交不可确认的状态。
4. **清密钥期间的同值新输入。** 不再只比较字符串相等，同时核对编辑代次，保留用户改出又改回的新输入。
5. **回滚取消的临时文件收尾。** 取消专项确认：临时文件已移动后，再删除不存在的旧路径可能让最终原因变成 NotFound。临时文件删除改为 force: true；仍断言取消原因、旧配置与原凭据完整，并重建服务确认原 receipt。真实回滚进程与创建确认进程竞争后，也不丢 receipt、不复活已删除供应商。

历史目录没有 vendorEntities 时，不在纯读取时额外写一次文件；下一次真实内容提交补齐归属。新字段不是对不兼容旧版本混写同根的支持承诺。

## 3. 新增持久化资源及公开契约

| 数据根内资源 | 内容与约束 |
| --- | --- |
| relay-auth.json | 稳定 entityId 与 creationReceipts；创建和 receipt 同次原子提交；清理、普通认证写入和 rollback 保留元数据 |
| relay-auth-receipt-key.json | 随机私有 HMAC 键，原子写入、mode 0600；不进入公开响应、日志或普通配置备份；存在 receipt 时缺失/损坏即失败，不重新生成来忘记旧记录 |
| relay-auth-preparing.json / relay-secrets.json | 沿用已有准备日志与凭据事务；隔离测试只使用文件或内存后端，未调用真实系统凭据写入 |
| relay-catalog.json | 保留 catalogRevision 是否存在，并在真实提交时持久化相关行的 vendorEntities；只读同步不为刷新缓存增加版本 |

以上私有键、receipt 和实体身份都应纳入后续 R3-03B 的数据根迁移资源盘点。当前 ResourceRoot 不维护逐文件迁移清单，本轮没有为此启用迁移。

新创建记录默认容量 10,000，可由 OPENCODE_RELAY_RECEIPT_LIMIT 配置；不自动淘汰。达到上限拒绝新创建，原样重试仍能确认。指纹采用私有 HMAC，覆盖完整创建命令；内部指纹、keyRef 和私有键不进入 AuthState。

AuthState 返回实际能力、实体身份和本次可选 operationReceipt；新增 sync 返回 auth/candidates/managed/catalogRevision/notice.status。catalogRevision 的 null 表示历史缺少版本，真实 0 保持为 0。生成 Promise/Effect 客户端均已更新，重复生成产物摘要一致，没有手改生成文件。

通知是本实例服务作用域内的有限重试责任，不是持久化 outbox，不承诺进程崩溃后恢复原投递责任。

## 4. 自动验证证据

证据根：`C:/Users/zh2100/AppData/Local/Temp/opencode-bf-implementation-20261112`。日志位于其 logs/，完整命令与隔离变量见 scripts/run.ps1。测试从对应包目录执行，未从仓库根运行。

| 验证 | 结果 | 日志 |
| --- | --- | --- |
| 修复前 App 五项诊断 | 2 pass / 3 fail，BF-01/02/03 正确失败 | baseline-app.log |
| 修复前 Core 三项诊断 | 1 pass / 2 fail，BF-04/05 正确失败 | baseline-core.log |
| 补查实体接纳与目录归属 | App 1 fail、Core 2 fail；修复后对应回归通过 | app-replacement-red.log、core-replacement-red.log、app-protocol-3.log、core-transactions-2.log |
| 设置状态、草稿、生命周期、新协议 | 92 pass / 0 fail，467 assertions，exit 0 | app-settings-complete.log |
| 历史同步、文件树、持久化及 i18n | 122 pass / 0 fail，exit 0；新增重新加载文案后单独复跑 i18n | app-history-final.log、app-i18n-delivery.log |
| 认证/目录/凭据/真实进程最终联合回归 | 87 pass / 0 fail，548 assertions，exit 0；含新增三项 B118 回归 | core-relay-delivery-complete.log |
| 创建、全入口保留、损坏元数据专项 | 15 pass / 0 fail，exit 0；与联合批次重叠，不累计 | core-create-metadata-final.log |
| 真实进程初始化/竞争/崩溃/丢响应 | 先前专项 5 pass / 0 fail，exit 0；两个进程初始化身份一致；新增真实回滚竞争在最终联合批次通过 | core-cross-process-final.log、core-relay-delivery-complete.log |
| 调度、真实授权 runner、附件 | 61 pass / 0 fail，exit 0 | core-history-final.log |
| 真实 Handler 与生成客户端 HTTP | 4 pass / 0 fail，exit 0；含子进程提交及读取/投递乱序 | server-http-final.log |
| Promise / Effect 客户端契约 | 14 pass / 0 fail，exit 0 | client-contract-2.log |
| Core、App、Schema、Protocol、Server、Client、OpenCode 类型检查 | 七个包 exit 0；Core/App 后续增补再查 exit 0 | *-typecheck-complete.log、core-typecheck-delivery.log、app-typecheck-delivery.log；最终 Core：core-typecheck-complete-final.log |
| 新增真实页面测试类型检查 | exit 0 | app-e2e-typecheck-delivery.log |
| 客户端再生成 | exit 0；源目录与重复生成全部摘要相同 | client-generate-final.log |

重要对照包括：无密钥副作用的 createOnly 碰撞；创建丢响应后另一真实进程原样确认；删除/重建、其他认证写入和 rollback 后仍确认原创建；损坏/重复身份、重复/越界 receipt、私有键缺失或损坏失败且不改写；迟到 ACK、同值新输入、分片/空结果/历史 null、代次切换与通知耗尽恢复。

验证过程中发现并处理的失败全部保留：新增测试中的 Effect/PlatformError/fetch 类型不匹配；B118 取消测试误取 Fiber.interrupt 的 void 返回值，修正为等待 Fiber.await 后，又暴露并修复上述临时文件清理问题（core-rollback-boundaries.log、core-rollback-cause.log、core-rollback-cleanup.log）；隔离依赖混入原仓库 Plugin/SDK 类型身份；首次导航等待 load 超时；页面复选框误点隐藏原生 input 被遮挡。没有通过移除断言或强制点击掩盖产品路径。修复后使用用户可见模型标签触发真实请求。

## 5. 本机真实界面验收范围

Windows 11 build 26300、Node v24.19.0、Bun 1.4.3、Playwright 1.59.1 / Chromium。独立源码 `C:/obf-20261112`；前端 44444，两个实际后端 44096/44098，共享隔离 data；本地可控模型上游 44097。凭据使用隔离文件后端，数据库为内存。

最终 `ui-consistency-final.log`：**2 passed / 0 failed / 0 skipped，exit 0**。两例分别运行旧、新布局，均覆盖：

- 初始 auth 实际请求挂起时填写并新增同名供应商；放行后使用正确后缀，原供应商身份、地址和密钥状态不变。
- 实际请求进入 Handler/Core、真实拉取本地模型并勾选；另一个后端进程取消勾选后，点击页面正常重新加载接纳外部结果。
- 保存带空格名称、末尾斜杠地址后，界面展示规范化值，不遗留伪 dirty。
- 保存准备请求被边界暂挂，另一后端删除重建同 ID；旧身份收到 409，不发后续模型刷新；重新读取后新实体可以正常拉取模型，旧勾选不复活。

旧布局通过浏览器固定日期到停用日期前访问，未修改产品布局退役逻辑。测试没有拦截并伪造 Relay 成功结果，只在实际请求边界控制顺序。

测试源：[relay-settings-consistency.spec.ts](D:/opencode/packages/app/e2e/regression/relay-settings-consistency.spec.ts)。独立类型检查：从 packages/app 执行 `bun run typecheck:e2e:relay`。

实际执行命令、单独配置和服务启动脚本保存在证据目录；复跑必须显式设置 BF_RELAY_E2E=1、BF_RELAY_BACKEND=http://127.0.0.1:44096、BF_RELAY_EXTERNAL_BACKEND=http://127.0.0.1:44098，并启动对应隔离服务与前端。未显式启用时框架 skip，不能计作验收通过。也可使用现有 playwright.config.ts 配合 PLAYWRIGHT_PORT/PLAYWRIGHT_SERVER_PORT 指向同一隔离端口执行此 spec。

截图：证据根 ui-classic.png、ui-modern.png；trace 和 JSON 报告：ui-results/、ui-results.json。截图里的冲突 toast 来自测试有意验证的 409。最终正常拉取及勾选状态由断言核验。

本轮创建的两个后端和 Vite 已停止，四个隔离端口已释放；现有运行应用未操作。

## 6. 源码、工作区与未关闭范围

基线 HEAD：6b051f12a21094df1adef83f9fddfcbb765b319e，分支 dev。baseline-status.txt、baseline-hashes.json 与 final-status.txt 保留工作区证据。

37 个实现/生成文件的主仓库与隔离副本 SHA-256 全部一致，见 final-hashes.json。另比较了 6,834 个非本轮允许文件，无差异；32 个不在副本的文件均属于初始排除的 artifacts/。未暂存任何文件。允许清单含 App package.json 的单条新增 e2e 类型检查脚本，保留了其原有未提交内容。

国际化复用既有“重新加载设置/讀取最新設定”等术语；新增简繁文案核对 Microsoft vscode-loc 与 Mozilla firefox-l10n 的设置、删除、重新加载及更新提示，材料存证据根 i18n-corpus/。其他语言沿共享 typed i18n fallback；没有宣称完成全语言新增文案的人工翻译验收。

以下仍不关闭：

1. D3 完整 UI 矩阵：创建丢响应后跨实例原样确认的真实页面流程、完整迟到 ACK 三组编辑对照、通知 exhausted 后恢复的真实消费者/聊天模型流程、旧服务降级与双服务器页面切换等。已有状态/Core/HTTP 对照不能替代缺失的页面/插件验收。
2. OA-06、UI01～UI08 的其余历史页面项目，以及 MCP/macOS plutil、调度长暂停、图片附件实际交互等历史验收。
3. RF-07 的 Linux/macOS/root 与真实传输取消范围；本轮没有改变既有结论。
4. R3-03B 的生产资源迁移、旧版本隔离、目标产物和跨平台矩阵；没有启用 apply，也没有把新身份/receipt 协议当成旧版本混写已解决。

本轮交付状态是“代码已实施，已列自动检查及本机页面子集通过，完整关闭仍需上述专项证据”。本轮 34 个手写文件最终 Prettier 检查通过；37 个实现/生成文件的最终摘要已更新。
