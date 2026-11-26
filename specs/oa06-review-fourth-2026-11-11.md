# OA-06 第四次复核（2026-11-11）

## 结论

G01～G04 原始复现均已重新运行，当前结果正确；最新设置定向回归为 49 pass、0 fail、258 个断言，App bun typecheck 退出码 0。

补充检查仍确认 4 处状态缺陷，编号 H01～H04。OA-06 继续不关闭，UI01～UI08 也仍待验收。本文不覆盖前三次复核和用户实施记录。

本轮只审查、运行内存隔离复现并新增本文，没有修改业务代码、提交、重启应用或写入生产配置。补充复现使用正式 createRelaySettingsState、真实 Solid createRoot、browser conditions、tsconfig.test.json 与 happydom；桩接口只提供响应和时序，不复制状态算法。以下是状态层证据，不冒充真实 HTTP 或界面验收。

## H01 / P2：同名同地址重建时，旧勾选响应仍会写入新供应商

位置：packages/app/src/hooks/use-relay-settings.ts:175、185、579～584。

当前 vendorIdentity 已采集 generation，sameIdentity 也实现了完整比较，但 setVisible 没有调用 sameIdentity，仅比较 present、builtin、baseURL。generation 实际被遗漏。

G03 的新测试使用了不同地址，或等新供应商 managed 补读完成再释放旧响应；此时地址变化或 managedWrite 变化恰好挡住旧响应，不能证明同地址且尚未补读的情况。

正式工厂复现：

1. 自定义供应商 custom-review 的地址为 https://review.invalid/v1。
2. 勾选 gpt，挂起旧 visibility 响应。
3. 删除该供应商。
4. 使用同名、同地址、新密钥重新添加；新供应商已提交，refresh 正在等待。
5. 释放旧勾选成功响应，内容为 gpt visible=true。
6. 新供应商 refresh 失败并收尾。所有挂起 Promise 均已完成。

实际输出：

~~~json
{"case":"same-url-recreated-old-visibility","vendors":["custom-review"],"managed":["gpt"],"checked":true,"count":1}
~~~

这里的 gpt 和勾选来自已删除的旧身份。新身份尚未成功读到目录，不能接纳旧身份的回包。即使新目录之后读取成功会覆盖，旧身份已经越过接纳边界；若补读失败，错误状态持续保留。

修改要求：

- 对目标使用完整身份比较，包括请求发出前的生命周期 generation。
- 删除、同名重建以及地址往返变更都应使旧请求失效，即使最终 URL 与原来相同。
- 不能只依赖“新补读已经写过 managed”来间接阻止旧响应。
- 正确使用或移除未被调用的 sameIdentity，避免定义完整校验却在关键路径手写残缺校验。

必补回归：同名同 URL 重建，新 refresh 分别挂起、失败、成功；旧响应在新补读之前和之后返回。补测 URL A→B→A 且没有新 managed 写入的情况。

## H02 / P2：读取先完成，会挡掉随后真正成功的勾选写入

位置：packages/app/src/hooks/use-relay-settings.ts:578～582。

setVisible 在请求发出前记录 managedWrite；完成时只要其变化就直接丢弃响应。但 managedWrite 既表示读取结果写入，也表示用户写入确认。一个后发读取可以在较早的勾选尚未提交时读到旧值；该读取不应使之后成功提交的勾选失效。

正式工厂顺序：

1. 初始 gpt visible=false。
2. 发出 setVisible(gpt,true)，服务端变更尚未完成。
3. reload 完成，读到当时仍合法的 false，写入 managedWrite。
4. 勾选操作随后提交成功，返回 visible=true。
5. setVisible 因 managedWrite 与基线不同而丢弃成功响应，正常返回。

实际输出：

~~~json
{"case":"read-completes-before-visibility-commit","backend":true,"checked":false}
~~~

backend 是隔离桩的已提交状态，表示真实协议允许的“读取先完成、变更后提交”；没有声称运行了真实服务器。界面最终与已确认写入不一致。

修改要求：

- 区分读取快照的写入水位与用户变更的确认序号。
- 成功变更的接纳应以仍属于同一供应商身份、没有被较新变更取代为依据；不能仅因普通读取更新了 Map 就静默丢弃。
- 在途变更需要有明确的每供应商/模型所有权。读取可以暂缓相关分片，也可以与写入结果合并，但最终成功确认必须能反映在界面。
- 同时保留 G02：已完成的新变更不能再被旧读取覆盖。不能为 H02 取消全部读取竞争保护。

必补回归：读取在变更提交之前返回旧值、读取在变更提交后返回新值、旧读取晚于变更确认返回、用户连续两次勾选；逐一验证返回成功后的最终 checked 与已确认状态一致。需要覆盖首次 managed 加载和手动 reload 两种读取入口。

## H03 / P2：B 的勾选会让 A 的有效补读被全局版本丢弃

