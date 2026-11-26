# 已知缺陷与验收缺口汇总 — 2026-11-12

本报告按当前源码、隔离复现和各轮最新结果去重。**当前新确认未修复的产品缺陷共 5 项：1 项 P1、4 项 P2。** 另有 R3-03B 工程未完成，以及完整界面、跨平台和打包产物等验收缺口；这些不与 5 项已复现缺陷混合计数。

主仓库：D:/opencode，分支 dev，审查时 HEAD 为 `6b051f12a21094df1adef83f9fddfcbb765b319e`。审查包含大量未提交、未跟踪内容；工作区状态清单已归档。以下行号对应审查时源码，后续修改可能移动。

本轮只检查和记录，没有修改业务实现或主仓库测试，没有提交、推送、重启当前应用或服务器，也没有写生产配置、凭据或迁移标记。验证在 C:/ocdf-dc5c7401 与独立 home/XDG/managed/TEMP、内存数据库中进行。当前没有可调用的 CodeGraph 工具，实际使用源码检索、调用链、历史证据及隔离测试；不声称完成了 CodeGraph 索引分析。

## 一、当前确认未修复的产品缺陷

| 编号 | 优先级 | 缺陷 | 实际影响 | 当前状态 |
| --- | --- | --- | --- | --- |
| BF-01 | P1 | 初始加载前新增同名供应商使用旧命名决策 | “新增”可能更新原供应商，覆盖其地址和密钥 | 已隔离复现，未修 |
| BF-02 | P2 | 自身保存规范化后草稿仍被当成已编辑 | 后续刷新出现伪字段冲突，阻碍正常接纳远端更新或保存 | 已隔离复现，未修 |
| BF-03 | P2 | 已废弃连接测试仍向同 ID 后继供应商发请求 | 删除重建后，旧操作会测试新实体；阻止回写并未阻止请求发送 | 已隔离复现，未修 |
| BF-04 | P2 | 显式同步未接纳其他进程提交的目录版本 | 磁盘已有新模型/勾选，本进程列表仍旧，调用 syncVendors 也不能恢复 | 真实共享数据子进程复现，未修 |
| BF-05 | P2 | 身份失效通知被目录文件变更条件吞掉 | 清密钥等身份变化未通知依赖目录事件的消费者，目录/投影可能继续陈旧 | 真实认证服务与事件订阅复现，未修 |

### BF-01：首次加载前新增供应商可能覆盖已有供应商

**入口与位置**

- [addVendor](D:/opencode/packages/app/src/hooks/use-relay-settings.ts:557) 在第 561 行根据尚未取得的 auth 计算 ID，第 576 行才等待读取完成，之后没有重算 ID。
- [RelayAuth.setVendor](D:/opencode/packages/core/src/relay-auth.ts:505) 按 ID 存在与否选择更新或创建；第 526、528、529 行处理地址、名称和密钥。它没有独立的“只能创建”约束。
- 两套供应商设置页面的新增输入可在初始读取尚未完成时提交。

**复现与结果**

1. 服务器已有 ID 为 review 的供应商，地址为 old.example。
2. 挂起初始读取，在新增表单输入 Review、新地址、新测试密钥并提交。
3. 放行读取；返回已有 review 及当前 revision。
4. 正确请求应使用 review-2，保留原供应商。
5. 实际状态工厂仍发送 vendorId=review。结合真实后端的同 ID 更新分支，这会更新原供应商，而不是新增另一项。

诊断断言：预期 review-2，实际 review。作为对照，等初始读取完成再新增时，review-2 正确。

**根因**

决定 ID 的状态版本与提交所用 revision 不一致。后取到的最新 revision 给先前基于空列表做出的命名决策提供了合法写入条件。单靠修订号不能识别“新增却命中已有实体”。

**修复与关闭条件**

先取得并接纳有效 auth，再选择唯一 ID，并在发送前确认新增目标仍不存在。建议给服务端新增语义增加 create-only 防线；撞 ID 应冲突而不能覆盖已有项。若改变公开协议，应按仓库规范重新生成客户端。补首次读取挂起、同名、并发新增和已加载对照用例；确认原地址与密钥解析不变，再在两套设置页验收。

### BF-02：保存规范化后产生伪字段冲突

