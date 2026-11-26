# 独立供应商目录补修与验收记录 — 2026-11-13

依据：[Bug 修复详细实施方案](D:/opencode/specs/all-bugs-fix-implementation-plan-2026-11-12.md)，本轮执行 C1.7、C1.8、C1.9 及关联联合/消费者/页面定向验收。原实施与移除记录保留，本文不回写历史通过结果。

## 1. 结果与范围

| 项目 | 本轮结论 |
| --- | --- |
| RF-BF-01 | 自动验证通过；真实同根 Bun 子进程刷新不再被旧实例同步或构建取消 |
| RF-BF-02 | 自动验证通过；服务公开前先完成实体一致性装载，真实 HTTP 首次读取和插件首次安装均排除退休/未绑定模型 |
| 独立凭据保护 | 自动验证通过；捕获、预留、发送前、完成阶段使用同一不可变凭据快照并核验实体/版本/地址/hasKey |
| 历史多来源模型 | 复核追加两条红转绿；检查所有可关联来源，缺绑定隔离、已知失配清退，不猜测唯一来源 |
| 两套真实设置页 | Windows/Chromium 定向子集通过；完整 D3、OA-06/UI01–UI08 与其他历史项目不据此全部关闭 |
| RF-BF-03 | 沿用“随统一密钥/智联入口移除不再适用”；没有恢复已移除功能 |
| R3-03B、RF-07 | 保持各自未关闭范围，未启用迁移 apply，未执行跨平台验收 |

实际业务修改只有 Core 的认证和目录两个文件。另有现存测试适配及新增回归。没有修改公开 Protocol/HttpApi/Schema，没有生成 SDK，也没有改版本、提交或推送。

## 2. 根因与最终行为

### 2.1 RF-BF-01：把本地缓存差异当成共享请求失效

旧 synchronize 根据本进程上次看到的 vendors 判断失效并删除共享 refreshRequests。另一个进程已完成合法凭据更新并预留新刷新时，旧进程同步会删掉它的完成资格。

现在目录事务在既有 auth → catalog 锁顺序下读取权威磁盘状态。实体清退依据持久化 vendorEntities，不借用本地旧 vendors 推断绑定。同步只接纳并归一化权威结果，不因本地落后而删除有效 token。

RelayAuth.capture 在认证锁内一次性获取并冻结 vendorId、entityId、供应商 revision、baseURL、key。refresh/probe 只使用这份快照发请求；refresh 在预留、发送前和提交时核验当前身份，完成资格同时受自身 UUID token 约束。旧 key/旧地址/退休实体的迟到结果不能安装到当前目录。

发送前核验不等待通知发布；核验释放锁后直接调用 HTTP，不把网络包进目录锁。最后核验之后的认证变更仍可能与已开始请求重叠，但请求只使用原快照，提交时拒绝旧结果。

### 2.2 条件清理与取消

仅在预留实际提交后承担 token 清理责任。预留前失败直接保留原错误，不额外获取清理锁。成功提交会删自己的 token；其余终止路径以 compare-and-delete 清理一次，不能删除后继请求的 token。

清理等锁预算为 2 秒，保留主错误、清理错误及中断原因；日志只输出非秘密 requestId。10 秒上游超时覆盖响应体读取，避免响应头已返回而正文永久挂起。正常取消进入清理；SIGKILL 不承诺 finalizer，残留 UUID 不持有互斥权，也不触发任务重放，后续刷新可以覆盖。

### 2.3 RF-BF-02：服务构建直接公开未核验目录

旧构建直接 read 后安装候选和 managed，实体检查依赖后续 sync。认证已删除重建、但目录尚未同步就退出时，下次首次模型读取可能使用旧模型。

现在在 Service 返回前通过同一权威事务完成装载。已知实体失配的行清退；未绑定的合法历史行进入同文件 quarantine，不参与 candidates/managed/hasManaged/visible/apply。构建期只登记通知责任，服务完成构建后再投递，避免构建期间的消费者重入。

逐个检查候选的 vendorId/sourceVendorId。managed 能关联多个历史来源时检查所有来源，不能因关联不唯一就跳过来源核验。能唯一关联才合并隔离 kinds；来源不唯一时保留独立建议及已知合法实体，不猜测来源。

### 2.4 同文件 quarantine 与兼容边界

