# 七项缺陷分阶段实施记录

实施入口：`seven-bugs-fix-implementation-plan-2026-11-15.md` 第 5 版。

本轮 HEAD：`6b051f12a21094df1adef83f9fddfcbb765b319e`。原有未提交内容保留，未提交、未推送、未重启现有应用、未访问生产凭据、未修改生产标记。

证据根：`C:\Users\zh2100\AppData\Local\Temp\seven-bugs-20261115-036ea436c30e42c58c666d0d50cb3ed2`。全工作区 6964 个文件的输入摘要、完整 Git 状态、暂存状态和 index 摘要见 `P0/manifest-input.json`；没有复制源码作为备份。

## P0：隔离基础设施

- 新增只依赖 Node 内建模块的 `script/test-isolation.mjs` 和外层 `script/test-isolated.mjs`。启动前建立独占根、清理继承覆盖和凭据环境，设置 home、XDG、tmp、managed config 与内存数据库。
- 导入前检查资源注册、路径边界、最近已有祖先的 realpath、显式 Global 覆盖与环境/注册漂移。协议描述的语义校验复用真实只读 ResourceRoot/LockProtocol；不在 preload 中提前导入 Global 并冻结后续旧 HTTP 文件的路径选择。
- Core/Server preload 在产品导入前重新准入。四个重选路径的旧 Server HTTP 文件在其首次产品导入前调用 loadGlobal，执行准入和导入后核对；它们仍须各自单进程运行。
- I01–I03 守卫测试 12 pass；真实 Core Global/layer 检查 1 pass；Server isolation 1 pass。Core 类型检查通过。
- `P0/legacy-server.log` 的旧认证 HTTP 批次为 3 pass、1 fail、1 error。进一步复核原始日志确认：首测把应用冷启动算在 5 秒用例预算内，超时后正文继续，下一测试写入使首测随后读到 revision=7，而自身响应是 6。没有放宽版本断言；改为 beforeAll 请求真实 auth 路由完成服务 readiness 后，再开始变更用例。30 秒只界定冷启动 hook，业务用例仍保留原时间预算。该失败及后续复跑均保留，不将超时后正文的交错计为产品精确重放证据。

读取审计：守卫导入图仅为 Node 内建模块。ResourceRoot 的只读选择链涉及 LockProtocol、LockIdentity、FSUtil、其 Effect/LLM 服务声明及通用工具；没有在模块求值时执行其服务层或 remember。损坏协议与不匹配注册的子进程测试均在 Global 入口哨兵之前拒绝，且未创建产品 data 目录；匹配的隔离原生协议注册只执行选择，不加载原生锁或获取业务锁。

## P1：凭据错误与取消生命周期（本机自动门禁通过）

首次新测试运行存在 Auth 测试层缺少 Global 的夹具错误，记录保留为 `P1/first-failure.log`，不作为产品复现。修正夹具并收紧取消观察后，正式红批次 `P1/red-final.log` 为 19 pass、36 fail；失败包括结构损坏变 Die、系统不可用变 KEY_MISSING、set 尚未结束就完成取消。

已修改：

- RelaySecretStore 使用 effectful 解码，语法/结构/IO 失败统一映射为不携带原文的 UnavailableError。系统读取保留成功、明确不存在和不可用身份；空值不能确认不存在，系统成功不额外读取文件。
- 引入窄的 SettledIO.drain：投递前检查取消，已投递 IO 等待真实完成，完成后先处理取消，再暴露结果或允许 fallback。失败也在屏蔽区内先转为 Exit，防止拒绝路径绕过取消检查。
- journal、凭据文件、认证 tmp/next/final 发布、删除和回执密钥写入采用上述完成边界；使用会传播 chmod 失败的 writeWithDirs，不改变全局 FSUtil 行为。
- preparing 恢复不再 ignore 清理错误；去掉重复的 discardUnused 清理入口。收尾显式合并正文/中断和清理失败，因为当前 Effect.onExit 的清理失败会替换正文原因。
- 正常 typed 错误收集使用 Effect.result，避免把中断当成可吞掉的业务失败。