**入口与位置**

- [applyAuth 的 acknowledged 分支](D:/opencode/packages/app/src/hooks/use-relay-settings.ts:177)。
- [saveVendor 的 trim 与地址规范化](D:/opencode/packages/app/src/hooks/use-relay-settings.ts:516)。

**复现与结果**

1. 将名称改成带两侧空格的 ` Saved `，地址改成 `https://saved.example/v1/`。
2. 保存请求及 ACK 为规范化后的 Saved 和无末尾斜杠的地址。
3. 保存期间不继续输入。
4. 远端随后改成 Remote/remote 地址，本地重新加载。
5. 应直接接纳新值；实际得到 name、baseURL 两个冲突。

**根因**

ACK 推进 baseline，却无条件保留原始草稿字符串。因此“已提交但被规范化的值”仍与 baseline 不同，被当成未保存编辑。随后正常远端变更就触发伪冲突。

**修复与关闭条件**

ACK 同时携带提交前原始字段与实际补丁。当前草稿仍等于提交时原始值时，接纳规范化 ACK 并变为干净状态；请求期间有新输入时，保留新输入。补空格、末尾斜杠、保存中继续输入、远端后续修改及真实双方同时修改的对照，不能为消除伪冲突而破坏已有编辑保护。

### BF-03：旧连接测试向删除重建后的实体发出 probe

**入口与位置**

- [probe](D:/opencode/packages/app/src/hooks/use-relay-settings.ts:651)。
- 第 656 行等待 persistDraft 后，仅检查服务器/生命周期 active；第 658 行重新读取当前实体身份，第 660 行发送请求。
- [persistDraft](D:/opencode/packages/app/src/hooks/use-relay-settings.ts:636) 没有把保存废弃状态传给调用者。

**复现与结果**

1. review 的连接测试先执行保存；保存已提交为 revision 2，但响应挂起。
2. 重新读取该已提交状态，再删除为 revision 3，重建相同 ID、新地址的供应商为 revision 4。
3. 放行旧保存的 revision 2 回包。
4. 旧保存回包被丢弃，但 probe 继续读取后继实体身份并发送请求。
5. 预期 probe 次数 0，实际 1。整个上下文销毁时的对照则正确不发送。

该复现使用单调真实可达的修订顺序；不是用高版本旧回包冒充有效状态。前端状态工厂与可控 API 边界证实了错误发送，未用生产网络请求验证外部服务行为。

**根因**

归属校验只保护最终状态写回，没有保护异步等待后的下一步副作用。等待结束后重新采集 identity，反而把旧动作绑定到后继实体。persistDraft 的“没有继续保存”也被当成成功继续。

**修复与关闭条件**

在等待前捕获操作和实体代次，等待后仍是同一实体且保存有效才允许发送；让 persistDraft 明确返回有效、废弃或失败结果。补删除重建、权威快照消失、身份变化、销毁、正常连接测试，并检查请求次数而不只是最终 status。类似先保存再执行的调用一并检查。

### BF-04：磁盘新目录版本没有进入本进程内存

**入口与位置**

- [目录事务](D:/opencode/packages/core/src/relay-catalog.ts:369)。
- 第 369 行 contentChanged 比较最新磁盘和本次操作结果；第 372 行仅在本次写入变化或供应商身份变化时更新 snapshot。
- [candidates/managed 读取](D:/opencode/packages/core/src/relay-catalog.ts:406) 使用内存快照。
- [syncVendors](D:/opencode/packages/core/src/relay-catalog.ts:535)。

**复现与结果**

1. 父进程服务保持存活，managed 初始为空。
2. 实际子进程共享同一数据目录，用真实 setVisibility 写入 external-model 并退出。
3. 父进程显式执行 syncVendors。
4. 磁盘 managed 为 external-model，父进程 managed 仍为空。

这不只是“尚未做跨进程界面验收”：现在已确认连显式同步也无法接纳外部提交。

**根因**

“本次需要写磁盘”和“本进程需要接纳更新”被合成一个判断。若其他进程已写好目录，本次操作对最新磁盘不再产生差异；供应商身份又没变，就不会更新旧的本地 snapshot。

**修复与关闭条件**

