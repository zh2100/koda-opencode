# 多模型协作下线：代码清单与修改方案

盘点基线：2026-11-22，`HEAD ac5272bc2a` 与当前工作区对照。本文是实施前方案，不代表已通过验证或已发布。

**结论：前端已有未提交的下线改动，后端仍可独立创建并执行任务。** 本文的“协作”指输入框开关及其背后的多角色任务编排，不指会话分享、项目同步、普通子代理或通用 `task` 工具。若目标仅是隐藏入口，可停在第一阶段；若目标是使旧客户端也无法发起协作，应完成接口及运行时下线。

## 原调用链

`HEAD` 中，输入框 `handleSubmit` 根据设置、模型与输入内容决定是否进入协作分支。`collaborationRoute` 区分普通处理与并行候选，`startCollaboration` 携带会话、项目、工作区及角色模型创建任务；服务端负责调度。`HEAD` 的 `submit.ts` 以 `mode: "parallel"` 创建任务，完成提交处理后直接返回；`waitForCollaboration` 是轮询工具，在该基线中只有测试调用，并非实际提交链路。创建协作任务和发送普通提示不是两个应当连续执行的步骤。移除分支后，同一次正常提交应只发送一次普通提示。

协议组 `server.orchestrator` 将创建、查询、控制映射到 `OrchestratorHandler`，后者调用 `TaskOrchestrator.Service`。核心层处理串行/并行执行、评审、测试、重试及状态持久化。只删开关不会注销这些路由。

## 文件清单与处理边界

下表以仓库根目录为基准；花括号与星号表示同目录文件组。

| 层次 | 文件 | 当前状态与建议 |
| --- | --- | --- |
| 协作专用界面、请求与测试 | `packages/app/src/components/prompt-input/collaboration-toggle.tsx`、`packages/app/src/components/settings-collaboration.tsx`、`packages/app/src/utils/collaboration{,.test}.ts` | 工作区已删除。原设置页含五种角色模型和 JEV 连接测试；不需要恢复页面再修改。 |
| 共用输入框与设置 | `packages/app/src/components/{prompt-input.tsx,prompt-input-v2.tsx,dialog-settings.tsx,settings-v2/dialog-settings-v2.tsx}`、`packages/app/src/components/prompt-input/{contracts.ts,submit.ts,submit.test.ts}`、`packages/app/src/context/settings.tsx` | 已有差异。复核两套入口、提交分支与设置就绪条件；保留普通发送、附件及上下文测试。 |
| 文案与资源 | `packages/app/src/i18n/{en,zh,zht,desktop-native}.ts`、`packages/app/src/assets/prompt/collaboration-{on,off}.png` | 核对实际文案差异；两张图片仍在版本库中，确认无引用后删除。不要连带清除其他设置项。 |
| 接口与挂载 | `packages/protocol/src/{groups/orchestrator.ts,api.ts}`、`packages/server/src/{handlers/orchestrator.ts,handlers.ts,routes.ts}`、`packages/opencode/src/server/routes/instance/httpapi/server.ts` | 仍存在。注销协议组、处理器、路由和实例服务装配，而非仅让创建请求返回成功但不执行。 |
| 执行与存储 | `packages/core/src/task-orchestrator.ts`、`packages/core/src/task-orchestrator/` | 专用实现包括 `execution.ts`、`loop.ts`、`parallel.ts`、`changes.ts`、`failure.ts`、`review.ts`、`post-commit.ts`、`retry*.ts`、`worker-*.ts`、`sql.ts`。断开调用方后移除运行逻辑；数据库定义单独处理。 |
| 测试代理及隔离 | `packages/core/src/{tester-isolation.ts,tester-session.ts,tester-session-bridge.ts,location-services.ts,plugin/agent.ts,tool/bash.ts,tool/tester-command-policy.ts}`、`packages/server/src/tester-isolation.ts`、`packages/opencode/src/{agent/agent.ts,task-orchestrator/tester-isolation.ts}` | 逐项核实 `orchestrator-readonly`、`orchestrator-tester`、测试会话桥接及隔离层的调用方。先撤销代理注册与执行入口，再移除专用限制；不要削弱通用 Bash 权限或删除整份代理注册文件。 |
| 数据库及注册 | `packages/core/src/database/migration/{20261013000000_task_orchestrator,20261021100727_task_orchestrator_parallel}.ts`、同级目录上层的 `migration.gen.ts`、`schema.gen.ts` | 涉及 `task_orchestrator_task`、`task_orchestrator_step`、`task_orchestrator_run`、`task_orchestrator_message`。默认保留历史迁移与表，不再写入。**首轮保留 `packages/core/src/task-orchestrator/sql.ts`**：`packages/core/drizzle.config.ts` 通过 `./src/**/sql.ts` 发现表定义，即使没有运行时 import 也不能整目录删除。`packages/core/schema.json` 是增量迁移基线；从 `packages/core` 运行 `bun script/migration.ts --check` 验证无 schema 漂移，不通过生成删表迁移来消除报错。 |
| 客户端与测试 | `packages/client/src/generated/{client,types}.ts`、`packages/client/src/generated-effect/client.ts`、`packages/sdk/js/src/v2/gen/{sdk.gen,types.gen}.ts`、`packages/client/test/promise.test.ts`、`packages/protocol/test/orchestrator.test.ts`、`packages/core/test/task-orchestrator*.test.ts` | 接口下线需重生成客户端，同步协议组断言与专用测试；核对 `packages/core/test/{agent,tester-isolation,tester-session,scheduled-task-wire}.test.ts` 和 `packages/core/test/tool/tester-command-policy.test.ts` 的共享依赖。 |

