# R3-03B 根因修复规划与详细实施方案

日期：2026-11-09。工作区：`D:\opencode`。用途：供人工分阶段修改与复核。

本文只规划修改。创建本文不代表已修改业务代码、完成自动测试、接入原生后端或执行迁移。R3-03B 继续保持未关闭。

## 1. 与原方案、现有实现的关系

原总方案：[系统锁接入、资源隔离与迁移实施方案](/D:/opencode/specs/round3/r3-03b-implementation-plan-2026-11-09.md)。当前实施记录：[2026-11-09 状态](/D:/opencode/specs/round3/status-2026-11-09.md)。

本方案优先修正最近复核发现的 8 项问题。原方案中的原生业务接入、跨平台与打包验证、离线迁移继续有效，但应在本轮修正通过后再推进。

对原方案补充一条明确约束：**按资源域选择协调目录、限制自定义目录的新规则，只适用于经过批准的新协议空间；不能回写到 legacy 或既有 path-identity-v1 的历史目录选择中。**

同 data、不同 state 的协调要求，也必须按真实入口解释：Relay 和任务 owner 已显式使用 data/locks，应继续共享；不能为了让所有无 dir 调用共享 data 锁，改变旧版本原来的 state/locks 默认值。

### 1.1 本轮证据基线

以下来自上一轮复核，不是本文创建时重新执行的结果：

- Core 新增定向批次 19 项通过；调度原有恢复用例通过。
- Core 原有 EffectFlock、Flock 联合批次 3 通过、26 失败，其中多个用例直接被本轮自定义目录检查阻断。
- 单独执行 Flock 的 await using 用例，因新增的全局初始化前置条件失败。
- Desktop 打包配置及现有后台 CLI 测试 15 项通过；这些测试没有覆盖 installCli 的实际暂存事务。
- Core、OpenCode、Desktop 类型检查通过。
- 隔离复现已确认：旧目录锁可被新默认目录绕过；Effect 服务丢注册信息后允许缺标记写入；无效完成标记被根选择器接受；调度竞争失败后仍收尾；损坏暂存包被复用。
- 原生环境清理范围、系统错误分类两项是源码审查结论，尚未针对当前入库源码编译复验。先前临时原型通过，不等于当前源码通过。

不要把 26 项失败全部归因于同一个原因，也不要为恢复测试数量而修改正确的保守锁语义。

### 1.2 实施边界

1. 不重启或终止当前应用与服务。竞争、暂停、终止只针对专门创建的隔离 fixture。
2. 不写生产迁移标记、启动描述文件，不删除生产锁或 breaker。
3. 迁移脚本继续只允许 plan，不启用 apply/resume/rollback。
4. 保留工作区原有未提交修改；不自动暂存、提交或清理已有文件。
5. 本轮不顺带把原生后端接入生产锁。native 尚不可用时，明确失败，不能退回目录锁。
6. 不扩大会话公开错误联合类型来消化锁错误。优先在现有服务和 HTTP 边界映射。
7. 不修改 App 会话/timeline；若后续扩展该范围，先补 App 规范要求的生产性能基线。

## 2. 缺陷映射与交付批次

| 编号 | 问题 | 根因 | 批次 |
| --- | --- | --- | --- |
| RC-01 | 旧根默认目录改变，新旧锁分离 | 兼容约束只覆盖键和后端，未覆盖目录 | B |
| RC-02 | 自定义目录和独立 Flock 调用回归 | 新协议目录限制、Global 初始化要求进入旧 API | B |
| RC-03 | Effect 服务丢失注册信息 | 路径对象代替完整协议上下文跨服务传递 | B |
| RC-04 | 无效标记通过启动选择 | 启动只检查存在，校验延迟到业务获取锁 | B |
| RC-05 | 未取得 owner 锁仍恢复任务 | Some(false) 被当成功，短超时包装被当一次尝试 | C |
| RC-06 | worker 退出释放其他环境的锁 | 进程共享表缺少环境归属，清理范围过大 | D |
| RC-07 | 系统调用错误全部变 BUSY | 丢失 OS 错误码与错误分类 | D |
| RC-08 | 损坏/不完整的暂存包被复用 | 单 exe 存在模型未升级为完整产物包事务 | E |

依赖顺序：A 基线与契约 → B 协议兼容和根上下文 → C 调度所有权 → D 原生独立验证 → E 产物暂存 → F 综合复核。

