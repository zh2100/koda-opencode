# 未提交内容五项缺陷修复实施方案

日期：2026-11-09  
范围：本轮审查已复现的五项问题。本文仅为实施方案，不代表代码已修改或验收通过。

修订：补齐旧会话入口、真实图片授权、MCP 来源读取错误契约和测试隔离四项复核缺口。本文规定的是实施及验收要求，不能仅凭文档完整就认定缺陷已修复。

## 1. 目标、边界与执行顺序

| 编号 | 优先级 | 问题 | 完成目标 |
| --- | --- | --- | --- |
| UC-01 | P1 | 权限过滤后重新加入托管图片工具 | 产品会话发往供应商的工具与权限决策一致 |
| UC-02 | P2 | MCP 只读来源返回展开后的凭据 | 来源编辑接口始终保留未展开引用 |
| UC-03 | P2 | Images 404 自动改发 Chat 请求 | 一次调用只使用明确选择的协议 |
| UC-04 | P2 | Desktop 环境对象类型错误 | 完整 Desktop 类型检查通过且启动环境语义不变 |
| UC-05 | P2 | 供应商慢刷新测试缺少执行边界 | 回归稳定验证旧结果不能覆盖新结果 |

建议顺序：记录基线 → UC-01 → UC-02 → UC-03 → UC-04 → UC-05 → 联合回归 → 隔离界面验收 → 整理交付。

实施约束：

- 保留现有未提交内容，不执行整树恢复、清理或全量暂存。
- 不重启当前应用及服务器，不读取或修改生产凭据，不写生产迁移标记。
- 使用临时目录、内存数据库和测试令牌；图片测试不得调用真实收费接口。
- 测试从对应包目录执行，类型检查使用 `bun typecheck`。
- 不直接修改生成客户端。本次 UC-02 将调整公开 GET 错误契约，必须执行客户端及旧 JavaScript SDK 生成，并审阅生成差异。
- 本方案不关闭 R3-03B，不启用迁移 apply，不扩大到原生锁跨平台验收。
- 本轮不需要修改 App session/timeline。若实施扩大到这些文件，先按 `packages/app/AGENTS.md` 记录生产构建性能基线。

## 2. 第一步：记录修改前基线

### 2.1 记录范围

1. 读取 `git status --short`，确认哪些文件已经修改、哪些文件尚未跟踪。
2. 阅读本方案涉及文件的工作区 diff，区分现有功能改动与本轮新增修复。
3. 将命令、退出码、失败用例和测试环境记录到单独的验收结果文档；不要把结果预先写成通过。
4. 不把图片 artifacts、历史方案或其他功能顺带加入修复提交。

### 2.2 已知基线

上轮定向检查结果仅供比较，实施时以当前代码重新执行结果为准：

- App 定向测试：94 项通过。
- Desktop 定向测试：42 项通过；完整类型检查有两处 `XDG_STATE_HOME` 的 TS2339。
- Core 定向测试：102 项通过、1 项失败；失败为 UC-05 对应的慢刷新时序测试。
- UC-01 已通过真实 `LLMClient.prepare` 复现：过滤后的工具列表为空，准备后的请求仍包含托管 `image_generation`。
- UC-02 已通过真实 HTTP 路径复现：环境配置直接获胜时，来源接口返回测试令牌的展开值。
- UC-03 已通过实际 `ImageGeneration.generate` 与受控 HTTP 客户端复现：一次调用先发 Images，再发 Chat。

### 2.3 先补失败用例

每项先加入能在当前代码失败的回归，再改实现。同一用例修复前后的差异必须来自真实入口，不在测试中重写业务决策。

## 3. UC-01：收口图片工具权限

### 3.1 根因与目标行为

当前路径：模型 body 的 `imageGeneration:true` 被转成 route 默认 providerOptions；会话权限随后移除本地工具；Responses lowering 看见本地同名工具缺失，重新加入托管工具。托管工具由供应商执行，不能依赖事后的本地 `Permission.assert` 拦截。

目标：产品会话统一使用已经实现权限检查、独立模型选择和凭据解析的本地图片工具。通用 LLM 库仍可为直接调用者保留显式托管图片能力，但产品配置中的普通模型选项不再自动授予该能力。

### 3.2 主要文件

- `packages/core/src/session/runner/model.ts`
- `packages/core/src/session/runner/llm.ts`
- `packages/core/src/session-policy.ts`、`src/tool/registry.ts`、`src/tool/image-generation.ts`：核对既有权限路径，按需修改。
- `packages/llm/src/protocols/openai-responses.ts`
- `packages/opencode/src/session/llm.ts`
- `packages/opencode/src/session/llm/native-request.ts`、`native-runtime.ts`：保持适配边界，不向适配层引入会话服务。
- `packages/core/test/session-runner.test.ts`
- `packages/core/test/tool-image-generation.test.ts`
- `packages/core/test/scheduled-authorization.test.ts`
- `packages/core/test/image-generation-authorization.test.ts`：拟新增真实权限集成测试。
- `packages/opencode/test/session/llm-native.test.ts`
- `packages/opencode/test/session/llm.test.ts`
- `packages/llm/test/provider/openai-responses.test.ts`

