# RV-01～RV-06 独立复核（2026-11-13）

结论：本轮不能将六项全部关闭。RV-01/02/03/04/06 在本轮自动复验范围内通过；RV-05 发现一项已确认残留 RV-05-R1。历史通过结果保留，但不能替代新增边界的失败证据。

本轮只检查、执行隔离测试和记录结果，未修改主项目业务代码或正式测试，未提交、推送、重启当前应用、操作生产配置、凭据、锁或迁移标记。

## 1. 已确认残留：RV-05-R1（P2）

**受保护删除已提交且请求取消后，createOnly 可以复用删除 operationId，丢失待清理凭据责任。**

位置：

- `packages/core/src/relay-auth.ts:519`：createOnly 跳过通用 replay，而 deletedCommands 的冲突检查只在 replay 中。
- `packages/core/src/relay-auth.ts:557`：createOnly 只检查 cached，未检查真实提交边界已建立的 deletedCommands。
- `packages/core/src/relay-auth.ts:305`：rememberCleanup 按 operationId 替换既有清理责任，放行碰撞后会删除原删除命令的待清理引用。

受控复现使用真实 RelayAuth、文件凭据后端及实际 FS rename，在最终替换完成后的交接屏障请求取消；没有伪造删除成功、直接改认证文件或直接操作内部 Map。

1. 创建带独立密钥的供应商，得到 auth revision 1 和 entityId。
2. 用 operationId=`cancel-delete`、expectedEntityId 和 revision=1 删除。
3. 等实际 rename 完成，再请求取消并释放屏障。删除已提交为 revision 2，deletedCommands 已登记，settleCleanup 尚未完成。
4. 在同一服务实例中，用同一 operationId 发送 createOnly=true，使用当前 revision 2、同一供应商 ID 及新的供应商信息；不携带旧 expectedEntityId。
5. 预期 REQUEST_CONFLICT，且 revision、供应商集合、待清理责任与凭据均不发生写入变化。
6. 实际创建成功，revision 2 → 3，产生新实体；pendingCleanup 数量 1 → 0。再次原样重试旧删除后，旧凭据仍在文件后端，清理记录已经丢失。

影响：同一操作编号对应两类已提交命令，违反方案 S5 的类型绑定要求，并造成已删除供应商凭据无法通过原待清理机制自动回收。原删除的精确重试仍保护后继供应商，没有观察到旧删除重试删除后继实体；本问题也不表示正常页面会自行发出碰撞编号。

根因：提交确认、返回结果缓存、创建回执各自维护，createOnly 分支的命令归属校验没有覆盖删除提交后至清理返回前的取消窗口。正式用例分别覆盖了取消后的原样删除重试、正常完成后的跨类型冲突，但未覆盖二者的交叉组合。

证据：

- 诊断：`C:/obf-20261112/packages/core/test/relay-recheck-cancelled-delete.test.ts`。
- 最终诊断与重复验证：`C:/relay-rv-recheck-20261113/core/logs/cancelled-delete-controls-corrected.log`、`cancelled-delete-repeat.log`。两次均 1 pass / 1 fail，退出码 1；失败为应拒绝碰撞却成功的产品行为断言。
- 正常完成删除的对照：同编号 createOnly 返回 REQUEST_CONFLICT；换全新编号可以正常创建，且产生新 entityId。
- 初版增强诊断曾引用未从夹具导出的 SecretStore 服务，得到 Service not found。已改为读取该夹具真实使用的隔离文件后端；旧日志保留，此夹具错误不计为产品缺陷。

## 2. 最小修复建议（本轮未实施）

1. createOnly 进入任何 receiptKey/凭据/配置写入前，检查 operationId 是否属于 deletedCommands；属于则直接返回 REQUEST_CONFLICT。保留现有创建回执的原样重试，不要直接使用通用 replay 的成功结果当作创建确认。
2. 所有其他认证写入口继续遵循相同命令归属要求，不能依赖 settleCleanup 是否写入 cached 才阻止跨命令复用。不要扩大整段写入的不可取消范围。
3. 把本次反例迁入正式删除重试套件，并覆盖碰撞目标为同 ID/另一 ID、删除后取消/清理失败、原样删除重试与新 operationId 对照。
4. 冲突断言同时核对 revision、供应商实体、凭据数量、原 pendingCleanup 引用不变；随后精确重试原删除应清掉原凭据，且不能影响合法后继。
5. 复跑 Core 认证/创建/删除/取消/跨进程联合、真实 HTTP 命令冲突及 Core 类型检查。只有新增失败反例通过后，才恢复 RV-05 的关闭判断。

