# 未提交五项缺陷验收记录

日期：2026-11-09  
状态：实施中。本文只记录已经执行的命令和结果，未执行项保持未验收。

## 基线

- HEAD：`6b051f12a21094df1adef83f9fddfcbb765b319e`
- 分支：`dev`
- `git status --short`：工作区已有大量已修改和未跟踪文件。本轮不执行整树恢复、清理或 `git add .`。
- 已知比较基线仅供对照，不以文档代替本次执行结果：
  - App 定向测试：94 项通过。
  - Desktop 定向测试：42 项通过；完整类型检查有两处 `XDG_STATE_HOME` 的 TS2339。
  - Core 定向测试：102 项通过、1 项失败；失败为 UC-05 慢刷新时序测试。
- 本轮不关闭 R3-03B，不启用迁移 apply，不写生产迁移标记，不重启应用。

## 涉及文件的现有工作区差异（修改前阅读）

这些文件在本轮开始前已经包含相关功能改动。本轮在其上补缺陷，不把它们当成干净基线。

- `packages/core/src/session/runner/model.ts`：`withDefaults` 把模型 body 的 `imageGeneration:true` 映射成 route 默认 `providerOptions.openai.imageGeneration`。
- `packages/core/src/session/runner/llm.ts`：产品请求只设置 `promptCacheKey`，没有显式关闭托管图片。
- `packages/llm/src/protocols/openai-responses.ts`：本地同名工具缺失且选项为 true 时重新加入托管 `image_generation`。
- `packages/opencode/src/session/llm.ts`：旧会话在 native/AI SDK 分流前没有规范化托管图片选项。
- `packages/opencode/src/config/config.ts`：`mcpSource()` 对非绝对路径和 managed 文件直接返回已展开 `entry`。
- `packages/core/src/image-generation.ts`：Images 返回 404 时自动调用 `chat()`。
- `packages/desktop/src/main/background-cli-compat.ts`：`commandEnv()` 复制环境后读写 `XDG_STATE_HOME`，返回类型未声明为 `NodeJS.ProcessEnv`。
- `packages/core/test/relay-catalog.test.ts`：慢刷新在确认第一笔 HTTP 进入前就提交新密钥。

## 条目状态

| 编号 | 状态 | 说明 |
| --- | --- | --- |
| UC-01 | 自动验证通过 / 界面待验收 | 旧会话三条路径与必跑文件已通过。产品交互未做隔离界面验收。 |
| UC-02 | 自动验证通过 / 界面待验收 | 五类只读来源、HTTP 契约、SDK 生成和消费者类型检查已通过。MCP 对话框未做隔离界面验收。托管偏好的真实 `plutil` 路径未在 Windows 上执行。 |
| UC-03 | 自动验证通过 / 界面待验收 | Images 404 不再自动改走 Chat。界面失败流程未验收。 |
| UC-04 | 自动验证通过 | Desktop 定向测试与完整 `bun typecheck` 通过。这不代表安装包验收。 |
| UC-05 | 自动验证通过 | 慢刷新 10 次顺序与联合回归通过。生产刷新逻辑未改。 |
| 界面 | 界面待验收 | 本轮未启动隔离验收实例，也未重启已有应用。 |
| R3-03B | 未关闭 | 不在本轮关闭范围。 |

## 命令记录

每条命令都在独立 PowerShell 子进程中先清理配置覆盖，再设置 `OPENCODE_TEST_HOME`、`XDG_*`、`OPENCODE_TEST_MANAGED_CONFIG_DIR`、`OPENCODE_DB=:memory:`、`OPENCODE_DISABLE_MODELS_FETCH=true` 和隔离 `TEMP`/`TMP`。退出码单独记录。

| 命令 | 隔离根 | 结果 | 退出码 |
| --- | --- | --- | --- |
| `packages/opencode`: `bun test test/session/llm.test.ts -t "disables hosted image generation when native falls back" --timeout 60000` | `opencode-uc-review-4922529b6e844aa899289b56d23dee15` | 1 pass，2 expect | 0 |
| `packages/opencode`: `bun test test/session/llm-native.test.ts test/session/llm.test.ts --timeout 60000` | `opencode-uc-review-06e6102aa2f6460ab02e817a7ebfb099` | 49 pass，0 fail，136 expect | 0 |
| `packages/opencode`: `bun test test/config/config.test.ts test/server/httpapi-config.test.ts --timeout 60000` | `opencode-uc-review-6d49331edc5942c491e5ffca0bac9945` | 131 pass，0 fail，353 expect | 0 |
| `packages/client`: `bun run generate` | `opencode-uc-review-009b6d165802419bbfa60e68165b7655` | 生成完成。该契约不含 MCP 来源路由。 | 0 |
| `packages/client`: `bun typecheck` | 同上 | 通过 | 0 |
| `packages/app`: `bun typecheck` | `opencode-uc-review-6c4034769f714c26a0a7e700578a8457` | 通过 | 0 |
| `packages/llm`: `bun typecheck` | `opencode-uc-review-afc1a7f187054ee2a70676af3cbaca9d` | 通过 | 0 |
| `packages/core`: `bun typecheck`（品牌类型修正前） | `opencode-uc-review-b1dc4395fdb9403db4d8199499866bf3` | `image-tool-permission.test.ts` 4 处品牌类型错误 | 2 |
| `packages/core`: `bun typecheck`（修正后） | `opencode-uc-review-0f5bdbb130394545a4ee59cc5fec09dd` | 通过 | 0 |
| `packages/opencode`: `bun typecheck`（GET 错误联合与记录收窄前） | `opencode-uc-review-faeb01a40443463896f687c675ab058f` | `config.ts` 与 `handlers/config.ts` 两处错误 | 2 |
| 仓库根：`bun ./packages/sdk/js/script/build.ts` | `opencode-uc-review-d9504ebc65464fa8b70efa8228a123bc` | 生成 `packages/sdk/js/src/v2/gen`。GET 联合含 400/403/404/409/503。 | 0 |
| `packages/opencode`: `bun typecheck`（收窄后） | `opencode-uc-review-1e831994acea4fa29593ce323b1d7c19` | 通过 | 0 |
| `packages/app`: `bun test --tsconfig-override ./tsconfig.test.json --conditions=browser --preload ./happydom.ts src/components/settings-v2/mcp-form.test.ts --timeout 60000` | `opencode-uc-review-b0284f7f7d564b7fb7c5f6535c6d3e0f` | 11 pass，0 fail，38 expect | 0 |
| `packages/sdk/js`: `bun typecheck` | `opencode-uc-review-7abb148cc75c4b32b2a88fc57aeca0b8` | 通过 | 0 |