### 3.3 具体实施步骤

1. 在 runner 现有测试设施中构造 Responses 模型，给模型 body 写入 `imageGeneration:true`。准备 plan、显式 deny、普通允许三类会话。
2. 使用真实模型解析、工具 materialize 和请求构造路径，将截获的请求继续交给 `LLMClient.prepare`，检查最终原生 body。不要只检查中间的 `request.tools`。
3. 在模型适配中去掉“模型 body 开关直接变成托管授权”的映射。继续剔除这个控制字段，避免它作为普通 HTTP body 参数透传。
4. 在 Core 产品会话最终构造请求的位置显式设置 `providerOptions.openai.imageGeneration = false`，并保留 `promptCacheKey` 等无关选项。已有独立准备验证表明 request 的 `false` 能覆盖 route 默认的 `true`；实施时仍需将该组合固化成自动回归。不能用删除字段或 `undefined` 代替。
5. 对模型变体、连接 metadata 和模型/route 默认值分别验证覆盖。旧会话入口不是可选检查：在 `packages/opencode/src/session/llm.ts` 的 session-owned 编排边界，完成配置、插件参数准备后、分流到 native/AI SDK 前，规范化产品会话的托管图片选项为禁用。保留其他 providerOptions，不直接修改共享模型或全局配置对象。
6. 保留本地图片工具的权限声明与 `Permission.assert`。plan 不提供此工具；显式 deny 不提供此工具；ask 在获准前不得产生图片 HTTP 请求；auto 仍须遵循已有授权规则。
7. 核对达到最大 agent steps 的路径：工具列表为空时也不能因模型开关重新提供托管图片能力。
8. 通用 LLM lowering 不引入 Core、Session 或 Permission 依赖。保留直接调用者显式启用托管图片的库级测试，更新注释，说明同名工具去重不构成会话授权检查。
9. 如果未来需要产品会话支持托管图片，另行设计供应商执行前的授权能力；本轮不要通过简单布尔开关重新开放。

### 3.3.1 旧会话入口的必做步骤

1. 沿 `LLM.run → LLMRequestPrep.prepare → native gate → LLMNative.request` 核对参数流。保留权限、插件及运行时选择在 `llm.ts` 的边界，不向通用 LLM 包或 `native-request.ts` 注入会话服务。
2. native 请求适配仍转换已经规范化的输入。在 `llm-native.test.ts` 中，从产品调用边界传入开启托管的配置或选项，经过适配及真实 `LLMClient.prepare` 检查最终 body；不能只在测试输入中手工改成 `false`。
3. 在 `llm.test.ts` 经过真实 `LLM.Service` 运行时分流，验证 native 开启、默认 AI SDK、native 不支持而退回 AI SDK 三条产品路径。用受控传输/执行器捕获最终交给供应商的参数，确认均未启用托管图片。
4. 若 AI SDK 路径使用的选项格式不同，在它现有的产品适配边界处理；不要假定 native 的字段格式自然覆盖 AI SDK。
5. 保留原有受控工具、普通文本、headers、prompt cache 和其他 providerOptions 的回归。产品禁用托管能力不应清空所有供应商参数。
6. `llm-native.test.ts` 与 `llm.test.ts` 是本项必跑文件，不得因 Core 测试通过而跳过。没有该组合覆盖，UC-01 不得关闭。

### 3.3.2 真实图片授权集成测试的必做步骤

现有 `tool-image-generation.test.ts` 中的权限服务替身只能证明工具调用了断言入口；现有调度授权测试的写文件场景也不能替代图片工具授权。新增 `image-generation-authorization.test.ts`，使用真实 `PermissionV2.node`、会话存储、所需投影与真实 `ImageGenerationTool`，仅替换模型响应及图片上游传输等外部边界。

1. 在隔离目录/数据库中创建真实会话、agent 和独立图片模型配置。使用真实工具注册与执行入口，不能在测试中重新实现模式判断。
2. 模型受控返回图片工具调用，图片上游记录请求次数、协议与模型；正常返回本地假图片样本。
3. ask 场景等待真实权限请求出现，以权限事件或 Deferred 建立同步边界；确认权限仍 pending、工具未结束、图片请求数为 0。
4. 通过真实 `PermissionV2.reply` 允许该请求，等待工具结束，确认图片生成请求数为 1，且目标为独立模型配置的协议和模型。
5. 用新的会话或清除作用域内授权状态再运行拒绝场景，通过真实 reply 拒绝；确认请求数仍为 0，无隐式替换协议或模型。
6. plan 场景确认工具没有被暴露；对受控模型仍返回该工具调用的防御场景，确认没有图片请求，不能通过执行入口绕过。
7. 显式 deny 场景覆盖普通会话与 auto 会话，确认规则仍有效；auto 无显式 deny 时按产品既有规则执行一次，不额外增加未经设计的确认行为。
8. 复用既有调度授权设施，增加真实 scheduled session 调用图片工具的 ask/auto/plan 组合，作为本项必验场景，断言实际图片请求次数；不能只检查会话的 `approvalMode` 字段。
9. 取消等待授权时，以测试 finalizer 回收权限请求、模型流和工具 fiber；不使用固定 sleep 证明“尚未请求”，不让已批准状态污染后续用例。

