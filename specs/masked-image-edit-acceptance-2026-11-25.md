# 遮罩图片编辑验收（2026-11-25）

**结论：源码离线验收通过；真实供应商与已安装桌面版未验收。** 回滚与旧任务清单仅通过已有基础能力的回归，不满足交付标准。

## 图片编辑

| 验收项 | 本轮结果 |
| --- | --- |
| 两版输入框 | Chromium 复用 `+` 与拖拽，PNG 打开遮罩编辑器，GIF/PDF 保持预览；覆盖英语 LTR、英语强制 RTL、阿拉伯语 RTL 与混合方向文件名。 |
| 选区与确认 | 128 × 64 原图及遮罩坐标一致，涂过区域 alpha 为 `0`、未涂为 `255`。清空后不能提交；展示模型、端点、上传及可能计费提示，确认前无编辑 POST。 |
| 原图与版本 | 本次弹窗内保留原图，可切换、下载并继续编辑新 PNG 版本。没有恢复旧“原图编辑”入口。本轮未验证关闭或刷新后从 UI 重建版本列表。 |
| 生成图与生命周期 | 从工具结果点开的图绑定 Session、workspace、消息、调用和字节摘要。取消后仅查收原请求；切 Session 后在途浏览器请求被中止，回到原 Session 重开不显示旧结果。后者不是浏览器收到迟到成功响应的测试。 |
| 实际路由与请求 | 本地回环验证未确认、过期目标和坏遮罩不派发；限定同一请求 ID 至多派发一次。实际 multipart 字段为 `image`、`mask`、`model`、`prompt`、`n=1`，核对原图和遮罩字节；拒绝重定向、结果 URL 和无效图片收据。真实 Session 投影的生成图编辑前后历史一致，inbox 无新增。 |
| 收据恢复与超时 | 关闭旧测试 handler 和上游回环服务后，用同一临时 SQLite 文件创建独立 handler，`reconcile: true` 返回原收据，无需再次派发。Core 使用 TestClock 验证 120 秒响应体空闲和 10 分钟总时限；持续有响应进展的请求可越过 240 秒。 |

本轮结果：Chromium 4 项；Core 定向 133 项；Server 全套 39 项（图片与 inbox 定向 2 项）；Schema 27 项、Protocol 2 项、Client 25 项、SDK-next 5 项、OpenCode Location HTTP API 4 项通过。App 单元 875 项、浏览器环境测试 240 项通过，另有 2 项跳过。相关包类型检查、App E2E 类型检查、Core 迁移检查与目标 diff 检查通过。App 首次直接运行 `bun test` 缺少包脚本的 Solid 浏览器条件及测试配置，报 `jsxDEV`；使用 `test:unit` 和 `test:browser` 后两套均正常通过。

### 精简生产构建基准

Windows Chromium，v2，关闭审查面板，24 轮历史、12 次增量，CPU 不限速，单样本：

| 指标 | 改动前留存基线 | 本轮 |
| --- | ---: | ---: |
| 首屏内容 | 287.21 ms | 319.16 ms |
| 增量完成 | 3082 ms | 3102 ms |
| 帧间隔 P95 | 18 ms | 19 ms |
| 最大帧间隔 | 28 ms | 40 ms |
| 长任务数 | 0 | 0 |

12 次增量均送达，基准通过。首屏和最大帧间隔比留存基线偏慢，单样本不能确认稳定回归，也不能据此放行完整性能矩阵。证据：`.tmp/image-editor-baseline.log`、`.tmp/acceptance-nov25-production.log`。

## 回滚与旧任务清单

依照 `specs/session-revert-and-stale-todos-fix-plan.md` 第 8、9 节核对：

| 门槛 | 验收判定 |
| --- | --- |
| staged 状态普通发送保护、幂等账本、无副作用的待执行读取、同 Session 屏障 | 已有基础回归通过。Core 另跑投影器、现有 todo 持久化和 `todowrite` 共 12 项通过。 |
| 安全重发与文件恢复 | 未交付。现有 `stage` / `clear` / `commit` 并非指定目标与版本的原子替换；缺少一并接纳新输入的持久事件，以及逐路径条件恢复与补偿。 |
| 三个回滚入口与可刷新待执行项 | 未交付。App 仍用旧撤回／恢复交互，持久 inbox 接口尚未接入，不具备提升后按同 ID 合并的交付验证。 |
| 清单归属、分支继承与迟到写入防护 | 未交付。V1 和 Core 仍各自写 `TodoTable`；未落地版本继承、明确换任务才取消、暂停／恢复与 V1 写入隔离。 |

旧版 OpenCode 回滚／压缩回归默认 5 秒时限下 6 项通过、2 项超时；用单次命令 `--timeout 30000` 重跑，8 项通过，其中两个用例分别耗时 12.37 秒和 11.27 秒。未修改断言或仓库默认时限；结果不替代新原子替换验收。证据见 `.tmp/acceptance-nov25-legacy-revert.log` 与 `.tmp/acceptance-nov25-legacy-revert-30s.log`。

## 证据与边界

- 浏览器：`.tmp/acceptance-nov25-image-browser.log`、`.tmp/acceptance-nov25-app-unit.log`、`.tmp/acceptance-nov25-app-browser-unit.log`。
- 服务与基础回归：`.tmp/acceptance-nov25-server.log`、`.tmp/acceptance-nov25-server-full.log`、`.tmp/acceptance-nov25-core.log`、`.tmp/acceptance-nov25-session-basics.log`、`.tmp/acceptance-nov25-sdk-next.log`、`.tmp/acceptance-nov25-opencode.log`。
- 未重启现有 App／服务器，未操作真实会话或上传真实图片，未请求付费上游，未打包或安装。浏览器 abort 不代表供应商取消或免计费；测试 handler 重开不代表生产重启恢复。跨 server、项目／worktree、draft 切换未逐项做浏览器验收。未跑远端 CI、当前 Core 全量、完整性能矩阵或已安装桌面端到端。
