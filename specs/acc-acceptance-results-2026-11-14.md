# ACC 修复实施前现状复验与验收结果（2026-11-14）

## 结论

本轮继续验收未通过。ACC-01、ACC-02 两处 P1 仍可复现，不能关闭。七个关键产品源码文件的 SHA256 与[修复实施报告](D:/opencode/specs/acc-bug-fix-implementation-report-2026-11-14.md)基线一致，说明补齐后的实施方案尚未落到这些实现上。本轮没有代替用户实施修复。

最终页面联合 15 passed、2 failed、0 skipped、0 flaky，退出码 1；两个失败都对应 ACC-01。Windows 冷启动两组样本均在权限恢复后继续返回 503，对应 ACC-02。Windows 另有一次测试 afterAll 清理 EPERM，该联合套件整体退出码为 1，不能只报业务断言通过。

没有提交、推送、修改版本或操作用户原有应用。全部本轮隔离服务和专用容器已停止/移除；用户 Docker 引擎保持运行。

## 1. 固定源码与证据范围

| 项目 | 本轮实际值 |
| --- | --- |
| 仓库 / 分支 | D:/opencode / dev |
| HEAD | 6b051f12a21094df1adef83f9fddfcbb765b319e |
| 暂存区 SHA256 | BBD12F44DE8316E49C158D6D52929477E524373902229F91879C4894F56FCC20 |
| 主机 | Windows NT 10.0.26300.0，zhangh/zh2100 |
| 运行时 | Bun 1.4.3，Node v24.19.0 |
| 证据根 | C:/acc-acceptance-20261114-01 |
| Linux | Docker 独立容器，oven/bun:1.4-alpine，本轮记录 uid 1000 与 uid 0 |
| 自动重试 | Playwright retries=0；不同诊断批次分别保留 |

基线与收尾清单保存为 baseline.json、source-hashes.json、workspace-before.json、workspace-observed.json、workspace-after.json、workspace-verification.json。清单记录内容摘要，不备份或重置用户源码。

原始两个正式页面文件未修改：

- [relay-settings-followup.spec.ts](D:/opencode/packages/app/e2e/regression/relay-settings-followup.spec.ts)
- [relay-settings-busy.spec.ts](D:/opencode/packages/app/e2e/regression/relay-settings-busy.spec.ts)

本轮临时 TCP harness 从上一批证据复制到新隔离根，只增加观察日志、清理路径检查和有 schema/预热对照；未修改产品或正式测试夹具。历史证据 C:/fup-next-20261113 未覆盖。

## 2. 实际批次结果

各行独立计数，不把复跑与联合批次相加。

| 批次 | 实际结果 | 退出码 | 可支持的结论 |
| --- | --- | --- | --- |
| 页面首批：原后续 8 项 | 4 passed、4 failed | 1 | ACC-01 两处失败；另有导航超时与刷新 409，保留首失败 |
| 页面受影响项复跑 | 4 passed、0 failed | 0 | 两种布局的初始延迟读取、地址/可见性/密钥/删除链本次通过，不能抹去首批失败 |
| 最终页面联合：busy 9 项 + followup 8 项 | 15 passed、2 failed、0 skipped、0 flaky，142.31 秒 | 1 | 仅两条经典切服用例失败；FUP-02 原覆盖范围本次通过 |
| App relay E2E 类型检查 | bun typecheck:e2e:relay 完成 | 0 | 正式 E2E 类型检查通过 |
| Windows 原始冷启动 TCP + ACL | 0 pass、2 fail，29 个断言 | 1 | 文件恢复后 HTTP 仍 503 |
| Windows 带 schema 冷启动对照 | 0 pass、2 fail，29 个断言 | 1 | 排除缺少 schema 与初始化格式差异是 ACC-02 的充分解释 |
| Windows 同样带 schema、仅增加成功预热 | 2 pass、0 fail，31 个断言 | 0 | 热实例恢复到 200；不能替代冷启动验收 |
| Windows 正式 HTTP + 权限夹具 + InstanceState | 71 pass、2 skip、1 fail，373 个断言，111.99 秒 | 1 | 用例断言通过，afterAll 删除临时根 EPERM；整批不通过 |
| Linux uid 1000：正式 HTTP + 权限夹具 + 原始 TCP | 61 pass、2 skip、0 fail，377 个断言，85.65 秒 | 0 | 该平台原有子范围通过；字节观测限制见第 5 节 |
| Linux uid 1000：带 schema 的 TCP 对照 | 2 pass、0 fail，31 个断言 | 0 | 恢复后 HTTP 200，读取前后文件内容一致 |
| Linux uid 0：mode 拒绝专项 | 0 pass、1 skip、0 fail | 0 | root 条件真实框架跳过，不计通过 |