上述用于关闭缺陷的集成测试禁止 mock `PermissionV2.assert`、`ask` 或 `reply`。原有工具单测可继续使用其替身，但不能单独作为授权验收证据。

### 3.4 回归矩阵

| 场景 | 预期 |
| --- | --- |
| plan + 模型开关开启 | 最终 body 无本地及托管图片工具 |
| 显式 deny + 模型开关开启 | 同上，无图片 HTTP 请求 |
| ask + 选择独立图片模型 | 先进入现有权限流程，未同意时零图片请求 |
| ask 拒绝 | 无图片请求，无其他协议或模型回退 |
| auto/allow + 独立工具可用 | 仅暴露本地 function，按所选模型执行 |
| 最后一个 agent step | 工具禁用，不重新加入托管图片工具 |
| 模型变体/连接默认值开启托管 | 产品会话最终请求仍不启用托管图片 |
| 旧会话 native 开启 + 上游选项开启托管 | 产品最终 Responses body 无托管图片工具 |
| 旧会话默认 AI SDK 或 native 回退 | 同一产品禁用策略仍有效，普通参数保持 |
| 真实权限服务 + ask 允许/拒绝 | pending 为零请求；允许一次；拒绝零次 |
| auto + 显式 deny | 零图片请求，不被 auto 覆盖 |
| LLM 库直接显式开启托管 | 独立于产品会话，保持原有库能力 |
| LLM 库同时传入本地同名工具 | 不重复暴露托管工具 |

### 3.5 完成条件

必须同时证明 Core 与旧会话的最终请求没有被绕过、真实权限服务的图片授权矩阵通过、普通供应商参数未丢失。仅修改布尔值、仅让 lowering 单测通过，或只运行 mock 权限的工具测试，均不能关闭此项。

## 4. UC-02：所有 MCP 来源统一返回未展开原文

### 4.1 根因与目标行为

`Config.mcpSource()` 对非绝对路径来源和 managed 文件提前返回 `config.mcp[name]`；这是主加载器展开后的运行配置。后面的 raw 来源链合并仅覆盖可写文件。

目标：运行时仍使用展开配置建立连接；来源接口统一使用原文重建配置。`writable` 只决定能否保存，不能决定是否暴露展开值。

### 4.2 主要文件

- `packages/opencode/src/config/config.ts`
- `packages/opencode/test/config/config.test.ts`
- `packages/opencode/test/server/httpapi-config.test.ts`
- `packages/opencode/src/config/mcp-edit.ts`：仅在需要复用现有解析/错误处理时调整。
- `packages/opencode/src/server/routes/instance/httpapi/groups/config.ts`
- `packages/opencode/src/server/routes/instance/httpapi/handlers/config.ts`
- `packages/opencode/src/server/routes/instance/httpapi/errors.ts`
- `packages/app/src/components/settings-v2/dialog-mcp-v2.tsx` 及对应表单/浏览器测试：核对 GET 错误状态，不涉及 session/timeline。
- `packages/client` 与 `packages/sdk/js` 的生成产物：通过生成命令更新。

### 4.3 具体实施步骤

1. 新增五类“直接获胜、没有可写本地覆盖”的测试：`OPENCODE_CONFIG_CONTENT`、well-known URL、managed 文件、组织配置、managed preferences。后两类的跨平台服务替身可以提供原始文本，但来源记录、解析和合并使用真实实现；未覆盖的实际平台能力须另记待验收。
2. 测试配置包含 `{env:REVIEW_MCP_TOKEN}` 和临时文件引用；使用纯测试占位值，不使用真实密钥。MCP 配置设为禁用，防止加载时连接外部服务。
3. 将 `mcpSource()` 的处理分为两个独立判断：重建原文配置；计算可写性及版本。移除直接返回展开 `entry` 的只读分支。
4. 继续使用主加载器实际记录的 sources 顺序。远程、环境、组织或托管内存来源使用加载时保存的 raw text；文件来源沿用现有受控原文读取。
5. 为所有来源确定其最后一次参与合并的位置。文件沿用既有文件身份比较；URL、环境等来源使用来源 ID 比较，不能要求所有 ID 都是绝对路径。
6. 按主加载器相同的优先级深度合并到获胜来源为止，保留继承 headers 与未展开引用。重复加载同一个文件时仍截到最后一次，不能退回第一次。
7. 可写文件继续先核对磁盘条目：条目已删除就返回缺失，不能用缓存链补回来。保留已有冲突、缺失、只读和非法文档错误语义。
8. 对 raw 文本采用不会做 env/file 替换的解析路径。核实 schema 校验不会间接展开引用。
9. 按第 4.3.1 节确定的契约区分缺失、非法文档和读取失败。调整 `Config.mcpSource` 的 Effect 错误类型、GET 契约及 handler 映射，禁止回退到已展开 `entry`，禁止把所有失败都吞成 `undefined`。
10. 只读来源保持 `writable:false`，版本字段保持现有接口约定；不能因为重用文件分支而变成可写。
11. 来源读取不得额外重新请求 well-known 地址或重新进行登录，避免查看设置产生网络副作用及不一致的第二份快照。
12. 保存仍只写用户补丁，不把继承字段或展开值写回项目文件。

