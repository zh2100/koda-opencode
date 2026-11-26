# 图片设置锁等待阶段 0 问题检查与解决方案

日期：2026-11-18

## 当前结论与下一步（2026-11-20）

**Linux F2-08b/F2-09 已修复。** [修复前诊断](evidence/image-settings-posix-retire-2026-11-20/before.log)确认新旧 inode 均为 398139，`retire` 返回成功且后继文件已不存在。`retire` 现强制要求事先捕获的 SHA-256；缺失或非法摘要在登记清理前拒绝，正常调用和重试均检查文件版本。原生产迁移调用已提供摘要。[Linux 模块测试](evidence/image-settings-posix-retire-2026-11-20/after.log) 47 通过、6 跳过，[Windows 模块测试](evidence/image-settings-posix-retire-2026-11-20/windows.log) 52 通过、1 跳过；Core/OpenCode typecheck 通过。本轮不是三包全量验收，也不承诺防止最终检查与 unlink 之间的并发路径替换。

**Linux 扩展验证发现未关闭问题：** [第二主体访问测试](evidence/image-settings-posix-reader-2026-11-20/test.log)确认已写入、尚未 rename 时，不同 UID 无法列举暂存目录或读取暂存文件。随后运行完整 `atomic-document.test.ts`（独立容器、非 root、未加载包级 preload）：[45 通过、6 个 Windows 用例跳过、1 失败](evidence/image-settings-posix-atomic-suite-2026-11-20/test.log)。F2-08b/F2-09 中旧文件删除并在同路径重建后，仅传旧 `dev/ino` 的 `retire` 意外成功。原日志未记录新 inode 或最终路径状态；待定向验证 inode 复用和后继文件处置，不将 Linux 模块验收记为通过。

**Linux 权限准备失败补验通过。** 原文件属主 `0:1000`、模式 `0640`，父目录归测试用户所有。由 UID/GID 1000、有效 capabilities 为零的进程执行真实替换：暂存文件 `fchown` 返回 `EPERM`，错误阶段为 `prepare`，提交回调次数为零；原文件身份、元数据和内容未变，无暂存残留或待清理责任。见[原始日志](evidence/image-settings-posix-prepare-2026-11-20-02/test.log)及[命令与源码哈希](evidence/image-settings-posix-prepare-2026-11-20-02/run.json)。[首次夹具日志](evidence/image-settings-posix-prepare-2026-11-20/test.log)仅命中属主前置断言，不计入产品验证。未覆盖第二主体访问或 Linux 包级回归。

**Docker/Linux 单项补验：** Windows 跳过的 `POSIX replacement preserves owner, group and restricted mode` 在 Bun 1.4.3、非 root UID/GID 1000、无宿主挂载的容器内实跑：1 通过、0 失败、4 个断言（替换后 UID/GID 不变、mode 为 `0640`、内容已更新）。测试与实现文件哈希均匹配阶段 2 最终候选。仅复制这两个文件执行原用例，未加载包级 preload；不是 Linux 全包、权限准备失败或第二主体访问验收。见[原始日志](evidence/image-settings-posix-2026-11-20/test.log)和[命令、镜像与哈希](evidence/image-settings-posix-2026-11-20/run.json)。

**当前候选：失败分类修复后的阶段 2 Windows 十项门禁均已通过。** [各门禁命令、日志摘要及退出码](evidence/image-settings-lock-wait-stage2-classification-2026-11-20/runs.json)已核对：无门禁超时，十份日志哈希匹配，[候选前后哈希无变化](evidence/image-settings-lock-wait-stage2-classification-2026-11-20/final.json)。Core 联合测试纳入两个永久负例：T10 为 `business-failure`，T07a 为 `scenario-timeout` 且原因未知；[14 份 worker 记录](evidence/image-settings-lock-wait-stage2-classification-2026-11-20/workers/)均确认目录已清理。Windows 跳过 POSIX 权限用例；不扩展为 Docker/POSIX 验收或三包全套测试通过。以下保留此前各次定向与阶段复核记录。

**最新复核：阶段 1 的两项失败分类缺口已定向验收。** T10 显式产品断言失败得到 `business-failure`、退出码 1；T07a 场景超时保留 `scenario-timeout` 及最后确认事件、未确认的下一事件和原因未知。正式 IMG、正常 worker 和两项永久负向回归在同一运行中 6 通过、0 失败，Core typecheck 通过。见[定向日志](evidence/image-settings-lock-wait-classification-2026-11-20/targeted.log)和[逐 worker 证据](evidence/image-settings-lock-wait-classification-2026-11-20/workers/)。下段为修复前结论；阶段 2 的旧候选结果不自动迁移至本次变更。

**阶段 0 已通过；阶段 1 正常路径通过，失败分类待修，暂不整体签认。阶段 2 已执行的 Windows 本机门禁均为绿，Docker/POSIX 未验证。** 阶段 0 的 `completion-29-candidate` 在同一次独占运行中完成九个门禁，全部为 `status: 0`、`timedOut: false`。监督进程 `18420` 已退出，独占 reservation 已释放，证据审计退出码为 `0`。见[逐门禁结果](evidence/image-settings-lock-wait-a3-2026-11-18/completion-29-candidate/results.json)和[证据清单](evidence/image-settings-lock-wait-a3-2026-11-18/completion-29-candidate/manifest.json)。下文各轮“保持打开”是当轮结论，不再作为当前准入限制。

