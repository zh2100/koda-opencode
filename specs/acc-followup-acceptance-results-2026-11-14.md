# ACC 后续验收记录（2026-11-14）

本轮结论：**未通过整体验收。确认两个产品缺陷；保留失败回归，未修改产品实现。**

## 1. 固定候选与隔离范围

- 分支 `dev`，HEAD `6b051f12a21094df1adef83f9fddfcbb765b319e`。
- 开始前对照上一轮 `candidate-final.json` 的 35 个产品/测试文件，摘要没有漂移。上一轮产品/测试聚合摘要为 `CE3E1F4C9EB56F4F8D00D8C1E58F80F7FA9E6F96BF009EA9D8D1310B2F3C1ADE`。
- 最新候选启动独立真实后端及 Vite，未重启用户应用。primary/secondary 数据隔离；external 只共享本轮 primary 测试根。假凭据使用测试文件适配器，没有系统凭据写入。
- 端口：44096、44097、44098、44100、44444，启动前无监听。本轮没有使用 Docker，没有变更用户 Docker 状态。
- 本轮只改验收测试与测试类型检查清单：新增 `packages/app/e2e/regression/relay-settings-refresh-interleave.spec.ts`，扩展 `packages/opencode/test/server/httpapi-config.test.ts`，将新页面测试加入 `packages/app/e2e/tsconfig.relay-settings.json`。另新增本报告。
- 结束对照原 35 文件，只有上述 HTTP 测试发生预期变动，产品源码均保持原摘要。没有 commit、push、版本变更或暂存操作。
- 开始/结束 `.git/index` 摘要相同：`C1F4E932CC73091758D88DDDD3299B0D2BF8A6AB2B878AA5CF7DA3924932B5CD`；暂存内容均为空。

证据根：

```text
C:\Users\zh2100\AppData\Local\Temp\opencode-acc-next-7c1dc70bddf748afa7d901e3712e4b7e
```

`baseline.json`、`workspace-check.json` 保存候选与工作区核对。历史报告 `acc-root-cause-fix-results-2026-11-14.md` 及其失败日志没有覆盖。

## 2. OBS-01：名称保存使尚未完成的模型刷新失去后续责任（P1，未修复）

### 2.1 确定性复现

经典、现代布局分别执行，不使用固定延时或重试写操作：

1. 真实 HTTP 创建独立供应商，地址为假上游 `/first`，密钥为假值。
2. 在实际设置页把地址改为 `/second`，点击 Save。保存返回 200，供应商版本变为 2。
3. 在页面发出的自动模型刷新处建立屏障：请求携带版本 2，但尚未送达后端。
4. 编辑供应商名称，再次点击 Save。保存返回 200，供应商版本变为 3。
5. 放行自动刷新。后端拒绝版本 2 的请求，返回 409。
6. 页面没有 `model-second`；真实 `/api/relay/models/sync` 的该供应商候选也为空。HTTP auth 与磁盘中的名称、地址均已更新为第二次保存的值。
7. 全部动作收尾后销毁页面 owner，再用最新 revision/entityId 删除夹具；删除返回 200。

专项两批都在两种布局复现，不能将其归为一次页面超时。带状态对账的批次为 `ui/playwright-interleave.log`，结果 **2 pass、2 fail，退出码 1，retries=0**。

动作关联结果：

| 路径 | 地址保存 | 后续动作 | 旧自动刷新 | 最终候选 | 夹具删除 |
| --- | --- | --- | --- | --- | --- |
| 自动刷新挂起 → 手动 Get models，经典/现代 | 200 | 手动刷新 200 | 409 | 有 `model-second`，通过 | 200 |
| 自动刷新挂起 → 只保存名称，经典/现代 | 200 | 名称保存 200 | 409 | 空，失败 | 200 |

手动路径中的 `persistDraft` 也提交配置并提高版本，但会自行刷新最新版本，所以最终列表正确。过期请求的 409 本身是有效保护；本缺陷是失去后续刷新，而不是应该接受过期结果。

`ui/results-interleave.json` 每条用例的 `action-results` 记录动作、状态和版本；`settled-state` 记录安全裁剪后的磁盘字段、auth 和候选。失败 trace 保留在对应 `results-interleave/relay-settings-refresh-int-*/trace.zip`。页面关闭发生在 finally，因此不能假定 runner 会在关闭后生成失败截图；本结论以 trace、页面断言与接口/磁盘对账为证。

### 2.2 根因

