# OA-06 第二次复核（2026-11-11）

## 结论

上轮 R01～R06 的针对性修复与新增测试已核实；目录构建错误边界、中断和服务销毁测试通过。OA-06 仍不能关闭：除 UI01～UI08 待验收外，正式设置状态工厂还有 3 条可复现的状态覆盖路径。

本轮仅审查、隔离运行与新增本文，不改业务代码，不提交，不重启应用，不调用生产 HTTP 或系统凭据。本文不覆盖原实施结果或第一次复核结论。

## F01 / P2：保存 A 密钥后，操作 B 的勾选会清除 A 的勾选显示

位置：packages/app/src/hooks/use-relay-settings.ts:96、168、425。

根因：

1. invalidate(A) 增加 vendorCatalog[A]，并移除 A 的 candidates / managed。
2. 修复后的供应商补读会重新装入 A 的 managed，但 vendorCatalog[A] 仍大于 0，这是合理的单调代次。
3. setVisible(B) 却把“代次曾经增加过”当成“数据仍然失效”，过滤掉所有 vendorCatalog[id] > 0 且 id != B 的条目。
4. 后端 visibility 响应即使包含 A、B 的正确数据，A 也会在本地被丢弃。

正式 createRelaySettingsState、真实 Solid createRoot，接口桩返回 A、B 两个已勾选模型；保存 ChatGPT 密钥后再勾选 Claude，实际输出：

~~~json
{"case":"other-vendor-visibility-after-save","before":["claude","chatgpt"],"after":["claude"],"chatgptVisible":false}
~~~

影响：A 的勾选与计数无故消失。已证明的是前端状态错误，没有把它描述为后端删除记录。

修改要求：

- 分开表示单调版本与当前失效状态，不能使用 version > 0 判断条目是否应被永久过滤。
- visibility 的合并以请求前采集的供应商身份/目录版本和可见性写入版本为依据。
- 对仍有效的其他供应商保留已确认状态；不能直接取消过滤后把删除或更换地址前的过时条目带回来。
- 成功装入对应供应商的新 managed 后，清除该代次对应的待补读状态；旧代次的完成不能清理新代次。

必补回归：

1. 保存 A 密钥并补读完成，随后操作 B 的勾选；A 的 checked、visibleCount 保持正确。
2. A 正在保存期间操作 B；按两种完成顺序验证 A、B 最终都正确。
3. A 删除/改地址与 B 的 visibility 返回交错，旧 A 不得复活。
4. 同一供应商连续失效两次，第一轮完成不能误清第二轮失效。

## F02 / P2：较早的全量读取可以覆盖供应商的新刷新结果

位置：packages/app/src/hooks/use-relay-settings.ts:96、138、158。

根因：

- 单供应商读取使用 vendorCatalog / vendorTicket 保护；全量读取只看 catalogVersion 和 catalogTicket。
- invalidate(A) 不改变全量请求票据；单供应商的新读取也不使之前全量响应中 A 的那一部分过期。
- 全量响应完成后仍整体替换 candidates / managed，所以供应商级保护不能阻止跨读取粒度的覆盖。

正式状态工厂的受控顺序：

1. 初始化已有 old 模型。
2. 发起 reload，让旧全量 candidates 响应挂起。
3. 保存 A 的新密钥，供应商补读返回 fresh，并完成显示。
4. 释放步骤 2 的 old 全量响应。

实际输出：

~~~json
{"case":"full-read-after-vendor-save","before":["fresh"],"after":["old"]}
~~~

修改要求：

- 全量请求也必须在真正发出前记录各供应商的版本、票据及必要的写入水位。
- 应用全量结果时，只合并请求期间未变化的供应商分片，保留期间已写入或刷新成功的分片。
- 单纯给所有刷新共用一个票据可能丢弃其他供应商的有效结果；需要明确无归属候选项的独立合并规则。
- candidates 与 managed 分别验证自己的有效性；认证 revision 较旧而未被采用时，后续目录读取也不能凭完成顺序取得覆盖新目录的权限。
- 不能只修“全量先发、供应商后发”；也需验证反向顺序和两个供应商并发。