失败路径复核：使用临时 worker 副本，保持正式 runner、协议校验和时限不变。反转 T10 的 conflict 断言后，结构化 `result.ok=false` 与退出码 1 被归入 `protocol-failure`；在 T07a `interrupt-requested` 后、实际发起中断前注入挂起，只得到 `scenario-timeout`。两者均未误判通过，亦非生产故障复现。需要区分有效产品断言失败与非法协议，并依据最后已确认事件为场景超时补充诊断（不得仅凭请求事件认定产品取消失效）。见[负向复核日志及 worker 证据](evidence/image-settings-lock-wait-stage1-negative-review-2026-11-20/)。

阶段 1：正式等待用例不再拦截 `ConfigDocument.withLock` 推断已等待，而是复用真实观察点、子进程及有界 runner。T07a 返回 `interrupted`，T10 返回 `conflict`；保留发布次数、文件原始字节、锁复用和暂存目录检查。见[定向日志](evidence/image-settings-lock-wait-stage1-2026-11-20/img.log)和[逐场景记录](evidence/image-settings-lock-wait-stage1-2026-11-20/workers/)。

阶段 2：按既有 `verify.py` 的筛选和期限，在新目录完成十项本机门禁（含三轮独立并发回归和三包 typecheck）。见[各项命令、退出码及日志摘要](evidence/image-settings-lock-wait-stage2-2026-11-20/runs.json)和[最终候选哈希](evidence/image-settings-lock-wait-stage2-2026-11-20/final.json)，前后哈希无变化。Windows 跳过的 POSIX 权限用例不计通过；本轮联合门禁不是三个包的全部测试。

| 阶段 | 执行动作 | 验收依据 |
|---|---|---|
| 1：正式 `IMG-T07a` / `IMG-T10` | 先逐项对照第 5 节与现有断言，只补缺口。T07a 须确认 saving fiber 终止后才释放 holder；T10 须验证 `wait -> higher-created -> holder-released -> result`，且结果为 conflict。 | 每个场景独立运行，保留 key/lockfile 双匹配、live-owner 及结构化终态证据。未知状态由父进程有界收尾，不据此判产品通过。第 29 轮 `img` 通过不代替逐项核对。 |
| 2：完整验证与归档 | 在阶段 1 的最终候选上执行 Core 定向、Core 三轮并发回归、Server/OpenCode 联合门禁和三包 typecheck。 | 将同候选哈希、原始日志及结果归入新目录，不覆盖第 29 轮。Docker/POSIX 独立记录；未运行即标为未验证。 |

## 1. 历史结论与方案依据

**completion-05 复核后：阶段 0 保持打开。** 真实 `tasklist` 尚未接入受管观察器，cleanup 的快照所有权、总时限和原目录保留语义未通过验收，联合归档混有多次运行记录。实施顺序和逐项通过条件见 [A3 修复方案：completion-05 复核](./image-settings-lock-wait-a3-remediation-plan-2026-11-18.md)。不得用历史联合测试计数替代 A3 或正式 `IMG-T07a/T10` 的放行证据。

采用最终组合方案是可行的，但必须拆成三个独立、可验证的门禁：

```text
A1：真实 EffectFlock Layer seam + replacement
A2：本轮局部显式 facade + 精确 package export
A3：T07a/T10 child process 硬隔离
```

A1 已有基础验证；A2 已实现局部 facade、类型兼容、identity 和编译负向检查，完整 import/resolution 审计未关闭；A3 runner 已修复 ready/退出竞争、payload/事件运行时校验和基本收尾，但完整故障矩阵、真实进程树证据、失败目录保留证据及阶段 0 危险等待测试硬隔离仍未完成。**阶段 0 保持打开，禁止开始正式 IMG-T07a/T10 改造。**

A2 是本轮战术性 API 隔离，不宣称解决 Core 全包 wildcard 的长期架构问题；全 Core 显式 export map 作为独立后续重构。

A3 的独立修复方案见：[A3 子进程 runner 修复方案](./image-settings-lock-wait-a3-remediation-plan-2026-11-18.md)。该方案定义统一 runner、F01-F09 故障矩阵、阶段状态机、错误聚合、Windows 进程树终止和 cleanup 保留规则；本文件继续作为阶段 0 总门禁和危险等待证据方案。

历史 `30 pass / 0 fail`、`6 pass / 0 fail` 和 Core typecheck 通过记录可以保留，但仅证明对应候选和已执行用例通过，不证明异常清理安全。既有图片设置超时在后续运行未复现，根因仍未确定，不能声明已修复。最新关闭条件以本方案第 8 节为准，不得通过降低 POC 标准将现存缺陷移到“正式 runner 后续完善”。

## 2. 已检查内容

### 2.1 观察点

当前观察点位于真实 `waitWhileHeld` 中：

- lockfile `stat` 返回存在；
- breaker 不存在；
- metadata 诊断为 `live-owner`；
- 在返回 `NotAcquired`、进入 retry 前发出 `{ key, lockfile }`；
- `stat` 失败时保持原有保守 busy 语义，但不产生真实等待证据；
- observer 异常被隔离，不改变锁错误或重试结果。

这部分暂不需要改动。正式测试仍必须同时匹配 canonical key 和目标 lockfile。

### 2.2 replacement

测试节点：

- 使用相同 `EffectFlock.Service`；
- 保留相同 global tag；
- 声明 `Global.node` 和 `FSUtil.node`；
- 通过原始 `EffectFlock.node` replacement；
- 不复制生产锁实现。

