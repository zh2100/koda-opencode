# 七项已确认缺陷修复实施方案

日期：2026-11-15。修订：第 5 版（明确同槽执行合并与托管工具协议兼容）。状态：**已按 P0–P6 实施，七项本范围 Windows 本机修复与验收通过；跨平台及历史未关闭项保持原状态。** 最终证据见[实施报告](./seven-bugs-fix-results-2026-11-15.md)及[123行验收矩阵](./seven-bugs-fix-acceptance-matrix-2026-11-15.md)。下文“仅修改方案/待执行”等文字属于版本历史，不代表当前实施状态。

Linux 续验补注（2026-11-15）：**联合门禁未通过**，确认读取兼容契约、Linux 别名测试断言与子进程时序门禁有待处理；原 Windows 结果保留。详见 [Linux 续验报告](./seven-bugs-linux-acceptance-2026-11-15.md)，不得据本轮证据关闭跨平台项。

## 1. 适用范围、依据和文档关系

本方案处理以下七项及其必要依赖，不宣称覆盖项目所有潜在缺陷：

| 编号 | 级别 | 已确认问题 | 本次必须达到的结果 |
| --- | --- | --- | --- |
| OBS-01 | P1 | 名称保存使尚未完成的模型刷新失去后续责任 | 最新有效实体的未满足刷新需求得到接续，旧响应不能覆盖新状态 |
| ACC-F02 | P1 | 项目保存与加载使用不同文件 | PATCH、目标文件、有效配置与重建后 GET 符合相同来源规则 |
| AUTH-REPLAY-01 | P2 | 兼容删除误用清理回执返回成功 | 删除只确认自己已提交的确切命令；清理记录不能证明删除成功 |
| UI-VIS-01 | P2 | 名称回包导致已提交勾选不刷新 | 同实体普通修订变化后，勾选仍回读最新状态；重建实体不受旧操作影响 |
| SECRET-SCHEMA-01 | P2 | 凭据结构错误变成带原文的 defect | 运行时返回脱敏的 typed 错误，原文件不被破坏 |
| SECRET-CANCEL-01 | P2 | 取消保存后晚到写入留下孤立凭据 | 已投递写入结束前，清理、记录和租约责任均不能提前结束 |
| TASK-ERROR-01 | P2 | 可重试限流被归为项目无效并停用任务 | 临时执行失败终结本次运行，保留后续计划和启用状态 |

依据：

- [第一份复查记录](./acc-followup-bug-review-2026-11-15.md)：前三项。
- [扩展复查记录](./project-bug-review-2026-11-15.md)：勾选同步与凭据结构错误。
- [第二轮扩展复查](./project-bug-review-round2-2026-11-15.md)：取消凭据写入与调度错误分类。
- [原 ACC 详细方案](./acc-followup-detailed-fix-plan-2026-11-14.md)：OBS-01、ACC-F02 的既定设计和 O01～O29、F01～F36。
- [阶段 A 实施结果](./acc-followup-fix-results-2026-11-15.md)：已落地部分及测试隔离事故、授权清理的历史证据。

**文档关系**：本文件是七项缺陷的总实施入口，替换旧方案的顶层实施顺序；旧方案第 4～12 节的细化设计与 65 项矩阵继续有效。旧方案 A/B/C 在本文件分别对应 P2/P3/P5；P1、P4 是新增阶段。本文件对命令归属、凭据生命周期、勾选收尾和调度错误作增补。不得删掉旧矩阵来降低工作量；若新增设计与旧细则出现实际矛盾，先在文档记录决策再改代码，不能静默选择较宽松条件。

历史 A 是部分自动验证结果，不是本次 P2 已完成。新 capability `vendor-commit-baseline-v1` 仍未启用；其启用遵循 P3 的隔离候选门禁。

## 2. 共同规则

| 方面 | 统一约定 |
| --- | --- |
| 身份 | 前端使用 server scope、生命周期 generation、vendor entityId；操作有自己的编号。普通 revision 是版本条件，不等于实体身份 |
| 命令 | 写入前冻结 DTO、原始 revision、目标和 operationId；同编号只重试相同命令，不随当前页面重新计算 |
| 提交 | 以真实原子发布/数据库更新成功为准；HTTP 回包、清理和通知是后续阶段 |
| 接纳 | 回包必须属于当前实体/生命周期；旧业务快照不直接覆盖新状态，但已提交操作的同步责任不能随旧回包被丢掉 |
| 取消 | 投递前可以放弃；无法取消的底层写入投递后必须等实际完成，再执行恢复/清理 |
| 清理 | 只删除有本操作归属证据且未被当前配置引用的资源；清理失败保留恢复依据 |
| 失败 | 区分确定未提交、已提交但同步未完成、结果未知；未知不自动换 operationId 重放 |
| 验收 | 核对返回结果、持久化状态、服务/前端内存和可见页面；各层证据注明真实实现或受控适配器 |

禁止通过删除版本检查、全局禁用保存、吞掉全部冲突、默认把损坏配置当空对象、扫描删除无归属凭据、无限自动重试写入来通过测试。

## 3. 阶段与基线

顺序：**P0 → P1 → P2 → P3 → P4 → P5 → P6**。逐阶段完成，不一次堆完产品修改再验证。

| 阶段 | 范围 | 进入下一阶段的条件 |
| --- | --- | --- |
| P0 | 源码范围冻结、隔离守卫、失败用例登记 | 候选摘要、环境与测试归属可核对；I01～I03 的导入前准入与导入后对账通过 |
| P1 | SECRET-SCHEMA-01、SECRET-CANCEL-01 | S01～S17、凭据/认证真实路径、journal/配置发布取消边界及类型检查通过；读取异常不伪装缺 key |
| P2 | AUTH-REPLAY-01，复核原 A 契约 | 删除/清理/创建兼容矩阵、正式 HTTP 与原 O24～O29 后端样本通过 |
| P3 | OBS-01、UI-VIS-01 | 真实 hook、O01～O29、勾选矩阵、两布局隔离页面通过 |
| P4 | TASK-ERROR-01 | T01～T20、认领复检/同槽合并与运行/任务/事件对账、真实凭据与模型错误边界、完整错误载荷及供应商最终请求体、通知部分交付与类型检查通过；Session 安全投影修改有同条件性能对比 |
| P5 | ACC-F02 | F01～F36 本机范围、TCP 闭环、共享入口、生成物及类型检查通过 |
| P6 | 同一最终候选联合验收 | 所有受影响自动检查和登记页面完成，清理及状态记录准确 |

每阶段记录：`manifest-input.json`、首次失败日志、每次候选源码摘要、`checks.json`、`manifest-output.json`、`handoff.json`。记录 runId、HEAD、分支、方案摘要、文件状态、index 摘要、拟改/实改文件 SHA256、工具版本、平台、命令、目录、退出码、用例结果和剩余限制。源码修改后旧 pass 只能作历史证据；跨阶段先核对是否漂移。

门禁失败时修复该阶段并补受影响验证；不得把失败用例跳过后进入依赖阶段。适用平台的必需样本缺环境则该阶段相应验收保持未完成。无关历史跨平台项不阻止记录本机阶段结果，但不得整体关闭对应历史问题。

### P0.1 冻结范围

1. 读取根及涉及目录的 AGENTS.md；记录当前 HEAD、完整 git status、已暂存差异与 index 摘要。
2. 比较历史候选；目前已知 HEAD 为 `6b051f12a21094df1adef83f9fddfcbb765b319e`，执行时必须重新取值。
3. 列出本方案涉及的实际文件、测试文件和必要依赖。既有大量未提交内容保留，不能重置、格式化整包或清理用户文件。
4. 不提交/推送、改版本、备份源码、启用迁移 apply、改生产锁协议或重启现有应用。
5. 本方案不改 Session/Timeline 执行算法；允许已登记的 `packages/core/src/session/execution/local.ts`、`session/runner/llm.ts`、`session/runner/publish-llm-event.ts` 日志及错误发布安全投影修改，保持内部 Cause、drain、coordinator 和执行算法。修改这些文件前先按适用 AGENTS 要求在隔离环境记录生产构建性能基线，P4 用同条件候选对比；不能改后补记。其他扩围先登记文件、理由、影响和验证门禁。

### P0.2 把隔离放在模块加载之前

采用“导入前准入、导入后对账”两道检查。`Global` 模块顶层会创建目录，不能等导入后再以路径断言声称阻止了首次写入。

