# OA-01～OA-06 实施结果

日期：2026-11-10  
状态：实施中。本文只记录本轮证据，不覆盖 `specs/uncommitted-fixes-results-2026-11-09.md`。

## 工作区

- HEAD：`6b051f12a21094df1adef83f9fddfcbb765b319e`
- 分支：沿用当前工作分支；本轮不 commit、不 reset、不全量暂存。
- 开工时未暂存改动：169 files changed, 14490 insertions, 1696 deletions。另有未跟踪文件。
- 参考基线（上一轮，不是本轮结果）：定向测试 636 pass、2 skip，八个包类型检查通过。
- 平台：Microsoft Windows。本轮证据不代表 Linux、macOS、root、网络共享、符号链接或已安装 Electron/Bun 单文件。

## 关闭边界

R3-03B、RF-07 跨平台、历史界面验收保持原状态。未执行的 UI01～UI08 记为界面待验收。

### OA-01
- 状态：并发写入一致性已验证；跨进程实时 UI 与旧写入者混用未关闭。
- 修改前：`RelayCatalog > C01 fails before the catalog commit boundary`，退出码 1。隔离根 `C:\Users\zh2100\AppData\Local\Temp\opencode-oa-fix-72ae344e2593488aa5a2601347de6b79`。磁盘结果只有 `gpt-first`，第二笔可见性写入被旧提交覆盖。
- 修改文件：`packages/core/src/relay-catalog.ts`、`packages/core/test/relay-catalog.test.ts`、`packages/core/test/relay-catalog-transaction.test.ts`、`packages/core/test/fixture/relay-catalog-writer.ts`。认证与服务端调用链核对后未改：`syncVendors` 在认证写锁释放后调用。
- 修改后：隔离根 `C:\Users\zh2100\AppData\Local\Temp\opencode-oa-fix-739b11c68e1d4df0a40d60f74ffe1b70`。`packages/core` 执行 `bun test test/relay-catalog-transaction.test.ts test/relay-catalog.test.ts --timeout 30000`，29 pass，0 fail，229 expect() calls，退出码 0，16.98s。C01～C12 均在本轮通过。C10 为两个真实进程共享同一数据根。
- 集成/界面：真实文件与多进程写入已覆盖。界面实时同步未执行，记为界面待验收。
- 限制：只关闭“新提交实现下并发写入不丢成功数据”。不关闭 R3-03B 旧写入者混用，不关闭其他进程提交后 UI 自动刷新。C08 证明中断后租约释放、后继可完成；没有单独证明“rename 前中断必须回滚已写临时文件”。C12 的 1200ms 等待只覆盖有界通知重试，不用于推断锁。Windows 证据不外推到其他平台。
- 关闭判断：OA-01 的 C01～C12 并发写入分项可以关闭。R3-03B 保持原状态。

