# 五项修复复核后的补修实施方案

日期：2026-11-09  
状态：待实施。本文仅规定补修步骤与验收要求，不代表业务代码已修改。

## 1. 依据与范围

本方案补充以下记录，不覆盖或删除历史测试结果：

- 原实施方案：`specs/uncommitted-fixes-implementation-plan-2026-11-09.md`。
- 原结果记录：`specs/uncommitted-fixes-results-2026-11-09.md`。
- 后续复核：图片相关四个测试文件独立重跑 48 项通过；新增隔离复现确认 UC-02 仍有三处缺陷。服务级三例及 HTTP 两例的失败属于三个问题的不同验证层次，不能计为五个独立缺陷。

| 补修编号 | 对应项目 | 性质 | 当前证据 | 完成目标 |
| --- | --- | --- | --- | --- |
| RF-01 | UC-02 | 已确认缺陷 | 首次读取损坏文档，HTTP 400 错误含配置原文及测试凭据，没有 code/ref | 初始化、重载和末端读取统一遵守安全错误契约 |
| RF-02 | UC-02 | 已确认缺陷 | 环境来源仅覆盖 enabled，来源接口丢失继承 URL、headers | 当前环境原文在来源链正确位置参与合并 |
| RF-03 | UC-02 | 已确认缺陷 | 缓存加载后删除获胜文件，GET 返回 404 | GET 缺失返回 200 空结果，PATCH 缺失保持 404 |
| RF-04 | UC-01 | 验证缺口 | 部分测试自行构造禁用选项及 plan 规则；缺少正常 auto 放行场景 | 用真实 runner、会话和权限规则验证产品路径 |
| RF-05 | UC-05 | 验证缺口及记录错误 | HTTP 位于提交许可之外；测试未固定新响应先完成，也未记录两次凭据 | 证明真正的乱序返回不会覆盖新目录，并修正记录 |

实施顺序：记录新基线及失败回归 → RF-01 → RF-03 → RF-02 → RF-04 → RF-05 → 联合自动回归 → 结果记录 → 隔离界面验收。

RF-01 涉及错误响应带回配置内容，应先处理。RF-04、RF-05 首先补强验证；只有真实回归进一步证明生产逻辑有缺陷时才调整对应生产实现。

## 2. 实施约束与准备

1. 保留所有现有未提交内容，不执行整树恢复、全量暂存或清理，不生成备份。
2. 不重启当前应用或服务，不读写生产配置、凭据、迁移标记，不启用迁移 apply。
3. 沿用原方案第 8.1 节的隔离准备，在业务模块导入前完成。额外清理新增的 `OPENCODE_TEST_MANAGED_PREFERENCES`，特殊来源用例自行注入并在清理阶段恢复。
4. 核验实际生效的 Global、Location、数据库、managed 和临时路径。不能只凭 XDG 环境变量判断隔离成立。
5. 仅使用本地测试令牌。图片及模型请求使用受控传输，禁止真实收费请求；`RECORD` 保持未设置。
6. 先添加真实入口失败回归，再改实现。原有通过项保留；不能删除边界用例或放宽断言以满足统计数字。
7. 测试从包目录执行；类型检查使用 `bun typecheck`，每条命令单独记录退出码。
8. 本轮不需要调整 App session/timeline。如果范围实际扩大到该部分，先按 App 规范记录生产构建性能基线。
9. 本方案状态为待实施；原来的通过记录保留为历史证据，不能覆盖本次复核失败。

## 3. RF-01：初始化及重载失败不得返回配置原文

### 3.1 根因与边界

当前 `mcpSource()` 通过 `InstanceState.use(...).pipe(Effect.orDie)` 获取配置。首次初始化时解析失败会变成 defect，未经过末端 `readRawText()` 的错误映射。通用错误响应仍可能序列化 `ConfigJsonError.data.message`，其中包括输入文档。

仅在 `readRawText()` 外加 catch 或给 GET 增加错误联合，不能修复初始化失败。必须覆盖真实 HTTP 路径中的首次加载、实例上下文初始化、失效后重载及已有缓存后的读取。

### 3.2 修改位置