此前已执行且本记录沿用的结果：

| 命令 | 隔离根 | 结果 | 退出码 |
| --- | --- | --- | --- |
| `packages/core`: `bun test test/image-generation.test.ts --timeout 30000` | `opencode-uc-review-298d3fbf742846ae9463c4de6a3879cb` | 22 pass，0 fail，63 expect | 0 |
| `packages/desktop`: `bun test src/main/background-cli.test.ts` | `opencode-uc-review-369ab134ba464c66a9f136197453bdb4` | 4 pass，0 fail，12 expect | 0 |
| `packages/desktop`: `bun typecheck` | 同上 | 通过 | 0 |
| `packages/core`: `bun test test/relay-catalog.test.ts -t "drops a slow refresh" --timeout 30000` | `opencode-uc-review-91e25996857a4f48b56be1f9f2ba1e66` | 1 pass，20 expect | 0 |
| `packages/core`: `bun test test/relay-catalog.test.ts test/relay-auth.test.ts test/relay-secret-store.test.ts --timeout 30000` | `opencode-uc-review-fc253d501e2143ab87298c289509a084` | 39 pass，0 fail，226 expect | 0 |

## 分项记录

### UC-01

- 修复文件：`packages/core/src/session/runner/model.ts`、`packages/core/src/session/runner/llm.ts`、`packages/opencode/src/session/llm.ts`、`packages/core/test/image-tool-permission.test.ts`、`packages/core/test/image-generation-authorization.test.ts`、`packages/opencode/test/session/llm.test.ts`。
- 根因：权限过滤移除本地图片工具后，Responses 降级在模型选项仍为 true 时重新加入托管 `image_generation`。删除或置为 undefined 不能覆盖 route 默认值。
- 修复：产品会话在最终请求上显式设置 `providerOptions.openai.imageGeneration = false`。旧会话在 native/AI SDK 分流前复制 options 并设置 `imageGeneration: false`。HTTP body 仍过滤该控制字段。库调用方仍可显式传入 true。
- 失败回归：`disables hosted image generation when native falls back to AI SDK`。空 `apiKey` 在发出 `/responses` 前失败；`@ai-sdk/xai` 会改走 `/chat/completions`。最终用已安装 `@ai-sdk/openai` 的 `file:///` 入口让 native 判定包名不受支持，同时 AI SDK 仍请求 `/responses`。
- 修复后：过滤运行 1 pass，退出码 0；`llm-native.test.ts` 与 `llm.test.ts` 联合 49 pass，退出码 0。
- 剩余限制：未启动隔离界面验收。Windows 结果不能代替 Linux、macOS、网络共享、符号链接或已安装 Electron 验收。

### UC-02

- 修复文件：`packages/opencode/src/config/config.ts`、`packages/opencode/src/config/managed.ts`、`packages/opencode/src/config/mcp-edit.ts`、`packages/opencode/src/server/routes/instance/httpapi/errors.ts`、`packages/opencode/src/server/routes/instance/httpapi/groups/config.ts`、`packages/opencode/src/server/routes/instance/httpapi/handlers/config.ts`，以及生成的 `packages/sdk/js/src/v2/gen`。
- 根因：只读来源读取时返回了已经展开的配置，读失败时还会回退到展开条目。
- 修复：来源读取重建未展开原文。`writable` 只决定能否保存。GET 非法文档返回 400 `MCP_DOCUMENT_INVALID`；读取失败返回 503 `MCP_SOURCE_READ_FAILED`。缺失仍为 200 空结果。PATCH 只读仍为 403。保存仍只写用户补丁。
- 回归：`MCP source raw references` 五类直接获胜来源，以及 `returns unexpanded environment MCP references and typed read failures`。联合文件 131 pass，退出码 0。
- 类型修复：GET 错误联合补上 403/404/409，使 handler 映射与公开契约一致。`mergeDeep` 前用 `isRecord` 收窄条目。
- SDK：`bun ./packages/sdk/js/script/build.ts` 退出码 0。生成的 `ConfigMcpSourceErrors` 包含 400、403、404、409、503，`McpConfigUnavailableError.code` 包含 `MCP_SOURCE_READ_FAILED`。未手改生成文件。
- `packages/client` 的 `bun run generate` 与 `bun typecheck` 退出码均为 0。该生成脚本只编译 `ClientApi`，契约中没有这条 OpenCode 实例 MCP 路由，因此生成差异不包含本项错误码。
- 消费者类型检查：OpenCode、App、Core、LLM、Client、旧 JS SDK 的 `bun typecheck` 最终退出码均为 0。
- 剩余限制：界面待验收。`OPENCODE_TEST_MANAGED_PREFERENCES` 只覆盖来源读取，不代表 Windows 上完成了真实 MDM/`plutil` 验收。

### UC-03

- 修复文件：`packages/core/src/image-generation.ts`、`packages/core/test/image-generation.test.ts`。
- 根因：Images 返回 404 时自动调用 Chat。
- 修复：一次调用只使用显式选择的协议。默认仍是 `openai-images`，但不探测其他协议。错误说明当前协议失败并提示检查配置，不声称上游没有费用，也不输出完整上游响应或认证信息。
- 回归：`fails the selected images protocol when the images route is missing`。`image-generation.test.ts` 22 pass，退出码 0。
- 剩余限制：界面失败流程待验收。`tool-image-generation` 本轮未重跑。

