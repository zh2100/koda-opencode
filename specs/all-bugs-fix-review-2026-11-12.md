# Bug 修复结果复核 — 2026-11-12

对应[实施结果](D:/opencode/specs/all-bugs-fix-results-2026-11-12.md)与[实施方案](D:/opencode/specs/all-bugs-fix-implementation-plan-2026-11-12.md)。

**复核未通过：确认仍有 3 类代码缺陷。** 前次 Core 87 项、App 设置 92 项通过的日志真实存在；它们没有覆盖以下路径。本次没有修改主仓库业务代码、测试、版本或原结果文档，只新增此复核记录。没有提交、重启当前应用、操作生产配置或启用迁移。

本轮 37 个实现/生成文件与已验证隔离源码的 SHA-256 仍全部一致。新增诊断只在 `C:/obf-20261112` 内执行。以下失败不是将全部历史验收缺口重新命名为 Bug。

## 1. RF-BF-01 / P2：旧实例同步会删除另一进程有效的刷新令牌

位置：[synchronize](D:/opencode/packages/core/src/relay-catalog.ts:519)，尤其第 526～529 行；[刷新提交时的令牌检查](D:/opencode/packages/core/src/relay-catalog.ts:603)。

复现顺序：

1. 父进程 A 已加载供应商旧状态；子进程 B 使用同一数据根、独立 state 目录。
2. B 更新供应商密钥，完成自己的 syncVendors，再发起真实 HTTP 模型刷新。
3. 本机随机端口的上游暂挂响应，此时 B 已持久化自己的 refreshRequests 令牌。
4. A 执行 synchronize。A 发现自己记忆中的供应商版本较旧，将该供应商列为 invalidated，直接从磁盘最新记录中删除 B 的令牌。
5. 放行上游；B 正常结束、退出码 0，但因令牌不匹配丢弃 fresh-child-model，最终返回空列表。

正常对照：相同真实子进程与相同请求流程，不插入 A 的同步，得到 fresh-child-model。两个真实服务实例的受控上游对照也复现同样问题。

根因：**本实例的缓存是否过时，被用来决定共享刷新租约是否过时。** 持久化 token 属于 B；A 的旧 vendorStamp 不能证明它无效。公共事务虽增加了持久化实体绑定，后续 synchronize 的旧失效分支仍会删掉有效 token。

修改方向：同步接纳与共享租约失效分开；仅依据租约持久化绑定的实体、凭据版本及所有权判定失效，不能凭本实例的旧视图删除。保留提交时的身份/令牌核验，并同时回归“真旧请求应被拒绝”和“别的进程当前请求应完成”。

## 2. RF-BF-02 / P2：服务初始化未校验目录实体绑定，退休模型重新可见

位置：[初始 snapshot 装载](D:/opencode/packages/core/src/relay-catalog.ts:328)、[缓存 managed 查询](D:/opencode/packages/core/src/relay-catalog.ts:564)、[模型投影](D:/opencode/packages/core/src/relay-catalog.ts:706)。事务里的退休清理位于第 405～430 行，但构建路径没有执行它。

复现顺序：

1. 创建自定义供应商 review，勾选 retired-model；目录已经保存旧实体的 vendorEntities。
2. 认证服务删除 review，再使用同 ID、新实体和新地址创建后继项；不执行目录同步，模拟认证提交后、Handler 后续同步前退出。
3. 销毁服务作用域，从同一磁盘重新构建认证与目录服务。
4. managed() 仍返回 retired-model，预期应为空。未替换实体的正常对照则正确保留原模型。

根因：**实体失效只覆盖了后续事务，没有覆盖首次装载与首次投影。** 构建时先安装原始目录，再读取当前 auth；已有 vendorEntities 没有与当前实体比对。插件初次安装就会调用 apply，不能依赖用户后来打开设置页 reload 才完成隔离。

修改方向：首次公开服务/投影前，按 auth→catalog 的锁顺序完成一致性装载并复用实体失效规则；明确内存过滤与必要落盘的边界。覆盖认证提交后退出、重建服务后直接 managed/apply，以及实体未变的正常对照。

## 3. RF-BF-03 / P2：仅有统一密钥时，内置供应商刷新误报 KEY_MISSING

