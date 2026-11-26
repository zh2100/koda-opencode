# R3-03B 系统锁接入、资源隔离与迁移实施方案

日期：2026-11-09，Asia/Shanghai。工作区：`D:\opencode`。

本文是待实施方案，供人工逐步修改。本文中的新增模块、接口、命令和产物布局都是建议；没有因本文创建而接入业务、写入生产标记、执行迁移或通过验收。当前状态以 `D:\opencode\specs\round3\status-2026-11-08.md` 为准。

## 1. 目标、起点与实施边界

最终目标：在已完成隔离迁移且受支持的资源域中，由操作系统锁表示真实所有权。进程退出后释放所有权，元数据缺失、损坏、陈旧 breaker 不再阻止新协议获取锁。任务恢复仍只收尾，不重放模型或工具。

当前已经完成的工作应保留：

- Node/Bun 使用同一份 node-gyp 延迟加载原生产物的独立验证。
- token 映射句柄、一次关闭、重复释放、worker 清理、强制终止、GC 和 65 秒真实暂停验证。
- `LockIdentity` 的绝对路径识别、最近已有祖先解析、多级缺失后缀、junction 身份合并。
- 标记中 `status` 字段存在但类型错误时拒绝；旧数据根保存、MCP 凭据串行写入已恢复。
- 旧数据根维持原始哈希和目录锁；没有新协议获取失败后的动态回退。

当前仍未完成：

- 原生模块正式入库、业务锁接入、系统锁所有权诊断与任务恢复接入。
- 产品资源根迁移与旧版本隔离。
- 剩余业务入口、已安装 Electron、Bun 编译产物、符号链接与其他支持平台验证。

实施期间遵守：

1. 不关闭或重启当前正在运行的应用和服务；本方案的迁移、暂停、终止仅针对以后单独启动的隔离测试进程。
2. 不对生产根写 `path-identity.json`，不以写标记代替迁移，不按年龄删除未知锁或 breaker。
3. 不改掉已有未提交修改；每阶段单独记录差异和测试结果。
4. 测试和 `bun typecheck` 从对应包目录执行，不能从仓库根跑测试，不能直接运行 `tsc`。
5. 本轮不计划改 Session 或 timeline。若实施范围扩展到 App 会话代码，先遵守 App AGENTS 的生产性能基线要求。
6. 支持范围按实际测试的平台、CPU、文件系统与发布形态记录。Windows 本地验证不能代表 Linux/macOS、网络共享或安装包已通过。

## 2. 实施前先固定的设计决定

### 2.1 键格式与后端必须分开

当前 `path-identity-v1` 只表示“规范化键 + 目录锁”。不能在保留这个 generation 的同时把一部分调用切到系统锁。

建议扩展现有标记解释，保留以下兼容关系：

| 根状态 | 选择的键 | 锁后端 | 普通业务行为 |
| --- | --- | --- | --- |
| 已识别的旧根，无标记 | 原始输入 | 旧目录锁 | 继续正常操作 |
| `generation: path-identity-v1`，status 缺省或 complete | 规范化键 | 目录锁 | 保持当前已实现语义 |
| status 为 migrating | 不生成业务锁键 | 无 | 普通业务写入拒绝；仅迁移和只读诊断工具可用 |
| 新 generation `os-lock-v1`，status 为 complete，字段全部有效 | 规范化路径键，非路径 ID 保持原文 | `native-file-v1` | 使用系统锁 |
| 新根缺标记、标记损坏、未知版本、矛盾状态 | 无 | 无 | 明确失败，不能降级 |

新 generation 建议的完整字段：

```json
{
  "schemaVersion": 1,
  "generation": "os-lock-v1",
  "status": "complete",
  "backend": "native-file-v1",
  "keyFormat": "canonical-path-v1",
  "rootId": "迁移时生成并持久化的 UUID",
  "epoch": 1
}
```

这是协议形状建议，不是现在就要写入的数据。新 generation 必须显式带 complete，不能复用旧 v1 对缺省 status 的兼容规则。存在字段的类型必须严格校验，JSON 重复字段、未知关键状态的处理也应在协议测试中明确。

### 2.2 新根丢标记必须能与旧根区分

不能只依靠“删除标记不是受支持操作”的文档约定。

建议由新版本启动描述文件记录：所选资源根、rootId、预期 generation 和 `requireManifest: true`。启动描述文件不放到会被迁走的旧默认根内。新根的身份记录与该描述必须相符。

