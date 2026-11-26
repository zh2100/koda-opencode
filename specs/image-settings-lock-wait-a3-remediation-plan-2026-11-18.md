# 图片设置真实锁等待证据：A3 子进程 runner 修复方案

日期：2026-11-18

当前状态（2026-11-20）：**A3 已随阶段 0 在 `completion-29-candidate` 通过。** `overflow` 回归覆盖了 worker 自行退出后 `taskkill` 找不到该 PID 的竞争：只有确认退出、管道和进程树收尾后，才保留原始输出错误分类。见[本轮联合测试日志](evidence/image-settings-lock-wait-a3-2026-11-18/completion-29-candidate/joint.log)。下一步按[总方案](image-settings-lock-wait-stage0-remediation-plan-2026-11-18.md)核对正式 `IMG-T07a` / `IMG-T10`。

历史基线：completion-05 复核时 A3 未通过，以下五项是当轮待修项。后文保留各轮当时的签认状态。

## 1. 目标与非目标

下一轮按[阶段 0 测试与修复执行单](image-settings-lock-wait-stage0-test-repair-2026-11-18.md)执行。执行单区分历史基线、待验证假设和签认条件；不以既有通过计数代替当前候选验收。

### completion-05 复核：待修项与验收方式

### completion-06 实施记录

已完成：快照改为 `mkdtemp` 独占目录；复制、cleanup helper 与快照删除共享 cleanup 总截止时间；真实 descendant `tasklist` 改用 runner 的 `context.observe`/`AbortSignal`；新增旧快照保护回归测试；归档脚本拒绝覆盖已有目录。`bun typecheck` 与联合门禁通过：`34 pass / 0 fail / 294 expect() calls`。证据位于 `completion-06-final/`。仍需逐条复核 descendant 原始输出、部分删除恢复语义，并执行正式产品门禁；A3 和阶段 0不关闭。

### completion-07 剩余工作记录

已新增真实“部分删除后挂起” cleanup 场景，确认 root 中 marker 被删除时，独占 snapshot 仍保留删除前内容；旧快照保护回归继续通过。新的单次证据位于 `completion-07-final/`，联合门禁为 `35 pass / 0 fail / 300 expect() calls`，`evidence-audit.json` 记录 112 个 worker、4 个 descendant、4 个 observer 收尾记录和 1 个 tasklist 原始证据记录。`tree-observers-closed.detail=0` 的场景表示没有启动 observer helper，不解释为 helper 成功收尾。仍需逐条审查真实 PID/tasklist 对应关系，并完成正式产品门禁；A3 和阶段 0不关闭。

### completion-08 测试执行记录

同一候选代码状态下重新执行 typecheck、runner/capability、POC、fault matrix、A2 和 stage0 联合门禁：`35 pass / 0 fail / 300 expect() calls`。新证据位于 `completion-08-final/`，没有与旧证据目录混合；审计记录 112 个 worker、4 个 descendant、1 个带 tasklist 原始 evidence 的记录和 16 个 retained root。专项 cleanup 和快照完整性测试通过，但仍缺少独立的真实挂起 observer helper 端到端 fixture，且正式 `IMG-T07a/T10`、完整 Core/Server/OpenCode 门禁未执行。A3 和阶段 0不关闭。

### 后续测试增量

对 runner 的 cleanup helper stderr 已改为并发、有界读取，避免在 helper 非零退出或 stderr 未 EOF 时无限等待；typecheck 通过。随后复跑 runner 单测为 `22 pass / 0 fail / 108 expect() calls`，包括部分删除后的完整 snapshot 测试。正式图片设置测试中仅按名称定向执行 `IMG-T07a/T10` 相关用例：`3 pass / 0 fail / 22 expect() calls`；该结果只作为产品回归观察，不替代阶段 0危险等待 worker 证据。cleanup helper 退出确认、snapshot 复制完整性和阶段 0真实 seam 仍未全部闭合，因此 A3/阶段 0继续打开。