### 4.3.1 来源读取与保存的确定契约

| 操作与状态 | 对外结果 | 约束 |
| --- | --- | --- |
| GET：没有该 MCP 条目，或获胜文件已删除 | 保持现有 200 空结果约定 | 内部 `undefined` 沿用现有 wire 编码；不得用缓存补回条目 |
| GET：有效文档中已移除该条目 | 同上 | 不能当空的可编辑本地配置 |
| GET：原文无法解析、schema 无效或合并后结构无效 | HTTP 400，`MCP_DOCUMENT_INVALID` 与 `ref` | 不能返回空、残缺配置或展开值 |
| GET：读取失败，如 EACCES/EIO | HTTP 503，新增 `MCP_SOURCE_READ_FAILED` 与 `ref` | 不暴露系统错误全文或文件内容 |
| GET：已知获胜来源的 raw 记录不可用或来源链不能可靠重建 | HTTP 503，`MCP_SOURCE_READ_FAILED` 与 `ref` | 不重新登录、不回退展开配置 |
| GET：只读来源正常 | 200，原文配置，`writable:false` | 只读性不导致读取报 403 |
| PATCH：提交到只读来源 | 保持 HTTP 403，`MCP_SOURCE_READ_ONLY` | 不写磁盘 |
| PATCH：来源/条目已缺失 | 保持 HTTP 404 及现有对应 code | 不创建旧条目 |
| PATCH：文档非法或读取失败 | 分别 HTTP 400/503，使用上述对应 code | 不改磁盘、不将读取错误误报成版本冲突 |
| PATCH：版本/来源冲突 | 保持 HTTP 409 及现有对应 code | 不覆盖用户外部修改 |

实施细节：

1. 领域层扩展现有 `McpEditError` 的 code 列表及状态映射，加入 `MCP_SOURCE_READ_FAILED`，名称保持兼容；领域层不依赖 HttpApi 错误类型。
2. `Config.Interface.mcpSource` 声明可失败的领域错误类型。原文读取区分 ENOENT、读取异常、解析失败和条目不存在，不能再使用同一个 `undefined` 代表全部状态。
3. `readMcpDocument` 当前会吞解析异常。为来源读取增加可区分的解析结果或复用可返回错误的解析路径；同时保留已有保存验证语义，避免只给外层加 catch 却仍拿不到失败原因。`get()` 初始化或 PATCH `invalidate()` 后重载也可能先遇到文档损坏，须在同一来源服务调用边界将可识别的配置解析/读取失败映射到对应领域错误；不能只覆盖末端 `readRawMcp()`，也不能把所有未知 defect 统一伪装成配置错误。
4. sources 中正常记录的可选文件原本就可能不存在，不能因此一律报 503。区分“加载时未贡献配置的可选来源”与“本条目所依赖的来源原文不可用”。缺少必需继承信息时停止并报错，不静默跳过后返回不完整的连接信息。
5. 扩展 `McpConfigUnavailableError` 的允许 code 及通用 MCP code 清单；GET `mcpSource` 明确声明 400/503 错误，handler 使用一致的领域错误到 HTTP 错误映射。
6. PATCH 的同一映射也处理新增读取错误，保留 403/404/409 的现有含义。禁止用 `MCP_WRITE_FAILED` 冒充读取失败。
7. 错误正文仅含已声明的 code/ref；原始 cause 只用于受控服务诊断，不能携带凭据写入响应或普通日志。
8. 按第 8.7 节重新生成两套 SDK，检查 GET 错误联合包含 400/503 及 code/ref。此步骤是必做项，不再作为可选工作。
9. App 来源读取沿用 `throwOnError:true`。400/503 时显示已有本地化加载失败状态并允许重试，保存保持禁用；有旧缓存时也不能清除冲突或把旧缓存重新当成成功读取。
10. 不必重新设计运行时 `/config` 契约。本项保护的是来源编辑接口及保存路径，不宣称原始配置里显式写入的字面量已经被脱敏。

### 4.4 回归用例

- 环境配置直接获胜：返回 `{env:...}`，响应全文不含测试令牌展开值。
- well-known 直接获胜：返回原始 URL、类型、headers、引用，且只读。
- managed 文件直接获胜：返回未展开 env/file 引用，且拒绝写入。
- 组织配置与 managed preferences 分别直接获胜：原文引用保留，来源身份正确，返回只读。
- 远程连接配置 + 本地仅覆盖 `enabled:true`：连接信息完整，引用保持原文。
- 多层 headers：不同键同时保留，同名键以高优先级为准。
- `.opencode` 覆盖、同文件重复加载：现有场景继续通过。
- 删除磁盘获胜条目：来源接口仍返回缺失。
- 获胜文档与必需继承文档分别损坏：HTTP 400，code/ref 正确，响应不含展开值，不返回残缺成功结果。
- 受控 EACCES/EIO、raw 记录不可用：HTTP 503，code/ref 正确；源文件字节未改变。
- 可选且未贡献配置的文件不存在：不被误判为读取失败。
- 有缓存旧值时读取 400/503：App 保持加载失败及保存禁用；重新加载成功后才恢复比较与保存。
- 保存补丁后读取项目文件：没有测试密钥明文，也没有无关继承字段。

