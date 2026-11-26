# 未提交改动复核（2026-11-11）

结论：本轮确认 2 项仍存在的功能缺陷，均通过调用当前真实实现的隔离回归复现。当前不能认定未提交内容已全部修复。

本轮没有修改业务实现，没有提交、推送或重启应用。临时测试副本已经删除；脚本及日志保存在下列隔离目录。

## REVIEW-1111-01：不同配置保存入口互相覆盖（P1）

位置：

- packages/core/src/image-generation-settings.ts:50–61
- packages/opencode/src/config/config.ts:880–901
- 同文件的 updateMcp:1084–1150 也有独立的 mcp-source 锁，但本轮直接复现的是图片设置与 updateGlobal。

触发条件：图片设置与普通全局设置更新同一份 opencode.json，在读取和提交之间交错。

真实复现顺序：

1. 隔离配置初始为 username: "before"、image_generation.enabled: false。
2. 调用 ImageGenerationSettings.Service.update()，读取旧文档并生成新文档；只在真实 fs.rename 前设置门闩暂停。
3. 调用 Config.Service.updateGlobal({ username: "saved-by-config" })。
4. 验证其返回 changed: true，磁盘 username 已是 "saved-by-config"。
5. 放开图片保存。图片保存正常完成，但最终 username 回到 "before"。

观测结果：

    CONFIG_COMMITTED true saved-by-config
    FINAL_FILE {"username":"before","image_generation":{"enabled":true,"model":"local/image","api":"openai-images"}}

“成功保存的 username 应保留”断言失败，退出码 1。

根因：互斥范围按功能划分，而实际资源是同一个配置文件。图片设置持 image-generation-settings:<config-directory> 锁；updateGlobal 没有共用该锁。原子 rename 只能防止读到半份文件，不能防止用旧文档覆盖新提交。MCP 的另一种业务锁同样不能约束其他写入口。

修复方向：

1. 为配置文档建立统一的写入协调入口，让图片设置、updateGlobal、updateMcp、写同一文档的其他入口共用同一资源锁。
2. 获取锁后再读取最新文档、验证来源/版本、应用本次字段补丁并提交。
3. MCP 的版本检查必须保留在共享锁内；不得先验证、出锁后再写。
4. 与现有锁协议兼容；本修复不得借机启用迁移 apply、写生产标记或静默更换协议。
5. 补双向交错回归：图片先读/普通配置先读；再补图片与 MCP、两个不同 MCP 条目、相同文件不同入口的并发保存。断言每个已确认成功的独立修改都保留。

复现脚本与日志：

- C:\Users\zh2100\AppData\Local\Temp\opencode-overall-audit-22da668391e04a168e51ad0184f4be4a\review-config-concurrency.test.ts
- 同目录 config-probe.log

夹具使用真实文件系统、真实图片保存锁和真实配置服务；只暂停 rename，没有替代写入算法。此前两次夹具准备失败（脚本相对路径、Layer 组合）不计为产品缺陷证据；上面的最终失败来自业务结果断言。

## REVIEW-1111-02：新工作树首条 shell 请求使用主目录客户端（P1）

位置：packages/app/src/components/prompt-input/submit.ts:499–507、655。

触发条件：从主目录的新会话输入框选择其他工作树，以 shell 模式发送首条命令。

真实复现：

1. 沿用 submit.test.ts 的真实 createPromptSubmit 工厂夹具。
2. 在现有测试副本的 clientFor(directory).session.shell 记录客户端绑定的目录。
3. 分别选择 /repo/worktree-a、/repo/worktree-b 发送。
4. 会话创建目录正确，但两次 shell 调用的客户端目录都是 /repo/main。

新增观测断言的结果：

    expected: ["/repo/worktree-a", "/repo/worktree-b"]
    received: ["/repo/main", "/repo/main"]

退出码 1。这里是工厂级受控复现，未启动真实 shell；服务端 SessionPrompt.shellImpl 使用请求实例的 ctx.directory 作为 ChildProcess.cwd，因此目录绑定会影响实际执行位置。

根因：handleSubmit 开始时把 submissionDirectorySDK 固定为原目录 SDK。选择新工作树时，仅切换局部 client 和 submissionDirectorySync；submissionDirectorySDK 未切换。会话创建使用局部 client，随后 shell 发送使用旧 submissionDirectorySDK。只有另一条“冷路由会话恢复”分支为它重新赋值。

既有测试漏点：已有工作树回归检查 createdClients、createdSessions 和命令参数，没有观测 shell 请求的客户端目录，因此原测试仍通过。

修复方向：

1. 确定最终 sessionDirectory 后，统一取得并保存对应目录的 SDK 与同步上下文；同一次提交后续所有路径使用这一对上下文。
2. 保持提交开始时捕获的服务器身份；不能改为在 await 后读取可能已切换到另一服务器的全局 accessor。
3. 不仅覆盖 shell，还要检查普通消息、v1 自定义命令、新建工作树、已有工作树及创建期间切换页面/服务器。
4. 在真实工厂回归中断言会话创建、发送请求、乐观消息与权限状态使用相同服务器和目录。另用隔离 shell 的 pwd/cwd 场景做界面验收。
5. 按 packages/app/AGENTS.md，在修改会话代码前记录生产性能基线，再做修改后对比。

复现脚本与日志：

- C:\Users\zh2100\AppData\Local\Temp\opencode-overall-audit-3158f826e8af46968ac8ec7db084d334\review-worktree-client.test.ts
- 同目录 worktree-probe.log

## 本轮通过的既有回归

- App：submit.test.ts + relay-settings-state.test.ts + relay-settings-lifecycle.test.ts，82 pass、0 fail、410 assertions。
- Core：image-generation-settings.test.ts，5 pass、0 fail、24 assertions。
- 上述两条新复现各 1 fail，分别由目标业务断言失败；不是依赖加载失败。
- 本轮没有改 TypeScript 实现，因此没有新增类型检查结论。上轮通过结果不冒充本轮全量验证。
- git diff --check 另发现 packages/opencode/test/mcp/auth.test.ts:138 文件末尾多余空行，属于格式问题，未计入功能缺陷。

## 未关闭的验收范围

- OA-06 的 UI01–UI08 仍待真实界面验收；本轮 61 项设置相关回归通过不等于界面验收完成。
- R3-03B、RF-07 跨平台、安装包等历史边界保持原状态，未因本轮结果关闭。
- 本轮是对高风险未提交路径的审查，不构成其余全部文件无缺陷的证明。


## 后续修复（2026-11-11）

以上两项已完成实现修复和自动验证；原始复核证据保留。详细范围、回归数量、生产基线及未关闭验收项见 [修复结果](D:/opencode/specs/review-1111-fix-results-2026-11-11.md)。本轮未提交、未推送、未重启已有应用。