历史联合日志记录 `33 pass / 0 fail / 290 expect() calls`，但 `completion-05/combined-workers/` 实有 **216 份 worker JSON 和 1 份能力探针**，不能作为单次候选的证据集。两条 `descendant-declared-and-gone` 记录的 `tree-observers-closed.detail` 均为 `"0"`：runner 提供了受管接口，真实 `waitForDescendant` 却仍直接调用 `Bun.spawn`。这不否定历史日志的测试计数，但不能据此确认 F07–F09 已通过。

| 顺序 / 优先级 | 修改位置与做法 | 通过条件（均待验证） |
| --- | --- | --- |
| 1 / P1：快照所有权（F09） | 修改 `isolated-worker-runner.ts` 的 `removeRoot`：在 root 外独占创建本次运行的快照目录。禁止预删固定同名目录；仅删除本次创建且可确认归属的快照。 | 重用显式 root，并在旧快照和同名相邻目录放入标记文件。第二次运行后两者内容及散列不变；复制失败不得进入原 root 删除步骤。 |
| 2 / P1：接管真实观察器（F07/F08） | 修改 `lock-wait-faults.test.ts` 的 `waitForDescendant`：通过 `context.observe` 执行 `tasklist`，取消后不再轮询。runner 分别记录观察命令、PID、退出结果和两条输出流状态。 | 真实后代场景归档前后 `tasklist` 原始输出和真实 `taskkill /T /F` 结果，受管观察器数量大于零。另用明确标注的挂起 helper 验证超时后无新观察、helper 已退出且输出已关闭；未确认必须保留 root。 |
| 3 / P1：限制整个清理阶段（F09） | 从快照开始共享一个 cleanup 截止时间，覆盖复制、删除、并发读取有界 stderr 和成功后移除快照。可能阻塞的文件操作由可终止 helper 执行；另列有限的终止确认预算，不以 Promise 超时充当操作已停止。 | 分别注入快照挂起、删除挂起、stderr 不收尾、快照回收挂起；在两个预算及测试容差内返回失败。记录超时步骤、退出和流状态；若未确认停止，不宣称目录稳定。 |
| 4 / P2：区分原目录与快照（F09） | evidence 分别记录原 root 处置、快照路径和复制是否完成；`retained` 或诊断 JSON 存在不表示原内容完整。 | 用真实 helper 删除 root 中一个标记文件后挂起；确认原文件缺失、完整快照中的文件散列与删除前一致、诊断可读。复制中断的快照不得标为完整。 |
| 5 / P2：隔离每次归档 | 替换 `completion-05/run.ps1` 中复用固定输出目录的做法：后续脚本独占创建运行目录或遇到已存在目录立即失败；分组、联合、退出码、源码散列和证据清单均绑定同一运行标识。 | 连续执行两次不得覆盖或合并旧结果。按清单核对每个场景及故障后的 healthy worker，拒绝缺失、重复或跨运行的记录。保留 `completion-05/` 原样，不从中挑选 JSON 补新包。 |

**放行顺序：** 先完成前四项边界回归及第五项归档隔离，再从 `packages/core` 对同一候选执行 `bun typecheck`、分组和联合测试，逐条复核 F01–F09。仅这些门禁通过才能签认 A3；阶段 0 还需单独完成正式 `IMG-T07a/T10` 与 Core/Server/OpenCode 门禁。故障注入被正确识别不是产品验收通过。

### 历史实施记录（不作为本次放行依据）

继续门禁实施：统一 `finalizeOnce()`、单向 lifecycle 记录、独立 ready/result-exit 预算、完整预算 evidence、stage0 实时协议、严格 fault 字段校验、每个 runner 单测后的真实 healthy 恢复及独立能力探针已加入。本轮 `bun typecheck` 与联合验证通过：`33 pass / 0 fail / 288 expect() calls`。当前证据只取 `completion-04/`；剩余 cleanup 原始内容保留及 tree 观察器资源取消边界见该目录 `review.md`。A3 仍未最终通过，不关闭阶段 0。