### UC-04

- 修复文件：`packages/desktop/src/main/background-cli-compat.ts`、`packages/desktop/src/main/background-cli.test.ts`。
- 根因：`commandEnv()` 复制环境后读写 `XDG_STATE_HOME`，返回类型未声明为 `NodeJS.ProcessEnv`，产生两处 TS2339。
- 修复：返回类型声明为 `NodeJS.ProcessEnv`。复制 `process.env`，不修改全局环境。提供 `stateHome` 时设置该变量，未提供时删除。`OPENCODE_NATIVE_LOCK_DIR` 仍为二进制所在目录。
- 回归：`background-cli.test.ts` 4 pass，退出码 0。完整 Desktop `bun typecheck` 退出码 0。
- 剩余限制：不代表安装包或 Electron 重启验收。本轮未重启 Electron。

### UC-05

- 修复文件：`packages/core/test/relay-catalog.test.ts`。生产 `packages/core/src/relay-catalog.ts` 未改。
- 根因：测试在第一笔受控 HTTP 进入前就提交新密钥。生产刷新在提交前持有单许可信号量，新刷新不能在旧 HTTP 挂起期间完成。
- 修复：测试增加 `started` Deferred。顺序为旧密钥提交、旧请求进入并挂起、新密钥提交、fork 新刷新、释放旧请求、再等待新刷新。重复 10 次。5 秒超时只用于检测死锁。
- 回归：`drops a slow refresh after the vendor key changes` 1 pass，退出码 0。与 `relay-auth.test.ts`、`relay-secret-store.test.ts` 联合 39 pass，退出码 0。
- 剩余限制：这不证明生产目录逻辑全部验收。

## 未执行项

- 未启动隔离 App 或验收后端，因此第 9 节界面项保持“界面待验收”。
- 未提交，未执行 `git add .`，未恢复或清理整棵工作区。
- 未写生产迁移标记，未启用迁移 apply，未重启已有应用。
- R3-03B 保持未关闭。
- Windows 证据不能作为 Linux、macOS、网络共享、符号链接、已安装 Electron 或 Bun 单文件验收。

## 复核补修

日期：2026-11-10  
依据：`specs/uncommitted-fixes-review-followup-plan-2026-11-09.md`。本节追加本轮执行结果，不删除上文历史通过或失败记录。上文“自动验证通过”不能覆盖本次复核结论。

### 复核前状态

| 编号 | 复核前状态 | 本节结论 |
| --- | --- | --- |
| UC-01 / RF-04 | 旧会话路径已通过；真实 runner 与 auto 放行仍待补齐 | 本轮隔离重跑真实 runner、授权与调度矩阵，退出码 0。生产图片授权未再改。界面仍待验收。 |
| UC-02 / RF-01、RF-02、RF-03 | 初始化错误可能返回原文；环境来源覆盖合并结果；获胜文件缺失提前返回错误 | 三处均已补修。最终配置与 HTTP 套件 146 pass，退出码 0。界面仍待验收。 |
| UC-03 | 自动验证通过，界面待验收 | 本轮未改生产协议选择，沿用既有自动通过。界面仍待验收。 |
| UC-04 | 自动验证通过，不是安装包验收 | 本轮未改 Desktop，沿用既有自动通过。 |
| UC-05 / RF-05 | 既有慢刷新通过；乱序响应与凭据验证仍待补齐；结果解释错误 | 乱序与凭据用例已通过。生产刷新未改。下文修正许可范围解释。 |
| R3-03B | 未关闭 | 仍未关闭。 |

### 修正 UC-05 记录

上文 UC-05 写的“生产刷新在提交前持有单许可信号量，新刷新不能在旧 HTTP 挂起期间完成”不成立。

`packages/core/src/relay-catalog.ts` 的实际顺序是：计算配置指纹与供应商代次，调用 `fetchUpstream()`，再进入 `commitPermit(...)`，然后重新确认配置与代次并提交目录。单许可只保护提交。HTTP 不在该许可内。本轮没有因此放宽乱序断言，也没有修改生产刷新。

### RF-01 / RF-02 / RF-03

- 初始化失败发生在实例上下文加载，早于 MCP handler。仅在 `readRawText()` 外加 catch 不能覆盖首次 HTTP 加载。
- 平台 `toHandled` 在路由中间件失败且 `causeResponse` 无法转换时，会发送空的 HTTP 500。把已映射错误再次 `die` 也会进入这条路径。
- 实例上下文中间件现在直接返回声明响应：可识别的 `ConfigJsonError`、`ConfigInvalidError`、`ConfigFrontmatterError` 返回 400 `MCP_DOCUMENT_INVALID`；确认的 `EACCES`、`EPERM`、`EIO`、`EBUSY` 返回 503 `MCP_SOURCE_READ_FAILED`。响应带新的 ref，不附带配置原文、测试凭据或系统错误全文。
- 普通 `Config.get()`、项目更新和全局更新仍保持原错误通道。来源读取失败不写入这些通道。
- 环境原文在来源链原位置深度合并。末端不再用环境条目替换整个合并结果。保存仍只写用户补丁。
- 获胜文件缺失的 GET 返回 200 空结果。PATCH 缺失保持 404，不重建文件。必需继承来源缺失返回 503。

### 本轮命令

每条命令都在独立 PowerShell 子进程中清理配置覆盖、`OPENCODE_TEST_MANAGED_PREFERENCES`、`RECORD` 和未声明的供应商密钥，再设置隔离 `OPENCODE_TEST_HOME`、`XDG_*`、managed 目录、内存数据库和 `TEMP`/`TMP`。退出码单独记录。