HTTP 用例须经过真实来源路由。服务级与 HTTP 级都检查凭据占位值；不要只检查 `writable:false`。加载远程来源的首次请求可命中受控测试服务，但同一已加载实例再次调用来源接口不得新增远程获取或登录请求。

### 4.5 完成条件

五类只读获胜来源均有服务级覆盖；环境、远程与 managed 文件直接获胜有 HTTP 覆盖；GET 400/503、空结果、PATCH 错误不写盘和 App 缓存失败状态均验证通过；两套 SDK 生成并通过相关类型检查。原有来源合并、删除、版本冲突及补丁保存测试全部通过。managed preferences 的非当前平台真实系统验收另行记录，不能用服务替身冒充平台验收。

## 5. UC-03：移除 Images 404 的隐式协议回退

### 5.1 主要文件

- `packages/core/src/image-generation.ts`
- `packages/core/test/image-generation.test.ts`
- `packages/core/test/tool-image-generation.test.ts`
- `packages/opencode/src/tool/image-generation.ts`：核对是否共用 Core 实现，避免只修一条运行路径。

### 5.2 具体实施步骤

1. 将现有“Images 缺失时使用 Chat”的成功测试改为明确的失败回归，显式传入 `api:"openai-images"`。
2. 受控客户端让 Images 返回 404；Chat 端预设可成功响应，以便检测隐藏的回退。
3. 断言结果为 `ImageGeneration.Error`，HTTP 调用数组只有一次 Images 请求。
4. 删除 404 分支中的自动 `chat()` 调用，让 404 与其他非成功状态进入既有协议错误处理。
5. 保留显式 `openai-chat` 分支；它应直接发 Chat，一开始就不访问 Images。
6. 对旧配置未提供 api 的底层默认行为保留现有约定，但不得因此启动协议探测。产品工具已有“未选择协议”校验则保持该校验。
7. 检查旧运行时实际调用路径；共用 Core 实现时复用修复，不复制一套实现。
8. 错误只说明当前协议失败、需要检查配置，不声称上游肯定未产生费用，不输出上游完整响应或认证信息。
9. 如果涉及 UI 新增可见提示，使用既有 i18n 机制；此项通常可以只修 Core，无需扩展界面。

### 5.3 回归矩阵

| 输入/响应 | 预期请求数及结果 |
| --- | --- |
| Images + 200 合法数据 | 一次 Images，成功 |
| Images + 404 | 一次 Images，失败 |
| Images + 401/403/429/500 | 每例一次 Images，失败 |
| Chat 显式协议 + 200 | 一次 Chat，成功，零 Images |
| Chat + 404 | 一次 Chat，失败，零 Images |
| 请求超时/取消 | 不发其他协议请求，不重放 |
| 图片工具遇协议错误 | 走既有失败返回，不换模型、不换协议 |

### 5.4 完成条件

所有错误分支没有第二次生成请求，显式 Chat 和 Images 的成功路径均正常；不通过真实收费接口验证。

## 6. UC-04：修复 Desktop 环境对象类型

### 6.1 主要文件

- `packages/desktop/src/main/background-cli-compat.ts`
- `packages/desktop/src/main/background-cli.test.ts`

### 6.2 具体实施步骤

1. 在 Desktop 包运行 `bun typecheck`，记录两处 TS2339 的当前基线。
2. 将 `commandEnv()` 内的 `env` 声明为 `NodeJS.ProcessEnv` 或仓库已经采用的等价环境变量类型。
3. 继续复制 `process.env`，不要直接修改全局环境；保留 `OPENCODE_NATIVE_LOCK_DIR=dirname(binary)`。
4. 保留现有 `stateHome` 语义：未提供时从返回对象删除 `XDG_STATE_HOME`；提供时设置到返回对象。
5. 不用 `any`、`@ts-ignore`、关闭检查或只过滤错误文件的方式通过类型检查。
6. 测试增加：显式 stateHome、未提供 stateHome、保留无关环境变量、调用后 `process.env` 不变。
7. 必须临时变更测试进程环境时保存旧值，并在 finally/测试清理中恢复；不要让其他测试依赖执行顺序。
8. 执行 Desktop 完整类型检查及已有 CLI 暂存、启动、更新定向测试。

### 6.3 完成条件

Desktop 完整 `bun typecheck` 退出码为 0，启动环境测试通过；无需启动或重启 Electron。

## 7. UC-05：为慢刷新测试增加受控执行边界

### 7.1 根因与边界

目前 fork 慢刷新后立即更换密钥并刷新。fork 不保证 HTTP 已发出；新刷新可能先成为第一个请求，等待 release，而 release 又位于新刷新完成之后，形成死等。

此项修复对象首先是测试，不凭该超时修改生产目录刷新逻辑或延长生产超时。

### 7.2 主要文件

- `packages/core/test/relay-catalog.test.ts`

### 7.3 具体实施步骤