1. 外层 launcher 仅使用 Node 内建模块或已审计无写入副作用的守卫，创建独占临时根。先设置 OPENCODE_TEST_HOME、HOME/USERPROFILE、XDG_DATA_HOME、XDG_CONFIG_HOME、XDG_CACHE_HOME、XDG_STATE_HOME、TEMP/TMP、OPENCODE_TEST_MANAGED_CONFIG_DIR；数据库为该根内文件或内存。不得静态导入 Global、产品服务装配或会间接加载它们的测试 helper。
2. 清除继承的 OPENCODE_CONFIG、OPENCODE_CONFIG_DIR、OPENCODE_CONFIG_CONTENT、原生模块/资源注册覆盖及供应商凭据；只显式传入本批隔离覆盖，不输出原值。清理环境变量不能代替注册描述检查。
3. 在任何可能写入的产品模块导入前，确定 ResourceRoot 实际选择：检查 `<OPENCODE_TEST_HOME>/.opencode/opencode-resource-root.json`、关联协议标记、配置目录覆盖、tmp、数据库以及拟传入 Global.layerWith 的全部路径。普通测试不带注册描述；协议专项只接受本批明确创建且全部路径在隔离根内的描述。未知、损坏、状态不匹配或域外注册直接拒绝。
4. 路径检查使用带边界的相对路径判定，并解析最近已有祖先的真实身份、补上尚不存在的路径段；检查 junction/symlink/reparse，不能用字符串 startsWith 判断。可复用经过完整导入图审计的只读 ResourceRoot/LockProtocol 选择逻辑；如有写入副作用，先提纯读取与计算部分，不得为复用而提前导入 Global。独占根由 launcher 管理；这不承诺抵御外部恶意进程并发替换路径。
5. 准入通过后才动态导入产品。随后对账真实 Global.Path、Global.Service、lockContext 和数据库路径，必须与已准入描述一致；若后置检查失败，停止后续测试并记录已经可能发生的写入，不能记为“首次写入前拒绝”。
6. 包 preload 若选择新子根或覆盖路径，必须在它自身首次产品导入前重新准入，再做导入后对账；不能仅凭“子根名称像临时目录”放行。保留 Server preload 与 isolation.test.ts，旧 Server HTTP 文件各用独立进程，不强行同进程联合。
7. Core 显式提供临时 Global 和假凭据层。SystemSecrets 仅用实例独立的受控内存适配器，本轮不调用真实系统凭据库，禁止泄漏全局 testing.layer。保留此前误写事故；已授权清理已完成，不重复或扩大清理。
8. 负例仅使用本轮拥有的临时兄弟根模拟域外目标，绝不以生产目录试写。安全隔离失败立即停止有写入的测试；记录入口哨兵、外部测试根前后文件清单/摘要和拒绝阶段。

| ID | 场景 | 必须断言 |
| --- | --- | --- |
| I01 | 正常根、合法 preload 子根、显式 layer 覆盖 | 产品导入前准入；导入后路径/身份一致；实际产物仅在登记根内 |
| I02 | 域外注册/config/db/tmp、junction 指向兄弟根、损坏描述 | 导入前拒绝，产品入口哨兵未执行；兄弟测试根无新增文件或内容变化 |
| I03 | preload 重选及准入流程观察到的环境/注册漂移 | 新选择重新准入；不一致停止；后置失败不冒充零写入保证 |

### P0.3 将探针转为正式回归

先把三份复查的失败步骤转为断言预期正确行为的正式测试，记录红测试、源码摘要与失败点。探针退出码 0 仅代表脚本完成，不能复制为测试通过。对照用例保留。同步使用 Deferred/请求或提交屏障，不用 sleep 猜时序；用例超时只作为防挂死边界。

## 4. P1：凭据错误与投递生命周期

计划修改：`packages/core/src/relay-secret-store.ts`、必要的 `relay-auth.ts`；测试 `relay-secret-store.test.ts`、`relay-auth.test.ts` 及专用生命周期文件（P0 固定名称）。正式 Server Relay HTTP 样本验证公开结果。

### P1.1 统一读取错误边界

1. 在 read() 中对 `Schema.decodeUnknownSync` 使用 Effect.try，或改成 effectful schema 解码；将解码失败映射为新的无原始 cause 的 UnavailableError。
2. readJson 的语法/IO 错误保持相同安全边界。NotFound 仅表示文件不存在；PermissionDenied、结构错误均不得视为 `{}`。
3. 不向 error.reason/details、日志、cause 或响应附加 schema issue、输入值、配置全文、真实凭据和完整私有路径。调用方只得到既有 SECRET_STORE_UNAVAILABLE 等声明错误。
4. get/put/remove 实际访问文件后端时共用读取校验；系统成功不额外强制读取文件。失败时原损坏文件字节不变；put 不覆盖损坏文件。系统删除与文件删除的既有双后端部分失败语义保留，不能声称失败必然零副作用。
5. 检查初始化与运行时边界：初始化只能按既有服务构建失败；已运行服务的读取失败走 typed 通道。不能扩大公开会话错误联合来绕过类型问题。

### P1.1a 区分凭据读取失败与确认不存在

当前 SystemSecrets.get 的异常先被转成 undefined，再回退文件；文件里没有该 ref 时，RelayAuth.capture 会将其当成 KEY_MISSING。仅修复 schema 或 model resolver 分类不能阻止这条前置误停用路径。本批在既有 get 返回类型内保留“值 / 确认不存在 / UnavailableError”三种语义，不新增公开错误类型。

1. 系统 get 的结果在内部保留成功与失败身份；不得先 catch 成 undefined 后丢掉失败证据。只将适配器明确返回的不存在结果（null，以及经既有契约确认的 NotFound）视为确认不存在，不用宽泛 message 匹配将权限/服务故障视为缺失。空字符串不作为可用密钥，也不作为确认不存在的证据；可尝试文件副本，无可用副本时返回 UnavailableError。异常对象、原文不向外传。
2. 系统返回可用值时沿现有优先级返回；文件不是必读后端，不能为统一校验额外读取并让无关文件故障破坏系统成功路径。系统不可用或确认不存在时可读文件副本；有可用副本则成功，不清理或重写任一后端。
3. 系统读取失败且文件无该 ref 时，返回无原始 cause 的 UnavailableError，禁止返回 undefined。文件读取拒绝/损坏同样返回 UnavailableError；系统未配置时仅以文件结果判断；只有所有参与查找的后端都确认不存在，才返回 undefined。
4. RelayAuth 将 UnavailableError 映射为既有 SECRET_STORE_UNAVAILABLE；只有未配置 keyRef、实体本来不满足认证条件或后端明确查无凭据，才沿既有 KEY_MISSING 分支。P4 对前者不得停用，对后者保留明确暂停策略。
5. 使用真实 makeLayer、文件读取和 RelayAuth.capture/resolve 验证，不用直接失败的 RelaySecretStore.Service 替身冒充这条链路。仅 SystemSecrets 为实例独立受控适配器；任何假密钥/错误标记均留在隔离测试根。

### P1.2 选择明确的取消策略

本批采用：**底层不可取消写入投递后，持有原作用域和业务租约，等待该 Promise 实际 settled；随后观察待处理取消，进入恢复。**不新增后台凭据执行队列、不立即返回后靠 detached 回调收尾。

生命周期为：`journal-writing → prepared → secret-dispatched → secret-settled → config-publishing 或 retiring → cleanup-complete`。恢复记录只含引用和必要归属信息，不含密钥；journal 原子替换实际完成后才进入 prepared。配置是否已提交按真实发布证据判断。

1. 投递前保留可取消检查；尚未调用系统 set 时取消，不能调用 set 或创建配置提交。
2. 将系统 set 的调用及等待放入窄的不可中断区域，覆盖同步 throw、Promise reject、Promise resolve。不能只屏蔽创建 Promise 而让 await 可取消。
3. 系统写入 settled 后立即到明确可取消边界。若取消已经到来，不能启动文件 fallback、验证后新增写入或配置提交；由外层已登记恢复责任清理该 ref。
4. 将 fallback 分成三个明确结果：取消已到达时不启动 fallback、不提交配置；无取消且系统失败但文件 fallback 成功时，允许正常提交一次配置；无取消且双后端均失败时不提交，清理已发生副作用，清理失败保留 journal。系统先写后 reject、文件又成功时，两份同 ref 副本可能同时存在；配置正在引用它们就不能当孤立凭据删除。fallback 的 write/rename 也必须等实际 settled，期间不得清理或释放文件锁。
5. set 成功、拒绝或结果未知均可能需要按 ref 清理；恢复读取当前配置确认引用不在用后，才删除。当前配置已引用该 ref，则保留凭据并完成对应记录收尾。
6. recoverPreparing 只有在该 ref 的写入已结束、清理成功或证实仍在使用后才能移除记录。取消与清理失败同时存在时保留中断；保留记录，并以脱敏方式记录清理失败，不用 ignore 后删除记录伪装完成。
7. 系统 delete 的实际完成、文件副本删除和 journal 移除也遵循同样完成边界。明确 NotFound/false 可算幂等成功，但仅在前置 set 已 settled 后有意义。
8. 保留 auth → secret 的现有锁序；不在持有 auth 租约时重入 auth，或让 finalizer 等待自己持有的许可。
9. 正常取消不新建配置版本；配置已经发布后的取消沿现有提交证据收尾，不撤销已提交密钥。

**停机限制**：该策略可能让取消/关闭等待一个挂住的系统 API。观察超时只能报告“仍在排空”，不能释放租约、删除 journal 或宣布安全关闭。若产品必须有硬截止，需另设计有明确持有者及恢复协议的执行服务；本批不以 Promise.race 超时伪造完成。进程强制终止超出正常取消保证，重启时保留的 journal 必须可恢复；原生 OS 行为未测不能标跨平台通过。

不自动扫描/删除历史孤立系统凭据：缺少归属证据时无法安全判断。该修复防止新孤立引用，并恢复有 journal 的引用；历史无记录资源需单独诊断和授权。

### P1.2a 恢复记录与配置文件也必须有完成边界

仅屏蔽系统 set 不足以成立。实施前逐个登记 journal、凭据文件、auth 配置的 write/chmod/rename/remove：投递点、实际完成信号、租约、归属证据和唯一清理者。

