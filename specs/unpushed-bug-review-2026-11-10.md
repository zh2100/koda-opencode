# 未推送与未提交内容整体审查（2026-11-10）

本轮仍发现 6 项可复现缺陷，不能认定全部修复。下述结果来自当前工作区的真实服务或解析函数，以及对真实前端 hook 函数体的受控调用。自动回归通过与新增缺陷复现并不矛盾：当前测试没有覆盖相应的乱序和预算边界。

本轮只审查，不修复业务代码，不暂存、不提交、不推送、不改版本，不重启应用，不写生产配置或迁移标记。新增本报告，并刷新 CodeGraph 索引。验证仅使用内存或 C 盘独立临时目录。

## 1. 范围和证据边界

- 仓库：D:/opencode；分支 dev；HEAD 6b051f12a2。
- 本地缓存 origin/dev 与 HEAD 的提交差为 0/0。未执行 fetch，这只证明本地引用一致，不证明实时远端状态。
- 审查起始有 169 个已跟踪差异文件，以及 80 个未跟踪文件；本报告不计在起始范围内。
- 已检查同步刷新、MCP 来源编辑、供应商配置和目录、调度任务、图片生成、附件提取、桌面启动与升级、SDK 等改动的关键路径，并执行下列回归。
- CodeGraph sync：35 added、73 modified；用于追踪调用路径。例如 normalizeDocumentAttachments 已接入真实 Core runner。
- 未逐行证明全部文件均无缺陷，也未执行所有包的全部测试。这里报告已确认的问题，不把待验收项当成已证实缺陷。

## 2. 缺陷清单

| 编号 | 优先级 | 问题 | 证据 |
| --- | --- | --- | --- |
| OA-01 | P1 | 模型可见性等目录写入乱序，成功保存的结果可能丢失 | 真实 RelayCatalog + 受控文件写入顺序 |
| OA-02 | P1 | 一次性任务排队期间被用户停用，仍创建会话并执行 | 真实调度器、SQLite、项目互斥锁 |
| OA-03 | P1 | 存在 Relay 托管模型时，普通供应商定时任务被误停用 | 真实调度器 + 受控目录服务 |
| OA-04 | P1 | XLSX 共享字符串展开绕过 16MiB 文本预算 | Core 与旧运行时真实解析函数、同一 ZIP 样本 |
| OA-05 | P2 | 非 UTF-8 文本附件以 Effect defect 终止处理 | 真实 normalizeDocumentAttachments |
| OA-06 | P2 | 迟到的认证读取覆盖保存后的供应商状态 | 真实 hook 函数体、Solid 响应式、独立接口快照 |

P1 表示应在继续发布相关功能前优先处理。OA-04 已证明输出超预算，没有运行极端内存样本，也没有把推测的 OOM 写成已发生事实。

### OA-01：目录提交没有统一事务边界

位置：

- [relay-catalog.ts:201](D:/opencode/packages/core/src/relay-catalog.ts:201)：持久化及发布更新。
- [relay-catalog.ts:270](D:/opencode/packages/core/src/relay-catalog.ts:270)：commitPermit。
- [relay-catalog.ts:363](D:/opencode/packages/core/src/relay-catalog.ts:363)：setVisibility。

触发步骤：

1. 第一笔 setVisibility 将 gpt-first 设为可见，文件写入暂不完成。
2. 第二笔将 gpt-second 设为可见，先完成文件写入。
3. 放行第一笔旧快照写入。
4. 两个调用均成功，但持久化只剩第一项，内存仍显示两项。

实测输出：

~~~json
{"writes":2,"persisted":["gpt-first"],"memory":["gpt-first","gpt-second"]}
~~~

根因：新加的 commitPermit 只覆盖 refresh；setVisibility、syncVendors 没有共用提交保护。各入口在磁盘写入前就修改 snapshot，也没有统一的失败回滚和跨进程协调。前端的 visibilityWrite 队列只保护同一 hook 实例，不能保护其他客户端和服务入口。

影响：用户已经收到成功结果，重启或重新读取后模型选择丢失；同类竞争也可能发生在刷新、供应商同步与可见性写入之间。

修复边界：

- 所有写入入口共用事务；锁内重读最新磁盘状态，再计算变更并原子提交。
- 持久化成功后更新内存并发布事件；失败保持原状态。
- 若支持同一数据根多进程写入，必须共用同一进程间锁身份；仅增加内存信号量不能关闭跨进程问题。
- 验收至少覆盖逆序完成、刷新与可见性并发、删除供应商与刷新并发、提交失败、多进程写入。

