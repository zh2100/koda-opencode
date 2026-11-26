# 原始 26 条 Bug 与后续修复的复核报告

> 后续已实施部分剩余修复，当前代码与验证状态见 [剩余 Bug 修复与验证记录](D:/opencode/specs/bug-fix-implementation-results-2026-11-07.md)。本文保留复核当时的结论，不作为最新关闭状态。

后续实施入口：[剩余 Bug 记录、解决方案与实施步骤](D:/opencode/specs/bug-remaining-fix-plan-2026-11-07.md)。该方案尚未实施，不改变本报告的复核结论。

日期：2026-11-07（Asia/Shanghai）  
对象：`D:\opencode` 当前工作区，包括已有未提交修改。  
性质：代码审查、包内自动回归及隔离复现；未执行真实界面验收，未重启应用或服务器。

依据：[原始审计](D:/opencode/specs/bug-audit-2026-11-06.md)、[原实施方案](D:/opencode/specs/bug-fix-implementation-plan-2026-11-07.md)、[认证清理与重连补充方案](D:/opencode/specs/bug-fix-followup-plan-2026-11-07.md)。这些历史文档中的待修复／待实施状态不是当前实现状态，本报告单独记录本轮结果，不改写历史证据。

## 1. 结论

不能认定所有 Bug 均已修复。

- 原始问题中，SYNC-001、SYNC-005、SYNC-007、ATT-003 仍能隔离复现；SET-005 还有源码调用链确认的编辑表单阻塞路径。
- SET-006 的同进程并发修复已有回归，但跨进程共用数据目录问题仍存在；TASK-002 传递了完整 Prompt、effort 和 plan agent，但 ask/auto 尚未映射为不同的执行授权策略。
- 其余条目能看到修复实现或相关回归证据，但专项测试与界面证据并不齐全，不能统一标为已验收。
- 后续认证清理与重连的既有修复回归本轮继续通过；这不能替代对原始其他刷新路径的检查。

本轮相关测试 280 项通过：App 185、Core 84、旧运行时 10、Server HTTP 1。Core、App、Server、Opencode 四个包的 `bun typecheck` 均通过。数量表示本轮实际运行的用例，不表示每个原始 Bug 都有专项回归，也不表示仓库全部测试通过。

## 2. 仍有缺陷的条目

### 2.1 SYNC-001 / P1：重叠快照仍可清除新权限提示

位置：[bootstrap.ts:105](D:/opencode/packages/app/src/context/global-sync/bootstrap.ts:105)、[权限合并与标记释放](D:/opencode/packages/app/src/context/global-sync/bootstrap.ts:500)。问题快照采用同类结构，需一并修复；本轮直接复现的是权限路径。

复现使用真实 `createServerSession`、`permission.asked` 事件处理和 `bootstrapDirectory`，仅替换网络响应：

1. 旧目录刷新 A 开始，权限列表请求保持未完成。
2. 收到新权限申请，实时列表中出现 1 项权限。
3. 新目录刷新 B 返回包含该权限的快照并完成。
4. B 的 `releasePromptBaseline()` 删除了 A 仍依赖的事件标记。
5. 放行 A 的旧空快照，`promptChanged()` 看到标记不存在，允许清空权限列表。

观测结果：B 完成后待审批数为 1，A 完成后变为 0。

建议：事件版本应具有足够长的生命周期，不由某一请求完成时直接清除仍被其他请求依赖的标记；同时保护快照代次，并隔离服务器与目录作用域。补充 A 请求 → 新事件 → B 完成 → A 完成的回归，权限和问题各覆盖一次。

### 2.2 SYNC-007 / P2：真实 Mutation 生命周期中，队列恢复调用仍过早

位置：[server-sync.tsx:1060](D:/opencode/packages/app/src/context/server-sync.tsx:1060)、[queue.ts](D:/opencode/packages/app/src/context/global-sync/queue.ts)。

现有修复在 `onSettled` 中调用 `queue.resume()`，但 TanStack Mutation 此时仍是 pending。队列的 paused 判断依赖该状态，因此 resume 提前返回；随后 Mutation 变为 success/error，没有另一个必然触发的恢复入口。

复现使用真实 `MutationObserver` 和 `createRefreshQueue`：保存期间入队一个目录，保存结束后没有其他事件。结果为 `pendingAtSettled=true`、保存完成后 pending=false、目录刷新调用次数=0，预期为 1。

建议：在实际暂停状态从 true 变为 false 后恢复队列，不能仅把 onSettled 当成状态已经切换的通知。补充实际 Mutation 成功和失败两种情况的集成回归。