C、D、E 可以分别形成可审查差异；本方案默认人工顺序实施。B 未完成前，不以业务测试证明根协议安全。

## 3. 必须先固定的不变量

### 3.1 锁身份

两个调用是否互斥，取决于同一协调对象及后端语义。检查时至少同时比较：资源空间身份、协调目录、键格式、锁键、后端、generation、epoch。不能只检查 hash 相同。

| 情况 | 键 | 目录 | 后端 |
| --- | --- | --- | --- |
| 未注册旧根、无标记、未传 dir | 原始键 | 原来的 state/locks | 目录锁 |
| 未注册旧根、无标记、显式 dir | 原始键 | 调用者原来指定的 dir | 目录锁 |
| 已有 path-identity-v1 | 规范化路径键；非路径 ID 保持原文 | 保留该协议既有的 dir 或 state/locks 规则 | 目录锁 |
| 已注册 os-lock-v1 complete | 规范化路径键；非路径 ID 保持原文 | 已批准资源空间中的固定 native 协调目录 | 原生文件锁 |
| migrating、损坏、未知、注册约束不符 | 不进入业务 | 不创建业务锁目录 | 不获取 |

legacy 的 domain 可以用于诊断，但不能决定一个新的默认目录。显式 data/locks 的认证、凭据、任务入口仍用原目录。

### 3.2 根上下文

Promise 与 Effect API 必须消费同一语义的资源根上下文。已注册根的 registration 不能是由调用者重组路径时可静默丢失的附带信息。

启动选择时校验描述文件和完成标记；每次加锁前检查它们仍满足启动时采用的约束。发现消失、替换、generation/epoch 变化时拒绝后续写入，不能在存活进程内自动切协议。

### 3.3 所有权与提交

- 只有真正取得的租约能授权临界区；诊断、无异常和文件存在都不能授权。
- 取消、BUSY、错误、取得成功必须有不同结果。
- 系统锁文件保留为稳定协调对象，正常释放不 unlink/rename/replace。
- 业务提交后的释放错误需要单独诊断，不能把已提交操作伪装为获取前失败并诱导客户端重复提交。
- 可复用的暂存目录必须代表一个经过完整验证、原子发布的产物包。

## 4. A 批：建立失败基线和契约测试

### 修改前操作

1. 记录 HEAD、git status、当前相关文件差异和未跟踪文件清单。记录只用于辨认本轮范围，不执行 reset、restore 或 git clean。
2. 保存旧协议的实际行为依据：原 Flock/EffectFlock 的默认目录、显式 dir、哈希输入、全局初始化时机，以及加入 LockProtocol 前的相关工作区补丁。
3. HEAD 可用于参考，但不能把 HEAD 当成包含全部历史修复的唯一基线；现有工作区还有未提交修复。
4. 单独跑旧锁套件与新增协议测试，保留每项首次失败原因、退出码、超时和子进程日志。
5. 把下文复现先写成会失败的测试，再修改实现。涉及 OS 生命周期的测试应使用真实子进程；人为错误注入只放在难以稳定制造的系统错误边界。

### 新增/修正测试位置

- 已有：[lock-protocol.test.ts](/D:/opencode/packages/core/test/util/lock-protocol.test.ts)、[lock-identity.test.ts](/D:/opencode/packages/core/test/util/lock-identity.test.ts)。
- 已有：[effect-flock.test.ts](/D:/opencode/packages/core/test/util/effect-flock.test.ts)、[flock.test.ts](/D:/opencode/packages/core/test/util/flock.test.ts)。
- 建议新增：`D:\opencode\packages\core\test\resource-root.test.ts`，用于启动根校验与实际服务传递。
- 继续使用已有真实 worker fixture；必须记录 ready/acquired/released/close，不能用固定 sleep 当取得锁的证据。

### 完成条件

每项 RC 都有失败复现或明确的待编译验证步骤；测试期望来自兼容契约和外部行为，不从被测实现复制推导。

## 5. B 批：修复旧协议兼容与根上下文

主要文件：

- [lock-protocol.ts](/D:/opencode/packages/core/src/util/lock-protocol.ts)
- [resource-root.ts](/D:/opencode/packages/core/src/resource-root.ts)
- [global.ts](/D:/opencode/packages/core/src/global.ts)
- [flock.ts](/D:/opencode/packages/core/src/util/flock.ts)
- [effect-flock.ts](/D:/opencode/packages/core/src/util/effect-flock.ts)