归属：setVisibility 的并发缺口在既有实现中已经存在；当前未提交改动新增了刷新许可和 syncVendors，但仍未完整收口。

### OA-02：一次性任务的自动停用与用户停用混为一谈

位置：[scheduled-task.ts:352](D:/opencode/packages/core/src/scheduled-task.ts:352)。

触发步骤：

1. 让任务 A 持有同项目执行锁。
2. 对已启用的一次性任务 B 调用 runNow，确认它已有 pending 记录。
3. 将 B 显式设置为 enabled: false。
4. 放行 A。

真实调度器输出：

~~~json
{"enabled":false,"secondRun":"completed","createdSessions":2}
~~~

根因：stillDue 为允许调度器 advance() 自动禁用后的已认领 once 任务继续执行，对全部 once 任务豁免 enabled 复检。手动 runNow 没有经过 advance，也被豁免。

影响：用户明确停用尚未开始的任务后，它仍可能执行工具和产生外部副作用。

修复边界：

- 为认领记录保留“自动推进”和“用户显式停用”的区分，或使用可持久化的取消版本。
- 等待项目锁后，重新校验用户停用或删除；已由 advance 自动停用的有效认领仍可执行。
- 验收 once/daily、自动调度/runNow、等待期间停用/删除/重新启用矩阵；不能再用 schedule === once 一概放行。

归属：当前未提交的 stillDue 修复引入了这条过宽的豁免。

### OA-03：普通供应商模型被 Relay 可见性误拦

位置：

- [scheduled-task.ts:295](D:/opencode/packages/core/src/scheduled-task.ts:295)。
- [dialog-scheduled-v2.tsx:42](D:/opencode/packages/app/src/components/settings-v2/dialog-scheduled-v2.tsx:42)：创建任务时使用最近模型或通用模型列表中的模型。

触发步骤：目录存在任意 Relay 托管模型；创建普通 openai/gpt-4.1 任务并 runNow。受控目录 hasManaged() 为 true，普通模型不在 Relay managed 中。

实测输出：

~~~json
{"created":0,"status":"failed","error":"MODEL_UNAVAILABLE","enabled":false}
~~~

根因：requireReady 对所有任务应用 catalog.visible(task.model.id)，未区分普通 provider 和 Relay 管理的模型身份。RelayCatalog.visible 只识别 managed 模型 ID。UI 没有限定只允许 Relay 模型。

影响：启用一个 Relay 模型后，原本能使用的其他供应商定时任务被判不可用并自动暂停。

修复边界：

- 先按模型与 provider 的完整身份判断是否属于 Relay 管理模型。
- Relay 模型检查目录可见性和对应凭据；普通模型走实际模型解析/可用性检查。
- 验收普通供应商与 Relay 同时存在、隐藏 Relay 模型、相同 model ID 属于不同 provider 等情况。

归属：该 guard 在 HEAD 中已经存在，属于本轮发现的既有缺陷，不能称为本轮新增回归。

### OA-04：XLSX 展开没有使用输出预算

位置：

- [Core office-text.ts:33](D:/opencode/packages/core/src/util/office-text.ts:33)。
- [旧运行时 office-text.ts:33](D:/opencode/packages/opencode/src/util/office-text.ts:33)。
- 两套实现的 sheetRows 位于各自文件第 184 行，按列宽分配输出位于第 198 行。

触发样本：

- ZIP 大小 76,083 字节。
- 一个 1,024 字节共享字符串。
- 17,000 行，每行引用这个共享字符串一次。
- 默认输出预算 16,777,216 字节。

两套函数均返回 17,425,008 字节文本，未拒绝：

~~~json
{"runtime":"core","archiveBytes":76083,"textBytes":17425008,"limit":16777216,"rejected":false}
{"runtime":"opencode","archiveBytes":76083,"textBytes":17425008,"limit":16777216,"rejected":false}
~~~

根因：extractDocumentText 只把 limit 传给 OpenDocument 分支；Office 分支直接调用无预算的 extractOfficeText。XLSX 在解压后再次展开 shared string 引用；压缩和解压尺寸上限约束不了最终文本。

影响：小附件可产生超预算文本并占用大量内存。XLSX 稀疏坐标转成 Array.from(width) 也没有预算前置检查；后者仅为代码证据，未运行危险的超大坐标样本。

