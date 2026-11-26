# REVIEW-1111 两项缺陷修复结果（2026-11-11）

范围：此前复核确认的 REVIEW-1111-01（配置并发覆盖）和 REVIEW-1111-02（工作树发送目录错误）。

状态：两项实现已修复，相关自动回归通过。真实界面交互验收仍待执行。本轮没有提交、推送、重启现有应用，也没有写生产锁标记或启用迁移 apply。

## REVIEW-1111-01：配置文档共用资源锁

新增 packages/core/src/config/document.ts，用同一 config-document:<file> 资源键协调所有参与的文档写入。Windows 路径先按既有 FSUtil.windowsPath 规则转换；虚拟来源仍保留为标识。最终协议与锁后端继续由已有 EffectFlock/LockProtocol 决定。

接入入口：

- ImageGenerationSettings.update：选择目标文件后，在共享锁内重新读原文、校验、补丁、写临时文件并 rename。不会提交取得锁前的旧原文。
- Config.updateGlobal、Config.update：在同一文档锁内读取、保留原有配置校验并提交本次修改。
- Config.updateMcp：来源检查、可写性检查和版本检查都在共享锁内，保留原有 typed HTTP 错误。旧版本不通过检查就不会写盘。
- 加载器自动补写 $schema、默认文档初始化、遗留 TOML 转换：共用文档键。使用不等待的 tryWithLock，锁忙时跳过可选写入，避免 MCP 保存重载配置时等待自身。
- $schema 注解只会改仍与读取快照相同的文档。
- 遗留转换在锁内重读当前 JSON，已提交的 JSON 字段优先于旧默认值；磁盘合并只使用未展开原文，运行时结果仍使用展开后的配置，避免把环境凭据写成明文。

MCP 的并发语义没有改成“静默合并旧版本”：两个旧版本补丁交错时，后一个得到 MCP_VERSION_CONFLICT。重新读取并提交新版本后，两笔独立修改都保留。

十组真实入口交错回归：

1. 图片 → 全局设置。
2. 全局设置 → 图片。
3. 图片 → MCP（冲突后重新读取并重试）。
4. MCP → 图片。
5. 无 $schema 的 MCP → 图片（验证锁内重载不会死锁）。
6. 两笔全局设置。
7. 项目设置 → 全局设置（同一个实际文件）。
8. 不同 MCP 条目（同文档旧版本冲突与重新读取）。
9. 自动 $schema 注解 → 图片。
10. 遗留转换 → 图片（同时验证环境引用在内存展开、磁盘保留原文）。

测试只在真实 FSUtil 的提交边界放门闩；使用真实服务、文件、锁、版本校验和补丁实现。也更新了既有 junction 别名竞争回归，使其持有实际生产入口使用的共享文档锁。

本修复协调采用新写入口的参与者。未采用此资源锁的旧版本、外部编辑器，以及不同资源根/状态目录的进程，不因此自动获得协调保证。R3-03B 的旧版本隔离、迁移及未知锁恢复没有关闭。

## REVIEW-1111-02：发送 SDK 与所选工作树绑定

packages/app/src/components/prompt-input/submit.ts 在选择其他工作树后，使用提交开始时捕获的 ServerSDK 取得该目录的 SDK；会话创建的 client 与后续发送的 client、api、protocol 使用同一个目录上下文。

没有改为在 await 之后读取可能已经切换服务器的全局 SDK。同步上下文、乐观消息和权限状态继续使用该次提交捕获的服务器和目录。

补充工厂回归：

- main、已有工作树、新建工作树，各自覆盖 shell、普通消息和 v1 自定义命令。
- 明确观测请求客户端的目录，不仅检查会话创建参数。
- 检查乐观消息和自动接受权限的目录。
- 会话创建挂起期间切换服务器、工作树选择和路由，发送仍归属原先捕获的服务器与工作树。
- 修改前定向运行：3 pass、8 fail；修改后包含既有设置回归的联合批次：92 pass、0 fail。

## 最终自动验证

| 范围 | 结果 |
| --- | --- |
| App submit + relay-settings-state + relay-settings-lifecycle | 92 pass、0 fail，452 assertions |
| OpenCode 配置并发（当时 9 组）+ config + 真实 HTTP config | 164 pass、1 skip、0 fail，527 assertions |
| 最终配置并发矩阵（含追加的遗留原文测试，共 10 组） | 10 pass、0 fail，65 assertions |
| Core 图片设置 + EffectFlock + LockIdentity | 30 pass、0 fail，113 assertions |
| App bun typecheck | 退出码 0 |
| Core bun typecheck | 退出码 0 |
| OpenCode 最终 bun typecheck | 退出码 0 |
| 涉及文件 Prettier / 受影响 tracked 文件 diff --check | 通过 |