本轮补充 runner 独立单测、reader 有界取消与关闭状态、退出确认/后代观察注入、F01-F09 扩展矩阵和每场景 evidence。当前候选 `bun typecheck` 通过；联合验证 `29 pass / 0 fail / 240 expect() calls`。完整本轮结果、逐项覆盖及未闭合门禁见 `specs/evidence/image-settings-lock-wait-a3-2026-11-18/completion-02/review.md`。A3 仍未通过，阶段 0 保持打开；本记录不勾选尚未闭合的通过标准。

### 1.1 目标

将 A3 从“若干故障 fixture 可以被判定为失败”修复为可验收的子进程生命周期门禁：

```text
spawn
→ 注册退出与 stdout/stderr 观察
→ 实时协议校验
→ 阶段 deadline
→ 有界终止
→ 主进程退出确认
→ stdout/stderr 收尾确认
→ 必要后代退出确认
→ 单次目录清理或保留
→ 完整证据归档
```

必须证明：

1. worker 正常完成、业务失败和真实 hang 的分类正确；
2. 协议、输出、启动、提前退出和 result 生命周期故障不会被误报为 timeout；
3. Windows `taskkill /pid <pid> /T /F` 的返回、主进程退出和后代退出均被分别确认；
4. 任一终止或清理失败都会保留 root、原始输出和主/次级错误；
5. POC、fault matrix、stage0 dangerous worker 共用同一安全 runner；
6. 每个故障场景之后都运行健康 worker，证明故障没有污染后续场景。

### 1.2 非目标

本方案不：

- 修改生产锁算法、`EffectFlock.Interface`、默认 Layer 或发布语义；
- 修改正式 `IMG-T07a` / `IMG-T10` 测试；
- 将 timeout 视为产品通过；
- 通过全局进程清理、单删 lockfile 或父进程替 worker 执行业务清理；
- 宣称完成 Core 全包 explicit export map；
- 验证 POSIX、Docker、其他 Bun 版本、GUI/EXE 或崩溃恢复。

## 2. 当前失败根因

当前 A3 的主要问题不是 fixture 数量不足，而是生命周期控制分散且证据模型不完整：

1. `lock-wait-poc.test.ts`、`lock-wait-faults.test.ts` 和 `stage0-lock-worker.test.ts` 各自维护 runner，无法证明同一套收尾逻辑安全；
2. `finally` 中存在重复 terminate、吞掉 termination error 及无界等待 `child.exited` 的路径；
3. `outputDone` 仅表示 Promise settled，不表示 stdout 成功 EOF；stdout/stderr 没有统一收尾模型；
4. POC 输出限制按 JavaScript 字符长度，不是字节长度；reader cancel/release 和错误保留不完整；
5. 协议校验主要在 EOF 后进行，fault harness 通过 mode-specific 字符串判断，不能证明通用实时协议验证；
6. deadline timer 没有取消或代际保护，提前退出可能被旧 timer 改写成 timeout；
7. spawn、终止、退出确认、后代确认和 cleanup 没有统一主错误/次级错误模型；
8. stage0 测试依赖外层 Bun test timeout，没有父级硬 deadline、输出限额、终止和 key/lockfile 双匹配；
9. F08 termination failure、exit confirmation failure 和 F09 cleanup failure 尚未注入并验证错误保留。

## 3. 设计原则

### 3.1 单一 runner，多个 worker

新增测试专用 support 模块，例如：

```text
packages/core/test/support/isolated-worker-runner.ts
```

POC、fault、stage0 测试只提供：

- worker executable/路径；
- 已校验 payload；
- 协议 schema/事件状态机；
- 启动、ready、scenario、termination、output、tree、cleanup budgets；
- 可选测试注入依赖。

测试不得再复制 `spawn`、`Promise.race`、`taskkill`、cleanup 和错误组合逻辑。

### 3.2 状态机优先于 boolean

runner 使用明确生命周期状态，禁止用多个互相独立的 boolean 推导事实：

