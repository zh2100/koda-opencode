# UC-02 项目来源与跨平台权限测试补修实施方案

日期：2026-11-10  
状态：待实施。本文仅规定修改与验证步骤，不表示代码已修复或验收已完成。

## 1. 范围、证据与优先级

本方案承接 `uncommitted-fixes-review-followup-plan-2026-11-09.md`，结果追加到 `uncommitted-fixes-results-2026-11-09.md`，不覆盖历史通过或失败记录。

| 编号 | 优先级 | 性质 | 本轮证据 | 目标 |
| --- | --- | --- | --- | --- |
| RF-06 | P2 | 已复现业务缺陷 | 禁用项目配置，环境提供有效 MCP，项目 opencode.json 损坏；真实 HTTP /config 为 200，/config/mcp/review 为 400 MCP_DOCUMENT_INVALID | 来源预检与实际加载使用相同的来源选择规则 |
| RF-07 | P2 | 静态确认的测试平台缺陷 | httpapi-config.test.ts 无条件调用 Windows icacls；非 Windows 找不到该命令时测试主动失败 | 共用契约测试跨平台运行，真实权限测试按平台执行 |

复核基线：配置与 HTTP 两套测试 146 pass、0 fail；图片授权测试 16 pass；OpenCode 的 bun typecheck 退出码为 0。额外的禁用项目配置 HTTP 回归为 0 pass、1 fail。这些是不同命令的结果，不能合并成“所有测试已通过”。本机未运行 Linux/macOS。

本轮不扩展 UC-01、UC-03、UC-04、UC-05，不切换锁后端，不处理 R3-03B，不启动迁移 apply。

## 2. 实施前准备

1. 记录当前分支、HEAD 和 `git status --short`，查看目标文件的暂存与未暂存差异，辨明哪些代码属于已有改动。保留所有原有改动，不执行整树恢复、全量暂存或自动格式化整仓库，不生成备份。
2. 阅读适用的仓库、测试目录 AGENTS.md；测试从包目录执行，类型检查使用 `bun typecheck`。
3. 沿用原实施方案第 8.1 节，在导入业务模块前设置隔离环境。每条验证命令使用新的测试子进程。
4. 清理父进程继承的 OPENCODE_CONFIG、OPENCODE_CONFIG_DIR、OPENCODE_CONFIG_CONTENT、OPENCODE_DISABLE_PROJECT_CONFIG、OPENCODE_TEST_MANAGED_PREFERENCES 和 RECORD，再按用例注入所需值。清理其他覆盖项和供应商凭据的规则沿用原方案。
5. 设置独立 TEMP/TMP、测试 home、XDG 目录、managed 目录和内存数据库。注意包内 test/preload.ts 会重新设置部分目录；验证实际 Global、Location 和数据库路径，不能只检查启动前环境变量。
6. 只使用临时 Git 项目和本地假令牌；MCP 设置 enabled:false，避免真实连接。若测试需要插件依赖，使用现有受控测试设施，避免外部下载。
7. 不重启当前应用，不读取生产凭据，不改生产配置、锁目录或迁移标记。
8. 实施顺序：拆分并隔离平台测试 → 加入 RF-06 失败回归 → 修复来源选择 → 各平台定向测试 → 联合回归与类型检查 → 追加结果。

## 3. RF-06 根因与修改边界

### 3.1 根因

`src/config/config.ts` 的 mcpSource() 当前在约 935 行独立枚举当前目录四个文件，在约 970、980、988 行调用 projectDocumentError()。该枚举不考虑 OPENCODE_DISABLE_PROJECT_CONFIG，也未使用主加载器的向上查找边界和目录集合。

主加载器约 610 行只在未禁用项目配置时调用 ConfigPaths.files()；约 622 行通过 ConfigPaths.directories() 获取目录。后者在禁用时排除项目 .opencode，但仍可保留用户 home 的 .opencode、全局目录和显式 OPENCODE_CONFIG_DIR。

因此，给四个路径外层简单加一个开关只能解决已复现场景，不能保证来源发现一致。反过来，禁用时跳过所有文件校验也会漏掉仍应生效的显式、用户或全局来源。