### B1. 将协议校验与资源目标选择分开

1. 为根级标记提供一个可复用的、无写入副作用的读取/校验入口。它负责 schema、generation、status、backend、keyFormat、rootId、epoch 和 registration 一致性。
2. ResourceRoot.select 与每次锁决策都调用该入口。不要为了校验启动而拿任意业务键调用 resolve，再依赖其副作用。
3. generation 使用明确的分支校验。os-lock-v1 必须显式 complete；path-identity-v1 保留原来允许 status 缺省的兼容规则；存在但类型错误的字段仍失败。
4. 路径型描述字段要求绝对路径；不要把错误的相对路径静默解析到当前工作目录后采用为注册根。
5. 拒绝完整标记身份与 registration 不符的组合。未知或矛盾字段按已定义协议处理，不以真假值检查代替“字段是否提供”的检查。
6. 根级校验本身不 mkdir、不加载 .node、不创建锁文件，也不依赖 Global.Service。

### B2. 建立一条完整上下文传递链

1. 为上下文使用显式判别：未注册旧根与已注册新根应是不同分支；已注册分支必须带 registration。
2. 根选择输出保留资源路径、注册身份和启动时采用的协议快照。把它作为锁服务的一个完整字段传递，不再在 EffectFlock 中手写四个路径重组。
3. Global.Service 或其专用配套服务提供完整上下文，Flock.setGlobal 和 EffectFlock 都从同一选择结果得到它。
4. 决策时确认实际资源路径与上下文匹配，防止 Global.layerWith 只覆盖 data 后仍继承另一根的 registration。
5. 为测试/嵌入调用提供显式、无副作用的上下文工厂。覆盖根路径时，必须重新选择/验证上下文；不要静默删掉 registration 以让测试运行。
6. 新上下文接口与内部错误类型先保持包内。若必须修改公开 HttpApi，再按仓库要求生成客户端。

建议的数据关系是“资源路径＋必需的根上下文”，不是又增加一份可独立变更的路径副本。具体类型名称可沿用现有 Context，但已注册身份必须由类型及运行时共同保护。

### B3. 在任何启动写入前完成校验

1. ResourceRoot.select 读取描述文件后，立即完整校验所选标记，不能仅检查存在。
2. 标记为 `{}`、损坏 JSON、目录、不可读文件、migrating、旧 generation、rootId/epoch 不符时，启动选择明确失败。
3. Global 的顶层 mkdir 必须在上述校验成功后发生。失败测试应断言 data/config/cache/log/repos/bin 等未被创建。
4. 采用的注册身份与协议快照要保留到进程生命周期结束。之后标记消失或变化，每次获取在创建协调目录前失败。
5. 保持依赖方向：根解析/协议校验不导入 Global，不产生 Global → Flock → Global 的初始化环。

### B4. 恢复两个旧协议的目录行为

1. legacy 分支返回原始键，并选择 `requestedDir ?? state/locks`。
2. path-identity-v1 分支只改变已定义的键格式；目录仍用该协议原来的 `requestedDir ?? state/locks`。
3. 新协议的资源域目录选择和自定义目录白名单独立放在 native 分支；不能先计算新目录再让所有分支共享。
4. migrating、损坏标记检查仍在 legacy 选择前执行；兼容显式 dir 不等于绕过协议门禁。
5. 保留认证/凭据/任务当前显式传入 data/locks 的调用，不把它们统一改回 state/locks。
6. 不同时获取新旧两把锁来“兼容”，不在一次获取失败后换目录或后端。

### B5. 恢复独立 Flock 的初始化契约

1. 原先显式 dir 的独立调用不要求先导入有 mkdir 副作用的 Global；本轮新增的强制前置条件要移除。
2. 推荐在无已注入上下文时，通过共用的无副作用启动解析入口取得上下文，读取当前描述文件并执行同样校验。该入口不能导入 Global；可以放在 ResourceRoot 或紧邻的启动解析模块中。
3. 当前描述为未注册旧根时，显式 dir 仍按原契约使用，不受 native 白名单限制。
4. 当前描述指向已注册根时，同样必须保留 registration；缺标记或不允许的 dir 失败。不能使用 `if (!global) return legacy` 作兜底。
5. 无 home/资源描述上下文的嵌入使用者必须能显式提供上下文。产品入口不得调用未校验的裸 legacy 分支。
6. 所有隔离测试通过自己的 home/路径/上下文运行，不能借生产描述文件或生产标记使测试通过。