```text
created
spawned
observing
ready
running
result-seen
failure-classified
termination-started
child-exited
stdout-closed
stderr-closed
descendants-confirmed
cleanup-started
cleanup-finished
retained
```

状态转换必须单向；每次转换记录时间戳和原因。

### 3.3 主错误与次级错误分离

证据结构至少包含：

```ts
type WorkerRunEvidence = {
  readonly root: string
  readonly pid?: number
  readonly events: readonly unknown[]
  readonly rawStdout: string
  readonly rawStderr: string
  readonly exit?: {
    readonly exitCode: number | null
    readonly signal: string | "unavailable"
  }
  readonly readyAt?: number
  readonly deadlineAt?: number
  readonly timeoutStage?: "startup" | "scenario" | "termination" | "output" | "tree" | "cleanup"
  readonly terminationStartedAt?: number
  readonly termination?: {
    readonly command: string
    readonly exitCode?: number
    readonly stdout: string
    readonly stderr: string
  }
  readonly errors: {
    readonly primary?: string
    readonly protocol?: string
    readonly output?: string
    readonly termination?: string
    readonly exitConfirmation?: string
    readonly descendant?: string
    readonly cleanup?: string
  }
  readonly cleanupStatus: "removed" | "retained" | "not-attempted"
}
```

不能用 cleanup error 覆盖 primary error，也不能将终止失败吞掉。

### 3.4 运行时能力与测试注入边界

方案实现前必须先用最小探针确认当前 Bun 版本实际提供的能力，不能从 `Bun.Subprocess` 类型或其他运行时经验推断：

- `child.exited` 的返回值以及 `child.exitCode` 的可观察时机；
- 是否存在可靠的 signal 信息；若 Windows/Bun 无法提供，统一记录 `"unavailable"`；
- stdout/stderr `ReadableStream` 在主进程及后代退出后的 EOF 行为；
- `taskkill` 子进程自身的 stdout/stderr、exit code 和超时行为。

F08/F09 的注入不能通过在断言中硬编码失败实现。runner 必须把以下边界作为显式测试依赖传入：

```ts
type RunnerDependencies = {
  readonly spawn: typeof Bun.spawn
  readonly runTaskkill: (pid: number) => Promise<TerminationEvidence>
  readonly processExists: (pid: number) => Promise<boolean>
  readonly removeRoot: (root: string) => Promise<void>
  readonly now: () => number
}
```

生产/真实 Windows 门禁使用默认实现；F08/F09 注入只替换测试依赖并保留相同状态机。注入边界必须记录注入名称，不得伪装成真实 `taskkill` 或真实文件系统证据。

### 3.5 预期失败与 runner 失败分离

每次运行必须同时声明：

```text
expectedOutcome = success | business-failure | protocol-failure | timeout-failure
```

测试 fixture 的“预期失败”不能直接作为 runner 错误。runner 需要报告结构化 `classification`，测试再断言：

- normal：`success`；
- POC failure：`business-failure`，且 result/exit code 一致；
- hang：`timeout-failure`，但不是产品通过；
- F01-F09：对应的基础设施/协议/生命周期失败分类；
- 终止或 cleanup 注入：分类中必须同时保留主错误和次级错误。

否则单一 `failed: boolean` 仍会掩盖错误分类。

## 4. Runner 实施方案

### 4.1 spawn 与观察注册

顺序必须固定：

1. 创建 root 并记录路径；
2. 构造并校验 payload；
3. 在 `try` 内执行 spawn；
4. spawn 后立即创建并保存：
   - `child.exited` 观察；
   - stdout reader；
   - stderr reader；
   - 状态转换记录；
5. 任一 spawn/reader 注册失败进入统一收尾。

spawn 失败时：

- 分类为 `startup`；
- 不伪造 `started`、`holding` 或 `result`；
- 如果 root 已创建，按“未启动、无子进程”规则进行一次 cleanup；
- cleanup 失败时保留 root 并记录 cleanup error。

