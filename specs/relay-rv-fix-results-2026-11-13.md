# RV-01～RV-06 修复实施结果（2026-11-13）

本轮六项代码修复已交付到 D:/opencode。自动验证通过；两套真实设置布局的清密钥旧 ACK、提交后待同步、只重试刷新、正常获取和模型勾选已通过。本轮真实页面尚未复现“模型提交后另一持锁者介入”的精确时序，因此 UI-RV 仍为部分验收，不能将整批或历史完整界面表全部关闭。

没有提交、推送、改版本、重启当前应用或服务器，没有操作生产配置、凭据、锁及迁移标记。R3-03B、RF-07 跨平台和其他历史未验收项保持原状态。本报告只覆盖本批允许范围，不声明工作区所有 Bug 已消除。

## 1. 实施范围与根因处理

| 编号 | 已交付修改 | 本机结论 |
| --- | --- | --- |
| RV-01 | probe 使用原捕获凭据发送；上游成功后，在既有只读事务中重核 entityId、供应商 revision、baseURL、hasKey。过期成功返回 REQUEST_CONFLICT，不向新地址补发。 | Core 变更矩阵、无变化/无关供应商对照及本地上游真实 Handler 通过。两套设置页面当前没有调用 probe 的按钮，未编造页面入口。 |
| RV-02 | 在现有原子提交/内存安装边界，根据权威 refreshRequests 判定自身责任结束。自身 token 已删除或被后继替代时不再多取一次锁；仍持旧 token 的被拒结果继续条件清理。 | 真实文件锁竞争、旧响应/后继保护、失败/取消、有界清理及真实子进程回归通过。页面上的精确竞争时序未执行。 |
| RV-03 | 将 clear-key 的命令确认与整份 Auth 快照接纳分开。只清同 scope、生命周期、实体、字段值和编辑代次均匹配的已提交草稿；旧 ACK 不再失效较新的目录。 | 旧 ACK、新编辑、改回原值、同 ID 重建、失败、销毁、切服务器通过；两套真实布局确认下一次保存不重交旧 key。 |
| RV-04 | 三个认证写 Handler 返回已提交事实和可选 catalogSync；预期目录失败返回 pending，认证失败仍沿原错误，中断与未知缺陷不伪装成功。两套布局显示既有本地化提示，仅重试 models.sync。 | 三写入口、真正认证冲突、新建确认、乱序/切服务器/旧服务兼容通过；两套页面仅重试同步且 auth revision 不再增长。 |
| RV-05 | 本服务内绑定受保护删除的 operationId、供应商、原实体与原请求 revision。真实提交后才登记；原样重试只确认当前状态并补自身清理，不能删除同 ID 后继。 | Core/真实 HTTP、改命令、清理失败、提交前失败、实际 rename 后取消及后继凭据保护通过。保证限同一服务存活期，未增加跨进程或重启后的永久删除确认承诺。 |
| RV-06 | 单次实际插件消费最多尝试三次，退避 100/200ms；非中断失败保留诊断并继续订阅。显式 retryNotice 可在发布端 idle 时发一轮失效通知，并合并并发恢复；普通 sync 不制造事件循环。 | 真实文件读取失败、reload 失败耗尽、无新配置的实际 HTTP 恢复、后续事件、并发显式恢复及作用域取消通过。发布成功仍不代表所有消费者已确认。 |

主要实现位于：

- [Core Auth](D:/opencode/packages/core/src/relay-auth.ts)、[目录事务](D:/opencode/packages/core/src/relay-catalog.ts)、[真实插件](D:/opencode/packages/core/src/plugin/provider/leidiandonghua.ts)。
- [HTTP Handler](D:/opencode/packages/server/src/handlers/relay.ts)、[公开 Schema](D:/opencode/packages/schema/src/relay.ts)。新增 auth-commit-outcome-v1 能力；没有扩展公开错误联合。
- [共享设置状态](D:/opencode/packages/app/src/hooks/use-relay-settings.ts)、[经典布局](D:/opencode/packages/app/src/components/settings-providers.tsx)、[新布局](D:/opencode/packages/app/src/components/settings-v2/providers.tsx)。新增的待同步状态按 scope 和供应商版本隔离。
- Client 与旧 JS SDK 均通过正式生成器更新；实际变化仅为两份生成类型文件。没有手改生成代码。

## 2. 验证环境与修复前证据

源码验证根 C:/obf-20261112；本轮证据根 C:/relay-rv-fix-20261113。Windows、Bun 1.4.3。每包独立 home/data/config/state/cache/managed/tmp，内存数据库、文件或内存测试凭据及假 key；真实 HTTP 上游仅使用本机测试服务。

原诊断样本已迁入正式测试文件；隔离副本中的过时重复诊断已删除，没有把临时诊断同步回项目。历史报告和通过记录保留。