### OA-02
- 状态：用户停用取消 pending、自动 once 不增加取消代次、内部 pause 撤销旧认领已验证。界面待验收。
- 修改前：公开 `setEnabled(false)` 与内部模型暂停没有共用持久取消代次。pending 认领可以在停用后继续创建会话；once 的自动推进如果复用停用代次，会误取消已认领执行。
- 修改文件：`packages/core/src/scheduled-task.ts`、`packages/core/src/scheduled-task/sql.ts`、`packages/core/src/database/migration/20261110124114_scheduled-cancel-epoch.ts`、`packages/core/src/database/schema.gen.ts`、`packages/core/src/database/migration.gen.ts`、`packages/core/schema.json`、`packages/core/test/scheduled-task.test.ts`、`packages/core/test/scheduled-task-cancel.test.ts`、`packages/core/test/fixture/scheduled-cancel-worker.ts`。`cancel_epoch` 保持数据库内部字段，未改 Protocol 或 SDK。
- 修改后：隔离根 `C:\Users\zh2100\AppData\Local\Temp\opencode-oa-fix-818d6bef91ea48c2bdeffbf43c8d8bbb`。`packages/core` 执行 `bun test test/scheduled-task-cancel.test.ts --timeout 20000`，14 pass，0 fail，66 expect() calls，退出码 0，7.90s。T01～T14 均通过。随后在隔离根 `C:\Users\zh2100\AppData\Local\Temp\opencode-oa-fix-985880f3852e4a5695c9bf24521f15b6` 执行 `bun test test/scheduled-task.test.ts test/database-migration.test.ts --timeout 30000`，39 pass，0 fail，141 expect() calls，退出码 0，5.55s；同进程 `bun script/migration.ts --check` 退出码 0。类型检查后复跑目录与取消用例的隔离根是 `C:\Users\zh2100\AppData\Local\Temp\opencode-oa-fix-8250c5815c84426ba616bebcd9585901`，43 pass，0 fail，295 expect() calls，退出码 0，20.32s。
- 集成/界面：T09 使用两个真实进程和隔离根内同一 SQLite 文件。T14 确认公开任务列表不依赖 running 的 sessionId，取消后运行进入 interrupted。设置界面未执行，记为界面待验收。
- 限制：T04 在同一秒唯一键冲突时重试到下一秒，重试只等待新认领成功，不把冲突本身当失败。T09 证明两边停用的增量都保留且最终没有 pending 或 running；它不证明两个进程同时持有项目锁。`packages/core` 的 `bun typecheck` 仍因既有 `src/session.ts`、`src/session/execution/local.ts`、`src/tester-session-bridge.ts` 的 CatalogError 不兼容而退出码 2。这些错误不属于 OA-02 修改文件。Windows 证据不外推到其他平台。
- 关闭判断：OA-02 的 T01～T14 分项可以关闭。界面待验收。R3-03B、RF-07 跨平台保持原状态。

### OA-03
- 状态：普通模型不再受 Relay 可见性误判；Relay 模型按 provider 与 modelID 精确校验。界面待验收。
- 修改前：`requireReady` 用 `catalog.hasManaged()` 和 `visible(model.id)` 作为所有任务的门禁。Relay 目录有托管项时，普通 OpenAI 模型会被当成隐藏 Relay 模型暂停。
- 修改文件：`packages/core/src/scheduled-task.ts`、`packages/core/test/scheduled-model-identity.test.ts`。未向全局 ScheduledTaskStore 注入 location-scoped Catalog。
- 修改后：隔离根 `C:\Users\zh2100\AppData\Local\Temp\opencode-oa-fix-bd75337d920d47a89016203782d80569`。`packages/core` 执行 `bun test test/scheduled-model-identity.test.ts --timeout 20000`，8 pass，0 fail，26 expect() calls，退出码 0，4.61s。补上合成请求断言后，隔离根 `C:\Users\zh2100\AppData\Local\Temp\opencode-oa-fix-d3af644eba874a7ab573ab084846fac0` 单独重跑 M08，1 pass，0 fail，7 expect() calls，退出码 0，3.07s。
- 集成/界面：M02 证明同名普通模型不调用 Relay 凭据。M08 使用 `SessionRunnerModel.resolve` 和 `LLMClient.prepare`，合成请求包含任务位置地址 `https://task.example/v1`，不包含 Relay 地址或 Relay 密钥。设置界面未执行，记为界面待验收。
- 限制：M08 覆盖任务位置选择后的真实 runner 模型解析和合成请求准备。它没有启动完整 SessionRunner 回合，也没有覆盖另一个进程的目录同步。Windows 证据不外推到其他平台。
- 关闭判断：OA-03 的 M01～M08 分项可以关闭。界面待验收。

