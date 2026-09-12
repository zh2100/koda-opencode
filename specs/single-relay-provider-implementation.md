# 雷电动画 OpenCode Fork 落地实施方案

本文将 `specs/single-relay-provider.md` 的产品要求拆成可执行的工程阶段。每个阶段都包含目标、代码边界、数据/API、验证方式和出口条件。实施遵循现有 OpenCode 的 Schema → Core/Protocol → Server → Client → App/Desktop/TUI 依赖方向。

## 1. 交付原则

- 先打通固定 Relay 的运行时请求链，再改界面，再做调度后台。
- Relay Vendor 是全局配置；Project、Session、PTY、文件树、权限和工具注册仍然受 Location 约束。
- 复用现有 Provider、SessionV2、SessionExecution、SkillV2、MCP、PTY 和事件模型，不建立平行运行时。
- 不允许通过 UI 隐藏代替 Server/Core 运行时过滤。
- Relay-only 硬过滤始终开启、没有 gate。按下表独立启用 `relay_core_ui`、`relay_layout`、`relay_skills`、`relay_mcp`、`scheduled_tasks`；Provider/Auth/Catalog 和密钥安全门禁通过后即可启用 Relay 运行时，核心界面验收后可单独交付 A/B，不等待布局、技能、MCP 或调度。
- 公共 Schema/Protocol 变更后从 `packages/client` 执行 `bun run generate`，不得编辑 `src/generated` 或 `src/generated-effect`。
- 测试从对应 package 运行，不从仓库根目录运行。

### Gate 控制范围与交付批次

五个 gate 独立配置，默认关闭；对应能力通过验收后独立默认开启。禁止增加一个聚合 UI gate 覆盖五者。关闭任一 gate 都不能重新启用官方 Provider，也不能撤销其他已通过能力。

| Gate | 控制范围 | 开启条件 / 交付批次 | 关闭行为 |
| --- | --- | --- | --- |
| 无 gate | 官方 Provider 硬过滤、固定 Relay URL、服务端鉴权与模型校验 | 始终执行，任何配置或 UI 状态不能绕过 | 无关闭或回退官方通道的路径 |
| `relay_core_ui` | Desktop/Web 厂商 Key、统一 Key、模型获取/勾选、输入条、项目新建/打开 | Provider/Auth/Catalog、密钥安全及核心 UI 验收通过；A/B 与输入条，工程阶段 5/6；TUI 的 Provider/Key/模型/档位同属 A/B 验收 | 只隐藏或禁用未完成的 Desktop/Web 设置和输入条界面；已有 Key、可见模型和有效 Project/Location 的运行时发送、直接 HttpApi、已验收 TUI 不受影响；无项目、无 Key、无可见模型仍由 Server 拒绝；新用户等待 gate 或使用已验收 TUI/HttpApi 配置；官方 Connect 仍禁止 |
| `relay_layout` | Codex 右栏、子智能体嵌套卡片、App v1/v2 布局 | 布局与卡片 E2E 通过；C/D，工程阶段 7/8 | 使用已验收的基础会话布局；厂商设置、模型选择、项目与发送仍由 `relay_core_ui` 提供 |
| `relay_skills` | 技能发现/启停/详情面板 | Skill source、权限状态和面板验收通过；E，工程阶段 9 | 隐藏新增技能面板；已有技能工具继续按 Permission 运行 |
| `relay_mcp` | MCP 新增管理界面（配置编辑、启停、OAuth/连接状态） | MCP 面板和权限状态验收通过；E，工程阶段 9 | 隐藏新增 MCP 管理界面；现有 `opencode.json` 配置、MCP 连接、OAuth 和工具权限继续按既有运行时工作 |
| `scheduled_tasks` | 已安排任务面板与自动调度循环 | 调度副作用门禁通过；F，工程阶段 11 | 不接受新调度触发；保留任务和运行记录，不重放或隐式终止已有 Session |

发布验证必须覆盖仅 `relay_core_ui` 开启、核心加布局、核心加技能、核心加 MCP、核心加调度、全部开启、所有 UI/调度 gate 全部关闭七种组合。五个 gate 全部关闭时，官方 Provider 仍返回 `PROVIDER_DISABLED`，不出现官方 Connect UI；已有 Key 的运行时发送、直接 HttpApi 和已验收 TUI 不因 UI gate 关闭而被服务端阻断。`relay_layout`、`relay_skills`、`relay_mcp`、`scheduled_tasks` 不相互依赖；调度依赖已验收的运行时与任务能力，不依赖布局、技能或 MCP 面板。总体验收未完成不宣称完整首版，但可分别交付 A/B、C/D/E、F。

### Gate 配置和生效机制