内部形状是 `{ version: 1, entries: [...] }`，位于数据根的 relay-catalog.json。白名单仅含供应商/来源 ID、modelId、missing-entity-binding 原因、candidate/managed 类别、旧 visible/名称/ownedBy、已知合法实体 UUID。

隔离记录不含 key、keyRef、凭据指纹、请求 token 或任意配置原文，也不暴露在 HTTP 响应中。读、复制、比较、编码及其他目录事务都显式保留和校验该字段。未知版本、非法 UUID、空或重复 kinds、重复稳定键拒绝读取且不改文件。

移除活动行、保存隔离、归一化绑定、推进目录版本使用同一次原子 rename。包括只有废弃绑定的修复在内，均在最终归一化后计算变化；真实变化只推进一次，重启不重复隔离。注入失败/取消和真实进程强退后，原文件或新文件始终完整。

刷新只生成当前实体候选，不依据旧 visible 自动勾选。用户对真实刷新得到的当前候选显式提交 setVisibility(expectedEntityId) 后，才在同一事务删除唯一匹配建议。模型不再存在、建议有歧义、缺候选或发生冲突时保留记录。旧勾选因此可能需要重新选择；本轮没有增加隔离管理 UI。

共享数据根的写入者必须全部采用保留 quarantine 的实现。本轮验证两个兼容进程互写；更旧写入者可能丢弃新字段，不能宣称新旧版本混写安全。生产旧版本隔离仍属于 R3-03B。本轮没有操作生产数据或建立配置/源码备份，隔离元数据是新版目录状态本身。

## 3. 修复前与修复后证据

证据根：`C:/relay-fix-20261113`；隔离源码：`C:/obf-20261112`。平台 Windows，Bun 1.4.3，真实浏览器由本地 Playwright 启动。

| 验证 | 最终结果 | 日志 |
| --- | --- | --- |
| 原始根因回归 | 修复前 1 pass / 2 fail；同实体正常保留，重建首次读取和旧实例同步两项失败 | logs/baseline-lifecycle.log |
| 历史多来源补充 | 修复前 0 pass / 2 fail，修复后 2 pass / 0 fail | logs/multiple-sources-red.log、multiple-sources-green.log |
| Core 联合 13 文件 | 156 pass / 0 fail，888 断言，退出码 0 | logs/core-final.log |
| Server 既有真实 HTTP | 4 pass / 0 fail，退出码 0 | logs/http-existing-delivery.log |
| Server 首次读取/隔离恢复 HTTP | 2 pass / 0 fail，退出码 0 | logs/http-lifecycle-delivery.log |
| OpenCode HTTP 与 Provider 联合 | 115 pass / 1 skip / 0 fail，退出码 0 | logs/opencode-consumers-final.log |
| 两套真实设置页面 | 2 passed，退出码 0 | logs/ui-delivery.log、ui/results.json |
| Core/App/Server/OpenCode 类型检查 | 各自 bun typecheck，退出码均为 0 | logs/core-types-delivery.log、app-types-delivery.log、server-types-delivery.log、opencode-types-final-tests.log |
| 本轮九文件格式 | Prettier check 通过 | 交付检查命令输出 |

Core 联合包含 41 条新生命周期回归与 3 条真实插件首次安装回归，已计入 156，不重复相加。覆盖真实子进程共享刷新、同步/并行构建、强杀、旧凭据拒绝、失败和取消条件清理、正文超时、隔离重启、其他进程写入保留、损坏文档、写入失败、不可取消原子提交和 rename 两侧强退。

Server 两个文件因夹具会修改全局环境和 testing.layer，分别在独立测试进程执行。OpenCode 最终四文件在同一测试进程联合通过；唯一 skip 是仓库既有 `provider HttpApi > returns public v2 provider not found errors`，没有计为通过。

## 4. 过程中失败的处理