分开磁盘提交、内存接纳和消费者通知。持锁读取到较新的 catalogRevision/内容后，即使本次无需再写，也要接纳最新快照；不得通过多写一次磁盘来掩盖读缓存问题。补长期存活双进程、无变化同步、candidates/managed/投影一致性与旧结果不得回退新版本的用例。

### BF-05：供应商身份失效事件丢失

**入口与位置**

- [syncVendors 的 identityChanged](D:/opencode/packages/core/src/relay-catalog.ts:548) 可以请求通知。
- [事务通知条件](D:/opencode/packages/core/src/relay-catalog.ts:386) 将通知收窄为 `result.notify && contentChanged`。
- [目录插件订阅](D:/opencode/packages/core/src/plugin/provider/leidiandonghua.ts:26) 依赖 CatalogUpdated 触发 reload。
- [前端事件消费者](D:/opencode/packages/app/src/context/server-sync.tsx:954) 也依赖目录事件。

**复现与结果**

1. 真实 RelayAuth 设置 chatgpt 测试密钥，执行同步。
2. 订阅真实 CatalogUpdated，再 setVisibility；确认收到第 1 次事件，证明订阅有效。
3. 真实 clearVendorKey，再执行 syncVendors；目录内容未变化。
4. 等待 1250ms，覆盖 1 秒通知重试周期。
5. 应收到身份失效通知，实际事件数仍为 1。

**根因**

目录内容变化与认证身份失效是两种独立原因，但事务只允许前者发布事件。内存供应商身份虽可更新，依赖事件的插件和前端未必获知。后续目录刷新偶然成功可能掩盖该问题，不能作为修复证明。

**修复与关闭条件**

身份失效应可独立通知；明确认证/目录版本参与通知去重和重试的规则。继续保证提交失败不发成功事件、中断不误报成功、已提交但通知失败可以重试。补换密钥、清密钥、改地址、删除、无可删除目录行及发布失败重试，再验证消费者实际重载。BF-04、BF-05 共享事务边界，但一个是内存接纳失败，一个是事件丢失，分别保留断言。

## 二、仍未完成的工程项：R3-03B

**整体保持未关闭，不把它描述成“尚无原生后端”。** Windows 原生后端、跨运行时租约和 NL-01/NL-02 已有分项验证，v1.0.6 分项关闭证据仍有效。

实际剩余工作：

1. [迁移脚本](D:/opencode/packages/core/script/migrate-lock-root.ts:3) 仅允许 plan；apply、resume、rollback 明确拒绝，真实离线迁移未接入。
2. 旧版本隔离、新资源根切换、完成标记和恢复流程还未构成可交付迁移闭环。不能与旧写入者混用新旧锁键。
3. 未知 owner、无法判定的锁及遗留 breaker 仍保守保留；需要受控离线诊断和恢复。**不应通过按年龄删除来强行关闭此项。**
4. Linux/macOS、Windows 符号链接、网络共享、已安装 Electron 与 Bun 单文件产物等目标仍缺对应环境的完整证据。

本轮未启用 apply，未切换生产目录，也未修改上述策略。

参考：[第三轮后续状态](D:/opencode/specs/round3/status-2026-11-09.md)、[v1.0.6 发布验收](D:/opencode/specs/round3/v1.0.6-release.md)、[最新锁修复结果](D:/opencode/specs/postfix-bug-fix-results-2026-11-12.md)。

## 三、待验收和验证缺口：不计为已证实的新产品缺陷

| 范围 | 尚缺证据 | 当前应如何表述 |
| --- | --- | --- |
| OA-06 / UI01～UI08 | 完整供应商/模型设置页、真实后端、两布局与多服务器矩阵 | OA-06 未关闭，且本轮 BF-01～03 说明剩余不只是 UI |
| 目录跨进程联动 | 长期运行客户端对外部配置/目录写入的完整刷新 | BF-04、BF-05 先修，再补整条链路验收 |
| RF-07 | Linux/macOS 非特权真实权限拒绝，root 真实 skip 统计，真实 HTTP 传输取消 | Windows 夹具生命周期修复与 ACL 通过保留；跨平台未关闭 |
| MCP 来源编辑 | 真实后端/多服务器/只读来源完整矩阵、macOS plutil | 局部 Chromium 组件和弹窗通过，不代表全部来源已验收 |
| 调度 | 真实长暂停恢复及完整交错验收 | TASK-001/002/004 已有自动证据，不再笼统写成完全未实现 |
| 附件、图片、历史同步 | 失败后的实际聊天交互，权限/队列/文件树完整 UI | 自动回归保留，页面路径按范围补验 |
| 工作树与性能 | 真实首条 shell 的 cwd；完整流式/标签页性能矩阵 | 已有自动证据不替代完整实际运行与性能验证 |
| 打包与凭据 | 已安装应用、目标运行时、系统凭据跨进程组合 | 不从源码/内存凭据样本外推所有发行产物 |