- `relay_core_ui`、`relay_layout`、`relay_skills`、`relay_mcp`、`scheduled_tasks` 由构建/部署配置或受控 feature flag 文件提供；普通用户不能在 UI、`opencode.json`、环境变量 Provider 配置或请求参数中自行打开。
- gate 在 Desktop/App 启动时读取并在当前进程内固定；需要变更时重启 App。`scheduled_tasks` 由 daemon 启动时读取；daemon 运行中不动态改变执行策略。
- Provider/Auth/Catalog 硬过滤、Vendor Key resolver、模型可见性和 Session 安全校验不读取任何 gate。
- `relay_core_ui` 关闭时，Server 仍允许满足 Project/Location、Key、模型可见性和权限条件的已配置请求；关闭只影响新增 Desktop/Web 配置和输入控件。不能用关闭 gate 绕过 `KEY_MISSING`、`PROJECT_INVALID`、`MODEL_UNAVAILABLE` 或 Permission。
- gate 状态应在诊断信息中显示名称和来源，但不显示任何密钥或内部 flag 秘密；未经授权的 gate 值按关闭处理。


## 2. 目标架构

```text
Schema
  Vendor / RelayAuth / RelayModel / Error / ScheduledTask / TaskRun
       ↓
Core
  RelayCatalog / VendorKeyResolver / CapabilityMap / SecretStore / Scheduler
       ↓
Protocol + Server
  Relay HttpApi / Provider policy / Session validation / Location checks
       ↓
Client
  generated SDK only
       ↓
App / Desktop / TUI
  settings / prompt bar / project picker / right panel / task UI
```

运行时请求链：

```text
providerID + modelID + variant
  → Relay managed model registry
  → vendorId
  → unified/vendor key resolver
  → SecretStore Credential
  → fixed https://api.leidiandonghua.cn/v1
  → OpenCode OpenAI-compatible route
```

## 关键风险门禁

以下三项是发布阻断风险。Provider/Auth/Catalog 门禁未通过时不得默认开启 Relay；布局、技能、MCP 和调度门禁只阻止各自入口，不阻止已经通过的 Relay 运行时。开发和测试环境可以显式开启 UI gate，但必须始终保留运行时硬过滤。

### 风险一：只改 UI，运行时仍可使用官方 Provider

**根因**：设置页隐藏不等于运行时禁用。当前 Provider 仍可从 env/config/custom/api 和 Models.dev 进入，旧 session 也可能携带 `anthropic/*`、`openai/*` 等模型。

**必须覆盖的服务端入口**：

- Provider catalog 构建和 `provider.list` / `provider.available()`。
- Models.dev 合并和默认模型解析。
- `opencode.json` provider 配置加载。
- 环境变量 Provider 加载。
- Session prompt 的 `providerID/modelID` 校验。
- TUI 的 Provider、模型和默认模型路径。
- 旧 session 打开和再次发送路径。
- 直接 HttpApi 请求，不依赖前端入口。
- `opencode.json` 中任意 ID 的 `openai-compatible` 自定义 Provider 和任意 base URL。
- `.well-known/opencode` 返回的远程配置、远程 Provider catalog 和连接初始化。
- plugin/provider hook 注册的 Provider。
- `sdk-next`、进程内 Core/Server layer 和不经过 HttpApi 的直接调用路径。

**强制验证**：用配置文件、环境变量、`.well-known/opencode`、自定义 openai-compatible、plugin Provider、旧 session、TUI、直接 HttpApi、sdk-next/进程内 Core 九类入口尝试官方 Provider，全部返回 `PROVIDER_DISABLED`；测试必须在 Server/Core 层完成，不能只截图设置页。

**不可配置绕过规则**：`opencode.json` 中的 `experimental.policies`、`disabled_providers` 或任何等价配置只能收紧权限，不能放开 Relay-only policy。Server/Core 在策略合并后再次执行硬过滤；任何 `allow provider.use`、环境变量、插件 hook 或直接 API 参数都不能恢复官方 Provider。

**Models.dev 隔离规则**：本 fork 的生产运行时允许名单为空，不以“旧版诊断”例外读取官方目录。仅测试允许名单为 `packages/core/test/models.test.ts`、`packages/core/test/plugin/models-dev.test.ts`、`packages/core/test/catalog.test.ts`，只用于隔离 fixture 回归，不注册生产 Provider、不回灌 Relay 数据、不触发生产 Models.dev 网络刷新。Provider catalog、默认模型、Session/TUI/App 选择器、Relay 候选/管理模型与请求解析均不得读取 Models.dev。Relay 元数据来自中转站或经验证的 Relay 能力表；用户仅可修改产品允许的名称/归属，不新增价格或能力编辑器。缺失数据显示原始 ID/未知状态。

### 风险二：v1/v2 漏改造成行为分裂

**根因**：App 同时存在 v1 布局、`newLayoutDesigns`、`TerminalPanel` 和 `TerminalPanelV2`，只修改其中一套会出现窗口行为不一致。

**必须统一的行为源**：

- Provider/Vendor/模型选择和 Key 状态。
- Project/Location 切换和草稿。
- 输入条的模型、档位、批准模式。
- 右栏文件、变更、任务、终端状态。
- PTY/tab 状态和终端恢复。
- 子智能体卡片和权限事件。
- Skill/MCP 状态。

**实施要求**：