- 正文超时测试最初受 Bun.serve 默认 idleTimeout=10 秒干扰，先触发了连接关闭。将该受控上游 idleTimeout 设为 0 后，产品自身 10 秒完整请求预算触发 UPSTREAM_TIMEOUT，未延长产品超时。
- 取消提交测试初版错用 Effect v4 不存在的 Fiber.poll，导致夹具收尾等待。已使用 pollUnsafe，并保证断言失败也释放测试屏障；没有削弱取消断言。
- HTTP 隐私测试初版用字符串包含 quarantine 判断，但合法供应商 ID 正好带该词。改为断言不存在 quarantine 属性，密钥不得泄漏的断言保留。
- 扩展旧 HTTP 测试仍断言五个内置商，并假定硬编码 revision=0；与已移除功能不符。现改为实际独立 URL/key 创建、实体身份、命令 receipt 与读取快照区分，并按真实 revision 验证后续写入。
- 扩展批次中的 OAuth 用例曾在 30 秒上限超时；单独复跑约 25 秒，最终同批约 17 秒通过。没有提高上限或跳过。该波动尚未证明产品根因，保留原始日志 `logs/opencode-http-provider.log`、`logs/oauth-isolated.log`，不把首次失败抹掉。
- 实施过程出现的测试类型错误已修复；最终完整类型检查没有以过滤错误代替通过。

## 5. 真实页面覆盖与未覆盖

从隔离源码运行 App 44444、主后端 44096、本地模型上游 44097、第二真实后端 44098，数据与 home/config/state/cache/managed/tmp 全部使用本轮隔离目录。两后端共享隔离数据，使用文件凭据后端和假 key。

两套布局均覆盖：初始读取延迟时同名新增保护、规范化保存、模型获取/勾选、另一真实后端修改可见性后通过页面真实 sync 采纳、同 ID 重建后的旧实体命令 409、重载和再次获取模型，及统一密钥/智联入口已移除。保存 trace 与截图于 `ui/results`。

这仍是既有 relay-settings-consistency.spec.ts 的定向子集，不等于 D3 全表或历史 UI01–UI08 全量验收。没有执行 Linux/macOS、真实系统凭据跨运行时/已安装产物、生产原生锁迁移、RF-07 跨平台/真实取消等历史项目。对应状态保留。

本轮创建的三个服务进程组已停止，44096/44097/44098/44444 监听已释放。未重启或操作用户当前应用。保留本轮隔离日志、trace 和假数据供复核。

## 6. 同步与审查

同步前核对 707 个既有源码/测试文件摘要；主工作区未出现并发漂移。只同步下表九文件及本文，不复制整个隔离目录，不携带启动脚本、运行数据、依赖或构建缓存。同步后核对逐字节摘要、其他既有文件未变，以及 staged diff 摘要仍为空。没有 commit、push、版本变更或生产迁移。

最终 SHA-256：

| 文件 | SHA-256 |
| --- | --- |
| `packages/core/src/relay-auth.ts` | `6221b2155a8efee19cf00b398983d7b0c912681f02809b7214065b2a1e99f6f8` |
| `packages/core/src/relay-catalog.ts` | `c3b7f451891731d1f4ef35231df8bba075067aaaa0b13a4cd439cf6ac474ac63` |
| `packages/core/test/scheduled-model-identity.test.ts` | `6bd34bf0fe2fb5f741b0b247a96f4bb4854452309b85d18f0c5154745c30a2a8` |
| `packages/core/test/relay-catalog-lifecycle.test.ts` | `2f320e0ea8ab8078178c438a61f75d6f02feb3fc3e5d89b54cd4293d0c93c954` |
| `packages/core/test/relay-catalog-plugin-lifecycle.test.ts` | `7fcc7525a16b11fc84d93cd46c1822590589a22a1f7157678fec21d62d72d6d6` |
| `packages/core/test/fixture/relay-refresh-writer.ts` | `084afe743b7b0b5156781496e4796cb05cdebbddeefdf83fde9f85cff9e779c6` |
| `packages/server/test/relay-catalog-lifecycle-handler.test.ts` | `72dcc500e2b9294a6d92549c81b8d8ae1ab318b63fd9f98bd85fe61449916c7d` |
| `packages/opencode/test/server/httpapi-relay-auth.test.ts` | `8ef669003e0d9efca3cce6601f49cdfe9ad72f12a39b3488bcd4c7df000807e3` |
| `packages/opencode/test/server/httpapi-relay-base-url.test.ts` | `835c922936c7fded3efc40eda8659623611c548590862559cc1b84df7269c006` |

完整摘要另见 `C:/relay-fix-20261113/evidence/validated-files.json`。主工作区验收核对见 `evidence/main-verification.json`。本轮结论仅覆盖本文列明范围，不声明项目不存在其他 Bug。