1. 在现有 `release` 之外增加 `started` Deferred，表示第一笔受控 HTTP 已经进入。
2. 受控 HTTP 第一笔请求先记录旧密钥和请求地址，完成 `started`，再等待 `release`。
3. fork 旧刷新后，主协程必须先等待 `started`；只在确认旧请求已悬挂后提交新密钥。
4. 使用新 revision 提交密钥，发起 fresh 刷新；第二笔请求立即返回 `new-model`。
5. 断言 fresh 返回新模型，并记录第二笔请求确实使用新密钥，防止“两个请求都使用新配置”的假阳性。
6. 释放第一笔请求，等待旧刷新结束，再读取最终 catalog，确认仍是新模型。
7. 将 release 完成和 fiber 中断/回收放入现有 Effect scope/finalizer。即使断言或配置提交失败，也能结束挂起任务；确保等待 fiber 结束前先释放它依赖的 Deferred。
8. 给测试设置有限的整体超时作为死锁检测，不把固定 sleep 当同步边界，不放大生产 HTTP timeout。
9. 单独运行该用例后运行完整 relay-catalog，再与 relay-auth、secret-store 联合运行，核对有无跨测试污染。
10. 针对此竞态用例进行有限重复运行，例如 10 次；出现一次失败就保留日志并调查，不用“重跑后绿了”替代修复。

### 7.4 应验证的顺序

`旧密钥提交 → 旧请求进入并悬挂 → 新密钥提交 → 新请求完成 → 旧请求释放 → 最终目录仍为新结果`

### 7.5 完成条件

完整测试稳定通过，断言同时覆盖请求使用的凭据与最终目录结果；失败清理不遗留悬挂 fiber。

## 8. 包级验证命令

以下命令从仓库根目录开始定位。执行测试前完成隔离设置；一项失败时先保留原始失败，不继续把该项记录为通过。

### 8.1 全部测试子进程的隔离前置步骤

Core 的 preload 没有统一重定向全部 XDG 路径，`OPENCODE_CONFIG_DIR` 又可覆盖 XDG 配置目录。以下准备必须在导入业务模块、执行包内 preload 或启动验收后端之前完成。建议在专用 PowerShell 会话中执行，所有 Bun 命令作为它的子进程继承隔离环境，结束后关闭该测试会话；不要修改系统/用户永久环境变量。

先清除本次测试不得继承的路径、配置内容、权限覆盖、运行时开关与录制开关。需要特殊配置的用例在自己的隔离子进程中显式注入，不能复用当前应用的值。

```powershell
$reviewRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('opencode-uc-review-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $reviewRoot | Out-Null
foreach ($reviewName in @(
  'OPENCODE_CONFIG',
  'OPENCODE_CONFIG_DIR',
  'OPENCODE_CONFIG_CONTENT',
  'OPENCODE_TUI_CONFIG',
  'OPENCODE_PLUGIN_META_FILE',
  'OPENCODE_PERMISSION',
  'OPENCODE_DISABLE_PROJECT_CONFIG',
  'OPENCODE_PURE',
  'OPENCODE_WORKSPACE_ID',
  'OPENCODE_EXPERIMENTAL',
  'OPENCODE_EXPERIMENTAL_NATIVE_LLM',
  'OPENCODE_NATIVE_LOCK_DIR',
  'OPENCODE_CONSOLE_TOKEN',
  'RECORD'
)) {
  Remove-Item -LiteralPath ('Env:\' + $reviewName) -ErrorAction SilentlyContinue
}
$env:OPENCODE_TEST_HOME = Join-Path $reviewRoot 'home'
$env:XDG_DATA_HOME = Join-Path $reviewRoot 'data'
$env:XDG_CONFIG_HOME = Join-Path $reviewRoot 'config'
$env:XDG_CACHE_HOME = Join-Path $reviewRoot 'cache'
$env:XDG_STATE_HOME = Join-Path $reviewRoot 'state'
$env:OPENCODE_TEST_MANAGED_CONFIG_DIR = Join-Path $reviewRoot 'managed'
$env:OPENCODE_DB = ':memory:'
$env:OPENCODE_DISABLE_MODELS_FETCH = 'true'
$env:TEMP = Join-Path $reviewRoot 'tmp'
$env:TMP = $env:TEMP
foreach ($reviewDirectory in @(
  $env:OPENCODE_TEST_HOME,
  $env:XDG_DATA_HOME,
  $env:XDG_CONFIG_HOME,
  $env:XDG_CACHE_HOME,
  $env:XDG_STATE_HOME,
  $env:OPENCODE_TEST_MANAGED_CONFIG_DIR,
  $env:TEMP
)) {
  New-Item -ItemType Directory -Path $reviewDirectory -Force | Out-Null
}
```

还须执行以下步骤：