- 先抽出共享 domain/store，再分别接入 v1/v2 视图；不能在两个视图中复制业务逻辑。
- `TerminalPanel` 和 `TerminalPanelV2` 只允许共享 PTY/tab 状态源；右栏迁移不能创建新 PTY。
- 核心 UI PR（`relay_core_ui`）只覆盖设置、Vendor/Key、模型勾选、项目新建/打开/切换和发送；至少在 v1、v2、宽屏、窄屏和移动端验证这些核心流程。
- 布局 UI PR（`relay_layout`）单独覆盖右栏切换、终端、PTY 恢复、文件/变更/任务 Tab、子智能体卡片和权限场景；这些场景不作为核心 UI PR 的发布条件。

**强制验证**：同一 Server 状态下，核心场景验证 Vendor、可见模型、当前项目、批准模式、草稿和发送一致；布局场景另行验证 v1/v2 的右栏、终端 tab 和子智能体状态一致。核心场景失败阻断 `relay_core_ui`；布局场景失败只关闭 `relay_layout`，不得阻断已通过的核心设置和发送。

**TUI 范围例外**：TUI 不实现右栏、Codex 项目布局、技能面板、MCP 面板或已安排任务。TUI 的 Provider 限制、Relay Auth、模型候选/可见性和中文档位属于 A/B 核心验收范围，但不受 Desktop `relay_core_ui` 开关控制；关闭 Desktop 设置页不能关闭 TUI。不能因为 Desktop/Web 的布局能力缺失而关闭或延后 TUI 核心能力，也不能以 TUI 通过替代 Desktop/Web 布局验收。

**UI gate 范围**：按 §1 的五 gate 表实施。v1/v2 布局或子智能体卡片验收失败只关闭 `relay_layout`；已通过的 `relay_core_ui` 保留设置、模型、项目和发送。核心功能本身仍需覆盖两套 App 视图；其缺陷归核心验收处理，不能用关闭布局 gate 隐藏核心错误。`relay_skills`、`relay_mcp` 和 `scheduled_tasks` 分别控制自己的新增界面/调度，均不控制硬过滤或服务端模型校验。

### 风险三：“一 Provider 一 Key”存储无法承载多把 Key

**根因**：当前 SDK/HttpApi 以 `/auth/{providerID}` 表达单 Provider 认证。若继续把多个 Vendor Key 塞进一个字符串，无法正确实现统一 Key、独立 Key、清除和缓存分桶。

**禁止做法**：

- 把 Vendor Key 拼成 JSON/分隔字符串写进现有单 Key 字段。
- 让前端根据 Vendor 直接附加 Authorization。
- 勾选统一 Key 时删除各 Vendor 独立 Key。
- 用一个全局 Key 状态覆盖所有 Vendor 的状态。

**必须新增的能力**：

- Relay 专用认证 DTO/API，表达 `unified`、Vendor 状态、revision、幂等 operation ID 和独立清除。
- Server/Core 的 Vendor Key resolver，按 `(providerID, modelID)` 解析 Vendor，再从统一/独立 Key 中选择 Credential。
- 候选模型缓存按 Server/认证身份、Vendor、服务端内部 Key 指纹和请求版本分桶；`keyFingerprint` 仅存 Server，不进入 Schema、Protocol、Client 或 UI。
- 安全 `SecretStore` 抽象，前端只获得 `hasKey`/`updatedAt`。
- 旧 `/auth/{providerID}` 数据迁移、备份和回滚。
- 旧 `/auth/{providerID}` 入口的兼容策略：只允许迁移 `leidiandonghua`；官方 Provider 请求返回 `PROVIDER_DISABLED`；Relay 写入不能从旧接口形成第二套数据源。
- Relay 模型归属和可见性的单一事实来源；候选列表勾选与管理模型开关必须调用同一个 Server mutation。

**强制验证**：

- 两个 Vendor 各用不同 Key 请求时，Authorization 必须分别正确。
- 开启统一 Key 后所有 Vendor 使用统一 Key；关闭后恢复原独立 Key，独立 Key 不丢失。
- 修改/清除一个 Vendor Key 不影响其他 Vendor。
- Key 变化后旧模型缓存、测试状态和迟到响应全部失效。
- 两个窗口并发修改时旧 revision 返回 `REVISION_CONFLICT`。
- 安全存储不可用时返回 `SECRET_STORE_UNAVAILABLE`，没有明文 fallback。
- 同一模型 ID 同时匹配多个 Vendor 时进入冲突待确认；没有显式确认前禁止发送，绝不采用 last-write-wins。
- 修改候选列表勾选后，管理模型、Provider catalog、Session 选择器和 TUI 立即观察同一可见性结果；不存在第二份本地可见性开关。
- 旧 `/auth/{providerID}` 对官方 Provider 不可写；对 Relay 只能走兼容迁移或转发到唯一 Relay Auth service，不能产生第二套认证存储。

### 阶段门禁

