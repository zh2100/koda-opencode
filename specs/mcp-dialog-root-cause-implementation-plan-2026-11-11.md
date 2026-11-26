# MCP 弹窗根因修复与验收修正实施方案 — 2026-11-11

实施状态（2026-11-11）：已按本方案完成修改和本机独立验收，详见[实施结果](D:/opencode/specs/mcp-dialog-root-cause-fix-results-2026-11-11.md)。下文保留原实施设计及历史基线；当前运行应用未重启，主工作区依赖未重装。

结论：AC-01 是共享焦点作用域的初始化缺陷；AC-02 是验收把 Portal 内容消失当作内部关闭完成。按“先固化失败 → 修复共享依赖 → 建立真实关闭契约 → 修正验收 → 独立生产构建复验”的顺序实施。

原始验收仍为 10 pass、2 fail。后续三次诊断通过只证明快捷键等待条件的归因，不能替代正式套件重新验收。OA-06、UI01～UI08、R3-03B、RF-07 等历史状态保持原样。

## 1. 根源定位

### 1.1 AC-01：恢复目标依赖后续事件，没有初始化已发生的聚焦

实际依赖为 @kobalte/core 0.13.11，版本由[根 package.json](D:/opencode/package.json:49)的 catalog 固定。

直接根源位于该依赖的 createFocusScope：

1. lastFocusedElement 初始为 null。
2. 挂载 effect 先派发自动聚焦事件。
3. [UI v2 Dialog](D:/opencode/packages/ui/src/v2/components/dialog-v2.tsx:101)在 onOpenAutoFocus 中同步调用 autofocus 输入框的 focus()，并阻止默认自动聚焦。
4. 后续 effect 才安装焦点陷阱的 focusin/focusout 监听，错过了刚发生的聚焦。
5. 安装监听时没有从 document.activeElement 补录内部焦点。
6. 外部控件 focus() 时，恢复代码对 null 调用 focusWithoutScrolling，焦点无法回到弹窗。

[旧版 Dialog](D:/opencode/packages/ui/src/components/dialog.tsx)同样使用同步 autofocus 回调，因此修复必须覆盖共享边界，不能只给 MCP 或 UI v2 加补丁。旧版是否存在完全相同的用户路径还需新增浏览器回归证明，不将推断写成已复现结论。

已确认的运行证据：初始内部输入框已聚焦、trapFocus=true、paused=false、两个焦点哨兵存在，但 lastFocusedElement=null；外部抢焦点成功。再次实际聚焦输入框后，lastFocusedElement 正确记录，相同外部操作被拦住。

### 1.2 AC-02：可见状态与命令可接纳状态被混用

直接链路：

- [DialogProvider.close](D:/opencode/packages/ui/src/context/dialog.tsx:67)登记 100ms 定时器，随后同步 setClosing(true)。
- Kobalte 的 open=false 会使 Portal 内容及其中的 data-dialog-layer 消失。
- 内部 stack 中仍有 closing=true 的 Active，定时器结束才移除。
- [来源编辑用例](D:/opencode/packages/app/e2e/regression/mcp-source-edit.spec.ts:94)只等待 DOM 层数量为零，随即发送 Control+,。
- [命令处理](D:/opencode/packages/app/src/context/command.tsx:398)看到 dialog.active，按现有规则返回。该按键不会在收尾后重放。

失败现场 suspended=false、signature=comma:1、active.closing=true，且没有第二次 settings-call。等待真实 dialog.active=null 后，三次完整快捷键保存重开路径均通过。没有证据支持暂停计数泄漏、命令注册丢失或已销毁设置回调残留。

本项首先修正验收契约。保留关闭期间的快捷键保护；不删除 dialog.active 检查，不缩短关闭定时器，也不自动重发按键。

### 1.3 为什么之前的验证没有拦住

- 组件回归没有复刻“同步 autofocus 先发生、陷阱监听后安装”的真实浏览器路径。普通 Content 默认聚焦与 UI v2 的自定义自动聚焦时序不同，Happy DOM 的结果也不能代表 Chromium。
- 测试断言了 modal、DOM 层数等间接状态，缺少“恢复目标已可用”和“内部栈已清空”的准确契约。
- Kobalte 同时发布 default JS 和 solid JSX 入口；若只修一个文件，会造成组件测试与生产构建结果不一致。
- 后续诊断中曾把 DOM 层消失误认为排除了关闭期间拦截。该判断已在[验收报告](D:/opencode/specs/mcp-dialog-acceptance-2026-11-11.md)中更正。