| 修复前正式样本 | 实际结果 | 日志（相对证据根） |
| --- | --- | --- |
| Core 初始定向样本 | 3 pass / 5 fail，退出码 1 | core/logs/red-core.log |
| App 旧清密钥 ACK | 1 pass / 1 fail，退出码 1 | app/logs/red-app.log |
| 三个认证写出口与删除重试 | 4 pass / 4 fail，退出码 1 | server/logs/red-http.log |

这些 fail 是正确行为断言的修复前证据，不计作修复后通过。各变体不重复计为新 Bug。

## 3. 最终自动验证

下列命令均从相应包目录执行，并通过 run.ps1 或 run-main.ps1 设置隔离环境。日志记录 Bun 实际计数；退出码已核对实际进程结果。不同批次存在重复样本，不相加成总用例数。

| 验证批次 | 结果 | 日志（相对证据根） |
| --- | --- | --- |
| Core 本轮与相邻正式联合批次，12 文件 | 152 pass / 0 fail，退出码 0 | core/logs/final-core-union.log |
| 最后追加的消费者取消回归连同其两个对照 | 3 pass / 0 fail，退出码 0；其中前两项已在上述联合批次 | core/logs/final-plugin-cancellation.log |
| 交付目录 Core 本轮定向，含最终取消样本 | 16 pass / 0 fail，退出码 0 | core/logs/delivery-core-targets.log |
| 调度模型身份消费者 | 8 pass / 0 fail，退出码 0 | core/logs/final-scheduled-identity.log |
| 交付目录 App 最终完整设置联合批次，7 文件 | 111 pass / 0 fail，退出码 0 | app/logs/delivery-app-final-union.log |
| Server 实际 probe Handler | 1 pass / 0 fail，退出码 0 | server/logs/final-relay-probe-completion-handler.log |
| Server 认证提交/目录失败/删除重试 | 8 pass / 0 fail，退出码 0 | server/logs/final-relay-commit-handler.log |
| Server 实际插件耗尽后的 HTTP 恢复 | 2 pass / 0 fail，退出码 0 | server/logs/final-relay-plugin-recovery-handler.log |
| Server 既有真实认证与跨进程确认 | 4 pass / 0 fail，退出码 0 | server/logs/final-relay-auth-handler.log |
| Server 首次目录/隔离保留生命周期 | 2 pass / 0 fail，退出码 0 | server/logs/final-relay-catalog-lifecycle-handler.log |
| Schema 可选属性、标识和契约规范 | 14 pass / 0 fail，退出码 0 | schema/logs/final-schema-fixed.log |
| 交付目录 Promise/Effect 客户端、生成一致性和导入边界 | 18 pass / 0 fail，退出码 0 | client/logs/delivery-client-all.log |
| OpenCode 真实认证 HTTP | 1 pass / 0 fail，退出码 0 | opencode/logs/final-http-auth.log |
| OpenCode 真实供应商地址 HTTP | 1 pass / 0 fail，退出码 0 | opencode/logs/final-http-base-url.log |
| OpenCode 真实 relay 请求及模型列表消费者 | 2 pass / 0 fail，106 filtered，退出码 0 | opencode/logs/final-provider-relay.log |

Core、App、Server、OpenCode、Client、Schema、旧 JS SDK 的 bun typecheck 均在隔离源码及实际交付目录通过，退出码均为 0。各包日志为 logs/final-types.log 和 logs/delivery-types.log；App 最后追加三条专用反例后的类型检查为 app/logs/delivery-app-types-final.log。relay E2E 独立类型检查退出码 0，见 app/logs/final-e2e-types.log。

生成命令 packages/client 的 bun run generate，以及 packages/sdk/js 的 bun ./script/build.ts 均退出码 0。后者包含 SDK 编译。生成差异清单见 generated-changes.json。

## 4. 真实界面与边界覆盖

已阅读项目要求的 Playwright 官方 Best Practices、Auto-waiting、Assertions、Locators、Network 和 Test Isolation 指南。正式场景位于 [relay-settings-completion.spec.ts](D:/opencode/packages/app/e2e/regression/relay-settings-completion.spec.ts)，需要 RV_RELAY_E2E=1 及明确隔离根才执行。

独立运行 App 44444、后端 44096、假上游 44097。最终两套布局为 2 passed、0 failed，退出码 0，24.9 秒；见 ui/logs/ui-final.log、ui/results.json 及 ui/results 下的 trace、截图。首次同样 2 passed，最终复验覆盖最终设置源码。未伪造最终成功响应、手改 store 或重载页面来替代服务恢复。

每套布局实际验证：

1. 真实清密钥已提交，但通过网络屏障延迟其 ACK；另一个供应商真实提交后，页面读取更高 Auth revision。旧 ACK 到达后原 key 草稿清空；再点击保存，实际 PUT 不携带旧 key。
2. 测试目录文件真实损坏后保存 key，后端返回 HTTP 200 且 catalogSync=pending；原草稿已确认，页面显示已保存/待刷新。
3. 恢复原测试文件后只点击 Retry refresh，实际只 POST models.sync(retryNotice=true)，不再发认证写请求，认证 revision 不变，提示消失。
4. 再次 Get models 和勾选 review-model，真实上游与可见 checkbox 状态正确。

