# 图片设置修复结果复核与剩余修复实施方案

日期：2026-11-17。版本：1.0。状态：**方案待实施；本次仅复核文档并制定计划，不新增测试通过记录。**

> 后续实施结果：见 [2026-11-17 最新本机结果](./image-settings-remaining-results-2026-11-17.md) 及其同候选证据。下文为原始计划，保留历史口径；不因本机通过自动关闭跨平台、全部 B2 强化项或完整 IMG-R4。

## 1. 依据与复核结论

依据：

- [修复结果](./additional-bugs-fix-results-2026-11-16.md)，以末节“2026-11-17 关闭顺序与并发不重入补测”为最新候选记录。
- [后续修复方案 v1.7](./image-settings-followup-fix-plan-2026-11-17.md)，保留其关闭策略、安全约束和 F1/F2/C 矩阵。
- [四项缺陷实施方案](./image-settings-four-fixes-implementation-2026-11-16.md)，保留第 5 节 IMG-T/CL 验收义务。

本次是结果文档复核，不是重新执行测试或独立源码验收。旧候选中的缺口不能直接当作当前缺口；最新候选的总通过数也不能替代逐项断言核对。

### 1.1 已记录成果

| 项目 | 已记录结论 | 边界 |
| --- | --- | --- |
| CL-05 持续 stat 失败分支 | 已修复并有永久回归 | 不代表 close 拒绝后的资源恢复 |
| CL-07 重复 retire 等待 | 已修复并有正常/失败对照 | 不据此关闭全部清理入口 |
| 内部 close cause | 首要 close 失败的内部 EIO 链保留 | prepare 主失败不覆盖；不进入公开错误；无独立 HTTP close-secret 用例 |
| C-01/C-02/C-03 | helper 组合及真实服务取消已记录通过 | 租约释放、后继保存成功不等于 uncertain 句柄恢复 |
| F1-06 写入失败 | 已记录 close→unlink→rmdir 顺序、prepare/EACCES、目标不变 | 不覆盖 Windows DACL 准备失败的独立注入 |
| F1-07、F2-04、F2-05 | 活动句柄保护、删除次数、并发跳过已有任务已记录通过 | 需核对断言时点、异常收尾和现有任务引用 |

最新记录：Core 定向 42 pass / 1 skip / 0 fail；Core 联合 83 pass / 1 skip / 0 fail；Server 19 pass / 0 fail；OpenCode 198 pass / 0 fail；三包 typecheck 退出 0。环境仅 Windows / Bun 1.4.3；POSIX skip 不算通过，Bun 1.3.14 未验证。

候选记录的 HEAD：`6b051f12a21094df1adef83f9fddfcbb765b319e`。关键 SHA-256：

- `packages/core/src/config/atomic-document.ts`：`27d9ee118ff8a0941cc2376b8af9ca8154955e34ae98dc8b53f9fe044e416a46`
- `packages/core/test/config/atomic-document.test.ts`：`19b131ec486d15174c0cfad9f2218c839d04d7c914d8ea43ceb41d653f48a3f9`
- `packages/core/src/util/settled-io.ts`：`b628fe867a7cc237390e1a98816001483e6b6c719c03e441e1105a54b1dd1ff0`

这些是结果文档记载的摘要，不是本次重新计算值；实施前必须重新核验。

### 1.2 对前次停止结论的修正

不能断言“当前范围内已无工作”。权限准备失败在后续方案第 6 节和原 CL-05 中是必测要求，不是可以直接省略的可选项。IMG-T02/T03/T08/T09/T10、CL-08～CL-10 的子场景仍须对照当前测试逐项映射；目前是证据待核验，不预判它们全部缺测或全部通过。

安全恢复受限不阻止继续完成本机保守责任管理、真实服务/HTTP 回归和证据归档。IMG-R4 的源码验收与 GUI/EXE、跨平台验收分别记录，不互相代替。

## 2. 范围与不可变约束

本轮目标：补齐适用必测场景和可核查证据；只有新回归确认产品缺陷时才做最小生产修复。

- 不重启应用，不写生产配置目录，不提交、不推送、不 reset/stash，不覆盖无关修改。
- 不自动构建或启动 EXE；不以本方案视为 GUI、额外账户或平台环境的操作授权。
- 不改变 HTTP 契约、锁协议、`drainWithCause`。
- `retryCleanup` 仍是唯一恢复入口。unknown 发布和身份未知对象继续隔离。
- close 拒绝仍为 uncertain：不自动重试、不按裸 fd 关闭、不按路径重开冒充原句柄、不删除证据、不虚报释放。
- 注入解除、GC、fixture 清理及子进程退出不算产品恢复。
- 受支持分支失败必须记 fail；缺证据记 not-run/待核验，不能改记 skip。安全恢复子项按既定决策记 skip（受限/未实现）。

## 3. 分阶段实施

### A：固定候选并整理矩阵（先执行）