| 门禁 | 通过条件 | 未通过时 |
| --- | --- | --- |
| 运行时 Provider/Auth/Catalog 门禁 | catalog、env、`opencode.json`、`.well-known/opencode`、自定义 openai-compatible、plugin Provider、Session prompt、TUI、直接 HttpApi、sdk-next/进程内 Core 均拒绝官方 Provider；policy 不能绕过；Models.dev 不回灌；旧 auth 不形成第二写入口 | Relay 不进入生产默认开启；官方 Provider 始终硬关闭 |
| Relay catalog 隔离门禁 | 候选/管理模型分层；无官方元数据回灌；归属冲突返回 `MODEL_VENDOR_CONFLICT` 并待确认；可见性单一事实来源；Server-only 指纹 | 不开放模型选择和默认模型 |
| v1/v2 布局一致性门禁 | App 两套布局和子卡片共享状态且同场景 E2E 一致；核心 UI 单独验收，TUI 验收 A/B 的 Provider/Key/模型/档位且不受 Desktop `relay_core_ui` 控制 | 只关闭 `relay_layout`，保留已通过的 `relay_core_ui`、设置和发送 |
| 多 Key 认证门禁 | 独立/统一/清除/并发/迁移测试全部通过；旧 auth 不能形成第二写入口 | 不接入设置页，不迁移真实配置 |
| 密钥安全门禁 | 目标平台 SecretStore 可用且日志脱敏；指纹不出 Server | 禁止明文落盘，Key UI 显示不可用 |
| 调度副作用门禁 | TaskRun 去重、补跑、双窗口、重启、准入后崩溃用例通过；未知执行不自动重放 | 只关闭 `scheduled_tasks` gate，不影响 Relay 默认开启 |

## 3. 第 0 阶段：基线、开关和代码地图

### 目标

建立可回滚基线，确认所有真实入口和现有状态源。

### 检查范围

- Provider：`packages/opencode/src/provider/provider.ts`、transform、ModelsDev 合并。
- LLM：`packages/llm/src/providers/openai-compatible.ts`、route/auth。
- Auth：`packages/opencode/src/auth`、`/auth/{providerID}`。
- Session：Session prompt、`SessionV2.prompt`、`SessionExecution.wake`、Location runner。
- Project：ProjectV2、directory、workspace、Location。
- App：settings providers、session prompt、layout、project picker。
- Terminal：`TerminalPanel`、`TerminalPanelV2`、PTY/tab 状态。
- Skills：SkillV2、SkillDiscovery、`/api/skill`、PermissionV2。
- MCP：配置、OAuth、Location service、权限状态。
- Desktop/CLI：daemon 和 Effect schedule。

### 实施

- 按 §1 定义五个独立 gate：`relay_core_ui`、`relay_layout`、`relay_skills`、`relay_mcp`、`scheduled_tasks`。先实现开关组合验证和永久硬过滤，不能以任一 UI gate 包裹 Provider 注册、鉴权或模型校验。
- 建立测试 fixture：固定 Relay Provider、两个内置 Vendor、候选模型、统一/独立 Key。
- 用 CodeGraph 记录 Provider、Auth、Session、Project、Skill、Terminal 的调用路径。

### 出口条件

- 分别关闭五个 gate，官方 Provider 仍被硬过滤并返回 `PROVIDER_DISABLED`。仅开启 `relay_core_ui` 时 Desktop/Web 设置、模型勾选、项目新建/打开与输入条可用；已有 Key、可见模型和有效 Project/Location 的运行时发送、直接 HttpApi 和已验收 TUI 不受 Desktop `relay_core_ui` 开关影响。关闭 `relay_layout`、`relay_skills`、`relay_mcp` 或 `scheduled_tasks` 不影响核心发送。五个 gate 全关时不显示官方 Connect UI。阶段 0 用组合测试约束后续实现，阶段 5/6 验证真实核心界面和 TUI A/B。
- 所有待改模块、公开 API 和生成代码位置已列入任务清单。
- 没有把 UI 文件误当成运行时安全边界。

## 4. 第 1 阶段：Schema、错误码和 Protocol DTO

### 新增建议文件

```text
packages/schema/src/relay.ts
packages/schema/src/relay-model.ts
packages/schema/src/relay-error.ts
packages/schema/src/scheduled-task.ts
```

### 核心类型

Vendor：`id`、`name`、`builtin`、`hasKey`、`updatedAt`、`revision`；内置 Vendor ID 不可改，自定义 Vendor ID 首版创建后不可修改；如未来开放修改，必须原子迁移模型、缓存、可见性、session 引用和 scheduled task。

RelayAuthState：`unified`、`hasUnifiedKey`、Vendor 状态、`revision`。密钥引用不返回 Client。

RelayCandidateModel（Server 内部）：`vendorId?`、`modelId`、`displayName?`、`ownedBy?`、`fetchedAt`、内部 `keyFingerprint`、`assignmentSource`、`upstreamPresent`。对外 DTO 必须删除 `keyFingerprint`，只返回安全的缓存状态和时间。

RelayManagedModel：`vendorId`、`modelId`、`visible`、`reasoningCapabilities`、`assignmentSource`、`lastSeenAt`、`upstreamPresent`。

ScheduledTask/TaskRun：包含项目/Location、Prompt、UTC 时间、IANA 时区、模型、variant、批准模式、版本、运行状态、关联 Session 和错误码。

### 稳定错误码