最终 P1/P2 Core 联合验证 131 pass、0 fail、750 个断言；正式 TCP 验证 10 pass、0 fail、367 个断言，包含 S03 七种损坏输入和 A07/A08/O24–O29。Core、Server 类型检查均退出 0。S01–S17 的真实 Auth、文件 fallback、受控系统适配器、各写入/发布/取消/退出/恢复边界均在正式回归中；未调用本机真实系统凭据，不据此声称原生凭据跨平台验收。

## P2：删除重放（本机后端门禁通过）

- 兼容与受保护删除统一匹配不可变命令证据；kind、目标、原 revision、expectedEntityId 的有无和值均参与核对。清理 journal/result 不能证明删除成功。
- 普通证据有界淘汰；受保护删除按服务生命周期保留。真正原子发布时登记证据，后续取消或清理失败不丢失已提交事实。重放只返回最新安全快照，不再次删除同名后继。
- 重启/证据淘汰后，原冻结请求保守冲突；创建既有持久化签名回执继续单独验证。新 capability 在本阶段仍未声明。
- 旧测试断言修正：同一删除重试必须使用原 DTO，改 revision 先断言冲突；跨服务清理完成不再冒充原业务确认。B118 的 final rename 已投递后取消按排空规则等待实际完成，保留取消并验证实际提交；发布前失败对照保留原字节。
- Core 六文件联合 131 pass；正式 TCP 10 pass；旧完整 Server 文件各独立进程：auth 4 pass、commit 8 pass、probe 1 pass、catalog lifecycle 2 pass。旧批次首次冷启动超时日志保留；初始化移至 beforeEach 的真实 auth readiness，业务用例仍为 5 秒。请求指定本轮隔离项目目录，避免启动仓库项目 watcher；重建服务语义保留。

## P3：刷新责任与勾选回读（本机自动及隔离页面门禁通过）

当前固定页面候选摘要：`2bc31f9aa84a280bf0a54a119b9386270dd7d197e44853d775159553038aefb6`。本阶段启用真实 `vendor-commit-baseline-v1`，只允许在原冻结 DTO、原始 R/V 与双端能力均有效时推导提交水位；最新安全快照不是原命令提交版本。

- 按实体保留目录同步、上游刷新、勾选回读三类责任。名称/空补丁不再使连接刷新退休；清钥、换地址、删除重建及生命周期变化按各自水位退休旧责任。
- 每实体最多两个实际未结束 HTTP 加一个最新排队请求。请求/排队/动作使用绝对预算，正文也受取消与截止时间约束；忽略 abort 的 transport 不虚假释放槽位。
- mutation FIFO 与后续目录读取分开。勾选 ACK 的回读按最新 fence 接续；稳定失败保留只读重试，新的 ACK 到来时不会丢唤醒。退休操作的晚到错误不能影响新实体或后来弹窗。
- 未知写入保留原编号和原 DTO；不自动换编号重放。真实 hook + 正式 TCP 验证 save/clear 在提交后丢 ACK、全局版本推进、重新读取及显式原命令重试，新密钥不被旧 clear 删除。

最终验证（各批次有重叠，不相加当作独立覆盖数）：前端八文件 154 pass；Core 七文件 142 pass；正式 TCP 10 pass；真实 hook + TCP 2 pass；transport 6 pass；经典/现代页面 26 pass。App、Core、Server、relay 测试和 E2E 类型检查均退出 0。证据见 `P3/checks.json` 与 `P3/matrix.md`。

页面批次 `page-with-http-sixth.log` 使用一个固定候选，workers=1、retries=0；结束时源码摘要一致。核对 auth/catalog 的实际磁盘内容、HTTP、前端和页面。两台隔离服务器使用独立 data 根，已等待 SIGTERM close；端口 44096/44097/44098/44100/44110 均已释放。运行数据根暂保留为证据，不称已删除。