| 命令 | 隔离根 | 结果 | 退出码 |
| --- | --- | --- | --- |
| `packages/opencode`: `bun test --timeout 30000 test/server/httpapi-config.test.ts -t "returns unexpanded environment MCP references and typed read failures"` | `opencode-uc-review-c27b87bcfdf744d18b6ca100dd3622cd` | 1 pass，16 expect | 0 |
| `packages/opencode`: `bun test --timeout 30000 test/config/config.test.ts test/server/httpapi-config.test.ts`，随后 `bun typecheck` | `opencode-uc-review-779a75b2c214429996459cfdcb5a3dd3` | 146 pass，0 fail，426 expect；类型检查 `McpEditError` 不可赋给 `never` | 测试 0；类型检查 2 |
| `packages/opencode`: `bun typecheck` | `opencode-uc-review-bcc5581408c4448f9d17e0f6cf495629` | 普通配置通道恢复 `never` 后通过 | 0 |
| `packages/opencode`: 同一拒绝读取过滤用例 | `opencode-uc-review-40f02130a8224b1793469ce6f007e328` | 1 pass，16 expect | 0 |
| `packages/opencode`: `bun test --timeout 30000 test/config/config.test.ts test/server/httpapi-config.test.ts` | `opencode-uc-review-7e46c4f5227d4fd4a454077f23e37482` | 144 pass，2 fail。首次语法损坏与首次 schema 无效均期望 400、收到 500 | 1 |
| `packages/opencode`: 首次损坏、首次 schema 无效、拒绝读取三条过滤用例 | `opencode-uc-review-ec978b594ed3482399c63495ffe0551f` | 3 pass，27 expect | 0 |
| `packages/opencode`: `bun test --timeout 30000 test/config/config.test.ts test/server/httpapi-config.test.ts`，随后 `bun typecheck` | `opencode-uc-review-6d41f90bbc5f4c3995bc1249e048d581` | 146 pass，0 fail，426 expect；类型检查通过 | 测试 0；类型检查 0 |
| `packages/opencode`: `bun typecheck`（换行后） | `opencode-uc-review-c6709f7a78394cc8a074889a7905b7f4` | 通过 | 0 |

本轮此前还在隔离环境重跑并通过：

| 命令 | 隔离根 | 结果 | 退出码 |
| --- | --- | --- | --- |
| `packages/core`: `bun test test/session-runner.test.ts test/image-tool-permission.test.ts test/image-generation-authorization.test.ts test/scheduled-authorization.test.ts --timeout 60000` | `opencode-uc-review-eef477bc35784212b6e545bc47301ca2` | 真实 runner、auto、deny 与调度矩阵通过 | 0 |
| `packages/core`: `bun test test/image-generation-authorization.test.ts --timeout 30000` | 同上 | 32 pass | 0 |
| `packages/core`: `bun test test/relay-catalog.test.ts test/relay-auth.test.ts test/relay-secret-store.test.ts --timeout 30000` | 同上 | 40 pass。含密钥变化与同密钥乱序各 10 次，并断言测试凭据 | 0 |
| `packages/core`: `bun typecheck` | 同上 | 通过 | 0 |
| `packages/opencode`: `bun test test/session/llm-native.test.ts test/session/llm.test.ts --timeout 60000` | `opencode-uc-review-c9bf4239bcd34ee1a78f25fc0a2479df` | 49 pass | 0 |
| `packages/app`: MCP 表单测试与 `bun typecheck` | `opencode-uc-review-366b9786860f4433915b1b2ac4473967` | 11 pass；类型检查通过 | 0 |
| `packages/sdk/js`: `bun typecheck` | 同上 | 通过 | 0 |

公开 HttpApi 声明本轮未扩大，因此未重新生成客户端或旧 JavaScript SDK。

### 未完成

- 未启动隔离 App 或验收后端。UC-01、UC-02、UC-03 的界面项保持“界面待验收”。App 表单函数测试不能代替 400/503 对话框查询。
- 未提交，未执行 `git add .`，未恢复或清理整棵工作区。
- 未写生产迁移标记，未启用迁移 apply，未重启已有应用。
- R3-03B 保持未关闭。
- Windows 证据不能作为 Linux、macOS、网络共享、符号链接、已安装 Electron 或 Bun 单文件验收。

## 2026-11-10 第二次复核补修

依据：`specs/uc02-project-sources-platform-followup-plan-2026-11-10.md`。本节只追加本轮结果，不覆盖上文通过或失败记录。上文“自动验证通过”不能关闭 RF-06、RF-07，也不能关闭界面、macOS `plutil` 或 R3-03B。

### RF-06

- 修改文件：`packages/opencode/src/config/config.ts`、`packages/opencode/src/config/paths.ts`、`packages/opencode/src/project/bootstrap.ts`、`packages/opencode/test/config/config.test.ts`、`packages/opencode/test/server/httpapi-config.test.ts`。
- 根因：MCP 来源预检和实例引导都无条件枚举当前目录四个项目文件。主加载器只在 `OPENCODE_DISABLE_PROJECT_CONFIG` 未设置时调用 `ConfigPaths.files()`，禁用后仍保留显式 `OPENCODE_CONFIG`、`OPENCODE_CONFIG_DIR` 和 home `.opencode`。
- 修复：新增 `ConfigPaths.discover()`，与主加载器使用同一开关、worktree 停止条件和 `opencode.json` 后 `opencode.jsonc` 的顺序。来源预检与引导共用该集合。显式文件即使位于项目内仍参与预检。公开 HttpApi 未改，未重新生成客户端。
- 修复前证据：隔离根 `opencode-uc-review-8025323f210b4b48856d32a21c465521`。`bun test test/config/config.test.ts test/server/httpapi-config.test.ts --timeout 60000 -t "disabled project config"` 为 3 pass、5 fail，退出码 1。HTTP 复现为 GET `/config` 200、GET `/config/mcp/review` 400 `MCP_DOCUMENT_INVALID`。
- 修复后矩阵：D01 HTTP 两个 GET 均为 200，保留环境 URL 与未展开 `{env:REVIEW_MCP_TOKEN}`，不含测试令牌和损坏原文。D02 覆盖损坏的 jsonc 与项目 `.opencode` 两种文件。D03 覆盖 worktree 内祖先。D04 在未禁用时仍返回 `MCP_DOCUMENT_INVALID` 和非空 ref。D05 在禁用时，显式 `OPENCODE_CONFIG` 指向损坏项目文件仍失败。D06、D07 使用隔离目录，分别保留显式配置目录和隔离 home `.opencode`；home 文件随后改坏时仍失败。原 400/503、不泄密、缺失 GET 和 PATCH 保护由联合套件覆盖。

