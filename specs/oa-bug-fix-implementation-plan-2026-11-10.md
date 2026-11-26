# OA-01～OA-06 详细修复实施方案

日期：2026-11-10  
状态：待实施。本文只规定修改与验收步骤，不代表代码已经修改或验证通过。  
依据：[整体审查报告](D:/opencode/specs/unpushed-bug-review-2026-11-10.md)。

## 1. 目标、范围与实施顺序

目标是修复审查中已复现的六项缺陷，并为各自根因建立回归保护。不要以“测试总数增加”替代对应失败路径的修复证据。

| 顺序 | 编号 | 必须达到的结果 |
| --- | --- | --- |
| 1 | OA-01 | 目录各写入入口串行提交最新状态；成功数据不被旧写入覆盖；失败不提前改变内存 |
| 2 | OA-02 | 用户停用能取消尚未开始的任务；一次性任务的自动调度推进不误取消已认领执行 |
| 3 | OA-03 | 普通模型不受 Relay 目录可见性误判；Relay 模型仍按完整身份校验 |
| 4 | OA-04 | XLSX 等文档输出受累计 UTF-8 预算控制，展开前拒绝超限 |
| 5 | OA-05 | 坏编码附件变成不可读提示，不以 defect 终止回合 |
| 6 | OA-06 | 设置读取不能覆盖较新保存结果，跨服务器或销毁后的回包不能写入当前界面 |

OA-01 与 OA-06 共同处理“后端保存一致性”和“前端展示一致性”，需要最后联合验收。OA-02 与 OA-03 修改同一调度文件，应分别补失败用例，再合并验证。

本轮不启用锁迁移 apply，不改生产标记，不重启当前应用，不清理用户已有未提交改动。R3-03B、RF-07 跨平台及历史界面项保留原状态；新增验证通过后，只关闭证据覆盖到的分项。

## 2. 开工前准备

### P01：固定工作区与证据

1. 在 D:/opencode 记录分支、HEAD、已暂存和未暂存清单；不要执行 reset、checkout --、restore 或全量暂存。
2. 保留当前审查报告，另建实施结果文档 D:/opencode/specs/oa-bug-fix-results-2026-11-10.md。
3. 在结果文档逐项登记：修改前失败、修复文件、修改后结果、退出码、测试环境、未覆盖项。
4. 当前参考基线是定向测试 636 pass、2 skip，八个包类型检查通过。它是上一轮结果，不是本轮修改后的结果。
5. 每次只暂存经核对属于本次修复的文件或代码块；新加 Core office-text 文件是未跟踪文件，最终交付时不能遗漏。

建议只读命令：

~~~powershell
Set-Location D:\opencode
git status --short
git rev-parse HEAD
git diff --stat
git diff --cached --stat
~~~

### P02：建立隔离验证环境

在单独 PowerShell 子进程中设置下列环境，再从对应包目录执行测试。不要把生产配置、凭据复制进夹具。