位置：packages/app/src/hooks/use-relay-settings.ts:294～301、585。

managedVersion 是全局计数，任意供应商的 visibility 成功都会增加。单供应商 A 的 managed 读取在完成时要求全局计数完全不变，即使变化只发生在 B，也会被丢弃。

正式工厂顺序：

1. 保存 A 的新密钥，invalidate(A) 移除 A 的 managed 并标记 pending。
2. A 的 candidates 完成，在 managed 请求阶段挂起。
3. B 的 visibility=false 成功。返回完整列表虽含 A，但因 A pending，合并不会接纳 A。
4. A 的 managed 返回最新、正确的 A 数据。
5. 因 B 已增加 managedVersion，A 补读被直接丢弃，也没有重新排队。

实际输出：

~~~json
{"case":"other-vendor-visibility-during-managed-refill","managed":["claude"],"chatgptChecked":false,"claudeChecked":false}
~~~

A 的正确勾选无法补回；其 pending 也未完成。现有 F01 虽测“保存 A 与操作 B”，没有把 A 精确停在 managed 的 await 内，因而未覆盖这条分支。

修改要求：

- 可见性变更水位按供应商或实际受影响分片维护，不能用全局变化否定无关的 A 结果。
- 若某结果确实受同供应商变更影响而不能接纳，应有明确的后续补读；不能使 pending 永久停留。
- B 的完整响应中涉及 A 的合并也必须遵守 A 的当前水位，不能为了补回 A 而放开旧 A 数据。

必补回归：A managed 已发出后 B 勾选成功，随后 A 返回；同时测试两供应商反向顺序、A 真正发生 visibility 变更，以及某一操作失败。断言 A/B checked、计数和下一次刷新都正常。

## H04 / P2：连续测试连接时，第二次成功结果不能更新第一次状态

位置：packages/app/src/hooks/use-relay-settings.ts:529～543。

probe 成功写状态要求 statusOwner 等于当前 actionId 或不存在，但开始新 probe 时没有接管 statusOwner。第一次成功后 owner 永远属于第一次 action；未改密钥的第二次 probe 不会 invalidate，也就不会清除 owner。

正式工厂无需并发：

1. 对已有密钥的供应商执行 probe，返回 count=1，状态 connected。
2. 不编辑设置，再执行 probe，返回 count=0。
3. 第二次调用返回 empty，但 store.status 仍为 connected。

实际输出：

~~~json
{"case":"sequential-probe-status","before":"connected","returned":"empty","after":"connected"}
~~~

界面读取 store.status，所以不会展示本次实际结果。同类状态归属也应复核 fetchModels / probe 交叉时序。

修改要求：

- 在操作开始时明确登记最新的状态所有者，或依据供应商当前动作票据判断是否能发布结果。
- 新操作成功应替换旧状态；旧操作较晚完成不得覆盖新结果。
- 保留 U05 的忙碌状态 finally 保护；忙碌所有权和结果状态所有权应一致地定义，不能只修其中一个。

必补回归：connected→empty、empty→connected、两个成功 probe 逆序返回，以及 probe 与 fetchModels 交叉。断言返回值、store.status 和忙碌状态全部一致。

## 修复时必须共同满足的约束

以上四条反映的是状态接纳规则仍未统一，继续局部加条件容易把旧覆盖变成有效结果丢弃：

1. 身份是否相同：完整包含生命周期代次，URL 相同不足以证明身份相同。
2. 写入是否有效：普通读取与成功变更不能共用一种“谁后写内存谁赢”的比较。
3. 变化影响谁：供应商 B 的动作不能直接使 A 的有效补读失效。
4. 状态由谁发布：最新动作必须能接管状态，同时拒绝旧完成结果。

建议先固定四条反例，再明确每供应商的身份代次、读取请求号、变更确认号和状态所有者之间的关系。完成每个异步阶段后用同一规则接纳数据/状态，错误票据只负责错误，不作为数据归属的替代。无需为此更改公开接口或 SDK。

## 本轮独立验证

| 检查 | 结果 |
| --- | --- |
| 设置工具与状态测试 | 49 pass，0 fail，258 expect；退出码 0；1056ms |
| packages/app 的 bun typecheck | 退出码 0 |
| G01 原始复现 | 全量空响应后 candidates=[]、managed=[] |
| G02 原始复现 | 旧供应商 managed 后回，fresh 保留 |
| G03 原始复现 | 目标删除后 managed 保持为空 |
| G04 原始复现 | 旧动作被跳过，当前 error 保持为空 |
| H01～H04 补充正式工厂复现 | 四条均已复现；脚本退出码 0 仅表示脚本完成，不表示缺陷通过 |
| UI01～UI08 | 未执行，界面待验收 |

本轮没有重跑 Core、OpenCode、Server 的检查，也没有开展跨平台、迁移或工具授权验收。R3-03B、RF-07 跨平台保持原状态。没有 commit。