UI01～UI08 仍需覆盖：

1. 初始读取延迟时保存密钥。
2. 改地址、删除、重新加载与目录联动。
3. 双客户端模型勾选持久性。
4. 两套布局、双服务器无串台。
5. 同项目 B 排队期间被停用。
6. once 自动任务完成且不再调度。
7. 普通供应商任务不误走 Relay。
8. 超预算/损坏编码附件失败后，后续聊天正常。

RF-07 的夹具 T13 目前是无条件框架 skip，不能把它算成真实 POSIX/root 验证。受控请求回调取消也不能代替真实 HTTP 传输中断。

## 四、原始 26 项去重后的状态映射

“自动通过”表示对应已有修复/定向证据，不表示本轮重新执行了该项全部测试或完整界面验收。原始条目不会因后来出现新的边界缺陷而凭空增加一份重复计数；当前具体未修项按 BF 编号跟踪。

原始登记：[bug-audit-2026-11-06.md](D:/opencode/specs/bug-audit-2026-11-06.md)。实施及回归：[2026-11-07 实施结果](D:/opencode/specs/bug-fix-implementation-results-2026-11-07.md)。

| 原编号 | 原问题 | 最新合并状态 |
| --- | --- | --- |
| SET-001 | 模型可见性与聊天列表不同步 | 原路径有修复与自动证据；完整 UI 待验，新增目录读缓存/通知缺陷见 BF-04/05 |
| SET-002 | 供应商变更/删除后目录陈旧 | 已有失效和代次修复；身份独立通知缺口见 BF-05，不可整体关闭 |
| SET-003 | 连续勾选乱序覆盖 | 已有版本/分片保护与自动证据；双客户端 UI 待验 |
| SET-004 | 设置页服务器作用域串台 | 已有 scope/generation/操作票据保护；两布局 UI 待验 |
| SET-005 | MCP 初始化/编辑丢失字段 | 后续来源编辑、继承原文、冲突和刷新重试已补；局部浏览器通过，完整来源矩阵待验 |
| SET-006 | 配置并发丢失 | 新协议同根写事务已有跨进程证据；旧版本隔离与真实迁移归 R3-03B；目录读缓存另见 BF-04 |
| SET-007 | 密钥变更时旧目录覆盖 | 已有按供应商代次保护；身份通知仍有 BF-05 |
| SYNC-001 | 权限/问题旧快照覆盖新事件 | 已有事件水位、服务器生命周期保护；本轮 bootstrap/event 回归通过 |
| SYNC-002 | 重连 busy/idle 被旧快照覆盖 | 已有每请求基线与统一合并；本轮 server-sync 回归通过 |
| SYNC-003 | Agent 缓存未刷新 | 历史修复/自动证据保留；实际 UI 不外推 |
| SYNC-004 | 强制文件/目录刷新被吞 | 刷新队列已有修复；本轮 queue 回归通过 |
| SYNC-005 | 同名目录重建失效不完整 | 显式删除/父快照完整失效及 reset 代次已补；本轮 tree-store 通过 |
| SYNC-006 | 侧栏会话缓存陈旧 | 已有缓存修复；本轮 session-cache 回归通过 |
| SYNC-007 | pending 保存期间队列提前恢复 | 已有独立保存计数和服务器隔离；本轮 queue 回归通过 |
| SYNC-008 | 目录刷新提前释放/命令列表旧值 | 已有队列修复证据；完整 UI 待验 |
| SYNC-009 | 强制消息刷新等待自己 | 已有同读取循环补刷；本轮 server-sync 回归通过 |
| SYNC-010 | 重连遗漏消息/待办补刷 | 已有失败重试、每轮去重、补刷期间重连处理；本轮 server-sync 通过 |
| TASK-001 | 同项目任务未串行 | 有同项目串行/跨项目并行/失败收尾自动证据；真实 UI 场景待验 |
| TASK-002 | Prompt/effort/plan 与工具授权 | 已补参数及 ask/auto/plan、runner 等自动证据；不能继续沿用早期“未做授权测试”的描述 |
| TASK-003 | 每日任务与 DST 原定时分 | 已有修复与调度自动证据 |
| ATT-001 | 纯文本附件按媒体处理 | 已有修复与自动证据；错误后聊天 UI 待验 |
| ATT-002 | 解压/展开预算缺失 | 后续 ATT-002-R2、逐段剩余额度已补；本轮 Core office-text 通过 |
| IMG-001 | GPT 图片协议参数错误 | 后续图片协议/原生回退/授权路径自动证据保留；图片失败 UI 待验 |
| IMG-002 | Gemini API Key/Bearer 处理 | 已有协议回归证据；目标界面/供应商实际环境待验 |
| ATT-003 | ODS 空列/重复行错位与预算 | 累计列、表间换行、重复行和边界已补；本轮 Core office-text 通过，旧运行时本轮未重跑 |
| ATT-004 | RTF CP936 解码 | 已有小样本与损坏编码自动证据；不宣称覆盖所有代码页 |