### 4.2 可取消阶段预算

使用统一 deadline helper，不直接散落 `Bun.sleep(...).then(...)`：

```text
startup budget
ready budget
scenario budget
termination budget
output-drain budget
descendant budget
cleanup budget
```

每个预算：

- 只允许一个 active timer；
- 成功、提前失败或进入下一阶段时取消；
- timer 触发后记录 `timeoutStage` 和 `deadlineAt`；
- 不允许旧 timer 修改后续状态；
- 外层 Bun test timeout 必须大于所有 runner 阶段预算总和。

分类规则：

- ready 前退出：`early-exit` 或 `startup-protocol`，不是 scenario timeout；
- ready 后提前退出：`early-exit-after-ready`，不是 timeout；
- ready 后场景 deadline 先触发：`scenario-timeout`；
- terminate 未完成：`termination-timeout`；
- 输出未收尾：`output-timeout`；
- 后代未退出：`tree-timeout`；
- cleanup 失败：`cleanup-failure`。

### 4.3 字节受限 reader

统一实现 stdout/stderr reader：

- 按 `Uint8Array.byteLength` 累计，不按字符串长度；
- 保留原始字节前缀和 UTF-8 解码文本；
- 限制总字节数及单行未完成长度；
- 超限后立即记录 output error；
- 调用 `reader.cancel()` 并在有界预算内等待 reader 收尾；
- 无论解析成功或失败，都消费并保存 Promise rejection；
- `stdoutClosed` / `stderrClosed` 只有在真实 EOF 或有记录的 reader failure 后才能设置。

“reader failure 已记录”不等于管道已关闭。若 reader failure 后无法在有界预算内确认流已结束，必须保留 root；只有明确的、已确认的 bounded reader termination 才能参与 cleanup 条件。输出收尾证据必须区分 `eof`、`cancelled-and-closed` 和 `failed-open`。

输出不能用：

```ts
outputDone = true
```

来表示成功收尾。

### 4.4 实时协议状态机

每个 stdout 行到达时立即：

1. 保存原始行；
2. 解码 JSON；
3. 校验 payload 类型；
4. 校验 scenario；
5. 校验事件名、允许字段和字段类型；
6. 校验事件顺序、唯一性和终态；
7. 更新 ready、result、deadline 状态；
8. 协议错误立即进入安全终止，而不是等 EOF。

POC 协议最少定义：

```text
normal:  started → holding → released → result(ok=true)
failure: started → holding → result(ok=false) → exit(non-zero)
hang:    started → holding → scenario deadline → terminate
```

fault 协议必须由通用状态机判断，不得再使用：

```ts
isValidFaultOutput(output, mode)
```

之类按 mode 硬编码的字符串规则。

必须拒绝：

- 非法 JSON；
- 未知 scenario；
- 未知 event；
- 缺失/错误字段；
- 重复 started/holding/result；
- 乱序事件；
- result 后继续业务事件；
- exit-without-result；
- result 与 exitCode 不一致。

### 4.5 单次终止与退出确认

新增单次 `terminateOnce()`，状态机保证最多调用一次。

Windows：

1. 记录 `terminationStartedAt`；
2. 执行：
   ```text
   taskkill /pid <pid> /T /F
   ```
3. 捕获 taskkill exit code、stdout、stderr；
4. 在 termination budget 内等待 `child.exited`；
5. 单独检查后代 PID；
6. taskkill 非零、超时、主进程仍在或后代仍在，均为失败；
7. 未确认完整退出时禁止 cleanup。

只有在明确记录“主进程已退出且无须再终止”时，才可跳过 taskkill。不能因为 `child.exitCode` 暂时非 null 就推断进程树已经退出。

进程树确认必须区分：

```text
no-descendant-declared
descendant-declared-and-gone
descendant-declared-but-alive
tree-observation-failed
```

没有收到 worker 的 `descendant-ready` 时，不得把 PID 文件缺失简单解释为“后代已退出”；应记录为“未声明后代”或 worker/protocol failure。收到 `descendant-ready` 后则必须确认对应 PID 退出。