`KEY_MISSING`、`KEY_REJECTED`、`UPSTREAM_UNREACHABLE`、`UPSTREAM_TIMEOUT`、`UPSTREAM_RATE_LIMITED`、`UPSTREAM_INVALID_RESPONSE`、`MODEL_UNAVAILABLE`、`MODEL_VENDOR_MISMATCH`、`MODEL_VENDOR_CONFLICT`、`PROVIDER_DISABLED`、`PROJECT_INVALID`、`REVISION_CONFLICT`、`REQUEST_CONFLICT`、`SECRET_STORE_UNAVAILABLE`。`MODEL_VENDOR_CONFLICT` 表示多个 Vendor 同时匹配且尚未人工确认，禁止发送。

错误响应统一包含 `code`、`retryable`、`requestId`，前端按 code 映射中文文案。

### 出口条件

- Schema 可被 Core 和 Protocol 使用。
- 不暴露完整 Key、Key 引用、HMAC 指纹。
- `packages/client` 可生成新 DTO 和 SDK。

## 5. 第 2 阶段：Relay Provider 和官方 Provider 过滤

### 实施位置

```text
packages/opencode/src/provider/provider.ts
packages/opencode/src/provider/transform.ts
packages/core/src/models-dev.ts
packages/llm/src/providers/openai-compatible.ts
packages/opencode/src/session/llm/native-request.ts
```

### 规则

- 固定 Provider ID：`leidiandonghua`。
- 固定 Base URL：`https://api.leidiandonghua.cn/v1`。
- ChatGPT、Grok、Gemini、Claude、KIMI 都是 Vendor，不是 OpenCode Provider。
- 运行时优先复用 `@opencode-ai/llm` 的 OpenAI-compatible route；若采用 `@ai-sdk/openai-compatible`，必须增加 LLM/Core bridge。
- Provider catalog、`available()`、默认模型、Session prompt、env、`opencode.json`（含任意 ID/URL 的 openai-compatible）、`.well-known/opencode`、plugin Provider、旧 session、TUI、直接 HttpApi 与 sdk-next/进程内 Core 全部执行相同硬过滤；用户 policy 只能收紧，不能放开官方通道。
- 官方 Provider 请求统一返回 `PROVIDER_DISABLED`。
- Models.dev 不得补回 Relay 未返回的模型、价格或档位。

### Relay catalog 分层

```text
/v1/models 候选缓存
  → 用户勾选
  → Relay 管理模型登记
  → Provider.Model 映射
  → Session/TUI/App 选择器
```

未勾选模型不能进入默认模型解析、Provider 可见列表或 Session 选择器。

### 出口条件

- 通过配置、环境变量、旧 session 和直接 HttpApi 尝试官方 Provider 均被 Server/Core 拒绝。
- 固定 Base URL 无法被配置和前端覆盖。
- Provider 仍使用现有 stream 链路。
- 运行时 policy 绕过、Models.dev 回灌、自定义 openai-compatible、远程 `.well-known`、plugin Provider、sdk-next/进程内 Core 六类测试均通过。

## 6. 第 3 阶段：安全存储和 Relay 认证 API

### API 建议

```text
GET    /relay/auth
PUT    /relay/auth/mode
PUT    /relay/auth/unified
PUT    /relay/auth/vendors/{vendorId}
DELETE /relay/auth/unified
DELETE /relay/auth/vendors/{vendorId}
POST   /relay/auth/test
POST   /relay/models/refresh
GET    /relay/models/candidates
PUT    /relay/models/visibility
```

最终路径以现有 HttpApi 命名规范为准，但必须按模式、统一 Key、Vendor Key、测试、刷新和可见性分别更新；不得用一个大保存接口隐式覆盖所有字段。每个 mutation 支持 revision、幂等 operation ID 和独立清除密钥。

### 存储

新增 `SecretStore` 抽象：`get(ref)`、`put(ref, secret)`、`remove(ref)`。

平台目标：Windows Credential Manager、macOS Keychain、Linux Secret Service；远程/Web Server 使用受保护加密存储。密钥库不可用时返回 `SECRET_STORE_UNAVAILABLE`，禁止明文降级。

前端只接收 `hasKey` 和 `updatedAt`。浏览器不存 Key，日志/遥测/诊断不含 Key 或 Authorization。

### 并发和幂等

- 更新携带 `revision`，旧版本返回 `REVISION_CONFLICT`。
- 创建和手动测试携带 operation ID，重复请求返回同一结果。
- 清除密钥使用独立操作，空输入不代表清除。
- Key、统一模式、Vendor 名称和模型可见性分开更新。

### 出口条件

- 统一 Key、分 Vendor Key 可独立保存和切换。
- 取消统一模式不丢失独立 Key。
- 未保存 Key 只可临时测试，取消编辑后清除内存值。
- 安全存储不可用时无明文 fallback。

## 7. 第 4 阶段：模型候选缓存、归属和档位

### 拉取

对每个有效 Key 调用 `GET /v1/models`，超时 10 秒、支持取消。只替换当前 Server/认证身份、Vendor、Key 指纹和请求版本均匹配的缓存。

### 归属优先级

1. 用户手动归属。
2. 已验证的 `owned_by`。
3. 已验证的 ID 前缀。
4. 未分组/待确认。