1. 在测试子进程中删除供应商 API key、真实 server auth、代理/远程端点和账号令牌等本用例未声明使用的外部认证/地址覆盖；只为受控上游注入测试凭据。优先复用包内已存在的清理列表，并检查新增供应商变量，不能仅依赖 OpenCode preload 替其他包清理。
2. 每个测试的 Global/Location 仍显式指向 scoped 临时目录。针对 `OPENCODE_CONFIG_DIR` 的回归必须把它设为临时子目录；`OPENCODE_CONFIG` 必须是临时文件；`OPENCODE_CONFIG_CONTENT` 只能包含本用例文本。
3. 在创建会执行写入的服务前，检查实际生效的 home、config、data、state、cache、managed、数据库与 Location，而不只打印环境变量。路径必须位于本次隔离根或该测试明确创建的 scoped 临时根中；解析实际已有路径，排除指向生产目录的 junction/符号链接。数据库允许明确的 `:memory:`。
4. OpenCode preload 会重新分配进程专用目录；其父临时目录也应留在隔离范围。测试检查以 preload 完成后的有效目录为准，不能假设父 PowerShell 设置就是最终值。
5. 增加隔离设施自测：先传入两个不同临时目录模拟“继承的配置覆盖”与“本轮隔离根”，执行清理/重定向后构建真实 Global，确认实际配置根落在隔离根、模拟旧根的哨兵文件不变。不得用真实生产目录做该验证。
6. 资源根检查失败立即停止该用例，不访问目标文件内容，不启动后端，也不能自动创建迁移完成标记来绕过失败。
7. 测试结束通过现有 scoped fixture 回收本轮创建的文件和服务。若人工清理临时根，先核对解析后的绝对目标确为本轮创建目录，再用同一 PowerShell 的 `Remove-Item -LiteralPath` 清理；不递归删除计算后未经核验的路径。

隔离检查是执行门槛。任何目录未确认都不能标记测试环境合格，也不能运行会写配置或凭据的验收步骤。每条测试/类型检查命令单独记录 `$LASTEXITCODE`，不能只记录整段脚本最后一个命令的退出码。

### 8.2 LLM

```powershell
Set-Location D:\opencode\packages\llm
bun test test/provider/openai-responses.test.ts --timeout 30000 --only-failures
bun typecheck
```

LLM 层测试使用已有 fixture/受控客户端，保持 `RECORD` 关闭。

### 8.3 Core

```powershell
Set-Location D:\opencode\packages\core
bun test test/session-runner.test.ts test/tool-image-generation.test.ts test/scheduled-authorization.test.ts --timeout 30000 --only-failures
bun test test/image-generation-authorization.test.ts --timeout 30000 --only-failures
bun test test/image-generation.test.ts test/image-generation-settings.test.ts --timeout 30000 --only-failures
bun test test/relay-catalog.test.ts test/relay-auth.test.ts test/relay-secret-store.test.ts --timeout 30000 --only-failures
bun typecheck
```

新增用例如果放入新的测试文件，加入上述命令；不要只运行旧文件后宣称新用例已通过。

### 8.4 OpenCode

```powershell
Set-Location D:\opencode\packages\opencode
bun test test/config/config.test.ts test/server/httpapi-config.test.ts --timeout 30000 --only-failures
bun test test/session/llm-native.test.ts test/session/llm.test.ts --timeout 30000 --only-failures
bun typecheck
```

沿用包内 preload 的隔离 XDG、managed 目录与内存 DB 设置，同时执行第 8.1 节的覆盖清理及有效目录检查。旧会话两份测试是 UC-01 的必跑项。需要不同环境配置启动加载器时，使用隔离子进程，避免模块缓存与全局环境串扰；native 开关必须由该用例显式指定。

### 8.5 Desktop

```powershell
Set-Location D:\opencode\packages\desktop
bun test src/main/background-cli.test.ts src/main/cli-staging.test.ts src/main/updater-controller.test.ts src/main/koda-release.test.ts electron-builder.config.test.ts --only-failures
bun typecheck
```

### 8.6 App 兼容回归

本轮不必扩大到全套界面测试；保留 MCP 表单与核心同步的定向兼容检查，并为新增 GET 400/503 的加载失败、重试、缓存及保存禁用状态补充真实组件或浏览器用例。现有纯表单测试不能单独证明对话框的查询错误行为。必须使用包规定的浏览器条件，直接 `bun test` 的 JSX/Solid 失败不能当产品缺陷。

```powershell
Set-Location D:\opencode\packages\app
bun test --tsconfig-override ./tsconfig.test.json --conditions=browser --preload ./happydom.ts src/components/settings-v2/mcp-form.test.ts src/context/server-sync.test.ts src/context/global-sync/bootstrap.test.ts src/context/global-sync/queue.test.ts src/context/file/tree-store.test.ts --only-failures
bun typecheck
```

新增对话框组件/浏览器测试使用包内对应运行设施，将确切文件及执行命令加入结果记录。若修改了 App，运行完整 App 类型检查，不通过时记录具体失败，不能仅过滤本轮文件宣称通过。

### 8.7 UC-02 公开错误契约与 SDK 生成（必做）

GET 的 400/503 及 `MCP_SOURCE_READ_FAILED` 是本方案确定的公开契约变化，完成领域错误、HTTP 声明及 handler 后执行：

```powershell
Set-Location D:\opencode\packages\client
bun run generate
bun typecheck
Set-Location D:\opencode
bun ./packages/sdk/js/script/build.ts
```

生成命令可能读取 Schema/Server/OpenCode 相关服务，仍使用第 8.1 节的隔离环境。执行后核对：