POSIX 仅作为未来补充；本轮 Windows 证据必须使用真实 `taskkill /T /F`。

### 4.6 单次收尾器

所有正常、业务失败、协议失败、timeout 和 runner 异常均进入同一个 `finalizeOnce()`：

```text
1. 停止/取消 active timers
2. 如果需要，执行 terminateOnce
3. 有界确认 child.exited
4. 有界确认 stdout/stderr 收尾
5. 有界确认后代退出
6. 根据全部确认结果决定 cleanup 或 retain
7. 生成 evidence
8. 返回或抛出包含主错误及次级错误的结果
```

禁止在 `catch` 和 `finally` 分别实现一套 cleanup/terminate。

禁止：

```ts
await terminate(child).catch(() => undefined)
await child.exited.catch(() => undefined)
```

### 4.7 cleanup 规则

只有同时满足以下条件才删除 root：

```text
worker exited
+ stdout closed or bounded reader failure recorded
+ stderr closed or bounded reader failure recorded
+ required descendants exited
+ no unresolved termination confirmation
```

cleanup 最多执行一次。

如果 cleanup 失败：

- 设置 `cleanupStatus = retained`；
- 保存 root 路径；
- 保存 cleanup error；
- 保留原始 stdout/stderr、事件和主错误；
- 测试必须失败。

正常路径不应依赖 finally 再次尝试 cleanup。

失败场景的“保留 root”必须有明确的证据生命周期：

1. 将 root 路径、PID、事件、stdout/stderr 和 evidence 元数据写入当前 A3 证据目录；
2. 测试断言 root 仍存在且包含可读取诊断；
3. 不在同一测试的 `afterEach`、隔离脚本或全局清理中删除该 root；
4. 由单独、显式的证据清理命令在审查完成后删除，不得把保留目录伪装成无残留。

正常完成和已确认完整收尾的预期失败可以清理；F08/F09 以及任何退出/输出/后代未确认场景不得自动清理。

## 5. 故障矩阵与测试设计

### F01：payload / spawn

注入：

- 缺少 payload；
- 非法 base64/JSON；
- 缺少 root/key；
- 不存在 worker 路径；
- spawn 注入失败。

断言：

- 分类为 startup/protocol；
- 不伪造 ready/result；
- root 处置可追踪；
- 健康 worker 随后通过。

### F02：未 ready 退出

注入：

- 只发送 started 后 exit；
- 启动后立即非零退出；
- started 后持续不发送 holding。

断言：

- 提前退出与 startup timeout 区分；
- 不进入 scenario timeout；
- 不调用不必要的 terminate；
- exit、stdout/stderr、cleanup 状态完整。

### F03：holding 后提前退出

注入：

```text
started → holding → exit(non-zero)
```

断言：

- 分类为 ready 后 early exit；
- 不被旧 timer 改写为 timeout；
- 不伪造 result；
- 主错误和退出码保留。

### F04：协议错误

分别注入：

- 非法 JSON；
- scenario 不符；
- 未知 event；
- 缺字段/错误类型；
- 重复 started/holding；
- 乱序事件；
- 重复 result。

断言：

- 读取到错误行时立即失败；
- 进入有界终止；
- 保存错误行、原始输出和终止证据；
- 不等待 EOF 才分类。

### F05：result 生命周期

分别注入：

- result 后继续存活；
- exit 无 result；
- result 与 exitCode 不一致；
- result 后输出额外事件。

断言：

- result-after-alive 不是普通场景 timeout；
- exit-without-result 是协议失败；
- 不以 result 或 exitCode 单独判成功。

### F06：输出

分别注入：

- stdout 超过字节上限；
- stderr 超过字节上限；
- 超长未完成行；
- stdout/stderr 不结束；
- reader 主动失败。

断言：

- 有界失败；
- reader rejection 被消费并归档；
- 不依赖外层 Bun test timeout；
- cleanup 只在输出收尾确认后执行。