这部分验证已通过，暂不需要改动。

### 2.3 API surface 根因

`packages/core/package.json` 当前包含：

```json
"./*": "./src/*.ts"
```

因此在 `src/util/effect-flock.ts` 中导出的 `layerWith` 会通过：

```text
@opencode-ai/core/util/effect-flock
```

被访问。`@internal` 只提供语义标记，不阻止解析或运行时导入。当前 API audit 用例确认了该暴露事实。

不能采用以下不充分修复：

- 只增加 `@internal` 注释；
- 只从公共 barrel 删除导出；
- 只在测试中约定“不应使用”；
- 将 hook 放进公开 `EffectFlock.Interface`；
- 把测试 Layer 复制到测试模块。

## 3. 解决线 A：本轮局部隔离 `layerWith` 的公共包入口

### 3.1 推荐方案

本轮采用局部、战术性的显式 facade，不把它描述为 Core 全包 API 重构。保留真实实现中的 `EffectFlock.layerWith`，增加一个不暴露该成员的显式公共 facade，并将包路径精确映射到 facade。facade 不能简单使用 `export { EffectFlock }`，因为这会继续暴露完整 namespace；必须显式转发允许的公共符号，并保留原始值/类 identity 以及类型和值空间兼容性。

```text
@opencode-ai/core/util/effect-flock
    -> packages/core/src/util/effect-flock-public.ts
```

facade 的具体 namespace 写法必须先经 Core typecheck 验证。它至少需要保留现有公共入口实际使用的 `Service`、错误类型、`Interface`、`layer` 和 `node`，但不得导出：

```text
layerWith
WaitObservation
测试 observer 配置
内部 NotAcquired/ReleaseError
```

不得使用全量 namespace re-export，也不得重新定义 Service 或错误 class。公共 facade 需要通过原始符号引用保持运行时 identity；类型空间则必须通过编译级检查确认，不得只依赖运行时 `in` 检查。

`packages/core/package.json` 增加精确导出：

```json
"./util/effect-flock": "./src/util/effect-flock-public.ts"
```

精确 subpath 应覆盖当前 wildcard 对同名路径的解析。测试专用模块从仓库相对路径导入真实内部生产模块，不能从公共包路径取得 `layerWith`：

```ts
import { EffectFlock } from "../../src/util/effect-flock"
```

公共生产代码和普通测试继续从：

```ts
@opencode-ai/core/util/effect-flock
```

导入，以验证本轮 facade 的公共形状。

长期方案另行跟踪：参考上游 `@opencode/ai` 的 explicit export map，作为独立任务盘点 Core 的全部公共入口并删除 `"./*"`；该任务不并入本轮 IMG-T07a/T10 证据修复。

### 3.1.1 facade 实现边界

公共 facade 必须从当前实际公共用法反向盘点，而不是猜测 namespace 成员。实施前记录以下清单：

- monorepo 中所有 `@opencode-ai/core/util/effect-flock` 的值导入和类型导入；
- 运行时依赖的 `Service`、错误 class、`layer`、`node` 和其他现有公共成员；
- 生产代码、测试代码和脚本中是否存在动态 import 或字符串形式的入口。

facade 文件只能引用原始实现的允许成员。若某个现有公共成员无法在不破坏类型空间的情况下保留，必须先记录为 A2 阻塞，不得用重新定义 class、复制 Layer 或扩大 hook 暴露来绕过。`package.json` 的精确 export 配置必须在实际 Node/Bun package resolution 下验证，不能只解析 JSON 文本；同时检查同名 wildcard、barrel、动态 import 和相对源码入口是否造成误判。

### 3.2 必须验证

阶段 0 API surface 验证必须同时满足：

1. `@opencode-ai/core/util/effect-flock` 仍能提供现有 `EffectFlock.Service`、错误类型、`Interface`、默认 `layer` 和 `node`；
2. 通过该公共入口取得的 `EffectFlock` 运行时不含 `layerWith`；
3. 公共入口存在编译级负向检查，确认 `layerWith` 和 `WaitObservation` 不能作为公共类型/API 使用；
4. 测试专用相对路径仍能取得真实 `layerWith` 和 `WaitObservation`；
5. `public.Service === internal.Service`、`public.layer === internal.layer`、`public.node === internal.node`，错误 class 的运行时 identity 也保持一致；
6. `EffectFlock.Interface` 没有新增成员；
7. SDK、公共 barrel、运行时配置没有出现 hook；
8. 默认 `EffectFlock.layer` 仍为 `layerWith()`，无 observer；
9. 审计所有 monorepo 内对 `@opencode-ai/core/util/effect-flock` 的导入，确保产品代码不依赖内部 seam；
10. 不能依赖仅删除测试用例来证明隔离。

这些标准只关闭本轮 `EffectFlock` 公共入口暴露问题，不代表 Core 全包 wildcard 已被解决。

如果 Bun/TypeScript 对 namespace facade 的导出形状不稳定，改用显式 facade 导出所有既有公共符号，但仍不得导出 `layerWith`。应先做包级 typecheck 和最小 import audit，再继续正式测试。

### 3.3 本轮不采用的替代方案

- 仅把 `layerWith` 移到另一个 `src` 文件：wildcard 仍可能暴露该文件；
- 只调整 barrel：当前主要入口不是 barrel，而是 package wildcard；
- 本轮直接删除整个 Core 的 `"./*"` 并改成全量显式 exports：这是长期正确方向，但影响面大，需要独立盘点和迁移，不与本轮锁等待证据修复混合；
- 用全量 namespace re-export 伪装成 facade：不能隐藏 `layerWith`，也不能满足 API 隔离；
- 改用 FSUtil seam：会降低观察点语义强度，只有本轮局部 facade 无法通过 API 隔离时才考虑。