1. 写 journal 前登记随机 ref 与本操作 tmp 的清理责任。journal 完整发布前不能 set。tmp write/chmod 已投递后遇取消，先等实际 settled，再清理自己的 tmp；不能让晚到写入在清理后重建文件。
2. journal rename 已投递后遇取消，等待真实结果，并在同一 auth 租约内重读确认是否发布。结果未知时保留可核对的归属证据，不假定没有副作用，也不提前释放租约。
3. journal 已发布、set 尚未投递时接受取消：不调用 set，安全完成恢复记录收尾。旧 rename 必须已经结束，不能在后继写者提交后覆盖其 journal。
4. auth tmp/next 文件的写入与准备同样等待实际 I/O；最终发布前保留取消边界。final rename 一旦准入则排空并确认结果，成功时登记命令提交证据、保留有效 ref；结果未知沿既有分类处理，不清理可能已被提交引用的密钥。
5. journal 删除也需等实际完成；只有凭据清理成功或已确认当前配置使用该 ref 后才能移除对应记录。失败保留可恢复状态，不删除其他操作记录，不在旧删除仍未结束时放行后继写者。
6. 不可中断区域限于已投递 I/O 和相应提交/收尾边界，区段间显式观察取消；不把整个保存、锁等待或未投递的新写入全部屏蔽。先定责任，再处理取消；不能通过将所有取消推迟到保存成功后通过回归。

### P1.3 必测矩阵

| ID | 场景 | 必须断言 |
| --- | --- | --- |
| S01 | 语法错误；对象/数组/数字/null 值；根数组/null | typed Fail，不是 Die；文件字节不变，诊断无标记原文 |
| S02 | get/put/remove、系统 fallback、读取拒绝 | 既有错误协议，独立引用不被错误覆盖 |
| S03 | 初始化和运行中损坏，正式 HTTP | 预期构建/运行时边界；运行时 503 等既有声明；响应/日志无假密钥 |
| S04 | set 投递前取消 | set/config commit 未调用，锁可重新获取 |
| S05 | set 已投递→取消→晚成功 | set settled 前取消收尾不能完成；之后无孤立 key，旧 key 可解析 |
| S06 | 系统同步 throw、Promise reject、先写后 reject，且取消在 fallback 前到达 | 不挂死；不启动 fallback，不提交配置；副作用按 ref 清理，旧配置保持 |
| S07 | 取消与完成同时发生，正常成功对照 | 正确分界；最多一次提交/清理，无重复删除后继资源 |
| S08 | 清理失败、再次服务初始化 | journal 保留且可继续；中断/清理失败不被伪装为成功 |
| S09 | 文件 fallback 已投递时取消 | I/O 完成后清理；无 tmp、锁或 journal 的错误提前释放 |
| S10 | 已提交后取消、ref 仍被配置使用 | 不删除有效凭据，提交证据与 revision 保持 |
| S11 | 服务退出/等待观察超时 | 已投递责任仍持有；完成后正确排空，无 detached 写入 |
| S12 | 无取消，系统 throw/reject/先写后 reject，文件 fallback 成功 | 提交一次且新 key 可解析；当前引用的系统/文件副本不被误删 |
| S13 | 无取消，系统与文件 fallback 均失败 | 不提交、旧 key 可解析；已发生副作用完成清理，或保留可恢复 journal |
| S14 | journal tmp write/chmod/rename 挂起时取消，并启动竞争者 | 实际 I/O 完成前不收尾或释锁；不 set；无晚到 tmp/rename 覆盖后继记录 |
| S15 | journal 发布后、set 前取消；journal 删除失败/晚完成 | 不 set、不提交；正确保留或完成记录；竞争者不受旧删除影响 |
| S16 | auth tmp/next/final rename 边界取消与竞争者 | 准入前不发布；准入后确认提交或未知结果；有效 ref 不被删，旧 I/O 不覆盖后继提交 |
| S17 | 系统读取失败/明确不存在/成功，交叉文件有值/无 ref/缺文件/拒读/损坏；无系统后端对照 | 按 P1.1a 返回值、undefined 或 typed UnavailableError；系统成功不读取文件；真实 Auth 映射正确，文件/配置字节不变，无秘密原文 |

## 5. P2：删除重放必须拥有命令证据

计划修改：`packages/core/src/relay-auth.ts`；保留旧客户端 expectedEntityId 可选的公开形状。测试覆盖 Core 和正式 RelayHandler/TCP。

1. 清理状态与业务命令记录拆开表达。settleCleanup 只更新清理结果，初始化清理不能生成“已完成删除”的证据。
2. 为删除记录不可变命令身份：kind=delete、vendorId、原 revision、expectedEntityId 的有/无与值、operationId。已有 set/clear 指纹与创建持久回执继续按各自规则工作；缺失字段不等同任意值。
3. 只有真实配置发布成功的短不可中断边界才能登记删除已提交证据，必须早于清理/返回可能失败的阶段。不能在调用前预记成功。
4. 精确重放先验证命令归属。即使原实体已经删除也可确认该次提交；只读取最新快照/补安全清理，不执行第二次删除，不移除同名后继实体。
5. operationId 被其他 kind、vendor、实体或 revision 占用时返回 REQUEST_CONFLICT。pendingCleanup 或 result-only 缓存均不能单独返回业务成功，受保护与兼容入口同一规则。
6. 重启/淘汰后缺少证据时保守冲突。若无任何记录，可按原冻结 revision 的首次条件写入规则处理；禁止读取当前 revision 后替旧命令改写重试。原 mutation 已提交使 revision 前进，旧条件应冲突。
7. 保留已实现的受保护删除生命周期内精确确认承诺；普通 mutation 的 1024 容量淘汰必须同时淘汰证据与结果。不要无说明地把已有 protected-delete 确认承诺缩为普通缓存期限。
8. 创建持久化回执和签名密钥不被重放缓存淘汰影响。保留删除后重复创建回执只确认原创建、不复活实体的语义。
9. 重放返回“最新安全快照”不代表该 snapshot revision 是原命令提交版本。继续执行原方案 O24～O29 的版本推导前提。

| ID | 场景 | 预期 |
| --- | --- | --- |
| A01 | rotate 留 pending→重建→兼容 delete 复用 id；清理成功/失败各一例 | 冲突，实体和版本不变，不能返回删除成功 |
| A02 | 同生命周期 set/clear/create/delete 跨种类或跨目标复用 | 冲突，无额外配置或凭据写入 |
| A03 | 兼容与受保护删除的精确重试 | 一次删除；最新快照；不重复增加 revision |
| A04 | 删除已提交、清理失败/取消/响应丢失后重试 | 已提交证据仍在，安全补清理 |
| A05 | 删除后同名重建，再重放旧删除 | 新 entity、key、目录不变 |
| A06 | 重启/缓存淘汰/只有 result 或 pending | 缺证据不确认业务成功；创建持久回执例外保持 |
| A07 | 配置发布失败/未知 | 不伪造确认；失败/未知分类及原字节保持 |
| A08 | 正式 TCP，expectedEntityId 有/无 | 状态码和公开形状正确，无秘密或内部指纹 |

P2 通过后仍不启用新 capability；先由 P3 接入真实前端。

## 6. P3：统一刷新需求与勾选提交后的同步责任

计划修改：`packages/app/src/hooks/use-relay-settings.ts`、真实状态机测试；必要时调整两种 providers 组件和 i18n。OBS 详细算法继续执行原方案第 4～6 节，不复制为第二套刷新器。

### P3.1 三种责任分别记录

- 上游模型刷新需求：地址/密钥提交导致，按实体和已确认连接提交水位保存；继续原方案有限并发、超时、替代与晚到收尾。
- 认证提交后的后端目录同步需求：现有 catalogSync/pendingCatalog，不改成上游刷新。
- 勾选提交后的快照回读需求：新增窄状态，表示该实体已有勾选提交尚未被一次足够新的目录读取确认；它不调用 saveVendor，也不自动抓取上游。

不能用同一个 boolean 代表三种责任。可共享 drain/生命周期基础设施，但每种责任的完成条件独立。

### P3.2 OBS-01 接续

1. 按原方案冻结每次写命令的 R/V/DTO；先在真实后端候选启用并验证 vendor-commit-baseline-v1，再验证前端精确版本路径。能力缺失走已定义兼容分支，不能用夹具加字段冒充后端支持。
2. 已提交地址/密钥变化产生需求；名称或空补丁提高 revision 时接续尚未满足的需求。
3. 旧 refresh 发生版本冲突时核对当前实体与最新目标，按规则合并补刷。请求失败/超时保留有界重试入口，不无限循环，不重新提交保存。
4. finally 仅释放自己持有的运行槽，退出前复查排队唤醒；旧 ACK 不清掉新目标或清钥屏障。
5. 清钥、删除、换服、销毁和同名重建分别按原方案终止/转移，不恢复旧实体。

### P3.3 UI-VIS-01 的接纳与排队规则