Windows 正式联合的两个 skip：POSIX mode 权限用例平台不适用；历史 T13 无条件框架 skip。Linux 联合的两个 skip：Windows ACL 平台不适用；同一个历史 T13。真实 root 的跳过来自单独 uid=0 执行，不能用 T13 代替。

## 3. ACC-01：仍访问旧服务器

最终联合两条原正式失败均保留：

1. A 的刷新请求挂起后，在经典 Servers 页切到 B。全局服务器按钮已为 44098，Providers 的输入值仍是 Primary unique，预期为 Secondary unique。
2. 不挂起请求直接切 B，点击 Reload settings。实际 /api/relay/models/sync origin 仍为 http://127.0.0.1:44096，预期为 http://127.0.0.1:44098。关闭重开后能够读到 B，正常对照成立。

两项是同一上下文归属缺陷的两个样本，不算两个独立 Bug。已确认错服读取；本轮没有为了证明风险执行切服后的保存、清 key 或删除，不能声称已观察实际错服写入。

正式证据：

- C:/acc-acceptance-20261114-01/app/logs/ui-joint.log
- results-joint.json、ui-summary.json
- results-joint/relay-settings-followup-cl-bfeff-es-the-old-refresh-response/trace.zip
- results-joint/relay-settings-followup-cl-3a1b9-d-with-close-reopen-control/trace.zip
- 对应 test-failed-1.png、error-context.md 及请求目标附件。

本轮正常通过的页面范围：两布局初始认证读取延迟时新增同名供应商、保存 ACK 后继续输入、外部可见性变更后的刷新、改地址后的模型列表、清/补密钥、删除，以及 FUP-02 的独立忙状态、关闭重开与现代 picker 隔离。没有据此关闭新的 U13～U18、所有 Models/聊天选择器或历史 UI 全表。

## 4. ACC-02：冷启动失败缓存仍阻止恢复

原始冷启动和带 schema 冷启动均得到以下实际链路：

1. 未成功预热该临时项目，真实 Windows ACL 建立拒绝，实际读文件返回 EPERM。
2. 真实 Server.listen + TCP 的配置来源请求返回 typed 503 MCP_SOURCE_READ_FAILED，带 ref，无配置原文/假凭据泄露。
3. 客户端取消包装请求后，权限夹具完成收尾；stage=restored。正常恢复一次，受控首次校验失败时恢复两次；中断与清理错误断言保留。
4. 直接 readFile 成功，内容与原文相同。
5. 同一服务、同一目录再次真实 HTTP 读取仍 503，期望为 200。没有调用测试专用 dispose、换目录、重启或预热去实现恢复。

新日志在最终断言前输出 ACC02_RECOVERY_OBSERVED，包括 code、stage、attempts、contentRestored、recoveredHTTP：

| Windows 样本 | 权限 | 直接内容校验 | 再次 HTTP |
| --- | --- | --- | --- |
| 冷启动，正常恢复 | restored / EPERM 已解除 | true | 503 |
| 冷启动，一次校验失败后恢复 | restored，attempts=2 | true | 503 |
| 带 schema 冷启动，两种恢复 | restored | true | 均 503 |
| 带 schema 热实例，两种恢复 | restored | true | 均 200 |

证据：permission/logs/transport-first.log、transport-cold-schema.log、transport-warm.log 及各自 exit.json。对照保持同一正式产品实现；预热样本只是定位证据，不计修复通过。

## 5. 首批额外失败与观测限制

### 5.1 OBS-01：保存与刷新交错的 409，需专项确认

首批现代布局改地址后，测试等待保存 HTTP ACK，随即点击 Get models。trace 记录：