## 4. 解决线 B：修复 T07a 超时清理矛盾

### 4.1 根因

Effect fiber 的中断是协作式的。若保存 fiber 在生产调用或测试 hook 中不响应中断，则同一进程内不能可靠证明：

```text
保存 fiber 已停止执行
```

此时释放 holder 可能让保存 fiber继续获取锁、发布文件；不释放 holder 又会使当前测试作用域无法正常完成。`Effect.ensuring` 只能执行清理逻辑，不能强制终止不响应中断的 fiber。

因此，不能继续使用以下规则：

```text
任何测试异常 -> ensuring -> 无条件释放 holder
```

也不能把 scope 关闭描述为任意 fiber 的强制终止机制。

### 4.2 推荐测试结构：正常路径与基础设施失败路径分离

#### 正常路径

1. 创建 holder；
2. 启动保存 fiber；
3. 等待匹配的 `WaitObservation`，使用有限 timeout；
4. 中断保存 fiber；
5. 在有限 timeout 内 `Fiber.await` 并确认保存 fiber 已终止；
6. 仅在第 5 步成功后释放 holder；
7. 等待 holder 结束；
8. 执行 publish、文件、阶段目录和 lock reuse 断言。

#### 超时/未知状态路径

1. 保存 fiber 未在规定时间内终止时，立即记录失败及最后可信阶段，按第 8 节分类；
2. 不执行正常产品断言；
3. 不释放仍可能被保存 fiber使用的 holder；
4. 不在同一测试作用域内继续尝试“修复”该状态；
5. 交给测试级硬隔离边界结束整个测试 worker/process；
6. 由外层 runner 记录原始 timeout，并按第 8 节分类，不能掩盖取消行为回归。

### 4.3 隔离边界选择

优先选择独立 child process 承载 T07a/T10 的危险并发场景。A3 只负责测试生命周期和硬终止，不改变生产锁实现；父进程不得执行锁操作、删除 lockfile 或替子进程完成业务清理。父进程负责：

- 创建并唯一标识本场景的临时根目录，子进程只接收该目录和经过校验的 JSON payload；
- 启动测试子进程，并在终止前注册一次性的 `close` 等待；
- 接收结构化阶段事件和最终结果，拒绝无法解析、重复终态或违反顺序的事件流；
- 施加有限 wall-clock timeout，并区分正常结果、worker 非零退出、worker 无结果退出和父进程 timeout；
- 超时后终止子进程，而不是在同一 Effect runtime 中释放未知状态的 holder；Windows 使用 `taskkill /pid <pid> /T /F`，其他平台使用平台适当的终止方式；
- 等待 child `close`/退出确认后，才清理独立临时目录；kill/taskkill 返回不等于 worker 已退出；
- 保留 stdout/stderr、退出码、signal、事件日志、timeout 时间点和清理结果；
- 清理失败时保留原始目录和失败信息，不用删除 lockfile 掩盖测试失败。

子进程内部仍使用真实 `EffectFlock` 和 `layerWith`，父进程只负责硬隔离和结果采集，不参与锁逻辑。worker 必须在正常完成、业务失败和异常退出时提供可区分的终态；超时未能通信时由父进程记录基础设施失败，不伪造 `result`。

如果本轮不引入 child process，则只能实现正常路径，并把“不响应中断的超时清理”明确列为未验证边界；不得声称已满足 T07a 的完整异常安全清理要求。

### 4.4 T10 的特殊处理

T10 在观察事件后创建高优先级文件，随后释放 holder。它不应在 holder 释放前等待一个可能无限期的保存 fiber完成。建议：

1. 观察事件匹配 key/lockfile 后创建高优先级文件；
2. 确认创建事件顺序；
3. 正常释放 holder；
4. 等待保存结果并断言 conflict；
5. 若保存结果在有限 timeout 内未结束，走 child process 基础设施失败路径，不执行产品断言。

事件顺序仍必须是：

```text
wait(canonical key, canonical lockfile)
-> higher-created
-> holder-released
```

## 5. 最终组合方案的实施顺序

### 阶段 0A：锁定 A1 的基线

A1 当前已通过最小验证，但仍需保留以下不变量：

1. `EffectFlock.layerWith` 使用真实生产 Layer；
2. replacement source 仍为原始 `EffectFlock.node`；
3. service identity、name、global tag、Global/FSUtil 依赖保持一致；
4. hook 只接受观察配置，不加入公开 `EffectFlock.Interface`；
5. 默认 `EffectFlock.layer` 不触发 observer；
6. 不修改正式 T07a/T10。

### 阶段 0B：实施并关闭本轮 A2 局部 API surface

1. 新增显式公共 facade，不做全量 namespace re-export；
2. 增加 `./util/effect-flock` 精确 package export；
3. 测试专用构造改为相对路径访问真实内部 Layer；
4. 公共入口不得暴露 `layerWith` 或 `WaitObservation`；
5. 增加编译级负向检查、monorepo import audit 和 public/internal identity audit；
6. 运行 Core `bun typecheck`、import audit 和阶段 0 测试；
7. 明确记录 A2 只解决 `EffectFlock` 入口，不关闭 Core 全包 wildcard 的长期问题；
8. A2 审计与 A3 基础设施修复可以并行；二者未关闭前，不得开始正式测试改造。

