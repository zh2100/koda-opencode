# 剩余 Bug 修复与验证记录

日期：2026-11-07，工作区：`D:\opencode`，分支：`dev`，HEAD：`b80464fbe6cb7f1df67feeaae8887d51b201840b`。

本记录对应本轮“请进行修复”。实施依据为 [第二轮实施方案](D:/opencode/specs/bug-fix-round2-implementation-plan-2026-11-07.md)。历史报告保留其当时结论；当前状态以本记录为准。工作区原有修改保留，未提交，未重启用户正在运行的应用或服务器。

## 1. 状态

| 条目 | 本轮实现与证据 | 尚未完成的验收 |
| --- | --- | --- |
| SET-006 | 认证完整事务和备用凭据读改写使用共享 data 下的进程锁；真实双进程 revision 冲突、独立凭据增删、三个进程退出恢复场景通过 | 路径别名、网络共享、真实系统凭据跨进程组合和长时间进程暂停矩阵未跑；未知所有者锁需人工恢复 |
| SET-005-R2 | MCP 按实际来源读取与写回；保留原始未编辑字段、JSONC 注释和 V1/V2 文件表示；受管、虚拟和内置来源只读 | 浏览器使用隔离生产页面和模拟 HTTP；完整真实后端与多服务器界面矩阵未验收 |
| TASK-002 | 会话持久化 ask/auto/plan；真实 Runner、权限服务和 WriteTool 验证批准、拒绝、取消、自动授权、显式 deny、plan 和普通聊天隔离；服务重建后策略仍生效 | 三模式完整界面验收、真实模型提供商和全部第三方工具矩阵未跑 |
| TASK-004 历史运行恢复 | 运行记录持久化 owner，保留活跃执行者；无执行者 pending/running 收尾为 interrupted，不重放模型或工具副作用；认领后事件发布失败也能收尾 | 完整任务界面验收待执行 |
| TASK-001 专项 | Deferred 控制同项目串行、跨项目并行、取消释放及 resume 失败释放；发布失败后下一任务可执行 | create/prompt 各自失败及手动/自动调度全部交错组合尚未穷举 |
| 原五项界面验收 | 本轮没有把历史自动测试当成界面验收 | 继续待验收 |

以上条目可以标记“代码已实现、所列自动验证通过”，不能整体标记“全部 Bug 已关闭”。

## 2. SET-006：配置与凭据一致性

- `relay-auth.ts` 的迁移、初始化清理、修改、回滚和配置/密钥组合解析，统一在进程内许可与 `data/locks` 的 `relay-auth` 锁内执行。锁内重新读取配置并检查 revision。
- `relay-secret-store.ts` 的备用 JSON 读取、put、remove 使用同一 data 目录中的独立 `relay-secrets` 锁，写入唯一临时文件后原子替换。固定锁顺序为认证锁 → 备用凭据锁。
- 轮换使用新的 UUID 引用，保留“写新引用 → 提交配置 → 清理旧引用”。清理仍被配置引用的密钥会被跳过；NotFound 和 Bun false 按幂等成功处理。
- 旧认证迁移同样通过准备日志创建新的 UUID 引用，不再使用跨数据目录可能重名的固定供应商引用。
- `relay-auth-preparing.json` 在写入新密钥前登记引用。恢复时只清理未被已提交配置引用的记录，日志不保存密钥正文。已提交的 pendingCleanup 继续处理。锁内只清扫本实现命名的遗留临时文件。
- 损坏配置和 I/O 错误不再静默变成空配置；只有文件不存在时才使用默认值。
- `EffectFlock` 只在本机所有者的进程确定不存在时自动回收锁。时间戳过期不能证明一个暂停的进程已经退出。无法识别所有者、远程主机、PID 存活或权限不确定时保留锁；breaker 也不再按年龄抢占。遗留 breaker 和未知锁需要先确认无写入者，再人工处理，不能在活进程持锁时删除。

真实进程测试 `relay-cross-process.test.ts` 覆盖：