### 3.2 文件范围

- `packages/opencode/src/config/config.ts`：mcpSource() 的候选发现、文档预检和失败重载判断。
- `packages/opencode/src/config/paths.ts`：优先复用现有 files()/directories()；只有确实需要主加载器与来源预检共用组合逻辑时才增加小型共享函数。
- `packages/opencode/test/config/config.test.ts`：服务级来源选择回归。
- `packages/opencode/test/server/httpapi-config.test.ts`：真实 HTTP 回归。
- 必要时增加独立测试文件以隔离启动环境，不为测试修改产品开关语义。

默认不改实例中间件、App、公开 Schema 或生成客户端。只有新失败明确证明这些位置也有缺陷时才扩大范围并记录原因。

## 4. RF-06 详细实施步骤

### 4.1 先补失败回归

1. 新建隔离 Git 项目，写入损坏的 opencode.json，例如 `{ invalid project `。
2. 设置 OPENCODE_DISABLE_PROJECT_CONFIG=true；环境原文提供完整 remote MCP：type、URL、enabled:false，以及带 `{env:REVIEW_MCP_TOKEN}` 的测试 header。
3. 从干净实例请求 GET /config 和 GET /config/mcp/review；断言两者为 200，后者保留 URL、type 和未展开引用，响应不含测试令牌值。
4. 当前实现应在来源接口的 200 断言失败。保留实际状态、错误 code 和 ref，不记录配置原文或凭据。
5. 对 opencode.jsonc、项目 .opencode 下两种配置和父目录配置做参数化测试；不要把这些拆成多个独立业务缺陷。
6. 以独立子进程或作用域 fixture 管理开关，必须在 finally/finalizer 中恢复环境、销毁实例并重置测试数据库。不同开关组合不得共享已加载实例。

### 4.2 对齐实际来源选择

1. 定位主加载器使用的 directory、worktree、Flag 和 ConfigPaths 调用，列出普通项目文件及目录来源的发现顺序。
2. 让 mcpSource() 的项目候选复用同一 ConfigPaths.files()，使用同一 worktree 边界，并在同一开关条件下启用。
3. .opencode 候选从 ConfigPaths.directories() 产生，按主加载器相同条件筛选，再使用同一文件顺序。不要自行猜测父目录搜索范围。
4. 保留 OPENCODE_CONFIG 的显式加载规则。即使它指向位于项目内的文件，禁用项目自动发现也不能排除这次显式加载。
5. 保留 OPENCODE_CONFIG_DIR、用户 home .opencode 等仍会被主加载器加载的来源。按“来源如何进入加载器”判断，不能仅按文件物理位置分类。
6. 若抽取共享候选函数，只共享文件发现、条件和顺序，不将原文解析、来源贡献记录、版本计算和写入逻辑重构到一起。
7. 更新三次 projectDocumentError() 调用及相关失败分支，使同次请求使用一致的候选集合。审查 projectFiles.length 等判断，避免替换变量后把原本应返回的读取错误吞成空结果。
8. 不调整 State.sources 合并顺序、contributed 过滤或获胜位置计算；重复参与合并的同一来源仍按既有最后获胜位置处理。诊断候选去重不得改变实际合并链。
9. 不以清空整个来源链、捕获所有错误返回 undefined，或直接返回展开后的 Config.get() 作为修复。
10. 若已加载 state 不可用，失败诊断仍应按相同发现规则工作；不能只依赖成功加载后才存在的 sources。

### 4.3 保持错误与读写契约

- 被禁用且未被显式指定的项目文件：不参与加载，也不能使来源接口失败。
- 仍生效的来源损坏：400 / MCP_DOCUMENT_INVALID / 非空 ref；不得返回原文、凭据或系统错误全文。
- 仍生效的来源明确读取失败：503 / MCP_SOURCE_READ_FAILED / 非空 ref。
- GET 获胜文件缺失：保持 200 空结果；必需继承来源读取失败仍按现有契约报错。
- PATCH 缺失、只读、冲突：维持 404、403、409；失败时不改写文件。
- raw env/file 引用、深度合并、补丁写入及 config/version 同源规则保持既有回归约束。