- `packages/opencode/src/config/config.ts`：来源服务加载、解析及错误转换。
- `packages/opencode/src/config/mcp-edit.ts`：复用既有领域 code/ref。
- `packages/opencode/src/server/routes/instance/httpapi/handlers/config.ts`：领域到 HTTP 映射。
- `packages/opencode/src/server/routes/instance/httpapi/groups/config.ts`：核对 GET/PATCH 错误声明。
- 实例 HTTP middleware / 通用错误处理：先定位实际抛出点，只在确认 handler 之前即失败时调整必要边界。
- `packages/opencode/test/config/config.test.ts`、`test/server/httpapi-config.test.ts`。

### 3.3 具体步骤

1. 新增服务级用例：实例尚未初始化时写入非法 JSONC，然后第一次调用 `Config.mcpSource()`。断言领域错误为 `MCP_DOCUMENT_INVALID`，带非空 ref。
2. 新增 HTTP 用例：从新实例第一次 GET `/config/mcp/:name`，配置包含唯一的假凭据字符串且文档语法损坏。保持原文只存在于隔离文件中。
3. 对响应同时断言状态为 400、code 正确、ref 非空；正文不得包含假凭据、`JSONC Input`、完整输入、原始 cause 或解析器长消息。不能只断言 HTTP 400。
4. 核对失败发生于 handler 内还是实例 middleware。初始化发生在 handler 前时，必须在该路由可达的适当边界转换；不能仅修改一个根本未执行到的 handler。
5. 在领域层将可识别的 `ConfigJsonError` / `ConfigInvalidError` 转为 `MCP_DOCUMENT_INVALID`；将确认为来源读取 I/O 的失败转为 `MCP_SOURCE_READ_FAILED`。保留中断与取消，不将未知编程错误统一伪装为配置错误。
6. 复用现有可识别错误判断或小型明确转换边界；不将包含全文的错误对象直接附到公开错误、用户提示或普通日志中。
7. 核对完整原文合并后的 schema 校验。同步抛出的解析异常也应进入上述转换，不能因末端 `ConfigParse.schema()` 抛错再次绕过契约。
8. 对 PATCH 的 `invalidate()`、重载及后续读取应用一致映射。补“已有旧实例 → 磁盘改坏 → PATCH”的回归，断言失败且源文件字节不变。
9. 对失败后修复文件的情形执行现有失效/重试路径，确认新调用能成功；不要求重启应用，也不能缓存失败为永久状态。
10. 通用错误处理若必须改动，保留其他路由既有公开契约。对新的配置错误映射做局部和真实完整路由验证，不直接扩大成全站错误处理重构。

### 3.4 错误契约与测试矩阵

| 场景 | 预期 |
| --- | --- |
| 首次加载语法损坏 | 400 / MCP_DOCUMENT_INVALID / ref，无原文 |
| 首次加载 schema 无效 | 同上 |
| 缓存加载后文件改坏再 GET | 同上，无缓存成功回退 |
| invalidate 后重载损坏再 PATCH | 同上，磁盘不改写 |
| 明确的读取拒绝或 I/O 失败 | 503 / MCP_SOURCE_READ_FAILED / ref，无系统错误全文 |
| 文件修复后按既有路径失效并重试 | 成功读取 raw 引用，不需重启 |
| 测试取消 | 正常取消与清理，不返回伪造配置错误 |

HTTP 错误正文仅使用已声明契约字段；tag 按现有 Schema 约定保留。状态码一致但正文不符合契约仍视为失败。

### 3.5 完成条件

服务级、完整 HTTP 首次加载及重载场景通过，所有错误响应均不含测试凭据或配置全文，PATCH 失败不写盘，修复后能重试。

## 4. RF-03：统一 GET 缺失语义并保持 PATCH 保护

### 4.1 根因

来源链循环中，`readRawText()` 对获胜文件 ENOENT 抛出 `MCP_SOURCE_MISSING`；只有非获胜来源的缺失被捕获。程序在后面的“获胜条目是否已删除”判断之前就结束，因此 GET 返回 404。

### 4.2 具体步骤