- 03:51:48.171Z：供应商 PUT 开始，返回 200。
- 03:51:48.312Z：第一次 refresh 开始，随后返回 409 REQUEST_CONFLICT，resource=relay.auth。
- 03:51:48.427Z：第二次供应商 PUT 开始，返回 200。
- 第一次 refresh 失败后进入 finally 删除测试实体；随后又有 refresh，与删除清理交错，其失败不能单独算新产品缺陷。

测试按 URL 等待 refresh，没有区分保存自动发起的刷新与按钮发起的刷新。因此目前只能确认有这组真实交错与冲突，不能仅凭该断言宣称手动动作的最终结果一定错误，也不能因后续通过认定已修复。

四条受影响项复跑与最终联合均通过，首批 trace、modern-refresh-network.json 和日志仍保留。OBS-01 状态为待定性：后续应建立不与 finally 删除混淆的受控交错，分别识别两次命令/刷新、等待用户动作收尾，再检查最终页面、内存与磁盘。禁止靠自动重试状态变更隐藏冲突。

### 5.2 首次导航超时

首条经典布局用例在 page.goto 等待 domcontentloaded 时超过 60 秒。首次启动的 Vite ready 耗时 51.43 秒，失败截图能看到页面框架，但这不足以证明超时根因就是 Vite。后续同一源码的受影响项与联合执行均通过。

保留 ui-first.log、results-final/ 中的截图/trace，以及 first-navigation.network.jsonl。该次尚未进入要验证的供应商操作，不据此新增已确认产品 Bug；也不抹去本轮跨批存在的不稳定现象。最终报告中的 0 flaky 是 Playwright 最终单批统计，不代表历史从未失败。

### 5.3 OBS-02：Windows 正式套件收尾 EPERM

71 个正式用例通过后，test/preload.ts:31 的 afterAll 在删除隔离 opencode-test-data-13304 时抛 EPERM。preload 现有删除重试仅识别 EBUSY；本次退出码为 1，必须保留失败。

已记录残留目录清单和根 ACL，确认目标位于本轮 permission/tmp，无目录重解析点后，用原生 PowerShell 在测试进程退出后清理成功。没有更改 ACL、扩大权限、修改 preload 或忽略原错误。

这只证明随后能够清理，不证明最初 EPERM 的根因已确定。文件句柄、并发后台安装与 Windows 文件系统时序仍需受控定位；本轮没有证据将其归为 ACC-02 或权限夹具恢复失败。状态为已观察的测试收尾问题、待定位；该套件不能标绿。

证据：permission/logs/official-joint.log、official-joint.exit.json、preload-leftover-inventory.json、preload-manual-cleanup.json。

### 5.4 Linux 原始样本的文件字节差异

原始 TCP 样本在恢复后、再次 HTTP 之前验证内容相同，断言通过；新增日志在再次 HTTP 之后观察到 contentRestored=false。源码 config.ts:395 附近存在缺少 $schema 时主加载器补写 schema 的既有行为。不能据前一次字节断言声称 HTTP 之后文件也完全未变。

另建初始即包含 $schema 的对照，两条 Linux TCP 均返回 200，日志 contentRestored=true；Windows 同样样本冷启动仍 503。原联合 61 pass 的有效范围保留，但不把缺少 schema 的样本作为“全程纯读、磁盘字节零变化”的证据。来源读取是否应避免触发此类运行时加载副作用，仍按实施方案第 5.4 节处理。

## 6. 四层一致性与未执行项

| 层次 | 本轮证据 | 仍有的缺口 |
| --- | --- | --- |
| 返回结果 | ACC-01 实际请求 origin；ACC-02 实际 HTTP 状态与 typed ref；正常写链 ACK | 新增完整错误聚合/清理失败映射矩阵未实现 |
| 磁盘 | 权限恢复与原文字节校验；带 schema 对照；测试实体清理 | 未做跨服写目标与两服磁盘对照全矩阵 |
| 内存 | 正式 InstanceState/夹具断言及页面派生状态 | 没有实施后的 owner 清理账本、代次与超时观察 |
| 页面 | 两布局真实 Chromium；最终 17 项 | 经典切服仍失败；共享消费者、聊天模型选择器与历史 UI 未全验 |