### 4.4 最小测试矩阵

| 用例 | 设置与输入 | 期望 |
| --- | --- | --- |
| D01 | 禁用项目配置；当前项目 json 损坏；环境 MCP 有效 | 两个 GET 均 200；来源完整且不泄密 |
| D02 | 同上，改为 jsonc 或项目 .opencode 文件损坏 | 同 D01 |
| D03 | 禁用；损坏文件位于 worktree 范围内的项目祖先 | 同 D01，不读被忽略来源 |
| D04 | 未禁用；同一损坏项目文件 | MCP GET 400，带 code/ref |
| D05 | 禁用；OPENCODE_CONFIG 显式指向该损坏项目文件 | MCP GET 400，证明显式来源仍生效 |
| D06 | 禁用；显式 OPENCODE_CONFIG_DIR 提供有效 MCP | 返回该来源及 raw 引用；来源类型、可写性遵守原契约 |
| D07 | 禁用；用户 home .opencode 有效或损坏 | 有效时参与合并；损坏时仍失败 |
| D08 | 禁用；项目文件和 .opencode 有冲突值，环境有独立值 | 来源中不出现被忽略的项目值 |
| D09 | 开启；父目录、当前目录、.opencode 分别贡献不同 header | 遵守主加载器实际优先级和搜索边界 |
| D10 | 已加载实例修复有效来源后按既有路径失效重试 | 无需重启即可恢复；引用仍未展开 |

D01 必须覆盖真实 HTTP；D04、D05 必须覆盖首次实例初始化。D06、D07 不得读真实用户目录，全部使用隔离 home/config。

## 5. RF-07 详细实施步骤

### 5.1 拆分测试职责

1. 将当前 `returns unexpanded environment MCP references and typed read failures` 拆为共用契约用例和真实拒绝读取用例。
2. 共用部分在所有平台执行：环境引用不展开、来源只读 PATCH 403、无效文档 400、缺失 GET 200 null。不要因 icacls 不可用而跳过整条原测试。
3. 将 Windows ACL 拒绝读取放入明确的 win32 用例；Linux/macOS 不创建该用例的 ACL 夹具，也不调用 icacls。
4. Linux/macOS 使用非特权身份的权限用例；若执行用户为 root 或环境不能制造真实拒绝，明确记录为跳过及原因，不能将跳过算成拒绝读取验证通过。
5. 受控文件系统服务替身可补充 EACCES/EPERM/EIO/EBUSY 映射的确定性测试，但不能代替已声明的真实 OS 权限验收。

### 5.2 Windows ACL 夹具

1. 只对新建、可丢弃的测试文件修改 ACL。使用参数数组调用 icacls，不拼接 shell 命令；核对用户名、域或 SID 的格式，避免含空格或域账户出错。
2. 在任何 ACL 修改开始前登记清理 finalizer；不能等修改成功或 HTTP 请求进入后才注册。
3. 检查子进程的启动 error、退出码和输出状态。Windows 下工具缺失或应用 ACL 失败必须明确失败，不以无条件 skip 掩盖准备错误。
4. 从新实例执行真实 GET，确保没有旧缓存；断言 503、MCP_SOURCE_READ_FAILED、非空 ref，且无假令牌、配置全文、原始 EACCES 信息。
5. 无论请求、断言还是准备阶段失败，都执行 ACL 恢复，并检查恢复命令结果。ACL 只作用于测试文件，禁止扩大到父目录、仓库或生产目录。
6. 恢复后确认文件可读、内容保持不变。随后允许 scoped 临时目录正常清理；恢复失败记录为测试失败，不静默忽略。

### 5.3 Linux/macOS 权限夹具