1. 新增真实路径：先成功 GET 来源并保存 source/version，随后删除获胜文件，再 GET 同一已加载实例。
2. 断言第二次 GET 为 200 空结果，沿用现有 `undefined → null` 的 wire 约定；不得返回旧条目、空的可编辑条目或 404。
3. 在来源重建前先读取获胜文件，并明确区分 ENOENT、合法文档无条目、非法文档和 I/O 失败。获胜缺失仅在 GET 返回空；不能把 EACCES/EIO 一并吞掉。
4. 同一次读取中复用获胜文件的这份原文，既用于参与合并，也用于计算 version。移除为了确认存在而再次读取但只更新 version 的模式，避免配置来自一次读取、版本来自另一次读取。
5. 不在测试中模拟“先返回旧正文、再返回新哈希”的伪成功；用受控读取边界验证发生变更时返回的 config/version 必须来自同一份获胜文本。
6. PATCH 仍在获得源文件锁后重新验证。GET 返回空时，PATCH 转为现有 404，不重建已删除文件；版本/来源改变仍为 409。
7. 区分缺失的获胜文件和缺失的继承来源。原本未贡献配置的可选文件可不存在；本条目依赖的继承原文缺失不能静默跳过后返回不完整连接配置。使用加载时记录的原文或来源贡献记录作出判断，不将“文件扩展名是 JSON”当成已贡献配置的证据。
8. 保留现有“合法文件中删除条目后返回空”的回归，补完整文件删除、managed 文件删除及必要继承来源丢失场景。

### 4.3 必测结果

| 操作 | 预期 |
| --- | --- |
| GET 获胜文件删除 | 200 / null |
| GET 合法文件删除该条目 | 200 / null |
| GET 获胜原文损坏 | 400，不能变成 null |
| GET 获胜文件读取失败 | 503，不能变成 null |
| PATCH 使用旧 source/version 保存已删除文件 | 404，文件不重建 |
| PATCH 保存读取后已被修改的文件 | 409，不覆盖 |
| 必需继承来源不可重建 | 503，不返回残缺成功结果 |

## 5. RF-02：环境原文在来源链原位置参与合并

### 5.1 根因

当前来源链先正确深度合并，随后在 `source === "OPENCODE_CONFIG_CONTENT"` 分支使用 `raw = parsed.entry`，用当前环境的局部条目替换了整个合并结果。环境来源只写 `enabled` 时，继承连接字段全部丢失。

### 5.2 具体步骤

1. 添加失败回归：项目文件提供 remote 类型、URL、headers 原始引用；环境来源只设置同名条目的 `enabled:false`。
2. 先确认运行时合并完整，再检查来源接口也包含完整连接信息，同时原始 env/file 引用未展开。
3. 删除末端用环境条目整体替换 raw 的处理。将环境当前原文作为来源链该条目的输入，在原位置按既有优先级深度合并。
4. 每次来源读取只采集一次当前环境原文，供该次解析与版本计算共同使用。不能在合并之后再次读环境并替换结果。
5. 保持来源链截止到实际获胜来源最后一次参与合并的位置；不得为了重读环境把它移动到所有来源末尾，覆盖优先级更高的组织或 managed 配置。
6. 当前环境来源被删除或不再包含该条目时，返回现有缺失语义，禁止用缓存把已经删除的获胜条目补回。后续完整重载是否采用较低优先级来源，继续遵循主加载器规则。
7. 当前环境内容非法时返回 RF-01 的 typed 400，不返回旧环境内容或 runtime 展开值。
8. 对非获胜的环境来源，仍采用与该次加载/来源链一致的原始快照。若选择重载整个链，必须保持 loaded.config、origins、sources 一致；不能只替换 origins 或私自改变当前获胜来源。
9. 输出只读状态不变，保存仍只写本次用户补丁；不得把环境继承字段落入项目文件。

### 5.3 回归矩阵

- 环境仅覆盖 enabled：保留继承 type、URL、headers。
- 环境增加另一个 header：两层 header 均保留，同名键由环境覆盖。
- 环境完整配置：保持现有直接获胜回归。
- 首次读取后环境局部内容变化：本次 GET 使用单次采集值，保留继承字段。
- 当前环境非法、删除或移除条目：分别按 400 或缺失语义处理。
- 环境之上还有组织/managed 来源：高优先级来源仍获胜。
- 同一项目文件重复加载：保留最后一次参与合并的截止位置。
- 真实 HTTP 场景验证来源完整且不含测试令牌展开值，不能只做服务级断言。

### 5.4 完成条件