### F07：真实后代

worker 必须：

1. 发出明确 descendant-started 事件；
2. 写入可追踪 descendant PID；
3. 发出 descendant-ready；
4. 持续存活；
5. 等待父 runner 终止。

断言：

- 主 worker 与后代均被发现；
- `taskkill /T /F` 结果有原始证据；
- 主进程退出不是充分条件；
- 所有后代退出后才允许 cleanup；
- 记录 tasklist 原始输出和确认时间。

`descendant-ready` 必须是协议事件，且必须在 PID 文件写入成功、后代仍存活检查成功后发送。父 runner 不得仅凭 `descendant.pid` 文件存在推断 ready。

### F08：终止/退出确认失败

真实验证：

- Windows taskkill 有界等待；
- 真实后代树；
- 主进程/后代退出确认。

注入验证：

- taskkill 返回非零；
- taskkill 不退出；
- child.exited 确认 timeout；
- descendant 检查 timeout。

断言：

- root 保留；
- primary/termination/exit-confirmation/descendant errors 同时保留；
- 不执行 cleanup；
- 健康 worker 不受污染。

### F09：cleanup 失败

通过测试专用 cleanup dependency 注入 `fs.rm` 失败。

断言：

- cleanupStatus 为 retained；
- root 路径和 cleanup error 保留；
- 原始主错误不被覆盖；
- 测试失败；
- 运行后健康 worker 仍可执行。

F09 的 cleanup 注入必须发生在 runner 的 `removeRoot` 依赖边界，而不是修改 fixture 或在断言后手动抛错。测试必须验证 root 保留，并验证 primary/protocol/termination 错误仍可从最终 evidence 读取。

## 6. stage0 dangerous worker 接入

`stage0-lock-worker.test.ts` 必须改为调用统一 runner。

runner payload 只包含：

```ts
{ scenario: "t07a" | "t10", root: string }
```

父进程不：

- 获取/释放锁；
- 删除 lockfile；
- 替 worker 确认业务成功；
- 依赖外层测试 timeout。

### T07a 事件与断言

```text
holding
→ wait(expected canonical key, expected lockfile)
→ interrupt-requested
→ saving-terminated
→ holder-released
→ result(ok=true)
```

`wait` 必须同时满足：

```text
event.key === ConfigDocument.key(expected file)
event.lockfile === expected state/locks/<hash>.lock
```

只有确认 `saving-terminated` 后 worker 才能释放 holder。

### T10 事件与断言

```text
holding
→ wait(expected canonical key, expected lockfile)
→ higher-created
→ holder-released
→ result(ok=true)
```

释放 holder 后必须观察 saving 的冲突/失败结论，不能只检查 result 存在。

## 7. 实施顺序

### 阶段 A：抽取 runner

1. 定义 evidence、error aggregation 和 lifecycle state；
2. 实现 byte-limited stdout/stderr readers；
3. 实现可取消 phase deadline；
4. 实现实时 protocol validator；
5. 实现 `terminateOnce`；
6. 实现 `finalizeOnce`；
7. 单元测试 runner 自身的正常、提前退出和异常路径。

### 阶段 B：迁移 POC

1. 将 `lock-wait-poc.test.ts` 改为统一 runner；
2. 保留 normal/failure/hang；
3. 验证 ready/exit 竞争；
4. 验证 timeout 不是产品 pass；
5. 归档完整 evidence。

### 阶段 C：迁移 fault matrix

1. 重写 fault worker，使其发出明确协议事件；
2. 删除 `isValidFaultOutput` mode-specific 判断；
3. 实现 F01-F09；
4. 每个故障后运行 healthy worker；
5. 注入 F08/F09 并确认 root 保留。

### 阶段 D：迁移 stage0

1. stage0 父测试改用统一 runner；
2. 加入 hard deadline、终止和输出限制；
3. 实现 key/lockfile 双匹配；
4. 验证 T07a/T10 事件顺序；
5. 不修改正式 IMG 测试。

