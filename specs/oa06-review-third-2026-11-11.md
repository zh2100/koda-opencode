# OA-06 第三次复核：F01～F03 补修（2026-11-11）

## 结论与范围

上轮 F01/F02 原始复现已重跑，两个结果分别为 A 的勾选保持 true、fresh 未被 old 覆盖。最新设置测试 35 pass、0 fail、154 expect，App bun typecheck 退出码 0。以上结果确认本轮补修有效。

但 OA-06 仍有 4 处已复现遗漏，编号 G01～G04。它们属于实际状态缺陷，不能归为仅待界面验收。本轮只审查和新增本文，没有改业务源码、提交或重启应用。所有补充复现使用正式 createRelaySettingsState 和真实 Solid createRoot；接口桩只控制返回数据与完成顺序，没有复制状态算法。没有调用生产 HTTP 或系统凭据。

## G01 / P2：全量空快照不能清掉旧模型和旧勾选

位置：packages/app/src/hooks/use-relay-settings.ts:194～212。

mergeOwned 只遍历 incoming 中出现的 vendorId，计算哪些供应商分片可被接纳；保留逻辑只删除这些 taken 分片。因此，当某供应商在完整响应中不再有任何行时，它永远不会进入 taken，旧行反而全部保留。

正式工厂顺序：

1. 初始 candidates / managed 都有 chatgpt/old。
2. 不做并发操作，将当前服务器的两个完整接口结果改为 []。
3. await state.reload()。

实际输出：

~~~json
{"case":"full-empty-result","candidates":["old"],"managed":["old"]}
~~~

预期两个列表都为空。部分为空也有同样问题，例如只剩 B 时 A 的旧分片应当清理。这不是“没有返回该分片，所以不作处理”的增量接口；此处读取的是完整列表。

修复要求：

- 全量合并的分片集合必须覆盖请求基线、当前条目和 incoming，不能只看 incoming。
- 对可接纳的分片，用 incoming 对应子集整体替换；对应子集为空同样表示有效删除。
- 空结果仍要遵守版本与写入水位，不能清掉请求期间刚产生的新分片。
- 同步记录“空分片已被新快照确认”的水位，避免后来的旧响应复活旧行。
- pendingInvalidation 的完成也必须支持有效空分片，不能靠响应里必须有行才能清除。

必要补测：全空、只缺 A、只缺 B、仅 managed 为空、仅 candidates 为空；旧空快照晚于新供应商刷新，以及新空快照晚于旧非空响应。检查列表、checked 和计数。

## G02 / P2：旧供应商 managed 晚到仍覆盖新全量勾选

位置：packages/app/src/hooks/use-relay-settings.ts:250～259。

当前检查在 await managed 结束之后重新读取：

~~~ts
const vendorWrite = vendorId ? sliceWrite.get(vendorId) ?? 0 : 0
if (vendorId && (... || writtenAfter(vendorId, vendorWrite))) return
~~~

writtenAfter 本身就是比较同一个 Map 当前值是否大于参数。这里参数刚从同一 Map 取出，期间没有 await，所以这部分比较始终为 false，不能检查请求期间是否发生了新写入。

正式工厂顺序：

1. 单供应商刷新已写入 candidates，在 managed 请求阶段挂起。
2. 新全量 reload 完成，candidates 和 managed 都显示 fresh。
3. 释放旧供应商的 managed，内容为 old。

实际输出：

~~~json
{"case":"old-vendor-managed-after-full","before":["fresh"],"after":["old"],"candidates":["fresh"]}
~~~

结果是模型候选列表为 fresh，但勾选列表倒退为 old。

修复要求：

- 在 managed 请求发出前捕获不可变的基线，完成后与当前值比较，不能完成后现取现比。
- 明确 candidates 和 managed 各自的数据水位；不能让 candidates 写入顺便赋予旧 managed 覆盖新 managed 的权限。
- 若沿用同一个目录事务序号，需明确阶段归属和允许的自身写入，不能把两阶段当成同一次无条件写入。
- 新全量快照、visibility、保存失效都应能使正在等待的旧 managed 分片过期。

测试缺口：

现有“F02 keeps a newer full merge when an older vendor read finishes later”把旧请求挂在 candidates，旧请求在 candidates 检查处就被丢弃，没有经过 managed 的上述检查。

该测试还用 managed(input?.vendorId) 选择闸门，但正式代码调用 api.managed() 不传参数，因此不能靠这个参数证明供应商 managed 请求已经挂起。

必要补测：使用实际调用次数或闸门明确确认“旧供应商 managed 已发出”，再完成新全量读取，最后释放旧 managed；断言 candidates、managed、checked 都保持 fresh。反向顺序及 visibility 写入期间的旧 managed 也要覆盖。

## G03 / P2：勾选的目标供应商删除后，旧响应会把目标放回本地 managed

位置：packages/app/src/hooks/use-relay-settings.ts:529～543。

setVisible 对其他供应商检查版本和 pendingInvalidation，但对目标直接使用 item.vendorId === vendorId 接纳。deleteVendor 的 beginAction 没有刷新旧 visibility 所持有的 vendorErrorOwner，所以删除后 ownsError 仍可能为 true。