### 阶段 0C：实施并关闭 A3 子进程硬隔离

先不修改正式 T07a/T10，新增最小 proof of concept。POC 必须同时覆盖正常、业务失败和超时三条生命周期路径：

1. worker 子进程能够启动真实 Core 测试代码，并只接收校验后的结构化 payload；
2. worker 能按严格协议输出结构化事件：`started`、`holding`、`released`、`result`；每个事件带场景标识，`result` 只能出现一次；事件名称必须描述真实生命周期，不得把 body 内信号称为 holder 已释放；
3. 父进程能增量读取 stdout/stderr，解析事件，并保留退出码、signal 和原始输出；必须先收到 worker 就绪事件，再开始 timeout/故障注入计时；
4. 正常完成时父进程等待 result 和 child close，且 result/退出码一致；
5. worker 主动报告业务失败时，父进程保留产品失败结果，不把它转换为 timeout；
6. worker 就绪后超过 wall-clock timeout 时，父进程先记录 timeout，再终止 worker；Windows 使用 `taskkill /pid <pid> /T /F`；启动 timeout 与场景 timeout 分开，未就绪退出不能计为场景 timeout；
7. close listener 必须在终止前注册，终止后必须等待 child close，不能把 kill/taskkill 返回视为退出确认；
8. 终止后不存在遗留 Bun/Node worker；
9. child close 确认后独立临时目录可以由父进程清理；清理失败保留目录和证据，不删除 lockfile 掩盖失败；
10. 父进程不执行锁操作、不删除 lockfile、不替 worker 完成业务清理；
11. Windows `node D:/opencode/script/test-isolated.mjs` 环境下验证 child process 行为，并至少重复正常和 timeout 场景；
12. POC 记录退出码、signal、事件顺序、timeout、worker 残留检查和临时目录清理结果。

A3 POC 通过前，不得把 T07a/T10 放入子进程，也不得宣称超时路径已安全。

### 阶段 1：改造正式 T07a/T10

仅在 A1、A2、A3 全部通过后：

1. T07a 正常路径：观察、取消、有限等待并确认 saving fiber 终止，之后才释放 holder；
2. T07a 未知状态：记录失败并按第 8 节分类，不执行产品断言，由父进程硬终止 worker；
3. T10 正常路径：观察、创建高优先级文件、严格记录 `wait -> higher-created -> holder-released -> result` 顺序、释放 holder、等待 conflict；
4. T10 未知状态：由父进程 timeout/终止，不在同一进程内释放未知 holder；
5. 生产断言只接受 worker 的结构化 `result` 和已验证的终态，不接受父进程根据文件残留或 timeout 推断产品通过；
6. 保留 key/lockfile 双匹配和 live-owner 条件；
7. 每个场景独立临时目录、独立 worker、独立证据文件；
8. 运行 T07a/T10 定向测试。

### 阶段 2：完整验证与证据

1. Core 定向测试；
2. Core 三轮并发回归；
3. Server/OpenCode 联合门禁；
4. 三包 typecheck；
5. 重新生成候选文件哈希和原始日志；
6. 单独归档 Docker/POSIX 结果；
7. 更新矩阵时区分产品失败、测试基础设施失败和未验证，不把 worker timeout 计为产品通过。

## 6. 当前门禁状态

| 项目 | 状态 | 说明 |
|---|---|---|
| 真实 `waitWhileHeld` 观察点 | 已验证 | 仅 `live-owner`，key/lockfile 双匹配 |
| replacement identity/tag/deps | 已验证 | 阶段 0 测试通过 |
| 默认锁行为 | 已验证 | 默认 Layer 可获取、释放和复用 |
| A1 真实 Layer seam | 已验证 | 阶段 0 测试通过 |
| A2 局部 API surface 隔离 | 已通过本轮范围 | facade、类型兼容、运行时 identity、Bun 测试解析、Node `require.resolve` 和 monorepo scoped import audit 通过；长期 Core 全包 wildcard 仍独立跟踪 |
| Core 全包 explicit export map | 未实施 | 独立长期重构，不属于本轮关闭条件 |
| A3 子进程硬隔离 | 部分故障门禁已通过，整体未关闭 | 已验证 normal/business failure/hang、协议故障、输出超限、result/no-result、后代进程和阶段 0 危险等待 worker；终止/清理失败注入、统一 runner、运行时能力探针和完整证据模型仍待完成 |
| T07a 正常中断路径 | 未正式改造 | 需 A1/A2/A3 后实施 |
| T07a 超时硬隔离 | 未解决 | 需 A3 通过后才能宣称安全 |
| T10 正式证据 | 未正式改造 | 不能升级结论 |
| Docker/POSIX | 未验证 | 独立补充范围 |

## 7. 最终组合方案的关闭标准

只有以下条件全部满足，才允许关闭阶段 0并进入正式测试。阶段 0 的关闭只表示 A1/A2/A3 门禁已通过，不表示 IMG-T07a/T10 产品测试已经通过：

```text
A1 pass
+ A2 pass
+ A3 pass
```

其中：