### 2.3 SYNC-005 / P2：父目录刷新发现删除时，没有清理子目录加载状态

位置：[tree-store.ts:82](D:/opencode/packages/app/src/context/file/tree-store.ts:82)。

新增 `removeDir()` 已覆盖显式 watcher 删除路径，但 `listDir()` 在父目录快照中发现子目录消失时，仍只删除 node 和后代 node，没有清理对应 dir 状态及请求代次。

复现使用真实 `createFileTreeStore` 和内存目录响应：加载 dir/old.ts → 父目录返回空列表 → 父目录再次出现 dir → 展开 dir。结果为 `dirReads=1`、`loaded=true`、`children=[]`，没有读取 dir/new.ts。

建议：父目录差异处理与显式删除共用完整的目录失效逻辑，清理所有后代加载状态并拒绝旧请求。测试不能只调用 removeDir 后检查结果，还必须覆盖父目录快照发现删除的入口。

### 2.4 SET-005 / P2：配置加载前编辑 MCP 表单，会阻塞后续初始化和保存

位置：[dialog-mcp-v2.tsx:43](D:/opencode/packages/app/src/components/settings-v2/dialog-mcp-v2.tsx:43)、[保存按钮](D:/opencode/packages/app/src/components/settings-v2/dialog-mcp-v2.tsx:178)、[编辑入口](D:/opencode/packages/app/src/components/settings-v2/mcp.tsx:89)。

证据等级：源码调用链确认，未执行界面复现。

编辑窗口初始 ready=false。配置未完成加载时，类型、命令、URL 控件仍可操作，操作后 dirty=true；配置随后加载成功，初始化 effect 因 dirty 提前返回，唯一将 ready 设为 true 的分支不再执行。保存按钮一直因为 !ready 而禁用，只能关闭重开。

父页面编辑按钮没有等待配置 ready 的条件。配置读取失败后 bootstrap 的完成状态与配置成功状态也应区分，避免用空配置完成初始化后无法重新回填。

建议：区分配置加载完成、表单初始值和用户草稿三种状态；配置加载完成可以解除保存门槛，同时不覆盖用户输入。或者在初始配置完成前禁用编辑，并提供加载失败重试。补充慢配置、先输入后返回、失败后重试的组件回归。

### 2.5 ATT-003 / P2：重复空列超过 256 时，ODS 仍发生列错位

位置：[Core office-text.ts:265](D:/opencode/packages/core/src/util/office-text.ts:265)、[旧运行时 office-text.ts:265](D:/opencode/packages/opencode/src/util/office-text.ts:265)。

两个实现当前内容相同，都将 `table:number-columns-repeated` 用 Math.min 截断到 256，然后继续拼接后续单元格，静默改变实际列位置。

本轮使用 314 字节的 ODS 归档：300 个重复空单元格后跟 Value。Core 和旧运行时均将 Value 输出到第 257 列，正确位置应是第 301 列。

建议：资源限制可以明确拒绝超限输入，或用有界且保留坐标的表示；不能截断空列后继续把后续值当作原位置输出。行重复也使用相同截断策略，应一起核对。

## 3. 原始 26 项逐项状态

“相关回归通过”仅指本轮对应测试文件通过；“专项待验”表示没有获得完整的原场景验证证据。所有依赖实际界面的项目仍是界面待验收。