1. 两个进程共享 data、使用不同 state，同 revision 提交仅一个成功；冲突方读取新 revision 重试后双方供应商保留。
2. 不同凭据引用并发增删互不覆盖，文件保持可解码。
3. 新密钥写入后、配置提交前退出：恢复保留旧配置/密钥并移除未提交引用。
4. 配置提交后立即退出：恢复保留新密钥，继续清理退休引用。
5. 退休凭据文件替换时退出：恢复幂等完成清理；恢复后的 revision 不额外递增。

进程退出由子进程在真实文件操作边界 `process.exit` 触发，恢复由另一个新进程完成。时间戳测试使用真实存活进程及回拨的锁时间；没有宣称已做操作系统挂起超过陈旧窗口的测试。旧版本写入者不遵守本协议时不具备并发保证。

## 3. MCP 来源编辑

- Legacy Config 记录每个 MCP 条目的优胜来源。读取接口返回 source、version、writable 与配置；文件来源使用原始值，避免把 `{env:...}` 或文件替换结果写回。
- 编辑接口在后端重新加载并确认来源、文件版本和条目仍匹配，只修改提交的 type/command/url。来源不符、外部修改或目标消失会拒绝写入。冲突目前通过原有缺陷错误通道返回，尚无专门的 HTTP 409 错误契约。
- 原始 headers、environment、cwd、timeout、OAuth、命令参数数组和未显示字段保留；切换 local/remote 时移除不适用字段。JSONC 按字段修改，保留其他注释。
- 前端查询键含服务器、项目目录和服务名。保存携带来源与版本，只提交 touched 字段，完成后失效配置和 MCP 查询；旧目标的迟到响应不关闭新目标。
- 不再用临时 `mcp.add` 冒充持久保存；保存后通过已有实例失效机制重新加载。
- 受管文件、mobileconfig、环境/远程虚拟来源及内置默认服务只读，显示已有 i18n 机制提供的说明。

新增 API 位于旧运行时 `/config/mcp/:name`。V2 文件格式通过兼容适配验证；本轮没有给独立 `packages/server` 补全此前不存在的 MCP/Config 体系，不能宣称该独立服务接口已验收。Legacy SDK 已按官方脚本重新生成。

## 4. 任务策略和恢复

- Session.Info 增加可选 approvalMode；任务创建会话时传入，使用 Session.Created 的 metadata 持久化。旧会话省略该字段，未知值校验失败，不默认升级为 auto。
- ask 保留普通权限审批；auto 仅将普通 ask 转为 allow，显式 deny、`question` 和 `external_directory` 的独立审批仍保留。
- plan 使用固定只读能力范围组合原规则。模型工具目录按策略过滤；写工具在真实权限叶节点仍拒绝，即使通过宽松工具目录直接调用，也不产生写入副作用。权限实现保留在统一权限服务和工具叶节点，注册表没有新增执行授权职责。
- 策略限于该会话。服务重建后从数据库读取，普通会话不继承 auto。测试用可控模型输出工具调用，权限服务、Runner 与写工具均为真实实现。
- 新的 run.owner 是可空内部列。调度服务先获取唯一的 scoped owner 锁再认领；恢复检查 owner 锁，其他仍活跃的调度器不会被当成孤儿。
- 启动、tick、runNow 会将无 owner 或确定已失去 owner 的 pending/running 收尾为 interrupted。只收尾，不恢复执行既有模型/工具工作。
- 认领与注册失败收尾之间不可被中断；恢复可中断执行后，发布/advance/执行失败均有收尾。执行互斥锁通过正常退出、错误和取消释放。

新增数据库迁移只添加 `scheduled_task_run.owner`。旧行保留，owner 为 null，迁移日志防止重复执行。生成器检测到了工作区已有 task-orchestrator timeout 默认值漂移，本轮没有将该无关表重建混入迁移，也没有宣称迁移漂移检查完全干净。

## 5. 自动验证

所有测试和类型检查从对应包目录运行。下列批次有重叠，不相加作为唯一测试数。