- A1：真实 `waitWhileHeld` 观察、replacement identity/tag/deps 和默认 Layer 行为通过；
- A2：本轮 `EffectFlock` 公共入口不暴露 `layerWith`/`WaitObservation`，编译级负向检查、monorepo import audit 和 public/internal identity audit 通过；该项不代表 Core 全包 wildcard 已移除；
- A3：第 8 节全部修复及故障注入门禁通过，原始输出、实际终止状态、目录处置与无残留证据归档后，才可关闭；
- T07a/T10 正式测试尚未改造前，不更新产品验收为通过；
- child process timeout 不得记为产品 pass；启动/协议故障、取消行为失败和原因未判定分别记录；
- Docker/POSIX、第二主体、其他 Bun 版本、GUI/EXE 和崩溃恢复仍保持独立未验证边界。

当前最小、风险最低的路线是：

1. 保留已验证的 A1；
2. 实施并验证本轮 A2 局部 facade；
3. 在正式 T07a/T10 前，补齐 A3 runner 的 close/退出状态、进程树残留、协议异常和失败清理证据；
4. A1/A2/A3 全部通过后才修改 IMG-T07a/T10；
5. 在此之前不宣布阶段 0 完成、不升级锁等待验收结论、不运行大范围候选门禁；
6. 将 Core 全包 explicit export map 记录为后续独立重构，不把它作为本轮阻塞或本轮已解决事项。

## 9. 剩余工作执行计划（复核更新）

本节替代此前将 A3 三场景 POC 视为接近完成的表述。当前已验证结果只覆盖：A3 正常完成、业务失败、就绪后持续 hang；以及 ready/退出竞争、基本事件运行时校验、退出确认后的基本清理。下列工作仍是阶段 0 的强制门禁，不得推迟到正式 T07a/T10 改造后。

### 9.1 A3 runner 完成真实故障矩阵

为避免单个联合测试掩盖场景边界，优先将故障场景拆成独立测试或独立 worker invocation。每个场景都必须保留原始 stdout/stderr、事件、退出状态、timeout 阶段和目录处置结果，并在故障场景后运行一个健康 normal 场景，证明没有污染后续用例。

必须新增并通过以下场景：

| 编号 | 故障场景 | 必须证明 |
| --- | --- | --- |
| A3-F01 | 缺失/非法 payload、worker 启动失败 | 归类为启动/协议基础设施失败；不伪造 holding、result 或场景 timeout；已创建目录的处置可追踪 |
| A3-F02 | started 后未到 holding 退出 | 与场景 timeout 区分；提前退出立即失败；退出确认后才允许清理 |
| A3-F03 | holding 后提前非零退出 | 不能在 deadline 后补记 timeout；保留非零退出和事件序列 |
| A3-F04 | 非法 JSON、未知字段/错误字段、场景不符、重复或乱序事件 | 增量读取时及时拒绝并进入安全终止；原始输出不丢失 |
| A3-F05 | result 后继续存活、退出无 result、重复 result | 均判为协议/生命周期失败；不能只依据 result 或退出码判成功 |
| A3-F06 | 输出超过字节限制、未完成行过长、stdout/stderr 管道不结束 | 有界失败；输出 reader rejection 被消费；不依赖外层测试总 timeout |
| A3-F07 | worker 创建可追踪后代并持续存活 | Windows `taskkill /T /F` 后主进程及后代均确认退出；主 worker 退出单独不足以通过 |
| A3-F08 | taskkill/kill 返回失败、退出确认超时 | 保留目录和原始/终止错误；禁止 cleanup；结果不得升级为成功 |
| A3-F09 | 目录清理失败 | 保留清理错误、原始业务/协议错误和目录路径；不得由 cleanup 错误覆盖主错误 |

终止和清理失败若不能稳定由真实环境制造，可以通过测试专用注入边界覆盖错误保留逻辑，但必须另行保留至少一个真实 Windows 后代树终止证据；注入测试不能替代真实 `taskkill /T /F` 验证。

### 9.2 A3 证据模型与生命周期收尾

在 runner 中补齐单一收尾状态模型，避免正常返回路径和 `finally` 路径重复清理或互相覆盖：

1. 在 spawn 后立即登记退出与 stdout/stderr reader；
2. 记录 `readyAt`、`deadlineAt`、`timeoutStage`、`terminationStartedAt` 和 `cleanupStatus`；
3. 将主错误、协议错误、输出错误、终止错误、退出确认错误和 cleanup 错误分别保存，最终报告包含主错误及次级错误；
4. 只有确认 worker 退出、输出收尾完成且真实后代检查通过时才执行一次目录删除；
5. 任一确认失败时保留目录、PID、事件和输出，并让测试失败；
6. signal 只有在运行时确实可取得时记录具体值，否则使用明确的不可得状态，不写入伪造的 `null`；
7. 清除所有 deadline timer、reader listener 和未处理 Promise rejection。

当前 `Bun.Subprocess` 能直接提供的退出信息仍需在实现中按实际 API 验证；不能为了填充证据结构而推断 signal 或后代退出。

### 9.3 A2 完整 import/resolution 审计

A2 不能只以现有 facade identity 测试关闭。需要新增可复现审计记录，至少覆盖：

- monorepo 中 `@opencode-ai/core/util/effect-flock` 的静态值导入、类型导入、动态 import、字符串入口和 barrel 转发；
- `layerWith`、`WaitObservation`、测试 observer 配置是否从公共包路径、SDK、公共 barrel 或运行时配置可达；
- Bun/Node 实际 package resolution 对精确 export 与 wildcard 的解析结果；
- 公共入口的值/类型兼容、内部源码入口的 seam 可达性及 identity 保持；
- 审计命令、环境、完整输出和退出码。