| 编号 | 当前实现／证据 | 本轮结论与剩余工作 |
| --- | --- | --- |
| SET-001 | models.tsx 以同一存储键共享 store，并发布持久化写入；持久化相关测试通过 | 修复实现已见；两个真实 ModelsProvider 的挂载、隐藏后写 recent/variant、重新打开设置的专项及界面证据仍不足 |
| SET-002 | Auth handler 提交后同步目录；目录供应商地址更新和删除回归通过 | 后端修复有回归；聊天保持打开时的列表更新待界面验收 |
| SET-003 | setVisible 使用 visibilityWrite 串行，并保留服务器作用域检查 | 原乱序写路径已有修复；现有 use-relay-settings.test.ts 主要验证 ID、URL、错误映射，不等于真实 hook 并发回归 |
| SET-004 | 新版供应商页和模型页均使用 SettingsServerScope | 作用域修复已见；双服务器保存、删除、切换及迟到响应待专项／界面验收 |
| SET-005 | V2 已读取全局配置，查询回归通过；表单增加 ready/dirty | 仍有加载前编辑造成永久未就绪的路径，见 2.4 |
| SET-006 | 进程内 permit 保护读取、revision 校验和提交；相关认证测试通过 | 部分修复；多个进程共享数据目录仍未解决，不可关闭完整并发问题 |
| SET-007 | 目录按供应商代次和凭据变化保护；慢旧请求及不同供应商并行回归通过 | 后端原场景有修复证据；界面待验收 |
| SYNC-001 | 已增加事件版本保护 | 重叠刷新仍会丢权限提示，见 2.1 |
| SYNC-002 | 首次加载和重连有状态版本合并；后续请求重新采集基线 | 相关回归通过；实际断线恢复和双服务器界面待验收 |
| SYNC-003 | Agent 刷新由 ensureQueryData 改为 fetchQuery，并有代次保护 | 实现修复已见，接口查询回归通过；新增、改名、删除 Agent 的完整事件到界面路径待验 |
| SYNC-004 | 目录 forceAgain、文件 fileForce 记录在途强制刷新需求 | 修复实现已见；watcher 回归通过，但不等于 FileProvider 完整慢请求／作用域切换回归 |
| SYNC-005 | 显式删除有 removeDir 和代次处理 | 父目录快照发现删除的原场景仍失败，见 2.3 |
| SYNC-006 | 重连调用 loadSessions(force=true)，绕过 sessionMeta 早退 | 修复实现已见；目录列表回归通过，断线期间增删／归档的真实侧栏路径待验 |
| SYNC-007 | 增加 queue.resume，并在保存 onSettled 调用 | 实际 Mutation 生命周期仍提前返回，见 2.2 |
| SYNC-008 | bootstrapDirectory 返回实际 Promise；Agent／command 写回有代次校验 | 主刷新路径修复已见，bootstrap 与 queue 测试通过；其他直接 command 写入口和完整联动仍需验收 |
| SYNC-009 | 消息强制刷新在同一读取循环中补刷 | server-session 相关回归通过；实际断线恢复待界面验收 |
| SYNC-010 | 重连强制补刷消息与 todo，保留失败目标；每轮允许重新补刷 | server-sync 相关回归通过；真实消息／待办完成状态待界面验收 |
| TASK-001 | perform 整段置于项目键互斥范围，覆盖 create、prompt 和 resume | 实现修复已见；当前 scheduled-task 测试没有可控执行边界下的同项目互斥、跨项目并行、失败释放完整验证 |
| TASK-002 | 传递 task.prompt、effort variant，plan 选择 plan agent | 部分修复；ask 与 auto 在执行入口没有区别，实际工具授权路径仍未关闭 |
| TASK-003 | nextDaily 使用 task.runAt 作为原始时分锚点；夏令时、回拨、跨月、追赶测试通过 | 原时间漂移有自动回归证据；调度整体时钟／运行去重集成验收仍独立记录 |
| ATT-001 | txt/md/csv 文本附件走文本规范化，不再直接作为媒体；消息转换测试通过 | 原基础场景有修复证据；大文件、损坏编码、完整文件 URI 组合覆盖不足 |
| ATT-002 | 两份解析器均有 256 条目、8MiB 单条目、16MiB 总量限制 | 代码限制已见；有效 DOCX 的 256/257 条目边界已隔离验证；未做完整输出上限、恶意归档及性能专项，不标为全面验收 |
| ATT-003 | 已处理自闭合／覆盖单元格和小规模重复列 | 大于 256 的重复空列仍错位，见 2.5 |
| ATT-004 | 已按代码页聚合转义字节，CP936 中文样本通过 | 原 CP936 样本有修复证据；全部代码页、损坏编码和复杂分组未完整覆盖 |
| IMG-001 | 官方 OpenAI 地址的 GPT Image 请求省略 response_format | 修复实现已见，图片相关回归通过；自定义兼容服务能力和真实上游仍待验，不能宣称所有代理均兼容 |
| IMG-002 | 普通 key 的 Gemini 分支设置 x-goog-api-key，其他协议保留 Bearer 路径 | 修复实现已见，Gemini 协议／工具相关回归通过；真实凭据、原生服务与兼容代理的组合仍待专项验证 |

## 4. 后续认证与重连修复状态

本轮继续检查了认证清理与重连实现，并运行了相关新增回归：