## 2. 选定实现路线与文件边界

选择保留 @kobalte/core 0.13.11，通过仓库现有 Bun patchedDependencies 机制添加最小持久补丁。当前没有已验证能解决此问题的升级版本，因此本方案不混入依赖升级。

| 文件或边界                                                      | 计划修改                                                   |
| --------------------------------------------------------------- | ---------------------------------------------------------- |
| 新建 patches/@kobalte%2Fcore@0.13.11.patch                      | 修复焦点作用域初始化及恢复目标失效处理                     |
| 根 package.json 的 patchedDependencies                          | 登记该精确版本补丁，保留其他补丁                           |
| bun.lock                                                        | 由包管理器登记补丁信息，保留当前其他未提交差异             |
| packages/ui/src/context/dialog.tsx                              | 在持久宿主增加由内部 stack 派生的 data-dialog-count        |
| packages/app/test-browser/dialog-provider-lifecycle.test.ts     | 增加内部计数与清理边界回归，保留既有用例                   |
| packages/app/e2e/reproduction/dialog-lifecycle/main.tsx         | 扩展真实浏览器夹具，覆盖初始 autofocus、旧版及恢复目标失效 |
| packages/app/e2e/regression/dialog-lifecycle-acceptance.spec.ts | 加入焦点边界回归，关闭等待改用内部计数契约                 |
| packages/app/e2e/regression/mcp-source-edit.spec.ts             | 保留 Control+,，等待真实 idle 后再重开                     |
| packages/app/e2e/regression/mcp-dialog-acceptance.spec.ts       | 保留按钮入口对照，统一采用内部关闭契约                     |
| 新建 packages/app/e2e/utils/dialog.ts                           | 复用精确的关闭就绪检查                                     |
| E2E 类型配置                                                    | 将新增验收文件纳入受控类型检查                             |
| specs 中结果文档                                                | 分项记录修改前失败、修改后通过与未覆盖边界                 |

产品 MCP 保存、服务器 scope、请求归属、公开协议和 SDK 本轮不需要改。会话/timeline 不在本方案内，因此不触发会话性能基线工作。

## 3. 逐步实施

### 步骤 0：固定当前基线，隔离依赖操作

1. 记录相关文件的 git diff、未跟踪文件清单、代码摘要和现有补丁列表。
2. 当前 bun.lock、DialogProvider 已有未提交改动。以当前工作区内容为基线，不把 HEAD 当作本轮起点。
3. 建立独立工作副本，包含本方案依赖的当前已修改文件及未跟踪测试；不得只复制已提交版本而丢失前轮修复。
4. 依赖安装和 bun patch 操作在独立副本及独立缓存内执行，不操作运行中应用使用的 node_modules 或共享实体。
5. 准备独立 home、XDG 数据/配置/缓存/状态、临时目录和空闲端口；不连接生产配置、凭据或迁移目录。
6. 保存当前原始浏览器失败、组件回归与类型检查日志。历史证据保持原路径，不覆盖。

交付物：本轮差异边界清单、隔离目录与环境记录。未完成本步，不开始依赖补丁。

### 步骤 1：先固化会失败的正式回归

1. 保留当前 AC-01 用例：打开真实 UI v2 弹窗后，仅等待 autofocus 输入框实际聚焦，不先对它调用 focus()。
2. 随即对背景按钮调用真实 focus()；期望焦点仍在弹窗内。此用例在修复前必须失败。
3. 为旧版 Dialog 增加相同路径，独立报告结果；不要先假定旧版一定失败。
4. 为默认聚焦路径增加无 autofocus 的对照，避免修复改变既有聚焦行为。
5. 保留原生关闭、叠层关闭、替换、Provider 销毁及 MCP 旧回包归属全部既有断言。
6. 对 AC-02 保留原失败记录；新增准确就绪契约的测试在下一步契约实现后执行，不通过固定 sleep 掩盖竞态。

交付物：修复前的精确失败列表。测试必须运行真实 Provider、Kobalte 与 UI 包装组件，不能用复制实现或替代焦点逻辑的 mock。

### 步骤 2：创建可持续安装的 Kobalte 补丁

1. 在隔离副本使用 Bun 的 patch 工作流定位 @kobalte/core@0.13.11，再生成版本绑定补丁。先核对当前 Bun 的 patch/patch --commit 帮助，不手工猜测写入位置。
2. 修改该包以下三个对应文件，保持逻辑一致：
   - src/primitives/create-focus-scope/create-focus-scope.tsx
   - dist/chunk/ISKHZMHS.js（default 发布入口依赖）
   - dist/chunk/7A3GDF4Y.jsx（solid 发布入口依赖）