1. 记录每次勾选 intent 的 scope/generation/entityId、modelId、目标 visible 和本地序号；写入前冻结。
2. 把“仍是同一实体”与“版本完全相同”拆成不同检查。不要全局修改 sameIdentity；仅为调度最新回读使用同实体判定。
3. 勾选尚未投递时，名称变更不应导致静默丢弃；同实体且当前仍可操作该模型时按队列顺序投递。目标删除/重建、清钥或连接更换使 intent 不再适用时明确取消/被替代并更新本地状态，不返回假提交成功。
4. 已投递请求成功后先登记回读责任，再检查回包是否可直接应用。同实体普通 revision 变化时仍要 sync 最新快照；不能因旧身份版本不同直接 return 丢责任。
5. 回读使用原 API/scope，接纳仍检查当前 lifecycle/entity 和目录水位。旧实体 ACK 不能刷新或勾选后继实体。
6. 使用“读取发出时间/序号晚于已确认勾选”的 fence，加现有 catalogRevision/分片写入水位确认完成。ACK 前已发出的旧 sync 不能消耗该回读责任；没有公开提交 catalogRevision 时不凭空推导。
7. 多次同模型 true/false 操作保持写入顺序；已投递的写不自动重试，成功后的快照读取可合并。每次读取只满足其发出前已知的提交，新的勾选 ACK 会留下下一轮需求。
8. 回读失败保留已提交状态和“同步待重试”；重试只读，不重新 visibility、更不重新 save。回读期间新增需求需在 finally 后接续。
9. 失败/结果未知时不伪造提交。可回读权威状态并提示用户未确认；若无幂等契约，不自动重放 visibility。错误票据不能由旧读失败覆盖新操作结果。
10. 队列不能被一个已失败读取永久卡住；突发勾选须有明确合并和终止行为。沿用有限请求超时/取消能力，无实际 abort 支持时保留晚到响应归属检查。

| ID | 场景 | 必须断言 |
| --- | --- | --- |
| V01 | 勾选已提交 ACK 挂起→名称保存先回包→勾选 ACK | 至少一次足够新的 sync；页面与持久目录一致 |
| V02 | 无交错正常勾选；名称保存失败 | 基本行为保持，错误有正确归属 |
| V03 | 勾选排队时名称/空补丁提交 | 合法 intent 不静默消失，写入顺序保持 |
| V04 | 勾选 ACK 前发出的 sync 晚到；ACK 后另一 sync | 前者不能完成新责任，后者按水位接纳 |
| V05 | true→false；不同模型/供应商；sync 中又有 ACK | 最终状态等于最后实际提交，分片互不覆盖，无丢唤醒 |
| V06 | 已提交后 sync 失败/超时，再显式重试 | 写次数不增加，责任保留直至成功或实体退休 |
| V07 | 未投递/已投递/已提交三个阶段遇删除、重建、换服、销毁 | 旧实体不污染新实体；不得靠“全部返回成功”跳过 |
| V08 | 清钥/换地址、旧错误晚到 | 不恢复旧连接状态；错误票据正确 |
| V09 | 新目录协议与明确旧服务器样本 | 各自既有兼容契约；旧快照不直接覆盖当前状态 |
| V10 | 经典与现代真实设置页 | 勾选、名称、目录和 HTTP/磁盘四层一致；刷新失败可恢复 |

P3 同时跑 O01～O29；V01～V10 是新增义务，不替代 O 矩阵。经典布局已退役时按既有隔离验收方法进入，不修改产品退役逻辑。修改 E2E 前阅读该目录要求的官方 Playwright 指南。

## 7. P4：调度错误分类与停用策略分开

计划修改：`packages/core/src/scheduled-task.ts` 的分类与同任务状态/发布顺序；`packages/core/src/session/execution/local.ts`、`session/runner/llm.ts`、`session/runner/publish-llm-event.ts` 的日志及错误发布安全投影。可提取窄的错误投影函数；必要的 schema、客户端生成物、调度显示错误映射及测试。会话事件投影器、`session/runner/to-llm-message.ts`、读取接口、正式 EventV2 和通知消费方作为保护回归入口。托管错误的协议校验/安全转换及受控拒绝登记在 `packages/llm` 的窄辅助模块和 `protocols/anthropic-messages.ts`、`protocols/openai-responses.ts`；P0 固定辅助模块路径，Core 通过 LLM 现有导出方向调用，不复制两份协议规则。保留正常解析/请求转换，不修改共享事件总线或模型执行算法绕过验收。Session runner/model resolver 的公开错误契约和执行算法保持。修改 Session 文件前完成 P0.1 性能基线，P4 同条件对比。

### P4.1 分类结果明确包含决策

局部分类结果至少包含安全 `code`、`retryable`、`pauseTask` 和固定的安全说明。pauseTask 不能再由一个兜底 code 推导。

| 来源 | 公开分类 | retryable | pauseTask |
| --- | --- | --- | --- |
| requireReady 确认项目无效 | PROJECT_INVALID | false | true |
| requireReady 确认模型不可用 | MODEL_UNAVAILABLE | false | true |
| SessionRunnerModel.ModelNotSelectedError / VariantUnavailableError / UnsupportedApiError | MODEL_UNAVAILABLE | false | true；只匹配来源明确的 typed 配置错误 |
| SessionRunnerModel.ModelUnavailableError（已丢失底层原因） | MODEL_UNAVAILABLE | false；无可靠自动重试依据 | false；不能据此证明永久配置失效 |
| requireReady 直接返回 SECRET_STORE_UNAVAILABLE / REQUEST_CONFLICT 等临时或竞争错误 | 保留既有 code | 按明确 typed 契约 | false |
| 前置认证明确缺失密钥（P1.1a 证明不存在，不含系统读取失败） | KEY_MISSING | false | true |
| LLM RateLimit | UPSTREAM_RATE_LIMITED | true | false |
| LLM Transport | UPSTREAM_UNREACHABLE | 按 typed reason | false |
| LLM ProviderInternal | UPSTREAM_UNREACHABLE | 按 typed reason | false |
| LLM InvalidProviderOutput | UPSTREAM_INVALID_RESPONSE | false | false |
| LLM Authentication | KEY_MISSING 或 KEY_REJECTED，按 kind | false | false；执行期失败不伪装已确认前置检查 |
| LLM NoRoute / InvalidRequest / QuotaExceeded / ContentPolicy / UnknownProvider | TASK_EXECUTION_FAILED（本批拟增代码） | 按 typed reason | false |
| Session、工具输出、上下文等其他 typed 执行失败 | TASK_EXECUTION_FAILED | 缺少明确证据时 false | false |
| 中断/defect | 内部保留 Cause 与 abandoned 终态规则；对外使用固定安全投影 | 不伪装业务可重试成功 | 不因兜底分类停用 |

**ModelUnavailableError 的保守决策**：当前 model resolver 将 Relay resolve 的多种 AuthError 包装为同一种 ModelUnavailableError，包含临时凭据存储故障；普通供应商真实模型缺失也可能得到此类型。本批不扩大 Session 公开错误联合，也不解析 message 猜根因，因此这两种歧义路径均不自动停用，保留 MODEL_UNAVAILABLE 并提示用户核对。只有上述可直接证明的前置/配置错误暂停任务。retryable=false 不等于 pauseTask=true；不额外发模型请求来“诊断”来源。今后若要区分两者，须另行设计保留来源的内部契约及兼容验证。

新增 TASK_EXECUTION_FAILED 的目的仅是表达无法归类为现有 Relay 前置条件错误的任务执行失败，不能反过来扩大会话公开错误联合。保留固定安全 details 或省略；不得继续 String(error) 暴露上游响应、URL/token、prompt 或上下文原文。

如果执行时发现现有更专门的错误可以无歧义覆盖，可在改产品前登记选择；不得把未知错误映射成 PROJECT_INVALID。新增代码必须检查 RelayError.Code 的所有穷尽映射、i18n/任务页面展示及 schema/SDK 消费方。

### P4.2 状态更新规则

1. 本次已接纳运行在执行失败后终结为 failed，记录实际 sessionId/promptMessageId 和安全错误。
2. pauseTask=false 时不写 enabled、cancel_epoch 或额外修改 nextRun。自动调度已做的 advance 保留；手动 runNow 的原计划不被改写。
3. pauseTask=true 时沿既有 disable 的事务逻辑收尾等待中的记录；保留已运行任务处理规则，不把停用后续计划扩成中断所有会话。
4. 不自动重放当前 prompt/tools，不新增立即重试。retryable 只是错误性质，未来正常计划仍可运行。
5. 用户在本次执行中显式停用后，失败处理不得重新启用；正常失败分支不写 enabled。事件也不得继续携带执行前的 task；按 P4.2a 在同任务发布顺序内读取最新任务，与真实 run 一起发布。
6. 通知失败、中断、最终清理与项目锁释放保持既有正确性，不能为了新分类吞掉 Cause。
7. 内部控制流保留原 Cause；持久化、日志、事件、API/页面分别只接收安全投影。覆盖 fail、abandoned、恢复诊断和发布的 run.error，不能在异常路径继续持久化 Cause.pretty 或 String(error)。
8. 安全投影只允许固定类别/阶段及本地 run/task/request ID 等明确白名单；不带原始 cause、stack、message、URL、响应正文、prompt 或上下文。投影失败也只用固定安全兜底，不回退输出原文。中断与 defect 组合时保留内部中断，不借脱敏将其改成成功。
9. 真实 SessionExecution 日志和会话 Step.Failed/Tool.Failed 发布均可发生在 scheduler 收到错误之前；按 P4.2b 在各输出边界投影，原 Cause 继续内部传播。已知发布入口全部纳入本次范围；其他新发现出口先登记再修改，不得只修 scheduler 和 logError 就宣称全链无泄漏。

### P4.2a 任务状态与事件发布顺序

本批选择同一 ScheduledTask 服务内按 taskId 串行的短状态/发布区段。只在 publish 前重读一次仍有“读取后停用、旧事件后发”的窗口，因此写状态与发布必须使用同一准入入口。