1. 新建临时文件，记录原 mode，提前注册恢复 finalizer，再移除读取权限。
2. 使用实际执行服务的非特权用户验证读取确实被拒绝；root 运行不能仅凭 chmod 成功就声称 EACCES 已覆盖。
3. 通过真实 GET 验证同一 503/code/ref 和不泄密断言。
4. 无论请求是否成功都恢复原 mode；验证文件仍可读、未改写，再删除夹具。
5. CI 至少安排一台非特权 Linux/macOS 执行者验证真实拒绝路径；未取得平台结果前保持该平台待验证。

### 5.4 环境与实例清理

1. 环境变量快照必须同时记住“原先不存在”与“原先有值”。
2. 用 Effect 的作用域 finalizer 或等效 finally 恢复，而不是把恢复语句放在测试最后几个断言之后。
3. 无效配置、HTTP 失败、ACL 准备失败、超时或取消都必须恢复 OPENCODE_CONFIG_CONTENT、测试令牌和开关。
4. 清理顺序保证请求不再读取夹具、权限已恢复、实例和数据库已释放，最后删除临时文件。清理失败不能覆盖或隐藏原始失败的诊断信息。

## 6. 执行命令与验证顺序

所有命令在完成第 2 节隔离准备的独立子进程中执行；以下是包目录内命令，不可从仓库根直接运行。

工作目录：`D:\opencode\packages\opencode`。

```powershell
# 先运行新增 RF-06 用例；-t 的值使用最终实际测试标题。
bun test test/config/config.test.ts test/server/httpapi-config.test.ts --timeout 60000 -t "disabled project config"

# 运行拆分后的来源契约和适用平台权限测试。
# 若另建文件，在此加入实际文件路径，不能遗漏其执行。
bun test test/server/httpapi-config.test.ts --timeout 60000

# 最后进行一次联合回归。
bun test test/config/config.test.ts test/server/httpapi-config.test.ts --timeout 60000

# 包级类型检查。
bun typecheck
```

1. 首次新增 RF-06 回归应在修改前失败，修改后通过；保存两次命令结果及退出码。
2. 过滤命令必须确认实际执行了目标用例，0 个测试或全部 skip 不算通过。
3. 在 Windows、非特权 Linux、macOS 记录各自的 pass/fail/skip 和权限能力。缺平台机器可以先完成本机修改，但状态写为跨平台待验证。
4. 联合套件按修改后实际数量记录；拆分和参数化会改变统计，不能要求固定为 146 项。
5. 检查本轮 diff：范围仅为来源发现、必要测试和文档；公开 HTTP 契约未变时无需重新生成客户端。若实际改变了公开声明，按仓库规范生成并检查，禁止手改生成文件。
6. 通过后不重复无关的图片、调度、锁或 Desktop 全套测试；只有依赖或实现范围变化才扩大验证。

## 7. 结果记录和关闭条件

在原结果文档末尾追加“2026-11-10 第二次复核补修”，填写：

| 字段 | 必填内容 |
| --- | --- |
| RF-06 | 修改文件、根因、修复前 HTTP 200/400 证据、修复后矩阵结果 |
| RF-07 | 拆分后的用例标题、平台条件、实际 OS/执行身份、真实拒绝读取结果 |
| 命令 | 工作目录、隔离根、精确命令、pass/fail/skip、退出码 |
| 清理 | ACL/mode 恢复、环境与实例清理是否完成 |
| 限制 | 未执行平台、界面、安装包及其他仍开放事项 |

关闭 RF-06 的条件：新增复现通过，来源选择与主加载器一致，显式来源未被错误跳过，原 400/503、不泄密、缺失和 PATCH 保护回归通过。

RF-07 可先记录“平台隔离已实现、本机通过”；Windows ACL 及至少非特权 Linux/macOS 权限矩阵取得对应结果后，才能声称其跨平台验证完成。未测平台保持待验证，不用 Windows 结果代替。

本方案实施和自动验证通过，仍不表示全部历史 bug 已关闭：UC-01/02/03 真实界面、macOS plutil、R3-03B 以及原记录中的其他验收缺口继续保留。界面若另行执行，必须使用独立数据根和端口，不重启当前应用。

本轮不提交、不推送、不改版本号。只实施本方案时，也不顺带删除其他未提交代码。