# 同目录多会话并发验收

日期：2026-11-26

## 结论

**源码层与自动化回归验收通过；已部署后端已确认包含移除工作区锁的逻辑，实际事件记录也存在同目录会话执行重叠。用户反馈的所有等待现象尚不能据此认定已解决。**

后续排查另行复现并修复了“停止有多个 resume 等待者的会话后，部分等待者不返回”的问题。该新增修复仅完成源码测试，本轮未构建或重启桌面后端，不应与已部署的移除工作区锁变更混为一谈。

## 变更范围

- `packages/core/src/session/execution/local.ts`：移除包裹整个 Session runner 的 `WorkspaceOwnership.withOwnership(...)`，保留按 Session ID 协调的 `SessionRunCoordinator`、Location 服务注入、异常日志及已有的 `withBarrier`。
- `packages/core/test/session-execution-local.test.ts`：新增执行入口集成回归测试。
- 后续扩展上述测试：使用真实 `SessionV2`、本地执行服务、Location 服务和真实 LLM runner，只替换模型客户端、模型解析、快照及图片设置边界，验证两条模型流重叠。
- `packages/core/src/session/run-coordinator.ts`：完成通知以成功值承载 `Exit`，等待端再恢复原来的成功、失败或中断结果，避免中断结果直接广播时遗漏等待者。
- `packages/core/test/session-run-coordinator.test.ts`：在已有测试基础上新增多等待者中断回归；保留原有 barrier 逻辑及测试。
- 不修改 `WorkspaceOwnership` 本身、文件写入保护或权限实现。
- 工作区存在大量其他未提交变更，本报告不是对全部未提交变更的验收。

## 验收矩阵

| 项目                                    | 验证方式                                                                                                                                                                       | 结果                                   |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| 同目录不同 Session 可以同时执行         | 在真实数据库中创建同目录两个 Session；第一个 runner 保持阻塞时唤醒第二个，断言两者均已进入 runner 且同时处于 active 集合                                                       | 通过                                   |
| 同一 Session 重复 resume 不重复执行     | 第一个 runner 未完成时再次 resume，随后等待两个调用完成，断言只有一次 runner 调用                                                                                              | 通过                                   |
| 停止隔离                                | 中断第二个 Session，断言只有第二个收到中断，第一个仍 active，之后可正常完成                                                                                                    | 通过                                   |
| 执行完成后可再次恢复                    | 再次 resume 第一个 Session，断言产生一次新的 runner 调用，最终 active 为空                                                                                                     | 通过                                   |
| 同文件写入保护                          | `file-mutation.test.ts` 覆盖同一规范路径写入串行化、条件写入竞争与过期内容拒绝；不同文件独立执行                                                                               | 通过                                   |
| 权限及编辑相关回归                      | `permission.test.ts`、`tool-edit.test.ts`                                                                                                                                      | 通过                                   |
| 调度、会话创建、Location 及 runner 回归 | 扩展回归测试集                                                                                                                                                                 | 通过                                   |
| 正式服务接线                            | 静态核对 `packages/server/src/routes.ts` 和 `packages/opencode/src/server/routes/instance/httpapi/server.ts`，均将 `SessionExecution.node` 替换为 `SessionExecutionLocal.node` | 已确认                                 |
| 真实 runner 的双模型流重叠              | 第一条客户端流阻塞期间，第二条流已被订阅，第二个输入已从 pending 移出                                                                                                          | 通过（受控模型客户端）                 |
| resume / wake 启动与停止隔离            | 两种启动方式分别验证；停止第一个后，所有同会话等待者退出，第二个继续正常完成并投影助手消息                                                                                     | 通过                                   |
| 多个 resume 等待者的中断广播            | 一个启动调用与三个加入调用全部得到中断结果                                                                                                                                     | 修复前真实 runner 用例超时；修复后通过 |
| 已部署真实会话的执行重叠                | 只读核对本地事件数据库中同目录两个会话的重叠工具执行记录                                                                                                                       | 已确认，见下文；非主动桌面全流程验收   |
| 已运行后端是否包含移除工作区锁变更      | 检查桌面日志、进程路径及可执行文件内嵌的执行逻辑                                                                                                                               | 已确认；本轮新增中断修复未部署         |

## 自动化结果

所有测试、类型检查均从 `packages/core` 执行。

### 并发稳定性

```text
bun run test ./test/session-execution-local.test.ts --rerun-each 50
50 pass, 0 fail, 700 expect() calls
```

### 扩展回归

```text
bun run test ./test/session-execution-local.test.ts ./test/session-run-coordinator.test.ts ./test/file-mutation.test.ts ./test/workspace-ownership.test.ts ./test/session-prompt.test.ts ./test/session-runner.test.ts ./test/scheduled-task-wire.test.ts ./test/session-create.test.ts ./test/location-layer.test.ts ./test/permission.test.ts ./test/tool-edit.test.ts
281 pass, 0 fail, 1000 expect() calls
```