U13～U18、I13～I25 是方案新增验证义务，不是已存在的通过用例。本轮未实施对应架构，不声称完成该矩阵。I01 的 Windows 恢复出口明确失败；已存在的取消/权限测试通过也不能代替新资源所有权与预算验证。

RF-07 只保留已验证的 Windows 热实例及 Linux 子范围，整体仍未关闭。macOS、R3-03B、完整历史 UI、任务/附件 UI、已安装 Electron 与 Bun 编译产物仍未验收。

## 7. 命令与日志索引

以下命令从各包目录执行；环境脚本只设置本轮隔离目录。完整脚本及配置均保存在证据根。

```powershell
# D:/opencode/packages/app
. C:/acc-acceptance-20261114-01/env.ps1 -Service app
$env:FUP_NEXT_E2E = '1'
$env:FUP_RELAY_E2E = '1'
bun node_modules/@playwright/test/cli.js test --config C:/acc-acceptance-20261114-01/playwright-joint.config.mts
bun typecheck:e2e:relay

# D:/opencode/packages/opencode；正式 test/preload.ts 仍加载
. C:/acc-acceptance-20261114-01/env.ps1 -Service permission
Remove-Item Env:/OPENCODE_DISABLE_PROJECT_CONFIG -ErrorAction SilentlyContinue
bun test --config C:/acc-acceptance-20261114-01/permission/bunfig.toml --timeout 60000 ./test/server/httpapi-config.test.ts ./test/server/config-read-permission.test.ts ./test/effect/instance-state.test.ts
bun test --config C:/acc-acceptance-20261114-01/permission/bunfig.toml --timeout 60000 C:/acc-acceptance-20261114-01/permission/transport-schema.test.ts

# Linux，本轮容器已在验收后移除
docker exec --user 1000:1000 acc-rf07-20261114-01 sh -c 'id; bun test --config /proof/bunfig.toml --timeout 60000 ./test/server/httpapi-config.test.ts ./test/server/config-read-permission.test.ts /proof/transport.test.ts'
```

Windows schema 样本：ACC_WARM 未设置为冷启动；ACC_WARM=1 为热对照。两个批次分别运行、分别记录，不能混合计数。上面命令是历史执行记录，容器及服务已清理，重新执行须重新创建隔离资源。

主要证据：

- 页面：app/logs/ui-first.log、ui-affected-second.log、ui-joint.log；results-final.json、results-second.json、results-joint.json；三批输出目录分别保留。
- 类型：app/logs/typecheck-e2e.log 与 exit.json。
- Windows：permission/logs/transport-first.log、transport-cold-schema.log、transport-warm.log、official-joint.log 及 exit.json。
- Linux：linux/joint-first.log、schema-transport.log、root-mode.log 及 exit.json。
- 对照源码：permission/transport.test.ts、transport-schema.test.ts、linux/transport*.test.ts，仅在隔离证据根，不是产品实现。
- 资源收尾：final-test-data.json、cleanup-processes.json、cleanup-final.json、linux/container-id.txt、container-cleanup.txt。

## 8. 隔离、收尾与下一步

A=44096、B=44098、共享 A 数据的第三进程=44100，上游=44097、前端=44444；均只绑定 127.0.0.1。home/config/data/state/cache/managed/tmp 独立，测试文件凭据适配器与假密钥，不访问系统凭据库。Linux 源码只读挂载；git/ripgrep 仅安装到本轮容器。

结束时三个后端的供应商数均为 0。按 PID、命令行和创建时间核对后停止 13 个本轮进程；容器按完整 ID 和任务 label 核验后移除。五个测试端口均无监听，preload 残留已单独清理，Docker 引擎未关闭。

本轮仅新增此结果文档；不修改实施报告、正式测试或产品代码。工作区和暂存区核对见 workspace-verification.json。没有把首次失败隐藏为单独复跑通过，没有扩大任何历史关闭范围。

下一步应先实施 ACC-01/ACC-02，再执行补齐后的 owner、清理、HTTP 与四层验收矩阵。OBS-01/OBS-02 先保留反例并定位，不在未证实根因时继续堆补丁。当前结论是“现状复验未通过”，不能宣布修复完成。