## 五、后续复核编号的合并记录

以下按缺陷族归并；各轮文档中的历史“待实施”不能盖过后来的修复记录。

| 编号/缺陷族 | 最新状态与归并依据 |
| --- | --- |
| FOLLOW-001～004 | 双后端凭据删除、已提交清理幂等、重连请求基线和已结束会话补刷均已有后续修复；本轮认证/secret/server-sync 通过 |
| SET-005-R2 / R3-02 | MCP 项目来源编辑、typed HTTP、409 冲突、缺失/损坏/只读、安全 raw 来源等有后续实现；完整验收边界见第三节 |
| SYNC-005-R2 | 文件树 reset 递增代次；保留历史 5 项及本轮 tree-store 回归证据 |
| ATT-002-R2 / ATT-003 各轮预算补修 | 已补逐段/累计/UTF-8/换行边界；不按每次补修重复登记一个当前开放缺陷 |
| TASK-004 / 历史无 owner pending | 停用 runNow、认领前复检和历史 pending 保守恢复已有自动证据；本轮调度/cancel 回归通过 |
| R3-01 | 12 项过时断言已修，历史联合 151 pass 保留 |
| R3-03A | 保守诊断、取消与受控恢复已有后续实现；未知锁保留不是按年龄删除的许可 |
| R3-03B | 整体未关闭，详见第二节 |
| R3-04 / R3-05 | 任务失败收尾已有自动验证；真实长暂停及完整界面仍待验 |
| NL-01 / NL-02 | 取消原生租约与诊断探测租约泄漏，v1.0.6 Windows 分项关闭；不据此关闭 R3 整体 |
| UC-01 | native 回退、托管图片与工具授权真实 runner 等自动证据保留 |
| UC-02 / RF-01～03 | MCP 安全错误、环境原文优先级、获胜文件缺失契约已补；不能重复登记为未修 |
| UC-03 | Images 404 不自动转 Chat 已有自动证据；失败 UI 待验 |
| UC-04 | Desktop 启动环境/暂存类型与测试已通过；已安装包待验 |
| UC-05 / RF-05 | 慢刷新、乱序凭据已补验证；单许可保护提交，HTTP 在许可外，保留最新解释 |
| RF-04 | 真实 runner/auto 验证已补，不能沿用早期“未验证”结论 |
| RF-06 | 配置发现规则与主加载器统一，本机关闭 |
| RF-07 | 生命周期、异常归一化、投递/取消收尾本机已修；跨平台/root/真实传输取消仍待，不重复列为新的产品 bug |
| OA-01 | 目录事务写一致性与通知失败收尾有通过证据；本轮读缓存/身份通知边界新增 BF-04/05 |
| OA-02～05 | once 与显式停用、普通供应商识别、XLSX 预算、解码 defect 已有自动证据；界面按范围待验 |
| OA-06 / U、R、F、G、H 各轮 | 多轮状态归属修复保留；新增 BF-01～03 未修，OA-06 不关闭 |
| REVIEW-1111-01/02 | 配置入口统一锁、工作树首条 shell SDK 已补；真实 cwd/完整性能矩阵待验 |
| OR-01～03 | MCP 保存、重载和关闭生命周期归属组件通过，后续浏览器覆盖通过 |
| MR-01/02 | 弹窗 bound/internal ID 和全局 close 并发问题已有修复与后续回归 |
| AC-01 | autofocus 已修，局部实际浏览器验收通过 |
| AC-02 | 原失败已更正为验收时序条件错误；Portal 消失不等于内部栈 idle，后续复验通过，不登记成当前未修产品缺陷 |
| DR-01/02 | 嵌套 Escape 与 aria-hidden 已修；Windows Chromium 隔离生产构建 34 pass、组件 30 pass，局部关闭 |
| RA-01/02 | 活锁诊断与通用 Effect 取消交接已有最新锁回归通过；默认阈值真实长暂停不由短阈值用例替代 |
| RA-03～05 | 错误归属、草稿实体代次、字段冲突合并已有 70 项通过；BF-02/03 是此次新增边界，不能用旧通过结果推断它们已修 |