冲突不按最后一次拉取覆盖。

### 可见性

- 保存 Key、测试成功、自动刷新都不自动显示全量模型。
- 用户勾选立即写入管理模型登记。
- 取消勾选立即隐藏。
- 上游下架模型保留登记并标记 `upstreamPresent=false`。
- 管理模型和候选列表共用同一可见性状态。

### 档位

由版本化 capability map 决定。未知模型不显示档位；不得仅凭 Vendor 名称推断 reasoning 支持。`low/minimal` 同时存在时映射最低有效档。

### 出口条件

- 模型选择器只显示管理模型中的可见项。
- Key 变化后旧候选缓存失效。
- 迟到响应不覆盖新 Key、新 Vendor 归属或新可见性。
- 401/403、429、空列表和无效 JSON 均有稳定错误码。

## 8. 第 5 阶段：设置页和模型选择器

### 修改范围

```text
packages/app/src/components/settings-providers.tsx
packages/app/src/components/settings-v2/providers.tsx
packages/app/src/components/dialog-connect-provider.tsx
packages/app/src/hooks/use-providers.ts
```

### UI 行为

- 移除官方 Provider 列表、OAuth Connect 和自定义 URL。
- 内置 ChatGPT/Grok 可编辑不可删除；用户 Vendor 可编辑可删除。
- 厂商卡片显示名称、Key 状态、可见模型数和连接状态。
- 测试连通和获取模型列表分开。
- 编辑表单 Key 不回显；留空保持，清除单独操作。
- Vendor 表单是草稿；模型勾选是即时保存状态。
- 统一 Key 开启时隐藏/禁用独立 Key 并显示“使用统一密钥”。
- 模型选择器按 Vendor 分组，支持搜索、键盘导航、最近使用置顶和档位分段按钮。

### 出口条件

- 新用户只看到 Relay 配置。
- Key、测试、模型拉取、模型勾选和取消不会互相污染。
- 失败保留旧缓存，并提供重试。

## 9. 第 6 阶段：Session 输入条、项目和草稿

### 代码范围

```text
packages/app/src/pages/session.tsx
packages/app/src/components/session/*
packages/app/src/pages/home/*
packages/app/src/context/*
```

### 输入条

固定显示项目、厂商/模型、档位、批准模式、发送/停止。项目、模型、档位和批准模式最多两次点击可修改；低频设置放入 `···`。

生成中的请求固定 Session/Location、模型、Vendor、Key 和 variant 快照；输入条后续修改只影响下一条消息。

无项目、无 Key、无可见模型、项目路径失效时禁止发送并提供修复入口。

### 项目

项目列表是当前 Server/用户的路径注册表；实际执行仍使用 `Location(directory, workspace)`。切换项目不迁移 Session，不改变运行中终端 cwd。新项目必须创建新目录，打开已有项目只选择已有目录。

### 草稿

按 Server + Project + Session 隔离。发送成功清除，失败保留；切换项目恢复对应草稿，不自动搬迁。

### 出口条件

- 首次使用流程：选择/新建项目 → 设置 Key 并勾选模型 → 发送。
- 无项目时不能向未知目录写文件。
- 项目切换后新输入使用新 Location，旧运行保持原 Location。

## 10. 第 7 阶段：Codex 式布局、右栏和终端

### 目标

```text
左侧可折叠窄轨 + 中间对话 + 右栏 Tab
```

右栏 Tab：文件、变更、任务、终端。复用现有 `ReviewPanelV2`、file tree、todo、PTY 和 terminal tabs。

### 约束

- `TerminalPanel`/`TerminalPanelV2` 共享 PTY/tab 状态。
- 右栏是容器位置变化，不重建 PTY。
- 文件树懒加载，Git 摘要防抖刷新，终端显示缓冲有限。
- 无项目时不初始化文件树、Git 或终端。
- 任务 Tab 是完整 Todo，输入条 dock 只显示进行中摘要。
- 宽度不足时先收起左栏，再把右栏变抽屉；禁止横向滚动。

### 出口条件

- 800/960/1280/1440px 和 200% 缩放通过布局验收。
- 终端切换位置、刷新窗口和切换布局不丢失 PTY。
- 右栏四个 Tab 都有空、加载、错误和重试状态。

## 11. 第 8 阶段：子智能体嵌套卡片

复用 `AgentPart`、`SubtaskPart`、child session、permission/question 事件。卡片是事件投影，不新增平行 SubagentTask 存储。

状态：进行中、等待权限、完成、失败、后台运行。等待权限在父会话处理；失败提供错误原因和重试；输出默认折叠；只显示一层嵌套；保留“在独立会话中打开”。

出口条件：父时间线、child session 和权限状态最终一致，主输入始终留在父会话。

## 12. 第 9 阶段：技能面板

对应提交：`feat(app): add skills panel`，只受 `relay_skills` gate 控制。

### 实施

Server 注册 `.claude/skills`、`.agents/skills` 等 source；UI 只调用 `/api/skill`。`relay_skills` 关闭时只隐藏/禁用新增 Desktop/Web 技能面板，不删除 source、不改变 `/api/skill` 返回、不改变 System Prompt，也不改变已有技能工具运行时。用户在面板中把技能设为关闭时，才通过 `PermissionV2.evaluate("skill", ...)` 使该技能对模型不可用；这是权限操作，不等同于关闭 gate。

