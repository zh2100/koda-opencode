# 项目缺陷扩展复查（2026-11-15）

## 结论

本轮新增确认 2 项缺陷，加上前次已复现且对应源码未变的 3 项，当前本轮复查范围共有 5 项确认未修复。未把待验收项目计为缺陷。没有修改产品代码、重启用户应用、访问生产配置/凭据或提交代码。

| 编号 | 优先级 | 状态 | 问题 |
| --- | --- | --- | --- |
| OBS-01 | P1 | 前次已复现，相关源码未变 | 名称保存使旧模型刷新冲突后没有最新版本补刷 |
| ACC-F02 | P1 | 前次真实 HTTP 1 pass / 3 fail，相关源码未变 | 项目保存写 config.json，加载读取 opencode.json/jsonc |
| AUTH-REPLAY-01 | P2 | 前次两种清理状态均已复现，相关源码未变 | 重建后兼容删除将其他命令的清理结果误认成删除成功 |
| UI-VIS-01 | P2 | 本轮新确认，受控交错和对照均完成 | 勾选提交后名称保存先回包，页面丢失勾选结果同步 |
| SECRET-SCHEMA-01 | P2 | 本轮新确认，结构错误与语法错误对照完成 | 凭据结构错误越过公开错误映射，并把错误字段原文放进异常诊断 |

旧三项完整证据与修复方向见 `specs/acc-followup-bug-review-2026-11-15.md`。本轮没有重复运行前次 HTTP 和页面样本，不能把历史结果标成本轮新通过。

## UI-VIS-01：已提交的模型勾选没有同步到本地

位置：`packages/app/src/hooks/use-relay-settings.ts:359`、`:1001`、`:1019`、`:1020`。

真实设置状态机受控 API 复现：

1. 初始供应商 entityId=entity:review、revision=1，模型 visible=false。
2. 调用 setVisible(..., true)，模拟服务端已提交 visible=true，但挂住该请求回包。
3. 保持同一供应商实体和地址，只修改名称并保存；名称保存先回包，revision 变为 2。
4. 放行勾选成功回包。
5. setVisible 在 sameIdentity 检查中发现 revision 不同，直接返回，未调用 syncCatalog。

实际输出：服务端替身 diskVisible=true，本地 store.managed.visible=false；sync 次数保持 1；认证 revision=2。没有错误提示或待同步责任被登记。这里的 diskVisible 是受控 API 的权威状态变量，并非真实后端磁盘。本轮证明了真实 hook 的错误接纳/收尾逻辑，没有冒充真实页面验收。

对照：完全相同的勾选请求，不插入名称保存，sync 次数从 1 变为 2，本地 visible=true，与权威值一致。

两种供应商设置布局均允许点击 Save 和勾选，未对二者作互斥门禁（经典 providers 的 saveVendor/setVisible，现代 providers 同样如此）。因此该交错可由界面动作触发，不是仅在不存在的公开入口上构造。

根因：sameIdentity 同时比较实体与普通修订号。它适合保护旧版本数据不被直接写回，但这里被用于决定是否继续同步一个已经提交的勾选；普通名称保存提高 revision 后，连最新快照回读也被放弃。已提交操作的同步责任没有独立保存。

修复要求：

- 勾选提交确认后，按服务器 scope、生命周期及 entityId 保留回读需求。
- 对同实体的修订变化，回读最新目录并按现有水位合并，不能直接应用旧 ACK 快照。
- 删除、重建、换服务器、销毁仍终止旧实体写回；不要全局删除 sameIdentity 的版本校验。
- 排队中的勾选、勾选失败、名称保存失败、换地址及清钥交错也应有明确接纳规则。
- 补两布局界面验收，并对返回结果、后端目录、本地状态、复选框作一致性核对。

证据：新证据根中的 `visibility-probe.ts`、`visibility-probe.log`、`app/result.json`；对照 `visibility-control.ts`、`visibility-control.log`、`app-control/result.json`。