### 阶段 E：联合门禁与归档

按同一代码状态执行：

1. `bun typecheck`；
2. runner 单测；
3. POC 定向测试；
4. F01-F09 故障测试；
5. stage0 dangerous worker 定向测试；
6. A3 联合测试；
7. 每次故障后的 healthy worker；
8. 保存 stdout/stderr、事件、退出状态、终止结果、cleanup 状态、root 路径和 SHA-256。

每次运行还必须保存：

- 当前候选 commit/工作树摘要；
- runner 配置和各阶段预算；
- `classification` 与 `expectedOutcome`；
- 是否使用 F08/F09 注入及注入名称；
- `taskkill` 原始 stdout/stderr/exit code（真实 Windows 场景）；
- 后代状态分类和 tasklist 原始输出。

## 8. A3 通过标准

只有以下全部满足才可将 A3 标记为 pass：

- [ ] POC、fault、stage0 共用统一安全 runner；
- [ ] F01-F09 全部有真实或明确测试注入覆盖；
- [ ] 所有协议错误实时发现并有界终止；
- [ ] 所有阶段 deadline 可取消且分类不串线；
- [ ] stdout/stderr 按字节限额并有界收尾；
- [ ] Windows 真实后代树终止证据已归档；
- [ ] taskkill/退出确认失败保留 root 和所有错误；
- [ ] cleanup 失败保留 root、主错误和 cleanup error；
- [ ] cleanup 最多执行一次；
- [ ] 每个故障后 healthy worker 通过；
- [ ] stage0 T07a/T10 使用 hard deadline 和双匹配；
- [ ] 当前代码状态下 typecheck、定向测试、联合测试和证据 hash 一致；
- [ ] 无未处理 Promise rejection、无无界 finally 等待、无全局进程清理伪造证据。

A3 通过前：

- 不修改正式 IMG-T07a/T10；
- 不关闭阶段 0；
- 不把 timeout、启动失败、协议失败或取消行为失败记为产品 pass。



## completion-11 执行增量（未签认）

本轮已实施删除 helper 的并发有界 stderr、退出/输出确认检查、快照复制完成标记及 tree observer 取消收尾检查；新增三条定向测试。当前候选 Core typecheck 退出 0，七文件同一次隔离联合运行 `38 pass / 0 fail / 320 expect() calls`。原始日志、源码散列、红测限制及剩余缺口见 [completion-11 复核](evidence/image-settings-lock-wait-a3-2026-11-18/completion-11-final/review.md)。完整预算、目录处置、observer PID/管道证据、归档原子隔离及产品门禁仍未完成；A3 与阶段 0保持打开，任务不得整体勾选完成。


## completion-14 增量（保持打开）

cleanup 四阶段受管 helper、阶段状态证据、observer PID/输出和原子归档负例已补充。最新同候选七文件联合 `44 pass / 0 fail / 385 expect()`，正式 IMG `3 pass / 0 fail / 22 expect()`；三包类型检查通过，Server 全量 `37 pass / 0 fail`。Core/OpenCode 全量被外层期限中断；Core tree kill 还出现非零退出，不能关闭。详见 [completion-14 复核](evidence/image-settings-lock-wait-a3-2026-11-18/completion-14-review.md)。observer 父侧握手、真实部分复制/回收中断及端到端预算仍有缺口。


## completion-15 增量（未签认）

真实部分复制/回收中断及 observer ready 后退出前 PID 可见性检查已补。最新同候选联合 46 pass / 0 fail / 408 expect()，正式 IMG 3 pass / 0 fail；三包类型检查与 Server 全量通过。Core 全量自然结束：1853 pass / 8 skip / 9 fail；OpenCode 在 15 分钟外层期限中断。manifest 审计通过，但端到端预算与握手后故障计时仍未完整。详见 [completion-15 复核](evidence/image-settings-lock-wait-a3-2026-11-18/completion-15-review.md)。A3 / 阶段 0保持打开。
