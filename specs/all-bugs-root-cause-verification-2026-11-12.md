# Bug 根因复验记录 — 2026-11-12

对应[修复结果复核](D:/opencode/specs/all-bugs-fix-review-2026-11-12.md)。本次使用原始实现、正常对照和隔离源码的单变量干预复验因果关系；**没有将实验修改接入主仓库，也没有关闭缺陷。**

结论：RF-BF-01、RF-BF-02 的根因已验证；RF-BF-03 需要扩展原结论，不能仅删除 vendor.hasKey 条件。新增确认：统一密钥轮换、清除或切换模式后，旧响应仍会写入目录。

## 1. RF-BF-01：把本进程缓存变化当作共享租约失效

位置：[本地差异计算](D:/opencode/packages/core/src/relay-catalog.ts:519)、[按差异删除共享令牌](D:/opencode/packages/core/src/relay-catalog.ts:528)。

真实子进程在更新密钥并完成自己的同步后，已经获得新的刷新令牌，正在等待本机上游响应。父进程随后同步，读取的是同一最新认证文件与目录文件，却根据自己旧的 vendors/vendorStamp 将该供应商列为 invalidated，删除子进程的令牌。

本轮逐项观察到：

- 同步前，令牌存在，目录绑定与当前认证实体匹配。
- 父进程同步前后，认证 revision 和实体均未变化。
- 原实现同步后令牌消失；子进程退出码为 0，但模型结果为空。
- 仅在隔离副本去掉第 528 行基于本地 invalidated 的令牌过滤，令牌原样保留，返回 causal-model。
- 该干预下，真实子进程有/无父进程中途同步均通过；已有 C03 删除失效、C04 不同供应商逆序、C05 同供应商新请求胜出均通过。

因此，根因是**错误的失效依据和所有权范围**，不是上游失败、HTTP 取消、认证再次变化或文件互相覆盖。

正式修复约束：同步负责接纳共享状态，不能凭本实例旧视图撤销别人的当前租约；失效应基于租约所绑定的实体和有效凭据版本。保留提交时的 token/身份检查，不能用“所有响应都接纳”替代。历史失效用例的定向通过不足以替代正式修复的完整矩阵。

## 2. RF-BF-02：初始快照绕过实体失效入口

位置：[直接装载初始快照](D:/opencode/packages/core/src/relay-catalog.ts:328)、[首次模型投影](D:/opencode/packages/core/src/relay-catalog.ts:706)。

复验直接检查磁盘 vendorEntities、当前 auth.entityId，以及重建服务后的 managed/apply：

- 未替换实体时，磁盘绑定仍合法，保留旧模型与原地址，正常对照通过。
- 替换实体后，磁盘明确仍绑定旧 entityId。重建服务时，该绑定未被检查；managed 仍返回 retired-model，apply 将它投影为 custom:review:retired-model，地址变为新实体的 https://after.invalid/v1。
- 仅在隔离副本公开 Service 前执行一次现有 synchronize，同样输入下 managed 与 apply 都为空；未替换实体的正常对照仍保留模型。

因此，问题不只是设置页没有刷新，而是**服务在首次被消费者使用前，没有完成一致性装载**。事务内部的失效逻辑正常，并不能保护完全没有进入事务的初始化路径。

正式修复约束：首次对外提供缓存查询和模型投影之前，以 auth→catalog 的锁顺序读取一致状态，复用实体过滤规则，再发布可用服务；不要要求聊天消费者或用户先打开设置页。实验中的直接启动同步仅用于归因，尚未替代对初始化通知、失败收尾和必要写盘边界的实现审查。

## 3. RF-BF-03：有效凭据状态没有贯穿准备、请求和提交

### 3.1 已确认的可用性错误

位置：[错误检查供应商独立密钥](D:/opencode/packages/core/src/relay-catalog.ts:493)。

同一服务、同一有效统一密钥下：

- vendor.hasKey=false，但 auth.resolve(chatgpt) 能解析到统一密钥。
- catalog.probe 成功，返回 1 个模型，证明解析与可控上游均正常。
- 原实现 refresh 返回失败，发往上游的新增请求数为 0。
- 仅将该条件从“供应商有独立 key”改为“供应商存在且凭据已解析”，refresh 才实际请求一次并成功。

这排除了密钥后端、统一模式未开启及上游不可用，确认供应商独立 keyRef 状态被误当成全部凭据的可用性。

### 3.2 更深的完成阶段错误

位置：[准备阶段捕获 resolved](D:/opencode/packages/core/src/relay-catalog.ts:574)、[实际请求重新解析](D:/opencode/packages/core/src/relay-catalog.ts:600)、[完成阶段再次使用旧 resolved](D:/opencode/packages/core/src/relay-catalog.ts:603)。统一凭据选择位于 [RelayAuth.resolve](D:/opencode/packages/core/src/relay-auth.ts:739)。