## 3. 本轮实际执行结果

源码及证据：主目录 `D:/opencode`；诊断源码 `C:/obf-20261112`；证据根 `C:/relay-rv-recheck-20261113`。每包独立 home/data/config/state/cache/managed/tmp，内存 DB、测试凭据及假上游。26 个交付文件在主目录与隔离副本均与上轮交付 SHA256 一致，见 `file-verification.json`，不匹配 0；暂存为空。

| 批次 | 本轮结果 | 日志（相对证据根） |
| --- | --- | --- |
| 主目录 Core，本轮与相邻回归 12 文件 | 153 pass / 0 fail，退出码 0 | core/logs/core-regressions.log |
| 主目录 App，设置状态 7 文件 | 111 pass / 0 fail，退出码 0 | app/logs/app-regressions-explicit.log |
| Server，认证提交及目录失败 | 8 pass / 0 fail，退出码 0 | server/logs/server-commit-retry.log |
| Server，真实 probe 完成身份检查 | 1 pass / 0 fail，退出码 0 | server/logs/server-probe.log |
| Server，实际消费者失败后的 HTTP 恢复 | 2 pass / 0 fail，退出码 0 | server/logs/server-plugin-recovery.log |
| Schema，Relay 与契约规范 | 14 pass / 0 fail，退出码 0 | schema/logs/schema-regressions.log |
| 主目录 Client，Promise/Effect/契约/导入边界 | 18 pass / 0 fail，退出码 0 | client/logs/client-regressions.log |
| Core、App、Server 完整 bun typecheck | 均退出码 0 | 各包 logs/*-typecheck.log |
| 新增取消/跨命令复用诊断及正常对照 | 两次均 1 pass / 1 fail，退出码 1 | core/logs/cancelled-delete-controls-corrected.log、cancelled-delete-repeat.log |

不同批次不累加为去重用例数。原正式套件通过与新增反例失败同时成立。

首轮执行的限制均保留证据：

- App 首次未使用 `./` 显式路径，被包的默认 src 测试根过滤，仅执行 5 项，不能算完整通过。改用显式路径后实际 111 项、7 文件通过，见 app-regressions-explicit.log。
- Server 首次与 Core 联合并行时 7 pass / 1 fail：首项已返回符合断言的 HTTP 200，但整项触及默认 5000ms 上限（5001.42ms），见 server-commit.log。停止 Core 测试竞争后，仅将 CLI 测试上限设为 15000ms 复验，原业务代码和断言不变，8 项通过；首项 2941.86ms。不能把第一次失败抹去，也不能据此确认产品逻辑故障。

## 4. 保持开放的验收范围

本轮没有重新执行真实页面、已安装打包产物、Linux/macOS 或真实迁移。历史两套页面的部分通过证据仍有效，但 UI-RV 精确提交后持锁竞争、完整 UI01～UI08、R3-03B、RF-07 跨平台等仍按原矩阵保留；待验证不等于已经确认的新缺陷。

本轮结果只覆盖上述修复与相邻路径，不声明整个工作区无其他 Bug。

## 5. 后续补修完成（2026-11-13）

RV-05-R1 已按第 2 节建议补上入口检查与四项正式回归。本机交付目录 Core 联合 61 pass、Server HTTP 8 pass，Core/Server 类型检查通过。新增反例已由修复前失败变为通过；待清理责任保留、原样重试完成清理、合法新建与后继保护均已验证。该项可按本机自动证据关闭，以上失败与历史通过记录保留。

联合执行另发现并修正了竞争测试把创建确认和后续凭据读取当作原子操作的既有夹具时序缺陷，未补修版本也有对照失败证据。详细记录见 [RV-05-R1 补修结果](D:/opencode/specs/relay-rv05-r1-fix-results-2026-11-13.md)。历史界面、跨平台和迁移未验收状态不变。