### 出口条件

- 技能发现、来源显示、搜索、启停、详情和权限状态通过。
- `relay_skills` 关闭只关闭面板入口；`/api/skill`、Skill source、System Prompt 和已有工具行为保持既有规则。
- 技能权限设为 deny 时，`/api/skill` 可仍列出带禁用状态，但 System Prompt 和工具可用列表不再暴露该技能；不把 gate 关闭误当成权限 deny。
- 技能面板失败只关闭 `relay_skills`，不影响 `relay_core_ui`、模型发送或 MCP。

## 13. 第 10 阶段：MCP 管理界面

对应提交：`feat(app): add MCP status and management`，只受 `relay_mcp` gate 控制。

### 实施

`opencode.json` 是配置入口；复用 Location 级 MCP、OAuth、连接状态和权限过滤。OAuth token 独立存储。授权过期、连接失败和工具禁用分别展示。`relay_mcp` 关闭时只隐藏/禁用新增 MCP 管理界面，现有配置、连接、OAuth 和工具调用继续按既有运行时工作。

### 出口条件

- MCP 配置编辑、启停、OAuth/连接状态和错误展示通过。
- `relay_mcp` 失败只关闭 MCP 管理面板，不影响技能、模型发送或已有 MCP 运行时。
- MCP OAuth 故障不影响模型 Key；MCP gate 关闭不停止已有 MCP 连接，也不删除配置。

## 14. 第 11 阶段：已安排任务和 daemon

### 数据和执行

每次运行创建新的 Session 和新的 prompt message ID：

```text
daemon 到期
  → 原子创建唯一 (taskId, scheduledAt) TaskRun
  → 校验 Project/Location、模型、Key
  → 创建新 Session
  → SessionV2.prompt
  → SessionExecution.wake
  → 监听事件并写入 TaskRun
  → 桌面通知
```

### 规则

- 使用本机 SQLite；同一任务和同一项目串行。
- 一次性任务 24 小时内补跑一次；每天任务只补最近一次；超窗标为已错过。
- 已进入 Provider/tool 阶段但结果未知的 run 标记中断待确认，不自动重放。
- 时间戳保存 UTC，日历时区保存 IANA 名称；处理夏令时缺失/重复时刻。
- Key、模型或项目失效时任务暂停；修复后手动恢复。
- 默认自动批准，列表和运行记录持续显示；可选择询问。
- 首版不做 cron、云端、多机同步或自动失败重试。

出口条件：daemon 重启、双窗口、双击手动运行和休眠补跑均不会产生重复执行或重复工具副作用。

## 15. 第 12 阶段：迁移和兼容

迁移顺序：备份 → 读取旧配置 → 导入安全存储 → 写 Relay 配置 → 清理官方 Provider 可用状态 → 保留旧 session 历史 → 失效模型提示重选 → 写迁移版本。

迁移失败必须保留原始配置和加密备份，不产生明文副本，不重新开放官方 Provider。

内置和自定义 Vendor ID 首版创建后均不可修改；名称可改且不改变请求归属。未来若单独立项开放 Vendor ID 修改，必须先完成冲突检查，再原子迁移 Key 引用、候选缓存、管理模型、可见性、session 引用和 scheduled task。

## 16. 测试矩阵

### Core/Server

- Relay Provider 固定 URL 和唯一 Provider policy。
- 官方 Provider 从配置、环境变量、`.well-known/opencode`、任意 openai-compatible、自定义 plugin、旧 session、TUI、直接 API、sdk-next/进程内 Core 均返回 `PROVIDER_DISABLED`。
- Vendor Key/统一 Key 解析、清除、revision 冲突和幂等。
- `/v1/models` 成功、空列表、401、403、429、超时、取消、无效 JSON。
- 自动归属、手动归属优先、冲突待确认。
- 未勾选模型不可进入 catalog、默认模型和 Session 选择器。
- Session 的 Provider、Vendor、模型可见性和 variant 校验。
- Project/Location 隔离。
- Skill 权限和 MCP OAuth 独立状态。
- Scheduled Task 去重、补跑、时区、重启和中断恢复。
- 迁移、备份和回滚。
- `experimental.policies`/`disabled_providers` 无法放开 Relay-only policy；`.well-known/opencode`、自定义 openai-compatible、plugin Provider、sdk-next/进程内 Core 均被硬过滤。
- Models.dev 不回灌 Relay 元数据；多 Vendor 冲突返回 `MODEL_VENDOR_CONFLICT` 并禁止发送，不采用 last-write-wins。
- 候选列表与管理模型共用同一可见性 mutation；未勾选模型在 App、TUI、Provider catalog 和 Session 选择器均不可见。
- `keyFingerprint` 仅 Server 内部可见，不存在于 Client DTO/生成 SDK；关闭 `relay_core_ui`、`relay_layout`、`relay_skills`、`relay_mcp` 或 `scheduled_tasks` gate 后官方 Provider 仍返回 `PROVIDER_DISABLED`。
- 旧 `/auth/{providerID}` 对官方 Provider 拒绝，对 Relay 不形成第二套写入口。