3. 源码与两个发布入口均纳入补丁；不只修改 src，因为生产实际执行 dist；也不只修改 default，因为 Solid 解析可走 JSX。
4. 提交 patch 工作流生成的补丁到隔离工作副本，检查根 package.json 中新增精确版本映射。
5. 由包管理器更新 bun.lock 的补丁信息，检查 catalog 版本仍为 0.13.11，其他 patchedDependencies 完整保留。
6. 差异若包含无关依赖升级、其他补丁重写或大范围锁文件格式变化，先查明原因再继续。

交付物：一个精确版本依赖补丁、对应清单和锁文件差异。不能只留下 node_modules 本地编辑。

### 步骤 3：修复焦点恢复算法

在 trapFocus 已启用、容器已存在、作用域没有暂停的分支内进行以下修改：

1. 安装监听时读取当前 activeElement。
2. 若当前焦点属于容器内、仍连接在当前文档且是有效聚焦目标，直接记为 lastFocusedElement；这一步只记录，不主动改变用户焦点。
3. 此初始化随作用域重新激活执行，覆盖上层弹窗关闭后恢复下层的路径。
4. 将 focusin/focusout 中的恢复目标解析保持一致：
   - 优先使用仍有效、属于当前容器的上次内部焦点；
   - 否则使用当前有效的内部焦点；
   - 再否则使用当前容器的首个可用 tabbable；
   - Dialog 没有可用子控件时，使用可聚焦的 Content 容器兜底。
5. 不接受已断开、已移出容器、禁用/不可聚焦或焦点哨兵作为恢复目标。复用依赖已有工具，不自创一套可见性/可聚焦判断。
6. 保留 DATA_TOP_LAYER_ATTR 的原有豁免，以及暂停、非模态和关闭状态的保护；不把合法外置下拉层拉回父弹窗。
7. 恢复动作必须防止递归抢焦点：同一目标已是 activeElement 时不反复 focus；选中恢复目标后保持内部记录一致。
8. 保留已有自动聚焦事件的取消语义、默认延迟聚焦及卸载焦点恢复，不将它们全部改为同步执行。
9. 在 JS/JSX 两份发布入口复核相同的初始化和回退逻辑，记录各测试实际解析的入口。

交付物：首次 autofocus 回归由失败变为通过，默认聚焦、关闭与叠层行为未退化。

不能以以下动作代替本步：删除 autofocus、先人工聚焦输入框、派发伪造 focusin、延迟到测试刚好能过、在 MCP 业务页另建焦点陷阱。

### 步骤 4：建立准确的关闭就绪契约

在 [DialogProvider 的持久宿主](D:/opencode/packages/ui/src/context/dialog.tsx:178)增加：

    data-dialog-count={ctx.stack().length}

规则：

1. 该属性放在 data-component="dialog-stack" 的持久 div 上，位于 Kobalte Portal 之外。
2. 数量直接来自真实 stack，不能由 querySelector 统计可见弹窗反推。
3. 未打开时为 0；打开一个为 1；进入关闭收尾时仍为 1；内部栈移除后才为 0。
4. 叠层数量准确反映所有仍在栈中的实例，包括关闭中的实例。
5. 保留 close 的幂等、实例定时器、show/push 语义，以及 command.tsx 的 dialog.active 保护。
6. 本次只增加计数契约。Active.closing 当前是普通字段，不能直接派生一个假装会自动响应的 closing data-state。
7. “count=0”表示内部命令准入栈已空，不代表第三方库所有延迟焦点清理均结束；需要验证资源释放时，仍单独断言 disposed 等结果。

增加组件回归：初始为 0；打开为 1；原生内容消失但实例仍 closing 时计数仍为 1；收尾后为 0；两层关闭、show 替换和 Provider 卸载保持原有一次性清理。

交付物：真实内部栈与外部验收共用一个状态来源，没有新建平行生命周期状态。

### 步骤 5：修正所有涉及关闭后操作的 E2E

新增复用的 waitForDialogsIdle(page)；当前 App 与专用夹具各只有一个 DialogProvider。辅助检查应：

    const stack = page.locator('[data-component="dialog-stack"]')
    await expect(stack).toHaveCount(1)
    await expect(stack).toHaveAttribute("data-dialog-count", "0")

具体应用：

