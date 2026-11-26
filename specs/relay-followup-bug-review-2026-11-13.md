# 目录与设置后续复核 — 2026-11-13

本轮继续检查当前未提交版本，集中在上一轮独立供应商补修的并发收尾、连接测试和清除密钥 ACK。确认 3 项 P2 缺陷，均有隔离复现。没有修改业务代码、重启当前应用、操作生产数据或提交。本报告不替代上一轮已通过的验收记录，也不宣称覆盖工作区全部未提交文件。

## RV-01：连接测试接纳已失效供应商的迟到成功

位置：[relay-catalog.ts:598](D:/opencode/packages/core/src/relay-catalog.ts:598)。

复现：开始 probe，等旧上游收到请求后挂起响应；此时清除该供应商密钥，或删除并同 ID 重建供应商，再放行旧响应。

实际结果：两种 Core 场景都返回 Success/count=1。真实 HTTP 场景中，清除接口已返回 hasKey=false，旧 probe 仍返回 HTTP 200、{"count":1}。页面若尚未同步外部认证变化，其本地身份检查无法发现这次变更，仍可把此回包显示为连接成功。

根因：probe 在发送前核验 captured 与当前身份；fetchUpstream 返回后直接返回 count，没有完成阶段的权威身份核验。refresh 的提交保护没有覆盖 probe。

建议：上游成功后，按既有锁顺序重新核验 captured 的 entityId、供应商 revision、baseURL、hasKey，再允许返回成功。发生变化时返回现有 REQUEST_CONFLICT；不要重新 resolve 新凭据，也不要把网络请求放进锁内。应覆盖清 key、轮换、换地址、删除/同 ID 重建、无变化正常对照和真实 HTTP。

证据：logs/followup-with-control.log 中两条 REVIEW-01 失败；logs/http-probe.log 中真实 HTTP 回归失败。密钥未输出。

## RV-02：模型刷新已提交，却因多余清理等锁而被报成失败

位置：[relay-catalog.ts:676](D:/opencode/packages/core/src/relay-catalog.ts:676)、[relay-catalog.ts:709](D:/opencode/packages/core/src/relay-catalog.ts:709)。

复现：刷新正常写入新模型并删除自己的 refresh token；通知投递期间，让另一真实作用域取得 auth 锁并保持占用；放行通知，让本次刷新返回。

实际结果：磁盘已有 committed-model，refreshRequests 中自身 token 已不存在；请求仍再进入一次清理事务，等锁 2 秒后返回 SECRET_STORE_UNAVAILABLE，details=refresh cleanup。该失败来自真实文件锁竞争，不是模型写入失败。

影响：界面可能提示“刷新失败”，但目录已经更新；调用者容易误判提交状态并重复操作。

根因：reserved 只记录“曾经预留成功”，没有在成功模型提交并删 token 时结束清理责任。结果提交成功后仍必走后续可能失败的事务，并把无须执行的清理错误覆盖到成功结果上。

建议：把自身 token 的未完成清理责任作为明确状态，在成功原子提交/安装边界更新；已完成删除或已确认不再持有 token 时跳过额外清理。不能简单以 result 是 Success 就跳过：旧结果被拒绝但自身 token 仍在时，仍需条件清理。保留真正失败/取消的 2 秒预算、主错误与清理错误，以及后继 token 保护。

证据：logs/followup-with-control.log 中 REVIEW-02 失败；日志同时记录 diskModels=[committed-model]、tokenExists=false 和失败原因。无竞争的 probe/refresh 正常对照通过。

## RV-03：清除密钥的旧成功 ACK 没有清掉原草稿

位置：[use-relay-settings.ts:842](D:/opencode/packages/app/src/hooks/use-relay-settings.ts:842)。

复现：密钥输入框已有草稿，点击清除密钥后挂起成功 ACK（revision=2）；另一供应商更新后先接纳新的全量快照（revision=3，目标供应商 hasKey=false、entityId 不变）；再送达原清除成功 ACK。用户期间没有编辑密钥。

实际结果：权威 auth 保持 revision=3、hasKey=false，符合防回退要求；但目标输入框仍保留提交时的密钥草稿。随后保存/获取模型会按现有 saveVendor 逻辑再次提交该非空草稿。

正常对照：用户在清除期间输入新的密钥时，新输入得以保留，该项通过。问题只在“未再编辑但 ACK 旧于最新快照”的提交确认路径。

根因：`if (!auth || !applyAuth(auth, context)) return` 将“成功命令的草稿收尾”与“能否接纳整份 Auth 快照”绑在一起。较旧快照被正确拒绝后，紧接着的字段值/编辑版本检查和清空逻辑都被跳过。saveVendor 已做的成功 ACK 分离没有扩展到 clearVendorKey。

建议：分开处理命令确认与快照接纳。拒绝旧 Auth 回退的同时，只在生命周期/服务器/实体仍匹配、提交时草稿及编辑代次未变化时清空原草稿；后续新输入或同 ID 重建必须保留/拒绝旧收尾。也不能借旧 ACK 清掉更新动作的错误或覆盖较新目录分片。

证据：logs/app-followup.log，editedAfter=false 失败，editedAfter=true 正常对照通过。该证据为真实 createRelaySettingsState 的状态回归，不是完整设置页验收。

## 隔离验证与状态

主源码与诊断副本在检查开始前逐字节一致。摘要记录在 C:/relay-review-20261113/source-hashes.json，检查结束后再次核对，业务源码未变。

证据根：C:/relay-review-20261113。源码运行根：C:/obf-20261112。所有验证使用本轮独立 home/data/config/state/cache/managed/tmp、内存数据库、假密钥及禁用 models 网络抓取。

| 包/诊断 | 结果 | 说明 |
| --- | --- | --- |
| Core relay-followup-review-20261113.test.ts | 1 pass / 3 fail，退出码 1 | RV-01 两变体、RV-02，以及无变更/无竞争正常对照 |
| App relay-followup-review-20261113.test.ts | 1 pass / 1 fail，退出码 1 | RV-03 与后续新输入保护对照 |
| Server relay-followup-review-20261113.test.ts | 0 pass / 1 fail，退出码 1 | RV-01 真实 Handler + 本地 HTTP 上游 |

上表使用“期望正确行为”的断言，因此失败是缺陷证据，不能计作修复通过。诊断测试仅位于隔离副本，未复制进主仓库。测试进程、真实锁作用域和 HTTP 上游均已结束/释放。

复跑命令使用证据根 run.ps1，Package 取 core/app/server。Core/Server 参数为 `test ./test/relay-followup-review-20261113.test.ts --timeout 20000`；App 参数为 `test --tsconfig-override ./tsconfig.test.json --conditions=browser --preload ./happydom.ts ./test-browser/relay-followup-review-20261113.test.ts --timeout 15000`。

三项共性是同一种保证尚未贯穿所有动作与完成阶段：probe 只有发出前保护；refresh 没有区分已结束的清理责任；clear-key 没有区分提交确认与快照接纳。建议补修时将这三个不变量及其阶段矩阵单列回归，避免只扩展某个现有动作的正常顺序测试。

R3-03B、RF-07 跨平台和完整历史 UI 验收仍沿用原未关闭范围；本轮没有将“未验收”直接算作新缺陷。