~~~powershell
$oaRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('opencode-oa-fix-' + [guid]::NewGuid().ToString('N'))
$oaPaths = @{
  OPENCODE_TEST_HOME = 'home'
  XDG_DATA_HOME = 'data'
  XDG_CONFIG_HOME = 'config'
  XDG_CACHE_HOME = 'cache'
  XDG_STATE_HOME = 'state'
  OPENCODE_TEST_MANAGED_CONFIG_DIR = 'managed'
  TEMP = 'tmp'
  TMP = 'tmp'
}
foreach ($oaEntry in $oaPaths.GetEnumerator()) {
  $oaPath = Join-Path $oaRoot $oaEntry.Value
  New-Item -ItemType Directory -Path $oaPath -Force | Out-Null
  [Environment]::SetEnvironmentVariable($oaEntry.Key, $oaPath, 'Process')
}
foreach ($oaName in @(
  'OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG_CONTENT',
  'OPENCODE_TUI_CONFIG', 'OPENCODE_PLUGIN_META_FILE', 'OPENCODE_PERMISSION',
  'OPENCODE_DISABLE_PROJECT_CONFIG', 'OPENCODE_PURE', 'OPENCODE_WORKSPACE_ID',
  'OPENCODE_EXPERIMENTAL', 'OPENCODE_EXPERIMENTAL_NATIVE_LLM',
  'OPENCODE_NATIVE_LOCK_DIR', 'OPENCODE_CONSOLE_TOKEN',
  'OPENCODE_TEST_MANAGED_PREFERENCES', 'RECORD'
)) {
  Remove-Item -LiteralPath ('Env:\' + $oaName) -ErrorAction SilentlyContinue
}
$env:OPENCODE_DB = ':memory:'
$env:OPENCODE_DISABLE_MODELS_FETCH = 'true'
Write-Output $oaRoot
~~~

需要验证数据库迁移或多进程时，显式使用该目录内的 SQLite 文件；不要让多个子进程分别使用 :memory: 后误以为它们共享状态。各子进程继承同一组 XDG 路径，并显式记录实际打开的文件路径。

### P03：先补会失败的回归

1. 针对每项复现路径先新增测试，在修改实现前运行。
2. 测试使用 Deferred、Promise.withResolvers、IPC ready/barrier 等控制边界。
3. 不用固定 sleep 推断“已经取得锁”“已经 pending”“已经发出请求”；等待实际状态或明确信号。
4. 测试实际服务、公共解析入口或正式状态工厂，不复制实现算法。
5. 外部网络、写盘完成顺序可以受控；至少保留真实磁盘/SQLite、真实 hook 或 runner 的集成验证。

### P04：性能基线

[App AGENTS.md](D:/opencode/packages/app/AGENTS.md) 要求在修改 session/timeline 前记录生产基准并比较。若实际修改涉及该范围，必须先跑基线；不能事后把新代码测量当成旧基线。Core runner 的 OA-05 也建议记录对应回合转换耗时和生产会话基准。

参考：[性能说明](D:/opencode/packages/app/e2e/performance/README.md)。从 App 包执行生产基准：

~~~powershell
Set-Location D:\opencode\packages\app
$env:PLAYWRIGHT_WORKERS = '1'
$env:PLAYWRIGHT_PORT = '14444'
bun run test:bench
~~~

先确认 14444 未被占用。基准配置会构建生产 bundle 并使用独立 webServer，reuseExistingServer 为 false。如果本机不能运行，记录缺口；不得写成前后性能验收通过，也不要重启当前应用来腾端口。

## 3. OA-01：统一目录事务，消除成功写入丢失

### 3.1 修改文件

必须核对：

- D:/opencode/packages/core/src/relay-catalog.ts
- D:/opencode/packages/core/test/relay-catalog.test.ts
- D:/opencode/packages/server/src/handlers/relay.ts
- D:/opencode/packages/core/src/relay-auth.ts
- D:/opencode/packages/core/src/util/effect-flock.ts

预计只需修改目录服务、其依赖声明和测试。若抽取共享锁键或原子提交辅助函数，范围只覆盖实际复用处，不顺便重构整个 FSUtil 或原生锁。

### 3.2 不变量

1. 三个写入口 refresh、setVisibility、syncVendors 都经过同一提交边界。
2. HTTP 请求在提交锁之外；提交时重新读取磁盘与认证状态。
3. 磁盘提交前，snapshot、vendors、vendorStamp 等“已提交状态”不改变。
4. 不存在或损坏的目录文件不能因通用 catch 被全部当成空目录覆盖。
5. rename 是提交点；提交后通知失败不能伪装成“配置未保存”。
6. 获取取消、提交失败、正常结束，都释放本次租约；不修改现有 NL-01/NL-02 所有权规则。

### 3.3 实施步骤

**01-A：收集全部写入者。**

用 CodeGraph/rg 查找 relay-catalog.json、write、setVisibility、syncVendors、refresh 的所有调用。建立“入口—文件—锁键”表，确认没有另外的迁移脚本直接改写同一目录文件。后续每个写入者必须纳入统一路径。

**01-B：规定唯一锁顺序。**

继续使用 EffectFlock，不自行选择 native 或目录后端。建议顺序：

~~~text
本服务提交许可
  → relay-auth 物理锁
  → relay-catalog 物理锁
  → 重读认证与目录
  → 计算并提交
  → 释放物理锁
  → 发布目录事件
~~~

物理锁目录均为 path.join(global.data, "locks")；认证锁键复用当前实际的 "relay-auth"，目录使用固定的 "relay-catalog"。如抽取常量，认证和目录两边同时引用。

这里获取认证锁是为了消除“校验凭据后、提交目录前供应商又被改写”的窗口。持锁期间只调用已经确认不再次加认证写锁的读取方法，如当前 auth.get()/resolve()；禁止调用 setVendor 等 mutate 入口。认证修改必须释放自己的写锁后再调用 syncVendors，避免重入和反向获取锁。检查全部调用链后再接入。

本地许可与物理锁都要有统一作用域；禁止在取得目录锁后再回头请求认证锁。

**01-C：把 read 改为严格读取。**

- 文件明确不存在时使用 empty。
- JSON 解析失败、Schema 校验失败、权限和 I/O 错误返回既有 CatalogError。
- 不再用 Effect.orElseSucceed(() => empty()) 吞掉所有读错。
- 兼容已有 StoredCandidate.sourceVendorId 的补全逻辑。
- 对新增持久化元数据提供旧文件默认值，并验证非负安全整数/字符串格式。

**01-D：建立一个真正计算最新状态的提交入口。**

推荐内部结构为 transact(change)，其中 change 接收锁内重读的最新 Draft 和认证状态，返回新 Draft、返回值和是否需要通知。调用者不能在进入 transact 前构造好旧 next 再原样写入。

事务内部顺序：

1. 获取许可和物理锁。
2. 重读最新文件和 auth。
3. 基于最新值计算 next，不修改现有 snapshot。
4. 校验并编码 next。
5. 写临时文件并原子替换。
6. 在短小的不可中断提交收尾区内安装本地已提交 snapshot、vendors 和 stamp。
7. 释放锁。
8. 发布或排队补发目录更新。

如果变更无效或已经过期，不写文件，不覆盖别人的数据。需要把新磁盘状态安装到本地时，也按已提交状态处理。

**01-E：原子替换与失败收尾。**

- 在目标同目录创建独占、随机命名的临时文件，写入完整 JSON，按已有安全策略设置 0600。
- 写完、关闭后 rename 到正式文件；如承诺断电持久性，还应验证所用文件系统和 flush/fsync 能力，不把“原子替换”直接称为“断电不丢”。
- rename 失败保留正式文件，不先删除正式文件。
- finalizer 只删除本次拥有的临时文件，不按通配符删除其他进程文件。
- 写入/rename 前失败：内存和事件都不更新。
- rename 成功后，即便取消到达，也完成本地已提交状态安装，再响应取消；不能把已经落盘的变更当作未落盘重放。
- 事件发送不持有目录锁，避免订阅者回读死锁。通知失败留下当前进程的待通知 revision，进行有界退避重试；重启时重新读取状态并触发初始同步。重试只发通知，不重复执行业务变更。

**01-F：让 setVisibility 基于最新快照合并。**

在事务内查供应商、现有 managed 项和 candidate，按 vendorId + modelId 更新一项，保留其他项。持久化成功后再返回该事务提交的 managed。不要返回另一个并发操作尚未落盘的可变全局数组。

**01-G：让 syncVendors 走同一事务。**

在事务中重读认证，剔除已删除供应商的条目，保留其他供应商结果。URL 或凭据身份改变时，即使行数不变，也触发目录失效通知。不能在提交失败前推进 vendorStamp，导致重试误认为已经同步。

**01-H：保留刷新代次，补足跨实例的请求归属。**

现有 generation 是进程内 Map。为了覆盖两个服务实例/进程，建议在 Stored 增加私有元数据：

- catalogRevision：每次持久化提交递增，旧文件缺省为 0。
- refreshRequests：按 vendorId 保存最新刷新请求 token，旧文件缺省为空。

刷新分为两个短事务，中间执行 HTTP：

1. 请求开始：在锁内读取最新认证，生成 vendor 专属 token 并写入 refreshRequests；捕获凭据/地址 fingerprint。此时不清空旧候选列表。
2. 释放锁，执行 HTTP。
3. 请求结束：重新加锁并重读；只有供应商仍存在、fingerprint 未变、token 仍匹配才应用该供应商结果。
4. 只替换该供应商来源的候选，并保留最新可见性和其他供应商数据。
5. 请求失败保留上一份有效目录。后续新请求覆盖该 vendor token，旧响应不能重新生效。

请求 token 不含密钥。catalogRevision 与现有 requestVersion 不混用；保留现有字段含义。不同 vendor 分别存 token，不能再用一个全局最新请求号互相淘汰。

仅写请求元数据不应清空 UI 或发布“模型已变化”事件。新目录内容成功提交后才发布变化通知。

**01-I：明确服务实例缓存边界。**

提交前一律重读磁盘，确保多个新版本写入者不丢数据。Effect 读取入口应有明确的外部 revision 刷新路径；同步的 visible/hasManaged/apply 只能读取已经安装的快照，不能暗中进行异步 I/O。

若要承诺其他进程提交后 UI 自动实时刷新，还需要独立的外部 revision 观察/同步及其验收。没有该证据就只关闭“并发写入丢数据”，不能据此关闭所有跨进程缓存同步问题。

**01-J：核对旧版本兼容范围。**

新增目录锁约束不了不获取该锁的旧版本写入者。测试与关闭结论必须注明“所有写入者使用新提交实现”。不通过删除迁移标记、双键混用或自动清除旧锁来获得通过；混用旧写入者仍归 R3-03B 迁移范围。

### 3.4 必须补的测试

| ID | 控制边界 | 必须断言 |
| --- | --- | --- |
| C01 | 第一笔提交挂起，启动第二笔可见性修改 | 第二笔不能基于未提交状态越过事务；完成后两项均在磁盘 |
| C02 | refresh HTTP 挂起，期间修改 visible | 刷新后用户选择保留 |
| C03 | 删除供应商后放行旧刷新 | 删除项不被复活，旧 token/fingerprint 不生效 |
| C04 | A、B 供应商并行刷新并逆序完成 | 两者结果均保留 |
| C05 | 同一供应商两次刷新，新请求先完成 | 旧请求不覆盖新请求 |
| C06 | write、rename 分别失败 | 原文件、内存、stamp 不变；未发布成功更新 |
| C07 | 文件损坏或拒绝读取 | 返回错误，原文件不被空数据覆盖 |
| C08 | 提交锁等待期间取消 | 后继竞争者可获取，未遗留租约 |
| C09 | rename 已完成时取消 | 磁盘与本地提交状态一致，业务变更不重复 |
| C10 | 两个真实进程写同一隔离数据根 | JSON 有效，两项均保留，进程退出后重建服务仍可读 |
| C11 | 同时获取认证/目录并修改供应商 | 无死锁，无凭据已删除后的旧目录提交 |
| C12 | 事件发送失败后恢复 | 提交不回滚，补发不重复写配置 |

C01 的旧实现应复现“磁盘一项、内存两项”。修复后更合理的顺序是第二笔等待第一笔，而不是强求两笔真实写盘仍能逆序完成。

关闭条件：C01～C12 均有本轮证据，至少一个真实文件/多进程用例；旧写入者混用与实时跨进程 UI 通知不能偷算进通过范围。

## 4. OA-02：用持久取消代次区分用户停用与自动推进

### 4.1 修改文件和明确语义

- D:/opencode/packages/core/src/scheduled-task.ts
- D:/opencode/packages/core/src/scheduled-task/sql.ts
- D:/opencode/packages/core/src/database/migration/ 下新增迁移
- 迁移生成文件、schema 快照
- D:/opencode/packages/core/test/scheduled-task.test.ts
- D:/opencode/packages/core/test/database-migration.test.ts

采用以下语义：显式停用取消 pending；已经成功从 pending 原子转为 running 的执行沿用现有运行/中断规则。停用不是“终止所有正在执行的会话”。这个开始边界必须在测试和 UI 文案/状态中一致。

### 4.2 实施步骤

**02-A：新增数据库内部 cancel_epoch。**

- scheduled_task.cancel_epoch：非空整数，默认 0。
- scheduled_task_run.cancel_epoch：可空整数；新认领显式写当前任务代次，旧行保留 null，表示无法证明认领代次。
- 不复用现有 revision 或时间戳：revision 已有配置/运行语义，时间戳可能相同。
- 这两个字段先保持为数据库内部字段，不暴露到公共 ScheduledTask.Info/Run，避免无必要的 Protocol 和 SDK 变更。

修改 Drizzle 表定义后，从 Core 包生成迁移：

~~~powershell
Set-Location D:\opencode\packages\core
bun script/migration.ts --name scheduled-cancel-epoch
bun script/migration.ts --check
~~~

检查生成的新增迁移、migration.gen.ts、schema.gen.ts、schema.json。不要修改已发布旧迁移来补列，也不要只改表定义不生成迁移。

**02-B：把显式停用做成数据库事务。**

setEnabled(id, false) 在一个事务内：

1. 确认任务存在。
2. 将 enabled 设为 false，并使用 SQL 表达式原子增加 cancel_epoch。
3. 将属于该任务、仍为 pending 的运行记录按条件更新为 interrupted，填写 ended_at 和现有 REQUEST_CONFLICT/disabled 说明。
4. 事务成功后发布实际改变的任务与运行事件。

即使一次性任务已经被 advance 自动设为 false，用户再次明确调用停用也必须增加代次，取消仍在排队的认领。不能因为 enabled 本来就是 false 而短路。

setEnabled(id, true) 不恢复旧运行；之后新认领捕获当前代次。停用再启用不能使旧 pending 重新有效。

**02-C：让自动 advance 不增加取消代次。**

advance 对 once 的自动 enabled: false 表示“不再安排下一次”，不表示用户撤销本次认领。因此只更新调度字段，不增加 cancel_epoch。

自动 tick 的“重读任务—确认 enabled/调度槽—插入认领—advance”应在同一数据库事务内完成，避免先读取旧启用状态、用户停用后又按旧值插入 pending。

同时清点所有 enabled: false 写入，包括 failReady 后的 pause。除 advance 的一次性自动推进外，凡表示撤销后续执行的停用都要原子增加 cancel_epoch 并条件中断 pending；不能只改公开 setEnabled，留下内部 pause 仍保留有效旧认领。不要在事务内递归调用会再次开启事务的公开方法。

**02-D：认领时捕获最新行。**

- runNow 获取现有认领互斥后，再在事务内重读任务。
- 新运行保存当前 task.cancel_epoch，不能从早先 ScheduledTask.Info 推断。
- 自动 tick 同样使用锁内/事务内当前行。
- 保留 task_id + scheduled_at 唯一约束、同秒冲突语义和已有活跃认领处理。
- 不为消除冲突而伪造新 scheduledAt，也不绕过现有 owner 恢复逻辑。

**02-E：等待项目锁后原子决定能否开始。**

删除“全部 once 豁免 enabled”的分支，改为：

1. 取得 task.projectID 项目锁。
2. 在短事务内重读任务和运行记录。
3. 验证 task 未删除、run 仍为本 owner 的 pending、run.cancel_epoch 非空且等于 task.cancel_epoch。
4. 不匹配则条件更新为 interrupted；run 已被停用事务中断时直接结束，不覆盖其终态。
5. 匹配时以条件更新/CAS 将 pending 改为 running，设置 started_at；事务提交后才允许创建 Session。
6. 对 once，不用 enabled: false 单独判取消；用取消代次判断用户是否撤销。daily 同样以取消代次与有效任务状态校验。

停用事务与开始事务竞争：先提交停用则不创建会话；先提交 running 则按“已经开始”的语义处理。这样不会留下“复检后、创建会话前被停用，却仍算 pending”的未定义窗口。

**02-F：适配会话创建前的 running 状态。**

现有实现先创建/录入 Prompt，再写 running。前移开始边界后，running 短时可能没有 session_id；Session 创建成功再条件附加 session_id，Prompt admitted 后再附加 prompt_message_id。

需要补齐：

- create/prompt 失败从本次 running 条件转为 failed/interrupted，不遗留孤儿 pending。
- 中断、进程退出时沿用 owner lease 恢复，不重放 Prompt 或工具副作用。
- 后续 patchRun 不能无条件把已 interrupted 的记录写回 running/completed；使用 owner、预期 status 和 run id 条件更新。
- 检查 App 任务列表、HTTP/SDK 和事件消费者对 running 但 sessionId 暂缺的处理；界面显示正在准备且不生成无效会话链接。若任何消费者要求 running 必须有 sessionId，就不能直接前移状态：应先增加内部持久 started/admitted 标记作为开始边界，再保持公开状态兼容，并为该替代方案补相同竞态测试。
- 已经创建会话但尚未填回 run 的崩溃恢复只收尾，不自动重试。

数据库事务内不调用 Session、网络或长时间等待；事务仅负责状态改变。

**02-G：兼容迁移前的运行记录。**

新代码不得将 cancel_epoch 为 null 的历史 pending 视为已获新协议执行授权。沿用现有 owner 探测：确认无活跃执行者后标 interrupted，不自动执行旧 pending。活跃旧 owner 的 running 不被新代码强行夺取或重放。

旧 JSON 导入的运行记录也按未知代次处理；终态记录保留历史内容。

### 4.3 必须补的测试

| ID | 场景 | 必须断言 |
| --- | --- | --- |
| T01 | daily A 占项目锁，手动 once B pending，停用 B 后放行 | B interrupted；未创建 B 会话 |
| T02 | 自动 once 已 advance 为 false、没有显式停用 | 本次执行一次并 completed |
| T03 | 自动 once pending 后又显式 setEnabled(false) | 即使 enabled 已 false，仍取消 |
| T04 | pending 后停用再启用 | 旧 run 不复活；新认领按现有唯一键规则处理 |
| T05 | pending 时删除任务 | 不创建会话，不发布不存在运行的完成事件 |
| T06 | daily pending 后停用 | interrupted，行为与 once 一致 |
| T07 | 显式停用与 pending→running 两种提交顺序 | 结果符合规定的开始边界，没有中间态误判 |
| T08 | running 后停用 | 不按 pending 取消，不重复创建或录入 Prompt |
| T09 | 两个进程并发停用/认领 | cancel_epoch 不丢增量，无停用后有效旧认领 |
| T10 | create/prompt/resume 分别失败，或取消 | 有终态，项目锁释放，下一任务可执行 |
| T11 | 从旧数据库迁移，有 null epoch 的旧运行 | 新任务可用；历史 pending 不被自动重放 |
| T12 | 同项目/跨项目/同秒 runNow | 同项目串行、跨项目并行、冲突语义均保留 |
| T13 | failReady 内部 pause 时还有排队记录 | 同样撤销旧代次，pending 不继续执行 |
| T14 | 已开始但 Session.create 尚未完成 | 公开状态和列表渲染兼容，不出现无效链接；取消/崩溃仍可收尾 |

关闭条件：原复现变成 interrupted 且 Session.create 计数未增加；自动 once 正常执行用例同时通过；迁移和开始边界两个顺序均验证。

## 5. OA-03：按 provider 与 model 的完整身份校验

### 5.1 修改位置

- D:/opencode/packages/core/src/scheduled-task.ts：requireReady。
- D:/opencode/packages/core/src/relay-catalog.ts：modelID/managed 身份读取，如有需要。
- D:/opencode/packages/core/test/scheduled-task.test.ts。
- 参考 D:/opencode/packages/core/src/session/runner/model.ts 的位置级模型解析。

### 5.2 实施步骤

**03-A：去掉全局 hasManaged 门禁。**

不能再把 catalog.hasManaged() 当成“所有任务都必须出现在 Relay 目录”的条件。hasManaged 可保留给其他调用者；只移除这里对普通模型的错误约束。

**03-B：先判断 Relay provider。**

当前 Relay 模型由 RelayCatalog.apply 注入 ProviderV2.ID.leidiandonghua。只有 task.model.providerID 为该值时，进入 Relay 可见性/凭据校验。不要根据 gpt-/claude- 前缀或 model id 是否恰好相同推断来源。

**03-C：Relay 分支精确匹配。**

1. 获取最新 managed 状态。
2. 使用 RelayCatalog.modelID(vendorId, modelId) 与 task.model.id 精确匹配。
3. 缺失或 visible: false 返回现有 MODEL_UNAVAILABLE。
4. 找到条目后，用该条目的 vendorId 调 auth.resolve；不凭 provider 显示名或 family 猜测。
5. 保留自定义供应商 custom: 编码、凭据缺失和项目合法性检查。
6. 与 OA-01 对齐：校验使用已经同步的最新目录，不读取其他进程长期未更新的内存状态。

**03-D：普通 provider 继续走真实位置级解析。**

普通模型跳过 Relay 检查，保留 projects.resolve 的项目校验，再由实际 SessionRunnerModel 根据任务 location 对应的 Catalog/Integration 解析模型与凭据。

本项的最小修复不在全局 ScheduledTaskStore 直接注入 location-scoped Catalog 或 SessionRunnerModel，这会破坏作用域边界。也不复制一套普通模型解析算法到调度器。

如果另行要求“普通模型失效必须在创建 Session 前发现”，应通过 LocationServiceMap.Service.get(task.location) 获取正式位置服务并设计独立预检；不能用 Relay 可见性近似代替。此扩展需单独的依赖/错误映射和集成测试，不作为本项最小补丁。

**03-E：验证最终模型确实来自正确 provider。**

服务单测之外，至少一条真实 runner 集成用例：同时配置 Relay 和普通 OpenAI，调度普通模型，捕获模型解析结果/合成 HTTP 请求，确认没有调用 Relay 凭据或 Relay 地址。测试用合成接口，不调用付费外部服务。

### 5.3 必须补的测试

| ID | 配置 | 预期 |
| --- | --- | --- |
| M01 | Relay 有托管项，普通 OpenAI 模型有效 | 执行正常，不自动暂停 |
| M02 | 普通模型 ID 与 Relay 模型 ID 相同 | 按 provider 区分，不串凭据 |
| M03 | Relay 模型可见、有对应凭据 | 执行正常 |
| M04 | Relay 模型隐藏或已删除 | MODEL_UNAVAILABLE，维持既有暂停策略 |
| M05 | 自定义 Relay vendor 编码模型 | 精确匹配对应 vendor |
| M06 | Relay 缺密钥/项目无效 | 仍走原有对应失败处理 |
| M07 | 普通模型失效 | 由真实 runner 的正常错误路径结束，不伪报 Relay 隐藏 |
| M08 | 任务 location 与当前打开项目不同 | 使用任务位置的模型配置 |

关闭条件：M01 原失败复现通过，同时 M03～M06 没有削弱 Relay 校验；M02、M08 至少有集成证据。

## 6. OA-04：贯通文档输出预算，展开前计费

### 6.1 修改文件

- D:/opencode/packages/core/src/util/office-text.ts
- D:/opencode/packages/opencode/src/util/office-text.ts
- 两个包各自的 test/util/office-text.test.ts
- 视需要新增共用测试样本数据；不要在测试里另写提取算法。

本轮先保留两套运行时入口。可以让两套测试读取同一份数据夹具；不要为了本项强行调整运行时依赖图。

### 6.2 统一规则

1. maxTextBytes 表示最终返回文本的 UTF-8 字节上限。
2. 预算恰好等于最终字节数时成功；少一字节时返回不可读，不截断成看似完整的内容。
3. 文本、制表符、单换行、表间双换行、表头都计入同一累计预算。
4. 输出预算与 ZIP 解压预算、中间展开额度分别管理；不能拿其中一个冒充其他两个。
5. 所有重复引用和稀疏列展开在大数组/字符串创建前检查，不在最终 join 后才判断。
6. 正常文档原有文字、顺序和分隔符不改变。

### 6.3 实施步骤

**04-A：让全部入口接收预算。**

extractDocumentText 将 limit 传给 Office 分支；extractOfficeText 增加可选预算参数，默认仍为 16MiB，使旧调用兼容。docx/xlsx/pptx 各分支共享同一次文档输出计数器。

检查直接调用 extractOfficeText 的所有入口，避免通过旧入口绕过默认上限。

同时把 RTF、EPUB 的最终输出纳入同一入口契约。若分阶段交付，至少在结果表明确它们是否已完成，不能只测 XLSX 就宣称“所有文档格式统一预算”。

**04-B：建立窄的预算写入器。**

按现有 pushLine 思路组织 append/appendLine 等实际复用原语：

- 先计算本次 UTF-8 字节数与分隔符成本。
- 用安全整数和减法形式检查剩余额度；乘法、坐标计算先做范围验证。
- 通过后再扣减并写入片段。
- 返回最终 join 之前断言累计数与 Buffer.byteLength 结果一致；该断言是回归保障，不能替代展开前限制。
- 文档数据损坏/超预算在公共解析边界变成 undefined。调用者传入非法预算参数仍按已规定的参数契约处理，避免和坏文档混淆。

不能为每一行、每一段或每一张表重新创建完整预算。

**04-C：对共享字符串引用重新计费。**

sharedStrings 可以解析为有界的字符串/字节长度表，但每个单元格引用它时都必须付出一次输出成本。

例如 1,024 字节共享字符串被引用 17,000 次，费用不是 1,024，而是 17,408,000 字节，再加行分隔和表头。遇到第一处超额立即终止，不继续建余下行数组。

未引用的共享字符串不应消耗最终输出预算；它们受现有解压与中间内存边界控制。

**04-D：在稀疏列数组创建前限宽。**

- 列坐标解析过程中检查安全整数。
- 验证 XLSX 列坐标在支持范围内；建议按 OOXML Excel 边界限制到 XFD/16,384 列，行号按 1～1,048,576 验证。
- 计算制表符数量、非空单元格字节总量、下一行分隔符后，再决定能否分配。
- 避免对不受限的坐标执行 Array.from(width)、repeat 或极大 spread。
- 保留正常 A、Z、AA、AZ、XFD 的相对列位置；非法坐标明确不可读，不能静默把值挤到错误列。
- 不新增按 row number 补齐百万空行的行为；保持当前只输出实际解析行的语义。

**04-E：把跨表、空表、DOCX/PPTX 分隔符纳入。**

XLSX 原有 "# SheetN"、行间 "\n" 和表间 "\n\n" 都必须在拼接时扣费。不要直接套用 ODS 的单换行布局改变 Office 输出。

DOCX/PPTX 文本片段也通过同一预算写入器；中文、emoji 按 UTF-8 字节计算，不用 string.length 代替。

**04-F：保护现有 ODS/ODT/ODP 修复。**

保留重复行、重复列、text:s 和跨段中间展开额度。中间额度仍跨段扣减，最终输出另行计费，不能把同一最终片段重复扣两次，也不能让每段重新使用全额。

重点重跑原有 302/301 字节行边界、7/6 字节空表边界，以及 20 组百万列、多表换行和 50 段 text:s 的回归。

**04-G：统一两个运行时的契约测试。**

同一份样本在两套入口上运行；记录实际返回字节数和是否不可读。不要只把实现复制过去而仅测其中一个包。

### 6.4 必须补的测试

| ID | 样本 | 必须断言 |
| --- | --- | --- |
| D01 | 审查的 76,083 字节 ZIP/17,000 次共享字符串引用 | 两套实现均在 16MiB 预算下拒绝 |
| D02 | 小型共享字符串重复引用，已知最终 N 字节 | N 成功；N-1 失败 |
| D03 | 中文与 emoji 单元格 | 按 UTF-8 字节而非字符数限制 |
| D04 | 多行分别低于预算、合计超限 | 合计拒绝 |
| D05 | 多表、空表、单/双换行边界 | 表头和全部分隔符计入 |
| D06 | 正常稀疏列 AA/XFD | 位置正确，费用准确 |
| D07 | XFE、超长字母坐标、非法行号 | 在分配前拒绝，不做危险内存样本 |
| D08 | 直接 extractOfficeText 与通用 extractDocumentText | 均不能绕过默认预算 |
| D09 | DOCX/PPTX/RTF/EPUB 小预算 | 公共入口契约一致，正常输出不变 |
| D10 | 原有 ODS/ODT/ODP 边界全集 | 既有修复保持通过 |

关闭条件：两套运行时通过同样的边界矩阵；输出和中间展开限制都在分配前生效。不要只增加最终 byteLength 检查。

## 7. OA-05：把坏编码归入附件不可读路径

### 7.1 修改文件

- D:/opencode/packages/core/src/session/runner/to-llm-message.ts
- D:/opencode/packages/core/test/session-runner-message.test.ts
- 真实 runner 集成测试文件，按现有 test/session-runner*.test.ts 结构放置

### 7.2 实施步骤

**05-A：限定修复策略。**

本项先保持“纯文本按严格 UTF-8 解码”的策略，不擅自猜 CP936 或替换坏字节。UTF-16/CP936 暂未支持时返回不可读；如另行扩展编码支持，应明确 BOM、回退顺序及歧义测试。

**05-B：只在解码边界捕获预期异常。**

把 fatal TextDecoder.decode 放入 Effect.try，或安全同步解码函数中，将解码错误映射到 plainText 的 typed failure/undefined。由现有 normalizeDocumentAttachments 生成不可读提示。

不要给整个 runner 加 catchAllCause/orElseSucceed 吞掉全部 defect；不要把取消转成成功；不扩大 Session 公开错误类型来容纳本应本地降级的解析异常。

**05-C：检查 data URI 与文件路径两条输入。**

两者在读取字节后共用相同解码逻辑。维持现有字节上限、文件读取错误和 Base64 处理策略；坏数据不能因一条路径走 Effect.try、另一条直接抛错而再次漏出。

**05-D：保持消息与历史无副作用。**

只构造发送给模型的派生消息，不写回用户原文或持久化附件元数据。不可读附件从本轮模型 media 列表移出，并加入现有说明；正常图片不受影响。

对包含坏附件的历史消息，多次规范化不能产生递增的重复提示或持续失败。

**05-E：验证实际回合。**

以合成模型/受控 LLM 执行真实 runner：

1. 第一条用户消息携带坏编码文件。
2. 模型收到不可读说明，回合可完成。
3. 第二条普通消息继续成功。
4. 另测取消仍保持中断，不被附件降级吞掉。

若触及 session/timeline，按 P04 完成前后性能记录。

### 7.3 必须补的测试

| ID | 输入 | 必须断言 |
| --- | --- | --- |
| A01 | data:text/plain;base64,//4= | Exit 成功，文本包含不可读说明，无 Die |
| A02 | 正常 UTF-8 hello、中文、emoji | 原文正确 |
| A03 | 截断 UTF-8、非法字节 | 安全降级 |
| A04 | UTF-16 BOM、CP936 样本 | 按选定策略安全降级或正确解码，不抛 defect |
| A05 | 相同字节的 file URI/readFile 路径 | 与 data URI 行为一致 |
| A06 | 空文件 | 按既有空文本语义处理，不误报坏编码 |
| A07 | 坏历史附件后继续发送 | 两个真实回合均可正常结束 |
| A08 | 读取/运行取消 | 保留中断，无多余模型请求 |
| A09 | 原消息对象与附件数组 | 未被原地改写 |

关闭条件：A01 修改前失败、修改后通过；A07 是真实 runner 证据，不能只靠纯函数测试关闭持续影响对话的问题。

## 8. OA-06：为设置请求建立上下文与版本归属

### 8.1 修改文件

- D:/opencode/packages/app/src/hooks/use-relay-settings.ts
- D:/opencode/packages/app/src/hooks/use-relay-settings.test.ts
- 建议新增 D:/opencode/packages/app/test-browser/relay-settings-state.test.ts
- 必要时修改 SettingsProviders/SettingsProvidersV2 的测试，尽量保持组件调用接口

现有 use-relay-settings.test.ts 主要测纯工具函数，不能当成 hook 生命周期覆盖。正式回归不能长期依赖审查时的源码字符串转译；应测试正式导出的状态入口或实际 Provider 包裹的 hook。

### 8.2 状态与上下文设计

推荐把内部状态逻辑收为 createRelaySettingsState(serverSDKAccessor)，useRelaySettings 只取得上下文并调用。工厂本身拥有正式实现；测试使用同一工厂，不复制算法。工厂不是另一个平行的假实现。

每个异步操作必须捕获：

- SDK/API 实例；
- server scope；
- 生命周期 generation；
- 操作 ID；
- 相关 auth revision、目录请求代次、草稿快照。

scope 相同不等于还是同一生命周期。A→B→A 后，第一次 A 的响应不能写到第二次 A。

### 8.3 实施步骤

**06-A：创建由 scope 驱动的生命周期。**

以 scope 作为 reactive source 建立当前上下文；scope 改变就提升 generation，销毁也使 generation 失效。资源加载由这个上下文 token 驱动，不能继续 createResource(load) 而不声明 source。

A→B→A 必须产生三份上下文。不要只比较字符串 scope；同 scope 的普通 refetch 不需要把用户草稿全部清空。

**06-B：明确状态重置。**

切换服务器时，清理旧 auth、candidates、managed、error、testing、fetching、status、drafts、统一密钥和新增表单草稿，以及 invalidated、目录代次和可见性队列上下文。

Solid createStore 的对象写入有合并语义：把 drafts/status 设置为 {} 不一定删除旧键。用 reconcile 或明确替换方式，并测试旧 key 确实消失。普通同服务器重新读取只合并认证状态，保留用户正在编辑的草稿。

**06-C：发出请求前捕获，await 后验证。**

load、loadCatalog、saveVendor、addVendor、persistDraft、probe、fetchModels、setVisible、setMode、saveUnified、clearUnified、clearVendorKey、rollback、deleteVendor 都使用捕获的上下文。

每次 await 后在发起后续请求、写 store、清草稿、invalidate、toast/finally 前检查上下文仍有效。尤其注意：

- load 的 get 与随后的 candidates/managed 使用同一份捕获的 API。
- persistDraft 结束后不能重新调用当前 relay()，把旧操作后半段发到新服务器。
- saveVendor 后的 setMode(false)、刷新目录也沿用原上下文。
- 返回 A 后，旧 A 的 catch/finally 不得清掉新 A 的忙碌状态。

请求取消可节省资源，但正确性依赖归属判断，不能依赖 AbortController 一定成功。

**06-D：让认证 revision 在同一生命周期内单调。**

applyAuth 统一接受 auth + capturedContext，不再在响应完成时默认取 scope。

只应用有效生命周期内 revision 不低于已应用值的快照。相同 revision 的等价快照可幂等处理；较低 revision 直接忽略。成功 mutation 和 GET 都走同一入口，禁止 setStore("auth", await ...) 绕过它。

这样“先读 revision 0、保存 revision 1、旧读取后到”不能回退。若后端发生真正的数据根重置或切换，应通过显式新上下文重建清除水位，不通过放行旧 revision 解决。

**06-E：为错误和忙碌状态同样增加归属。**

- fail(error) 不再无条件写当前 store；带上请求上下文或由受保护调用者处理。
- 成功的旧请求不能清掉新请求的错误。
- 旧操作 finally 只能结束自己持有的 testing/fetching 状态；可用 vendor + operationId 或 pending 计数，不能无条件 set undefined。
- 同一供应商有较新操作时，旧 probe/status 不覆盖它。
- 新增错误文案按 App i18n 规则处理。

**06-F：目录使用适当的请求代次。**

保留配置失效版本，但区分全局 managed 快照和按供应商 candidates 的请求顺序：

- 同一 vendor 只应用最新有效请求结果；
- A/B 两个 vendor 的成功刷新不能因同一个“全局最新请求号”互相丢弃；
- 全量 managed 响应不能覆盖其发出后已经应用的较新 visibility mutation 结果；
- 删除供应商或换地址后使旧目录请求失效；
- 同一 scope 的显式重载也不能把旧目录数据盖回保存后状态。

需要在 mutation 成功时使之前的目录读取代次失效，并安排捕获上下文内的补读。不要只修 auth，留下 managed 同类乱序。

**06-G：保护用户草稿。**

保存时记录提交的 key/name/URL。成功后只有当前草稿仍等于本次提交值、上下文仍有效时才清理对应字段。用户在等待期间输入的新值保留。

revision 旧响应被忽略时，本次真实保存的结果仍按成功处理；不要据此自动再次提交密钥。REVISION_CONFLICT 使用现有提示与重新读取流程，不盲目重放旧草稿。

**06-H：保留队列和销毁语义。**

可见性写队列绑定生命周期。切换后旧队列中尚未发出的请求停止，不转移到新服务器；已经发送的请求可完成于原服务器，但不改变当前 UI。销毁使所有异步 store 写入失效。

### 8.4 必须补的测试

每次响应构造独立 JSON 对象。不能让测试复用同一 auth 对象，Solid store 的合并可能修改共享引用并掩盖回归。

| ID | 时序 | 必须断言 |
| --- | --- | --- |
| U01 | 初始 GET 挂起→保存 rev1/hasKey true→旧 rev0 GET 完成 | 保持 rev1/true；原复现不再发生 |
| U02 | 两次 GET 逆序完成 | 旧 revision 不回退较新认证 |
| U03 | A GET 挂起→切 B→放行 A | B 自动发 GET；当前 auth/catalog 全属 B |
| U04 | A→B→A，再返回第一轮 A | 旧 generation 无效 |
| U05 | 旧请求 reject/finally 晚到 | 不污染新上下文错误、忙碌状态 |
| U06 | 保存前补读/保存后 setMode 或 refresh 遇到切换 | 所有请求仍属于捕获的原 API，不写到 B |
| U07 | 保存过程中用户输入新 key | 不清除新草稿，不重复提交旧 key |
| U08 | managed GET 挂起→visibility 成功→旧 GET 完成 | 保留最新可见性 |
| U09 | 不同 vendor 刷新乱序 | 两者成功结果都保留 |
| U10 | 组件销毁后响应返回 | 不再写 store，不触发后续请求 |
| U11 | 同服务器 reload 与服务器切换 | 前者保留草稿，后者确实删除旧 drafts/status 键 |
| U12 | 一次保存冲突/失败后重新读取 | 不伪装成功、不自动重放提交，后续可恢复 |

关闭条件：U01 正式状态入口测试通过；旧布局和新布局各有实际设置页证据；不能只用 keyed 重建掩盖 hook 本身的问题。

## 9. 验证命令与执行分组

所有命令在 P02 的隔离子进程内执行；不要从仓库根目录运行 bun test。以下是计划命令，本文没有执行它们。

### 9.1 Core 分组

目录/认证：

~~~powershell
Set-Location D:\opencode\packages\core
bun test test/relay-catalog.test.ts test/relay-auth.test.ts test/relay-secret-store.test.ts --timeout 60000 --only-failures
~~~

任务及迁移：

~~~powershell
bun script/migration.ts --check
bun test test/scheduled-task.test.ts test/database-migration.test.ts test/scheduled-authorization.test.ts --timeout 60000 --only-failures
~~~

文档与消息：

~~~powershell
bun test test/util/office-text.test.ts test/session-runner-message.test.ts --timeout 60000 --only-failures
~~~

把实际新增的真实 runner 集成测试文件也加入命令。不要只运行工具函数文件而漏掉新集成用例。

共享锁行为保护：若 OA-01 只消费现有 EffectFlock，先跑调用方新测试；如果修改了公共锁辅助代码，必须补跑：

~~~powershell
bun test test/util/flock.test.ts test/util/effect-flock.test.ts test/util/native-lease-lifecycle.test.ts test/protocol-recheck.test.ts --timeout 60000 --only-failures
bun typecheck
~~~

本机缺原生模块时明确记录无法执行的用例；不能静默跳过后记为完整通过。

### 9.2 App 分组

~~~powershell
Set-Location D:\opencode\packages\app
bun test --tsconfig-override ./tsconfig.test.json --conditions=browser --preload ./happydom.ts ./src/hooks/use-relay-settings.test.ts ./test-browser/relay-settings-state.test.ts --timeout 60000 --only-failures
bun test --tsconfig-override ./tsconfig.test.json --conditions=browser --preload ./happydom.ts ./src/context/server-sync.test.ts ./src/context/server-session.test.ts ./src/context/global-sync/bootstrap.test.ts ./src/context/global-sync/queue.test.ts ./src/components/settings-v2/mcp-form.test.ts ./src/context/file/tree-store.test.ts --timeout 60000 --only-failures
bun typecheck
~~~

relay-settings-state.test.ts 是本文建议新增的文件，创建前直接运行会失败。若采用实际 Provider 包裹的 hook 测试而不抽状态工厂，替换为最终文件名，并记录选择原因。

### 9.3 旧运行时

~~~powershell
Set-Location D:\opencode\packages\opencode
bun test test/util/office-text.test.ts --timeout 60000 --only-failures
bun test test/config/config.test.ts test/server/config-read-permission.test.ts test/server/httpapi-config.test.ts --timeout 60000 --only-failures
bun test test/session/llm-native.test.ts test/session/llm.test.ts --timeout 60000 --only-failures
bun typecheck
~~~

保留原有两个 skip 的真实名称和原因。未运行的 POSIX/root 验证不记为 pass。

### 9.4 类型与客户端契约

从 Core、App、OpenCode、Server 分别执行 bun typecheck。若实际改到 LLM、Client、Desktop、session-ui，也从对应包执行同样命令，最后建议复核上一轮通过的八包集合。

本方案优先让内部 cancel_epoch、目录 revision/request token 留在私有存储层。如果修改公开 Protocol/Server HttpApi：

1. 从 D:/opencode/packages/client 执行 bun run generate。
2. 旧 JS SDK 路由/公开错误发生变化时，从 D:/opencode 执行 bun ./packages/sdk/js/script/build.ts。
3. 不手工修改 generated/generated-effect 内容。
4. 复核各 SDK 和客户端类型检查，以及真实 HTTP 成功/错误响应。

## 10. 真实界面与集成验收

在独立数据根、独立端口、合成供应商和浏览器配置下验收，不重启当前应用。先完成所有自动回归，再执行以下实际操作：

| ID | 操作 | 验收结果 |
| --- | --- | --- |
| UI01 | 供应商初始读取延迟时保存 key，随后放行旧读取 | hasKey、revision 不回退；保存一次 |
| UI02 | 编辑供应商地址、删除供应商、重新加载设置 | 模型目录对应更新，已删除项不复活 |
| UI03 | 两个独立客户端并发修改不同模型可见性 | 两项都保存；重建隔离服务/重新读取仍保留 |
| UI04 | 旧布局、新布局分别切换两台服务器 | auth、候选、managed、草稿无串台 |
| UI05 | 同项目任务 A 阻塞，B 一次性任务等待，停用 B | B interrupted，未创建会话 |
| UI06 | 自动 once 到期，无用户停用 | 本次完成且没有再次调度 |
| UI07 | Relay 与普通供应商同时存在，运行普通任务 | 使用普通供应商正确模型，不误暂停 |
| UI08 | 上传超预算 XLSX、坏编码文本，再发送普通消息 | 前者安全失败/提示不可读，应用与后续对话正常 |

UI01/UI05 可以使用受控测试后端和明确 barrier。不要在生产服务器上修改文件权限、暂停正在使用的服务或执行锁迁移来制造时序。

界面通过后记录浏览器、应用构建、协议版本、实际端口、数据根、操作步骤和截图/日志证据。未执行的项目保持“界面待验收”。

## 11. 结果记录、交付和回退

### 11.1 每项记录模板

~~~markdown
### OA-xx
- 状态：待实施 / 自动验证通过 / 界面待验收 / 本机关闭
- 修改前：失败测试名、退出码、关键输出
- 修改文件：
- 修改后：测试命令、pass/fail/skip、退出码
- 集成/界面：实际路径、环境、证据
- 限制：平台、旧写入者、迁移、未覆盖边界
- 关闭判断：本项不变量是否逐条满足
~~~

### 11.2 交付检查

1. 逐项对照 C/T/M/D/A/U 测试矩阵，不把历史通过次数搬成本轮结果。
2. 检查新文件是否被遗漏：Core 提取器、新回归、迁移、schema 快照、结果文档。
3. 不把秘密、真实配置、临时数据目录和故障夹具提交进仓库。
4. 检查目录提交是否仍存在绕过事务的 write；认证 store 是否仍存在绕过 applyAuth 的 await 赋值；任务是否仍存在无条件写回终态。
5. 用当前代码重新同步 CodeGraph，再检查真实调用入口。索引成功不等于运行验收成功。
6. 不用 unconditionally skip、扩大 timeout、吞掉断言或全局 catch 来获得通过。
7. 未完成 UI、跨平台或混用旧版本验证时明确保留缺口。

### 11.3 回退约束

- 代码回退只撤销本次明确修改的块，不全量恢复工作区。
- 已执行的数据库迁移采用向前兼容方案：新增列可被旧读取代码忽略，但旧写入者不维护 cancel_epoch，不能因此宣称混用旧版本安全。回退测试使用隔离副本，不破坏生产运行记录。
- 目录新增私有元数据旧版本可能忽略或丢弃，不能混合运行后再认为刷新 token 仍可靠。
- 不删除已完成协议标记以降级，不启用迁移 apply，不清理未知锁。
- 不清空数据库、目录或用户模型选择来掩盖一致性错误。

六项自动回归和真实路径都完成后，可以逐项关闭 OA-01～OA-06；R3-03B、RF-07 和其他历史缺口仍按各自证据单独验收。