### OA-04
- 状态：两套文档解析都按累计 UTF-8 输出预算拒绝超限。界面待验收。
- 修改前：隔离根 `C:\Users\zh2100\AppData\Local\Temp\opencode-oa-fix-66759eba164e40a2b08148888f236c0a`。`packages/core` 执行 `bun test test/util/office-text.test.ts --timeout 60000 -t D01`，D01 失败。76,083 字节 ZIP 被旧实现展开，`extractDocumentText` 返回以 `# Sheet1` 开头的完整文本，退出码 1。该进程在打印超大失败文本时被终止，耗时 99.0s。
- 修改文件：`packages/core/src/util/office-text.ts`、`packages/opencode/src/util/office-text.ts`、两个包的 `test/util/office-text.test.ts`。
- 修改后：Core 隔离根 `C:\Users\zh2100\AppData\Local\Temp\opencode-oa-fix-56c9c3b5608140ecaa95fda2ec14d677`。`packages/core` 执行 `bun test test/util/office-text.test.ts --timeout 60000`，12 pass，0 fail，72 expect() calls，退出码 0，455ms。旧运行时隔离根 `C:\Users\zh2100\AppData\Local\Temp\opencode-oa-fix-59f45990be7d46b7854ecb4989662ae3`。`packages/opencode` 执行同一测试文件，14 pass，0 fail，86 expect() calls，退出码 0，20.77s。调用方隔离根 `C:\Users\zh2100\AppData\Local\Temp\opencode-oa-fix-bcfc0003cbbc42f49b1f4f142af41457`。`packages/opencode` 执行 `bun test test/util/office-file.test.ts test/tool/write.test.ts --timeout 60000`，21 pass，0 fail，37 expect() calls，退出码 0，41.97s。
- 集成/界面：D01～D10 覆盖两套公共入口。DOCX、XLSX、PPTX 写回读取仍通过。设置界面和会话界面未执行，记为界面待验收。
- 限制：D01 在分配宽行前按共享字符串引用、分隔符和剩余额度拒绝。RTF 与 EPUB 的最终输出进入同一公共入口，超限返回不可读。Windows 证据不外推到其他平台。
- 关闭判断：OA-04 的 D01～D10 分项可以关闭。界面待验收。

### OA-05
- 状态：坏编码附件进入不可读提示，真实 runner 回合可继续。界面待验收。
- 修改前：隔离根 `C:\Users\zh2100\AppData\Local\Temp\opencode-oa-fix-6ef16850a6774ac2a9c40096a0e15f48`。`packages/core` 执行 `bun test test/session-runner-message.test.ts --timeout 60000 -t "normalizes data URL"`，退出码 1。`data:text/plain;base64,//4=` 的 Exit 为 Failure，没有进入不可读提示。
- 修改文件：`packages/core/src/session/runner/to-llm-message.ts`、`packages/core/test/session-runner-message.test.ts`、`packages/core/test/session-runner.test.ts`。
- 修改后：隔离根 `C:\Users\zh2100\AppData\Local\Temp\opencode-oa-fix-ce46587f917746638965b4a2082419a9`。`packages/core` 执行 `bun test test/session-runner-message.test.ts --timeout 60000`，7 pass，0 fail，41 expect() calls，退出码 0，1.85s。真实 runner 隔离根 `C:\Users\zh2100\AppData\Local\Temp\opencode-oa-fix-125ab75a70e84e37b2d009415492ec82`。`packages/core` 执行 `bun test test/session-runner.test.ts --timeout 60000 -t "unreadable text attachment|attachment read"`，2 pass，0 fail，6 expect() calls，退出码 0，3.38s。
- 集成/界面：A07 使用合成 LLM 跑真实 SessionRunner。第一条坏附件请求包含不可读说明，第二条普通消息继续成功。A08 在模型流开始后中断，Exit 保持中断，请求数为 1。设置界面未执行，记为界面待验收。
- 限制：UTF-16 与 CP936 按现有严格 UTF-8 策略降级为不可读，没有新增编码猜测。Windows 证据不外推到其他平台。性能基准未运行，因为本项没有修改 App session/timeline。
- 关闭判断：OA-05 的 A01～A09 分项可以关闭。界面待验收。