复现及修正记录：逐阶段勾选矩阵复现了退休失败逃逸、清钥取消旧回读仍抛冲突，均先记录失败再修复。原经典 Servers 切服用例的后端是 v2，而经典布局明确过滤 v2；改用现代真实 server picker 验证 A→B→A，不改退役逻辑。旧请求在切服后被正确取消，因此晚响应用例只让该 refresh transport 忽略 abort，以验证真实后端晚响应隔离。页面早期批次及一次源码运行中漂移的结果保留，不计入最终门禁。O29 重建服务时初始化已完成清理后，原冻结 R 返回 REVISION_CONFLICT；尚有 pending 的阶段仍断言 REQUEST_CONFLICT，未放宽磁盘、凭据或版本断言。

## P4：调度准入、错误分类与完整载荷（本机自动门禁通过，统一验收待执行）

- 按真实阶段区分配置错误与临时执行错误；RateLimit/Transport/ProviderInternal/无效输出不暂停计划，歧义 ModelUnavailable 保守不暂停；新增安全 TASK_EXECUTION_FAILED，不扩大会话公开错误类型。
- 同任务短状态及发布区段排序，重读当前 task；任务 epoch 防止旧失败停用新计划。自动认领与推进在同一 SQLite 事务；同槽历史尝试仅推进，不重放会话、工具或旧通知。
- 通知失败保留内部 Cause/未恢复责任，不重写已完成run，不整批重放部分交付。SettledIO 清理合并正文、取消与cleanup原因。
- Session日志与Step/Tool失败完整载荷安全化。托管工具使用协议白名单重建失败语义和引用，未知/损坏格式在下一请求前typed拒绝；成功路径保留。
- 真实 SessionExecution→runner→loopback 429、真实 SecretStore/Auth/resolver 临时失败，以及纯defect、interrupt+defect、typed+cleanup defect均进入回归。

最终 Core 联合294 pass、0 fail、1614断言；LLM历史与两协议联合95 pass、0 fail；Schema10 pass。App/Core/LLM/Server/Schema/Client/旧SDK包内类型检查通过，两套客户端正式生成。T01–T20子场景索引见P4/matrix.md，包含终态发布九组合、36种同槽历史记录及实际服务重建。任务页不展示run.error，新code经公开Schema及SDK可解码；不捏造错误页面通过。

Session修改前后均跑同条件生产构建性能测试，两布局各通过，40个增量全部消费，无行/Markdown重挂载、无底部漂移或空白采样；耗时存在机器噪声，不声称性能提升。44120预览端口已释放。

首次联合导入错误、cassette缺语言system消息、夹具错误及全部复跑日志保留。cassette只补确定请求，response录制字节未改，并强制replay避免付费上游。最终结果不覆盖历史失败。完整页面/API/数据库统一验收留给P6。

## P4 后阶段记录（历史，最终结果见 P5/P6）

以下为当时的阶段状态，已由后文最终结果取代：P5、P6尚未完成。P5正在按原F01–F36实施配置来源/目标/引用/锁/两阶段任务/typed HTTP与handoff闭环；P4结果不能代替P5。

P5容量实现决策：1024 上限同时约束实际保留的各代域/步骤责任，而不只数去重后的键；否则同一 owner/step 的重复失败可以无限增加记录。每代预留在成功或有同责任 covered 证据后释放，容量满时新 mutation 在 admitted 前拒绝，不淘汰旧失败，也不额外执行 PATCH。该保守上限意味着同域连续失败也可能达到容量；记录仍是服务内存责任，不声称有跨进程恢复。

P5共享调用方盘点补充：`src/config/tui-migrate.ts` 的自动迁移也会剥离并改写 `opencode.json/jsonc`，此前没有经过 ConfigDocument。为满足原方案 F13/F29 的“同版本不能有绕过门禁的写入者”，将该文件、`tui.ts` 的依赖装配和 `tui.test.ts` 的互斥/legacy 别名样本登记为必要依赖。先运行失败回归，再将可选迁移放入同一文档的非等待租约，租约内重读、原子替换，并排空已投递 IO。保留既有迁移备份语义，不对用户原文件执行迁移；测试只用本轮隔离根。锁序仍是单文档，不获取项目 selection 锁。

