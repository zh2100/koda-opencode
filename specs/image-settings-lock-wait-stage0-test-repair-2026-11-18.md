# 阶段 0：隔离 worker 测试与修复执行单

当前状态（2026-11-20）：阶段 0 已通过；本执行单保留作为阶段 0 的测试设计和历史基线。放行证据与阶段 1 准入条件见[修复实施总方案](image-settings-lock-wait-stage0-remediation-plan-2026-11-18.md)。

原定目标是在 Windows / Bun 1.4.3 上证明：故障发生后，runner 要么确认资源已关闭，要么有界返回失败、停止破坏性操作，并准确报告哪些状态未知。不是排查或修改生产锁算法。

## 一、基线与范围

- `completion-08-final/workers/opencode-lock-fault-Jo3UNd.json` 是真实树终止的正对照：后代 PID 22948 从 `tasklist` 可见变为不可见，`taskkill /pid 17740 /T /F` 返回 0。不要用注入的退出码 7 替代它。两个 stage0 worker 也已有成功事件序列及 key/lockfile 双匹配测试，不重写它们。
- `completion-08-final` 的联合结果早于 runner 和 runner 测试的后续变更；后来分别通过的 22 个 runner 测试和 3 个 IMG 用例不是一次联合验收。`completion-05` 混跑，`completion-06-final` 缺少 worker JSON；均保留原样，不补写成单次证据。
- 修改范围限于 `packages/core/test/support/isolated-worker-runner.ts`、相应的 `test/util`、必要的 `test/fixture`、测试归档脚本及实施记录。正式 IMG 用例仅执行，不改写；不改 A2 facade、生产锁，不构建 GUI/EXE。

## 二、按故障逐项执行

每行按同一流程执行：**先加测试 → 记录修复前的结果 → 只修对应路径 → 原测试复跑 → 跑一个真实健康 worker**。用独占临时 root、marker 或握手事件证明到达目标分支；只有超时文字不算命中。若基线已绿且分支确实命中，作为已有覆盖保留，不为制造红测而改实现。若外层 watchdog 先到、helper 遗留或清理归属不明，记为基础设施失败，停止该轮。故障 fixture 要有独立的有界兜底，只回收本测试拥有的进程，不用全局清理。

| 顺序 | 故障如何触发 | 最小修补方向 | 通过条件 |
| --- | --- | --- | --- |
| 1 · F09 删除 helper 的 stderr 不结束 | 先确认复制已完成且进入删除分支。让退出观察已完成、stderr 仍未 EOF；必要时以测试依赖独立控制退出与 reader，并标注注入。另测非零退出带诊断。 | `removeRoot` 中原 root 删除与复制/回收共用 helper 收尾逻辑。从启动起并发、有字节上限地读 stderr。 | 不等待无界 `Response.text()`；能区分退出、EOF、取消成功和未确认。保留有界诊断及原始错误；超时不报成功。 |
| 2 · F09 截止时间与退出确认 | 在快照创建、复制、删除、回收边界分别耗尽预算；注入 kill 后退出观察仍不完成。 | 一条工作截止时间覆盖所有步骤，过期不启动下一步。另设一次有限收尾预算供 kill、退出与 reader 确认共享；不能只等 `allSettled` 而忽略结果。 | 记录超时步骤、kill 尝试、退出和输出结果；总返回时间不超过工作预算＋收尾预算＋预先声明的调度容差。未确认时不继续删除，不声称目录已稳定。外层测试预算只作保险。 |
| 3 · F09 目录完整性 | 分别制造复制中断、真实删除一个 marker 后挂起、root 已删除后回收快照中断；另设带 marker 的旧快照。 | 分别记录原 root 的处置、快照复制完成状态和回收状态；不要用路径存在或重建空目录表示已恢复。 | 复制中断时不启动 root 删除；部分删除时核对快照 marker 与删除前 SHA-256；回收中断时不误报旧 root 尚在或剩余快照完整；旧快照散列不变。 |
| 4 · F07/F08 真实 observer 挂起 | `context.observe()` 启动真实 Bun helper，记录 PID 和就绪 marker，保持两条管道打开，等待 tree deadline。与“不启动 helper 的回调超时”分开。 | runner 逐个检查 observer 的退出及两路 reader 结果，取消后拒绝新的观察；如有失败，保留各项错误。 | 记录 abort、kill、退出确认及 stdout/stderr 最终状态，独立核对该 PID 已消失；结果为 tree 故障、root 保留。负对照中退出或 reader 未确认不得记为成功关闭。 |
| 5 · 归档隔离 | 以同一 run ID 重入，再以新 ID 运行；用缺失或重复的 worker 清单作为审计负例。 | 原子独占创建目录；每次命令有独立子目录与 `A3_EVIDENCE_DIR`；按 run ID、命令和场景关联故障及恢复记录。 | 重入失败且旧文件散列不变；不同运行不混合；缺项、重复、源码漂移均使审计非零退出。 |

