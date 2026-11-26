# 七项修复 Linux 续验报告（2026-11-15）

结论：**本轮 Linux 联合门禁未通过，不能据此关闭跨平台验收。** Windows P0–P6 的既有通过结果保留。Linux 权限、真实传输取消、凭据与调度路径取得通过证据；配置兼容契约、路径别名断言和子进程时序门禁仍有待处理项。本轮只验收、诊断和更新文档，没有修改产品代码或测试断言。

## 1. 候选与隔离

- 仓库 `D:\opencode`，分支 `dev`，HEAD `6b051f12a21094df1adef83f9fddfcbb765b319e`。
- 沿用 Windows 已验源码与生成物。Linux 输入快照和测试结束快照逐文件一致，暂存语义一致；验收之后仅更新交付文档，另行登记差异。
- 证据根：`C:\Users\zh2100\AppData\Local\Temp\seven-bugs-20261115-036ea436c30e42c58c666d0d50cb3ed2\linux-20261115-151752`。
- Docker Linux amd64、Bun 1.4.3、Node 24.22.3；主测试以 uid/gid 1000:1000 执行，root 跳过统计单独以 uid 0 执行。
- 仓库和证据目录均只读挂载。依赖沿用仓库现有安装，不修改依赖；专用容器安装诊断工具之后断开 bridge，最终 Networks 为 `{}`。测试临时数据在容器可执行 `/tmp` 中。
- 每批经 `script/test-isolated.mjs` 在导入前建立专用 home/data/config/state/cache/tmp；OpenCode 保留正式 `test/preload.ts`，没有加载终端 JSX preload。命令及退出码见 `commands.json`、`results.json`，环境见 `platform.json`、`platform-capabilities.json`、`final-mounts-networks.log`。
- 没有重启用户应用、访问付费模型、写生产凭据或迁移标记、启用 migration apply、替换生产锁后端。未提交、未推送、未改版本。

## 2. 首次联合批次（保留原结果）

| 批次 / 日志 | pass | skip | fail | 退出码 |
| --- | ---: | ---: | ---: | ---: |
| `permission-http.log`：配置 HTTP、权限夹具、真实传输取消 | 86 | 2 | 0 | 0 |
| `root-mode-skip.log`：root 的 POSIX mode 权限用例统计 | 0 | 1 | 0 | 0 |
| `relay-secrets.log`：凭据、认证、创建/删除与重放 | 142 | 0 | 0 | 0 |
| `scheduled-runner.log`：调度、授权、真实 runner、wire、取消与错误载荷 | 294 | 0 | 0 | 0 |
| `shared-document-locks.log`：共享文档、原子发布与锁生命周期 | 66 | 2 | 1 | 1 |
| `config-matrix.log`：配置、来源、TUI 及 InstanceWork | 359 | 3 | 3 | 1 |

六批执行统计为 947 pass、8 skip、4 fail；批次间可能覆盖同一行为，不作为独立行为覆盖数。另一次 POSIX 首跑为 1 pass，不重复累加。以上统计不包含后续诊断和复跑，也不以复跑覆盖首次失败。

权限批次的两个 skip 分别是 Linux 不适用的 Windows ACL 用例、既有无条件框架跳过的 T13；后者不能冒充已验证。root 专项确实为框架 skip，未算通过。Core 两个 skip 是 Windows DACL、缺失 Linux 原生锁模块；配置三处 skip 是仅 Windows 的键绑定用例。

## 3. 已取得的 Linux 证据

1. uid 1000 实际 chmod 拒读产生 EACCES；正式 HTTP 返回安全 503/ref，恢复后无需重启或销毁实例即可 GET 200。权限夹具的恢复/错误保留断言通过。
2. 两条 `RF07_TRANSPORT_EVIDENCE` 记录真实 TCP 取消：请求已中断、权限最终 restored、恢复后 HTTP 200。正常恢复用一次；注入第一次恢复校验失败的样本用两次，保留原错误/中断。拓扑为测试专用 Node HTTP wrapper 驱动权限夹具，内部访问真实 `Server.listen`；不是产品 API 修改文件权限。
3. 凭据/认证矩阵 142 项和调度/真实 runner 矩阵 294 项通过。受控上游为 loopback/cassette replay，外网已断开。
4. POSIX 共享文档 owner/group/mode 断言通过；目录符号链接的规范化身份与 legacy 别名拒绝路径得到执行。

这些结果仅扩展对应子场景证据。没有运行 Linux 页面、Linux 原生锁、安装版 Electron 或 Bun 单文件验收，也没有在 Linux 重做全部包类型检查。

## 4. 未通过项及根因

### LNX-01：不可访问自定义配置目录的兼容契约冲突（待处理）

位置：`packages/opencode/src/config/config.ts:446`、`packages/opencode/test/config/config.test.ts:1176`。

原用例将空 `OPENCODE_CONFIG_DIR` chmod 000，约定 `Config.use.get()` 成功。Linux uid 1000 首跑和原样复跑均因读取该目录下 `opencode.json` 的 EACCES 失败；复跑见 `config-failures-rerun.log`。

根因已定位：HEAD 的 `readConfigFile` 使用 `FSUtil.readFileStringSafe`，同时将 NotFound、PermissionDenied 视为无配置；本轮实现换成直接读取，仅 ENOENT 返回缺失，其余成为 defect。于是目录无搜索权限时，尚未确认文件是否存在就失败。Windows 该旧用例直接 return，不执行权限动作，不能证明这项契约兼容。

这是相对既有测试的真实行为变化，不能简单归为容器慢或直接删除旧断言；也不能把所有 EACCES 重新吞成空配置，因为 F09/RF-07 已要求必要来源和引用拒读时安全失败、不回退改写其他文件。当前方案对 PATCH 的严格读取规则，尚不足以单独决定普通运行时 GET 对“不可遍历的可选目录”应采用何种兼容策略。