### OA-06
- 状态：复核后不能关闭。R01～R06、F01～F03、G01～G04 已补测。界面待验收。OA-06 仍不关闭。
- 修改前：设置状态入口没有请求归属。`createResource(load)` 在构造时就会发一次读取，两次显式 `load()` 的闸门因此对不上。旧读取可以在较新保存之后写回 auth。隔离根 `C:\Users\zh2100\AppData\Local\Temp\opencode-oa-fix-7354ae970da54500a2bf9672ec799b52`。`packages/app` 执行 `bun test --tsconfig-override ./tsconfig.test.json --conditions=browser --preload ./happydom.ts ./test-browser/relay-settings-state.test.ts --timeout 20000`，U02 在 20000.82ms 超时，退出码 1。
- 修改文件：`packages/app/src/hooks/use-relay-settings.ts`、`packages/app/test-browser/relay-settings-state.test.ts`。组件仍调用 `useRelaySettings()`。通知缺陷接住属于 OA-01 回归补强，文件是 `packages/core/src/relay-catalog.ts`。
- 修改后：隔离根 `C:\Users\zh2100\AppData\Local\Temp\opencode-oa-fix-f339c123938c4e5eaac4b1b970a5c1aa`。`packages/app` 执行 `bun test --tsconfig-override ./tsconfig.test.json --conditions=browser --preload ./happydom.ts ./src/hooks/use-relay-settings.test.ts ./test-browser/relay-settings-state.test.ts --timeout 20000`，17 pass，0 fail，66 expect() calls，退出码 0，1.56s。同根 `bun typecheck` 退出码 0。相关界面状态回归隔离根 `C:\Users\zh2100\AppData\Local\Temp\opencode-oa-fix-b1db282d841546229d499ed14c6b7945`，177 pass，0 fail，378 expect() calls，退出码 0，2.01s。
- 集成/界面：U01～U12 覆盖正式 `createRelaySettingsState`。旧布局和新布局的真实设置页未执行，记为界面待验收。
- 限制：没有覆盖跨进程设置同步。Windows 证据不外推到其他平台。U05 证明旧 probe 的 finally 不清掉较新忙碌状态；旧失败本身仍会在当前生命周期留下错误。
- 关闭判断：U01～U12 不能单独关闭 OA-06。2026-11-11 复核确认首次自动加载、命令幂等编号、未编辑刷新、managed 补读、CatalogError 构建边界和通知生命周期仍有缺口。

### OA-06 复核（2026-11-11）
- 状态：R01～R06 已补。OA-06 仍不关闭。界面待验收。
- 修改前：复核文档记录首次打开和切换服务器不自动读取；保存供应商与切换模式复用 `operationId`；未编辑刷新丢弃结果；保存后 managed 被清空；Core 类型检查 4 个 `CatalogError` TS2322；通知 `catchCause` 吞掉中断且 `forkDetach` 脱离服务作用域。
- 修改文件：`packages/app/src/hooks/use-relay-settings.ts`、`packages/app/test-browser/relay-settings-state.test.ts`、`packages/core/src/relay-catalog.ts`、`packages/core/test/relay-catalog-transaction.test.ts`。
- 修改后：设置隔离根 `C:\Users\zh2100\AppData\Local\Temp\opencode-oa-fix-7318e2bf9aca4815b9cb4ec1b3dff433`。`packages/app` 执行设置工具测试和状态测试，21 pass，0 fail，83 expect() calls，退出码 0，3.15s。同根 `bun typecheck` 退出码 0。目录事务隔离根同进程，`packages/core` 执行 `bun test test/relay-catalog-transaction.test.ts --timeout 30000`，15 pass，0 fail，38 expect() calls，退出码 0，16.75s。C12 现在断言恢复后实际发布 1 次且文件不变。C13 保持中断。C14 服务退出后 1200ms 发布次数不再增加，且不超过 9 次。C15 损坏目录构建失败且文件保持 `{`。C16 构建后读取损坏返回 `CatalogError`。
- 类型检查：隔离根 `C:\Users\zh2100\AppData\Local\Temp\opencode-oa-fix-2183c6b2fd1e41288309902006c9e6ee`。Core、OpenCode、Server 的 `bun typecheck` 退出码均为 0。此前 4 个 TS2322 不再出现。
- 集成/界面：UI01～UI08 未执行，记为界面待验收。R02 使用保留 operationId 重放的接口桩，另有真实 RelayAuth 幂等行为留在复核文档；本轮没有跑完整 HTTP。
- 限制：Windows 证据不外推到其他平台。R3-03B、RF-07 跨平台保持原状态。没有 commit，没有重启当前应用。
- 关闭判断：OA-06 保持不关闭。R01～R06 不能把剩余工作仅归为界面验收。