审计结果只能关闭 `EffectFlock` 这一局部入口；不得将其写成 Core 全包 explicit export 已完成。

### 9.4 阶段 0 危险等待测试硬隔离

A3 POC 通过后，新增独立 worker 承载阶段 0 的真实等待/取消危险场景，但仍不得修改正式 IMG-T07a/T10：

- worker 内使用真实 `EffectFlock.layerWith` 和已验证 replacement；
- 父进程只传递经过运行时校验的场景 payload，不执行锁操作、不释放 holder、不删除 lockfile；
- 事件必须区分 `wait`、`interrupt-requested`、`saving-terminated`、`higher-created`、`holder-released`、`result`，并同时记录 canonical key 与 lockfile；
- T07a 风险路径只有确认 saving fiber 终止后才允许 worker 释放 holder；未知状态由父进程终止整个 worker；
- T10 风险路径允许在 saving 仍等待时创建 higher 文件，但必须严格记录 `wait -> higher-created -> holder-released`；
- 父进程只接受已校验的结构化 result，不根据残留文件或 timeout 推断产品通过。

该 worker 的通过只关闭“危险测试已硬隔离”这一阶段 0 条件，不代表正式 T07a/T10 产品断言已经完成。

### 9.5 证据归档和验证顺序

按以下顺序执行，禁止拼接不同候选、不同代码状态或不同运行的 totals：

1. Core `bun typecheck`；
2. A2 import/resolution audit；
3. A3 正常、失败、协议、输出、后代、终止和清理故障测试；
4. 每条故障场景后的健康 worker；
5. 阶段 0 危险等待 worker 的定向测试；
6. 阶段 0 相关测试联合运行；
7. 图片设置旧测试仅作为回归观察，不升级旧 T07a/T10 的等待证据结论；
8. 保存每次运行的命令、Bun/Node/Windows 版本、隔离根目录、退出码、stdout/stderr、事件日志、目录处置和 SHA-256。

必须建立新的证据子目录，不覆盖旧红测或旧候选。若任一故障场景失败、目录未确认清理或审计缺失，阶段 0 仍保持打开。

### 9.6 剩余工作完成定义

只有以下项目全部完成，才可将状态从“部分修复”更新为 A3 pass，并继续评估阶段 0：

- [ ] A3-F01 至 A3-F09 全部通过，且故障后健康场景通过；当前已覆盖协议/输出/后代/健康场景，终止失败和 cleanup 失败仍未完成。
- [ ] Windows 真实后代进程树终止证据已归档；
- [ ] 终止确认失败和 cleanup 失败均验证为保留目录、不覆盖原始错误；
- [x] A2 本轮 `EffectFlock` import/resolution 审计输出已归档；长期 Core 全包 explicit export audit 不在本轮范围；
- [ ] 阶段 0 真实等待/取消危险测试已迁移到 child process，完成 key/lockfile 双匹配；
- [ ] 当前代码状态下的 typecheck、定向测试和联合测试日志完整且可复现；
- [ ] 两份方案、结果文档、任务状态和实际测试结果一致。

在上述清单完成前，禁止修改正式 IMG-T07a/T10，禁止宣布阶段 0 通过，也不得把旧图片设置测试的通过结果重述为真实锁等待证据通过。

## 8. 复核后的修复执行与准入条件

本节是阶段 0 的强制门禁，覆盖前文含糊或过时的 POC 完成措辞。不得再以三场景测试通过替代以下验收。

### 8.1 修复顺序

1. **退出未确认禁止删除目录。** 移除吞掉退出超时后继续 cleanup 的逻辑。spawn、协议、deadline、输出和断言失败必须进入同一个生命周期收尾；目录只清理一次。保留主错误以及终止、输出收尾、清理的次级错误，不用 finally 的异常覆盖原始失败。
2. **deadline 与提前退出竞争。** 启动预算只等待校验后的 holding；就绪后另起场景 deadline，并与 worker 退出、协议失败竞争。提前退出必须失败；只有场景 deadline 真正先触发才能标记 timeout。测试输入不能推导 timedOut。正常/业务失败路径的 watchdog 超时也必须记录并使门禁失败。
3. **有界终止及输出收尾。** Windows 先有界等待 taskkill /T /F 的结果，明确直接 kill 的降级条件，不能同时启动两种终止而不确认结果。注册退出及输出观察必须早于终止。Bun.spawn 的确认条件为 child.exited、stdout/stderr 收尾和必要的进程树确认；不能伪造 close。Node child_process 则提前注册 close。任何一步超时都保留目录和诊断。
4. **协议校验。** payload 与每条事件进行运行时校验；验证场景 ID、事件名、字段、顺序、唯一终态及 result.ok/退出码一致性。协议错误应立即反馈 runner，不等 EOF 才发现。限制总输出字节数及未完成行，收集失败立即进入安全终止路径，并及时处理 promise rejection。
5. **证据真实性。** 实际记录退出码、signal（平台确实无法提供时标为不可得而不是 null）、触发 deadline 的阶段/时间、终止命令结果、stdout/stderr、目录保留或清理原因。清理失败保留错误，不只返回 retained。不得根据残留文件推断产品通过。
6. **完成 A2 与真实 seam 集成。** 归档 monorepo 静态/动态 import、barrel、TS paths 和实际 package resolution 审计；公共/内部类型兼容、负向编译和 identity 检查保持通过。不把相对/绝对源码可访问性当作 package API 隔离承诺。将阶段 0 的真实等待/取消危险测试也纳入已验证的硬隔离边界；真实 seam 事件仍要求 key/lockfile 双匹配，不能用 holding 代替 wait。