表中配置矩阵存在重复执行，不能把两行数量相加当成互不重复的测试。1 项 skip 是 Windows 不适用的 POSIX mode 权限用例，不代表跨平台验证完成。

扩大配置回归曾捕获本轮重构遗漏了项目更新原有的加载/校验：已把它恢复到共享锁内，最终回归覆盖拒绝无效原生权限文档且不写盘。第一次联合执行还有 Windows Git Bash 路径场景在 30 秒预算下超时；最终以 120 秒上限完成整组。没有修改该用例的业务断言；时延根因未据此认定已解决。

公开协议、HTTP 返回结构与 SDK 没有在本轮修改。工作区原有的协议和生成客户端改动继续保留。

## 生产性能基线与比较

遵守 packages/app/AGENTS.md，在修改 submit.ts 实现前先采集生产构建数据。修改前 submit.ts SHA-256：

    3FF08FDA1EC9EBF32B00C6A19EE1008F5CAF0A306757DDB53AB308C000602AA6

现有标签页基准因缺失目标标签页失败；现有流式基准在 420 秒内没有观察到最终 delta，均没有可用指标，不能算通过。保留失败记录，没有修改其断言。

新增手工性能场景 e2e/performance/timeline/prompt-directory-benchmark.spec.ts。它复用标准 benchmark / withBenchmarkPage / mockStressTimeline，在生产包里等待会话稳定与输入框可见，跑三个全新浏览器上下文。独立随机端口，后台 API 使用测试 mock，没有连接当前生产应用。

| 批次 | 会话及输入框就绪时间 ms（三次） | 中位数 ms |
| --- | --- | --- |
| 修改前 | 2608.7797、1997.9027、1893.7591 | 1997.9027 |
| 修改后首次（同时存在其他验证） | 37599.7457、3055.7971、2312.7785 | 3055.7971 |
| 修改后单独复测（其他验证结束后） | 3948.1879、1633.3067、1585.6347 | 1633.3067 |

三次生产基准均完成并报告指标。首次修改后有明显长尾，因此保留原值，另作单独复测。后一次中位数低于基线，但样本小且单机调度噪声明显，不能据此宣称性能提升；本场景也不衡量实际 shell 执行、完整标签页切换或持续流式吞吐。

## 原始证据位置

- 配置/HTTP 最终日志：C:\Users\zh2100\AppData\Local\Temp\opencode-overall-audit-5d60c87c7e98493c8a57e00a13970140\config-final.log
- 十组并发最终日志：C:\Users\zh2100\AppData\Local\Temp\opencode-overall-audit-b5fa3972d66a4c3aa15a8fbe6444a250\concurrency-final.log
- 生产基线：C:\Users\zh2100\AppData\Local\Temp\opencode-overall-audit-54aa96cbf6924bf7a241cba1063325e8\benchmark-before.log
- 修改后首次：C:\Users\zh2100\AppData\Local\Temp\opencode-overall-audit-7cf14eb830734a4882dece42037dac54\benchmark-after.log
- 修改后单独复测：C:\Users\zh2100\AppData\Local\Temp\opencode-overall-audit-69ec6f849c5b44fabc67ff6bebd3f2bd\benchmark-after-idle.log
- 原标签页基准失败：C:\Users\zh2100\AppData\Local\Temp\opencode-overall-audit-b7b9b39db7474edf965cfd90135d56ac\benchmark-before.log
- 原流式基准失败：C:\Users\zh2100\AppData\Local\Temp\opencode-overall-audit-86d6679a2c904279897053a642a7c61a\benchmark-before.log

临时数据根均与生产数据分离。临时服务器由测试框架启动和收尾，没有重启已有应用。

## 状态边界

- 两项新缺陷：实现修复、自动验证完成。
- 工作树界面里真实发送命令并观察 cwd，以及历史 OA-06 UI01–UI08：仍待界面验收。
- R3-03B、RF-07 跨平台、完整流式/标签页基准：保持未关闭或待验证。
- 本记录不把其余全部未提交内容认定为无缺陷。