修复边界：

- 在公共提取入口贯通累计 UTF-8 输出预算；共享字符串每次引用都重新计费。
- 行、分隔符、表头和跨表换行共同累计；分配稀疏列数组前验证坐标及剩余额度。
- 两套实现使用同一样本验证预算恰好够用、少一字节失败和多行/多表累计。
- ODS 已有预算测试不能替代 XLSX 分支。

归属：Core 提取器为未跟踪新增文件；旧运行时文件为已修改文件，其中 Office 分支尚未纳入这轮新增预算约束。

### OA-05：文本解码异常逃逸为 defect

位置：

- [to-llm-message.ts:83](D:/opencode/packages/core/src/session/runner/to-llm-message.ts:83)。
- [to-llm-message.ts:129](D:/opencode/packages/core/src/session/runner/to-llm-message.ts:129)。
- [llm.ts:233](D:/opencode/packages/core/src/session/runner/llm.ts:233)：真实 runner 调用入口。

使用合法 msg_ 消息 ID，附件 URI 为 data:text/plain;base64,//4=，即非 UTF-8 字节。对照的 UTF-8 hello 正常转换。

实测：非 UTF-8 附件返回失败 Exit，原因类型为 Die，错误为 The encoded data was not valid for encoding utf-8。

根因：fatal TextDecoder.decode 在 Effect.gen 中直接抛出；外层 Effect.orElseSucceed 只能处理 typed failure，不能捕获 defect。因此没有进入预期的不可读附件降级。

影响：一个无法解码的普通文本附件可中断模型回合；历史消息在后续回合仍会被重新规范化，可能持续阻止对话。

修复边界：

- 将解码纳入 Effect.try 或明确的安全解析边界，失败进入不可读附件提示。
- 是否支持 UTF-16、CP936 应另定策略，但任何不支持或损坏编码都不能变为未捕获 defect。
- 验收损坏 UTF-8、UTF-16 BOM、正常 UTF-8，以及包含坏历史附件时后续消息能继续。

归属：当前未提交新增的附件规范化路径。

### OA-06：旧认证快照覆盖新保存结果

位置：

- [use-relay-settings.ts:80](D:/opencode/packages/app/src/hooks/use-relay-settings.ts:80)：applyAuth。
- [use-relay-settings.ts:93](D:/opencode/packages/app/src/hooks/use-relay-settings.ts:93)：load。
- [use-relay-settings.ts:109](D:/opencode/packages/app/src/hooks/use-relay-settings.ts:109)：无 scope source 的 createResource。

同一服务器的受控复现：

1. 初次 get 挂起，保留旧 revision: 0 的响应。
2. 在默认供应商卡片上填写新 key 并执行 saveVendor。其补读返回独立快照，保存返回 revision: 1、hasKey: true。
3. 放行初次旧 get。
4. 表单回退到旧状态。

实测输出：

~~~json
{"saved":{"revision":1,"hasKey":true},"afterInitialLoad":{"revision":0,"hasKey":false}}
~~~

另一个受控场景中，A 初始读取未完成时将 SDK accessor 切到 B，再放行 A，得到 A 的 auth 与 B 的 candidates。B 的 get 调用次数为 0。

验证方式：读取当前 hook 源文件，仅替换导入依赖并转译，执行真实函数体，使用真实 Solid createResource/createStore 和受控 API；每次响应使用独立对象，避免对象共享影响断言。这是 hook 级复现，未挂载真实设置页面，不能记为界面验收。

根因：

- applyAuth 没有在同一 scope 内比较认证 revision 或读取/写入代次。
- load 在 await 完成后才默认取 requestScope，旧请求会被误认为属于当前 scope。
- createResource(load) 没有 scope source，组件存活时切换服务器不会自动发起新的 auth 读取。
- 目录版本保护不能保护 auth；部分操作的 scope 检查也不能约束首次加载。

影响：保存后界面错误地显示无密钥或旧供应商信息；下一次操作可能携带旧 revision，遇到冲突。未发现后端实际保存的密钥被这条迟到读取删除。

修复边界：