### RF-07

- 拆分标题：
  - `returns unexpanded environment MCP references and typed read failures`：全平台共用，覆盖未展开引用、PATCH 403、无效文档 400、缺失 GET 200 null。
  - `returns a typed read failure when Windows denies the project config`：仅 `win32` 执行，其他平台 skip。
  - `returns a typed read failure when the project config mode denies read`：非 Windows 执行；本机按平台 skip。root 或无法制造真实拒绝时记录 skip，不算拒绝读取通过。
- 本机：Microsoft Windows NT 10.0.26300.0，身份 `zhangh\zh2100`。ACL 只作用于新建测试文件，`icacls` 使用参数数组。真实拒绝为 `EPERM`。恢复后断言 503、`MCP_SOURCE_READ_FAILED`、非空 ref，响应不含测试令牌、配置全文或 `EACCES`/`EPERM`。恢复后文件仍可读且内容未改。
- 跨平台验证未完成。Linux/macOS 非特权 mode 拒绝仍待对应平台执行。本机 skip 不能代替该结果。

### 命令

工作目录均为 `D:\opencode\packages\opencode`。每个隔离根都先清理配置覆盖、`RECORD`、托管偏好和供应商密钥，再设置独立 home、XDG、managed、内存数据库和 `TEMP`/`TMP`。

| 命令 | 隔离根 | 结果 | 退出码 |
| --- | --- | --- | --- |
| `bun test test/config/config.test.ts test/server/httpapi-config.test.ts --timeout 60000 -t "disabled project config"`（修复前） | `opencode-uc-review-8025323f210b4b48856d32a21c465521` | 3 pass，5 fail，148 filtered out | 1 |
| 同上（修复后） | `opencode-uc-review-44818fedc6944daaa790c2dddd64aac5` | 8 pass，0 fail，148 filtered out，40 expect | 0 |
| 同上（同步发现后） | `opencode-uc-review-5a3f9a43c9ce428aa3af799d435207cc` | 8 pass，0 fail，40 expect | 0 |
| `bun test test/server/httpapi-config.test.ts --timeout 60000` | 同上 | 16 pass，1 skip，0 fail，112 expect | 0 |
| `bun test test/config/config.test.ts test/server/httpapi-config.test.ts --timeout 60000` | `opencode-uc-review-ed047b36293044d9af171bb33b078c42` | 155 pass，1 skip，0 fail，468 expect | 0 |
| `bun typecheck` | `opencode-uc-review-0c077d58b4774bf593d13856852492aa` | 通过 | 0 |

跳过项是非 Windows 的 mode 拒绝用例。0 个测试或全部 skip 未计为通过。

### 清理

- Windows ACL 在请求 `finally` 和 Effect finalizer 中执行 `icacls /reset`。失败会让测试失败。本轮 ACL 用例通过，说明恢复后文件可读。
- 环境变量快照区分原先不存在和原先有值，并在 Effect finalizer 中恢复。home 损坏夹具在 finalizer 中删除。
- 测试实例由用例和 `afterEach` 释放。未改生产配置、锁目录或迁移标记。

### 限制

- Linux、macOS 的真实拒绝读取仍待验证。Windows 结果不能代替。
- 未启动隔离 App。UC-01、UC-02、UC-03 界面仍待验收。macOS `plutil` 未执行。
- R3-03B 保持未关闭。未提交，未推送，未改版本号，未执行 `git add .`。

## 2026-11-10 RF-07 统计与清理补齐

依据：`specs/rf07-skip-permission-cleanup-completion-plan-2026-11-10.md`。本节追加证据，不覆盖上文 155 pass、1 skip 或历史通过。RF-06 本机关闭结论不变。

### RF-07A

- 平台与身份：Microsoft Windows NT 10.0.26300.0，`zhangh\zh2100`。
- 注册分支：Windows ACL 用例在 `win32` 注册为正常执行。POSIX mode 用例只在非 Windows 且 `process.getuid()` 明确不为 0 时注册。root 或无法确认身份时使用 `it.live.skip`。
- 本机 reporter：`returns a typed read failure when Windows denies the project config` 为 pass；`returns a typed read failure when the project config mode denies read` 为框架 skip。过滤命令为 1 pass、1 skip、0 fail，退出码 0。
- 运行中无法建立拒绝不再打印 skip 后返回。探测仍可读，或探测错误不是 `EACCES`/`EPERM`，都会失败并进入恢复。
- 共用契约 `returns unexpanded environment MCP references and typed read failures` 继续执行。
- root 注册统计未在本机提升权限执行，保持待验证。

### RF-07B

- 修改文件：`packages/opencode/test/fixture/config-read-permission.ts`、`packages/opencode/test/server/config-read-permission.test.ts`、`packages/opencode/test/server/httpapi-config.test.ts`。未改产品权限映射或公开 HttpApi。
- 夹具在任何 chmod/icacls 之前登记 finalizer，并先进入待恢复。恢复验证可读且内容未变后才改为已恢复。请求收尾和 finalizer 共用同一状态与两次预算。
- 控制逻辑：探测仍成功为 fail 且恢复；`ENOENT` 不当成拒绝；部分 apply 失败仍恢复；第一次恢复失败后第二次成功；两次都失败保持待恢复并失败；中断等到修改完成后由作用域恢复。7 pass，0 fail。
- 本机真实 ACL：拒绝为 `EPERM`，HTTP 503、`MCP_SOURCE_READ_FAILED`、非空 ref，响应不含测试令牌或原始权限错误。恢复后状态为 restored。

### 命令