### B6. 修正协议测试的错误期望

1. “unmarked root” 用例的默认目录期望改为历史 state/locks，而非 config/locks。
2. “same data domain” 用例区分：旧协议显式 data/locks 应共享；旧协议省略 dir 仍保留原 state 行为；native 空间的共享规则单独测试。
3. 对两种锁 API 做交叉竞争：先按历史目录持有原始键，再调用修改后的默认入口。竞争者必须等待，释放后必须真正取得并执行。
4. path-identity-v1 同样测试历史目录与规范化键的组合，不能只比较 LockIdentity.key。
5. 独立运行 Flock 测试文件，确保不会依赖另一个测试文件先导入 Global。

### B7. 根上下文验收用例

| 场景 | 期望 |
| --- | --- |
| 未注册、无标记 | 正常旧协议操作，不加载原生模块 |
| 注册新根、启动前缺标记 | 启动失败，无目录写入 |
| 注册新根、标记存在但 `{}` 或 migrating | 启动失败，无目录写入 |
| 注册 rootId/epoch 与标记不符 | 启动失败 |
| 完整选择后，删除标记，再调用真实 Effect 服务 | 写入 body 不运行，不新建业务锁目录 |
| 完整选择后，替换为 legacy/path-identity 标记 | 两 API 都拒绝，不降级 |
| 进程存活期间 generation/epoch 改变 | 拒绝，要求重新选择根后启动 |
| 显式覆盖测试根但保留不匹配的注册身份 | 在服务构建/获取边界拒绝 |
| Global 构建与 Promise 构建使用同一注册描述 | 对缺失/损坏/身份变更有相同结果 |

本批完成条件：RC-01～04 的失败复现全部通过；旧目录竞争仍成立；旧根普通保存和 MCP 串行写入不回归；原生不可用不会触发 fallback。

## 6. C 批：用真实所有权授权调度恢复

主要文件：[effect-flock.ts](/D:/opencode/packages/core/src/util/effect-flock.ts)、[scheduled-task.ts](/D:/opencode/packages/core/src/scheduled-task.ts)、[scheduled-task.test.ts](/D:/opencode/packages/core/test/scheduled-task.test.ts)。

### C1. 先阻止 Some(false) 继续执行

1. 先增加测试：诊断已返回空闲，但真正尝试返回 false，旧 run 必须保持原状态。
2. 若先做最小安全修复，除 None 外也必须排除 false。该修改只作为阶段性止血，不能据此关闭 RC-05。
3. 保留锁错误和取消原有语义；取消不能通过 Effect.option 变成普通 None 后继续恢复。

### C2. 将一次尝试从等待流程中独立出来

1. 不再使用 `acquire(...).timeoutOption("1 millis")` 实现 tryAcquire。慢文件系统上的一次正常操作不能被当成 BUSY。
2. 抽取实际的一次获取原语，acquire 的等待循环和 tryAcquire 共用它；仅 acquire 负责可取消退避与总截止时间。
3. 返回明确的内部结果：`{ status: "busy" }` 或 `{ status: "acquired", lease }`；协议/权限/I/O 错误走错误通道。
4. 使用 Effect Scope 登记租约释放。成功获取到 finalizer 登记之间不可中断；等待/退避阶段可中断。
5. 目录后端沿用当前确认已退出 owner 才恢复、未知 owner/breaker 保守阻止的规则，不重新引入按年龄夺锁。
6. 即使保留旧 boolean 接口作为兼容适配，调度恢复也应消费能表示真实所有权的内部结果；不能再使用 Option<boolean> 作为授权。

### C3. 重写恢复的授权顺序

1. 对带 owner 的记录直接做受 Scope 管理的一次获取；isLocked 可以用于诊断，但不能决定是否可以更新数据库。
2. BUSY：跳过记录；真实错误：保留记录并按现有诊断通道记录；取消：停止当前恢复，不改记录。
3. acquired：在同一持锁作用域内重新读取 run，再比较 owner、status 和当前恢复资格。
4. UPDATE 使用 ID、读取时原 owner、读取时原 status 作条件。状态相等后，在 SQL 中也必须约束该具体状态；不能仅用 pending/running 两者之一。
5. 原 owner 为空时明确使用 IS NULL 条件，不能省略 owner 条件；避免并发填入 owner 后被历史恢复覆盖。
6. 仅更新成功并返回一行时发布恢复事件；没有匹配行则跳过。数据库失败不能发布成功事件。
7. 恢复只写 interrupted 和错误说明，不调用 create/prompt/resume，不重放副作用。
8. 持锁直到数据库条件更新结束；发布失败采用现有事件一致性策略并记录，不恢复成可再次执行的 pending。