处理要求：先明确可选目录发现、明确指定来源、必要继承文件/引用、冷态 GET/PATCH 的读取契约；再让 discovery、普通加载、只读快照和预检遵循同一规则。补足目录不可遍历、文件拒读、缺失、只读可读目录、恢复后重读及不泄密/不改盘矩阵。若选择严格拒绝，需要显式更新兼容说明与对应安全错误断言；若保留可选目录忽略，必须限制在可证明可选的发现阶段，不得吞掉已选来源读取失败。本轮没有替产品决定该兼容变更。

### LNX-02：别名测试把“原路径哈希必须变化”当作通用规则（测试缺陷）

位置：`packages/opencode/test/config/config.test.ts:1817`。

真实入口已证明 source 与 symlink alias 归为同一身份、原锁阻塞 updateMcp、只存在规范键锁、源文件未写入 alias。失败发生在要求目录中不能包含原 source 哈希的否定断言。

Linux 的原 source 已为绝对真实路径且不需要大小写转换，其 raw key 本来就等于 canonical key。`key-proof.log` 的三个独立断言确认：raw(source) == canonical(source) == canonical(alias)，raw(alias) 的哈希才不同。因此这条否定断言与前面的“包含规范锁”相互矛盾。

修正要求：保留真实 updateMcp 阻塞、两身份相等、唯一规范锁、原文件字节不变的验证；以未经规范化的 alias 键检查不能产生第二把锁，或仅在原 source 键确实不同的分支验证其不存在。不能通过删除互斥断言放过真实分叉。本轮未改测试，门禁仍失败。

### LNX-03：锁 worker 的 5 秒 ready 门禁不足（原门禁仍失败）

位置：`packages/core/test/util/effect-flock.test.ts:720`。

原用例首跑和单独原样复跑均在等待 ready 的 5 秒限时失败，尚未进入终止/恢复步骤。`worker-timing.log` 测得原 worker 到实际持锁后写 ready 为 7620.78ms。另一个保留原 worker/锁步骤的补充诊断 `crash-probe.log`，允许更长启动观察窗口，7116.07ms 到 ready，随后终止 owner、按原用例回拨临时锁时间、继任者成功获取且 done 恰为一行，整个诊断约 14.23 秒。

因此本机样本支持锁恢复功能可用、原 ready 门禁不足；补充诊断不等于原门禁已通过。修正方向是分开启动/模块加载就绪、真正取得锁、业务执行/恢复的阶段信号与截止时间，并保留失败时子进程 stderr/退出状态及最终回收。不能只把所有超时无限调大。

尚不能据此断言超时完全由 Docker 挂载导致：临时 bundle 对照的 worker 在 40 秒内没有 ready，该对照未形成结论；其布局与原源码不同，不用于证明锁失败或打包验收通过。对应日志和 bundle 摘要保留。

### LNX-04：刷新责任测试的 10 秒整进程时限波动（待稳定）

位置：`packages/opencode/test/config/refresh.test.ts:17`。

首批 `close-running` 子进程被 10 秒 `execFile` 时限 SIGTERM。原样单独复跑通过，8415.43ms；随后完整四场景复跑为 3 pass、1 fail：`close-running` 8447.25ms 通过，但 `early-recovery` 又被 10 秒时限终止。原首批 `early-recovery` 本身通过。证据见 `refresh-running-rerun.log`、`refresh-full-rerun.log`。

失败会在场景之间变化，进程总时间接近阈值；现有证据未复现业务断言失败，也未证明纯环境问题。临时 bundle 的 `close-running` 6687.85ms 完成，仅作诊断，不替代原门禁。修正方向同 LNX-03：显式发布启动和场景阶段信号，分别限制启动与业务收尾，记录被终止前阶段，并用同候选联合复跑证明稳定。此次不能关闭 F36 的 Linux 联合门禁。

## 5. 后续顺序与关闭条件

1. 先裁定 LNX-01 的读取契约并实施最小修正，目录权限和文件权限分别验证，保留 F09/RF-07 安全失败与原文件不变要求。
2. 修正 LNX-02 的平台错误假设；Windows junction 与 Linux symlink 均执行真实入口、互斥与磁盘检查。
3. 为 LNX-03/04 补阶段就绪和诊断，保留有限截止与子进程回收；不能仅以单跑通过关闭。固定修改后候选，重跑配置/共享锁的完整 Linux 批次及受影响 Windows 保护项。
4. 只有原适用联合门禁均通过、失败与 skip 如实登记，才更新这些 Linux 子项状态。macOS、Linux 原生模块、真实迁移与产品打包布局另立对应环境门禁，R3-03B 整体仍不关闭。

## 6. 清理与交付范围

测试结束时再次逐文件核对，`manifest-tested.json` 相对 `manifest-input.json` 无变动、无删除，暂存语义一致。随后仅新增本报告并给原方案/实施报告/矩阵增加续验链接；`manifest-delivery.json` 单列这些文档差异。

已核对专用容器完整 ID 与登记一致，确认没有活动测试 worker 后停止并删除 `seven-linux-20261115-151752`。容器的 `/tmp` 隔离根和诊断 bundle 随之释放；host 日志、脚本、摘要保留。收尾扫描未发现遗留 mode000 文件或目录，该扫描仅为辅助，恢复成功的主要证据来自夹具断言与恢复后 HTTP 200。既有 PostgreSQL、Redis 容器未操作，原启动时间保持。见 `cleanup.json`、`permission-final-audit.json`、`processes-final.log`、`existing-containers-final.log`。

本轮没有把任何失败改写成通过，没有更改原 Windows 验收结果；整体结论仍为 Linux 续验未通过。