1. 记录实际 HEAD、分支、运行时、平台及相关源码/测试 SHA-256；未跟踪文件也必须入清单。存在 `.codegraph/` 时按仓库要求先用 CodeGraph 定位实现。
2. 以原 IMG-T/CL 和后续 F1/F2/C 为行，建立子场景矩阵：要求、测试文件与名称、实际断言、运行证据、状态及限制。禁止只按标题匹配。
3. 保留历史候选，不覆盖旧计数。明确最新记录中新增四项断言对旧缺口的替代关系。
4. 核验日志是否可完整取得、候选前后摘要是否存在；没有则对新候选重新采集，不补造旧日志或历史红测。

产物：独立证据目录中的 `baseline.json`、`matrix.md`、缺口清单。退出条件：每个适用子项都有映射或明确缺口，未决事项不隐藏。

### B：补权限准备失败及测试收尾证据

涉及：`packages/core/test/config/atomic-document.test.ts`，默认不改产品代码。

#### B1：Windows DACL 准备失败（必测）

- 注入必须落在已创建阶段目录、已取得 FileHandle、尚未写正文的文件安全描述符准备步骤，不能用 open EACCES 或 write EACCES 冒充。
- 优先采用隔离子进程和自有 fixture：构造在安全描述符读取/设置步骤真实失败的测试输入，例如不存在的独立 `securitySource`，并确认失败确实来自该步骤；仅有“publish 拒绝”不足以定位。
- 若该方法不能稳定命中，先验证窄边界注入的可行性；不要未经验证断言 ESM 绑定可拦截，也不要先增加生产测试钩子。必须抽取平台适配边界时，先登记理由和影响，再评审最小改动。
- 断言：正文写入次数为 0；发布次数为 0；已取得句柄的真实 close 完成后才 unlink/rmdir；结果仍为 prepare；既有目标字节和身份不变（创建路径目标不存在）；已确认归属的责任清理完成。
- 追加权限准备失败叠加清理失败的对照：主 prepare 原因不被覆盖，未完成责任保留；故障解除后只清理、不重新发布。close 拒绝对照必须维持 uncertain，不把清理归零设为该分支预期。
- 在 Windows 覆盖创建与既有目标的适用路径；POSIX chown/chmod 失败在独立平台分项验收，不伪装本机通过。

#### B2：核验已有四项补测质量

- F1-06 的顺序记录应以 close 成功结算为准，不仅记录 close 调用开始。需要时用 close 闸门证明结算前无 unlink/rmdir。
- F1-07 在后台扫描和第二次保存的前置扫描后、放行写入前都核对活动句柄仍未关闭及对象仍存在。
- F2-04/F2-05 必须有闸门前返回、同一任务不重入和完成后计数证据；保留 publisher 与扫描任务引用，异常路径也排空。
- 所有直接改写的 handle 方法分别恢复，不能只依赖 fs 的 mockRestore；验收断言应先于 finalizer 的注入恢复与夹具兜底。

B2 是复核要求，不预判现有用例失败；仅补实际缺失断言。

### C：补真实服务/HTTP 与 IMG-R4 证据

涉及：`packages/core/test/image-generation-settings.test.ts`、`packages/server/test/image-generation-settings-handler.test.ts`、AtomicDocument 测试。

| 优先级 | 场景 | 必须核验/补充的证据 |
| --- | --- | --- |
| P1 | IMG-T02、T09 prepare | 真实提交前失败，旧字节/无关字段不变，安全未提交错误，发布不重放 |
| P1 | 内部 close-secret → HTTP | 注入假秘密和路径的 close 拒绝经真实服务/handler 输出固定安全错误；不透传内部 cause；不靠 fake Service 替代链路 |
| P1 | IMG-T03、CL-10 | 真实发布成功后目录删除一次/持续失败，服务与 HTTP 仍成功、磁盘新值、责任存在；恢复只清理且不二次保存 |
| P1 | CL-08 | unknown 后扫描与再次保存不删除证据/关联目录、不重发，计数不双算 |
| P1 | CL-09 | create、replace、publishCopy、retire 各自权限/版本约束及清理失败结果；不能以 create 通过代表其他入口 |
| P2 | IMG-T08 | alias、初始读取、持锁后读取、无效文档逐项安全错误、不发布、无底层原文 |
| P2 | IMG-T09 普通异常 | 与 prepare/unknown 分类边界一致，公开固定文案、无自动备用写入 |
| P2 | IMG-T10 | get/返回/磁盘一致；BOM/CRLF/注释保持；等待期间目标变化后不写入失效目标 |
| P2 | IMG-T07a/b | 等锁取消和投递前取消分别证明发布 0、文件不变、租约无泄漏 |

已存在有效断言则直接映射，不重复实现。实际缺口补永久回归。Effect 测试实施前加载仓库 Effect 技能；复用已有真实服务组装及同一 ConfigDocument 锁，租约观察不得借用另一套 Global/锁实例。