1. 统一登记 create、setEnabled、claim/advance、运行状态变更及终态、自动 disable、recover 和 remove 的状态/事件边界。同任务的相关写入和发布共享短队列；不同任务互不等待。扫描快照只用于发现候选，不能作为执行准入；按 P4.2a.1 在事务内确认并冻结接纳快照，之后运行使用该快照。事件的 task 则来自发布区段内的最新数据库记录，两者不能混用。
2. 在队列内完成短数据库事务，取得实际更新的 run，再读取当前 task，最后 await 正式事件发布完成才释放区段；不得持有数据库事务等待事件。task 已不存在时不拿旧快照补发 Updated，也不重新插入任务。run 已终态且本次未更新时，不伪造重复终态发布。
3. 失败、中断、成功都通过同一发布入口。先于终态区段完成的停用必须反映在终态事件里；若终态区段先赢，则它的事件先交付，停用写入及事件随后发生。在通知正常完成的验收分支，最终 DB、GET 和最后已交付任务状态一致；通知失败分支按 P4.2a.2 登记未投递、部分交付或结果未知，不能一律记为未交付，也不计为状态一致通过；不存在要求每条历史事件永远等于未来状态的承诺。
4. 队列不覆盖整个 perform、模型请求、工具执行或项目锁等待；需要二者时保持项目执行锁在外、短状态区段在内，区段内不再等待项目锁。内部 disable/patch/publish 使用已持有区段的内部路径，不递归获取同一队列；setEnabled 不等待运行结束。事件发布失败/中断时先按事件入口的完成契约确认本次投递已经结束；不可取消的投递须排空，不能让晚到事件越过后继区段。随后释放区段，保留已提交状态与原失败，不回滚、不重放运行、不自动重复终态通知。事件回调不得同步等待同任务 mutation；用受控订阅者验证正式事件入口不会构成自等待。
5. 运行中“停用后重新启用”会改变 cancel_epoch；旧运行若要求自动暂停，必须在事务内核对其认领 epoch 与当前值。已变化时只终结旧 run，不用旧配置故障再次停用新一轮计划。既有 once advance 语义保持，不把 nextRun 的正常推进当用户取消。
6. 保留当前公开事件形状；不把 Run.revision（认领时的任务修订）改作事件序号。当前页面是 GET/refetch，通知消费 run 终态，分别验证，不虚构页面会自动按 Updated 替换任务。该队列保证同一服务内的状态/发布顺序，不承诺跨独立服务进程的全局事件线性顺序、断线必达或持久 outbox；相应历史跨进程项不因此关闭。

### P4.2a.1 认领与推进必须重新验证当前状态

当前 tick 在扫描时判断 enabled，claim 虽然重读任务却只检查存在，advance 又把扫描快照的 enabled 写回。将这些调用各自排队不能阻止停用后的旧候选重新启用任务。本批将准入检查、认领和自动推进作为一个短事务处理。

1. tick 的任务列表、dueSlots 和 runNow 排队前读取均为候选。进入同任务区段后，在数据库事务内重新读取任务，检查实体仍存在、当前 enabled、cancel_epoch，以及自动候选对应的计划/到期位置。旧扫描到当前值发生变化时按最新状态重新判定，不能给旧候选直接套上新的 epoch 授权执行。
2. 自动候选必须仍属于当前未处理的到期范围；已推进、已删除、已停用或旧 epoch 的扫描候选不创建 run、不改 lastRun/nextRun、不发布“开始”事件。最新合法自动候选遇到同槽已有 run 时，按 P4.2a.1a 只补推进未消费的计划，不把它和“计划已经推进”的重复请求混为一类。一个扫描批次含多个补偿时段时，每次准入重新核对；保持既有 missed/once/daily 规则，不重复补偿已处理时段。
3. 自动准入在同一事务内区分“新建 run 并推进”“同槽已有 run、只补推进”“已消费计划、无操作”。任一写入失败整体回滚；不得统一规定插入失败永不推进。daily 只更新计划字段，不从旧快照写 enabled=true；once 在该自动时刻首次消费时停止后续调度，已有 run 不重新执行。runNow 也在区段内重检存在/启用/已有活动 run，保持既有 NotFound/Disabled/Conflict 和精确活动运行返回规则，自身不推进自动计划。
4. 原子准入使用显式内部结果区分 created（新 run 与执行快照）、consumed（只补推进后的 task）和 skipped（无操作）。只有 created 登记新 run 的 abandoned/执行责任并调用 execute/perform；consumed 只发布 task，不能把已有 run 返回给通用执行分支。准入提交和收尾责任登记之间不能留可取消空窗；已创建 run 先登记责任，再恢复取消或发布事件。finalizer 只在短区段释放后进入新的收尾区段，避免自等待。数据库事务不等待事件、项目执行锁或模型调用。
5. 停用先于准入胜出时零认领；准入先胜出、启动前用户停用时，由既有 stillDue 在项目锁等待结束后核对认领 epoch，旧 pending 收尾为 interrupted，不创建会话。自动 once 的内部 advance 不增加 cancel_epoch，已认领执行仍能启动；不能把 once 的 enabled=false 当成用户取消。
6. 此处准入/推进保持原有唯一约束和 owner 责任，只修复本次调度状态竞争，不以进程内队列宣称多进程调度所有权已解决。旧运行退出不重放 prompt 或工具。

### P4.2a.1a 同一时刻的手动/自动执行合并

本批确定：以数据库现有 `(task_id, scheduled_at)` 唯一键表示一次时刻的执行尝试；手动 runNow 与自动计划精确撞在这个键上时共用已有尝试，不建立第二次执行。保留原索引，不按来源拆键、不改数据库 schema；“已经尝试”不等于成功。手动时间仍按现有秒级取整，自动时间按原精度；只比较精确持久化值，不额外扩大到整个秒窗口。

1. 事务内先确认自动候选就是当前仍待消费的 nextRun（缺省沿原 runAt 规则），并通过当前 enabled/epoch/到期复检，再查找精确同槽 run。无记录时插入并推进；冲突时重读冲突行及当前计划，不能盲目按冲突异常推进。计划已经前进时零写入；同槽已存在但计划未前进时仅推进一次。无法确认精确匹配或事务失败时退出，不改其他时段。
2. 同槽记录是 pending、running、completed、failed、interrupted 或 missed，均证明该键已有一次尝试；自动路径不调用 perform、resume、prompt，也不改变已有 run 的状态、owner、epoch、revision、session 或错误。pending/running 的活持有者继续原有执行；无执行者的记录仍由原恢复规则按 owner 租约核对后收尾，不能在认领事务里恢复或接管。
3. 仅补推进时：daily 写 lastRun=该槽、nextRun=既有 nextDaily 计算值；once 写 lastRun=该槽、nextRun=null、enabled=false，不增加 cancel_epoch。事务前的 enabled 和计划位置须仍满足准入条件；不重新启用用户停用的任务。已有 run 的旧 epoch/null epoch 不赋予新执行资格，也不覆盖当前 epoch；合并仅消费同一时刻，用户重新启用不会重放该槽副作用。
4. 该规则也适用于重启后残留的历史同槽记录；不猜它来自手动还是旧自动版本，不需要新增来源字段。历史失败或中断仍保留失败/中断，不伪装成功；结果报告明确“同槽只消费计划，不保证那次尝试完成”。本批不提供同槽重新执行功能。
5. 只补推进的事务提交后发布最新 task，**不附已有 run**，避免把旧 completed/failed 再变成终态通知；没有新的认领、开始或终态事件。通知失败按 P4.2a.2 记录，下一次 tick 根据已推进计划不重复发布或执行。新建 run 的路径仍按既有准入收尾规则执行。
6. 自动先到时，daily 的 runNow 对活动 run 按原规则返回，对同秒终态保持 Conflict；once 已被自动消费后 enabled=false，runNow 保持 Disabled，不为复用旧结果绕过停用检查。手动先到时，自动只补推进；手动终态结果不变。非同槽手动运行不影响自动计划。
7. 验收冻结时钟并在唯一插入/事务提交/发布处设屏障。涵盖手动先到、自动先到、同槽运行中/各终态、历史 null/旧 epoch、重启、两个 tick 竞争、事务回滚、通知失败及不精确相等的时间。断言 run/会话/工具执行次数不增加、计划恰好推进一次、无旧 run 重复通知；daily 下一正常时刻仍能执行，once 不永久保持旧到期状态。

### P4.2a.2 通知结果按真实投递阶段记录

当前 ScheduledTask.Updated 为非持久事件，EventV2.notify 先逐个调用监听者，再投递 typed/all 订阅流。某个监听者失败时，前面的监听者可能已完成；publish 成功也不等于浏览器已经消费。

| 状态 | 可用证据 | 允许的结论 |
| --- | --- | --- |
| 未投递 | 本次 publish 尚未调用 | 没有通过本次调用交付，不代表其他调用也未交付 |
| 部分交付 | 测试或受控观察确认至少一个入口已接收，后续阶段失败/取消 | 已有接收者可能发生副作用；不回滚状态、不整批重放 |
| 结果未知 | 已调用 publish，但失败/取消且不能证明各阶段完成情况 | 不假定零交付或全部交付；保留原始内部 Cause，诊断仅存安全阶段与标识 |
| 发布完成 | 正式 publish 返回成功 | 监听/入队阶段按现有契约完成；不保证客户端已消费、展示或通知送达 |