位置：[fingerprintOf](D:/opencode/packages/core/src/relay-catalog.ts:487)，第 493 行要求 vendor.hasKey；[保留刷新请求](D:/opencode/packages/core/src/relay-catalog.ts:590)。

复现：保存统一密钥、启用 unified，不为 ChatGPT 单独保存密钥，然后调用 catalog.refresh(chatgpt)。实际返回 Relay.CatalogError，code=KEY_MISSING；上游尚未被请求。增加一个独立密钥后，同样的统一模式与模型响应可以刷新成功。

根因：hasKey 只表达供应商自己的 keyRef，不表达统一模式下真正可解析的凭据。fetch/resolve 支持统一密钥，但刷新指纹的前置检查又把这个合法状态拒绝。

这是**历史未修逻辑**：实施前隔离源码 `C:/ocdf-dc5c7401` 的相应检查已存在，不计为本轮新引入的回归。公开统一认证接口仍保留，因此不能视为无效输入。

修改方向：以实际选定的有效凭据与其版本建立刷新身份，区分独立端点和共享端点；不能只用 vendor.hasKey。回归统一密钥单独存在、统一密钥轮换/清除、切换模式以及自定义地址不使用共享密钥。

## 4. 验证与审查假设

证据根：`C:/Users/zh2100/AppData/Local/Temp/opencode-bf-implementation-20261112`。

| 验证 | 结果 | 日志 |
| --- | --- | --- |
| Core 新边界与正常对照 | 3 pass / 4 fail；四个失败对应以上三类缺陷，令牌竞争分别由双实例和真实子进程复现，不重复计 Bug | logs/review-core-final.log |
| 统一凭据错误码核验 | 1 pass / 1 fail，确认失败为 KEY_MISSING | logs/review-unified-code.log |
| 新增冲突恢复审查假设 | 1 pass / 1 fail；不是本报告确认缺陷的验收断言，见下文 | logs/review-app-final.log |
| 前次已通过结果核对 | Core 87 pass / 0 fail；App 设置 92 pass / 0 fail；源码摘要仍匹配 | logs/core-relay-delivery-complete.log、logs/app-settings-complete.log、final-hashes.json |

复现源保存在 review/core.test.ts、review/writer.ts；原运行路径为隔离源码的 packages/core/test/bf-review.test.ts 与 test/fixture/bf-review-writer.ts。Core 从 packages/core 执行 `bun test ./test/bf-review.test.ts --timeout 30000`，完整隔离变量与日志收集入口见 scripts/run.ps1。

新增冲突假设没有计入确认缺陷：页面对 REVISION_CONFLICT 清除 pendingCreate，对 REQUEST_CONFLICT 保留。初始诊断要求后者也立即清除，但认证可能已提交、后续目录同步才返回 REQUEST_CONFLICT，不能将所有该错误都当成未提交。本次保留该失败日志与 review/app-hypothesis.test.ts，撤回“无条件清 pending”的验收期待。用户明确放弃/另建命令的交互出口，以及如何可靠区分提交阶段，仍需设计和真实 HTTP 证据，不混入以上 3 项。

两套设置页原有 2 项定向验收，本轮没有重新启动页面重复执行，也没有把它们扩大成完整验收。原报告保留的 D3、OA-06/UI01～UI08、RF-07、R3-03B 等历史缺口仍未关闭。

本次遗漏的共同原因是验证集中于正常提交和显式同步后的状态，没有覆盖“首次装载就被消费者使用”和“一个进程的同步插入另一进程刷新中途”；统一凭据又没有“只配置共享密钥”的对照。补修应先保留本报告的失败用例，再逐项修实现并验证正常与失败两侧，不能只新增顺序成功测试。
## 5. 根因复验补充

详见[根因复验记录](D:/opencode/specs/all-bugs-root-cause-verification-2026-11-12.md)。RF-BF-01 的共享令牌删除与 RF-BF-02 的初始化失效缺口已通过隔离单变量干预确认。RF-BF-03 还包含完成阶段复用旧 resolved 的问题：统一密钥轮换、清除、关闭统一模式后，旧响应仍被接纳。仅删除 vendor.hasKey 检查不能完整修复。所有干预均已从隔离副本恢复，未修改主仓库业务代码，三项仍未关闭。