- 普通旧版布局、没有迁移注册记录：允许原有 legacy 模式。
- 已注册的新根：缺少标记、rootId 不符、generation 不符或根记录丢失时拒绝启动写入服务。
- 当前进程已经采用某个 rootId/epoch 后，发现它变化应停止后续业务操作，不能在存活进程内切换协议。
- 启动描述文件是新版本的路由与校验入口，不能约束不读取它的旧版本；旧版本隔离另做。

### 2.3 协调范围由受保护资源决定

同一数据目录、不同 state 目录的进程必须争抢同一把凭据或任务 owner 锁。不能仅因为两进程的 `global.state` 不同，就各选不同的协议和锁目录。

建议引入内部 `LockSpace` 概念，包含 rootId、资源域、协调目录、generation、backend、keyFormat、epoch。名称可按实际代码调整，语义必须保留。

- Relay 认证、凭据和任务 owner 的 LockSpace 绑定共享 data 根。
- 文件配置、缓存等按真实资源域绑定，两个写入者访问同一目标时必须解析到同一 LockSpace。
- `dir` 参数指定自定义协调目录时，校验它属于已选资源域；不能任意覆盖目录后仍沿用另一个根的协议。
- 不同资源域同时处理同一个外部项目文件的情况必须明确拒绝或有同一协调域规则，不能默认互斥成立。

### 2.4 明确同账户隔离的能力边界

ACL 无法按应用版本区分同一账户中的两个进程。对旧路径拒绝写入后，新版本必须完整使用获准的新位置，才能继续工作。

特别注意：项目里的 MCP 配置、工作目录中的 npm 安装、外部插件配置并不天然位于新 data 根中。只有迁 data/state/config 四个目录，不能证明这些目标已经隔离。

每个实际写入目标必须在迁移清单中选择并验证一种策略：

1. 迁到新版本专用位置，且新版本的真实读写入口已重定向；旧路径不可写，新位置可写。
2. 有独立部署约束保证旧写入者不能再启动，并在验收中验证该约束。
3. 尚不能隔离：保留该资源域的旧协议，不能把它标记为已迁移。若暂不实现按资源域选择，则整个相关根继续保持旧协议。

不要为了通过验收自动搬迁用户工程、把所有项目配置改成只读，或引入未经评审的项目配置 overlay。不能满足清单中资源的隔离条件，就在迁移阶段停止。

## 3. 文件修改清单

以下新增路径为建议，实施前确认没有同名文件。