- `packages/app/src/hooks/use-relay-settings.ts:712` 只把地址/密钥变化算作 `changed`；名称保存的 `changed` 为 false。
- 同文件 `saveVendor` 只有本次 `changed` 且满足条件时才调用 `loadCatalog`。没有把前一次尚未完成的刷新责任交给最新版本。
- `packages/core/src/relay-auth.ts:591` 每次保存均递增供应商版本，包括名称保存。
- `loadCatalog` 发送 `expectedEntityId/expectedVendorRevision`，认证层严格核对。因此旧刷新被正确拒绝，但名称保存不补发最新版本的刷新。

这不是磁盘保存失败，不是 finally 删除造成的 409，也没有证据要求放松服务端实体/版本检查。

### 2.3 后续修复边界

1. 将“需要刷新目录”的责任按服务器、供应商 entityId 和最新目录依赖保存，不只挂在触发它的 Save Promise 上。
2. 后续名称保存或空补丁提高版本时，保留尚未完成的刷新需求。过期刷新完成/冲突后，若实体仍在、密钥仍有效且需求未被较新成功结果满足，合并发起最新版本的一轮刷新。
3. 对清钥、删除、换服、销毁、同名重建明确终止/移交责任，不能让补刷恢复旧实体。
4. 保留版本保护及同命令幂等语义；不要自动重放 Save 或无限重试刷新。
5. 当前四个页面样本必须全部转绿；增加空补丁保存、刷新已到上游/ACK 晚到、失败与清钥/删除交错的回归，再核对页面、HTTP、磁盘和候选。

## 3. ACC-F02：项目配置保存与加载路径不一致（P1，未修复）

### 3.1 真实 TCP 证据

测试使用真实 `Server.listen` 和 HTTP。取消样本在产品调用 `AtomicDocument.publish` 后通过屏障控制，再用 Node HTTP client 的 `destroy()` 真正关闭连接；不是仅中断测试等待者。

最终来源对照批次 `tcp-disconnect-source-control.log`：**1 pass、3 fail，30 assertions，退出码 1**。

| 样本 | 已验证的收尾 | 最终回读 | 状态 |
| --- | --- | --- | --- |
| 投递后断连，再放行真实发布成功 | 发布只调用 1 次；磁盘含新值；reload hook 1 次；等待实例 disposed 后回读 | 仍为 `tcp-before` | 失败 |
| 投递后断连，受控发布边界拒绝 | 原文件字节不变；没有提交通知；后续 GET 200 且仍为旧值；未重放 | 正确 | 通过 |
| 真实发布完成、回包尚挂起时断连 | 磁盘含新值；reload hook 1 次；等待实例 disposed 后回读 | 仍为 `tcp-before` | 失败 |
| 全程正常连接的对照 | PATCH 200 且正文含新值；磁盘含新值；等待实例 disposed | GET 200 但仍为 `tcp-connected-before` | 失败 |

前置 GET 明确断言读到当前项目的旧标记，避免把默认用户名或错误项目当作证据。提交成功样本在磁盘和通知断言之后才在 GET 回读处失败。正常连接同样失败，排除了“只是取消导致缓存尚未刷新”的解释。

受控拒绝在发布函数入口抛出，不代表真实 EIO/ENOSPC 或全部文件系统阶段故障已经验收。

### 3.2 根因

- `packages/opencode/src/config/config.ts:925` 的项目 `update` 固定写入 `<project>/config.json`。
- 同文件 `:670` 的项目读取调用 `ConfigPaths.files("opencode", ...)`。
- `packages/opencode/src/config/paths.ts:11` 因而只发现 `opencode.jsonc` 和 `opencode.json`，不加载项目 `config.json`。
- 实例清理、重建或服务通知不能使一个未参与来源发现的文件生效。现有默认 HTTP 保存回归只验证 ACK、disposed 和磁盘，没有继续 GET 同目录，因此漏掉了这一点。

这是普通项目 `/config` PATCH→GET 的闭环缺陷；不能据此推定 MCP 定向来源保存也存在同一问题。

### 3.3 后续修复边界

1. 先定义项目写入目标及来源优先级：已有 `opencode.json/jsonc`、二者共存、父项目继承、`.opencode`、显式配置与禁用项目配置分别写向何处。
2. 让读写共享目标/来源规则。不要简单将任意项目的 `config.json` 加入搜索，避免加载第三方同名文件或改变已有优先级。
3. 若已有旧保存写出的 `config.json` 需要兼容，明确识别、冲突和迁移策略，不能静默覆盖有效 `opencode.json/jsonc`。
4. 保留 ConfigDocument 锁、AtomicDocument 发布、来源/版本复检和服务层 handoff；不要通过仅修改内存缓存掩盖重新加载后的丢失。
5. 当前正常 TCP 和两条成功提交后的取消回归必须转绿，拒绝样本继续保持原字节；再补冷启动、重开、来源组合和并发写入对账。

## 4. 首次失败及各批次结果

以下是独立批次，不累加为一个通过总数。