| 验证 | 结果 |
| --- | --- |
| Core：relay-auth、relay-secret-store、scheduled-task、scheduled-authorization、effect-flock | 56 通过，0 失败 |
| Core：真实双进程及三个退出恢复场景 | 4 通过，0 失败 |
| Core：补齐遗留临时文件清扫后的认证、备用凭据与真实双进程联合复查 | 27 通过，0 失败 |
| Core：旧认证迁移改用准备日志后的认证完整复查 | 18 通过，0 失败，Core 类型检查退出码 0 |
| Core：授权补充直接调用和服务重建验证 | 7 通过，0 失败 |
| Core：旧运行记录 owner 迁移专项 | 通过，包含同一迁移重复执行 |
| Opencode：MCP 来源编辑 V1/V2 文件、受管来源和内置来源 | 4 通过，0 失败 |
| App：MCP form、server-sync、i18n 定向回归 | 55 通过，0 失败 |
| App：隔离生产页面 MCP 编辑/重载和只读来源浏览器回归 | 2 通过，0 失败 |
| Core / App / Opencode / Schema / Server / Client 完整 bun typecheck | 已通过 |
| Client `bun run generate`；Legacy SDK 官方 build 脚本 | 退出码 0 |
| `git diff --check` | 退出码 0 |

**未通过的联合批次不能忽略：** permission、scheduled-task、scheduled-authorization、session-runner、session-runner-tool-registry、tool-write、relay-cross-process 联合运行得到 133 通过、12 失败。失败集中于已有会话测试对 system 数组的精确断言；实际请求包含 HEAD 已存在的“跟随用户语言回复”指令。已单独复现 `reuses one durable baseline after the context producer changes` 的同一差异。没有删除语言指令，也没有修改旧断言使测试变绿；未逐一建立 12 项的修改前运行对照，故保留联合批次失败结论。

主要复跑命令：

```powershell
# D:\opencode\packages\core
bun test test/relay-auth.test.ts test/relay-secret-store.test.ts test/scheduled-task.test.ts test/scheduled-authorization.test.ts test/util/effect-flock.test.ts --timeout 30000
bun test test/relay-cross-process.test.ts --timeout 60000
bun test test/database-migration.test.ts -t 'scheduled run owner' --timeout 30000
bun typecheck

# D:\opencode\packages\opencode
bun test test/config/config.test.ts -t 'MCP source editing' --timeout 30000
bun typecheck

# D:\opencode\packages\app；使用本地独立生产构建预览
$env:PLAYWRIGHT_PORT='4548'
$env:PLAYWRIGHT_SERVER_PORT='4548'
bunx playwright test e2e/regression/mcp-source-edit.spec.ts --workers 1 --reporter line
bun typecheck
```

## 6. 性能与界面证据

会话修改前后均使用生产构建、独立 4547 端口、相同模拟后端、24 个历史轮次、24 个增量、CPU throttle=1、旧布局、单 worker。修复了性能测试配置误收集 Bun unit 测试的问题后，两次基准均通过。

| 指标 | 修改前 | 修改后 |
| --- | --- | --- |
| 首次内容观察时间 | 505.4977 ms | 650.0196 ms |
| 完成观察时间 | 6522.5 ms | 6195 ms |
| RAF gap P95 | 33.336 ms | 33.3 ms |
| 行/Markdown 节点替换 | false / false | false / false |
| 空白样本 / 最大滚动距离 | 0 / 0 px | 0 / 0 px |
| 完成增量 / 剩余增量 | 24 / 0 | 24 / 0 |

记录：[修改前](D:/opencode/specs/bug-fix-before-performance-2026-11-07.json)、[修改后](D:/opencode/specs/bug-fix-after-performance-2026-11-07.json)。各一次样本，只能说明该场景完成且未出现上述显示问题，不能据此声称性能改善或无回退；未开启 raw trace/profile，不能替代完整性能验收。

MCP 浏览器测试使用本地生产页面 `127.0.0.1:4548` 和隔离浏览器上下文，HTTP 为可控模拟，覆盖编辑字段提交、保存后重开读取、只读来源禁用保存。测试预览进程已停止。用户原有应用和服务器没有重启。

仍须补齐原五项界面验收，以及真实后端下的供应商/模型列表刷新、双服务器切换、MCP 来源覆盖、任务运行与三模式审批流程。上述未执行项继续保持待验收。