入口核对：probe 保留 Core 和真实 Handler 证据，但当前两套 Providers 页面均无 probe 调用按钮，页面部分不适用；不能靠新增控件凑验收。模型提交后另一持锁者介入的精确竞争在 Core 真实文件锁用例通过，尚未通过真实页面走该时序，UI-RV 仍只部分验收。历史完整 UI01～UI08 等不由本次两个场景自动关闭。

测试创建的两个进程组已按记录 PID、命令行身份清理，44096/44097/44444 监听已释放。没有操作用户当前应用。测试假数据、日志和 trace 留作证据。

## 5. 首次失败与处理

- App 初次直接 bun test 遗漏项目规定的浏览器 tsconfig/conditions，产生 jsxDEV 导入错误。改用 package.json 中规定的浏览器测试方式后通过，没有修改产品以适配错误命令。
- 第一版保护删除确认时把整段认证写入屏蔽取消，导致既有 B118 提交前取消回归超时。修复保护范围为受身份保护删除的最终 rename 与确认登记；准备阶段及旧调用保持可取消。未修改原 B118 断言，后续 27 项及最终联合均通过。
- 新增实际 Handler/插件夹具首次缺少全局无关的工作区中间件，报 Service not found。夹具明确隔离工作区路由/认证，使用真实 RelayHandler、EventV2、PluginHost/Catalog 和文件错误；没有新增生产测试开关。正式完整 routes 的 HTTP 套件另行通过。
- 旧 HTTP 回归将写响应与后续 GET 整体相等；新增 catalogSync 是命令结果，不应持久化成读取状态。已改为分别断言写结果和 GET 的权威字段，没有删除 key/revision/实体保护断言。
- Schema 规则测试在 Windows 将 URL.pathname 当成本地路径，得到 /C:/... 的 ENOENT。夹具改为 fileURLToPath；原规则断言保留，14 项通过。这是测试可移植性修正。
- 隔离目录在 C 盘、依赖 .bun 链接到 D 盘时，Bun metafile 产生 ../../../../D:/... 路径，客户端边界测试的本地 resolve 无法识别。未放宽断言；在实际 D:/opencode 交付目录原样执行，18 项（含边界）通过。

首次失败日志保留，没有只保留重跑成功，也没有把环境错误记成已修复产品缺陷。

## 6. 交付核对与剩余项

仅交付 26 个代码、生成产物和正式回归文件，外加本结果文档及两份方案的实施状态更新。每次写主工作区前比对本轮基线，随后逐文件核对 SHA-256。完整文件清单及摘要见 C:/relay-rv-fix-20261113/validated-files.json。

基线共 6918 文件。交付后核对非目标变更 0、意外新增 0、暂存文件 0、目标摘要不匹配 0；见 main-verification.json。最后追加的清密钥专用测试单独再次核验原交付摘要后同步，最终清单已更新。没有整目录覆盖、删除原未提交代码或创建源文件备份。

本批代码状态为“已实施、自动验证通过”。RV-03/RV-04 的上述真实页面行为已验收；UI-RV 的精确持锁竞争仍待补验，不能把整个矩阵写成全部完成。跨平台/已安装包、R3-03B、RF-07 和历史未覆盖界面项不在本批新增关闭范围内。删除确认仍仅保证本服务生命周期内的精确重试，synced 仍只代表服务目录接纳完成。

## 7. 2026-11-13 后续独立复核（保留以上历史结果）

本轮重新执行 Core 153、App 111、Server 8+1+2、Schema 14、Client 18 项及 Core/App/Server 类型检查，通过。但新增取消与跨命令复用交叉反例稳定失败：受保护删除实际提交后取消，createOnly 复用其 operationId 可成功写入，并丢失旧凭据待清理记录。RV-05 因此重新列为未关闭，不能沿用第 1 节正常路径的通过结论将六项整体关闭。

详情、日志、正常对照及最小修复建议见 [独立复核报告](D:/opencode/specs/relay-rv-recheck-2026-11-13.md)。本轮仅检验与记录，没有修改业务代码。

## 8. RV-05-R1 已补修并复验（2026-11-13）

第 7 节重新打开的取消后跨命令编号复用残留已补上：createOnly 在任何写入前拒绝已属于删除命令的 operationId。四项正式新增边界与 HTTP 真实入口通过；实际交付目录 Core 61 pass、Server 8 pass，Core/Server 类型检查通过。RV-05-R1 可按本机自动验证证据关闭，历史失败记录保留；完整 UI-RV 与其他历史待验收项未扩大关闭。

本轮同时修正已在未补修版本复现的跨进程竞争测试夹具时序错误，保留普通创建的凭据验证并新增删除后凭据为空断言。详情见 [补修结果与证据](D:/opencode/specs/relay-rv05-r1-fix-results-2026-11-13.md)。未提交、未重启应用。