### App/Desktop/TUI

- 设置页不出现官方 Provider 和 URL 编辑。
- Key 不回显；统一/独立模式切换。
- 模型搜索、Vendor 分组、档位选择和键盘导航。
- 项目新建/打开/切换、草稿隔离。
- 右栏四 Tab、PTY 保留、文件树懒加载和 Git 空状态。
- 子智能体父卡片、权限、失败重试和展开详情。
- 技能面板、MCP 状态和 scheduled task 面板。
- 800/960/1280/1440px、200% 缩放、移动端抽屉和无横向滚动。
- IME 输入时 Enter 不误发；Esc 恢复触发点焦点。
- Server/Core 运行五个 gate 的开关组合，验证任意组合下官方 Provider 仍硬拒绝、Key/模型/Project/Permission 校验仍执行。
- App v1/v2 E2E 只测试已开启的 UI gate：核心场景验证 `relay_core_ui` 的厂商设置、模型勾选、项目和发送；布局场景验证 `relay_layout`；技能面板验证 `relay_skills`；MCP 管理界面验证 `relay_mcp`；对应 gate 失败只关闭自身入口。
- TUI 单独验收 A/B 的 Provider、Key、模型和档位，不依赖任何 Desktop UI gate；直接 HttpApi 单独验收已配置请求和硬过滤。
- daemon 单独验收 `scheduled_tasks` 的创建、去重、补跑和中断恢复。
- 五个 gate 全关时不出现 Connect UI，官方 Provider 仍硬拒绝；已有 Key 的运行时发送、直接 HttpApi 和已验收 TUI 不因 UI gate 关闭而被服务端阻断。

测试命令必须从 package 目录执行，例如：

```text
cd packages/core && bun test && bun typecheck
cd packages/opencode && bun test && bun typecheck
cd packages/app && bun test && bun typecheck
```

## 17. 提交和发布顺序

建议拆为以下 conventional commits：

1. `feat(schema): add relay catalog and auth schemas`
2. `feat(core): add relay provider and model registry`
3. `feat(server): add relay auth and model endpoints`
4. `fix(provider): enforce relay-only provider policy`
5. `feat(app): add vendor management and model picker`
6. `feat(app): add project-aware prompt controls`
7. `refactor(app): move terminal into shared right panel`
8. `feat(app): render child sessions as timeline cards`
9. `feat(app): add skills panel`
10. `feat(app): add MCP status and management`
11. `feat(desktop): add scheduled task daemon`
12. `chore(migration): migrate legacy providers and auth`
13. `test: add relay integration and regression coverage`

每个提交都必须：

- 只包含当前阶段范围。
- 通过对应 package 的 typecheck 和测试。
- 不修改生成目录。
- 不含真实 API Key。
- 五个 gate 各自开关均不得削弱硬过滤；只开启 `relay_core_ui` 即可交付核心界面，不能以布局、技能、MCP 或调度未完成阻挡设置与发送。

## 18. 发布前检查表

- [ ] 设置页只显示 Relay 和 Vendor。
- [ ] 固定 URL 无任何编辑入口。
- [ ] 官方 Provider 在 UI、配置、环境变量、`.well-known/opencode`、自定义 openai-compatible、plugin、旧 session、直接 API、sdk-next/进程内 Core 全部被硬阻止。
- [ ] 五个 gate 按 §1 独立开闸；仅开启 `relay_core_ui` 可完成 A/B 与输入条流程，布局、技能、MCP 或调度失败不阻断核心交付。
- [ ] 统一 Key/分 Vendor Key 的保存、切换、清除和脱敏通过。
- [ ] 旧 `/auth/{providerID}` 不能作为第二套 Relay 写入口；官方 Provider 旧接口请求返回 `PROVIDER_DISABLED`。
- [ ] 候选模型与管理模型分层，未勾选模型不可见。
- [ ] Models.dev 不向 Relay 回灌名称、价格、档位或能力；模型归属冲突返回 `MODEL_VENDOR_CONFLICT` 并进入待确认；无 last-write-wins。
- [ ] `keyFingerprint` 只在 Server 内部存在，Protocol/Client/UI 不可见。
- [ ] 候选列表和管理模型共用同一可见性事实来源，未勾选模型在 App/TUI/Provider catalog/Session 选择器均不可见。
- [ ] Provider/Vendor/model/variant 请求校验通过。
- [ ] 项目、Location、Session、PTY 切换边界通过。
- [ ] 右栏和子智能体卡片在 v1/v2 一致。
- [ ] Skill/MCP 权限和 OAuth 状态隔离。
- [ ] Scheduled Task 去重、补跑和中断策略通过。
- [ ] 迁移有备份、回滚和版本记录；首版 Vendor ID 不可修改，未来开放时才执行完整引用迁移。
- [ ] 诊断、日志、遥测无 Key、Authorization 和不必要的绝对路径。
- [ ] 桌面/Web/TUI 的已承诺范围均已验收。