HTTP close 拒绝可能遗留 uncertain 句柄，使用隔离子进程及假凭据；退出只负责夹具收尾，不能写入恢复通过结论。

### D：仅对新确认缺陷做最小修复

1. 先保存当前候选上的失败输出，确认不是夹具或注入错误。
2. 明确影响范围：提交/清理边界、句柄责任、身份验证、错误映射或租约生命周期。
3. 修复不得把 committed 改回 prepare，不得吞掉 unknown、不放宽隔离、不通过删断言取得通过。
4. 若需改 HTTP、锁协议、取消 helper 或 uncertain 策略，停止当前修复，先补专项设计和评审。
5. 每次源码或测试修改形成新候选，重跑对应门禁；不回退用户工作区制造历史红测。

### E：同候选门禁与归档

从对应包目录使用隔离 runner。先执行定向，再执行联合及完整类型检查；新增测试文件必须加入命令清单。

```powershell
# D:\opencode\packages\core
node D:/opencode/script/test-isolated.mjs test --timeout 30000 test/config/atomic-document.test.ts test/settled-io.test.ts test/image-generation-settings.test.ts
node D:/opencode/script/test-isolated.mjs test --timeout 30000 test/config/atomic-document.test.ts test/config/document.test.ts test/settled-io.test.ts test/image-generation-settings.test.ts test/scheduled-task-cancel.test.ts
node D:/opencode/script/test-isolated.mjs run typecheck

# D:\opencode\packages\server
node D:/opencode/script/test-isolated.mjs test --timeout 30000 test/image-generation-settings-handler.test.ts test/relay-auth-handler.test.ts test/relay-commit-handler.test.ts test/relay-catalog-lifecycle-handler.test.ts test/relay-probe-completion-handler.test.ts
node D:/opencode/script/test-isolated.mjs run typecheck

# D:\opencode\packages\opencode
node D:/opencode/script/test-isolated.mjs test --timeout 30000 test/config/atomic-entry.test.ts test/config/tui.test.ts test/config/config.test.ts
node D:/opencode/script/test-isolated.mjs run typecheck
```

并发定向连续三轮，每轮新进程/隔离根；重复通过不替代闸门断言。记录完整命令、工作目录、开始/结束时间、退出码、原始输出、隔离根及前后摘要。超时或无明确退出码不能记 pass。

建议证据目录：`specs/evidence/image-settings-remaining-2026-11-17/`。只归档相关文件摘要和脱敏日志，不打包整个工作区，不保存真实凭据。没有历史日志的项明确缺失。

## 4. 需环境或专项设计的工作

| 项目 | 前置条件与实施方向 | 当前裁定 |
| --- | --- | --- |
| uncertain 安全恢复 | 提供指定运行时下产品可观察的安全证据，再评审有界重试、唯一认领、直接/保存前置/并发扫描 | 不启用自动恢复；受限/未实现 |
| Bun 1.3.14 | 独立获准运行环境，不替换本机运行时；执行同候选适用门禁 | 未验证 |
| Linux/macOS 权限 | 独立平台环境；验证 owner/group/mode、权限准备失败及清理行为 | 本机 skip 不算通过 |
| 第二主体访问 | 获准的隔离账户/环境，分别核验阶段目录与文件暴露窗口 | 不自动创建账户或更改用户权限 |
| 路径替换窗口 | 评审平台原语与攻击模型，区分可观察身份替换和检查后竞争 | 当前不承诺抵御恶意并发替换 |
| GUI/EXE | 明确构建/启动授权、独立产物和测试配置；不替换正在运行的应用 | 未授权，不执行 |
| 崩溃后持久恢复 | 独立持久责任与重放设计 | 不纳入本轮进程内修复 |

上述工作不阻止 A～E，但不能在最终报告中被悄悄删除或改写为通过。

## 5. 验收与交付口径

分三层交付，不能用“完成”混指：

1. **已复现缺陷修复**：保留 CL-05/CL-07 已有局部关闭结论，新增缺陷按自身回归关闭。
2. **本轮自动化源码验收**：A～E 完成，适用必测全部有直接断言和同候选证据，无未决策略、未运行必测或适用失败；可以限定为“本轮自动补修验收通过，安全恢复能力受限”。IMG-R4 的源码侧结论必须核对 CL-01～CL-10、真实服务/HTTP 和相关入口，不凭总数关闭。
3. **完整交付验收**：平台、第二主体、路径安全要求和 GUI/EXE 等按原方案各自判断。源码侧通过不自动关闭完整 IMG-R4 或全部 ADD/QA。

最终追加结果应包含：矩阵逐项状态、修复范围、生产文件是否变动、日志路径与摘要、三包门禁、skip/not-run 原因、未实现能力、是否构建/启动/提交。历史记录保留，最新入口明确指向本轮结果。

**执行顺序：A → B → C → 必要时 D → E；专项环境工作另行准入。当前可以继续补证据和本机必测，不应因安全恢复受限而停止全部任务。**
