# 图片保存四项缺陷详细修复实施文档

日期：2026-11-16。版本：1.1。状态：**原始复现已通过，CL-05/CL-07 补修待实施，完整验收未关闭**。

对应 [主方案第 17 节](./additional-bugs-fix-implementation-plan-2026-11-16.md#17-局部实施复核后的图片保存补修16)。本文是该节的执行细化，不替代其他 ADD 项目、平台权限或历史界面验收。本次只编写文档，不修改产品代码、测试代码或生产数据。

**1.1 执行入口为第 9 节。** 最新独立复核已确认原始三个行为复现通过，Core/Server/OpenCode 类型检查通过；取消与失败同时发生的四种组合也通过。剩余已确认问题是 CL-05 创建失败后永久 active 和 CL-07 多入口重复清理，另需补齐仓库取消回归。第 1～8 节保留完整背景和总体验收要求，其中原始失败描述是历史基线，不代表当前源码仍有这些原始失败。

## 1. 目标、依据和边界

目标是在图片设置的真实保存链路中同时保证：提交状态不误报、取消不提前释放锁、错误类型可检查、清理失败不逆转成功。修复必须沿 `HTTP handler → ImageGenerationSettings.update → ConfigDocument.withLock → AtomicDocument.publish` 验证，不能只测试独立的映射函数。

1.0 编写依据目录：`C:\Users\zh2100\AppData\Local\Temp\opencode-img-acceptance-f544897f33784402983d57504ac35070`。其中保存了 `acceptance-report.md`、源码摘要、外置失败用例、原始日志及 `packaged-source.json`。1.1 最新证据见第 9 节。临时目录不是长期依赖；实施时将必要用例纳入仓库，将日志及摘要归入本轮长期证据目录。原始敏感内容不得进入证据，测试只使用假凭据。

验收基线 HEAD：`6b051f12a21094df1adef83f9fddfcbb765b319e`，但受测内容包含大量未提交修改。HEAD、版本号或文件时间都不能单独标识候选，必须记录源码 SHA-256。

| 编号 | 确认事实 | 根因 | 本轮完成条件 |
| --- | --- | --- | --- |
| IMG-R1 | unknown 拒绝返回 unavailable 和“配置未替换” | 在成功通道判断被拒绝的 CommitError，外层统一覆盖错误语义 | 失败通道正确分类，HTTP 保留待核对语义 |
| IMG-R2 | settled=false 时竞争者已获锁；随后原发布写入磁盘 | Fiber 中断先结束租约，底层 Promise 仍执行 | 已投递 IO 完成及收尾前，后继始终拿不到租约 |
| IMG-R3 | Core/Server 均在图片服务 catchTag 报 TS2345 | 原样 unknown 破坏错误联合，末尾断言不能修复 | 不靠断言或忽略错误，完整受影响包类型检查通过 |
| IMG-R4 | 目标已写入，rmdir 失败一次后返回 prepare；第二次清理成功也仍报错 | 提交和清理落在同一失败转换中，清理责任未完整区分文件与目录 | 已提交始终保持提交成功，清理失败登记并独立重试 |

1.0 历史验收结果：Core 44 pass / 1 skip，Server 17 pass；补充边界 3 fail，Core/Server 类型检查退出 2。该批失败在 1.1 最新复核中已转绿，完整结论见第 9 节。常规通过不能抵消边界失败；POSIX 用例在 Windows 跳过不能算跨平台通过。

本轮保留现有 DACL/受保护暂存目录、`publishCopy`、图片错误 code、别名门禁与锁协议。不得通过撤销这些改动来掩盖问题。不得重启当前应用、修改生产目录、切换原生锁协议、提交或推送。新的包仅在自动门禁通过后构建到新目录；安装和发布不属于本次文档执行默认范围。

## 2. 先固定结果契约

### 2.1 提交与清理是两个状态

提交状态只能按证据从 preparing 进入 committed 或 unknown；明确提交前失败为 prepare。committed 不得回退成 prepare/unknown。unknown 不得仅根据文件内容相同、取消、回包丢失或重试成功推断为未提交。

| 状态/触发 | 发布器结果 | 服务及 HTTP 行为 | 清理规则 |
| --- | --- | --- | --- |
| 确认提交前失败 | 拒绝 CommitError(prepare) | unavailable + 固定未提交文案；HTTP 400，kind=unavailable | 清理已确认属于本操作的对象，失败责任保留 |
| 发布结果不可确认 | 拒绝 CommitError(unknown) | unknown + 固定待核对文案；HTTP 400，kind=unknown；不自动重发 | 隔离原证据及关联目录，自动清理不得触碰 |
| 确认提交，全部收尾完成 | `{ committed: true, cleanupPending: false }` | 既有配置成功响应，HTTP 200 | 无遗留责任 |
| 确认提交，文件或目录仍待清理 | `{ committed: true, cleanupPending: true }` | 仍为既有配置成功响应，HTTP 200；不再次保存 | 保留对应所有权记录，后续只补清理 |
| 发布调用拒绝普通未知异常 | 无可靠阶段证明 | 保守映射 unknown/待核对，不承诺“未替换” | 不由服务层擅自清理或重试发布 |
| 发布前读取、锁或解析失败 | 尚未调用发布器 | 分别映射 unavailable/alias/invalid/conflict 的固定安全错误 | 不产生新的发布任务 |

本轮不增加公开响应字段。内部继续使用 `ImageGenerationSettings.Error { code, message }`，code 为 alias/conflict/invalid/unavailable/unknown；handler 继续映射到已有 `InvalidRequestError { kind, message }`。不能因为 HTTP 是 400 就认定磁盘没有变化，kind=unknown 明确表达不确定性。

`cleanupPending` 表示本次操作尚有未完成清理责任，不表示全局任意操作有遗留。真实提交确认后，即使回执观察者或临时目录删除失败，也不能走 prepare 分支。确认丢失但文件身份与内容证据足以确认提交的既有路径必须保留。

### 2.2 取消状态不代表提交状态

| 取消时点 | 允许行为 |
| --- | --- |
| 等锁/发布投递前 | 可以中断；发布计数为 0；释放已获得但未使用的租约 |
| 已投递、Promise 未结算 | 记录中断请求，继续持有租约，等待真正的发布/收尾完成 |
| 发布成功、取消待处理 | 目标可以是新值；恢复中断，不能把取消解释为回滚 |
| 发布失败、取消待处理 | 同时保留中断和已脱敏的发布失败 Cause；不能伪造成功或重放 |

不得对无法撤销的发布 Promise 使用 `Promise.race` 超时后释放锁。超时只能说明等待超时，不能宣称操作终止。测试有总体截止时间；若发布永不结算，应把该场景记为阻塞失败，并只处理本轮拥有的测试进程，不释放仍在写入的生产租约。

## 3. 修改范围

| 文件 | 修改内容 |
| --- | --- |
| `packages/core/src/config/atomic-document.ts` | 明确不可逆提交边界；文件/目录的清理记录及安全重试；IMG-R4 |
| `packages/core/src/image-generation-settings.ts` | 发布失败分类、完整错误边界、取消排空、去除返回类型断言；IMG-R1～R3 |
| `packages/core/src/util/settled-io.ts` | 增加显式选择的 `drainWithCause`（拟新增名称），保留既有 drain 行为 |
| `packages/core/test/config/atomic-document.test.ts` | 已提交清理失败、目录所有权、重试与 unknown 对照 |
| `packages/core/test/image-generation-settings.test.ts` | 真实服务/锁/发布器的状态与取消矩阵 |
| `packages/core/test/settled-io.test.ts` | opt-in 排空入口的取消/成功/失败组合 |
| `packages/server/test/image-generation-settings-handler.test.ts` | 真正路由与服务的错误 kind、脱敏、成功待清理 |
| `packages/opencode/test/config/atomic-entry.test.ts`、`tui.test.ts` | 共享发布器的 MCP/迁移/备份对照；按实际覆盖补用例 |
| `specs/additional-bugs-fix-results-2026-11-16.md` | 追加阶段候选、命令与结果；保留原始失败 |

`ConfigDocument`、`EffectFlock`、原生锁源码不需要为本轮重写。`packages/server/src/handlers/image-generation.ts` 的现有 kind 映射原则上只验证；如必须修改，记录具体原因。`publishCopy`、`retire` 和配置发布调用方属于共享影响范围，不能只通过图片保存测试就宣布共享修改安全。

## 4. 阶段基线及实施顺序

| 阶段 | 输入 → 输出 | 工作 | 退出条件 |
| --- | --- | --- | --- |
| S0 | 当前源码 → IMG2-B0 | 固定范围、摘要和现有行为 | 所有测试根通过隔离准入，基线可重现 |
| S1 | IMG2-B0 → IMG2-R0 | 补真实失败回归 | 三项历史红测重现；新增边界记录实际结果，不预设都失败 |
| S2 | IMG2-R0 → IMG2-C1 | 修复 AtomicDocument 提交/清理分离 | R4 与清理所有权用例通过；不宣称全阶段通过 |
| S3 | IMG2-C1 → IMG2-C2 | 修复服务错误通道与类型 | R1/R3、错误脱敏和 HTTP 分类通过 |
| S4 | IMG2-C2 → IMG2-C3 | 修复取消排空及 Cause | R2 的真实锁/磁盘/终态矩阵通过 |
| S5 | IMG2-C3 → IMG2-RC | 固定候选并跑联合、依赖与类型检查 | 四项自动关闭门禁均通过，未解释失败为 0 |
| S6 | IMG2-RC → 新产物摘要 | 重建 EXE，独立启动/界面验收 | 构建对应 RC；自动、GUI、平台分别记录结果 |

每个候选保存 HEAD、分支、全部相关文件 SHA-256（包括未跟踪文件）、暂存语义摘要、运行时/OS/用户、隔离根和测试列表。S2/S3 的局部通过不能提前替代 S5。后续补改生成新候选，重跑受影响门禁；日志不覆盖首次失败。

### S0：隔离与基线

1. 阅读根 AGENTS 和适用包约束；记录当前工作区差异，不执行 reset/stash/整文件还原。
2. 通过 `script/test-isolated.mjs` 从对应包目录启动测试。Global/服务导入前配置 HOME、XDG、临时根、数据库和托管配置；导入后不得切换进程全局根。
3. 为每个用例创建独立目录；运行前核对规范路径确实位于准入根。测试只监听 `127.0.0.1` 的独立端口，不调用真实供应商。
4. 保存当前关键实现和新/旧 EXE 摘要。不得把之前的 1.0.6 安装包当作本轮源码输出。

### S1：先将外置失败复现变成仓库回归

1. 把验收目录中的 unknown、取消后真实发布、一次 rmdir 失败三个用例按本项目测试风格落入上表文件。测试真实 Service.update、ConfigDocument 锁和 AtomicDocument，不复制实现。
2. 只在文件系统或发布边界建立可恢复的 spy/闸门。注入不得影响并行用例；使用注入的场景串行执行，或放入独立子进程隔离模块状态。
3. 取消用例使用非阻塞中断请求，或在另一个 fiber 请求中断；主测试线程要继续探测锁并放行。不能同步等待 `Fiber.interrupt` 完成后才去放行，否则正确修复也会死锁。
4. finalizer 按顺序放行闸门、等待真实 publisher 结算、等待写入 fiber 退出、恢复 spy、清理自有目录。断言失败也走完整收尾。
5. 对 unknown/quarantine 等进程级状态使用独立子进程，不能通过导出清空生产状态的测试后门让后续测试通过。保存当前类型检查错误为 R3 红测，不刻意制造其他编译错误。

### S2：先修发布器的提交与清理边界

#### S2-A：提交事实只在一个位置确认

1. 保留现有 no-replace 创建、Windows ReplaceFile、POSIX rename，以及确认丢失后的身份/内容核对。
2. 在正常发布返回成功，或核对确认目标确为本次发布时，明确记录 committed；记录发生在回执观察者和清理之前。
3. 把准备/发布失败处理与提交后的收尾分开。`prepare` 的构造只能出现在“确认尚未提交”的路径；不能用覆盖整个函数的 catch 将清理异常转换成 prepare。
4. unknown 继续隔离临时文件及其目录，并保留阻止盲目重发的现有机制。不得把 unknown 记录转入普通重试删除队列。
5. 已提交路径无论清理是否成功，都返回 `committed: true`。单次清理失败后本轮不立刻对同一路径循环重删；保留待清理记录，由下一次显式 cleanup 重试处理。`onCommitted` 调用最多一次。

#### S2-B：按操作登记文件与目录的所有权

当前 `pending`、`stages` 将文件和目录的责任拆散，又可能把目录放进只调用 unlink 的队列。本轮应改成内部的“每操作清理记录”，结构可按仓库风格实现，但必须包含以下信息：

- 操作标识、状态（active、retryable、quarantined、unidentified 等内部状态），以及关联的暂存文件和暂存目录。
- 文件记录：绝对路径、已获取的 dev/ino、必要时的内容摘要、完成状态；继续兼容 retire 的版本摘要核对。
- 目录记录：创建后取得的目录身份、绝对路径、完成状态。文件不存在不代表目录清理已经完成。
- 提交结果与清理记录分离；不能通过清空队列修改提交状态。

执行顺序：

1. 创建专属暂存目录前建立本操作的责任；目录创建后立即获取并保存身份，再创建文件。`fs.open`/`fstat` 失败也必须进入本操作收尾，不能因为尚未进入原来的 try 块而丢失责任。
2. 若创建结果或对象身份无法确认，保留 unidentified 责任并停止自动删除，不能只凭路径判断对象属于自己。不能通过放宽目录权限来完成清理。
3. 已登记文件先按身份/摘要核对后删除。ENOENT 对该文件视为完成，但继续检查关联目录；其他失败保留文件记录，目录不得先删。
4. 文件责任完成后处理目录。先核对真实目录身份、类型和无重解析变化，再确认其为空；只执行非递归 rmdir。若目录被替换、变成链接或出现未知条目，不删除条目、不递归清理，保留诊断责任。
5. 目录删除失败时保留目录记录，不能先从 stages/队列移除。目录 ENOENT 为完成；身份不符不冒充成功。身份核对不是抵御恶意并发路径替换的完整证明，本轮不扩大该安全保证，相关平台路径约束仍沿用主方案。
6. retryCleanup 对同一操作必须串行，不能由两个调用同时清理；活动发布与未知提交的整个操作都跳过，文件和目录不能分别逃过保护。旧记录不能删除同名新操作的对象。
7. 所有责任确认完成后才移除该操作记录。`cleanupPending` 从本次操作的剩余责任计算，而不是仅看 temporary 是否还在 Map 中。

`retryCleanup()` 的返回形状维持 `{ remaining, failed }`。本轮明确按“尚未完成的操作记录”计数，同一操作的文件和目录不重复计数；retire 可作为一条独立记录。active 记录可计 remaining，但不因尚在执行计 failed；本轮重试失败以及 quarantined/unidentified 责任按记录去重计 failed。成功重试后两项归零。同步更新测试说明，不用无依据的新计数掩盖遗留。

这是进程内清理责任，不能据此宣称进程崩溃后的持久恢复已完成。若需要持久日志，继续使用主方案对应阶段，不能在本轮偷偷加入敏感内容日志或生产迁移。

#### S2-C：失败路径不能被清理覆盖

明确 prepare/unknown 的原始结果必须保留。收尾失败记录在清理责任中，不能覆盖原始阶段，也不能把 prepare 升级成成功。普通投递异常没有可用提交证据时维持不确定结论。新建、替换、publishCopy、retire 都用同一所有权清理机制；未确认归属的旧文件绝不删除。

S2 退出前至少验证：一次/持续目录删除失败、文件先清理成功而目录失败、后续重试、陌生目录内容、身份替换、未知提交、活动发布和并发 retryCleanup。

### S3：修复图片服务错误映射与类型

1. 在 `Effect.tryPromise` 的 catch 中构造明确的 `ImageGenerationSettings.Error`，不要再返回原始 cause。
2. `CommitError(unknown)` → code=unknown + 固定待核对消息；`CommitError(prepare)` → code=unavailable + 固定未提交消息。发布阶段其他异常 → code=unknown + 固定待核对消息，不透传系统消息。
3. 删除成功分支中的 `instanceof CommitError` 和“不是对象即未提交”判断。正常返回按 `AtomicDocument.Result` 使用；cleanupPending=true 不抛错、不发起第二次 publish。
4. 保留 alias/conflict/invalid 的专用安全消息。将最初 read、持锁后 read 和锁失败纳入完整类型边界；保留锁请求的可取消性，不把中断抓成 unavailable。
5. 将入口生成的安全 Error 原样传递；其他内部异常映射为固定中性错误。不得把 `cause.message`、绝对路径、正文或假秘密写入响应。
6. 移除末尾 `as Effect.Effect<...>`。依靠真实推导满足 Interface；禁止 any、忽略类型错误或扩展公开错误联合来规避 TS2345。
7. 真 HTTP 使用当前 handler，校验 400 的 kind 和 message，200 的配置结构；发布器未知和普通异常都不自动重试。代码字段是当前基线，不能为了符合旧文档回退成只有 message。

S3 期间仍可有 R2 未修复，但必须在阶段结果中明确标记，不能作为整节验收通过。

### S4：修复取消生命周期与 Cause

1. 在 `SettledIO` 增加 opt-in `drainWithCause`，原 drain 和其既有调用方保持原语义。它承担“已投递不可撤销 IO 的排空并保留失败”的独立边界，不引入业务状态。
2. 在不可中断区域开始前设置取消检查点。若取消已发生，不启动发布 Promise。
3. 通过延迟执行的 Effect 启动 Promise，在 mask 内等待 `Effect.exit(effect)`，直到发布器完成其即时收尾或登记待清理责任。不得提前创建 Promise，不要把 publisher 的终止信号误当作文件系统完成。
4. IO 结束后恢复中断检查，并捕获该检查的 Exit：没有待处理取消时返回原 IO Exit；有取消且 IO 成功时保留中断；有取消且 IO 失败时用 Cause 合并两者，保留已脱敏错误，不让失败恢复分支启动备用写入。
5. 将该 helper 包在图片服务发布调用外、但放在 `ConfigDocument.withLock` 的 body 内。等锁及无 IO 的前置操作不纳入大范围 mask。
6. 使用现有资源作用域释放租约；不要另建第二个关闭入口，也不要在取消回调中自行删临时文件。若释放本身失败，保留可观察错误，不用 ignore 变成成功。
7. 测试正常、取消、prepare/unknown 同时到达的组合。中断后成功写入的磁盘结果必须明确记录，不能把 fiber 被中断当作文件未变的证据。

若实现选择直接修改旧 drain 而非增加 opt-in，视为扩大范围：先登记 relay-auth、relay-secret-store、project-write、tui-migrate 等全部直接使用方，并补它们的取消与错误恢复回归。不得在结果报告中省略这项影响。

## 5. 必须执行的测试矩阵

以下为实施用例，不是现有通过记录。原 IMG-T 编号保留，新清理用例标为 CL；每项记录返回结果、磁盘/身份、内存责任和真实请求/锁观察四类证据。

| 用例 | 场景 | 必须断言 |
| --- | --- | --- |
| IMG-T01 | 发布拒绝 unknown，cause 含假秘密 | code/kind=unknown；不含未替换、秘密或路径；发布一次 |
| IMG-T02 | prepare 与真实提交前失败 | 原目标及无关字段不变；安全未提交错误；无重试 |
| IMG-T03 | 成功，无清理/仍待清理 | 服务和 HTTP 均成功；目标是新值；待清理责任不丢失 |
| IMG-T04 | 闸门内发布尚未完成时取消 | 后继 tryAcquire=false；发布未结束，租约未释放 |
| IMG-T05 | T04 放行真实发布并成功 | 磁盘新值；原 fiber 中断；发布一次；结束后可取锁 |
| IMG-T06a/b | 取消后分别以 prepare/unknown 拒绝 | 失败与中断 Cause 同时保留；收尾后可取锁；无自动备用写入 |
| IMG-T07a/b | 等锁取消、投递前取消 | publish 计数 0，文件不变，无泄漏锁 |
| IMG-T08 | alias、初始读取、持锁后读取、无效文档 | 正确安全错误；不发布；无底层原文；完整类型检查通过 |
| IMG-T09 | 真实 HTTP 的 unknown/prepare/普通异常/成功待清理 | 400/200、kind 与配置结构正确；不靠 fake Service 替代真实路径 |
| IMG-T10 | 正常保存、目标在等待期间变化 | get/返回/磁盘一致；BOM/CRLF/注释保持；失效目标不写入 |
| CL-01 | 已提交后 rmdir 只失败一次 | 返回 committed=true、cleanupPending=true；本次不再次删目录或发布；下一次 cleanup 成功 |
| CL-02 | 已提交后 rmdir 持续失败 | 目标不变；目录责任持续存在；恢复删除能力后只补清理 |
| CL-03 | 文件 unlink 失败，之后文件成功但目录失败 | 两类责任按阶段推进；不能在文件消失时遗忘目录 |
| CL-04 | 文件已被允许的外部清理移除，目录仍在；以及目录也已不存在 | ENOENT 按对象分别处理，最终无假残留且不漏目录 |
| CL-05 | 暂存目录创建后 open/fstat/权限准备失败 | 不泄漏未登记对象；句柄关闭；归属不明则隔离而非按路径删除 |
| CL-06 | 目录新增陌生条目、替换同名目录或改成链接 | 不递归删除、不删陌生条目；保留失败责任，后继对象完整 |
| CL-07 | 两个 retryCleanup 并发、清理与活动发布并发 | 同一操作串行；活动文件/目录都不删；无重复认领 |
| CL-08 | unknown 后自动清理/再发布 | 证据和关联目录均保留，不重发；计数不双算 |
| CL-09 | 创建、替换、publishCopy、retire 对照 | 每种路径维持原权限/版本约束；清理失败不改变已提交事实 |
| CL-10 | 图片真实服务 + HTTP 发生 CL-01/02 | HTTP 成功且磁盘新值；后续 cleanup 不触发第二次保存 |

纯边界注入证明的是接纳/映射规则，不能替代真实发布。T05、T10、CL-01/02/09/10 必须包含真实磁盘操作。清理权限测试同时保留已有 Windows DACL、POSIX mode 用例；Linux/macOS ACL 和第二主体访问仍按主方案分开验证。

## 6. 命令与阶段门禁

从下列包目录执行；命令中的文件已存在。新增用例若另拆文件，先加入命令清单。必须保留退出码、测试数量与 skip 原因。不能以过滤后的类型错误列表代替完整检查。

```powershell
# 工作目录 D:\opencode\packages\core，S2/S4 定向门禁
node D:/opencode/script/test-isolated.mjs test --timeout 30000 test/config/atomic-document.test.ts test/settled-io.test.ts test/image-generation-settings.test.ts

# 同目录，S5 联合门禁
node D:/opencode/script/test-isolated.mjs test --timeout 30000 test/config/atomic-document.test.ts test/config/document.test.ts test/settled-io.test.ts test/image-generation-settings.test.ts test/scheduled-task-cancel.test.ts
node D:/opencode/script/test-isolated.mjs run typecheck

# 工作目录 D:\opencode\packages\server
node D:/opencode/script/test-isolated.mjs test --timeout 30000 test/image-generation-settings-handler.test.ts test/relay-auth-handler.test.ts test/relay-commit-handler.test.ts test/relay-catalog-lifecycle-handler.test.ts test/relay-probe-completion-handler.test.ts
node D:/opencode/script/test-isolated.mjs run typecheck

# 工作目录 D:\opencode\packages\opencode
node D:/opencode/script/test-isolated.mjs test --timeout 30000 test/config/atomic-entry.test.ts test/config/tui.test.ts test/config/config.test.ts
node D:/opencode/script/test-isolated.mjs run typecheck
```

如旧 drain 行为改变，另增 Core 的 `test/relay-auth.test.ts`、`test/relay-secret-store.test.ts`、`test/relay-secret-lifecycle.test.ts`、`test/relay-secret-boundaries.test.ts`，以及根据 rg 调用点识别的真实取消用例；仅跑名称相似的文件不代表覆盖全部使用方。

本轮保持 Protocol/HttpApi 结构不变时不重新生成 SDK。如实施时扩展公开结构，先记录范围变更，再按根 AGENTS 运行 Client/旧 JS SDK 生成与类型检查，禁止手改生成文件。反向排列 CLI 测试文件参数不能证明交换加载顺序，QA-02 的该项门禁继续单列。

## 7. 修复后重建和验收 EXE

旧包 `D:\opencode-builds\koda-1.0.6-20261116-182736\dist\Koda-desktop-win-x64.exe` 不作为本轮候选。其 asar 已确认包含旧的 CommitError 成功分支和未排空发布，且缺少当前错误 code。不得只改文件名或版本号就当成新修复包。

S5 通过后：

1. 固定 IMG2-RC 与打包源摘要，在构建开始、结束时再核对。发现相关源码变化，当前包作废为验收候选，重新固定并重建。
2. 保留原包及其历史记录，选择新的绝对输出目录。沿现有 `bun run build`（含 prebuild）与 `bun run package:win --x64 --publish never --config.directories.output=<新目录>`，不跳过本轮修复模块构建、不借旧 CLI 冒充新产物。遵守 Windows 路径检查与打包脚本约束。
3. 保留包当前版本，除非用户另行指定。相同版本可用于本地验收，但必须用源码/产物摘要区分；签名状态、内置 GDAL 与其他资源范围写入报告。
4. 对实际 app.asar 的后端 chunk 与构建中间产物做摘要核对，结合对应源码/构建清单确认新错误映射和取消入口已进入产物；仅搜索一个字符串不是充分证明。核对原生模块及 manifest 摘要。
5. 用隔离配置运行打包 CLI 的版本与可用的受控 API 检查。CLI 与 Electron 后端若走不同入口，必须分别验证，不能只因 CLI --version 通过就宣布桌面可用。
6. 独立启动本轮解包 EXE，使用独立 Electron userData、HOME/XDG/状态根、后端端口和浏览器上下文。启动前验证实际参数/环境能隔离其持久层、守护进程注册和单实例锁；不能证明隔离则保持 GUI 待验，不让它接入当前应用。禁用测试实例自动更新与真实供应商请求。
7. 页面验证图片开关/模型/API 保存、刷新、关闭窗口后重新启动测试实例读取；同时核对响应、磁盘及页面。取消、未知提交和清理故障必须使用受控夹具/API 阶段证据，不能凭关闭弹窗或断网猜测服务 fiber 已取消。
8. 结束时只关闭本轮记录的 PID/子进程。保存截图/trace、请求与数据摘要。未执行安装/卸载则明确标注，不能以解包启动替代安装验收。

## 8. 关闭条件、停止条件与交付

| 关闭对象 | 必须满足 |
| --- | --- |
| IMG-R1 | T01/T02/T03/T09 的服务与 HTTP 都通过，unknown 未误报且不重发 |
| IMG-R2 | T04～T07 真实租约、实际磁盘及 Cause 矩阵通过；无提前释放 |
| IMG-R3 | 去除断言后 Core/Server/OpenCode 完整类型检查退出 0 |
| IMG-R4 | CL-01～CL-10 适用用例通过；已提交不回退，责任可安全重试 |
| 本轮自动验收 | 同一个 IMG2-RC 上四项门禁及共享使用方回归完成 |
| 新 EXE 验收 | RC 到产物可追踪；独立实际启动/页面证据完成，未验内容明列 |

必须停止当前阶段的情况：隔离指向真实目录、出现真实凭据、无法证明对象清理所有权、unknown 被自动重试、清理成功覆盖主体失败、共享 helper 使既有用例回退，或类型检查仍失败。停止的是当前阶段推进，不擅自清理生产记录、不撤销用户其他修改。

实施交付时追加到既有结果记录：四项状态表、各阶段源码摘要、原始红/绿日志、实际命令和退出码、pass/skip/fail、真实入口证据、包文件与 SHA-256、未完成项。发生失败后复跑，保留首次失败及原因。只有经过本轮验证的环境可关闭对应项目，不能把文档写完、DACL 小样本通过或 EXE 构建成功写成“所有 bug 已修复”。

P1 的完整候选预留/权限安全、跨平台 ACL、第二主体访问、进程崩溃后的持久恢复、历史 UI、R3-03B 等继续保留原状态。本文新增的安全边界对照是验收要求，不将尚未复现的场景预先宣称为新增产品缺陷。

## 9. CL-05 / CL-07 剩余缺陷补修方案（1.1）

### 9.1 当前状态与本次范围

最新证据目录：`C:\Users\zh2100\AppData\Local\Temp\opencode-img-recheck-c3713907d8ce4318a8b90a05d0ba5c33`。参见 `recheck-report.md`、`additional-boundaries.test.ts`、`additional-boundaries.log`、`prior-boundaries.log` 和前后源码摘要。

| 项目 | 最新实测 | 本轮动作 |
| --- | --- | --- |
| 原 unknown、取消提前放锁、提交后目录清理误报 | 三项原始复现全部通过 | 保留实现并作为防回退用例，不重新设计 |
| 类型检查 | Core、Server、OpenCode 全部退出 0 | 保持完整门禁 |
| 取消同时遭遇 prepare/unknown | helper 与真实服务四种组合通过 | 将等价受控回归加入仓库 |
| CL-05 | open 失败后两次 cleanup 均 remaining=1、failed=0，暂存目录仍在 | 补齐投递到收尾的完整创建责任 |
| CL-07 | 发布即时收尾与 retryCleanup 对同一临时文件调用两次 unlink | 所有清理入口共用操作级认领 |
| 常规回归 | Core 49 pass/1 skip，Server 17 pass，OpenCode 定向 50 pass | 补修后针对同一新候选复跑 |

产品修改以 `packages/core/src/config/atomic-document.ts` 为中心。默认不改图片服务、HTTP 契约、锁协议和已经通过的 `drainWithCause`。测试修改为 `test/config/atomic-document.test.ts`、`test/settled-io.test.ts` 和图片服务测试；必要的 HTTP/迁移对照沿第 6 节执行。移除或接入当前未使用的 `settle()`，不得再保留第二个绕过认领的清理入口。

### 9.2 统一状态和所有权规则

保留现有业务状态 active/retryable/quarantined/unidentified；新增的“正在清理”由操作记录上的单一 in-flight Promise 表示，不与提交状态混用。字段名可按代码风格确定，以下 `cleanupOnce`、`cleanupTask` 是拟实现的内部概念，不是新增公开 API。

| 场景 | 记录归属与转移 | 后续行为 |
| --- | --- | --- |
| 创建调用尚未结算 | active，创建者拥有责任 | 后台清理跳过 |
| 创建/准备失败，残留对象身份已确认 | 停止生产新对象，转 retryable 并认领清理 | 完成后移除；失败保留责任 |
| 创建/身份确认结果不可知 | unidentified | 自动清理跳过；不能宣称没有残留 |
| 已确认未创建任何对象 | 完成并移除创建记录 | 返回原始 prepare 失败 |
| 提交未知 | quarantined | 保留原证据，禁止自动清理或重发 |
| 发布已确认成功 | 保持成功；收尾时转 retryable 并认领 | 清理失败只能增加待清理责任 |
| 同一操作已有 cleanupTask | 直接调用方复用该 Promise，后台扫描跳过并保留未完成计数 | 不再次检查后删除、不重新发起 unlink/rmdir |

不允许已结束的创建者留下 active 状态；不允许未确认身份时按路径删除；不允许状态变成 retryable 后在没有认领的情况下 await 或调用可重入逻辑。

`remaining` 计尚有责任的操作记录，不能仅检查已知 file/directory 字段：创建结果或身份未确认本身也是未完成责任。`failed` 包含 retryable 清理失败和 unidentified/quarantined 记录；仍正常执行的 active 不计失败。一个操作只计一次；不得把 active 残留改成“不计数”来让测试归零。

### 9.3 步骤 A：固定本轮基线并先补红测

1. 固定 `CL-B0`：HEAD、受影响文件摘要、暂存摘要、运行时、隔离根。先确认当前仍是最新复核候选，不能假定文件未被其他工作修改。
2. 将外置 CL-05、CL-07 复现移入 AtomicDocument 测试。用真实文件和真实 publish，在 fs.open/unlink 边界注入故障，不复制清理逻辑。
3. 在 CL-B0 上确认：CL-05 留下同一个暂存目录，连续 cleanup 没有进展；CL-07 同一路径出现两次删除调用。保存红测和退出码。
4. 闸门使用明确 entered/release 信号。测试截止时间只用于判失败和保障 finalizer 放行，不得把“等待若干毫秒没有观察到”当作互斥正确的唯一证据。
5. 活动或隔离状态可能污染后续用例的失败基线用子进程运行；不能为了通过而导出清空生产 Map 的后门。任何失败都放行并等待已投递 IO，再恢复 spy。

### 9.4 步骤 B：修复 CL-05，覆盖完整创建生命周期

**不要只把 fs.open 向下移动一行。** 暂存目录创建、目录身份读取、文件打开、文件身份读取、权限设置及句柄关闭都属于同一次责任。

1. 在任何创建 IO 前分配唯一操作 ID 和规范化的暂存目录路径，登记 active 的创建责任。将随机路径生成从仅在成功返回时才可见的 helper 内部移出；helper 可以接收已分配路径，但不得改变安全创建方式。
2. 从目录创建开始建立统一 try/catch/finally。handle 使用可选值保存，未成功 open 的分支也必须能收尾；只有取得 handle 才调用其 stat/close。
3. 目录创建成功后保存身份，再投递 file open。创建调用失败时先判断“明确未创建”还是“创建结果不确定”：只有确定不存在且无其他残留才移除记录；确认不了则转 unidentified，不自动删除。
4. open 明确拒绝且没有本次文件对象时，用已保存的目录身份做安全清理。若实际出现未登记文件或 open 的结果不确定，保留隔离责任，不凭路径把它认作自己的文件。
5. fstat 失败时优先从仍持有的 handle 恢复身份；无法恢复时关闭句柄并保留 unidentified。目录身份读取失败也必须留下责任，不能在登记前直接抛出而丢失创建结果。
6. 创建者停止生产新对象后，按步骤 C 的原子交接转为 retryable 并认领清理。清理失败保留责任，返回原始 prepare 失败；不让清理错误覆盖原始原因，也不能错误转成 committed。
7. 句柄关闭失败不得冒充已经关闭。区分已关闭状态、可重试关闭和无法确认状态，保留责任；不得先删除对象记录后让仍可能持有句柄的任务在后台运行。
8. 保持原有发布 unknown/committed 分类：暂存阶段的创建不确定是“清理所有权不确定”，不是“目标已发布”；只有确认尚未开始目标发布时才返回 prepare。

B 阶段退出：open/目录 stat/file stat 失败都有可解释终态；没有已终止操作永久 active；恢复故障后可清理的责任归零，不能确认所有权的责任明确隔离。获得 `CL-C1`，但 CL-07 尚未通过时不能宣布本轮完成。

### 9.5 步骤 C：修复 CL-07，统一所有清理入口

1. 将 `finishOperation` 拆成只有一个调用者能进入的工作体，以及统一 `cleanupOnce(operation)` 入口。发布成功收尾、发布失败收尾、retire、retryCleanup 全部经过该入口；无使用方需要的旧 wrapper 删除。
2. `cleanupOnce` 在任何 await 之前检查该操作现有 cleanupTask；存在时返回同一个任务，不创建新的删除流程。没有时同步登记一个延迟启动的 Promise，再执行工作体。禁止“先异步开始工作，稍后才把 Promise 放入记录”。
3. 发布者到清理者的交接在同一同步段完成：确认生产已结束 → 设置可清理状态 → 登记 cleanupTask，中间不能 await。回执回调要么在仍受 active 保护时执行，要么在清理认领完成后执行；不能留下回调重入后台清理的窗口。
4. 由已认领的工作体执行完整的身份检查、文件删除、目录为空检查和目录删除。其他调用不能先独立检查身份再等待删除，这会把检查结果变成过期证据。
5. 一个任务结束后才释放认领。成功删除对象后更新对应 done，失败保留未完成字段；只清除仍指向本任务的 cleanupTask。不得因旧任务结束而清掉后继任务的认领。
6. 只有全部责任完成且 Map 中仍为同一个操作记录时才删除记录。对 retire 的重复调用，相同对象身份/摘要应复用现有记录，不覆盖它；不同身份使用独立记录并按各自所有权验证。
7. retryCleanup 扫描快照后还要在认领入口复核当前状态和记录归属；active/quarantined/unidentified 跳过。扫描遇到已有 cleanupTask 的操作也跳过，并在返回计数中保留其未完成责任；不能把跳过当成已清理。即时收尾或重复 retire 等确需结果的直接调用方复用并等待已有任务。后台扫描不等待正在执行的任务，以免另一配置保存因该任务被不必要地挂住或形成自等待；不额外引入全局写入锁。
8. 全局 cleaning 可以保留为避免重复扫描的优化，但不是删除互斥的依据。工作体不得递归调用 retryCleanup 或等待自己的 cleanupTask，避免自等待。回执回调产生的清理请求也不能形成循环依赖。
9. 不使用未被等待的 `.finally()` 派生 Promise，防止清理失败产生新的未处理拒绝。原始失败、任务拒绝和责任记录按同一结果处理；外层吞掉清理异常时必须已经保留责任。

C 阶段退出：同一操作最多一个删除工作体，同一个已成功删除对象没有后续重复 unlink/rmdir；取消或异常不会丢认领，也不会永久占有认领。保留 `committed: true` 与每操作 cleanupPending 的原有契约，获得 `CL-C2`。

### 9.6 步骤 D：补齐取消回归，保留已通过行为

当前 `settled-io.test.ts` 首个用例在 `Effect.fail` 后连接 `Effect.interrupt`，后者不会执行，且仅断言 Exit.isFailure。替换为受控并发测试：

1. 启动使用 drainWithCause 的 gated IO，等待“已投递”信号。
2. 以非阻塞方式请求中断，再让 IO 分别成功、prepare 失败、unknown 失败。
3. 对失败组合同时断言 Cause.hasInterrupts 和 Cause.hasFails；断言包含安全错误、不包含注入秘密。成功组合保留中断但不伪造业务失败。
4. 在图片真实服务入口重复 prepare/unknown 组合，检查外层映射没有丢弃其中一种 Cause，并确认租约在 IO 结束前不可获得。
5. 保存原始 unknown、真实取消写入、提交后清理失败三项绿测，作为此次清理重构的防回退门禁。当前产品取消实现已经通过外置复核，默认只补测试，不重新改写 helper。

### 9.7 补修回归矩阵

| 用例 | 场景 | 成功标准 |
| --- | --- | --- |
| C05-1 | 目录创建后 open 明确 EACCES | 目标不变；原始 prepare 失败；空目录被清理或进入可重试状态，无永久 active |
| C05-2 | 清理目录持续失败，之后恢复 | 责任/计数保留；恢复后只补清理并归零，不重新发布 |
| C05-3 | 创建助手失败、目录 stat 失败 | 明确无对象可完成；归属无法确认则隔离，不能静默丢记录 |
| C05-4 | file fstat 失败、close 失败 | 不按不可信路径删除；句柄及对象责任完整、失败不被成功覆盖 |
| C05-5 | 创建/IO 尚在执行时并发 cleanup | 活动对象不被清理，生产结束后才交接 |
| C07-1 | 发布即时收尾挂在第一次 unlink，后台 retry 到来 | 同一删除任务被复用；该对象 unlink 一次；文件/目录最终状态正确 |
| C07-2 | 发布失败收尾与后台 retry 并发 | 保留原始 prepare 失败；清理不重入、不丢责任 |
| C07-3 | retire/重复 retire/retryCleanup 并发 | 相同记录不被覆盖，旧任务不能清掉新记录，无重复删除 |
| C07-4 | 清理失败后两个新重试同时到来 | 一次新认领；原任务完成前不能开启下一删除流程 |
| C07-5 | 回执回调请求 cleanup；两次 retry 并发 | 无重入窗口、无自等待、返回结果与计数一致 |
| C07-6 | 文件已不在但目录仍在；目录被替换或出现陌生内容 | 正确补目录清理；不删后继对象/陌生条目，不递归删除 |
| C07-7 | 一个操作清理挂起，另一独立操作提交/清理 | 不破坏独立操作的锁与提交；被等待者完成后所有责任可收尾 |
| CAUSE-1 | helper 与服务的取消+失败组合 | 中断与安全失败同时保留；失败文字不泄密 |
| INTEG-1 | 真实图片 HTTP/迁移/备份调用方 | 错误语义与成功待清理不回退，未出现重复保存 |

C07-1 必须检查即时收尾与 retry 两条路径，不能只启动两次 retryCleanup。每个用例有独立目录和模块状态隔离，最后等待所有任务完成并恢复注入。未知所有权场景保留证据，不为了清空目录而执行生产清理无法证明安全的动作。

### 9.8 联合门禁、记录与关闭

从相应包目录运行，所有参数通过隔离 runner；不从仓库根跑测试。

```powershell
# D:\opencode\packages\core：先定向，再联合
node D:/opencode/script/test-isolated.mjs test --timeout 30000 test/config/atomic-document.test.ts test/settled-io.test.ts test/image-generation-settings.test.ts
node D:/opencode/script/test-isolated.mjs test --timeout 30000 test/config/atomic-document.test.ts test/config/document.test.ts test/settled-io.test.ts test/image-generation-settings.test.ts test/scheduled-task-cancel.test.ts
node D:/opencode/script/test-isolated.mjs run typecheck

# D:\opencode\packages\server
node D:/opencode/script/test-isolated.mjs test --timeout 30000 test/image-generation-settings-handler.test.ts test/relay-auth-handler.test.ts test/relay-commit-handler.test.ts test/relay-catalog-lifecycle-handler.test.ts test/relay-probe-completion-handler.test.ts
node D:/opencode/script/test-isolated.mjs run typecheck

# D:\opencode\packages\opencode
node D:/opencode/script/test-isolated.mjs test --timeout 30000 test/config/atomic-entry.test.ts test/config/tui.test.ts test/config/config.test.ts
node D:/opencode/script/test-isolated.mjs run typecheck
```

全部采用固定 `CL-RC` 源码摘要。定向通过后不再修改源码再沿用旧结果；任何补改都生成新候选并重跑依赖门禁。以 pass/skip/fail 和原始退出码报告，避免用同版本号或“相关文件没报错”替代完整候选证据。

CL-05 关闭：创建失败各分支不再永久 active，责任已完成或明确隔离，原始故障恢复后可清理的记录归零。CL-07 关闭：全部清理入口共用认领，红测及并发矩阵通过，无重复删除、自等待和责任覆盖。取消回归必须纳入仓库，外置绿测不是永久替代。

本次不自动宣称整个 IMG-R4 已关闭；还需核对第 5 节其他适用 CL 用例及真实入口证据。将实际补修结果追加到现有实施记录，保留历史结果。只有同一候选上的适用门禁全部满足，才按第 7 节重建并独立验收新 EXE。旧包、跨平台权限、GUI 和历史未关闭事项状态不变。