1. 运行时缺少逐接收者证据时使用“结果未知”，不为本批修改 EventV2 的公共契约或推测已收到的数量。不能仅用捕获异常的事实判定“未交付”。测试中的精确接收次数仅作为该次受控样本证据。
2. 不自动再次调用整批 publish；不能重跑数据库写入、认领、prompt/tools 来补通知，也不能将已完成的 run 改成执行失败以表示通知失败。队列按 P4.2a 的完成边界释放；运行错误与通知错误分别保留安全记录。
3. 发布完成样本分别等待正式流接收和页面/通知消费证据；失败样本核对已收到的前缀、后续缺失、DB/GET、后继任务可继续。不得把订阅流入队等同页面验收通过；断线恢复与持久必达不在本批承诺内。

### P4.2b 会话错误在发布前投影

1. 全部已知出口纳入实施清单：`runner/llm.ts` 的 LLMError.reason.message → failAssistant、工具异常 → failUnsettledTools；`publish-llm-event.ts` 的 provider-error.message → failAssistant、tool-error.message → Tool.Failed，以及 tool-result 中 result.type=error → settledOutput → Tool.Failed。最后一条同时携带 error 和原始 result，不能只改 error.message。错误必须在 Step.Failed/Tool.Failed 发布前完成转换，不能等持久化或投影后再遮盖。
2. 将错误类别、固定安全说明与原始 Cause 分开传递。typed LLM 错误按固定类别映射；流内 provider-error 若只有任意 message 则用固定上游失败说明；工具异常使用固定工具执行失败说明。只允许受信任的固定说明进入上述发布器，不把原始 message 当成“已安全”。原 Cause 仍交给原失败/中断路径，不改变工具是否成功/失败、调用身份、执行次数、重试或终态规则。错误说明与错误结果载荷明确允许转换为安全形式；成功工具结果保持原样，不再承诺错误结果原文不变。
3. 同步审计错误事件附带的 providerMetadata 和其他诊断字段；仅保留原 schema 允许且明确列出的安全字段，不能通过 metadata 把原文绕回事件。正常用户文本、模型正文和成功工具输出不属于本次错误脱敏，不能批量删改；保留事件公开形状与固定合法说明，新增用户可见文案遵守既有 i18n 规则。
4. 测试通过真实事件总线和 projector，检查原始错误事件、消息/工具错误投影、会话读取接口、调度运行记录、通知/页面适用项和日志。分别覆盖抛出 LLMError、流内 provider-error、工具异常、中断与 defect 组合；假秘密仅放在错误及诊断载荷里，不能把正常正文含相同文本作为错误泄漏判据。
5. 对 tool-result 错误先生成固定安全 error，再按执行归属生成安全 result。普通本地工具使用 `{ type: "error", value: 安全说明 }`；providerExecuted 工具按 P4.2b.1 保留经过校验的供应商错误结构/引用，不能统一改成字符串。发布 error/result/metadata 前逐字段重建，禁止对象 spread 留下原 value、stack、cause、任意正文或未知嵌套字段。tool-error 使用相同安全 error；无 result 的普通分支不新增原文，无 result 的托管分支按专用续接规则处理。
6. 明确后续模型输入契约：本地工具和受支持、校验通过的托管工具保留 callID/name、失败语义和执行归属，不重复执行工具；各供应商可能发送结构化结果或仅发送引用，不能统一断言所有工具都重发错误正文。无法安全重建的托管错误须在下一次请求发出前明确拒绝，不能静默删掉结果、改成普通工具或发送无效字符串。走真实 projector → 消息读取 → toLLMMessage → 协议转换 → 最终 HTTP 请求体验证。本地分支组合的 error/content/structured 分别核对来源；正常工具进度和成功输出保持，不把上游错误对象伪装成进度绕过处理。
7. 分别测试 tool-error、字符串/对象/嵌套错误 value 的 tool-result、provider-error 和抛出异常；假秘密独立放在 message、result.value、metadata，不能只用一个 error.message 样本代表所有出口。每支都核对原始失败事件、持久事件、消息投影、读取 API 和后续模型请求，确认错误仍可识别。正常成功工具输出作为不变对照。
8. 先记录生产性能基线，再改已登记 Session 文件；相同构建条件复测。正常成功流、固定中断说明、工具收尾次数、事件数量、schema 解码及后续模型输入均做保护回归；不得靠不发布失败事件、删除原会话记录或吞掉 Cause 通过无标记断言。本批不回写清洗历史会话。

### P4.2b.1 托管错误按供应商协议处理

本批覆盖仓库现有 OpenAI Responses 与 Anthropic Messages 托管工具路径；普通工具继续使用固定安全文本。必要引用属于协议数据，不将整个 metadata 当作可原样保留的安全对象。P0 固定“供应商/工具名/错误结构/字段及枚举/引用约束”的白名单和对应协议版本证据；依据仓库解析器、现有夹具与实施时核实的供应商规范，不能猜测支持的错误码。

| 路径 | 保留的最小协议信息 | 最终请求检查 |
| --- | --- | --- |
| 普通本地工具失败 | 已有调用身份、error 类型、固定安全说明 | 各既有普通工具转换仍发送错误结果，不泄漏任意原文 |
| Anthropic 托管工具失败 | 根据已确认工具名重建对应 `*_tool_result_error` 对象，保留工具对应白名单内的 `error_code`；外层 tool_use_id 与已接纳调用一致 | `web_search`、`web_fetch`、`code_execution` 使用各自结果 block；content 是合法结构，不能变成普通字符串。已有 `web_search_tool_result_error/max_uses_exceeded` 作为明确对照，其余码需逐项核实 |
| OpenAI Responses 托管工具失败 | 安全错误说明与校验后的 `openai.itemId`；引用须属于同一模型来源/调用，沿已有 metadata 优先级核对，禁止任意字段整体复制 | store 启用时使用正确 item_reference，不伪造 function_call_output 或重发错误正文；store=false 保持现有不回传托管引用的规则，不能因此声称已把错误正文重新发给模型 |

1. Anthropic 的 result.type 仍为 error，但 value 为逐字段重建的协议对象。错误说明供界面使用，协议 error_code 供续接使用，二者分开。tool-error 未提供所需结构、未知工具名、未知码或不匹配类型不能靠固定字符串通过协议转换，也不编造供应商错误码。
2. OpenAI itemId 从当前调用记录与本次结果的已知协议字段核对；结果缺失引用时仅允许使用已保存且属于该调用的引用。校验来源与格式/长度后保留，不混用另一调用、另一供应商或未经确认的任意 metadata。store 启用但没有可信引用时，不能静默 continue 丢失结果；store=false 不新增该引用。成功托管工具的既有引用和输出保持。
3. 对未知或损坏的托管错误，持久化固定安全 error 及不含原文的“不可续接”内部结果标记；不能将该标记发给供应商。标记不携带任意 reason/原值，沿现有可承载 result 的结构保存，不新增公开事件字段。下一次协议准备必须识别标记并返回既有 typed InvalidRequest 类安全错误，HTTP 请求次数为零，不回退成普通工具、不自动重试。未标记的历史托管错误若不符合白名单也在准备边界明确拒绝，不回写历史记录。
4. 在 LLM 层集中实现白名单/转换及不可续接校验，Core 发布器复用；协议适配器在最终 lowering 前再验证所需结构/引用，避免只保护新消息。不能只用 Unknown 类型检查通过就宣称 wire 格式有效，也不为本批更改正常模型执行或成功工具重放规则。
5. T20 必须经过真实供应商 parser → Core 事件发布与 projector → 消息读取 → toLLMMessage → LLM prepare/本地假 HTTP，分别核对存储、读回及最终 wire body。Anthropic 各支持工具分别覆盖合法错误结构；OpenAI 覆盖 store=true/false、有效/缺失/错配 itemId；普通本地工具为对照。消息/API 中无诊断标记与 HTTP 请求格式合法是两条独立断言。
6. 保留必要协议身份不等于保留秘密：假秘密放在任意 message、cause、扩展 metadata 等诊断位置；必要标识使用受控合法测试 ID，检查不被替换或串用。未知码/恶意引用等负例预期安全拒绝，不以“原文消失但请求无效”计为成功。

### P4.3 必测矩阵