- 发出请求前捕获 SDK、scope 和生命周期代次；结果只应用到同一有效上下文。
- 同一 scope 内只接受不低于已应用 revision 的认证快照，或让成功写入使旧读取失效。
- 以 scope 驱动资源加载，并在切换时清理相应草稿、错误和目录状态；所有 catch/finally 同样检查归属。
- 验收同服务器先读后写乱序、双服务器切换及 A→B→A、失败响应、销毁后回包。
- SettingsServerScope 在新布局中 keyed 重建能缓解部分跨服务器场景，不能修复同一服务器读取覆盖写入的问题。

归属：初次加载与 revision 缺口在既有 hook 中已存在；当前未提交改动给部分写入增加 scope 检查，但未覆盖这条读取路径。

## 3. 本轮自动验证

全部命令从对应包目录执行；隔离环境禁用模型抓取，使用合成凭据和临时数据根。

| 范围 | 命令/文件 | 结果 |
| --- | --- | --- |
| Core | relay-auth、relay-catalog、relay-secret-store、scheduled-task、image-generation、image-generation-settings、image-generation-authorization、session-runner-message、util/office-text | 113 pass，0 fail |
| App | server-sync、server-session、global-sync/bootstrap、global-sync/queue、mcp-form、file/tree-store；browser conditions + happydom + tsconfig.test | 177 pass，0 fail |
| OpenCode 配置/权限/附件 | bun test test/config/config.test.ts test/server/config-read-permission.test.ts test/server/httpapi-config.test.ts test/util/office-text.test.ts --timeout 60000 --only-failures | 203 pass，2 skip，0 fail；194.54 秒 |
| OpenCode LLM | bun test test/session/llm-native.test.ts test/session/llm.test.ts --timeout 60000 --only-failures | 49 pass，0 fail |
| Desktop | background-cli、updater-controller、koda-release、electron-builder.config | 38 pass，0 fail |
| LLM | bun test test/provider/openai-responses.test.ts --timeout 60000 --only-failures | 56 pass，0 fail |

合计 636 pass、2 skip、0 fail；各测试进程退出码为 0。这是定向回归统计，不是项目全量测试统计。

bun typecheck：Core、App、Desktop、OpenCode、Server、LLM、Client、session-ui 八个包均退出码 0。

权限套件的两个 skip 仍分别是夹具 T13 占位跳过和 Windows 不适用的 POSIX mode 用例。它们不能记成 Linux/macOS/root 验证通过。

部分隔离证据根：

- Core 联合：C:/Users/zh2100/AppData/Local/Temp/opencode-overall-audit-6361fff349fc449098259d76d6e6956d。
- OA-01：C:/Users/zh2100/AppData/Local/Temp/opencode-overall-audit-f573924bedc14e559cc7ce8590e2d9ca。
- OA-02：C:/Users/zh2100/AppData/Local/Temp/opencode-overall-audit-2b48a13227c647369dc14d6122960df0。
- OA-03：C:/Users/zh2100/AppData/Local/Temp/opencode-overall-audit-ca562d33eaa343879338c29af575f0fb。
- 配置/权限/附件联合：C:/Users/zh2100/AppData/Local/Temp/opencode-overall-audit-eb4edbb27c5f452e9e942feca97119ad。
- LLM 双路径：C:/Users/zh2100/AppData/Local/Temp/opencode-overall-audit-9c44ab394e8f4120b4474e26f8506e9d。
- Desktop：C:/Users/zh2100/AppData/Local/Temp/opencode-overall-audit-36a3ae5b091d4965a0af3312e3f08434。
- LLM Responses：C:/Users/zh2100/AppData/Local/Temp/opencode-overall-audit-8a4b21de30904465bb21bc7f79598e31。

## 4. 历史缺口与尚未证实的风险

以下不计入上面的 6 项已复现缺陷，也不因本轮自动测试通过而关闭：

- R3-03B：离线迁移 apply 仍未启用；跨平台、符号链接、已安装 Electron、Bun 单文件与真实迁移验收仍有缺口。已关闭的 NL-01/NL-02 本机结论不被本报告推翻。
- RF-07：Linux/macOS 非特权权限拒绝、root 的真实跳过统计、真实 HTTP 传输取消。
- 历史界面验收、macOS plutil、相关生产性能前后基线。
- MCP 弹窗 reload/save 的异步结果归属，以及全局配置多入口的并发提交一致性，需要进一步从完整组件和实际写入入口验证。本轮未将它们认定为新增缺陷。

不要因为上述缺口存在就重复关闭/重开已通过的分项；后续修复应逐项记录复现、失败回归、实现、自动验证及实际平台/界面验收。