## 三、冻结候选与签认

在 `D:\opencode\packages\core` 执行。每轮保留命令、环境版本、源码散列、退出码与完整日志。单例调试示例（过滤词按新增用例名替换）：

```powershell
node D:/opencode/script/test-isolated.mjs test test/util/isolated-worker-runner.test.ts --test-name-pattern "partial root deletion" --timeout 120000
```

1. 五项通过后冻结候选。对 runner、fixtures、各门禁测试、隔离与归档脚本记录 SHA-256；同时记录 HEAD 和工作树摘要。此后哪怕只改测试超时，也另建候选重跑。
2. 执行 `bun typecheck`。再通过上述隔离入口分组运行 runner/capability、POC、fault matrix、A2/stage0；随后把下列七个文件放入**同一次**调用。实际退出码、断言和 worker 记录决定结果，不预设通过数。

```powershell
$a3 = @(
  'test/util/isolated-worker-runner.test.ts', 'test/util/isolated-worker-capabilities.test.ts',
  'test/util/lock-wait-poc.test.ts', 'test/util/lock-wait-faults.test.ts',
  'test/util/effect-flock-test-layer.test.ts', 'test/util/effect-flock-resolution.test.ts',
  'test/util/stage0-lock-worker.test.ts'
)
node D:/opencode/script/test-isolated.mjs test @a3 --timeout 120000
```

3. 逐项核对 F01–F09、故障后健康恢复、真实 PID 的前后查询和 taskkill 原始输出，以及 retained 目录的实际处置。上述项全通过才签 A3。随后另起归档子目录，以相同候选联合运行 `@a3` 和 `test/image-generation-settings.test.ts`。IMG 通过不能抵消 runner 失败；stage0 worker 通过也不能替代产品断言。
4. 独立记录完整 Core、Server、OpenCode 产品门禁，不把它们的结果拼入 A3。按两份实施文档分别列出 A3、阶段 0 及产品验收状态；任何强制项未完成就保持对应状态打开。最后生成并校验包含复核记录在内的证据清单，保留红测和失败目录的诊断。


## completion-11 执行增量（未签认）

本轮已实施删除 helper 的并发有界 stderr、退出/输出确认检查、快照复制完成标记及 tree observer 取消收尾检查；新增三条定向测试。当前候选 Core typecheck 退出 0，七文件同一次隔离联合运行 `38 pass / 0 fail / 320 expect() calls`。原始日志、源码散列、红测限制及剩余缺口见 [completion-11 复核](evidence/image-settings-lock-wait-a3-2026-11-18/completion-11-final/review.md)。完整预算、目录处置、observer PID/管道证据、归档原子隔离及产品门禁仍未完成；A3 与阶段 0保持打开，任务不得整体勾选完成。


## completion-14 增量（保持打开）

cleanup 四阶段受管 helper、阶段状态证据、observer PID/输出和原子归档负例已补充。最新同候选七文件联合 `44 pass / 0 fail / 385 expect()`，正式 IMG `3 pass / 0 fail / 22 expect()`；三包类型检查通过，Server 全量 `37 pass / 0 fail`。Core/OpenCode 全量被外层期限中断；Core tree kill 还出现非零退出，不能关闭。详见 [completion-14 复核](evidence/image-settings-lock-wait-a3-2026-11-18/completion-14-review.md)。observer 父侧握手、真实部分复制/回收中断及端到端预算仍有缺口。


## completion-15 增量（未签认）

真实部分复制/回收中断及 observer ready 后退出前 PID 可见性检查已补。最新同候选联合 46 pass / 0 fail / 408 expect()，正式 IMG 3 pass / 0 fail；三包类型检查与 Server 全量通过。Core 全量自然结束：1853 pass / 8 skip / 9 fail；OpenCode 在 15 分钟外层期限中断。manifest 审计通过，但端到端预算与握手后故障计时仍未完整。详见 [completion-15 复核](evidence/image-settings-lock-wait-a3-2026-11-18/completion-15-review.md)。A3 / 阶段 0保持打开。