- 新引用写入 → 配置提交 → 旧引用清理的顺序，以及提交失败保留旧凭据。
- 双后端删除；清理失败保留记录；相同 operationId 重试只补清理。
- NotFound 异常、Bun delete 返回 false 的幂等处理。
- HTTP 对已提交且清理未完成的操作仍返回 AuthState，不暴露内部 cleanupPending 字段。
- 每次实际网络请求记录自己的状态版本基线。
- 补刷期间到来的重连继续下一轮；失败目标存入独立 retry 集合。
- 新快照发现的会话失败后变为 idle，下一次仍能重试。
- 每轮补刷分别去重，后续轮次可以再次刷新同一会话。

这些目标路径的现有回归继续通过，本轮未在它们的既有复现场景中发现新的失败。但原始 SYNC-001 的权限快照和 SYNC-007 的设置 Mutation 恢复属于其他调用路径，不能据此前者通过而关闭后者。

## 5. 本轮自动验证记录

### App

工作目录：`D:\opencode\packages\app`。

```powershell
bun test --timeout 30000 --tsconfig-override ./tsconfig.test.json --conditions=browser --preload ./happydom.ts --only-failures ./src/utils/persist.test.ts ./src/hooks/use-relay-settings.test.ts ./src/hooks/provider-catalog.test.ts ./src/hooks/use-providers.test.ts ./src/context/server-session.test.ts ./src/context/server-sync.test.ts ./src/context/global-sync/bootstrap.test.ts ./src/context/global-sync/queue.test.ts ./src/context/file/watcher.test.ts ./src/components/file-tree.test.ts ./src/context/local-agent.test.ts
bun typecheck
```

结果：185 pass、0 fail，396 次断言；类型检查通过。

### Core

工作目录：`D:\opencode\packages\core`。

```powershell
bun test --timeout 30000 --only-failures ./test/relay-auth.test.ts ./test/relay-catalog.test.ts ./test/relay-secret-store.test.ts ./test/scheduled-task.test.ts ./test/session-runner-message.test.ts ./test/image-generation.test.ts ./test/tool-image-generation.test.ts
bun typecheck
```

结果：84 pass、0 fail，330 次断言；类型检查通过。

### 旧运行时

工作目录：`D:\opencode\packages\opencode`。

```powershell
bun test --timeout 30000 --only-failures ./test/util/office-text.test.ts ./test/util/office-file.test.ts
bun typecheck
```

结果：10 pass、0 fail，27 次断言；类型检查通过。

### Server

工作目录：`D:\opencode\packages\server`。

```powershell
bun test --timeout 30000 --only-failures ./test/relay-auth-handler.test.ts
bun typecheck
```

结果：1 pass、0 fail，33 次断言；类型检查通过。

### 额外隔离复现

通过 stdin 运行真实实现，未写入业务代码或永久测试文件：

| 场景 | 实际结果 |
| --- | --- |
| 重叠权限快照 | 新快照后权限数 1，旧空快照后 0 |
| Mutation onSettled 恢复队列 | onSettled 时 pending=true；最终 pending=false，但刷新次数 0 |
| 父目录删除后重建 | 子目录只读取 1 次，loaded=true，children=[] |
| ODS 300 个重复空列 | 314 字节样本；Core 和旧运行时均把第 301 列数据移到第 257 列 |
| 有效 DOCX 256/257 条目边界 | 256 条目返回 readable，257 条目被拒绝 |

上述前四项失败场景应转成正式回归，再修改实现；不能用现有测试通过覆盖这些失败证据。

## 6. 未完成的验收和建议顺序

1. 优先修复 SYNC-001，避免任务等待授权时界面提示消失。
2. 修复 SYNC-007，确保真实保存成功和失败后都能恢复刷新队列。
3. 修复 SYNC-005、SET-005、ATT-003，并补对应真实入口的回归。
4. 单独设计并验证跨进程配置写入策略，不把进程内互斥当作跨进程解决方案。
5. 明确 TASK-002 的 ask/auto/plan 语义并执行受控工具测试；补 TASK-001 的同项目串行、跨项目并行与失败释放测试。
6. 补模型偏好双实例、模型勾选真实 hook、双服务器切换、MCP 慢加载和文件内容慢请求等缺失专项。
7. 使用独立数据目录及端口完成界面验收，不停止或重启当前应用。
8. 会话代码修改前的生产性能基线此前未记录，本轮也未补做前后比较；不能用当前结果伪称修改前基线。若要补证，需要可验证的修复前代码快照和一致环境。

本次只新增此报告；未修改业务实现、未提交代码、未重启应用。该审查覆盖已记录的 26 条及后续认证／重连修复，不构成“整个仓库不存在其他 Bug”的保证。
