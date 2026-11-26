# 剩余缺陷复查记录（2026-11-15）

## 结论与范围

本轮针对阶段 A 认证命令归属、设置模型刷新、项目配置保存进行复查，确认 3 项未修复缺陷：2 项既有 P1 仍存在，新增确认 1 项 P2。没有修改产品代码、没有提交、没有重启应用，也没有访问生产配置/凭据。只新增本记录，复现脚本和输出均留在隔离临时根。

源码 HEAD：6b051f12a21094df1adef83f9fddfcbb765b319e。阶段 A 输出清单登记的 36 个文件在检查前后摘要均一致；.git/index 摘要不变。该核对仅覆盖登记文件，不代表所有未提交文件都已审计。

证据根：`C:\Users\zh2100\AppData\Local\Temp\acc-review-094fb0987c57439d9fe37ce0b136543f`。

## 1. OBS-01 / P1：名称保存使未完成的模型刷新失去后续责任

位置：`packages/app/src/hooks/use-relay-settings.ts:712`、`:755`、`:764`。

触发：地址/密钥保存启动旧版本模型刷新，刷新尚未完成时再次只保存名称。认证提交提高供应商版本，旧刷新因版本冲突被拒绝；第二次保存因 changed=false 不发起最新版本刷新。

影响：名称、地址已保存，模型候选仍为空或停留在旧状态，需用户另行触发模型刷新。

本轮实际运行真实 createRelaySettingsState 的受控 API 探针：版本从 1 推进至 3，只发出一次 expectedVendorRevision=2 的刷新；旧刷新返回 REVISION_CONFLICT 后，没有版本 3 的请求，最终 candidates 为空。探针命中目标条件并以 0 退出；这是缺陷复现成功，不是修复测试通过。

证据：`app-probe.ts`、`app-probe.log`、`app-probe/result.json`。本轮未重新运行真实页面；历史两布局页面失败证据见 `specs/acc-followup-acceptance-results-2026-11-14.md`，相关源码摘要未变。

修复方向：按服务器、供应商实体保存独立刷新需求；后续名称或空补丁提交提高版本时接续未完成需求。旧刷新失效后，对最新版本合并补刷，限定取消、清钥、删除及重建时的终止条件。保留服务端实体/版本校验，不能放松版本校验或自动重放保存。

## 2. ACC-F02 / P1：项目配置写入文件不参与回读

位置：`packages/opencode/src/config/config.ts:925`、`:927`；`packages/opencode/src/config/paths.ts:11`。

根因：Config.update 固定写入项目 config.json；项目加载器发现的是 opencode.json/jsonc。提交成功、发出重载通知及重建实例，都不能令一个未参与加载的文件生效。

本轮重新运行真实 TCP 测试：

```powershell
# 在隔离环境、packages/opencode 目录执行
bun test --timeout 120000 ./test/server/httpapi-config.test.ts -t I30
```

实际结果：1 pass、3 fail、30 assertions、退出码 1。

- 提交后断连并放行发布：磁盘新值、通知一次，GET 仍旧值，失败。
- 已发布、回包前断连：GET 仍旧值，失败。
- 正常连接保存：PATCH 200 且返回新值，实例重建后 GET 仍旧值，失败。
- 投递后发布被拒绝：原字节保持、无提交通知，后续 GET 正确，通过。

证据：`config-http.log`。测试独立临时监听端口并自行停止，没有启动或停止用户应用。

修复方向：实施方案阶段 C 的共享项目来源/写入目标规则，明确 opencode.json/jsonc 共存、继承、显式覆盖和禁用项目配置的行为；保存后必须以同目录 GET、重建和磁盘对账验收。不要直接把任意第三方 config.json 纳入项目加载。

## 3. AUTH-REPLAY-01 / P2：服务重建后，清理结果被兼容删除误当成成功回执

位置：`packages/core/src/relay-auth.ts:321`、`:416`、`:417`、`:530`、`:708`、`:717`。

边界：删除请求未提供 expectedEntityId，并复用了先前更换密钥的 operationId。公开协议仍允许省略 expectedEntityId（`packages/protocol/src/groups/relay.ts`），Server handler 原样传入 Core。因此这是兼容路径可达缺陷；正常使用新实体保护且操作编号独立的请求不属于本复现。

确定性步骤：

1. 在临时数据根创建假供应商，使用内存凭据适配器，不触及系统凭据。
2. 用 operationId=rotate-id 更换密钥；让旧密钥删除失败，形成 pendingCleanup，提交版本为 2。
3. 销毁并重建 RelayAuth 服务，使内存命令指纹丢失。初始化处理 pendingCleanup，会通过 rememberResult 生成仅含 result 的缓存条目，没有 command。
4. 发起 deleteVendor，省略 expectedEntityId，传当前 revision=2，并复用 rotate-id。
5. replay 无 command 的分支把通用清理结果当作删除结果直接返回。实体未删除，版本仍为 2，请求却成功。

已在真实 Core 服务复现两种情况：重建后清理继续失败，以及重建时清理成功。两者均返回 Result.Success、stillPresent=true、beforeRevision=afterRevision=2；第二种 cleanupPending=false。两次探针退出码 0 表示复现脚本完成，不表示期望行为通过。

证据：`auth-probe.ts`、`auth-probe.log`、`auth-probe-result.json`；`auth-probe-cleanup-ok.ts`、`auth-probe-cleanup-ok.log`、`cleanup-ok/auth-probe-result.json`。

根因：阶段 A 已把普通 set/clear 的重放证据绑定命令指纹，但未统一约束没有 expectedEntityId 的删除入口。pendingCleanup 和初始化缓存只证明清理责任，不能证明删除的种类、目标实体或请求版本。

修复方向：清理重试与业务成功回执分离。所有删除路径仅在拥有该删除命令的确切归属证据时确认重放；普通清理编号或无 command 的缓存不能返回删除成功。缺少证据或跨命令种类复用应冲突；保留受保护删除的精确重试、后继实体保护和创建持久回执。加入重建前后、清理成败、其他供应商、旧/新删除入口矩阵。若选择更改旧客户端兼容契约，先明确接口行为，不得无说明地强制必填。

## 验证限制与未关闭项

本轮是定向复查，不能据此保证全部未提交内容没有缺陷。阶段 B/C 尚未实施；65 项矩阵是验证义务，不是 65 个已确认缺陷，也不能因阶段 A 后端历史通过就整体关闭。

真实两布局页面联合验收、R3-03B 产品迁移及跨平台/打包验收、RF-07 Linux/macOS/root 验证继续保留未关闭状态。它们与以上 3 项已确认缺陷分开管理。本轮未修改源码，因此未重复执行全包类型检查。

## 隔离与证据说明

所有新进程均在加载产品模块前设置独立 OPENCODE_TEST_HOME、HOME/USERPROFILE、XDG_DATA/CONFIG/CACHE/STATE、TEMP/TMP 和内存数据库，并移除继承配置覆盖。Core 使用明确临时 Global 层和内存凭据适配器；OpenCode 使用包 preload 再隔离。临时证据保留供复核，无生产清理操作。

`baseline-check.json`、`final-source-check.json` 记录摘要核对；历史失败和通过记录均未覆盖。本记录新增不属于登记产品源码漂移。