### 静态检查

- `bun typecheck`：通过。
- 仓库根目录执行 `bunx --no-install prettier --check packages/core/src/session/execution/local.ts packages/core/test/session-execution-local.test.ts`：通过。
- `git diff --check -- packages/core/src/session/execution/local.ts`：通过；仅提示 Git 后续操作可能将 LF 转换为 CRLF。

### 后续强化验证

```text
bun run test ./test/session-execution-local.test.ts ./test/session-run-coordinator.test.ts --rerun-each 30
900 pass, 0 fail, 2580 expect() calls
```

再次执行上述 11 文件扩展回归：**284 pass, 0 fail, 1021 expect() calls**。

新增测试后再次执行 `bun typecheck`：通过。部分测试启动时受 GitHub 下载 ripgrep 超时影响，未进入测试进程；后续命令将本机已有的 `rg.exe` 所在目录添加到该命令的 PATH 后运行成功，没有修改全局环境或绕过测试隔离。

## 已部署运行证据

- 桌面应用：`C:\Program Files\Koda\Koda.exe`，版本 `1.0.7`。
- 本轮核对时后端 PID 为 `14984`，启动于本地时间 `2026-11-26 12:23:22`，监听 `127.0.0.1:4096`。
- 后端位于桌面用户数据下的 `cli\lildax-v1.0.7-6888af77ce89\opencode-cli.exe`。检查其 `Failed to drain Session` 附近的内嵌代码，确认直接执行 runner 并注入 Location，不再通过工作区 ownership 包裹；不是仅凭文件时间推测版本。
- 只读查询本地 `opencode.db` 的 `event` 表；以下两个会话的 `session.directory` 均为 `D:/opencode`：

| 本地时间（UTC+8，2026-11-26） | 会话 | 持久化事件                       |
| ----------------------------- | ---- | -------------------------------- |
| 12:42:45                      | A    | step started，开始 bash 工具输入 |
| 12:42:46                      | B    | step started，开始 bash 工具输入 |
| 12:42:48                      | A    | bash 成功                        |
| 12:42:49                      | A    | step ended                       |
| 12:42:49                      | B    | bash called                      |
| 12:42:52                      | B    | bash 成功                        |

A：`ses_dea2709baffey8oEw8WGaDUCjj`；B：`ses_df22e7b8effe5dBr1KAuslc6IY`。不记录提示词、工具输入内容及凭据。

这组记录证实当前后端并非把同目录会话全程串行化，但不能证明所有时间段、所有供应商请求都不存在等待。`session.next.step.started` 在收到可发布的助手内容或工具事件后才生成；它不是 HTTP 请求发出的时间，因此提交到该事件之间的延迟不能直接归因为本地调度排队或供应商限流。

## 新发现的中断等待者缺陷

真实 runner 测试中，`resume` 启动后再次加入同一会话，随后停止会话：执行 owner 已停止、active 已清除，但一个加入者在 5 秒内仍未收到结束通知。原先只中断 wake 启动会话的测试未覆盖这一点。

当前安装的 Effect `4.0.0-beta.83` 中，`Deferred.doneUnsafe` 遍历可变的 `resumes` 数组；直接通知中断可能同步触发等待者取消清理并修改数组，从而跳过另一个等待者。本次不修改第三方源码，而是在协调器中广播成功的 `Exit` 值，再由各等待者恢复其结果。复现用例及四等待者回归均通过。

此缺陷可能造成停止后的请求悬挂，但尚无证据认定它就是用户观察到的跨会话等待根因。

## 覆盖边界与风险

原有集成测试以可控 runner 替代模型执行；后续新增测试使用真实 runner 与受控模型流，覆盖持久化接收、输入提升、上下文初始化、模型流订阅、中断以及结果投影。它仍不包含真实模型供应商 HTTP 传输或桌面交互。运行数据库的重叠记录是补充实证，不是对用户所有等待场景的全面验收。

并发 Session 共享同一目录，不提供文件系统快照或事务隔离。文件级保护不等于任意 shell 命令或 Git 操作之间存在互斥；应避免两个 Session 同时修改同一文件，或同时切换分支、重置工作区。

## 部署后人工验收步骤

1. 若验证本轮新增的中断等待者修复，需要重新构建并重启后端；移除工作区锁的先前变更已确认在当前运行版本中。
2. 在同一项目目录打开两个不同 Session，分别发送耗时且不修改文件的请求。
3. 确认 A 尚未完成时 B 已开始实际模型处理，而非仅显示已提交或排队。
4. 停止 B，确认 A 仍持续运行并正常完成。
5. 再次向 B 发送请求，确认可正常执行，无残留运行状态。

这些步骤是剩余验收清单，不是本次已经完成的测试记录。