### OA-06 第二次复核（2026-11-11）
- 状态：F01～F03 已补。OA-06 仍不关闭。UI01～UI08 仍是界面待验收，但不是唯一剩余项。
- 修改前：保存 A 后操作 B 会按“代次曾经增加”清掉 A 的勾选；旧全量读取晚到会把 fresh 覆盖成 old；同一服务器内的旧读取失败会写入新读取成功后的错误。
- 修改文件：`packages/app/src/hooks/use-relay-settings.ts`、`packages/app/test-browser/relay-settings-state.test.ts`。没有改公开 Protocol 或 Server HttpApi，没有重新生成客户端。
- 修改后：单调代次与当前待补读分开。可见性合并使用请求前的供应商版本、票据和可见性水位。全量读取按请求前分片合并，无归属候选项只在本次全量票据仍有效时替换。读取与用户操作使用错误票据；供应商探测另有供应商错误所有者。旧请求完成或拒绝时不改当前界面错误。认证 revision 未被采用时，后续目录读取不覆盖已有目录。
- 定向测试：隔离根 `C:\Users\zh2100\AppData\Local\Temp\opencode-oa-fix-31fc51af638348fabb3b6bead5ccde6a`。`packages/app` 执行 `bun test --tsconfig-override ./tsconfig.test.json --conditions=browser --preload ./happydom.ts ./src/hooks/use-relay-settings.test.ts ./test-browser/relay-settings-state.test.ts --timeout 20000`，35 pass，0 fail，154 expect() calls，退出码 0，1.54s。F01 覆盖保存后勾选、两种完成顺序、删除交错和连续失效。F02 覆盖旧全量后回、反向顺序、删除期间全量、candidates 与 managed 分别挂起、两个供应商并发。F03 覆盖旧 get、旧目录阶段、旧成功晚于新失败、销毁与服务器 A→B→A、同供应商探测。
- 类型检查：隔离根 `C:\Users\zh2100\AppData\Local\Temp\opencode-oa-fix-c4bfd80524714ab1b5abc840ae79d667`。`packages/app` 的 `bun typecheck` 退出码 0。本轮没有改 Core、OpenCode、Server。
- 集成/界面：UI01～UI08 未执行，记为界面待验收。本轮没有跑完整 HTTP，没有重启当前应用，没有 commit。
- 限制：Windows 证据不外推到其他平台。R3-03B、RF-07 跨平台保持原状态。U05 现在断言旧探测失败不覆盖较新成功探测的错误和忙碌状态；同供应商旧失败不再要求在新成功后留下错误。
- 关闭判断：OA-06 保持不关闭。F01～F03 的状态层补测不能代替真实设置页验收。