服务级和 HTTP 层均覆盖局部继承；环境读取、来源身份、深度合并和版本来自一致输入；五类只读来源的既有回归保持通过。

## 6. RF-04：用真实产品路径补齐图片授权验证

### 6.1 当前缺口

- `image-tool-permission.test.ts` 的辅助函数自行写入 `imageGeneration:false`，不能单独证明真实 runner 会写入该字段。
- `image-generation-authorization.test.ts` 在测试中自行构造 plan 的 deny/read 规则，无法检测生产规则转换被破坏。
- 场景表没有正常 auto 放行用例；scheduled auto 场景中又把 agent 规则替换成通用 ask，无法证明真实 agent deny 被保留。

这些是验证缺口，不直接宣称现有生产授权逻辑失效。

### 6.2 真实 runner 请求回归

1. 在 `packages/core/test/session-runner.test.ts` 的真实会话执行设施中增加用例，或新增独立文件复用该设施。
2. 使用会话公开创建/提示入口启动执行，保持真实 runner、模型解析与工具 materialize。不通过测试辅助函数预先写入托管禁用选项。
3. 在受控 LLM 服务边界截获真实 runner 构造的原始请求，原样交给真实 `LLMClient.prepare`。允许替换供应商传输，禁止在该边界补写 `imageGeneration:false`。
4. 在模型、变体或连接默认值设置托管开关为 true，分别覆盖 plan、显式 deny、普通允许及最大 steps 的工具禁用路径。
5. 同时断言原始产品请求显式禁用托管、最终 prepared body 无托管工具、prompt cache 等无关参数保持。
6. 保留旧会话 native、AI SDK、native 回退三路径 49 项联合验证。新 Core 回归不能取代旧入口，旧入口通过也不能取代 Core。

### 6.3 真实权限与模式回归

1. 保持真实 `PermissionV2.node`、SessionStore、Agent 与 ImageGenerationTool。使用公开会话入口或现有真实调度设施设置模式，随后读取 SessionStore 确认实际模式，不只检查输入参数。
2. 使用生产 `sessionPermissions` / runner materialize 路径形成可见工具。删除测试手写的 plan 规则转换；单独测试转换函数可保留，但不能作为完整执行证据。
3. 增加 auto + ask 规则场景：工具可见，不出现待确认权限请求，实际图片请求恰好一次。
4. auto + 显式 deny 场景：agent 中真实保留 deny；不能为了构造 auto 场景先把 deny 改为 ask。验证暴露列表及实际请求数。
5. 普通与 scheduled 场景分别运行。scheduled 至少经过实际调度创建会话的既有受控设施，并重读会话/agent 状态；只手插同名 metadata 不能替代调度入口验证。
6. ask 允许/拒绝继续通过真实权限事件和 reply 驱动，pending 和拒绝阶段零图片请求，允许后恰好一次。
7. 对 plan/deny 下受控模型强行返回图片工具调用的情形，验证执行入口不能绕过限制。HTTP 请求计数是最终证据，不能仅依赖工具列表断言。
8. 用 scope/finalizer 清理权限等待、订阅和执行 fiber，禁止固定 sleep 判断“没有执行”。

### 6.4 验收矩阵

| 模式/规则 | 工具与授权预期 | 图片请求数 |
| --- | --- | --- |
| ask，等待用户回复 | 真实权限请求 pending | 0 |
| ask，once 允许 | 执行所选独立图片模型 | 1 |
| ask，reject | 拒绝执行 | 0 |
| auto，规则为 ask | 按既有 auto 策略直接执行 | 1 |
| auto，明确 deny | 保留 deny，不执行 | 0 |
| plan | 不暴露图片工具，强行调用也不执行 | 0 |
| 达到最大 steps | 不提供工具，不恢复托管能力 | 0 |

矩阵中普通与调度入口分别记录结果。通过数只能统计实际运行的组合，不把同一份手工规则反复调用当成两个入口。

## 7. RF-05：验证真正乱序刷新并修正记录

### 7.1 正确的生产边界

当前代码的顺序为：计算配置指纹与供应商代次 → `fetchUpstream()` → `commitPermit(...)` → 再确认配置/代次并提交目录。单许可保护提交，HTTP 不在该许可内。

因此，结果文档中“生产刷新在提交前持有单许可，新刷新不能在旧 HTTP 挂起期间完成”的解释不成立。不得依此放宽乱序验证。