工作目录均为 `D:\opencode\packages\opencode`。隔离方式与上节相同。

| 命令 | 隔离根 | 结果 | 退出码 |
| --- | --- | --- | --- |
| `bun test test/server/config-read-permission.test.ts --timeout 60000` | `opencode-uc-review-4971b62fc976402fa69871a4c84bb012` | 7 pass，0 fail，25 expect | 0 |
| `bun test test/server/httpapi-config.test.ts --timeout 60000` | `opencode-uc-review-72ba41cc8af54e2d901893e3d9d907fd` | 16 pass，1 skip，0 fail，113 expect | 0 |
| `bun test test/server/httpapi-config.test.ts --timeout 60000 -t "denies"` | `opencode-uc-review-1506c37824c847c2b84ad22e14e24c0b` | 1 pass，1 skip，0 fail | 0 |
| `bun test test/config/config.test.ts test/server/httpapi-config.test.ts --timeout 60000` | `opencode-uc-review-55f2ca9b51de412ea9e0feab600d705a` | 155 pass，1 skip，0 fail，469 expect | 0 |
| `bun typecheck` | `opencode-uc-review-c743bed19a9b47839e1c39d1855adba8` | 通过 | 0 |

联合回归在注册分支收窄前执行，统计与最终 HTTP 过滤一致：POSIX 用例为框架 skip。类型检查在收窄后通过。

### 清理

- 权限恢复由夹具状态机负责。成功后文件可读且内容未改。恢复失败保持待恢复，并在预算用尽后失败。
- 环境恢复使用独立 finalizer。实例和数据库由 HTTP 套件的 `afterEach` 释放。
- 未改生产配置、锁目录或迁移标记。

### 未验证

- 非特权 Linux/macOS 的真实 mode 拒绝仍待执行。
- root 下 POSIX 用例的框架 skip 统计仍待受控环境执行。
- HTTP 等待期间取消只由夹具中断用例覆盖，未在真实 HTTP 请求中取消。
- 界面、macOS `plutil`、R3-03B 保持原状态。未提交，未推送，未改版本号。

## RF-07 生命周期根因修复

依据：`specs/rf07-lifecycle-root-cause-fix-plan-2026-11-10.md`。本节追加证据，不覆盖上文 155 pass、1 skip，也不覆盖“2026-11-10 RF-07 统计与清理补齐”。RF-06 本机关闭结论不变。缺陷范围限于测试夹具和验证代码，未据此修改产品权限逻辑。

### 修复前失败

隔离根 `opencode-uc-review-e7c392094fc34367998741424eefdfef`。平台 Microsoft Windows NT 10.0.26300.0，身份 `zhangh\zh2100`。命令：`bun test test/server/config-read-permission.test.ts --timeout 60000 -t "T07 keeps|T04 reports|T03 uses"`。

| 用例 | 断言 | 结果 |
| --- | --- | --- |
| T07 keeps apply finished before restore when the wait is interrupted | apply 结束后才恢复 | 60 秒超时，退出码 1 |
| T04 reports the first restore error after a later restore succeeds | 整体失败且保留首次恢复错误 | `Exit.isFailure` 收到 false |
| T03 uses the remaining restore budget after apply reports failure | 预算两次、实际恢复两次 | 期望 2，收到 1 |

三条均为 fail，6 条旧用例被过滤。退出码 1。

### 修复后

- 唯一入口是 `withConfigReadDenied`。旧 `deny`/`restore` 句柄已删除。HTTP 测试只提交请求回调，不持有可改生命周期。
- 权限修改在操作声明开始后进入不可取消等待，等到底层 Promise 结束后才恢复。HTTP 请求留在可取消区域。
- 同一 `finish` 处理准备失败、请求失败、取消和恢复失败。上限两次。成功后的再次收尾不再执行权限调用。首次恢复错误在后续成功后仍保留。正文与收尾错误用 `Cause.combine` 同时保留。
- POSIX 恢复使用修改前读取的 mode。Windows `/reset` 只用于夹具新建且确认有继承 ACL 的临时文件。恢复后检查没有测试添加的拒绝 ACE，并核对内容可读。

### 不变量

| 要求 | 测试 | 修复前 | 修复后 | 平台/身份 | 断言 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| L01 | T01、T02、T06 | 调用者手动恢复 | 13 pass 中的对应用例通过 | Windows `zhangh\zh2100` | 修改前取得快照；失败后自动恢复且请求不执行 | 本机通过 |
| L02 | T07、T08 | T07 超时 | 两条通过 | 同上 | apply-finished 早于 restore-started；请求中断后仍恢复并保留中断 | 本机通过 |
| L03 | T02、T03、T12 | T03 只恢复一次 | 三条通过 | 同上 | 同一 finish 覆盖失败、预算和幂等收尾 | 本机通过 |
| L04 | T03–T05、T10 | 预算未用完 | 四条通过 | 同上 | 两次上限；验证失败也消耗剩余预算 | 本机通过 |
| L05 | T03–T05、T09 | T04 被记成成功 | 四条通过 | 同上 | 正文、中断和清理原因都可见 | 本机通过 |
| L06 | T11、T14 | 固定 0666/0644 | T11 与 Windows HTTP 通过 | 同上 | 0600/0640/0644/0664 按捕获值恢复；HTTP 503 后文件内容未变 | 本机通过；POSIX chmod 待验证 |
| L07 | T13 | Windows 直接 return | 框架 skip | 同上 | POSIX mode 用例和 root 统计不在 Windows 计为 pass | 本机 skip 正确；Linux/macOS/root 待验证 |
| L08 | 全部新增回归 | 恒真断言 | 修复前三条 fail，修复后对应断言 pass | 同上 | 错误顺序、丢失错误和少恢复都会失败 | 本机通过 |

### 命令

工作目录均为 `D:\opencode\packages\opencode`。隔离方式与上节相同。