| ID | 场景 | 预期 |
| --- | --- | --- |
| T01 | daily/runNow 的 RateLimit | failed、可重试、任务保持启用，原计划保留 |
| T02 | Transport/ProviderInternal/无效输出 | 正确 code/retryable；不误停用 |
| T03 | NoRoute/Quota/Policy/未知 typed 执行错误 | 安全 TASK_EXECUTION_FAILED，不冒充项目错误 |
| T04 | requireReady 明确项目/Relay 模型/缺 key；ModelNotSelected、VariantUnavailable、UnsupportedApi | 仅这些来源明确的分支暂停；等待记录正确收尾；不将歧义 ModelUnavailable 纳入本行 |
| T05 | 自动 daily、手动 daily、自动 once | 区分 advance：自动 once 原本停用，不重新启用 |
| T06 | 执行中用户停用，再失败/中断/成功 | 数据库与 GET 保持停用，终态事件 task.enabled=false；run 结果正确，不用旧快照恢复状态 |
| T07 | 同项目后继任务、跨项目、失败/取消/通知故障 | 项目锁释放与串并行规则保持 |
| T08 | 假 HTTP 429 走真实 LLM/runner→调度边界 | 不仅测试分类 helper 或 resume 替身 |
| T09 | 后续正常到期执行、数据库重建读取、事件 | 任务仍可按计划执行；不重放失败旧 run |
| T10 | typed、纯 defect、中断+defect、清理/恢复失败均带假秘密标记 | 实际执行日志、DB、事件、API/适用页面无标记；内部中断保持；新 code 可解码显示；至少一例经过真实 SessionExecution 日志出口 |
| T11 | requireReady 成功后，以屏障让真实 model resolver 的 Relay 凭据读取临时失败 | 经过真实 AuthError→ModelUnavailableError 包装；本次失败、任务仍启用；不能只手造模型错误 |
| T12 | 普通供应商真实模型缺失，走 ModelUnavailableError | 按保守策略不暂停；与 T04 明确配置错误对照；用户可见安全 MODEL_UNAVAILABLE |
| T13 | 真实 SecretStore→Auth→requireReady：系统读取失败且无文件副本；有副本/确实不存在对照 | 前者 SECRET_STORE_UNAVAILABLE 且不暂停；有副本继续执行；明确不存在才 KEY_MISSING 并暂停；不只手造 AuthError |
| T14 | 终态读取后发布挂起时停用、停用先赢、停用再启用、任务删除、发布失败/取消 | 按 P4.2a 顺序核对 DB/GET/事件；旧 epoch 不停用新计划；无旧任务复活、锁自等待或重复通知；不同任务不被阻塞 |
| T15 | LLMError、流内 provider-error、工具异常的错误/metadata 带假秘密；正常/中断对照 | 真实 Step/Tool 失败事件、消息投影、读取 API、运行记录及适用日志/页面无原文；内部 Cause/中断和正常输出保持 |
| T16 | tick 扫描后认领前停用/删除/停用再启用；runNow 等待期间停用；重复时段；准入先赢再停用；once/daily 对照 | 区段内复检拒绝旧候选且零认领/推进；成功认领与推进同事务；旧快照不写回 enabled；启动前 epoch 复检，不执行旧 pending；自动 once 已认领运行保持 |
| T17 | tool-error 与 tool-result(error) 的字符串/对象/嵌套 value、metadata 标记；本地/合法托管/未知格式；成功对照 | error/result 均安全，存储/读取无诊断原文；可续接分支的请求保持工具失败语义；未知托管格式按 T20 拒绝；执行次数及成功输出保持 |
| T18 | publish 前取消；首监听者接收后第二监听者失败/取消；失败点不明；正常发布与慢消费者 | 未投递/部分交付/未知/发布完成按证据区分；正常入队不冒充页面消费；不重复投递或重写状态，释放区段后后继操作可继续 |
| T19 | 精确同槽手动/自动先到；活动/终态/历史旧 epoch；重启、并发、回滚、通知失败及非同槽对照 | 同槽只一次尝试；合法自动路径只补推进一次，不重复会话/工具/终态通知；once 不卡旧时间，daily 后续正常；停用与原 runNow 错误语义保持 |
| T20 | Anthropic 各已支持托管工具错误、OpenAI store/引用组合、未知/损坏协议字段、本地工具对照 | 经真实 parser/事件/消息到最终 HTTP body；必要结构和引用正确、无诊断原文；无法安全重建时请求前 typed 拒绝且零 HTTP，不改变成功路径 |

T08 使用本地假供应商和真实产品调用链；T11 使用受控凭据适配器与真实 resolver；T13 使用真实 makeLayer/Auth/requireReady，只替换系统 API；T10/T15/T17 经过真实执行日志、事件发布、投影、读取和后续模型请求；T16/T19 使用正式 tick/runNow 的准入入口与事务屏障；T20 验证各供应商实际 wire 请求体与拒绝时零请求；T18 使用真实 EventV2 及按顺序登记的受控监听者/订阅流，不能只用 publish 替身或投影 helper。所有样本均不得请求实际付费模型。时钟驱动与真实 I/O 分清，禁止把固定等待当作执行完成。

## 8. P5：项目配置读写闭环

严格继承原方案第 7～12 节及 F01～F36。本节给实施顺序，不简化来源、锁或取消要求。

1. 先确认本地写入语义：当前目录已有 opencode.json/jsonc/.opencode 候选选实际最后参与者；只有父/全局时新建当前 opencode.jsonc；不改外部 OPENCODE_CONFIG、home/组织/环境/托管来源。
2. 禁用项目配置、候选损坏/拒读/只读/域外时明确失败，不转写低优先级文件。更高来源覆盖按原 7.3 验证，不能写了无效值仍 ACK 成功。
3. 提取共享来源快照和目标描述，包含逻辑来源、实际身份、合并位置、未展开原文、摘要、读写限制；不用 MCP contributed 名单冒充全字段来源信息。
4. 保持引用原文，临时展开仅用于有效配置校验；不把继承字段或密钥明文回写。JSONC 保留注释；模板不可编辑与真正损坏按原错误区分。
5. 按原规则取得选择锁与规范身份去重的文档锁，锁内重读并复检；保留 legacy 别名拒绝及新协议门禁，不切换锁后端或写生产迁移标记。
6. 项目写入登记 preparing/admitted/committed/handoff 责任，取消和关闭按原方案收尾。发布前取消不写；发布已准入后排空真实操作；通知/重建失败不能丢责任或重放 PATCH。
7. 只有目标原文加本次补丁参与发布。no-op 与真实提交区分，避免虚假通知/版本增长。
8. 更新 CONFIG_* 公开错误、冷态预检和 handler 映射；正式生成两套客户端。
9. 盘点 ConfigDocument/InstanceWork 的所有共享调用方，回归 MCP、全局设置、图片设置及可选 schema 注解，不只测试新项目入口。
10. 迁移旧 I30 测试的目标夹具：用明确规则断言真正目标，不从生产 selector 计算 expected。保留原失败日志，成功必须 GET/实例重建再次读到有效值。
11. 遗留错误 config.json 不自动读入/删除/覆盖；本批不实施导入。必须在结果报告告知旧错误文件不会自动恢复设置。

P5 的完成依据是全部适用 F01～F36、既有 MCP/图片等保护回归及生成检查，不能只把 config.json 改名后关闭。

## 9. 测试执行与公开契约

所有命令均在 P0 隔离 launcher 建立环境之后运行；从包目录执行，禁止根目录 bun test。下面是现有入口骨架，新增正式测试文件在 P0 登记后逐一加入，不将示例路径假称已运行。

| 包/目录 | 检查 |
| --- | --- |
| packages/core | bun test --timeout 60000 ./test/relay-secret-store.test.ts ./test/relay-auth.test.ts ./test/relay-mutation-replay.test.ts ./test/relay-create.test.ts；追加正式取消/删除边界及读取结果分类文件 |
| packages/core | bun test --timeout 60000 ./test/scheduled-task.test.ts；追加真实 LLM 429、凭据故障、认领/同槽补推进、任务事件排序/部分交付及会话错误载荷/供应商请求体集成文件 |
| packages/core | 目录事务、AtomicDocument、ConfigDocument、图片设置、路径/协议回归；按 P5 原矩阵登记 |
| packages/llm | Anthropic Messages/OpenAI Responses 的 parser、托管错误 wire 转换及既有成功工具回归；新增 T20，固定入口后运行本包测试与 bun typecheck |
| packages/server | isolation.test.ts；Relay HTTP 文件分别独立进程运行，包含受保护/兼容删除及凭据错误；追加图片/调度公开契约 |
| packages/app | bun test --tsconfig-override ./tsconfig.test.json --conditions=browser --preload ./happydom.ts ./test-browser/，或登记的受影响文件列表 |
| packages/app | 原 src/hooks 辅助测试另跑；不能替代 test-browser 的实际 createRelaySettingsState |
| packages/opencode | bun test --timeout 120000 ./test/server/httpapi-config.test.ts -t I30；随后执行原 F 矩阵登记的 config/InstanceWork/HTTP/共享调用方回归 |
| 每个受影响包 | 包内 bun typecheck；App 测试文件及 E2E 另跑覆盖它们的类型检查入口；当前 app tsconfig 的 include 不含 test-browser，须在 P0 核实已有专用脚本，若无则增加窄的配置/脚本，不能拿 bun 转译执行充当静态检查 |

公开 schema/HttpApi 变化后：在 `packages/client` 执行 `bun run generate`；按根规范运行 `bun ./packages/sdk/js/script/build.ts` 生成旧 SDK（脚本从仓库根调用，非根测试）。检查实际差异和双方 `bun typecheck`。不手改 generated。不含某路由的客户端也需执行要求的生成并记录无相关变化，不能臆造契约。

新增 TASK_EXECUTION_FAILED 必须由 schema→Core/Protocol→Server→Client 的既有依赖方向传播；查齐消费者的穷尽分支。如最终 P5 修改 Desktop/其他包的共享依赖，按影响补类型检查，不能拿过滤错误输出当作整个包通过。

首次失败与复跑全部保留。某次超时或启动失败后单测通过不能抹去首次失败；分析是测试资源、产品等待还是隔离问题，再决定是否需要重跑联合批次。

## 10. P6：统一验收与关闭