### 7.2 测试改造步骤

1. 在 `relay-catalog.test.ts` 使用 `oldStarted`、`newStarted`、`releaseOld`、`releaseNew` 四个边界，分别确认两次请求进入并控制响应释放。每个请求保存独立编号、URL、Authorization 与响应状态。
2. 先提交旧密钥，启动旧刷新，等待 `oldStarted`。在 HTTP 进入时记录旧请求确实携带旧测试密钥。
3. 提交新密钥，启动新刷新，等待 `newStarted`，记录新请求确实携带新测试密钥。此时旧请求仍未释放。
4. 先让新 HTTP 返回，等待新刷新完整结束。断言返回与当前 catalog 均为新模型。
5. 再释放旧请求，让它更晚返回；等待旧刷新结束，再次断言 catalog 保持新模型。
6. 给等待新请求、新刷新及整体用例设置有限超时。若新请求在旧请求未释放时无法完成，先定位实际阻塞点，不能提前释放旧请求把测试改成顺序成功。
7. 单独增加“密钥不变、同一供应商两次刷新”的乱序用例，确保供应商代次保护本身被验证，而不只是配置指纹变化让旧结果失效。
8. 保留跨供应商并行用例，确认 A 的完成不会被 B 的代次丢弃；沿用既有通过项，不重复实现业务逻辑。
9. 将 Deferred 释放与 fiber 回收放在正确的作用域清理中。断言失败时也要先解除受控 HTTP 等待，再等待/中断子 fiber，不遗留挂起请求。
10. 记录关键阶段的事件顺序与凭据断言；只使用测试密钥，不在正式结果记录中打印真实 Authorization。

应证明的顺序是：

`旧请求已进入并挂起 → 新密钥提交 → 新请求已进入 → 新刷新完成 → 旧请求释放并完成 → 最终目录仍为新结果`

### 7.3 稳定性与结果修订

1. 对上述乱序用例进行有限重复，例如 10 次，每次都验证相同里程碑与最终结果；出现一次失败就保留原始输出，不以重跑转绿抵消。
2. 再运行 relay-catalog/auth/secret-store 联合回归。
3. 修正结果文档中关于许可范围的解释，记录实际 HTTP 与提交顺序。
4. 本项不以证明所有生产目录逻辑正确为目标。若新增回归揭示真实生产问题，另列缺陷、根因与修复，不通过改变完成顺序掩盖失败。

## 8. 测试与类型检查命令

先完成原实施方案第 8.1 节的隔离准备及本方案第 2 节的补充清理。以下为包内命令，新增独立测试文件时须把它加入实际命令及结果记录。

### 8.1 OpenCode

```powershell
Set-Location D:\opencode\packages\opencode
bun test test/config/config.test.ts test/server/httpapi-config.test.ts --timeout 60000 --only-failures
bun test test/session/llm-native.test.ts test/session/llm.test.ts --timeout 60000 --only-failures
bun typecheck
```

RF-01 至 RF-03 必须有真实 HTTP 回归。优先复用现有路由设施；涉及 middleware 的局部隔离测试按 server AGENTS 使用 Effect HTTP 测试层，不启动生产监听端口。

### 8.2 Core

```powershell
Set-Location D:\opencode\packages\core
bun test test/session-runner.test.ts test/image-tool-permission.test.ts test/image-generation-authorization.test.ts test/scheduled-authorization.test.ts --timeout 60000 --only-failures
bun test test/image-generation.test.ts test/tool-image-generation.test.ts --timeout 30000 --only-failures
bun test test/relay-catalog.test.ts test/relay-auth.test.ts test/relay-secret-store.test.ts --timeout 30000 --only-failures
bun typecheck
```

不能只重复原来的 48 项通过统计；新增真实 runner、auto 放行、真实调度及乱序里程碑用例必须在本轮命令中实际执行。

### 8.3 App 与 SDK 消费者

```powershell
Set-Location D:\opencode\packages\app
bun test --tsconfig-override ./tsconfig.test.json --conditions=browser --preload ./happydom.ts src/components/settings-v2/mcp-form.test.ts --timeout 60000 --only-failures
bun typecheck
Set-Location D:\opencode\packages\sdk\js
bun typecheck
```