主要后续证据：

- [未提交修复结果及 RF-07 最后追加节](D:/opencode/specs/uncommitted-fixes-results-2026-11-09.md)
- [OA 结果](D:/opencode/specs/oa-bug-fix-results-2026-11-10.md)
- [OA-06 H01～H04](D:/opencode/specs/oa06-h01-h04-fix-results-2026-11-11.md)
- [REVIEW-1111 结果](D:/opencode/specs/review-1111-fix-results-2026-11-11.md)
- [MCP 弹窗生命周期](D:/opencode/specs/mcp-dialog-lifecycle-fix-results-2026-11-11.md)
- [MCP 弹窗根因修复](D:/opencode/specs/mcp-dialog-root-cause-fix-results-2026-11-11.md)
- [嵌套浮层实际浏览器验收](D:/opencode/specs/dialog-nested-fix-results-2026-11-12.md)
- [RA-01～05 最新结果](D:/opencode/specs/postfix-bug-fix-results-2026-11-12.md)

这些记录证明局部 MCP/共享浮层已有真实浏览器验收，不能再统一写成“所有界面都没验收”；同样不能扩大成整个设置页、真实后端和所有平台已验收。

## 六、本轮验证与可追溯证据

证据根：[本轮隔离证据](C:/Users/zh2100/AppData/Local/Temp/opencode-bug-consolidation-20261112-ae0265eba8d549bc9cb352c34901a7b4)。

| 类别 | 本轮结果 | 解释 |
| --- | --- | --- |
| 新增 App 审查诊断 | 2 pass、3 fail，11 断言，退出 1 | BF-01～03 正确行为断言失败，2 个正常/销毁对照通过 |
| 新增 Core 审查诊断 | 1 pass、2 fail，6 断言，退出 1 | BF-04/05 失败，普通本地写入对照通过 |
| 既有 App 7 套件 | 117 pass、0 fail，296 断言，退出 0 | 同步、bootstrap、队列、事件、缓存、文件树、持久化 |
| 既有 Core 9 套件 | 117 pass、0 fail，658 断言，退出 0 | 认证、凭据、目录事务、调度、授权、文档 |
| 源码一致性 | 10 份关键源码 SHA-256 主/副本一致 | 设置 hook、同步、目录事务、认证、调度等 |
| 类型检查/浏览器 | 本轮未重跑 | 历史通过只保留其原范围，不冒充本轮执行 |

新增诊断合计 3 pass、5 fail。它们是审查中新加的失败复现，**不是既有正式套件从通过退化为 5 fail**。既有相关回归合计 234 pass。

首次 App 审查回归用错运行条件，出现 jsxDEV/响应式环境问题；使用 browser 条件、tsconfig 和 happydom 重跑后 117 项通过。早期失败日志保留，不把测试运行环境错误登记为产品缺陷。

日志与源码：