### C4. 必测边界

1. 真实 owner 正常运行、暂停时不能被恢复；owner 进程退出并等待 close 后才可以恢复。
2. 诊断为空闲与获取之间被竞争者抢先：用 Deferred/ready 边界制造竞争，断言 BUSY 后不更新。
3. 单独验证 boolean 兼容接口返回 false 时不进入恢复；此用例用于防止 Some(false) 回归。
4. 一次获取本身耗时超过 1 毫秒仍能成功；不能依赖机器速度决定测试结果。
5. 两个恢复者竞争同一个旧 owner：最多一次条件更新、一次成功恢复事件；会话和 prompt 次数不增加。
6. 重读后 UPDATE 前 owner/status 变化：旧 UPDATE 匹配零行；包括无 owner 变为有 owner。
7. 取消分别发生在获取前、取得到 finalizer 登记边界、DB 更新期间；锁无泄漏，原有者不被释放。
8. DB 失败、发布失败不重放任务；已提交与未提交的状态分别验证。

完成条件：普通恢复测试与真实竞争测试同时通过；只有取得的租约能授权 DB 修改。单独修复 false 判断不算本批完成。

## 7. D 批：原生所有权、错误分类与独立构建

主要文件：[binding.cc](/D:/opencode/packages/core/native/process-lock/binding.cc)、[binding.gyp](/D:/opencode/packages/core/native/process-lock/binding.gyp)、[native-file-lock.ts](/D:/opencode/packages/core/src/util/native-file-lock.ts)、[build-process-lock.ts](/D:/opencode/packages/core/script/build-process-lock.ts)。

### D1. 先固定可重建的构建环境

1. 将当前源码与先前验证通过的临时原型逐项比较，特别是 cleanup、token、错误处理、delay-load hook。不要直接沿用临时原型的测试结论。
2. 显式声明构建所需的 node-addon-api 与 node-gyp，使用已验证的固定版本并记录来源；不要依赖恰好被其他包安装的传递依赖。
3. Windows 使用标准 node-gyp win_delay_load_hook.cc；检查最终二进制延迟导入信息。同一产物分别被 Node/Bun 加载，禁止通过改导入名维持两套运行时产物。
4. 当前宏配置为 NAPI_DISABLE_CPP_EXCEPTIONS，源码却有普通 C++ throw。应统一异常策略：优先使用明确的 N-API 错误返回和资源清理，任何 C++ 异常不得跨越 N-API 回调边界。
5. 不直接复用临时目录中的旧 .node。构建记录包含源码摘要、工具链版本、平台/架构、模块摘要。

### D2. 为每个 N-API 环境建立所有权记录

1. Init 为当前 env 创建独立环境记录，并把记录作为 cleanup hook 的参数；不再向所有环境传 nullptr。
2. 每个 Held 包含所属环境的身份或引用。全局注册表可以保留以确保进程内 token 唯一，但所有操作受同一明确同步策略保护。
3. tryAcquire 成功后将句柄登记到当前环境；release 只接受该环境拥有的 token。跨环境使用 token 不得释放他人的句柄。
4. cleanup 仅原子认领并关闭当前环境剩余句柄，不遍历关闭其他 env 的条目。
5. 显式 release 与 cleanup 共享一次关闭入口；迟到释放和重复释放不能触碰后继持锁者。
6. 关闭后的表项及时清理，token 序列不重用。不存在的旧 token 可以返回 already-released，无需永久保留全部历史句柄。
7. token 耗尽、表登记失败、构造 JS 返回值失败等路径要释放已取得的本地句柄；不泄漏到业务不可访问的状态。
8. 不依赖 napi_external 的 GC/finalizer 表示锁所有权。环境记录与数字/字符串 token 所有权要明确。

### D3. 保留并分类 OS 错误