Git 证据补注：P0 的 index 原始字节摘要后曾因普通 git status 刷新 stat 缓存而变化，未发生暂存语义修改。P4/index-refresh.json 保存核对；后续快照统一 GIT_OPTIONAL_LOCKS=0，并同时记录 ls-files --stage -z 语义摘要。不能把该缓存刷新写成 index 字节全程不变。历史R3-03B、RF-07跨平台状态不变。未提交、未推送、未重启当前应用。

## P5：配置来源与提交后收尾（本机门禁通过）

项目PATCH与加载器共用来源、目标及raw/effective投影。锁前预取远程，选择锁和排序文档锁内重读与最终复检；冻结后变化明确拒绝，不自动换路径/重放。PATCH先无副作用预检、禁loader可选写，typed HTTP与两套正式SDK已更新。

共享门禁覆盖project/MCP/global/image及schema/default/TOML/TUI。TUI两条真实红测复现绕锁和legacy alias改写，已改为锁内重读、原子发布及已投递IO排空；取消回归证明实际发布结束前不释锁。未迁移用户文件。

InstanceWork区分preparing/admitted，关闭先停生产者再排空；提交后责任独立登记，一般hook不重放，明确幂等最多两次；失败、covered和容量只在同owner/step处理，诊断溢出不丢责任。

配置联合365pass；Core68pass1平台skip；正式配置TCP43pass1平台skip；图片正式入口2pass，均0fail。Core/OpenCode/Server/App/Client/旧SDK类型退出0，两SDK生成成功。逐F01–F36及锁序见P5/matrix.md。Windows不适用的POSIX样本不计通过。TCP prepare/unknown窄注入仅证明入口映射，底层由Core真IO证明。全部历史失败保留，P6尚未完成。

P6必要验证登记：补Server正式scheduled-task handler的TCP/SQLite/Event对账；仅Session执行边界受控注入，真实runner→loopback由Core wire套件另证。任务页不展示run.error，只验适用任务与开关状态。


## P6：同候选统一验收完成（Windows 本机范围）

最终测试候选为 `d7a2f6ccb30bc28c1c7ec11ce242b6bf559c8fc79918b893b93d357582d7760e`。候选覆盖源码、测试和两套生成物；自动门禁与最后页面批次期间文件摘要完全一致。报告与方案状态在验收之后更新，单独记录为交付文档差异，不能把文档更新伪称测试时的原候选。

123 个登记行（I 3、S 17、A 8、O 29、V 10、T 20、F 36）均保留原场景和断言，逐项关联 `P6/matrix.json`、`P6/matrix.md` 及阶段子样本索引。本机适用子场景通过；两个 POSIX 权限用例在 Windows 上由框架 skip，未计为通过。

| 最终批次 | 结果 |
| --- | --- |
| 导入前隔离守卫 / Core 准入 / Server 隔离 | 12 / 5 / 1 pass |
| 凭据、认证、创建、删除与重放 | 142 pass |
| 调度、权限、实际 runner、错误载荷及取消 | 294 pass |
| 共享文档、原子发布和锁生命周期 | 68 pass、1 平台 skip |
| 配置来源、目标、TUI迁移及 InstanceWork | 365 pass |
| 配置正式 TCP、断连、重建及收尾 | 43 pass、1 平台 skip |
| Server 正式 relay TCP / 旧 auth / commit / probe / catalog | 10 / 4 / 8 / 1 / 2 pass |
| 图片正式 HTTP / 调度正式 HTTP | 2 / 1 pass |
| 前端实际设置状态 / 真实传输边界 | 154 / 6 pass |
| LLM 最终供应商协议 / Schema | 95 / 10 pass |
| 两布局实际页面与适用调度页 | 27 pass，workers=1、retries=0 |
| 页面批次真实 hook→正式 TCP | 2 pass |

各批次可能覆盖同一行为，不相加当作独立覆盖数。29 个自动执行/类型门禁全部退出 0。Core、OpenCode、Server、App、LLM、Schema、Client、旧 JS SDK 的包内类型检查，以及 relay 测试和 E2E 专用类型检查均通过。两 SDK 的正式生成证据在 P4/P5；P6 固定并检查生成物摘要，没有手改生成文件。