- [App 最终诊断](C:/Users/zh2100/AppData/Local/Temp/opencode-bug-consolidation-20261112-ae0265eba8d549bc9cb352c34901a7b4/app-final-review/run.log)
- [Core 最终诊断](C:/Users/zh2100/AppData/Local/Temp/opencode-bug-consolidation-20261112-ae0265eba8d549bc9cb352c34901a7b4/core-final-review/run.log)
- [App 既有回归](C:/Users/zh2100/AppData/Local/Temp/opencode-bug-consolidation-20261112-ae0265eba8d549bc9cb352c34901a7b4/app-final-existing/run.log)
- [Core 既有回归](C:/Users/zh2100/AppData/Local/Temp/opencode-bug-consolidation-20261112-ae0265eba8d549bc9cb352c34901a7b4/core-existing/run.log)
- [App 复现源码](C:/Users/zh2100/AppData/Local/Temp/opencode-bug-consolidation-20261112-ae0265eba8d549bc9cb352c34901a7b4/app-review.test.ts)
- [Core 复现源码](C:/Users/zh2100/AppData/Local/Temp/opencode-bug-consolidation-20261112-ae0265eba8d549bc9cb352c34901a7b4/core-review.test.ts)
- [源码摘要对照](C:/Users/zh2100/AppData/Local/Temp/opencode-bug-consolidation-20261112-ae0265eba8d549bc9cb352c34901a7b4/source-proof.json)
- [审查时工作区清单](C:/Users/zh2100/AppData/Local/Temp/opencode-bug-consolidation-20261112-ae0265eba8d549bc9cb352c34901a7b4/status.txt)
- [复现命令及独立环境设置](C:/Users/zh2100/AppData/Local/Temp/opencode-bug-consolidation-20261112-ae0265eba8d549bc9cb352c34901a7b4/reproduce.ps1)

既有回归从对应包目录运行：

```text
# packages/app
bun test --tsconfig-override ./tsconfig.test.json --conditions=browser --preload ./happydom.ts ./src/context/server-sync.test.ts ./src/context/global-sync/bootstrap.test.ts ./src/context/global-sync/queue.test.ts ./src/context/global-sync/event-reducer.test.ts ./src/context/global-sync/session-cache.test.ts ./src/context/file/tree-store.test.ts ./src/utils/persist.test.ts --timeout 30000

# packages/core
bun test ./test/relay-auth.test.ts ./test/relay-secret-store.test.ts ./test/relay-catalog.test.ts ./test/relay-catalog-transaction.test.ts ./test/scheduled-task.test.ts ./test/scheduled-task-cancel.test.ts ./test/scheduled-model-identity.test.ts ./test/scheduled-authorization.test.ts ./test/util/office-text.test.ts --timeout 30000
```

诊断代码已归档到证据根，不保留在包测试目录中，避免后续正常测试被故意失败的审查样本污染。复跑时须先将归档文件放回独立副本原目录，因相对导入依赖这些位置；只允许使用独立测试数据。

## 七、处理顺序与后续审查重点

1. 先修 BF-01，防止“新增”修改已有供应商；同时补 create-only 冲突契约。
2. 修 BF-02、BF-03，分别建立“草稿原始提交值”与“异步动作实体归属”的完整契约。
3. 一起梳理 BF-04/05 的事务阶段，但分别验证磁盘提交、内存接纳、身份失效、通知与消费者重载。
4. 将上述失败复现纳入正式回归并转绿，保持本轮 234 项既有回归通过；按实际改动运行包类型检查。
5. 在独立应用/后端完成 UI01～UI08，按需扩展双进程、多服务器；再独立推进 R3-03B 与 RF-07 的目标平台工作。

多轮遗漏的共同原因是：只验证“旧回包不能写状态”，没有验证等待后的下一步请求；只验证规范化保存 ACK 和并发输入，没有验证保存后干净状态；只验证写事务不丢失，没有验证其他进程提交的读取接纳；把内容写入作为身份通知的统一门槛。后续测试应围绕这些跨阶段不变量，而不是只复刻当前实现分支。

本报告汇总的是截至本次审查有证据支持的已知问题，不承诺覆盖全部未提交改动、目标平台或所有时序，也不据此声称项目不存在其他缺陷。