1. Windows：LockFileEx 失败后立刻保存 GetLastError，再关闭句柄。只有明确的锁冲突映射 BUSY；访问拒绝、无效句柄、文件系统错误等返回带 code 的错误。
2. Unix：flock 失败立刻保存 errno。EWOULDBLOCK/EAGAIN 表示 BUSY；EINTR 按明确的中断策略处理；其他错误进入错误通道。
3. CreateFileW/open 失败同样保存系统错误码，给出 operation、code 和可诊断路径；日志不包含密钥。
4. release 不可忽略 UnlockFileEx/flock/CloseHandle/close 的失败后无条件返回 released。分别处理所有权撤销、句柄关闭和诊断结果，避免盲目重试导致关闭已复用句柄。
5. TypeScript 适配层将原生错误映射到已有 NativeLockError 分类；load 失败与调用失败都要明确，不能伪装 BUSY。
6. 获取错误不能执行 body；释放错误不能按路径删除协调文件，也不能回退另一个锁后端。

### D4. 必须新增的真实生命周期测试

1. 主线程持锁；另一个只加载模块而不持锁的 worker 退出；外部竞争者仍 BUSY。
2. worker A 与 B 分别持不同锁；A 退出后只允许取得 A 的锁，B 的锁仍 BUSY。
3. 主线程与 worker 同时释放/退出，关闭每个句柄最多一次；旧 token 不释放后继持有者。
4. 正常 release、重复 release、GC、worker 终止、进程强制终止并等待 close，分别验证。
5. Node/Bun 双向竞争；先 readiness，再启动竞争者，最后等待 holder 真正 close 后测试重新取得。
6. 当前源码构建产物做真实暂停：暂停实际 holder 超过旧阈值，竞争者仍 BUSY；恢复并显式释放后才取得。
7. 系统错误分类测试：能稳定制造的错误用真实文件系统场景；难以制造的错误用原生测试边界注入，断言不会无限等待。
8. 显式 release 后协调文件仍存在且身份稳定；不能只验证“文件被删掉”。

在 TS 类型检查通过之外，必须有当前 C++ 源码的构建与执行证据。支持范围逐平台记录；本机未测的平台不填通过。

本批完成后仍不自动接入业务 native 分支，也不关闭 R3-03B。

## 8. E 批：将桌面暂存改为完整产物包事务

主要文件：[background-cli.ts](/D:/opencode/packages/desktop/src/main/background-cli.ts)、[prebuild.ts](/D:/opencode/packages/desktop/scripts/prebuild.ts)、[electron-builder.config.ts](/D:/opencode/packages/desktop/electron-builder.config.ts)、[build-node.ts](/D:/opencode/packages/opencode/script/build-node.ts)。

### E1. 先确定包级清单和可选能力

1. 为完整 CLI 包声明 exe 摘要、native 清单摘要、模块摘要、清单 schema/module/N-API/platform/arch/libc。native 能力是否声明必须来自构建配置。
2. 旧协议专用包可以明确不声明 native；若声明 native，缺清单或缺模块都必须失败。不能仅凭 manifest 不存在就推断“这是合法旧包”。
3. 验证清单字段类型和摘要格式；file 只能指向受控包内的常规文件，拒绝绝对路径、..、目录和逃逸的符号链接。
4. 按构建目标选择平台/架构，不能只用打包宿主的 process.platform/process.arch 复制模块。未提供目标模块则构建明确失败。
5. loader 与暂存包使用同一产物定位约定。若使用 OPENCODE_NATIVE_LOCK_DIR，由启动链明确设置并验证服务派生进程继承；不能依赖开发机环境中偶然已有的值。

### E2. 完整 fingerprint

1. fingerprint 包含 exe 摘要、清单完整内容摘要、模块摘要，以及会影响布局的版本字段。
2. 使用固定顺序和无歧义编码组合后再做 SHA-256，不直接拼接可混淆字符串。
3. 清单只变化、模块未变时也应得到不同的产物包身份，不能复用旧清单。
4. 目录名可以使用摘要截断值，但 READY 中保留并校验完整摘要。

### E3. 原子暂存与发布

1. 在 cli 父目录创建本次独有的 preparing 临时目录；不要先把 exe 发布到最终可启动目录。
2. 复制 exe、native 模块、清单。设置执行权限并在复制后的目标文件上重新计算摘要。
3. 全部匹配后写入内部 READY 记录，记录完整包身份与所需文件；不能只写一个无校验的布尔完成标记。
4. 将准备好的整个目录在同文件系统内原子 rename 到最终版本目录；不能通过替换稳定锁文件来协调此操作。
5. 两个暂存者竞争同一目标时，失败者验证获胜者完整包；正确则复用，否则明确失败或进入受控重建流程。
6. 任何复制、校验或发布失败，保留原完整包。本次只能清理自己创建且路径已核验的 preparing 目录。
7. 不要覆盖可能被运行进程使用的损坏版本目录；可产生新的受控修复实例目录并发布指针，旧目录待确认无人使用后清理。
8. Windows 删除/移动前核验最终绝对路径在 staging 父目录内，使用同一 shell 的 LiteralPath 操作。