| 命令 | 隔离根 | 结果 | 退出码 |
| --- | --- | --- | --- |
| 修复前三条回归 | `opencode-uc-review-e7c392094fc34367998741424eefdfef` | 0 pass，3 fail，6 filtered out | 1 |
| `bun test test/server/config-read-permission.test.ts --timeout 60000` | `opencode-uc-review-fdeff15172c54eaa9b5dba518f76cf6f` | 13 pass，1 skip，0 fail，60 expect | 0 |
| `bun test test/server/httpapi-config.test.ts --timeout 60000` | `opencode-uc-review-e510cc337784423880ed2dfff957e97c` | 16 pass，1 skip，0 fail，114 expect | 0 |
| `bun test test/config/config.test.ts test/server/config-read-permission.test.ts test/server/httpapi-config.test.ts --timeout 60000` | `opencode-uc-review-3d82734f99f140c29007bf6bb065bc94` | 168 pass，2 skip，0 fail，530 expect | 0 |
| `bun typecheck` | `opencode-uc-review-f9e5689060854e9f85bdf5df522de390` | 通过 | 0 |

Windows ACL 用例实际执行并通过。POSIX mode 用例为框架 skip。联合回归的 2 skip 是 T13 与该 POSIX HTTP 用例。

### 清理与限制

- 权限恢复由夹具唯一 finish 完成。Windows HTTP 用例在整体收尾后读取临时文件，内容与原文档一致。
- 环境恢复仍由独立 finalizer 负责。实例和数据库由 HTTP 套件 `afterEach` 释放。
- 未改生产权限映射、公开 HttpApi、SDK、锁或迁移标记。未提交，未推送，未改版本号。
- 非特权 Linux/macOS 的真实 chmod 拒绝、root 框架 skip 统计仍待执行。真实 HTTP 传输取消未单独执行；T08 只证明受控请求回调取消后的夹具收尾。
- 界面、macOS `plutil`、R3-03B 保持原状态。RF-07 本机生命周期证据已补齐，跨平台验证未关闭。

## RF-07 操作投递与取消收尾补修

依据：`specs/rf07-dispatch-and-cancellation-fix-plan-2026-11-10.md`。本节追加证据，不覆盖上文 155 pass、1 skip、“2026-11-10 RF-07 统计与清理补齐”或“RF-07 生命周期根因修复”。RF-06 本机关闭结论不变。

### 根因与修复

- D01：所有权从适配器开始信号改为投递时登记。已启动的修改 Promise 在取消后仍被等待，恢复晚于 apply 完成。
- D02：同步抛错、返回失败和 Promise 拒绝进入同一完成结果，不再等待不存在的开始信号。
- D03：删除 `Effect.ignore`。当前 Effect 4.0.0-beta.83 的 `acquireUseRelease` 会丢弃 release 失败，因此入口改为 `uninterruptibleMask` 捕获正文退出，再由唯一 finish 合并中断与清理错误。`Cause.pretty` 会省略与中断并列的失败，所以中断原因上保留清理错误文本，同时 Cause 仍保留原中断和清理失败。
- 产品权限映射、公开 HttpApi、SDK、锁和迁移代码未改。

### 本机结果

平台 Microsoft Windows NT 10.0.26300.0，身份 `zhangh\zh2100`。工作目录 `D:\opencode\packages\opencode`。

| 项目 | 修复前 | 修复后 |
| --- | --- | --- |
| D01 / B01 | 作用域结束后修改继续，资源未恢复 | apply 完成先于恢复；一次恢复；Cause 保留中断 |
| D02 / B02 | 只收到 TimeoutError | 有界完成，Cause 含 `apply failed before started`，请求未执行，恢复完成 |
| D03 / B03 | 恢复两次，Cause 只有中断 | 恰好两次恢复；`Cause.hasInterrupts` 为真；两次恢复错误可见 |
| B04–B10 | B04 为历史对照，其余未固化 | 同步抛错、拒绝、取消后失败、二次恢复、投递前取消、部分修改和恢复抛错/拒绝均通过 |
| B11 | 历史 Windows ACL/HTTP 通过 | 本轮 HTTP 套件再次实际执行 Windows ACL，503、`MCP_SOURCE_READ_FAILED`、非空 ref，响应不含令牌、文档全文或 `EACCES`/`EPERM` |

### 命令

| 命令 | 隔离根 | 结果 | 退出码 |
| --- | --- | --- | --- |
| `bun test test/server/config-read-permission.test.ts --timeout 60000 -t "B01 restores\|B02 reports\|B03 keeps"`（修复后） | `opencode-uc-review-ef5a59ec2cab4fb8b2e2bd3653381a6b` | 3 pass，0 fail，14 filtered out，16 expect | 0 |
| `bun test test/server/config-read-permission.test.ts --timeout 60000` | `opencode-uc-review-19be95ff3a7540ca9e23bbf2cba49956` | 23 pass，1 skip，0 fail，111 expect | 0 |
| `bun test test/server/httpapi-config.test.ts --timeout 60000` | `opencode-uc-review-36712e7ac11b46b0a879e152f15d654b` | 16 pass，1 skip，0 fail，114 expect | 0 |
| `bun test test/config/config.test.ts test/server/config-read-permission.test.ts test/server/httpapi-config.test.ts --timeout 60000` | `opencode-uc-review-0a57645529fc4fae8508e258af12b68f` | 178 pass，2 skip，0 fail，581 expect | 0 |
| `bun typecheck` | `opencode-uc-review-06f4caab842e4ee59a00347883aab338` | 通过 | 0 |

夹具套件的 1 skip 是 T13。HTTP 与联合套件的 POSIX mode 拒绝仍是框架 skip。过滤命令实际执行了 B01、B02、B03。

### 清理与限制

- 已投递操作在成功、失败和取消出口都会等待结束后恢复。投递前取消不调用 apply，也不恢复。
- Windows ACL 仍只作用于新建临时文件。HTTP 用例在 `withConfigReadDenied` 返回后断言文件内容。
- 未提交，未推送，未改版本号，未执行 `git add .`。
- Linux/macOS 非特权 chmod 拒绝和 root skip 统计仍待对应环境执行。本机 Windows 结果不能代替。
- 界面、macOS `plutil`、R3-03B 保持原状态。RF-07 本机投递与取消收尾已补齐，跨平台验证未关闭。