| 日志 | 结果 | 解释 |
| --- | --- | --- |
| `ui/playwright-next.log` | 18 pass、3 fail；退出码 1 | 17 条既有页面 + 4 条新交错。两项新缺陷失败，另一项为首次供应商读取未及时完成 |
| `ui/playwright-interleave.log` | 2 pass、2 fail；退出码 1 | 增加失败时的安全状态对账；两种布局名称保存仍失败 |
| `ui/playwright-warm-control.log` | 1 pass；退出码 0 | 单独复验首条既有 busy 用例；不覆盖首批失败 |
| `tcp-disconnect-first.log` | 0 pass、3 fail；退出码 1 | 新测试误以为 tmpdir(config) 已创建 config.json；夹具实际创建 opencode.json。未进入预期发布边界 |
| `tcp-disconnect-second.log` | 1 pass、2 fail；退出码 1 | 显式创建目标后，提交成功的两条样本在 GET 回读失败 |
| `tcp-disconnect-final.log` | 1 pass、3 fail；退出码 1 | 加入正常连接和等待 disposed 的对照 |
| `tcp-disconnect-source-control.log` | 1 pass、3 fail；退出码 1 | 用项目旧值标记确定来源，最终重现读写不一致 |
| `app-typecheck.log` | 退出码 0 | App 包类型检查 |
| `opencode-typecheck.log` | 退出码 0 | OpenCode 包类型检查 |
| `relay-e2e-typecheck.log` | 退出码 0 | 含新增交错页面样本的 relay E2E 类型检查 |

首条既有 busy 失败的 trace 中：页面 GET `/api/relay/auth` 耗时 **21836.356ms**，超过随后 20 秒的供应商按钮断言。该 GET 的响应含两个正确供应商；断言失败进入 finally 后删除第一项，后续 sync 的快照才只剩第二项。不能据清理后的截图断言此前保存丢了第一项。独立热态复验通过，但尚未定位这 21.8 秒的服务端/系统瓶颈，因此保留为冷态耗时观察项，不宣称已修复或归因于 Vite。

类型检查不能代替行为验收。故意保留两项缺陷对应的失败回归，没有放宽期望或改成 skip。

## 5. 本轮关闭边界与剩余项

- OBS-01 现在已完成关键定性：手动刷新交错正常；再次名称保存交错存在确定缺陷。**OBS-01 不关闭。**
- I30/I31 的真实断连样本已补，投递后拒绝的收尾样本通过；成功提交后的回读被 ACC-F02 阻塞，不能关闭整个 I30～I39。
- 最新后端已参与本轮页面验收，补了上一轮“服务启动后又修改后端”的候选限制；这不表示所有后端新代码的故障分支都被页面覆盖。
- 尚未执行：共享冷启动请求中单个取消、编码失败/不执行 pre-response 的专门注入；独立共享 SSE/query 消费者全过程；每个切服写动作的 A/B 磁盘完整矩阵；所有 fs 阶段/Windows 共享句柄/未知结果 reconcile；真实 Snapshot tick 写入中退出与所有 producer 的晚到组合；TOML 迁移完整取消/失败矩阵。
- OBS-02 的历史 EPERM 精确句柄仍未实证；R3-03B、RF-07 跨平台整体、macOS、安装版 Electron 和 Bun 单文件仍保持原状态。

## 6. 收尾与复验方法

- `ui/process-tree-before-stop.json` 保存四个 wrapper 及其实际后代。按命令行、创建时间和父子链确认后停止共 13 个自建进程，包括 Vite 的 esbuild；没有按端口杀未知进程。
- `ui/service-cleanup.json` 确认 owned 进程及五个端口均无残留。
- `ui/data-cleanup.json` 记录精确移除的 14 个已创建假数据目录，均在本轮 proof/ui 下；保留日志、trace、状态对账和脚本，没有删除历史证据或生产目录。
- 定向 diff 检查退出码 0。原有未提交修改保留，未暂存。

后端复验在 `packages/opencode` 的隔离进程环境执行：

```text
bun test --timeout 120000 ./test/server/httpapi-config.test.ts -t I30
```

页面需要重新启动独立服务并创建新的假数据根，不能使用已清理的数据目录直接重跑。使用本轮 `ui/run.ps1`、`env.ps1`、`server.mts` 和 Playwright 配置作为结构参考，必须替换 proof 路径并重新验证端口与目录归属；启用 `ACC_REFRESH_E2E=1`，将 `ACC_REFRESH_DATA_ROOT` 指向该次 primary 的 `data/opencode`。正式新增样本有隔离开关，未配置时不会访问普通应用。

修复后应先运行当前失败回归，再执行既有 17 条页面、相关配置/并发/取消套件和类型检查。必须追加新批次结果，不能覆盖本报告中的失败记录。