### E4. 复用和清理

1. 复用前校验 READY、exe、清单和模块内容摘要、目标平台兼容性；仅 existsSync 不够。
2. 缺清单、模块被修改、部分复制、READY 不符全部不得返回 installed:false。
3. 先验证 source 包，再验证 staged 包。不能只校验 source 后信任同目录名的目标文件。
4. 清理旧目录前确认相关进程/版本租约已结束。service stop 调用失败被忽略，不代表进程已退出。
5. 在版本租约机制完成前，保守保留旧完整目录，停止“不是当前目录就全部递归删除”的策略。
6. 包已发布与后台服务是否需要切换分别处理。只发布新的修复实例，不等于可以立即删除仍在运行的旧实例。

### E5. 将暂存逻辑变成可执行测试

1. 将文件暂存事务抽成可复用的独立模块，依赖通过普通函数参数传入：source、stagingRoot、version、目标规格和 logger。Electron app.getPath 留在调用层。
2. 这样测试能执行真实复制、校验和 rename，不需要模拟整个 Electron app 或用源码字符串检查代替。
3. 保留现有密码兼容测试，但它们不计入原生暂存验收。
4. 建议新增 `D:\opencode\packages\desktop\src\main\cli-staging.test.ts`；实现模块名称与位置可沿用项目习惯。

### E6. 必测矩阵

| 场景 | 期望 |
| --- | --- |
| 首次暂存完整包 | 全部校验后可启动 |
| 同一包再次暂存 | 验证目标后复用 |
| staged 模块内容损坏 | 不复用，不启动损坏包 |
| staged 清单/READY 缺失 | 不复用 |
| source 仅清单变化 | 包身份改变，目标清单正确 |
| exe 复制后、模块复制中、清单写入前失败 | 无部分完成包可见 |
| 两个暂存者同时运行 | 最终包完整，不互删，不启动部分产物 |
| 清单平台/架构/libc 错误 | 明确失败 |
| 包内路径含中文/空格、清单试图越界 | 合法路径成功，越界失败 |
| 旧后台进程仍存活 | 旧目录不被删除 |
| 声明 native 却缺产物 | 构建/暂存失败，不变成无 native 包 |

完成条件：真实文件事务测试通过；从最终用户暂存位置验证产物定位。已安装 Electron 与 Bun 编译产物仍需单独验收，不能用本批测试代替。

## 9. F 批：综合回归与证据记录

### F1. 执行命令

所有命令从包目录运行。新增测试文件只有创建后才加入命令。

```powershell
Set-Location -LiteralPath D:\opencode\packages\core
bun test test/util/flock.test.ts
bun test test/util/effect-flock.test.ts
bun test test/util/lock-identity.test.ts test/util/lock-protocol.test.ts test/lock-root-migration.test.ts
bun test test/image-generation-settings.test.ts test/npm.test.ts test/repository-cache.test.ts
bun test test/relay-auth.test.ts test/relay-secret-store.test.ts test/relay-cross-process.test.ts
bun test test/scheduled-task.test.ts test/scheduled-authorization.test.ts
bun typecheck
```

独立运行两个旧锁文件，是为了发现依赖其他文件初始化 Global 的问题。通过后再执行联合批次检查文件间污染。若遇到历史断言与已明确的保守 owner 规则冲突，逐条解释并修正；不能恢复按年龄删除未知锁的行为来换绿。

```powershell
Set-Location -LiteralPath D:\opencode\packages\opencode
bun test test/mcp/auth.test.ts test/plugin/meta.test.ts
bun test test/config/config.test.ts -t "MCP|mcp source"
bun test test/server/httpapi-config.test.ts -t "MCP|\.opencode"
bun typecheck
```

```powershell
Set-Location -LiteralPath D:\opencode\packages\desktop
bun test electron-builder.config.test.ts src/main/background-cli.test.ts
bun typecheck
```

根校验、新的暂存事务及原生生命周期测试分别加入对应批次。原生测试缺产物时可以在普通旧协议批次明确跳过，但其专项验收必须失败/未执行，不能把跳过当通过。