1. 来源编辑保存后，先等以上 idle，再发送一次 Control+,；继续断言设置出现、MCP 可编辑和命令重读正确。
2. MCP 按钮重开用例也使用 idle；保留按钮路径作为独立对照，不用它替换快捷键用例。
3. 叠层测试等待内部计数从 2 到 1，再确认下层焦点约束；全部关闭等待 0。
4. 原生关闭与 Provider 销毁仍分别检查关闭通知和销毁次数，不能只看计数。
5. 不添加全局诊断 getter、bundle 字符串替换或产品测试专用回调。
6. 不使用 sleep、waitForTimeout 或重发按键来同步。
7. 辅助检查必须先确认宿主存在且唯一，避免 Provider 未挂载或已销毁时把“没找到任何弹窗”误判为 idle。
8. 若未来出现多个合法 Provider，再按明确上下文定位对应宿主，不用 first()/last() 消除歧义。

交付物：AC-02 用例准确覆盖“关闭完成后的快捷键重开”，关闭期间的合法拦截另由组件测试验证。

### 步骤 6：补齐类型检查与依赖安装复现

1. 将新增 spec、夹具和配置纳入受控 E2E 类型检查入口。
2. 可以新增专用 e2e/tsconfig.dialog-lifecycle.json 继承已有 E2E 配置，并配套包内 typecheck:e2e:dialog 脚本；也可精确扩展现有 include。两种方式选一种，不同时维护重复清单。
3. 纳入 fixture Vite 配置时，要同时包含它实际导入的 packages/app/vite.config.ts 和 vite.js，避免 TS6307。
4. App 和 UI 的类型检查仍从各自包目录执行 bun typecheck。
5. 在独立、无原 node_modules 的副本做冻结锁文件安装，证明补丁自动应用。主工作区不做清理安装。
6. 不依赖本机现存的补丁后缓存；记录安装器版本，并与 CI 使用的 Bun 版本核对。无需为本次修复改 packageManager 版本。
7. 分别核实默认 JS 入口及生产 Solid 入口的实际解析路径、补丁内容与运行结果。

交付物：可在干净安装中复现的修复；专用 E2E 类型检查不是临时脚本才可运行。

### 步骤 7：执行真实生产构建验收

1. 使用独立工作副本的修复后版本重新生产构建，不能复用修复前 bundle。
2. 用现有独立验收配置启动新空闲端口，reuseExistingServer=false。
3. 真实浏览器运行原有 12 项加新增焦点矩阵，保留 API 受控的边界说明。
4. 快捷键保存重开路径在独立 browser context 中连续验证三次；不对同一失败操作自动重试。
5. 查看关键截图：初始焦点、保存重开读取结果、旧请求完成后保留新草稿。
6. 确认关闭期间的数据计数为 1，完全收尾后为 0；无关闭后抢焦点、重复销毁或旧响应误关新弹窗。
7. 测试结束仅清理本次独立服务；核实端口释放，保留日志、JSON、trace 和截图。

交付物：对应修复后代码摘要的新验收报告。

## 4. 最小回归矩阵

| 编号 | 场景与精确要求                                                          | 验证层                 |
| ---- | ----------------------------------------------------------------------- | ---------------------- |
| F01  | UI v2 首次 autofocus 后直接外部 focus，始终留在当前弹窗；不预先手动聚焦 | 真实浏览器，修复前红测 |
| F02  | 旧版 Dialog 同样路径，记录修复前后结果                                  | 真实浏览器             |
| F03  | 无 autofocus，默认聚焦和 Tab/Shift+Tab 循环保持正确                     | 真实浏览器             |
| F04  | 上次焦点控件被移除、移出容器或禁用，再次外部 focus 能恢复到有效候选     | 真实浏览器             |
| F05  | 无可用子控件时 Content 获得焦点，无递归聚焦或异常                       | 真实浏览器             |
| F06  | 两层弹窗只约束栈顶；上层关闭后下层恢复，底层不抢栈顶焦点                | 真实浏览器             |
| F07  | 真实 Select/Popover 外置层按既有 top-layer 规则正常交互                 | 真实浏览器             |
| F08  | 替换、卸载后旧作用域不再抢新弹窗或页面焦点                              | 真实浏览器及组件       |
| C01  | DOM 内容已消失但内部实例 closing 时，data-dialog-count 仍为 1           | 组件，控制收尾边界     |
| C02  | 关闭完成 count=0；两层、替换和销毁计数准确，无重复销毁                  | 组件及浏览器           |
| C03  | 内部 idle 后 Control+, 重开并读到已保存命令，三次独立上下文均通过       | 完整 App 浏览器        |
| C04  | 关闭期间快捷键保护保持，不意外重放或重复打开                            | 组件，控制收尾边界     |
| M01  | 现有 28 项 Provider/MCP 归属回归全部通过；新增项单独计数                | 组件                   |
| I01  | 干净冻结安装自动应用补丁，JS/JSX 两入口逻辑一致                         | 安装与构建检查         |

