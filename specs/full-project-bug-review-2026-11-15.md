# 项目 Bug 检查总览（2026-11-15）

本报告汇总第六至十轮检查。第六轮新增 3 项 P2 产品缺陷及 2 项测试可靠性问题；第七轮新增 3 项 P2 产品缺陷，并扩展 ADD-18 的 EPUB 证据。第八轮新增 3 项 P2；第九轮新增 2 项 P2；第十轮新增 2 项 P2。追加记录累计 **29 项产品缺陷（3 P1、26 P2）**，当前仍需修复。已测模块通过不代表项目没有其他 bug；本报告是有证据边界的检查结果，不是全量功能验收证明。

详细复现、根因、修复要求见 [追加缺陷记录，第 12～21 节](./additional-bugs-review-2026-11-15.md#12-第六轮扩大项目检查范围2026-11-15)。

## 1. 第六轮范围与基线（第七轮增补见第 7 节）

- 仓库：`D:\opencode`，分支 `dev`，HEAD `6b051f12a21094df1adef83f9fddfcbb765b319e`，包含检查开始时的全部既有未提交改动。
- 本轮未修改产品源码、仓库测试、版本或暂存状态；仅更新追加记录并新增本报告。没有提交、推送、重启应用或操作生产配置/凭据。
- 证据目录：`C:\Users\zh2100\AppData\Local\Temp\opencode-project-audit-1199803213624af6a5e9ddba62f879df`。
- `manifest-before.json` 与 `manifest-tested.json`：相对检查输入，文件无变化，暂存语义一致。交付摘要已核对仅两份检查文档变化，HEAD 与暂存语义不变，见 `manifest-delivery.json`。
- 所有测试在对应包目录使用 `node D:/opencode/script/test-isolated.mjs ...`；隔离路径先于产品导入。仅使用测试数据、受控服务和本地测试接口，没有调用真实付费模型。
- 本轮未找到可调用的 Codegraph 工具，使用文件索引、调用链阅读、源码摘要、实际实现回归和受控复现。没有声称重新建立了 Codegraph 索引。

## 2. 新增结论

| 编号 | 等级 | 已确认表现 | 验证边界 |
| --- | --- | --- | --- |
| ADD-17 | P2 | 定时任务设置页切换服务器仍显示 A；点击后向 B 发送 A 的任务 ID | 真实组件编译与 Solid/HappyDOM，API 边界夹具；完整页面待验 |
| ADD-18 | P2 | XLSX/PPTX/EPUB 忽略声明顺序；关系指向合法非数字文件名的 XLSX 工作表被遗漏 | Core 与旧运行时真实提取函数，受控 ZIP/XML，正常顺序对照通过 |
| ADD-19 | P2 | XLSX 的 64 字节预算在 20 行展开中被重复使用，展开 640 字节行内容后才拒绝 | 两套实现、小规模同步分配观测；未进行 OOM 压测 |
| ADD-20 | P2 | 技能开关向 B 发送 A 的权限 ID，未重取 B 权限列表 | 真实组件、同服务器对照，后端删除接线核对 |
| ADD-21 | P2 | RTF Unicode 后的转义回退被输出，还会吞掉后续正文 | 两套提取器及 Core 消息附件入口 |
| ADD-22 | P2 | RTF 未知 starred 目标未忽略，非正文内容进入附件文本 | 两套提取器及 Core 消息附件入口；未发送模型请求 |
| ADD-23 | P2 | 只改非当前服务器名称，会意外激活该服务器 | 真实编辑控制器 + ServerProvider，两个正常分支对照 |
| ADD-24 | P2 | 默认服务器地址替换后，持久默认键仍指向旧地址 | 同一集成复现，平台边界记录；未重启应用 |
| ADD-25 | P2 | XML 字符实体重复解码，合法字面文本被改写 | 两套 DOCX/ODT 提取器，独立 .NET XML 对照 |
| ADD-26 | P2 | 定时任务已提交后通知失败返回 500，原样重试落库两个启用任务 | 真实 Core、HTTP、SQLite；受控监听器失败，未执行模型 |
| ADD-27 | P2 | 百分号编码的合法二进制 data URL 解码失败，附件无法读取 | 旧字节 helper、Core 真实文档消息入口，Node 原生解码对照 |
| ADD-28 | P2 | 定时旧数据迁移后删空会复活；部分导入失败后重试遗漏剩余任务 | 真实 Store、SQLite 和服务作用域重建，受控数据库触发器失败 |
| ADD-29 | P2 | RTF 原始高位字节绕过代码页，正文出现乱码 | 两套提取器、Core 消息入口及 Windows 独立 RTF 解析对照 |
| QA-01 | 测试 P2 | 定时 T12 断言同秒冲突，但没有控制真实秒边界，联合批次偶发失败 | 原文件失败/单独通过，临时副本跨秒对照复现 |
| QA-02 | 测试 P2 | HTTP 套件导入 Global 后更换 XDG 根，联合运行被隔离检查拒绝 | 联合加载失败，两个文件分别进程运行通过 |

ADD-18 将两种格式和两套实现归为一项“按文档关系清单遍历”缺陷；多个失败断言不重复计算产品缺陷。QA-01/02 不计入 29 项。

## 3. 第六轮自动验证账本（保留原始结果）

### 类型检查

以下 10 个包的 `bun run typecheck` 全部退出码 0：

`core`、`app`、`server`、`opencode`、`desktop`、`llm`、`client`、`schema`、`ui`、`session-ui`。

这不包含每个工作区包、所有 E2E tsconfig、正式打包及跨平台编译。没有将核心包通过写成整个 monorepo 每个入口均通过。

### 首次定向回归

| 领域 | 测试文件/入口 | 结果 | 退出码 |
| --- | --- | --- | --- |
| Core 调度 | scheduled-task、wire、cancel、model-identity、authorization | 138 pass、1 fail | 1 |
| Core 认证与目录 | relay-auth、catalog-transaction、create、delete-replay、mutation-replay | 80 pass、0 fail | 0 |
| Core 会话与附件 | session-runner-message、office-text、image-generation、image-generation-authorization | 57 pass、0 fail | 0 |
| App 状态 | server-sync、server-session、tree-store、刷新 queue、use-relay-settings、attachments | 160 pass、0 fail | 0 |
| Server HTTP | image-settings、relay-auth、relay-commit、scheduled-task handlers | 3 pass、2 fail、2 errors | 1 |
| Desktop | background-cli、updater-controller、updater-subscriptions、shell-env、打包配置 | 41 pass、0 fail | 0 |
| LLM | openai-responses 协议 | 56 pass、0 fail | 0 |
| OpenCode 附件 | office-text、data-url | 17 pass、0 fail | 0 |

首次批次合计 **652 pass、3 fail**，其中 HTTP 的两个 fail 是文件加载错误，同时报告 2 errors，不另加两次失败。失败原因是 QA-01/02，不能将首次批次标为全部通过。

### 失败定位与新缺陷复现

| 验证 | 结果 | 日志 |
| --- | --- | --- |
| 原始 T12 单独执行 | 1 pass、0 fail | schedule-t12-alone.log |
| T12 临时副本增加跨秒边界 | 0 pass、1 fail | t12-boundary.log |
| 原始 relay-auth HTTP 独立进程 | 4 pass、0 fail | server-auth-alone.log |
| 原始 relay-commit HTTP 独立进程 | 8 pass、0 fail | server-commit-alone.log |
| 定时列表真实组件 scope 复现 | 0 pass、1 fail | scheduled-scope.log |
| 两套 Office 顺序/关系/展开额度复现 | 4 pass、8 fail | office-order.log |

新产品缺陷复现共 **4 pass、9 fail**；这是预期会失败的正确性断言，不是修复结果。单独复跑与首次批次有重复，不累计成更多独立覆盖数。全部原始命令、进程退出信息见 `jobs.json`、`results.json` 及日志；新增脚本也保留在证据目录。

## 4. 已有缺陷仍需处理

ADD-01～16 延续前五轮证据及未修复状态。本轮源码摘要与前轮交付一致，没有通过改动或新证据关闭它们；不声称逐个重跑了全部历史复现。

| 类别 | 未关闭编号 | 处理重点 |
| --- | --- | --- |
| 文件权限保留（P1） | ADD-01、06、13 | 图片设置替换、TUI 备份、旧 TOML 迁移分别保留源/目标权限；真实入口验收 |
| 配置写入和取消 | ADD-02、04、08、12、16 | 已投递 IO 排空、候选目标复检、no-replace 发布、失败恢复 |
| 配置来源/迁移/值语义 | ADD-03、07、09、11、14、15 | 有效来源一致、禁用规则、继承补丁、优先级、锁竞争读取、引用转义 |
| 刷新责任 | ADD-10 | 旧失败与新成功交错后，责任集合最终收敛 |
| 第六轮新增 | ADD-17、18、19 | 服务器归属、文档逻辑顺序、展开前累计预算 |
| 第七轮新增 | ADD-20、21、22 | 技能权限归属、RTF 回退字符与目标组 |
| 第八轮新增 | ADD-23、24、25 | 编辑与选择解耦、默认引用迁移、XML 单次解码 |

建议先处理三项 P1 权限问题；再将配置提交与迁移作为同一套规则逐入口修复。ADD-17 和 Office 两项可独立推进，但必须补真实入口验收。QA-01/02 应在下一轮统一回归前处理，避免把测试不稳定误判为产品不断产生新 bug。

## 5. 本轮覆盖与剩余验证边界

本轮实读并分析了设置页/弹窗归属、调度状态机、会话运行入口与附件构造、文件树生命周期、桌面后台/更新控制器及文档提取；自动验证覆盖上表列出的实际文件。没有新复现的模块，只能表述为“本轮所查场景未发现新增实证”，不能表述为完全无缺陷。

以下没有完成，不关闭历史状态：

- 完整设置页、双服务器实际页面、真实浏览器端到端及所有历史 UI 验收项。
- Linux/macOS/root 权限、Windows 符号链接、真实 plutil、已安装 Electron 和 Bun 单文件等平台/打包组合。
- R3-03B 产品迁移、旧版本隔离和实际迁移 apply；未操作生产标记。
- 全部供应商真实 API、所有模型协议、付费工具调用、真实 OAuth、网络断连与长期负载。
- 仓库所有测试及全部未提交文件的逐行穷尽审查；此次是覆盖主要风险链路的广泛检查。

不能承诺“所有 bug 都已找出”。目前可执行结论是：已有 29 项产品缺陷有记录，其中第六至十轮共新增十三项；先按证据修复并完成对应验收，再决定是否关闭，不用测试数量替代行为正确性。

## 6. 第六轮交付核对

日志、脚本、摘要与清理清单保留在本轮证据根。测试数据根仅按日志中的 `Test isolation root` 登记路径清理，删除前核对系统 Temp 父目录、固定前缀及无重解析点；不清理生产目录和其他任务的临时文件。

已精确清理日志登记的 24 个测试隔离根，`cleanup.json` 均记为 removed；证据目录保留。最终文件摘要只新增本报告并更新追加记录，HEAD 和暂存语义保持不变。此报告没有执行修复，也没有将任何未验收项标成关闭。


## 7. 第七轮续查（2026-11-15）

证据根：`C:\Users\zh2100\AppData\Local\Temp\opencode-followup-audit-3499d7f1186a4bb187b277d56dbc3b5a`。输入来自第六轮 manifest-delivery；HEAD 不变，before/tested 摘要确认检查期间源码与暂存语义未改变。

新增 ADD-20/21/22 的完整复现与修复要求见追加记录第 14 节。EPUB 已用含 container、OPF manifest/spine、NCX 以及不压缩 mimetype 的受控 ZIP 复现章节乱序，归入 ADD-18。没有独立 EPUB 阅读器验收。

| 验证 | 结果 |
| --- | --- |
| 真实技能组件同服务器对照及跨服务器命令归属 | 1 pass、1 fail，退出码 1 |
| 两套 RTF/EPUB 提取器最终样本 | 6 pass、8 fail，退出码 1 |
| Core 真实消息附件构造 | 1 pass、2 fail，退出码 1 |
| 既有 Core office-text + session-runner-message | 19 pass、0 fail，退出码 0 |
| 既有 OpenCode office-text | 14 pass、0 fail，退出码 0 |

新复现共 8 pass、11 fail，既有测试 33 pass。失败用于证明未修复缺陷，不是修复验证。探索阶段的初版 EPUB 包和未引用 HTML 断言不计最终账本、不新增编号；最终包补齐容器结构后，顺序错误仍可复现。没有产品改动，因此未重复类型检查，也未把上轮结果写成本轮重新执行。

此轮只更新两份检查文档；不修改生产数据、不启动或重启应用、不调用模型、不提交。测试根按日志登记路径清理，清理结果和交付摘要保留在本轮证据目录。原有真实页面、平台/打包与 R3-03B 等状态不变。


## 8. 第八轮续查（2026-11-15）

证据根：`C:\Users\zh2100\AppData\Local\Temp\opencode-round8-audit-1ca41b2e183948d8b4e51e6053f4eb94`。输入来自第七轮交付，before/tested 确认源码与暂存语义未变化。新增 ADD-23～25，完整复现、根因和修复要求见追加记录第 16 节。

服务器样本编译真实编辑控制器和 ServerProvider，未替换 add/remove/setActive 逻辑；健康检查、平台存储、上下文和 mutation 调用边界由夹具提供，不测试真实网络和 TanStack 卸载/重试。默认服务器修改后遗留旧键已确认，真实启动表现未验收。文档样本通过实际 DOCX/ODT 提取入口，并以独立 .NET XML 解码结果核对预期。

| 验证 | 结果 |
| --- | --- |
| 服务器编辑四场景 | 2 pass、2 fail，退出码 1 |
| 两套 DOCX/ODT 字符实体十二场景 | 4 pass、8 fail，退出码 1 |
| 独立 XML 参考解析 | 3 个输入均符合预期 |
| 既有 App server 上下文与工具测试 | 17 pass、0 fail，退出码 0 |

新缺陷复现共 6 pass、10 fail，原始服务器复现中重复的对照已替换，初版结果保留、不重复累计。源码未修改，不重复类型检查。继续保留真实界面、跨平台、R3-03B 等待验收状态。

本轮仅更新追加记录与本报告；测试根按日志登记路径清理，证据与清理清单保留。没有提交、推送、重启应用或操作生产数据。


## 9. 第九轮续查（2026-11-15）

证据根：C:\Users\zh2100\AppData\Local\Temp\opencode-round9-audit-7017018416f940f4a9ae1a01b0d8c095。输入为第八轮交付，before/tested 摘要确认产品源码、仓库测试和暂存语义不变。新增 ADD-26/27，完整复现与修复要求见追加记录第 18 节，原始验证账本见第 19 节。

- ADD-26：真实 HTTP 首次 POST 返回 500，但 GET 已有一条启用任务；相同参数重试返回 200，GET 与 SQLite 均有两条。未来任务没有执行，不能把潜在重复执行写成已发生计费。
- ADD-27：同一 DOCX 使用 Base64 可以生成附件正文，逐字节百分号编码则被判不可读。旧 byte helper 对合法二进制抛 URI error；Node 原生 data URL 解码返回正确字节。未运行完整旧运行时会话或调用模型。

| 验证 | 结果 |
| --- | --- |
| Core 真实创建提交/通知复现 | 1 pass、1 fail，退出码 1 |
| HTTP + SQLite 创建重试复现 | 0 pass、1 fail，退出码 1 |
| byte helper 与 Core 文档消息四场景 | 2 pass、2 fail，退出码 1 |
| 既有 Core T18、Server 定时 HTTP | 分别 3 pass、1 pass，退出码均 0 |
| 既有 OpenCode data-url，显式 30 秒超时 | 3 pass、0 fail，退出码 0 |

新复现共 3 pass、4 fail，证明两个未修复边界；既有定向回归 7 pass。OpenCode 前两次未带包约定的显式超时，收尾动态导入超过默认期限，均为 3 pass、1 fail；按配置复跑后通过，原始日志保留，不计新增产品缺陷。源码未修改，未重复类型检查。

本轮只更新两份检查文档。测试隔离根按日志登记及安全检查清理，证据保留；交付摘要核对 HEAD、暂存语义不变，只有这两份文档变化。没有提交、推送、重启应用、操作生产数据或关闭历史待验收项。


## 10. 第十轮续查（2026-11-15）

证据根：C:\Users\zh2100\AppData\Local\Temp\opencode-round10-audit-6f476db038694ed2a47ec3543ed868bb。继承第九轮交付，before/tested 确认源码、仓库测试及暂存语义不变。新增 ADD-28/29，详见追加记录第 20～21 节。

- ADD-28：旧文件迁入的最后一条启用任务删除后，重建隔离服务会恢复同 ID 启用任务。另用 SQLite 触发器拒绝第二条导入，解除故障后再次构建仍只剩第一条。共同根因是按表是否为空判断迁移完成，且迁移没有完整事务/恢复状态。本轮未真实杀进程或重启用户应用。
- ADD-29：RTF 中原始高位字节被当成 latin1 字符直接输出。CP936 的“你好”变成“ÄãºÃ”，CP1252 的 € 变成 U+0080；同字节的十六进制转义对照正常。两套提取器及 Core 消息路径均复现，Windows 原生 RTF 控件独立解析四份样本都正确。

| 验证 | 结果 |
| --- | --- |
| 删空后重建：正常/迁移两场景 | 1 pass、1 fail，退出码 1 |
| 迁移中途数据库失败并恢复 | 0 pass、1 fail，退出码 1 |
| RTF 两套提取器及 Core 消息 | 6 pass、6 fail，退出码 1 |
| 既有 Core/OpenCode office-text | 12 pass、14 pass，退出码均 0 |
| 既有删除 pending 任务 T05 | 1 pass、0 fail，退出码 0 |

新复现共 7 pass、8 fail，既有定向回归 27 pass。最初 Core 附件测试路径拼错，没有执行用例，日志单独保留，未混入结果。没有产品改动，因此未重复类型检查。

只更新两份文档，隔离测试数据清理后保留证据。未提交、未推送、未重启当前应用，也未操作生产数据或执行模型；历史未验收项保持原状态。