| 文件或目录 | 操作 | 职责 |
| --- | --- | --- |
| `D:\opencode\packages\core\src\util\lock-identity.ts` | 修改 | 纯路径身份计算；保留旧键与现有 v1 兼容 |
| `D:\opencode\packages\core\src\util\lock-protocol.ts` | 新增 | 严格协议解析、资源域选择、不可变的加锁决策 |
| `D:\opencode\packages\core\src\util\native-file-lock.ts` | 新增 | 懒加载原生模块、非阻塞获取、释放与错误转换 |
| `D:\opencode\packages\core\native\process-lock\` | 新增 | node-gyp、原生源码、类型和构建说明 |
| `D:\opencode\packages\core\script\build-process-lock.ts` | 新增 | 可重复构建并产生平台产物清单 |
| `D:\opencode\packages\core\src\util\effect-flock.ts` | 修改 | 根据决策分派目录/系统后端，接入 Effect 生命周期 |
| `D:\opencode\packages\core\src\util\flock.ts` | 修改 | 与 EffectFlock 共用协议和系统后端，保留 Promise API |
| `D:\opencode\packages\core\src\global.ts` | 修改 | 先解析资源位置与协议，再创建目录；保持旧根默认行为 |
| `D:\opencode\packages\core\src\resource-root.ts` | 新增 | 资源根描述、rootId/epoch 校验与启动选择 |
| `D:\opencode\packages\core\src\scheduled-task.ts` | 修改 | 持 owner 锁完成恢复判断与数据库收尾 |
| `D:\opencode\packages\core\src\relay-auth.ts`、`relay-secret-store.ts` | 核对后修改 | 共享 data 的协调域、可恢复错误、恢复记录语义 |
| `D:\opencode\packages\core\script\migrate-lock-root.ts` | 新增 | 默认只读规划，隔离 apply/resume/rollback；业务服务不自动迁移 |
| `D:\opencode\packages\opencode\script\build-node.ts` | 修改 | Node 服务构建保留正确的原生产物定位 |
| `D:\opencode\packages\cli\script\build.ts` | 修改 | 当前 Bun CLI 产物带原生模块资源与清单 |
| `D:\opencode\packages\opencode\script\build.ts` | 按发布用途修改 | 仍发布该构建产物时同步支持，不替代 CLI 实际构建链 |
| `D:\opencode\packages\desktop\scripts\prebuild.ts` | 修改 | 实际复制 CLI 的路径同步携带原生产物 |
| `D:\opencode\packages\desktop\electron-builder.config.ts` | 修改 | 明确包含目标平台原生模块，放在可加载的真实文件系统位置 |
| `D:\opencode\packages\desktop\src\main\background-cli.ts` | 修改 | 暂存 CLI 时同时暂存、校验 native 资源，不能只复制 exe |
| 各包相关测试及 fixture | 新增/修改 | 真实进程、真实业务入口、迁移与包内加载验证 |

不要一次重写所有目录锁代码。旧根分支保留已有取消、重试、发布、单次清理和 breaker 保守处理。

## 4. 第 0 阶段：准备可比较的基线

### 修改前执行

1. 记录 HEAD、工作区状态和本轮涉及文件清单。既有未提交修改单独列出，不重置。
2. 把独立验证原型及构建说明归档进仓库中的测试/源码目录，不能把临时目录当发布依赖。
3. 记录已验证运行时、架构、文件系统、node-gyp 版本及原生产物摘要。当前已知 Node 24.19.0、Bun 1.4.3、node-gyp 12.4.0 的结果只是特定组合证据。
4. 在包目录跑现有锁、身份、图片设置、MCP 凭据和调度的相关测试，记录首次失败。进程竞争用例首次失败后单独重跑成功，仍保留为未定位的偶发失败。

### 完成条件

有可重放的基线、原型源码和测试命令。没有新增生产标记。不得把准备阶段写成 R3-03B 完成。

## 5. 第 1 阶段：先完成协议与资源域选择

### 修改步骤

1. 将协议解析从路径转换中分离，避免 `active()`、`readGeneration()` 和 `lockKey()` 各自形成不同的“已启用”判断。路径比较函数不负责启用系统后端。
2. 新增严格的协议解码，覆盖第 2 节状态表。优先使用项目已有 Effect Schema 方式解析未知 JSON；不存在、损坏、权限不足分别处理。
3. `resolve` 返回一次加锁所需的完整决策：协议、后端、资源域、有效键、协调目录、epoch。后续等待、获取、释放只用该决策。
4. 已迁移根的协议选择应先于非路径键的快速返回。因此 `scheduled-task:...`、`relay-auth`、`relay-secrets` 虽不改键文本，也必须服从同一个后端与 migrating 阻断。
5. 新根与旧根布局分别验证。新根注册信息存在但完成标记丢失时拒绝；旧根无标记继续正常读写。不能为了让测试通过给所有旧根 fixture 预写完成标记。
6. 配置启动信息应在 `Global.Path` 的顶层 mkdir 和默认目录创建之前完成选择；避免明明选择新根，导入模块时仍触碰或重建旧根。
7. 同一资源域被不同 state 目录访问时，使用同一个 rootId 和协调目录。资源域不明、多个记录冲突或 target 不在迁移清单内时明确报错。
8. 新增根解析模块保持在 Core 内，不依赖 Protocol/Server 的运行时。避免 `Global → Flock → LockProtocol → Global` 的导入环；协议解析接受已选上下文，不反向导入 Global。浏览器/renderer 不加载 `.node`。
9. 身份必须在目标通过“临时文件 + rename”更新后仍稳定，不能直接把经常被替换的目标文件 inode/file ID 当业务锁键。Windows 大小写规则按所支持的目录语义验证；对区分大小写目录不能盲目合并两个不同文件，初期无法正确支持时明确阻止该目录采用新协议。硬链接、运行中重定向 junction 等尚未定义的情况不能自动算入已支持别名。

### 必测

- 旧根：图片设置、MCP 凭据、npm 安装仍使用原始哈希和目录后端。
- 现有 path-identity-v1：仍是规范化键加目录后端。
- migrating：路径键和非路径键都不进入业务写入，也不创建业务锁目录。
- 损坏 status，包括 123、true、null、对象；未知 generation/backend/keyFormat/epoch、根 ID 不符均拒绝。
- 迁移后根丢标记拒绝，不能变成 legacy。
- 故障过程中没有尝试第二套哈希或第二个后端。

### 完成条件

协议测试通过，旧根业务回归通过，原生模块尚未被普通旧根加载。

## 6. 第 2 阶段：原生模块正式入库

### 修改步骤

1. 保留已通过的 node-gyp 标准延迟加载钩子。固定构建依赖，不使用二进制导入名替换，不在运行时下载编译器或头文件。
2. Windows 使用 Unicode 路径接口 `CreateFileW`，统一锁定固定字节区间；文件句柄不继承。正常打开时不允许删除共享，以降低持锁文件被替换的风险。
3. Linux/macOS 实现采用经真实 runner 验证的 `flock` 路径。使用 close-on-exec；记录实际 libc、架构及文件系统。不把 Windows 结果记为 Unix 通过。
4. 正常释放只解锁和关闭句柄，持锁文件保留。任何新协议正常路径都不 unlink、rename 或替换锁文件。Unix 对协作写入者的锁文件不可替换约束也必须明确。
5. token 注册表受线程安全保护。持有记录包含创建它的环境、句柄和关闭状态；同进程多个 worker 能安全并发调用。
6. token 在进程生命周期内不得复用。若沿用 JS Number，必须限制在安全整数范围并在耗尽时报错；也可以采用明确的字符串 token，但需同步调整接口与测试。
7. `release`、环境清理和异常收尾使用同一个一次关闭入口。未知或重复 token 有明确结果；释放权不属于当前环境时拒绝，不能关闭其他环境的句柄。
8. 不依靠 external finalizer 保持所有权。数字/字符串 token 持有者即使没有 JS 对象强引用，仍应保持原生记录直到显式释放或环境清理。
9. 检查每个 N-API、打开、加锁、解锁和关闭调用的结果。只有明确的锁竞争错误返回 busy，权限、路径、模块加载或系统调用错误都单独返回。
10. 规范加载路径与模块身份。同进程两种 JS 包装器、多个 worker不能因加载不同副本而绕过进程内互斥。不同平台的同进程重复获取行为单独实测。

### 建议的窄接口

```ts
type AcquireResult = { status: "busy" } | { status: "acquired"; token: string }
type ReleaseResult = "released" | "already-released"
```

`tryAcquire(file)` 必须非阻塞；`release(token)` 显式释放。token 类型最终按第 6 步决定。错误不伪装成 busy。

### 必测

同运行时、跨运行时、同进程不同包装器、不同 worker 的互斥；GC；重复释放；迟到释放；worker 清理；强制退出；权限错误；Unicode 路径；长路径边界；错误参数。环境清理时的文件写入仅用于测试观测，不能成为生产释放是否成功的依据。

### 完成条件

源码可重建，产物清单含平台/架构/ABI/摘要；同一目标平台产物在 Node 与 Bun 上通过独立测试。普通旧根不需要加载它也能运行。

## 7. 第 3 阶段：共享 JS 后端与两套锁 API 接入

### 修改步骤

1. 新增统一的原生加载和锁适配模块。`EffectFlock` 与 Promise `Flock` 共用它，不能各写一套系统锁路径、busy 判断和 token 管理。
2. 模块只在决策为 native 后端时懒加载。原生产物不存在、架构不符或加载失败时返回稳定错误；已经选定 native 的请求不回到目录锁。
3. 根据部署模式从可信的包位置或显式资源目录定位模块，不能从当前工作目录或任意搜索路径加载 `.node`。
4. native 协调文件使用单独的稳定目录，例如所选 LockSpace 下的 `locks-native-v1/<hash>.lock`。旧目录锁和新文件锁不共享同一个物理路径形状。
5. 每次获取先完成决策，然后非阻塞尝试，busy 时可取消等待。总截止时间用单调时间衡量；每次竞争共用同一截止时间，不能每轮重置。
6. Effect：尝试获取到释放登记之间保持不可中断；等待阶段恢复可中断。取得 token 后立即登记 finalizer，再执行 body。
7. Promise：检查 AbortSignal，取得 token 后交付 Lease 前再次处理取消；这段边界取消必须释放刚取得的 token。`release` 和 `Symbol.asyncDispose` 共用一次释放逻辑。
8. 同一临界区不隐式重入或合并不同调用者的 lease；并发获取需要等待。不得用“本进程已持有”让第二个独立写入者直接进入。
9. native 分支去掉 heartbeat/stale/breaker 的所有权意义；旧分支保留当前逻辑。诊断元数据只能在持锁后更新，内容错误不能阻止已成功取得系统锁的请求。
10. 超时、取消、原生加载失败、文件系统错误都不能继续执行 body。释放失败进入诊断，不能按路径删除锁文件补救。

### 接口调整建议

- 保留现有 `acquire`/`withLock`/Lease 调用方式，兼容旧根。
- 内部增加明确的 LockSpace 传递或解析，不能只把 global.state 作为一切资源的协议根。
- 新增一次性 `tryAcquire` 能力，成功时同样受 Scope 管理，用于任务恢复；busy 与错误分开。
- 如果需要扩展公开给外部使用的 API，再单独处理兼容性；本阶段优先保持为包内接口。

### 必测与完成条件

- 取消发生在 busy 等待、成功获取、登记释放边界时均无泄漏。
- A 释放后 B 获取，A 的迟到 finalizer 不能关闭 B。
- A 长暂停超过 60 秒后 B 仍失败；恢复 A 后正常释放。
- legacy 分支已有测试仍通过。
- 两种 API 使用相同 root、键和后端时，真实进程中互斥成立。

### 错误处理与提交结果

实施时至少区分：锁竞争、真实超时、取消、迁移阻断、模块不可用、权限不足、文件系统失败和释放失败。可以在现有 `LockCompromisedError` 中增加可识别的内部 reason，或新增内部错误类型，但要逐个处理所有调用方。

1. 锁竞争只用于等待，其他错误不无限重试；取消保持原取消语义。
2. MCP 编辑继续沿用已有 typed HTTP 错误族和稳定 ref；只有真实等待耗尽才叫 timeout。协议或模块不可用不能伪装成字段冲突。
3. Relay 凭据继续映射到已有凭据不可用错误，保留非敏感诊断；配置已提交后的清理失败仍遵守已实现的 committed/cleanupPending 语义。
4. MCP 凭据当前有 `Effect.orDie` 包装。预期锁失败应在服务或 HTTP 构建边界转换，不因 migrating 状态变成未处理缺陷。启动失败清楚说明根/协议问题，不扩大 Session 的公开错误类型来掩盖。
5. 释放发生在 body 提交之后时，响应必须区分“业务已提交”和“获取前失败”，不能诱导客户端重复提交已成功操作。锁释放错误另行诊断。
6. 若因此修改公共 Protocol/Server HttpApi，从 `D:\opencode\packages\client` 执行 `bun run generate`；若改了旧 instance HTTP 契约，按仓库要求执行官方 Legacy SDK 构建脚本。生成目录不手改。
7. 如果需要可见错误文案，使用所在包的 typed i18n API，不硬编码英文；App/桌面界面相关改动另做对应验收。

## 8. 第 4 阶段：诊断与定时任务恢复

### 修改步骤

1. 系统锁文件存在与否不再决定是否被占用。native 诊断通过受控非阻塞获取探测：busy 是占用；成功探测后立即释放；权限/加载/I/O 错误是未知或不可用。
2. `diagnose` 只服务展示和诊断。任务恢复不能拿一次 diagnose 结果作为随后修改数据库的授权。
3. 在 `scheduled-task.ts` 中，对带 owner 的 pending/running 行尝试取得同一个 owner 锁。busy 就跳过，错误就保留记录并返回可诊断结果。
4. 成功取得后，在持锁作用域内重读行，并使用行 ID、原 owner、pending/running 状态作条件更新；owner 或状态变化时不收尾。
5. 仅将真实孤儿记录标成 interrupted。完成后发布事件。不得调用 create/prompt/resume 去重放历史副作用。
6. 没有 owner 的历史行沿用明确的历史恢复规则，并测试它与新 owner 行互不混淆。
7. 恢复者竞争同一个旧 owner 时串行处理；同进程活跃 owner 也必须挡住恢复探测。
8. legacy 模式继续保守处理未知元数据与 breaker；不能借接入系统锁自动删除 legacy 残留。

### 必测

活跃 owner、暂停 owner、退出 owner、元数据缺失/损坏、两个恢复者、恢复中 owner/status 改变、DB 写入失败、发布失败、恢复者被终止。断言会话数、prompt 次数及工具副作用次数没有增加。

### 完成条件

同一数据根但不同 state 的两个进程观察相同 owner；恢复只有持锁和条件更新成功时才收尾。不是只把 `isLocked` 的返回值换一下。

## 9. 第 5 阶段：全部业务调用方接入和入口测试

### 逐项清单

| 资源 | 当前入口 | 必须增加的验证 |
| --- | --- | --- |
| npm 安装 | `packages/core/src/npm.ts` | 大小写、junction/符号链接竞争时不创建 node_modules；释放后确实完成 |
| 图片生成设置 | `packages/core/src/image-generation-settings.ts` | 两进程更新无覆盖，未迁移根仍可保存，配置失败不损坏原文件 |
| 仓库缓存 | `packages/core/src/repository-cache.ts` | 同缓存目标的别名不并发 checkout/reset，不同目标可并行 |
| Relay 认证 | `packages/core/src/relay-auth.ts` | 共享 data、不同 state，revision 和准备/清理记录正确 |
| Relay 凭据 | `packages/core/src/relay-secret-store.ts` | 密钥写入、提交失败、退休清理保持现有语义 |
| MCP 来源编辑 | `packages/opencode/src/config/config.ts` | 别名串行、typed 冲突、原文引用不展开、保存失败不改磁盘 |
| MCP 凭据 | `packages/opencode/src/mcp/auth.ts` | 实际服务使用别名 data，阻塞期间无写入，释放后内容正确 |
| 插件元数据 | `packages/opencode/src/plugin/meta.ts` | touchMany/setTheme 同文件无丢失，别名串行 |
| 插件主题 | `packages/opencode/src/plugin/tui/runtime.ts` | 真实主题落盘在持锁期间不开始，释放后完成 |
| 插件配置 | `packages/opencode/src/plugin/install.ts` | `plug-config:` 的真实配置更新串行 |
| TUI KV | `packages/tui/src/context/kv.tsx` | 初始化和保存都使用相同协调规则，两个入口无覆盖 |
| 调度 owner | `packages/core/src/scheduled-task.ts` | 活跃进程不误收尾，崩溃后只收尾一次 |

### 修改与测试要求

1. 每个入口检查键里的路径是文件还是目录、资源根是谁、自定义 dir 是否一致，不能只检查前缀。
2. 同时测 legacy 和 native 两种根。现有 path-identity-v1 另保留兼容测试。
3. 等待持锁者公开 readiness 信号后再启动竞争者；不用固定 sleep 猜它已进入临界区。
4. 不仅断言短时间内未完成，还要在释放后验证竞争者真正执行并成功；否则错误返回、永远挂起也可能伪装成“被锁住”。
5. 至少对认证/凭据、任务和两个锁包装器保留真实多进程测试，不能仅靠单进程 Layer 实例证明跨进程互斥。
6. 偶发竞争失败保留首次日志、PID、角色、ready/acquire/release/close 时序与随机种子；定位后补确定性边界，不能靠多跑几次作为关闭证据。

### 完成条件

表中所有计划支持的真实入口均有执行证据；未覆盖项明确列为待验收。只验证共享身份函数不能代表每个入口已验收。

## 10. 第 6 阶段：发布布局与后台 CLI 暂存

### 修改步骤

1. 定义统一的目标产物清单：模块版本、N-API 版本、平台、架构、libc、文件相对路径和摘要。运行时校验清单与所选产物相符。
2. Node 服务构建检查 `packages/opencode/script/build-node.ts`，不能在 bundling 中丢掉真实文件定位或把开发机绝对路径打入产物。
3. 当前桌面 prebuild 实际使用 `packages/cli/script/build.ts` 产出 Bun CLI，再复制为 `resources/opencode-cli*`。必须修改这条链，不能只修改旧的 opencode build 脚本。
4. 初期允许“Bun 编译 exe + 外置 .node”的明确分发包。若仍要求真正单文件，需要另验证嵌入/落盘/加载机制；旁置成功不能写成真正单文件成功。
5. Electron 的资源目录明确包含该模块；外置 resources 或 asar unpack 的选择必须对应 loader 的实际路径。代码签名和 macOS notarization 按正式产物验证。
6. `background-cli.ts` 的 `installCli` 当前只暂存可执行文件。改成暂存一个版本化目录，包含 exe、native 资源及清单，全部校验通过后才发布为可启动状态。
7. 暂存 fingerprint 计算覆盖 exe 与 native 清单/模块摘要。不能 exe 未变就复用缺模块或旧模块的目录。
8. 复用暂存目录前检查完整性；部分复制、模块缺失、架构错误均明确失败或重建同版本暂存包，不能切到另一个锁后端。
9. CLI 被放到用户目录后，必须从它的最终位置运行加载验证。不能只在应用安装 resources 位置测试。
10. 更新与清理不得删除仍在使用的 native 产物目录；通过正在运行的版本/租约记录约束清理，不能仅按“不是最新目录”判断可删。

### 必测

已安装 Electron 触发的后台 CLI、独立 Node CLI、Bun CLI、Bun 编译包；首次启动、复用暂存、资源缺失、错误架构、安装路径含中文与空格、worker 退出、升级与旧进程仍运行。

### 完成条件

实际安装包中的后台进程与独立 CLI 双向互斥。真实安装包、编译 exe+旁置模块、真正单文件分别记录，不能合并成一个“打包通过”。

## 11. 第 7 阶段：离线迁移工具，只在隔离根实施

### 工具形式

新增迁移脚本，默认只生成计划。建议明确提供 `plan`、`apply`、`resume`、`rollback` 子命令；普通业务启动不能自动执行 apply。

计划至少包含：源/目标的解析后绝对路径、rootId、资源清单、同一资源的别名、协调目录、协议、文件摘要、凭据引用、DB 备份策略、ACL 备份、逐步恢复日志。日志不记录密钥内容。

### 迁移顺序

1. **盘点**：列出 data/config/state/cache、SQLite 及 WAL、Relay 准备/清理记录、MCP 凭据、系统凭据引用、自定义配置、项目配置和锁目录。发现清单外写入目标时停止。
2. **生成新根**：新根位于独立位置，建立 rootId 和 requireManifest 注册，但保持 preparing/migrating，普通业务不能写入。
3. **确认离线**：由后续专门维护窗口确认所有相关旧写入者已退出；测试工具只终止自己创建的 fixture 进程。本轮不操作当前应用。
4. **冻结旧位置**：按经过演练的策略限制旧目标、重建路径及父目录替换，保存 ACL 和路径身份。单纯检查进程列表不能替代阻止后续旧写入。
5. **取得一致快照**：在旧位置冻结且可读后备份。SQLite 使用受支持的备份/检查点流程，不只复制一个可能有 WAL 的主文件，不直接删除 WAL。
6. **复制和重绑定**：把文件放到新根，按清单改新版本的资源定位。相对文件引用、插件路径、项目归属都需验证，不能直接把旧目录移走就宣布可用。
7. **凭据处理**：新根使用独立引用命名空间；按现有“准备 → 提交 → 清理”语义迁移。备份和日志使用受控权限，不新增明文密钥日志。旧版本访问已知旧引用不能误清理新引用。
8. **锁残留归档**：备份旧未知锁与 breaker 作为诊断证据，放到隔离区。不要把旧目录伪装成 native 已持有锁，也不要在旧写入者仍可能活跃时删除它们。
9. **能力验证**：以产品实际账户证明“旧位置写入/重建/替换失败，新版本真实入口写新位置成功”。只证明旧位置失败不够；新旧都失败是迁移失败。
10. **故障点演练**：在复制、凭据准备、配置提交、ACL 修改、清单发布、启动描述文件更新等边界逐一终止迁移 fixture，再用 resume/rollback 恢复。
11. **提交完成状态**：同目录临时写入并原子发布完整清单，处理必要的持久化顺序；最后发布启动位置。只有 rootId、协议、摘要及隔离验证一致时才为 complete。
12. **新进程验证**：从新根启动隔离产品入口，完成配置保存、凭据写入、任务 owner 和真实竞争测试。旧版本 fixture 再次尝试写旧资源仍失败。

### 日志状态建议

`planned → prepared → legacy-blocked → copied → verified → committed`。

每个阶段必须可判断“尚未做、已经做、需要人工处理”。重跑先校验实际文件/权限与日志，不只信日志最后一行。路径变化、摘要矛盾、rootId 不符时停止，不覆盖未知数据。

### 回退规则

- 新根尚未承载业务写入：按日志恢复原目录与 ACL，并验证旧根可用。
- 新根已经承载写入：执行独立的反向数据迁移，保存新根最新数据；不能简单恢复最初备份，不能删除标记强行降级。
- 旧版本不能解释新数据格式时禁止回退，给出明确恢复路径。
- Windows 移动/删除操作前核对解析后的绝对路径与清单边界；使用同一 shell 的 LiteralPath 方式，不跨 shell 拼接删除命令。

### 完成条件

在隔离根完整证明新版本可写、旧版本不可写、部分失败可恢复、回退不丢新数据。外部工程路径不能证明隔离时不提交该资源域 complete。

## 12. 第 8 阶段：验证批次与命令

以下是实施后应执行的命令，不表示本文编写时已执行。新增测试文件创建后才加入对应命令。

### Core：旧协议与现有业务回归

工作目录 `D:\opencode\packages\core`：

```powershell
bun test test/util/lock-identity.test.ts test/util/effect-flock.test.ts test/util/flock.test.ts
bun test test/image-generation-settings.test.ts test/npm.test.ts test/repository-cache.test.ts
bun test test/relay-auth.test.ts test/relay-secret-store.test.ts test/relay-cross-process.test.ts
bun test test/scheduled-task.test.ts test/scheduled-authorization.test.ts
bun typecheck
```

新增建议：`test/util/lock-protocol.test.ts`、`test/util/native-file-lock.test.ts`、`test/lock-root-migration.test.ts`、真实子进程 fixture。默认旧根测试不能依赖原生产物存在。

### OpenCode：来源、凭据和插件

工作目录 `D:\opencode\packages\opencode`：

```powershell
bun test test/config/config.test.ts -t "MCP|mcp source"
bun test test/mcp/auth.test.ts test/plugin/meta.test.ts
bun test test/server/httpapi-config.test.ts -t "MCP|\.opencode"
bun typecheck
```

插件配置和主题入口测试按实际模块增补，不能用纯配置解析测试代替真实写入。

### TUI、CLI 与 Desktop

分别从 `D:\opencode\packages\tui`、`D:\opencode\packages\cli`、`D:\opencode\packages\desktop` 执行 `bun typecheck`。

TUI 新增 KV/主题入口测试；Desktop 至少扩展 `electron-builder.config.test.ts`、`src/main/background-cli.test.ts`，验证 native 清单和暂存目录。CLI/原生构建前先核对脚本输出路径；现有 CLI 构建会清理它自己的 dist，不在有需要保留的构建产物上直接运行。

### 原生与迁移专项矩阵

| 维度 | 最低验证 |
| --- | --- |
| Node/Bun | 同一运行时、交叉运行时、同进程两个 API、worker |
| 退出 | 正常释放、强制终止并等待 close、worker 环境清理 |
| 并发 | 多进程争抢，临界区同时进入数最大为 1，不同资源可并行 |
| 生命周期 | GC、重复释放、迟到释放、取消的每个边界 |
| 暂停 | 实际挂起、心跳停止、超过旧阈值、恢复后显式释放 |
| 路径 | 大小写、分隔符、junction、符号链接、多级不存在目标、中文/空格/长路径 |
| 协议 | legacy、path-identity-v1、native、migrating、未知/损坏/丢失标记 |
| 资源域 | 同 data 不同 state、自定义协调目录、外部项目、不同数据根误指同资源 |
| 打包 | 源码、Node 服务、Bun 编译包、已安装 Electron、实际暂存后台 CLI |
| 文件系统 | 每个声明支持的平台/架构/本地文件系统；未知或网络共享不自动启用 native |
| 迁移 | 每个提交边界的中断、重试、回退，新可写旧不可写 |

需要符号链接权限的测试放在有相应能力的 runner 上跑。本机权限不足只记录未执行，不能记为通过。平台故障专项可以按能力分类单独运行，但发布支持范围要求其对应矩阵全部完成。

## 13. 建议拆成的提交批次

本方案不自动提交。人工实施时建议每批完成后单独复核：

1. `refactor(core): define lock protocol and resource scopes`：协议与根选择，不改旧根行为。
2. `feat(core): add native file lock backend`：原生源码、构建和独立测试。
3. `feat(core): integrate scoped native locks`：两个包装器、取消和诊断。
4. `fix(core): guard scheduled recovery with owner locks`：任务恢复与真实进程测试。
5. `test(core): cover lock identities at write entrypoints`：Core、OpenCode、TUI 的入口覆盖，可按包再拆。
6. `chore(desktop): bundle and stage native lock resources`：CLI、Node、Electron、暂存发布链。
7. `feat(core): add offline lock root migration`：迁移工具、数据根接入和故障注入。
8. `docs: record native lock acceptance results`：精确的平台/包/迁移验收记录。

迁移工具的设计在第 1 阶段就要确定，不能等后端接入后再发现资源无法隔离。第 7 批是实现和验收，不是首次思考隔离方案。

## 14. R3-03B 关闭条件

同时满足后才关闭：

- [ ] 每个支持的平台和发布形态均有可重建、可加载的原生产物。
- [ ] 两个锁 API 共用所有权与协议选择，互斥、取消、释放、崩溃和暂停验证通过。
- [ ] 旧根正常业务无回归，path-identity-v1 仍明确使用目录锁。
- [ ] native 根、非路径 owner 键、凭据协调域与自定义目录使用同一事实来源。
- [ ] 新根缺标记、未知状态、加载失败、文件系统异常都不降级或继续写入。
- [ ] 调度恢复在持锁和数据库条件更新边界内完成，不重放副作用。
- [ ] 支持的真实写入入口逐项验收，不以共享函数测试代替。
- [ ] 已安装包与实际暂存后台 CLI 双向互斥通过。
- [ ] 产品迁移证明新版本可写、旧版本不可写；中断与回退有真实证据。
- [ ] 未支持的平台/文件系统/外部资源有明确阻止或旧协议策略，状态记录没有扩大通过范围。

可以先交付第 0～3 阶段的隔离实现，但不能据此把 R3-03B 标记完成。原有真实界面验收项也不会因为这份锁方案完成而自动关闭。