## 5. 验证命令与执行顺序

从 packages/app 运行组件回归：

    bun test --tsconfig-override ./tsconfig.test.json --conditions=browser --preload ./happydom.ts ./test-browser/dialog-provider-lifecycle.test.ts ./test-browser/dialog-mcp-v2-ownership.test.ts --timeout 20000

组件测试生成的临时编译文件清理后，再从各包目录运行：

    bun typecheck

E2E 类型检查使用步骤 6 选定的包内脚本，不直接调用 tsc，也不把默认脚本未包含新文件的成功冒充新用例已检查。

建立全新隔离环境、设置 OPENCODE_ACCEPTANCE_ROOT 与 OPENCODE_ACCEPTANCE_PORT 后，从 packages/app 运行：

    bun ./node_modules/@playwright/test/cli.js test --config e2e/reproduction/dialog-lifecycle/playwright.config.ts

最后检查 Prettier、相关 git diff --check、依赖补丁差异及临时文件清理。

## 6. 关闭条件

AC-01 关闭必须同时满足：

1. 原先失败的首次 autofocus 浏览器用例在未改期望的情况下通过。
2. 初始化与恢复目标失效由同一共享边界处理。
3. 旧版、默认聚焦、叠层和外置交互层没有回归。
4. JS/JSX 发布入口均携带修复，干净冻结安装可复现。
5. 产品构建与真实浏览器均通过，组件和类型检查通过。

AC-02 的验收问题关闭必须同时满足：

1. 正式测试用真实内部计数等待 idle，且宿主存在、唯一。
2. 原 Control+, 保存重开与重读路径通过，不改成按钮规避。
3. 不使用固定延时、重发按键或生产全局诊断变量。
4. 关闭期间保护保持，三次独立上下文重复验证通过。

任何必需项未执行就标记“待验收”，不得用其他通过项替代。原始 12 项历史结果不覆盖；新报告按新增用例数量精确记录，不拼接诊断统计。

## 7. 风险、回退与交付顺序

主要风险是依赖焦点作用域也被其他浮层使用。因此补丁必须保留 top-layer、暂停及非模态语义，并至少完成 F07。原关闭逻辑本轮只增加观测属性，不调整定时器与准入规则。

推荐交付顺序：

1. 先交付正式失败回归和共享依赖补丁。
2. 再交付内部计数契约和 E2E 等待修正。
3. 最后交付干净安装、生产浏览器验收和结果记录。

若失败，只撤销本轮新引入的补丁注册、锁文件补丁差异及本轮相关代码差异，不整份恢复 bun.lock 或 DialogProvider，不覆盖用户原来的未提交修改。验收证据保留。

本方案不包含提交、推送、版本发布或生产目录变更。用户授权实施后，再按本文件执行。

## 8. 根因证据

- [验收与后续根因报告](D:/opencode/specs/mcp-dialog-acceptance-2026-11-11.md)
- [焦点因果对照](C:/Users/zh2100/AppData/Local/Temp/opencode-mcp-cause-6f5f9ff22e794026a6192474ccd33394/cause.log)
- [原等待条件三次对照：2 pass、1 fail](C:/Users/zh2100/AppData/Local/Temp/opencode-mcp-cause-6f5f9ff22e794026a6192474ccd33394-repeat/cause.log)
- [等待内部栈清空后三次对照：3 pass、0 fail](C:/Users/zh2100/AppData/Local/Temp/opencode-mcp-cause-6f5f9ff22e794026a6192474ccd33394-settled/cause.log)

## 9. 实施追加边界

F06 加严回归发现同步嵌套 autofocus 发生时，旧监听清理可能晚于作用域暂停。最终共享补丁在 focusin/focusout 事件入口再次检查暂停和 trapFocus，三发布文件保持一致。该路径已先失败再通过。最终浏览器 20 项、组件 30 项、快捷键三个独立上下文及三项类型检查全部通过；历史未关闭项保持原状。完整证据见[实施结果](D:/opencode/specs/mcp-dialog-root-cause-fix-results-2026-11-11.md)。