1. 两条生成命令分别退出 0，未手写 `src/generated` 或 `src/generated-effect`。
2. 生成的 MCP 来源 GET 错误联合包含 400/503、对应 code/ref；PATCH 的 503 联合接受新增读取错误。
3. HTTP 回归用实际生成客户端调用来源 GET，确认错误不会被解码成成功或空结果，`throwOnError` 行为符合现有 SDK 契约。
4. 重新检查消费者的类型，包括 OpenCode、App、Client；若涉及 Protocol/Server 包，再跑对应包 `bun typecheck`。
5. 检查生成差异是否只来自本轮实际契约；无关变更先查原因，不盲目提交。生成及消费者检查未完成时，UC-02 保持未关闭。

## 9. 隔离界面验收

自动验证通过后，再使用独立数据根与空闲端口启动专用验收实例。启动前确认端口空闲，不终止已有进程；后端环境必须在启动前完成隔离，前端明确连接该验收后端。

### 9.1 MCP

1. 配置只读来源并填入测试 env/file 引用，打开设置。
2. 检查原始来源响应保留引用，不出现测试令牌展开值；检查只读提示与保存禁用状态。
3. 切换到可写项目来源，仅编辑一个字段并保存，核对磁盘只有该补丁。
4. 外部修改配置制造 409；确认重新加载与字段冲突行为保持正常。
5. 分别让来源原文损坏与受控读取失败，确认 GET 对应 400/503，弹窗保持加载失败、保存禁用，并提供重试；即使存在旧缓存也不能清除冲突。
6. 恢复原文与读取条件后重试，确认成功读到原文、重新比较草稿，且不会自动再次提交配置。

### 9.2 图片权限与协议

1. 使用受控供应商测试端点，记录收到的请求，不连接真实图片服务。
2. plan 或 deny 场景下，确认没有图片请求，也没有供应商托管图片工具。
3. ask 场景确认获准前没有图片请求，拒绝后仍没有请求。
4. 显式选择 Images 并返回 404，确认只收到一次 Images 请求；界面显示失败，不自动请求 Chat。
5. 改为明确选择 Chat，确认仅请求 Chat。

只有实际操作并记录结果后才能标记“界面通过”。未搭建隔离实例时记录“界面待验收”，不能由单测代替。

## 10. 交付与关闭标准

每项单独记录：修复文件、根因、失败回归名称、修复后命令/退出码、剩余限制。建议状态使用“待修改 / 自动验证通过 / 界面待验收 / 已验收”。

关闭规则：

- UC-01：Core 与旧会话三条运行路径的最终请求回归通过，真实权限服务覆盖普通/调度会话的图片授权组合，普通参数保留，产品交互完成隔离验收后关闭。
- UC-02：五类只读来源、明确错误契约、真实 HTTP/生成客户端和 App 错误状态回归通过，SDK 生成及消费者类型检查完成，MCP 界面完成隔离验收后关闭。
- UC-03：错误请求数、显式两协议成功路径通过，界面失败流程完成隔离验收后关闭。
- UC-04：完整 Desktop 类型检查与启动环境回归通过即可关闭；不能据此声明安装包验收通过。
- UC-05：执行顺序确定、清理可靠、有限重复和联合回归通过即可关闭；不扩大表述为生产目录逻辑全部验收。

提交前按文件/片段审阅 `git diff --cached`，只纳入这五项修复必需内容；不要执行 `git add .`。是否提交、推送及发版按后续明确指令执行，本方案本身不触发发布。

### 10.1 防止漏项的交付清单

以下清单每一项都要附对应测试名称、命令和结果。未执行不得填“通过”；失败不得用另一批通过结果抵消。

- [ ] Core runner 最终 prepared body：plan、deny、最后一步、默认值覆盖。
- [ ] 旧会话 native、AI SDK、native 回退三条路径：托管禁用且普通参数保留。
- [ ] 真实图片权限：ask pending/允许/拒绝、plan、auto、auto + deny；不以权限 mock 替代。
- [ ] 调度会话图片工具授权组合：使用真实 scheduled session，观察实际图片请求数。
- [ ] 五类只读 MCP 来源直接获胜：服务级覆盖完整，指定 HTTP 场景通过。
- [ ] 来源缺失、400 非法原文、503 读取失败、必需继承链失败与可选来源缺失可区分。
- [ ] GET 失败时不展开引用、不返回残缺成功结果；PATCH 相同失败不写盘。
- [ ] MCP 对话框 GET 失败/缓存/重试/保存禁用行为通过，既有冲突保护保留。
- [ ] Client 与旧 JavaScript SDK 生成通过，实际生成客户端及消费者类型检查通过。
- [ ] Images/Chat 明确协议与错误路径请求次数符合约定。
- [ ] Desktop 完整类型检查与启动环境回归通过。
- [ ] 目录慢刷新顺序确定、失败清理可靠，有限重复及联合回归通过。
- [ ] 配置覆盖变量清理、真实生效路径检查和模拟覆盖隔离自测通过。
- [ ] 隔离界面验收有操作记录；未做部分明确标记待验收。
- [ ] R3-03B、跨平台/安装包真实验收等不在本轮范围的项目保持原状态。