### OA-06 第三次复核（2026-11-11）
- 状态：G01～G04 已补。OA-06 仍不关闭。UI01～UI08 仍是界面待验收，但不是唯一剩余项。
- 修改前：全量空快照保留旧模型和旧勾选。旧供应商 managed 晚到覆盖新全量勾选。删除正在勾选的自定义供应商后，旧勾选回包把它带回本地 managed。旧操作补刷借用最新错误票据，失败后污染当前错误。
- 修改文件：`packages/app/src/hooks/use-relay-settings.ts`、`packages/app/test-browser/relay-settings-state.test.ts`。没有改公开 Protocol 或 Server HttpApi，没有重新生成客户端。
- 修改后：全量合并的分片集合覆盖请求基线、当前条目和 incoming；空子集按同一接纳规则替换，并记录写入水位。candidates 与 managed 使用分开的水位。managed 基线在请求发出前捕获。勾选目标在回包时核对存在性、内置标记和地址；删除、同名重建或地址变更后，原回包不写入。保存、添加和获取模型把原动作票据传入补刷；补刷失败使用请求发出前固定的错误归属。
- 定向测试：隔离根 `C:\Users\zh2100\AppData\Local\Temp\opencode-oa-fix-4c6fe32c846c4c47b0460f5418c2a783`。`packages/app` 执行 `bun test --tsconfig-override ./tsconfig.test.json --conditions=browser --preload ./happydom.ts ./src/hooks/use-relay-settings.test.ts ./test-browser/relay-settings-state.test.ts --timeout 20000`，49 pass，0 fail，258 expect() calls，退出码 0，2.16s。G01 覆盖全空、只缺 A、只缺 B、仅 candidates 为空、仅 managed 为空、旧空快照晚于新供应商刷新、新空快照晚于旧非空响应。G02 用无参数 `managed()` 调用次数确认旧供应商 managed 已发出，再覆盖反向顺序和 visibility 写入期间的旧 managed。G03 覆盖删除勾选目标、删除后同名重建、目标换地址且其他供应商保持。G04 覆盖同供应商 fetchModels 的 refresh、candidates、managed 分别失败，以及 saveVendor 与 addVendor 的补刷票据。
- 类型检查：同一隔离根。`packages/app` 的 `bun typecheck` 退出码 0。本轮没有改 Core、OpenCode、Server。
- 集成/界面：UI01～UI08 未执行，记为界面待验收。本轮没有跑完整 HTTP，没有重启当前应用，没有 commit。
- 限制：Windows 证据不外推到其他平台。R3-03B、RF-07 跨平台保持原状态。G03 只证明前端不再复活已删除供应商，没有证明后端是否重建供应商或凭据。
- 关闭判断：OA-06 保持不关闭。G01～G04 的状态层补测不能代替真实设置页验收。

### MCP 弹窗 OR-01～OR-03（2026-11-11）
- 状态：OR-01、OR-02、OR-03 的组件回归已通过。完整界面验收未执行。OA-06、UI01～UI08、R3-03B、RF-07 保持原状态。
- 修改前：复核报告记录三处 P2。保存 A 期间切到 B，A 成功后把 B 标成已保存。切换服务器后新配置已加载，旧重载仍留下“加载失败”。关闭保存中的弹窗后再打开其他弹窗，旧请求完成会关闭新弹窗。
- 修改文件：`packages/app/src/components/settings-v2/dialog-mcp-v2.tsx`、`packages/app/src/components/settings-v2/mcp.tsx`、`packages/ui/src/context/dialog.tsx`、`packages/app/test-browser/dialog-mcp-v2-ownership.test.ts`、`packages/app/.gitignore`。没有改公开 Protocol 或 Server HttpApi，没有重新生成客户端。
- 修改后：保存、重载、刷新重试和错误回写都检查组件生命周期、身份代次和操作序号。身份变化只增加身份代次。已提交配置按保存开始时的 scope 与 directory 刷新，当前弹窗的已保存标记、错误和关闭另按归属写入。异步关闭使用打开时绑定的弹窗 id。遮罩点击在挂载后按该 id 关闭对应层。同名重开和叠加弹窗使用新的 id。
- 定向测试：隔离根 `C:\Users\zh2100\AppData\Local\Temp\opencode-oa-fix-77682b060681423fb86a7c9654e3f8e1`。`packages/app` 执行 `bun test --tsconfig-override ./tsconfig.test.json --conditions=browser --preload ./happydom.ts ./test-browser/dialog-mcp-v2-ownership.test.ts --timeout 20000`，16 pass，0 fail，75 expect() calls，退出码 0，6.54s。覆盖 A→B、A→B→A、交错保存、B 仍在加载、B 已加载、交错重载、销毁重载、销毁保存、Escape、遮罩关闭、dialog.show 替换、同名重开和叠加弹窗。测试编译真实 DialogMcpV2、真实 DialogProvider 和真实查询库。结束后两个编译文件均不存在。
- 类型检查：隔离根 `C:\Users\zh2100\AppData\Local\Temp\opencode-oa-fix-d0de9202aacc4338a8659e707ed83a38`。`packages/app` 的 `bun typecheck` 退出码 0。`packages/ui` 的 `bun typecheck` 退出码 0。本轮没有改 Core、OpenCode、Server。
- 集成/界面：完整设置页验收未执行。本轮没有跑完整 HTTP，没有重启当前应用，没有 commit。
- 限制：这是 DOM 组件受控复现，替换了网络响应、上下文入口和 UI 外壳。Windows 证据不外推到其他平台。叠加弹窗在下层保存完成后只保留上层，这是下层关闭自己的结果。
- 关闭判断：OR-01～OR-03 的本轮组件回归可以记为已修复。完整界面验收未完成，不能把设置页验收记为关闭。