四层对账：设置页将真实返回、auth/catalog 持久文件、hook 状态和指定实体页面对应起来；项目配置走正式 PATCH→目标磁盘→handoff 后有效 GET→实例销毁重建 GET，保留 ACK 后旧 GET 窗口的明确证据；调度经真实 store/SQLite/公开 handler 返回与实时 EventV2 监听者对账。调度更新事件是实时发布，不声称其存在于持久 EventTable 中。实际 runner→loopback 429、真实模型/凭据错误与后续正常运行由 Core wire 测试另行验证；Server 新用例只在 Session 执行边界注入限流，不冒充完整 runner。任务页面不展示 run.error，页面只核对项目内的任务、启用动作及公开状态，没有虚构错误文案通过。

首次联合页面为 26 pass、1 fail：新增调度用例从首页打开设置，实际呈现“Open a project to get started”，未进入项目。改为隔离项目路由后专项通过，再在最终候选完整重跑 27 pass。新增 Server 夹具经历包导入、依赖输出、错误持久化事件假设及测试 API 名称的修正；全部首次失败保留，未放宽产品错误/磁盘/版本断言。最后 Server 包类型检查和正式 HTTP 均通过。

P4 的 Session 生产构建 before/after 两布局性能门禁保留：40 个增量均消费、无重挂载/漂移/空白。P5/P6 未再次修改 Session/Timeline 执行或显示逻辑，不以噪声耗时宣称提速。

| 缺陷 | 当前结论 | 保留边界 |
| --- | --- | --- |
| SECRET-SCHEMA-01 | 本范围本机自动/集成验收通过 | 系统凭据为受控适配器，不声称原生跨平台验证 |
| SECRET-CANCEL-01 | 本范围本机生命周期/恢复验收通过 | 已投递 API 挂住时必须继续持有责任；无记录历史孤立凭据不自动清理 |
| AUTH-REPLAY-01 | 本范围本机正式 TCP 验收通过 | 普通命令证据不承诺跨重启/淘汰无限重放 |
| OBS-01 | 本范围本机两布局验收通过 | 不合作 transport 的实际未结束槽位不伪释放；有限等待与显式重试 |
| UI-VIS-01 | 本范围本机两布局与磁盘对账通过 | 保留实体/服务器/生命周期身份门禁 |
| TASK-ERROR-01 | 本范围本机实际 runner、协议/API/DB/事件验收通过 | 不自动重试旧 run、不承诺跨进程顺序/客户端必达；未知托管格式安全拒绝 |
| ACC-F02 | 本范围本机配置/共享入口/断连验收通过 | 不自动导入 config.json；非合作外部写入者及其他平台边界保留 |

这七项的本机结果不能外推为项目所有潜在 bug 已消失。R3-03B、RF-07 跨平台，以及本方案外的历史事项保持原状态。未提交、未推送、未改版本、未重启用户应用、未写生产迁移标记、未访问付费模型。


最终清理：已核对并删除本轮登记的 204 个隔离数据根，先解除 reparse 链接再删除自身目录，未遍历链接目标；日志、摘要、trace、截图与方案证据根保留。18 条历史/当前自建后端登记均核对进程身份，没有仍运行的对应后端；44096/44097/44098/44100/44110/44120 端口释放。详情见 P6/cleanup-results.json、process-audit.json、ports.json。

暂存语义与 P0 保持一致，未删除任何原有基线文件；最终测试期间全部候选文件摘要一致。测试后的交付差异只包括本报告、方案顶部状态和[123行验收矩阵](./seven-bugs-fix-acceptance-matrix-2026-11-15.md)。运行证据与精确命令/退出码见 P6/checks.json、automatic-results.json、commands.json。没有提交或推送。


## Linux 续验（2026-11-15，未通过）

已补 Docker Linux 非 root 权限、root skip 统计、真实传输取消、凭据与调度等验收。首次六批为 947 pass、8 skip、4 fail；后续复跑仍有配置读取契约、别名断言及子进程时序门禁待处理，不能关闭跨平台验收。原 Windows 本机通过结果保留。详细根因、日志与清理见 [Linux 续验报告](./seven-bugs-linux-acceptance-2026-11-15.md)。本轮没有修改产品代码或测试断言。