必补回归：

1. 旧全量先发 → A 保存并刷新成功 → 旧全量后回：A 保持 fresh。
2. 同上并含未变化的 B：B 的有效响应仍被接纳。
3. A 读取先发 → 新全量读取并合并 → A 旧读取后回：不得倒退。
4. 全量读取挂起期间删除 A，不得因旧全量回包复活。
5. 全量与供应商读取分别在 candidates 和 managed 阶段挂起，不能仅测其中一个 await。

## F03 / P2：较旧读取失败仍会污染较新成功读取的错误状态

位置：packages/app/src/hooks/use-relay-settings.ts:114、178、187。

根因：

- active(context) 只判定 scope、生命周期 generation 和销毁状态。
- 同一服务器同一生命周期中的两个 load 都会通过。
- actionId 已存在，但没有用于读取错误与 clearError 的所有权判断。
- loadCatalog 的 catch 在票据检查之前调用 fail，也有同样的旧错误写入路径。
- 反向情况也应补测：较旧成功请求可能清除较新失败请求的错误。

正式工厂复现：

1. 首次自动 get 挂起。
2. reload 的第二次 get 与目录读取成功，error 为空。
3. 第一次 get 随后以 UPSTREAM_UNREACHABLE 拒绝。

实际输出：

~~~json
{"case":"stale-read-failure","before":null,"after":"settings.relay.error.UPSTREAM_UNREACHABLE","revision":1,"calls":2}
~~~

已有结果文档对 U05 也注明“旧失败本身仍会在当前生命周期留下错误”。这与 OA-06 对旧操作不能污染当前状态的总体要求仍不一致，不能只因 busy 的 finally 已被保护就关闭错误归属。

修改要求：

- 为读取与用户操作定义明确的错误所有权；开始新读取时登记票据，写入或清除错误时校验其仍为当前所有者。
- 旧请求仍可按调用契约完成/抛错，但不能改当前界面错误状态。
- 读取的认证、目录阶段使用同一读取上下文，并在每个异步成功/失败边界校验。
- 各供应商独立操作的错误策略应明确，避免为修复旧读取错误而让不相关的真实失败被静默丢弃。

必补回归：

1. 旧 get 失败晚于新读取成功，error 保持为空。
2. 旧 candidates / managed 失败晚于新读取成功，error 保持为空。
3. 旧读取成功晚于新读取失败，新错误保留。
4. 销毁、服务器 A→B→A 后的旧错误均无效。
5. 同供应商两次 probe：旧失败不覆盖新成功，且原 U05 忙碌状态保护仍成立。

## 本轮独立验证

| 检查 | 结果 |
| --- | --- |
| App 设置工具与状态测试 | 21 pass，0 fail，83 expect；退出码 0；11.93s |
| Core 目录事务测试 | 15 pass，0 fail，38 expect；退出码 0；33.85s |
| Core bun typecheck | 退出码 0 |
| OpenCode bun typecheck | 退出码 0 |
| Server bun typecheck | 退出码 0 |
| App bun typecheck | 退出码 0 |
| 补充正式工厂复现 | F01、F02、F03 均复现；独立脚本退出码 0，代表脚本运行成功，不代表缺陷通过验收 |
| UI01～UI08 | 本轮未执行，仍待验收 |

App 测试和补充复现均使用 tsconfig.test.json、browser conditions、happydom。补充复现置于真实 Solid createRoot，并调用正式工厂；接口桩只控制完成顺序和响应内容，没有复制状态合并逻辑。它们属于状态层证据，不冒充真实界面或完整 HTTP 验收。

Core 本轮隔离根：
C:/Users/zh2100/AppData/Local/Temp/opencode-overall-audit-564451bad8364a84a8dd1e4c62ed4a94。

现有 21 项测试没有覆盖以上三条交叉操作。上轮 R01～R06 的具体复现可视为已通过本机定向复核，但 OA-06 当前仍有实际缺陷，不能把剩余工作仅归为界面验收。R3-03B、RF-07 跨平台保持原状态。