已使用产品允许删除的自定义供应商重新复现：

1. 自定义供应商 custom-review 有 gpt 模型。
2. 对该模型发起 visibility 请求并挂起。
3. 删除同一个自定义供应商成功，auth.vendors 为空。
4. 释放删除前的 visibility 完整响应，其中还有 custom-review/gpt。

实际输出：

~~~json
{"case":"custom-visibility-target-deleted","vendors":[],"managed":["custom-review"]}
~~~

影响是本地 managed 出现已删除供应商的幽灵条目。当前只证明前端复活，没有证明后端重新创建供应商或凭据。

修复要求：

- 目标供应商也必须检查请求发出前捕获的身份、存在性、目录代次和生命周期。
- 删除、同名重建、地址更换后，原 visibility 目标响应不能作为当前身份的写入结果。
- 不能只依赖错误所有权作为数据有效性判断；错误归属和数据归属需要各自校验。
- 不要简单屏蔽目标所有代次变化，应区分 visibility 自己的已确认写入和外部身份变更。

现有 F01 删除测试是“删除 A、返回 B 的 visibility”，没有覆盖“删除 visibility 的目标 A”。

必要补测：勾选目标删除、目标删除后同名重建、目标换地址；同时验证其他仍有效供应商的数据不会被错误清除。

## G04 / P2：旧操作补刷借用新错误票据，旧失败仍污染当前状态

位置：packages/app/src/hooks/use-relay-settings.ts:220、389、422、507。

loadCatalog 的 owner 默认值是调用当时的 errorOwner。saveVendor、addVendor、fetchModels 的补刷没有显式传入原动作票据。

因此，一个较旧操作若在 await persistDraft / vendor 响应之后才进入 loadCatalog，就会借用期间较新操作签发的 errorOwner。后续失败被当成新操作的失败。

正式工厂复现：

1. 第一次 fetchModels(chatgpt) 在内部 vendor 保存响应处挂起。
2. 第二次 fetchModels(chatgpt) 完整成功，界面无错误。
3. 第一次保存返回较旧 auth；随后第一次动作的 refresh 失败。
4. 旧 refresh 使用第二次动作的票据写入错误。

实际输出：

~~~json
{"case":"old-action-followup-borrows-new-error-ticket","before":null,"after":"settings.relay.error.UPSTREAM_UNREACHABLE","refreshes":2,"vendors":2}
~~~

修复要求：

- 错误票据和错误归属域必须从动作开始显式传到底层；后续 await 之后不能从全局变量重新读取默认所有者。
- 去掉能悄悄借用当前 errorOwner 的默认参数，或由包含不可变归属信息的请求上下文承载。
- probe / fetchModels 的供应商错误归属也必须贯穿 persistDraft、saveVendor、refresh、candidates、managed。
- 同供应商较旧动作的补刷，可以跳过发起；若仍发起，其失败必须只返回给原调用，不能改当前界面错误。
- 不同供应商仍相关的真实错误不能因全局最新动作而被静默丢弃；需要明确现有单个错误展示槽的策略。

必要补测：两次同供应商 fetchModels 在内部保存响应处逆序完成；分别让旧 refresh、candidates、managed 失败。再覆盖 saveVendor/addVendor 补刷的所有权传递。

## 从源头收口的实施约束

本轮遗留不是类型错误，而是状态协议没有贯穿所有异步阶段：

1. 全量响应必须定义“缺失行”的含义，并与非空分片使用同一接纳规则。
2. 所有竞争检查都比较“发出前不可变基线”与“完成时当前状态”；不能在完成后构造比较基线。
3. 目标分片和其他分片都应验证身份，不能因为它是操作目标就绕过失效检查。
4. 动作上下文必须贯穿内部保存、网络读取、数据合并和错误处理；不能在链中重新认领最新所有权。

建议先写上述四条反例，再修改统一的接纳边界。测试矩阵同时覆盖响应为空/非空、目标/其他供应商、candidates/managed、请求成功/失败，以及每个 await 前后的两种顺序。桩接口的参数与返回形状要匹配真实调用，避免仅用测试名称推断覆盖范围。

## 本轮验证记录

| 检查 | 结果 |
| --- | --- |
| 设置工具与状态定向回归 | 35 pass，0 fail，154 expect；退出码 0；765ms |
| packages/app 的 bun typecheck | 退出码 0 |
| 上轮 F01 原始复现 | A 保存后操作 B，A 保持 checked=true |
| 上轮 F02 原始复现 | fresh 保持为 fresh |
| G01～G04 正式工厂补充复现 | 四条均复现；脚本退出码 0 仅代表脚本运行完成，不代表缺陷通过 |
| G03 自定义供应商补充复现 | 删除后 auth.vendors=[]，managed 仍含 custom-review |
| UI01～UI08 | 未执行，仍待验收 |

本轮没有重跑 Core / OpenCode / Server 类型检查，它们上一轮通过的证据保持原记录，不能作为本轮新增结果。R3-03B、RF-07 跨平台与历史界面验收保持原状态。