**不按关键词批量删除。** `packages/opencode/test/permission-task.test.ts` 使用 `orchestrator-*` 验证通配权限，`packages/opencode/src/cli/cmd/run/runtime.ts` 中的同名词是注释。现有 `global-sync/child-store.ts` 差异修改的是 provider 回退行为；它及其测试、图像生成相关差异不应随本方案回滚或纳入删除清单。

## 实施顺序与验收

1. **收口前端。** 审阅已有 diff，不覆盖未提交工作。检查两版输入框和设置页均无入口；分别从新会话和已有会话提交跨模块提示，确认只发送一次、无协作 POST/轮询，附件与上下文仍正常。旧的 `settings.collaboration.models`、`settings.collaboration.preferences` 不应阻塞启动；后者可能保存 `jevKey`，建议通过现有持久化适配层做定向清理，不输出其值，不重置 `settings.v3`。
2. **退役接口。** 发布前通知旧 SDK 使用方，先在旧实例阻止新的创建请求，保留查询和控制以处理在途任务。检查 `task_orchestrator_task` 的 `pending`、`running`、`paused` 记录：逐项确认已结束、已中止或已人工登记为历史遗留；仍有活动执行时不切换服务端，不把数据库改状态当作停止执行。暂停任务不在升级后自动重跑。随后注销 `POST /experimental/orchestrator`、`GET /experimental/orchestrator/:taskID`、`POST /experimental/orchestrator/:taskID/control`。验证三条路由均不再提供服务，普通会话路由仍可用。在 `packages/client` 运行 `bun run generate`；从仓库根目录运行 `./packages/sdk/js/script/build.ts` 更新旧版 JS SDK，不手改生成文件。
3. **撤销执行能力。** 去除实例装配、专用代理、调度与隔离实现。检查两个服务端装配入口均能启动；普通子代理、权限、定时任务及测试隔离若仍被独立消费者使用，应保留相应实现和测试。
4. **保留升级与回退路径。** 首次下线不删历史表或用户会话。分别用空库和含旧任务的数据库启动，确认迁移正常、旧会话可读、普通发送不产生协作记录。若之后要求物理清理，先备份并安排独立的前向迁移；删除表后不能仅靠回退二进制恢复任务历史。
5. **验证并记录。** 在受影响的各包目录运行 `bun typecheck`。在 `packages/app` 运行 `bun test src/components/prompt-input/submit.test.ts`，在 `packages/client` 运行 `bun test test/promise.test.ts`，并在相应包执行更新后的协议、权限、数据库升级与服务启动测试。复查 `git grep -inE "collaboration|TaskOrchestrator|server\.orchestrator|/experimental/orchestrator|task_orchestrator" -- packages`：逐条解释保留的历史迁移、通用功能和无关文案，不以零命中作为验收条件。

本次仅盘点并生成文档，以上测试与升级演练均为实施时的验收项。