1. 固定最终源码候选及所有生成物摘要。重新创建隔离数据和服务，不使用实现前的旧后端；只管理本轮登记的进程，不能重启用户应用。
2. 在同一候选运行全部适用自动矩阵：旧 O01～O29、F01～F36，加 I01～I03、S01～S17、A01～A08、V01～V10、T01～T20。共 123 个登记行，行内子场景仍须逐项记录，不能用总 pass 数代替覆盖。
3. 真实设置页面覆盖经典/现代的 Save、名称/空补丁、Get models、勾选、清钥、删除、换服与重建交错；workers=1、retries=0，动作前注册等待，验证具体实体和版本。
4. 项目 /config 没有对应页面动作时，用实际调用方和真实 TCP，不制造虚假按钮；勾选页面通过不能替代项目配置验收。
5. 调度页面若展示错误，检查新 code 的文案和任务开关状态；没有该入口时记录正式 API/事件/数据库证据及页面适用性，不捏造页面通过。
6. 页面验收使用独立端口/上游和唯一假数据。保存成功同时核对返回、目标磁盘、服务/前端状态、页面；失败样本核对写入次数、原字节、剩余租约/恢复记录和未受影响实体。
7. 退出时按 PID、命令行、创建时间核对并停止本轮进程；等待退出和端口释放后清理自建数据。删除前验证绝对目标、归属和 reparse 身份，仅删隔离根内本轮记录；保留日志/摘要/trace，无源码备份。
8. 检查 index 和非本轮文件未被修改；输出逐项状态、已知限制、实际运行平台/模式，以及未执行项。

### 每项关闭依据

| 编号 | 自动依据 | 集成/页面依据 | 关闭限制 |
| --- | --- | --- | --- |
| SECRET-SCHEMA-01 | S01～S03/S17 typed 错误/原字节/读取分类/脱敏 | 正式 HTTP 冷/热边界、真实 Auth 读取 | 未测平台原生凭据不标跨平台通过 |
| SECRET-CANCEL-01 | S04～S16 生命周期与恢复 | 真实服务作用域、journal/配置发布、文件 fallback、竞争者及退出排空 | 内存适配器证明契约；原生验证范围单列，不清理未知历史 orphan |
| AUTH-REPLAY-01 | A01～A08、原 O24～O29 后端 | 正式 TCP 旧/新请求形状 | 不承诺跨重启普通命令无限可重放 |
| OBS-01 | 原 O01～O29 | 两布局既有失败样本转绿、四层对账 | 能力兼容与有限等待限制随报告交付 |
| UI-VIS-01 | V01～V09 | V10 两布局及最新快照对账 | 页面未跑则保持页面待验收 |
| TASK-ERROR-01 | T01～T07/T09/T12/T14/T16/T19 | T08/T11/T13 真实调用链、T10/T15/T17 完整错误载荷、T20 供应商最终请求体、T18 真实部分交付；Session 性能对比 | 同槽合并不等于成功；未知托管格式安全拒绝；不自动重试旧 run，不承诺跨进程全局顺序/客户端必达 |
| ACC-F02 | 原 F01～F36 适用项 | TCP 正常/断连/重建、共享入口 | 遗留 config.json 不自动导入；平台和外部来源原子性边界保留 |

“自动验证通过”“本机集成通过”“页面待验收”“平台未执行”分别记录。只有该项所有约定适用义务完成，才可写本范围关闭；不能把七项修复外推为项目所有 bug 已消除。

## 11. 交付物与停止规则

实施交付应包含：逐阶段 manifest/checks/handoff、各矩阵行与子样本结果、首失败和最终日志、生成物/类型检查结果、页面 trace/必要截图、四层对账、进程和隔离数据清理记录，以及一份最终实施报告。

任何阶段发现新根因：先给出独立复现，判断属于本不变量的遗漏还是新增范围；修改方案和矩阵后再继续依赖工作，避免边实现边无边界扩张。若共享依赖导致旧保护回归失败，保留现场并修正本阶段，不能只更新断言为现有错误行为。

R3-03B、RF-07 跨平台、历史其他 UI/工具授权项保持原状态。本方案不启用生产迁移、不发布、不提交。实施后的运行安装/推送需按用户后续指令处理。

## 12. 本方案自检

已核对：七项均有阶段/文件/步骤/矩阵/关闭依据；原 65 行矩阵保留，本文件 58 行形成 123 行登记，原编号不变；命令重放与清理证据分离；取消覆盖 journal、凭据与配置真实 I/O；fallback 成功与取消/双失败分开；勾选读取 fence 不依赖不存在的公开回执；歧义 ModelUnavailable 不停用；系统读取失败不降格成 KEY_MISSING；任务准入在短区段内重新检查，新认领/自动推进同事务，同槽既有尝试仅补消费计划；任务状态和事件排序，不用旧快照恢复用户状态；通知失败区分部分交付与结果未知；内部 Cause 与安全输出分开，Session 日志、错误事件完整载荷、消息投影及供应商最终请求体纳入范围、保护回归和性能门禁；托管工具保留合法协议结构/引用，未知格式明确拒绝；新公开错误纳入生成与消费方；隔离有导入前准入与导入后对账，后置失败不声称零写入。

本节是文档一致性检查，不代表代码已修复、测试已通过或真实页面已验收。执行时以 P0 实际候选重新验证。

## 13. 第 2 版修订追踪

| 复核问题 | 修订决策 | 新增/修订验证及门禁 |
| --- | --- | --- |
| ModelUnavailableError 混合永久与临时来源 | 本批保守不暂停，不改 Session 错误联合；明确配置分支仍暂停 | T04、T11、T12；P4 分类表及关闭依据 |
| 导入 Global 后才检查可能已经写入 | 先无副作用准入最终资源选择，再动态导入和对账 | I01～I03；P0 门禁 |
| S06 要求所有系统失败都保留旧配置，与 fallback 冲突 | 取消、文件回退成功、双后端失败分别定义 | S06、S12、S13；P1 门禁 |
| 只保护系统 set，遗漏 journal/配置投递完成 | 发布记录前登记责任；write/chmod/rename/remove 均等待真实完成 | P1.2a、S14～S16；P1 与取消关闭依据 |
| abandoned/恢复/Session 日志仍可能输出原始 Cause | 保留内部控制流，所有输出独立安全投影；登记窄日志修改及修改前性能基线 | T10；P0.1/P4 门禁及关闭依据 |

本次仅修订实施方案，没有据此实施产品修改或执行回归；以上用例均为待执行义务。

## 14. 第 3 版补齐追踪

| 复核遗漏 | 本次确定的修改 | 验证与关闭门禁 |
| --- | --- | --- |
| 系统 get 异常被 undefined 吞掉，前置检查仍误报 KEY_MISSING | P1.1a 保留三态；允许可用文件回退，无法确认不存在时返回 UnavailableError | S17、T13；P1/P4 与相关关闭依据 |
| 只保持数据库 enabled，却发布旧 task | P4.2a 同任务短状态/发布区段，终态重读；旧认领 epoch 不覆盖新启用计划 | T06、T14；DB/GET/正式事件顺序及失败释放 |
| 原文在调度前已进入 Step.Failed/Tool.Failed | P4.2b 登记 llm/publish-llm-event 安全投影，覆盖流内错误及诊断字段 | T10、T15；真实事件/消息投影/读取/日志及性能基线 |

本版保留七项缺陷编号与原矩阵编号，新增 S17、T13～T15 共 4 行。114 行旧登记加 4 行为 118 行；每行子场景分别采证。此前版本的实施限制继续有效。本次仅补齐文档，所有新增验证仍待执行。

## 15. 第 4 版修正追踪

| 复核问题 | 修正决定 | 回归和门禁 |
| --- | --- | --- |
| 排队后的旧 tick 快照仍能认领并写回 enabled=true | P4.2a.1 区段内重检当前状态；认领与自动推进同事务；daily 不从旧快照回写 enabled | T16，保留 T05/T06/T14；P4 准入及状态对账 |
| tool-error/tool-result(error) 绕过辅助函数，result 保留原文 | P4.2b 列全发布分支；error/result/metadata 同步安全化，错误 result 的内容允许改变但失败语义保持 | T17 与 T15；原始/持久事件、消息、公开读取及后续模型请求 |
| publish 失败被一律登记未交付 | P4.2a.2 区分未投递、部分交付、未知和发布完成；不推断客户端消费，不自动整批重放 | T18；真实监听者前缀与订阅流验证 |

保留此前全部矩阵编号，新增 T16～T18 共 3 行；本文件 56 行与原 O/F 65 行合计 121 行。第 2、3 版追踪表作为修订历史保留；当前实施以本版正文及门禁为准。本次只修正文档，没有实施产品修改或执行回归，新增用例均待执行。

## 16. 第 5 版修正追踪

| 复核问题 | 修正决定 | 回归与门禁 |
| --- | --- | --- |
| 重复认领永不推进使手动占用的自动时刻长期卡住 | P4.2a.1a 保留同槽唯一尝试；当前合法自动候选遇已有同槽 run 时仅补推进计划，不复用副作用或重复终态通知 | T19；重启/历史记录/事务回滚/once/daily 均采证 |
| 托管错误统一字符串破坏供应商结构或引用 | P4.2b.1 区分普通工具、Anthropic 结构化错误和 OpenAI item_reference；集中白名单转换，未知格式请求前安全拒绝 | T20；真实 parser 到最终 HTTP body，LLM 包类型检查与成功路径回归 |

当前为 58 行新增矩阵加原 O/F 65 行，共 123 行。旧修订追踪中的数量仅表示当时版本，实施以第 5 版正文、矩阵和关闭条件为准。只修改方案；未变更数据库/产品代码、未运行测试、未提交或操作现有应用。