## 本轮验证

UI01～UI08 未执行，保持界面待验收。F01～F03 已有状态层证据，不能把 OA-06 的剩余工作仅归为界面验收。R3-03B、RF-07 跨平台和历史界面验收保持原状态。

| 分组 | 隔离根 | 结果 | 退出码 |
| --- | --- | --- | --- |
| Core 目录、任务、文档、消息 | `opencode-oa-fix-60af62667cc0481eb22782fcbdfa6263` | 首次 138 pass，1 fail。C12 因 `Effect.die("notify")` 逃出 `Effect.catch` 失败 | 1 |
| C12 单独复跑 | `opencode-oa-fix-8ff519db5f1f4fe4bbf4e6f50352e1b7` | `catchCause` 后 1 pass，0 fail，2 expect() calls，5.68s | 0 |
| Core runner 附件 | 同上首次根 | 2 pass，0 fail，6 expect() calls，1.58s | 0 |
| Core 迁移检查 | 同上首次根 | `bun script/migration.ts --check` 无待生成迁移 | 0 |
| OpenCode 文档、配置、LLM | `opencode-oa-fix-c4dec7b8f47145ba951ba8a08e907220` | 282 pass，2 skip，0 fail，959 expect() calls，173.84s。跳过是 `config-read-permission.test.ts` 的 POSIX T13，以及 `httpapi-config.test.ts` 的 Windows 拒绝读取和 POSIX 模式拒绝读取 | 0 |
| App 设置状态 | `opencode-oa-fix-f339c123938c4e5eaac4b1b970a5c1aa` | 17 pass，0 fail；`bun typecheck` 通过 | 0 |
| App 相关回归 | `opencode-oa-fix-b1db282d841546229d499ed14c6b7945` | 177 pass，0 fail | 0 |
| Core/OpenCode/Server 类型检查 | `opencode-oa-fix-ed4a9fa03a6a4d048c515aaeb82f190f` | 既有 `CatalogError` 不兼容，退出码 2。本轮测试文件的两处类型错误随后已改 | 2 |
| Core 测试复跑 | `opencode-oa-fix-6734605471384fe585d90719736edd5a` | M01～M08 与消息套件 15 pass，0 fail，75 expect() calls，4.67s。类型检查不再报告这两个测试文件 | 测试 0；类型检查 2 |
| Client 类型检查 | 同上类型检查根 | `bun typecheck` 通过 | 0 |

`packages/core`、`packages/opencode`、`packages/server` 的 `bun typecheck` 仍因既有 `CatalogError` 不兼容退出码 2。位置包括 `packages/core/src/session.ts`、`packages/core/src/session/execution/local.ts`、`packages/core/src/tester-session-bridge.ts`，以及 OpenCode/Server 中传播同一错误的调用点。这些错误在 OA-06 之前已经存在，不属于本轮关闭项。公开 Protocol 与 Server HttpApi 未改，没有重新生成客户端。
