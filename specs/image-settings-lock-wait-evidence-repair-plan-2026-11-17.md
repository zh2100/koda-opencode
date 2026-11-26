# 图片设置锁等待证据补强方案

日期：2026-11-17

实施状态（复核更新）：采用 A1（真实 Layer seam）+ A2（局部 facade/精确 export）+ A3（child process 硬隔离）。A1 已有基础验证；A2 局部检查通过但完整 import/resolution 审计未关闭；A3 已验证 normal、business failure、ready/退出竞争、协议/输出故障、后代进程和阶段 0 危险等待 worker，但终止/清理失败注入、完整证据模型及完整 import/resolution 审计仍未完成。阶段 0 未通过，禁止开始正式 IMG-T07a/T10 改造。当前证据归档于 `specs/evidence/image-settings-lock-wait-stage0-2026-11-18/` 和 `specs/evidence/image-settings-lock-stage0-audit-2026-11-18/`。剩余工作、故障矩阵与准入条件见 [阶段 0 修订计划第 9 节](./image-settings-lock-wait-stage0-remediation-plan-2026-11-18.md#9-剩余工作执行计划（复核更新）) 和第 8 节。历史测试通过不等于阶段验收；Core 全包 explicit export map 仍是独立后续任务。

## 1. 目标与范围

本方案只补强两项测试证据：

- `IMG-T07a`：保存操作在持有真实文档锁的情况下，确实已经进入锁等待后再取消；
- `IMG-T10`：高优先级配置文件确实是在保存操作等待真实文档锁期间创建，并在释放锁后触发冲突。

本轮不预设生产代码存在缺陷，也不修改 BOM 修复、发布协议、错误分类、公开 `EffectFlock.Interface` 或默认锁行为。为建立可靠观察点，允许增加默认关闭、仅供测试注入的内部 seam；该 seam 不得改变默认运行时路径。只有强化后的测试暴露实际行为错误时，才追加最小生产修复。

## 2. 当前问题

当前两个测试通过 `ConfigDocument.withLock` 的 spy 发出同步信号：

```ts
Effect.andThen(Deferred.succeed(waiting, undefined), original(flock, target, body))
```

该信号发生在调用原始 `withLock` 之前。随后测试通过 `probe()` 观察到锁为 `busy`，但这只能证明另一主体持有锁，不能严格证明保存 fiber 已经执行到 `EffectFlock.acquire()` 的等待分支。

因此，当前测试可以证明取消后的结果安全，但不能把“已进入真实锁等待”作为强结论。

## 3. 设计原则

1. **不以时间延迟作为同步手段**：不使用 `sleep`、固定轮询次数或“希望调度已经发生”的窗口。
2. **观察真实锁获取尝试**：同步点必须来自锁实现实际执行的文件系统获取/重试边界。
3. **不放宽产品断言**：继续验证零发布、原字节不变、租约释放、无阶段文件和正确错误分类。
4. **测试故障与产品故障分离**：若无法建立可靠的内部观察点，宁可保留边界声明，不增加侵入式生产日志或公开 API。
5. **取消发生在等待确认之后**：确认等待后才执行 `Fiber.interrupt` 或创建高优先级文件。

## 4. 推荐实现：增加测试专用的锁等待路径观察点

当前生产代码已经增加仅供内部测试使用的 `layerWith({ onWait })` seam；它不属于公共 `EffectFlock.Interface`，也不通过公共 package facade 暴露。后续测试仍必须验证该 seam 的真实生产 Layer、异常隔离和默认 Layer 不触发 observer 行为。

推荐固定采用方案 A；方案 B 仅作为阶段 0 失败后的降级路径，不作为并行设计目标：

1. 在 `effect-flock.ts` 增加不改变公开 `EffectFlock.Interface` 的内部 `layerWith(options)`，默认 `layer` 继续使用无 hook 配置；测试专用模块 `packages/core/test/support/effect-flock-test-layer.ts` 只包装该真实 Layer，构造带完整依赖声明的测试节点；
2. 图片设置测试仍以原始 `EffectFlock.node` 作为依赖图节点，并通过 replacement 注入测试专用节点，不得只把测试节点额外加入 group：
   ```ts
   AppNodeBuilder.build(
     LayerNode.group([ImageGenerationSettings.node, EffectFlock.node]),
     [
       [EffectFlock.node, createEffectFlockTestNode({ onWait })],
       [Global.node, Global.layerWith(...)],
     ],
   )
   ```
3. 在正式修改 IMG-T07a/T10 前，先完成“阶段 0：验证 Layer replacement”，确认 replacement 与原节点具有相同 service identity、tag 和兼容依赖，并确认 `ImageGenerationSettings.Service` 与直接获取的 `EffectFlock.Service` 使用同一实例；
4. 如果阶段 0 证明方案 A 的 Layer replacement 无法安全保留既有依赖，才转用方案 B：在测试中包装真实 `FSUtil.Service`，仅拦截目标 lockfile 的 `stat` 边界；
5. 如果方案 B 也无法精确证明目标 busy 边界，则不增加伪同步，保留现有测试并降低验收措辞。

本方案固定选择方案 A。允许修改 `effect-flock.ts` 增加包内 **internal test seam** `layerWith(options)`，但不得把 `onWait` 加入公开 `EffectFlock.Interface`。由于测试专用模块需要访问该真实 Layer，`layerWith` 可以作为包内源码导出入口，但必须满足：不从 SDK、公共 barrel 或运行时配置导出；不暴露完整锁控制能力；仅接受测试观察配置；默认 `EffectFlock.layer`/`EffectFlock.node` 继续指向无 hook 的默认 Layer；并增加 API surface 检查确认该导出未进入对外包入口。测试专用工厂必须返回与 `EffectFlock.node` 相同 service identity 和 global tag 的 `GlobalNode<Service>`，并声明与默认节点兼容的 `Global.node`、`FSUtil.node` 依赖；测试模块只包装真实 Layer，不复制锁实现。方案 B 不修改生产锁实现。两种方案都必须保持默认 `layer`/`node` 行为不变，生产默认调用路径不得产生额外事件。

### 4.1 阶段 0：验证 Layer replacement

在修改 IMG-T07a/T10 测试前，仅完成最小构造和编译验证：

1. 从测试专用模块构造 `createEffectFlockTestNode({ onWait })`，声明完整的 `Global.node` 和 `FSUtil.node` 依赖；
2. 使用原始 `EffectFlock.node` 作为 replacement source：
   ```ts
   AppNodeBuilder.build(
     LayerNode.group([ImageGenerationSettings.node, EffectFlock.node]),
     [[EffectFlock.node, createEffectFlockTestNode({ onWait })]],
   )
   ```
3. 验证 replacement 与原节点的 service identity、tag 和依赖兼容；
4. 验证 `ImageGenerationSettings.Service` 与直接获取的 `EffectFlock.Service` 使用同一测试实例；
5. 验证不带 hook 的默认 `EffectFlock.layer`/`EffectFlock.node` 类型和行为不变。

该阶段必须先通过最小 `bun typecheck` 或等价包内类型检查，再进入正式测试修改，并检查 `layerWith` 未进入 SDK、公共 barrel 或运行时配置导出。若方案 A 的 replacement、依赖或 API surface 验证失败，才转用方案 B，不继续假设测试节点可以安全替换原节点。方案 B 只在能够精确观察目标 lockfile busy 边界时升级验收结论；否则保持降级措辞。

### 4.2 Docker 阶段前置检查

Docker 只用于独立的 Linux/POSIX 补充验证，不是当前 Windows 锁等待证据的必要条件。进入 Docker 阶段前必须：

1. 确认 Docker daemon 可用，并记录 Docker Server 版本；
2. 确认可用的 Linux Bun 镜像，或记录确定的镜像构建方式；
3. 在容器内输出 Bun、Node、Linux、UID/GID 和文件系统信息；
4. 将仓库复制到容器内部路径，POSIX 权限测试不得依赖 Windows bind mount；
5. 先运行无副作用的版本检查或包级 typecheck；
6. 前置检查失败时，将 Docker 阶段标记为未验证，不影响 Windows 门禁。

Docker 阶段的结果必须单独归档，不并入 Windows 的 pass/skip 统计，也不作为本方案 Windows 完成条件。

### 4.3 观察点位置

优先在 `EffectFlock` 的内部 Layer 工厂中增加一个仅测试使用的可选观察回调，位置应在目录锁获取逻辑中：

- 仅在 `waitWhileHeld` 对目标 `lockfile` 完成 `stat`、确认当前 owner 仍活动，并准备进入 `NotAcquired` 重试之前。

该观察点必须满足：

- 已解析出与目标文档对应的真实 `lockfile`；
- 已确认该锁目录存在且当前 owner 仍活动、不是本 fiber 持有；
- `diagnosis.reason` 必须是 `live-owner`；`remote-owner`、`permission-denied`、`metadata-missing`、`metadata-corrupt`、`breaker-held` 或其他状态不得计入本轮“当前 owner 仍活动”的等待证据；
- 即将进入锁等待重试路径，而不是仅进入 `withLock` 调用边界；
- 只在测试层注入，不改变默认运行时行为。

建议形态是测试专用配置中的可选同步 `onWait` 回调，默认值为 `undefined`，生产路径不产生额外效果。事件结构固定为：

```ts
type WaitObservation = {
  readonly key: string
  readonly lockfile: string
}
```

事件只报告目标 lockfile 已进入等待重试路径，不报告 owner 的 PID、hostname 或 metadata。回调可以因多次重试被多次调用，测试只消费目标 `key` 与 `lockfile` 同时匹配的第一次事件。

回调必须满足以下约束：

- 非阻塞、同步返回；
- 不等待 `Deferred`，不执行文件操作、断言或释放 holder；
- 不创建 scope，不持有锁；
- 测试回调不得抛异常；如果实现层允许回调异常传播，则必须在 seam 内捕获，使其不能改变锁获取结果或错误分类。

如果使用 `FSUtil.Service` 包装作为降级方案，必须保留真实服务的全部方法，只在目标 lockfile 的 `stat` 检查处发出通知；不得用只包含 `stat` 的不完整 service 替代真实文件系统。

### 4.4 观察点语义与取消可中断性

观察点的结论必须限定为：**已执行真实 lockfile busy 检查，并进入锁等待重试路径，准备再次尝试获取锁**。它不要求证明某一次具体 backoff 已经完成，也不能表述为“已完成 sleep”。

观察回调本身必须是非阻塞的同步通知，不能等待测试方的 `Deferred`，否则会改变锁等待行为。测试方收到通知后再取消保存 fiber或创建竞争文件。

如果采用 Effect 回调，必须确认该通知不持有锁、不创建额外 scope，也不吞掉原始锁错误。

测试等待观察通知必须有有限超时。实施前先确认当前 Effect 版本实际可用的 timeout API，并显式处理超时结果；当前仓库已有 `Effect.timeout(...)` 用法，但不得未经编译确认直接假定其他 timeout API 可用。不得使用固定 `sleep`、固定轮询次数或无限等待。

### 4.5 失败清理

必须分别处理两条正常路径：

- T07a：匹配真实 wait → 发出取消 → 有限等待并确认 saving 终止 → 释放 holder → 产品断言。
- T10：匹配真实 wait → 创建并确认高优先级文件 → 释放 holder → 等待 conflict → 产品断言。释放前不要求 saving 已结束。

未知状态不得在同一进程内无条件释放 holder；Effect 中断、scope close、ensuring 均不是强制终止机制。父进程负责有界终止整个场景，不执行锁操作、不单独删除 lockfile、不替代 worker 业务清理。

只有确认退出、输出收尾完成及必要的进程树终止后，才允许清理独立临时根目录。退出确认超时不能忽略并继续删除目录；保留目录、PID、事件、原始错误及终止/清理错误。未知状态不执行正常产品断言。

正常路径恢复 spy、等待安全释放完成，以同一 key 的 probe/acquire 验证复用；若能精确定位目标 lockfile/breaker，再检查其残留。不得要求整个 state/locks 目录为空，不得通过删除锁目录伪造业务释放成功。

启动/协议故障归基础设施失败；真实等待及取消请求已确认而 saving 不终止，应记录取消行为失败或疑似产品回归；信息不足记为原因未判定。任何 timeout 均不能记为产品通过。具体 runner 状态和故障注入要求遵循阶段 0 修订计划第 8 节。

### 4.6 观察能力与验收结论对应

| 实际观察能力 | 允许的验收结论 |
| --- | --- |
| `waitWhileHeld` 对目标 lockfile 完成 busy 检查，并在 `NotAcquired` 重试前发出匹配 `WaitObservation` | 可声明“已观察到真实锁等待路径” |
| FSUtil 包装能够精确证明同一目标 lockfile 的上述边界 | 可声明“已观察到真实锁等待路径” |
| 仅观察到 `withLock` 调用前后 | 只能声明“已观察到锁调用边界”，不能声明已进入等待 |
| 仅观察到 `probe() === busy` | 只能声明“存在持锁者”，不能声明保存 fiber 已进入等待 |

只有前两行允许将锁等待证据从“需补强”更新为“通过”；后两行必须保持降低后的验收措辞。

## 5. IMG-T07a 修复步骤

文件：`packages/core/test/image-generation-settings.test.ts`

### Arrange

1. 创建临时目录和已有 `opencode.json`，记录原始字节；
2. 使用真实 `EffectFlock` 获取该文档的锁；
3. 通过经过验证的 `createEffectFlockTestNode({ onWait })` 安装观察点，只监听目标文档的 lock key；若采用 FSUtil 降级 seam，则只监听目标 lockfile 的真实 busy 检查；
4. spy `AtomicDocument.publish`。

### Act

1. 启动 `settings.update(enabled)` 保存 fiber；
2. 等待 `onWait` 发出“真实 lockfile 已确认 busy、已进入锁等待重试路径”的通知；
3. 使用 Effect 超时保护，超时视为测试失败，而不是继续取消；
4. 收到通知后中断保存 fiber；
5. 发出取消后，在受控超时内确认保存 fiber 已结束并收集最终 `Exit`；只有确认保存 fiber 已终止后才释放 holder。若保存 fiber 超时或收集失败，记录最后可信阶段并按 4.5 分类失败，不执行正常的 `publish === 0` 或文件结果断言；不得释放 holder 让未终止的保存 fiber继续运行，也不得把同一进程的 `ensuring` 当作强制终止手段。该测试必须运行在可硬终止的 child process/worker 边界内，由外层保留并报告原始超时；只有正常路径才断言保存 fiber 是 interrupt failure。

### Assert

- 保存 fiber 以 interrupt failure 结束；
- `AtomicDocument.publish` 调用次数为 `0`；
- 原文件字节完全不变；
- 没有 `.opencode-stage-*`；
- holder 释放后，对同一 key 的 `probe()` 返回 `acquired`；如能精确定位目标 lockfile，再断言该 lockfile/breaker 无残留；
- 观察点至少命中一次，且命中事件的 `key` 与 `lockfile` 同时匹配目标文档，并发生在取消之前。

### 额外要求

不要再使用“先在 `withLock` spy 中 signal，再检查 `probe busy`”作为主要同步依据。该 spy 可以保留用于确认调用入口，但不能代表真实等待证据。

## 6. IMG-T10 修复步骤

文件：`packages/core/test/image-generation-settings.test.ts`

### Arrange

1. 创建 canonical `opencode.json`，内容包含 BOM、CRLF 和注释；
2. 准备较高优先级的 `opencode.jsonc` 路径但暂不创建；
3. 持有 canonical 文件对应的真实文档锁；
4. 安装同一 `onWait` 观察点，并记录事件来源 key；
5. spy `AtomicDocument.publish`。

### Act

1. 启动 `settings.update(enabled)`；
2. 等待观察点确认保存 fiber 已在 canonical 文档锁上执行真实 busy 检查并进入锁等待重试路径；
3. 验证事件来源 key 等于 canonical 文档的 `ConfigDocument.key(json)` 后，创建 `opencode.jsonc`，内容使用预先记录的 `higher` 字节；
4. 记录并释放 holder 锁；
5. 将竞争文件创建、holder 释放和保存结果收集置于同一正常路径 `ensuring`/`finally` 作用域；正常路径失败时先完成可证明安全的 holder 清理再重新抛出原始失败。若保存结果超时，转入可硬终止的 child process/worker 基础设施失败路径，不在同一进程内释放未知状态的 holder。

### Assert

- 返回 `ImageGenerationSettings.Error`，`code === "conflict"`；
- `publish` 调用次数为 `0`；
- canonical 文件仍保持原始 BOM/CRLF/注释字节；
- 新创建的高优先级文件字节完全不变；
- 不存在阶段文件；
- 锁释放后 `probe()` 返回 `acquired`；
- 观察点命中发生在高优先级文件创建之前；记录并断言事件顺序为 `wait(canonical key, canonical lockfile) -> higher-created -> holder-released`。

这样才能证明竞争文件是在真实等待期间创建，而不是在保存任务尚未进入锁获取逻辑时创建。

## 7. 如果无法增加测试观察点

若测试专用节点或 Layer 结构无法安全注入观察回调，采用以下降级方案，但必须在报告中明确降低结论：

1. 在测试中包装真实 `FSUtil.Service`，保留全部方法，只拦截目标 lockfile 的实际 `stat`/目录读取边界；
2. 只在目标 lockfile“存在且 owner 仍活动”、并即将进入重试路径时发出通知；
3. 若仍无法观察该边界，则不修改生产代码，不声称“已进入真实等待路径”；
4. 保留现有测试作为“持锁期间取消/竞争结果”测试，并把验收矩阵措辞改为“取消发生于锁调用边界之后，未证明已进入重试等待”。

不得为证明测试而公开生产锁内部状态，也不得用固定延时替代观察点。任何测试节点或 Layer replacement 都必须先验证完整依赖、服务身份、同一 `EffectFlock.Service` 供给，以及默认实现不被改变。

## 8. 验证顺序

正式测试改造前必须先完成并归档 A2/A3 阶段证据：

- A2：facade 的公共/内部编译检查、运行时 identity、package resolution 和 monorepo import audit；
- A3：worker 正常完成、业务失败、timeout 硬终止、`close` 等待、无残留 worker 和 close 后目录清理；
- 每条 A3 场景保留 stdout、stderr、退出码、signal、事件日志、timeout 和清理结果。

A2 `EffectFlock` 局部 import/resolution 审计已完成并归档；A3 runner 已完成部分生命周期修复，但完整故障矩阵、真实进程树、终止/清理失败保留和阶段 0 危险等待硬隔离仍未完成。因此在 A3 完整门禁完成前，不运行以下正式 T07a/T10 改造测试，也不使用旧测试通过结果关闭新的等待证据缺口。

### 8.1 剩余工作执行顺序（复核更新）

在进入正式 T07a/T10 前，按以下顺序完成：

1. **A3 故障矩阵**：新增启动失败、未就绪退出、holding 后提前退出、非法/重复/乱序事件、result 后不退出、退出无 result、输出超限、输出管道不结束、后代进程、taskkill/退出确认失败和 cleanup 失败场景；每个故障场景后运行健康 worker。
2. **A3 证据与收尾**：保存主错误和所有次级错误，记录 timeout 阶段、实际退出状态、输出收尾、进程树确认和目录处置；未确认退出或输出未收尾时保留目录，不执行删除。
3. **A2 完整审计**：已完成本轮 `EffectFlock` 局部入口的静态/动态 import、barrel、TS paths、Bun/Node package resolution 审计，并归档原始命令、环境、输出和退出码；Core 全包 explicit export map 仍是独立任务。
4. **阶段 0 危险等待硬隔离**：新增专用 worker，使用真实 `layerWith` seam 和 replacement，父进程不操作锁；T07a 必须确认 saving 终止后才释放 holder，T10 必须记录 `wait -> higher-created -> holder-released`。
5. **证据归档与联合验证**：在同一代码状态下运行 typecheck、A2/A3/阶段 0 定向测试和联合测试，保存日志、环境、退出码、目录处置及哈希；不拼接不同运行的 totals。

这些工作完成前，A3 只能记为“部分修复”，阶段 0 仍保持打开；不得修改正式 T07a/T10，也不得把现有图片设置测试结果升级为真实等待证据通过。

### 第一阶段：Windows 本机小范围测试

从包目录执行：

```text
node D:/opencode/script/test-isolated.mjs test --timeout 30000 test/image-generation-settings.test.ts -t "IMG-T07a|IMG-T10"
```

随后运行完整 Core 定向集合：

```text
node D:/opencode/script/test-isolated.mjs test --timeout 30000 test/config/atomic-document.test.ts test/settled-io.test.ts test/image-generation-settings.test.ts
```

### 第二阶段：并发回归

使用既有 `verify.py` 的三轮 Core 并发筛选，确保新增观察点没有引入调度依赖、死锁或测试间污染。

### 第三阶段：三包门禁

测试文件发生变化后，必须重新生成新的候选证据，不得继续引用旧候选哈希：

- Core 联合测试；
- Server 联合测试；
- OpenCode 联合测试；
- Core、Server、OpenCode `bun typecheck`。

所有 Windows 本机测试仍使用 `node D:/opencode/script/test-isolated.mjs`，不从仓库根目录直接运行测试。

### 第四阶段：Docker Linux 补充验证（可选但推荐）

Docker 不能替代 Windows 本机门禁，也不能证明 Windows NTFS/DACL、GUI/EXE 或 Electron 行为。它用于补充验证当前未覆盖的 Linux/POSIX 边界，结果必须与 Windows 证据分开归档。

#### 容器环境要求

1. 使用 Linux 容器内部文件系统创建临时目录；不要把 Windows bind mount 作为 POSIX 权限测试的唯一文件系统；
2. 明确记录镜像、Linux 发行版、文件系统类型、Bun 版本和完整命令；
3. 不以 root 作为唯一测试主体，至少创建并使用固定 UID/GID 的非 root 用户；
4. 如验证第二主体，使用不同 UID 的进程或用户，并分别记录身份；
5. 先确认 Docker 容器内的 Bun 版本，不能把容器结果默认为 Windows/Bun 1.4.3 的结果。

#### 推荐验证范围

- POSIX owner/group/mode 保留与受限模式；
- Linux 权限准备失败和清理失败；
- 不同主体访问同一文档与锁；
- Linux 下锁等待、取消、发布和清理；
- 指定 Bun 版本的兼容性（若镜像已提供）。

#### Docker 证据要求

- 单独使用 Docker/Linux 证据目录或独立运行记录，不并入 Windows 的 pass/skip 统计；
- 保存 Docker 镜像标识、容器用户 UID/GID、Bun 版本、文件系统类型、隔离根目录、原始日志、退出码和 SHA-256；
- 若 Docker 环境无法可靠提供某项权限语义，记录为环境限制或未验证，不将其标记为通过；
- Docker 验证仍必须使用与包目录兼容的隔离测试 runner，或记录等价的隔离方式及差异。

Docker 阶段属于独立的可选跨平台补充，不属于当前 Windows 锁等待证据的完成条件；不改变本方案对 Windows、本地锁等待观察点、GUI/EXE、崩溃恢复和完整 IMG-R4 的边界声明。

## 9. 证据与文档更新

保留现有证据目录中的历史结果，不覆盖：

- 旧候选日志和哈希继续保留；
- 新候选使用新的子目录或更新后的根层证据，并记录生成时间、Bun 版本、平台、隔离根和退出码；
- 若补强测试失败，保留原始失败日志和候选哈希；
- 只在新候选全部通过后更新 `matrix.md` 和最终结果文档。

矩阵措辞应区分：

- “已观察到真实 lockfile busy 并进入重试等待”；
- “仅观察到锁调用边界及另一主体持锁”。

## 10. 风险与不在本方案范围内的事项

本方案不关闭以下边界：

- POSIX owner/group/mode（Docker 阶段若实际完成则单独记录，不与 Windows 结果合并）；
- Bun 1.3.14（需在 Docker 容器内实际确认版本）；
- Linux/macOS（Docker 只覆盖实际运行的 Linux 容器，不代表 macOS）；
- 第二主体访问（需在容器内使用不同 UID/GID 实际运行）；
- 恶意路径替换窗口；
- GUI/EXE；
- 崩溃后的持久恢复；
- `uncertain` close rejection 的自动安全恢复；
- 完整 IMG-R4 或全部 B2 强化项。

## 11. 完成标准

只有同时满足以下条件，才可将锁等待证据状态从“需补强”更新为“通过”：

1. 两个测试均观察到目标 canonical key 与目标 lockfile 同时匹配的 `WaitObservation`，该事件来自 `live-owner` 的 busy 检查并发生在 `NotAcquired` 重试前；不要求证明某次具体 backoff 已完成；
2. 连续三轮并发回归全部通过；
3. Core/Server/OpenCode 联合测试和三包 typecheck 全部退出码为 0；Docker 阶段不属于本条的前置条件；
4. 唯一 skip 仍被准确记录为 Windows 不适用的 POSIX 测试；
5. 新候选的所有日志 SHA-256 与运行元数据校验一致；
6. 文档没有把 Windows 或 Docker 本机结果扩大为未实际运行的平台、崩溃恢复或完整 IMG-R4 结论；默认锁实现、公开服务接口和默认运行时行为保持不变；Docker 证据与 Windows 证据分开统计。