若修改了公共 Protocol 或 Server HttpApi，从 `D:\opencode\packages\client` 执行 `bun run generate`；若修改旧 SDK 契约，执行 `D:\opencode\packages\sdk\js\script\build.ts` 官方脚本。生成目录不手改。本轮优先保持改动为内部接口，不预先生成无关差异。

### F2. 验证层次

1. 纯协议校验：标记、目录选择、键与身份约束。
2. 真实服务构建：描述文件 → Global → EffectFlock/Promise Flock；启动前失败、运行中标记变化。
3. 真实业务入口：普通保存、认证/凭据、MCP、调度，断言 body 是否执行及数据是否保持。
4. 真实进程竞争：等待 readiness，断言最大并发临界区数量为 1，释放后竞争者实际完成。
5. 当前 C++ 产物：worker、GC、重复/迟到释放、系统错误、退出和暂停。
6. 真实暂存文件事务：失败点、损坏复用、并发发布与旧版本仍运行。
7. 安装包与迁移：继续保留为独立验收项目。

### F3. 记录规则

在现有状态文档追加“根因修复复核”记录，不覆盖历史事实。对每个 RC 写明：

- 复现条件、实际代码改动和关联测试名称。
- 首次失败证据与修改后结果，运行目录、命令、退出码。
- 是否使用真实子进程、当前源码原生产物、安装包或受控注入。
- 通过、失败、未执行、待验收分别记录。
- 未覆盖的平台与发布形式，不能用临时原型结果代替当前源码。

类型检查通过只证明类型一致性；19 项/15 项数量本身不能代表兼容、所有权和发布事务已验收。

## 10. 每批交付与回退

| 批次 | 交付 | 进入下一批前的条件 | 回退规则 |
| --- | --- | --- | --- |
| A | 失败复现、旧契约表 | 证据可重复 | 不涉及业务回退 |
| B | 完整上下文、启动校验、历史目录行为 | RC-01～04 和普通旧根业务通过 | 只撤本批相关差异；不改生产描述/标记 |
| C | 一次获取原语、持锁恢复与 SQL 条件 | false/BUSY/取消/竞争用例通过 | 保留“不能凭诊断更新”的安全约束，不重放历史任务 |
| D | 当前源码原生产物与独立生命周期证据 | RC-06、07 专项通过 | 业务仍不接入 native，不静默 fallback |
| E | 完整暂存事务、目标完整性和保守清理 | RC-08 的失败点与复用矩阵通过 | 保留旧完整包和仍运行实例，不覆盖或删其资源 |
| F | 综合记录与剩余工作清单 | 所有必测项有明确状态 | 不用删除标记或恢复旧数据快照强行降级 |

本方案不要求自动提交。人工需要拆提交时建议：

1. `fix(core): preserve legacy lock coordination`
2. `fix(core): retain validated resource root context`
3. `fix(core): require owner lease for scheduled recovery`
4. `fix(core): scope native lock ownership to environments`
5. `fix(core): preserve native lock error semantics`
6. `fix(desktop): publish verified cli bundles atomically`
7. `docs: record lock regression verification`

提交时只选择本批文件中的相关修改，不能把既有工作区内容一并暂存。

## 11. 本轮与 R3-03B 的关闭条件

本轮 8 项修正完成需要同时满足：

- [ ] 两种旧协议的键、后端、默认目录、显式 dir 契约均保留；独立/联合测试通过。
- [ ] 两种锁 API 使用同一根上下文；注册身份不能在服务传递中丢失。
- [ ] 启动前完整校验，运行中缺标记或身份改变拒绝，不降级、不执行业务 body。
- [ ] 调度只凭实际租约恢复；DB 条件覆盖原 owner 和原状态；false/BUSY 不更新。
- [ ] 当前 C++ 源码完成环境归属、一次释放、错误分类与真实生命周期复验。
- [ ] 目标暂存包经过完整校验与原子发布，损坏不复用，旧活跃实例不被清理。
- [ ] 服务、业务、进程、原生、文件事务各层证据齐全；跳过不计通过。

即使以上全部通过，R3-03B 仍需原总方案中的原生业务接入、支持平台/文件系统矩阵、实际安装包、旧版本隔离、产品离线迁移和故障恢复验收后才能关闭。真实界面验收也保持独立状态。

建议人工实施从 A、B 开始，每批通过再进入下一批。不要在旧协议回归尚未恢复时继续接入生产原生锁或推进真实迁移。