在供应商也有独立密钥的情况下启动统一模式刷新，使原来的 hasKey 检查不会提前阻止请求。上游暂挂后分别执行：不变、更换统一密钥、清除统一密钥、关闭统一模式；每次都调用现有 syncVendors，再放行响应。

| 请求期间的变更 | 原实现 | 只放开 hasKey 检查 | 实验中完成后重新解析有效凭据 |
| --- | --- | --- | --- |
| 无变化 | 正常接纳 | 正常接纳 | 正常接纳 |
| 统一密钥轮换 | 错误接纳旧响应 | 仍错误接纳 | 丢弃旧响应 |
| 清除统一密钥 | 错误接纳旧响应 | 仍错误接纳 | 丢弃旧响应 |
| 关闭统一模式 | 错误接纳旧响应 | 仍错误接纳 | 丢弃旧响应 |

原因：这些动作没有修改单个供应商的 revision。完成阶段虽再次调用 fingerprintOf，却传入准备阶段捕获的旧 resolved；计算结果仍包含旧 key，无法证明当前实际选用的凭据仍与本次请求相同。同步会发通知，但不会使该令牌失效。

这三种变更是同一有效凭据身份缺口的表现，本记录按 RF-BF-03 的扩展范围归类，不重复包装成三个独立根因。

### 3.3 正式修复必须满足的条件

1. 由认证层明确选择有效凭据：独立或统一、实体、端点及可比较的凭据代次；不能用 vendor.hasKey 代替。
2. 预留刷新时绑定该身份；实际 HTTP 使用被核验的同一份目标与凭据，避免准备后又解析另一份凭据。
3. 提交时，在认证与目录事务保护内比较当前有效身份，变更后拒绝旧响应；统一模式和共享密钥变化必须参与比较。
4. 不要直接把实验的“HTTP 返回后、目录锁外重新 resolve”作为正式方案。该方法证明了旧凭据复用的因果关系，但新读取与提交之间仍有竞争窗口。
5. 当前 auth.resolve 会再次取得认证锁，不能在已持有认证锁的 transact 中直接嵌套调用。需要由认证层提供适合已持锁事务的读取契约，或重新设计一次持锁协作边界，避免自等待。
6. 同时保留自定义地址使用独立密钥、跨供应商并行和真正过时请求被拒绝的对照；不要用所有认证变更都取消所有供应商请求来掩盖粒度问题。

## 4. 实验结果与范围

证据根：`C:/Users/zh2100/AppData/Local/Temp/opencode-bf-implementation-20261112`。

| 变体 | 结果 | 日志 |
| --- | --- | --- |
| 原实现新增根因测试 | 2 pass / 6 fail；包含原三项及统一凭据变更的新增对照 | logs/root-cause-baseline-1.log |
| 仅取消本地差异撤销共享 token | 根因测试 1 pass、真实子进程 2 pass、失效与乱序回归 3 pass，均 0 fail | logs/root-cause-token-only-1.log～3.log |
| 仅补首次公开前同步 | 2 pass / 0 fail | logs/root-cause-startup-only-1.log |
| 仅放开 hasKey 检查 | 有效凭据组 2 pass / 3 fail；独立端点防泄漏对照 1 pass | logs/root-cause-availability-only-1.log、2.log |
| 放开检查并在完成后重新解析，仅用于因果验证 | 有效凭据组 5 pass / 0 fail；失效与乱序回归 3 pass / 0 fail | logs/root-cause-effective-credential-1.log、2.log |

各组有重叠，不累计成一次完整回归。脚本自身退出 0 只表示实验编排完成，不能当测试通过；各实际测试退出码和命令都保存于 review/root-cause-*.json。

新增诊断源码保存于 review/root-cause.test.ts；实际运行路径是隔离副本 packages/core/test/bf-root-cause.test.ts，跨进程夹具为 test/fixture/bf-review-writer.ts。每次通过 scripts/root-cause.py 选择一个临时干预；脚本串行执行，并在 finally 从主仓库原始源码恢复隔离文件，记录恢复摘要。所有实验均确认主仓库未变。

首版观察用例误将“目录绑定项是否保留”当作“认证实体是否变化”；令牌被删除且没有其他目录行时，绑定项会随之被移除。现已改为直接比较 auth.entityId 与 revision，首版输出仍保留在 logs/root-cause-baseline-observe1.log，不将那条观察断言本身计为新增产品缺陷。

本次只启动了诊断用随机本机端口和自己创建的短生命周期子进程，均已收尾；没有启动页面或操作正在运行的应用。主仓库没有接入临时变体，没有提交，3 项缺陷仍未修复。既有完整 UI、跨平台及迁移缺口保持原状态。