## SECRET-SCHEMA-01：凭据结构损坏变成带原文的缺陷异常

位置：`packages/core/src/relay-secret-store.ts:82`、`:87`；上层 `packages/core/src/relay-auth.ts:287`。

触发：relay-secrets.json 是语法合法的 JSON，但引用对应值不是字符串，例如 `{ "secret:...": { "secret": "FAKE_SECRET_SENTINEL", "invalid": true } }`。全部样本仅使用假凭据。

真实 Core 服务隔离复现：

1. 明确临时 Global 数据/状态根，使用 makeLayer(undefined) 文件凭据后端，不调用系统凭据。
2. 用真实 RelayAuth.setVendor 创建临时供应商。
3. 将临时凭据值改成上述结构错误。
4. 调用真实 RelayAuth.resolve，检查 Effect Exit 和原因。

实际结果：Exit.Failure，原因标签 Die；Cause.pretty 包含 `Expected string, got ...` 和 `FAKE_SECRET_SENTINEL`。文件字节保持不变。

对照：同一路径改成语法错误 JSON，返回 Fail 类型的 Relay.AuthError，诊断不含标记原文。说明问题位于 JSON 读取之后的 schema 解码：decodeUnknownSync 直接抛异常，未进入 UnavailableError / SECRET_STORE_UNAVAILABLE 的 typed 错误通道。

影响：结构损坏不能沿公开的凭据不可用错误被处理；异常诊断带入输入字段原文。已确认诊断包含原文；本轮未测试 HTTP 响应或实际生产日志，不能声称公网响应已经泄露凭据。语法损坏用例当前只断言 Failure，无法约束结构错误的 Fail/Die 分类和脱敏。

修复要求：

- 用 Effect.try 包住同步解码，或使用 effectful schema 解码，再映射为不携带原始字段/SchemaError cause 的 UnavailableError。
- 保留原文件，不将损坏数据当作空配置覆盖；get/put/remove 均通过同一读取边界处理。
- 增加结构错误矩阵：对象值、数组值、数字、null、根数组，以及语法错误；检查 typed 错误、原字节不变、诊断和公开响应不含假密钥标记。
- 验证 RelayAuth.resolve、相关保存/清理及正式 HTTP 路径，确认服务初始化失败与运行时错误边界符合既有协议。

证据：`secret-probe.ts`、`secret-probe.log`、`secret/result.json`；对照 `secret-control.ts`、`secret-control.log`、`secret-control/result.json`。

## 基线、执行与限制

- HEAD：6b051f12a21094df1adef83f9fddfcbb765b319e。
- 开始时工作区有 459 条 Git 状态记录；本轮不清理或重置它们。
- 阶段 A 清单登记的 36 个文件与此前候选摘要一致；不等于 459 条改动全部审计完成。
- 新证据根：`C:\Users\zh2100\AppData\Local\Temp\project-bug-review-91ac53fc1aa04e5cad0b045f8a71fabb`。
- 进程启动前设置独立 OPENCODE_TEST_HOME、HOME/USERPROFILE、XDG、TEMP/TMP、内存数据库并清除配置覆盖；脚本从对应包目录通过 bun --eval 运行，App 使用仓库既有 browser conditions / happydom。
- 四个探针都以 0 退出，表示复现/对照脚本执行完成。两个缺陷探针观测到了错误行为，这些退出码不能作为修复通过证明。
- 本轮还静态检查了目录事务、调度执行与取消/恢复路径；没有据此确认新的调度缺陷，也不宣称这些模块无缺陷。
- 未运行全量测试、类型检查或完整真实页面。R3-03B、RF-07 跨平台及历史页面验收仍按原记录保留未关闭。

本轮新增问题应补入实施计划：UI-VIS-01 纳入阶段 B 的提交后同步责任；SECRET-SCHEMA-01 单列凭据读取错误边界修复和契约验证。原阶段 B/C 和 AUTH-REPLAY-01 仍需实施。