## RF-07 完整验证异常与状态归一化修复

日期：2026-11-10。本节追加实际修改与验证证据，保留上文历史结果。

### 根因与修改

1. 恢复预算原先只覆盖 restore 调用本身。后续 read、mode 或 ACL verify 同步抛错、Promise 拒绝时，异常会越过该预算，第二次恢复不执行。现在 restoreAttempt 将恢复与全部验证放进同一个 settled 边界，统一记录每次失败，最多执行两次；完整验证成功后才标记 restored。后续恢复成功仍保留前次错误。
2. apply 结果原先在正常与取消出口分别转换。取消出口只提取 error，导致非零或 null status 且没有 error 时丢失操作失败。现在投递入口统一把结果转换为同一个 Exit：仅 status 为 0 且无 error 成功，其他状态生成明确错误；正常与取消收尾都使用这份结果。
3. 中间验证发现：在不可中断等待内部直接传播失败，会遮住待处理中断。最终实现只在等待区传递 Exit 值，离开该区域后再解释结果，由唯一收尾入口合并中断、操作失败和恢复失败。删除未使用的 joinSettled 及重复结果转换。

本轮代码仅修改 test/fixture/config-read-permission.ts 与 test/server/config-read-permission.test.ts，未改产品权限映射、公开协议或 SDK。

### 长期回归

新增 permission result boundaries 共 20 项受控回归：

| 编号 | 覆盖 | 用例数 |
| --- | --- | --- |
| C01 | read/mode/verify 的同步抛错与 Promise 拒绝；首次失败后恢复成功、持续两次失败；检查预算、失败历史与最终状态 | 12 |
| C02 | status 为 1、null、0 且带 error，分别走正常与取消出口；检查操作错误、中断、请求未执行及恢复次数 | 6 |
| C03 | 取消、仅 status 的 apply 失败、两次恢复失败同时发生，所有原因都保留 | 1 |
| C04 | 请求取消后，首次验证拒绝、第二次恢复成功；中断和首次验证错误均保留 | 1 |

修复前新增回归为 2 pass、18 fail、24 filtered out、51 expect，退出码 1。隔离根为 `C:\Users\zh2100\AppData\Local\Temp\opencode-rf07-final-review-e31d7363b6ea458cb972f66b20fe74d5`。首次中间实现全夹具为 38 pass、1 skip、5 fail；中断传播问题修正后才得到下列最终结果。

### 最终验证

平台 Microsoft Windows NT 10.0.26300.0，身份 `zhangh\zh2100`。工作目录 `D:\opencode\packages\opencode`。

| 命令 | 结果 | 退出码 |
| --- | --- | --- |
| `bun test test/server/config-read-permission.test.ts --timeout 60000 --only-failures` | 43 pass、1 skip、0 fail、230 expect | 0 |
| `bun test test/config/config.test.ts test/server/config-read-permission.test.ts test/server/httpapi-config.test.ts --timeout 60000 --only-failures` | 198 pass、2 skip、0 fail、700 expect；200 tests，177.71 秒 | 0 |
| `bun typecheck` | 通过（最终中断传播修正后执行） | 0 |
| `bun ../../node_modules/prettier/bin/prettier.cjs --check test/fixture/config-read-permission.ts test/server/config-read-permission.test.ts` | 两份目标文件格式通过 | 0 |

最终夹具隔离根：`C:\Users\zh2100\AppData\Local\Temp\opencode-rf07-final-review-63bd1359af3641a4a9f2f30b5ece76d4`。

最终联合隔离根：`C:\Users\zh2100\AppData\Local\Temp\opencode-rf07-final-review-906bf6c3ccc246478bb1d6b6feb6fd0d`。

两个 skip 分别是夹具 T13 的无条件框架 skip，以及本机不适用的 HTTP POSIX mode 用例。T13 不能作为 POSIX 或 root 的真实验证证据。Windows ACL HTTP 用例实际执行并通过。

最终文件 SHA256：

- `test/fixture/config-read-permission.ts`：`2A81FB35BE653BB554802EBD521E939D5CD23A47CACDFE73204A5A0FCA6E3C4B`
- `test/server/config-read-permission.test.ts`：`290214C76263BE745BD93B7B708533EA4518118C47A2A052AF4B805AA61CF209`

### 结论与边界

本轮两类夹具缺陷已在本机修复并完成自动验证。Linux/macOS 非特权权限拒绝、root 真实跳过统计、真实 HTTP 传输取消仍待验证；受控请求取消不能代替传输层验收。历史界面、macOS plutil 和 R3-03B 保持未关闭状态。

未提交、未推送、未重启应用，未改版本号，未写生产配置、凭据或迁移标记。未覆盖其他未提交改动。
## 后续验收发现 ACC-01 / ACC-02（2026-11-13）

本节晚于前述 FUP-02 局部验收，不撤销其原范围。新增正式后续页面联合 6 pass、2 fail、0 skip；两个失败指向同一处经典布局切服务器后仍读取 A 的缺陷 ACC-01。Relay E2E 类型检查通过。Linux uid 1000 联合 61 pass、2 skip、0 fail；真实 root mode 用例 0 pass、1 skip、0 fail。Windows 冷启动 ACL 恢复后仍 503，确认失败缓存缺陷 ACC-02；热实例和直接目录缓存失效仅为定位对照，不能作为修复。

详见 [后续验收、根因与修复出口](D:/opencode/specs/followup-acceptance-results-2026-11-13.md)。RF-07 仅 Linux 已覆盖子范围通过，macOS 和 Windows 冷启动恢复仍未关闭；经典布局、历史完整 UI、R3-03B 与目标产物仍不扩大关闭。没有修改产品实现、提交或重启用户原有应用；本轮隔离服务和专用容器已清理。