对来源 GET 400/503/空结果时的实际对话框查询状态，补入组件或浏览器用例，不能用纯表单函数测试代替。若需修改 App，只触及必要设置组件并遵循 i18n 规范。

### 8.4 生成与其他兼容检查

- 本次目标是让实现遵守已声明的契约，原则上无需再次扩大 GET 错误联合。403/404/409 的既有声明不能作为 GET 缺失返回 404 的实现依据。
- 若实际调整公开 HttpApi 声明，运行仓库根的 `bun ./packages/sdk/js/script/build.ts`；影响 Protocol/Server HttpApi 时按规范从 `packages/client` 执行 `bun run generate`，不手改生成产物。
- `packages/client` 的契约目前不包含这条实例 MCP 路由，不能用它生成成功代替旧 JS SDK 的错误解码验证。用实际拥有该路由的 SDK，检查 400/503 的 code/ref 与 throwOnError 行为。
- 未改动 Desktop 时不要求为本补修重复完整打包。若其相关代码或依赖发生变化，再执行对应包的定向回归与完整 `bun typecheck`。

## 9. 结果记录与状态修正

实施时更新原结果文档，保留旧命令及退出码，在新的“复核补修”章节追加，不删除之前成功或失败的证据：

| 项目 | 补修前应记录状态 | 可进入下一状态的条件 |
| --- | --- | --- |
| UC-01 | 既有自动测试通过，真实入口/auto 组合验证待补 | RF-04 全部通过后记自动验证完成，界面仍单列 |
| UC-02 | 复核未通过，三处缺陷待修 | RF-01/02/03 服务、HTTP 和消费者回归全部通过 |
| UC-03 | 保留既有自动通过，界面待验收 | 不因本次复核虚构新验收结果 |
| UC-04 | 保留既有自动通过 | 不升级为安装包验收通过 |
| UC-05 | 已有测试通过，乱序/凭据证明待补 | RF-05 固定顺序、有限重复和联合回归通过 |
| R3-03B | 未关闭 | 不属于本方案关闭范围 |

每项附：失败回归名称、修复文件、命令与工作目录、独立退出码、断言内容、隔离方式、平台限制。只有实际执行的结果才能计为通过。

## 10. 隔离界面验收与最终关闭

自动回归通过后，在独立数据根及空闲端口启动验收实例，前端明确连接该后端；不重启或终止当前应用。

1. 环境来源局部覆盖场景打开 MCP 设置，确认连接信息完整、只读状态正确、引用未展开。
2. 首次加载损坏配置及已有缓存后改坏配置，确认显示加载失败、保存禁用，网络响应不包含配置正文或测试令牌。
3. 删除获胜来源，确认 GET 空结果，界面不会据缓存恢复为可保存状态。
4. 恢复来源后重试，确认按新数据比较草稿；重试不能自动提交旧草稿或清除未解决冲突。
5. 图片 ask/auto/plan 与显式 deny 在受控供应商下操作，核对实际请求次数和最终工具列表。
6. 未做上述操作时，仍标“界面待验收”；Windows 来源替身不代表真实 macOS plutil 验收，现有跨平台及安装包限制继续保留。

最终关闭清单：

- [ ] 首次初始化及重载错误均返回安全 typed 响应，无配置原文。
- [ ] 环境局部覆盖保留继承字段，来源优先级与主加载器一致。
- [ ] GET 缺失为空、PATCH 缺失为 404，错误类别没有相互吞并。
- [ ] 获胜 config/version 使用同一份读取文本，必需继承来源丢失不会返回残缺成功结果。
- [ ] Core runner 的真实请求回归不由测试预写禁用选项。
- [ ] 普通与调度图片授权包含正常 auto 和 auto + deny，采用真实规则及权限服务。
- [ ] 新响应先完成、旧响应后完成的目录回归成立，两次凭据均正确。
- [ ] 有限重复、联合回归、对应包类型检查和 SDK 解码验证完成。
- [ ] 原结果记录已按复核事实修正，平台限制及界面待验收项明确。
- [ ] 隔离界面实际验收完成后，才关闭需要产品交互证明的条目。

本方案不自动授权提交、推送或发布。完成后先提供可审阅的代码差异与完整结果，按后续明确指令处理发布。