### 8.2 必须执行的故障注入

| 场景 | 验收要求 |
| --- | --- |
| 正常完成、业务失败 | result 与退出码一致；真实释放后才报告 released；作用域结束后输出终态；不依靠内部强退绕过清理 |
| 启动失败、未就绪退出、启动卡住 | 分别记录；不计为场景 timeout；已启动进程必须安全收尾 |
| holding 后提前非零退出 | 必须失败，不能在 sleep 后补记 timeout |
| holding 后持续不退出 | 真实场景 deadline 先到，随后有界终止并确认；至少重复验证 |
| result 后仍不退出、退出无 result | 均失败，不以 result 或退出码单独判定成功 |
| 非法 JSON、字段错误、场景不符、重复/乱序终态 | 及时拒绝，保留原始输出并安全终止 |
| 输出超限、输出管道不结束 | 有界失败，不依赖外层测试超时；不遗留未处理 rejection |
| 带后代进程的卡住场景 | 验证树终止和可追踪后代均退出；主 worker 退出不是充分证据 |
| taskkill/kill 失败、退出确认超时 | 保留根目录及原始/次级错误，禁止执行目录删除；不能升级为成功 |
| 目录清理失败 | 保存目录及实际错误，判为门禁失败；不覆盖业务失败 |

优先真实子进程故障注入。难以可靠制造的终止/清理失败可通过测试专用依赖边界注入，并与实际 Windows 终止测试分开归档；不能用注入测试替代真实进程树证据。每个故障测试之后运行健康用例，确认不污染后续测试。不得使用全局进程清理来伪造无残留。

### 8.3 时间预算与分类

- 启动、场景执行、终止、输出收尾和目录清理分别设置有限预算；成功或失败后清除计时器和监听器。
- 外层测试预算必须大于整条最长收尾链；三个场景串行时按总预算计算，或拆为独立测试。不能仅增加 --timeout 使现有用例变绿。
- 启动/协议故障归基础设施失败；真实 wait 和取消请求已确认但 saving 不终止，记录取消行为失败或疑似产品回归；信息不足标为原因未判定。timeout 一律不是产品 pass。
- T07a 正常顺序为 wait → interrupt → 确认 saving 终止 → release holder；T10 为 wait → higher-created → release holder → conflict。未知状态不得无条件释放 holder。

### 8.4 阶段 0 关闭清单

- [ ] A2 完整 import/resolution 审计与类型/identity 检查归档。
- [ ] 8.1 的生命周期修复完成，退出确认失败不删除目录。
- [ ] 8.2 故障矩阵及健康恢复用例全部通过，Windows 真实树终止无残留证据归档。
- [ ] 阶段 0 真实 seam 危险测试完成硬隔离及双匹配验证。
- [ ] 从 Core 包目录运行 bun typecheck、阶段 0 定向测试及图片设置联合回归；不得拼接不同运行的结果作为联合通过。
- [ ] 归档当前候选原始日志、环境、命令、退出状态、文件哈希及失败目录处置；保留历史红测。既有图片设置超时未复现不等于根因已修复。
- [ ] 两份方案、结果记录和任务状态一致；所有未通过项明确保持打开。

全部勾选后才允许进入正式 T07a/T10 改造。当前上述清单未完成，阶段 0 未通过；不扩展到 Core 全包 exports、POSIX、其他 Bun 版本、GUI/EXE 或生产崩溃恢复。


## completion-11 执行增量（未签认）

本轮已实施删除 helper 的并发有界 stderr、退出/输出确认检查、快照复制完成标记及 tree observer 取消收尾检查；新增三条定向测试。当前候选 Core typecheck 退出 0，七文件同一次隔离联合运行 `38 pass / 0 fail / 320 expect() calls`。原始日志、源码散列、红测限制及剩余缺口见 [completion-11 复核](evidence/image-settings-lock-wait-a3-2026-11-18/completion-11-final/review.md)。完整预算、目录处置、observer PID/管道证据、归档原子隔离及产品门禁仍未完成；A3 与阶段 0保持打开，任务不得整体勾选完成。


## completion-14 增量（保持打开）

cleanup 四阶段受管 helper、阶段状态证据、observer PID/输出和原子归档负例已补充。最新同候选七文件联合 `44 pass / 0 fail / 385 expect()`，正式 IMG `3 pass / 0 fail / 22 expect()`；三包类型检查通过，Server 全量 `37 pass / 0 fail`。Core/OpenCode 全量被外层期限中断；Core tree kill 还出现非零退出，不能关闭。详见 [completion-14 复核](evidence/image-settings-lock-wait-a3-2026-11-18/completion-14-review.md)。observer 父侧握手、真实部分复制/回收中断及端到端预算仍有缺口。


## completion-15 增量（未签认）

真实部分复制/回收中断及 observer ready 后退出前 PID 可见性检查已补。最新同候选联合 46 pass / 0 fail / 408 expect()，正式 IMG 3 pass / 0 fail；三包类型检查与 Server 全量通过。Core 全量自然结束：1853 pass / 8 skip / 9 fail；OpenCode 在 15 分钟外层期限中断。manifest 审计通过，但端到端预算与握手后故障计时仍未完整。详见 [completion-15 复核](evidence/image-settings-lock-wait-a3-2026-11-18/completion-15-review.md)。A3 / 阶段 0保持打开。
