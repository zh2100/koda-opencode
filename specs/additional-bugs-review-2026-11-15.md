# 追加缺陷复核记录（2026-11-15）

本记录经十轮复核，在 Linux 续验已登记的问题之外，累计确认 **29 项产品缺陷（3 项 P1、26 项 P2）**。首轮 ADD-01～03，第二轮新增 ADD-04～08，第三轮新增 ADD-09～10，第四轮新增 ADD-11～13，第五轮新增 ADD-14～16，第六轮新增 ADD-17～19，并单独记录 QA-01/02 两项测试可靠性问题；第七轮新增 ADD-20～22，并扩展 ADD-18 的 EPUB 证据；第八轮新增 ADD-23～25；第九轮新增 ADD-26～27；第十轮新增 ADD-28～29。它们是本轮新发现，并不等于都由最近一批修改引入。仅检查和复现，没有修改实现、仓库测试、版本或暂存内容；不将既有已测场景通过扩大为这些新场景通过。

## 1. 复核基线与证据

- 仓库 `D:\opencode`，HEAD `6b051f12a21094df1adef83f9fddfcbb765b319e`，分支 dev。
- 证据根：`C:\Users\zh2100\AppData\Local\Temp\opencode-other-bugs-a196a2f78acf46c08d512c97aa28da43`。
- 所有产品模块导入前经 `script/test-isolated.mjs` 配置独立 home/data/config/state/cache/tmp。凭据使用假值；MCP 上游为受控拒绝适配器，没有调用远程或付费模型。
- 主证据均在对应包目录执行；测试脚本位于证据根，没有加入仓库。测试前和测试后的文件摘要一致，暂存语义一致，见 `manifest-before.json`、`manifest-tested.json`。
- 初次临时脚本出现未导出的 FSUtil.layer、根层未输出 EffectFlock、Env 导入路径错误，均作为夹具错误保留，不算产品缺陷。一次纠正 Env 后的复跑误从根目录发出，不计有效门禁；随后已从 packages/opencode 原样重跑，结论使用该次包目录日志。

## 2. 已确认问题

### ADD-01 / P1：保存图片设置会移除现有配置文件的受保护 DACL

位置：[image-generation-settings.ts](../packages/core/src/image-generation-settings.ts)，第 73–78 行；正式 Server handler `packages/server/src/handlers/image-generation.ts` 直接调用该服务。

复现：隔离配置内放入普通字段及假 apiKey，将文件 DACL 设为受保护且仅当前用户 FullControl；调用真实 `ImageGenerationSettings.update({ enabled: false })`；读取替换后的文件 DACL。

结果：保存成功、原有假 apiKey 保留，但 DACL 从受保护的 `D:PAI(...)` 变成继承的 `D:AI(...)`，重新包含父目录中其他主体的访问规则。安全断言失败。这是实际 NTFS ACL 结果，没有注入 ACL 实现；不表示测试中有其他主体实际读取过文件。

根因：该入口仍以 `writeWithDirs(temporary, text, 0o600)` 加普通 rename 替换整个配置。Windows 的 mode 600 不等于复制既有 DACL；新文件继承父目录权限。共享 ConfigDocument 锁只串行化写入，不能保留文件安全描述符。

证据：`image-final-audit.log` 的 `AUDIT_IMAGE_ACL`，0 pass、2 fail 中第一项。对照：仓库现有 `AtomicDocument` 的真实 Windows 受保护 DACL 测试在同机通过，见 `atomic-dacl-control.log`（1 pass、退出码 0）。

修复方向：在既有 ConfigDocument 租约内改用统一 AtomicDocument 发布，传入原字节并保留安全描述符；不能仅在 rename 后再补 ACL，否则临时文件写入和发布期间仍可能过宽。补实际图片设置入口的 DACL、原字段/假凭据保留，以及 POSIX owner/group/mode 回归。此处权限问题已在 Windows 确认，POSIX 入口行为本轮未执行。

### ADD-02 / P2：取消图片设置保存时，底层 rename 未结束就释放文档锁

位置：同文件第 75–78 行及外围 ConfigDocument.withLock。

复现：仅在 FSUtil.rename 的异步边界设置受控闸门，其他读写和锁使用真实服务与隔离磁盘。启动真实 settings.update，等待 rename 适配器已接收调用；首先确认竞争者无法取得同一锁；再取消保存，底层闸门仍未释放，第二次尝试取得同一锁。

结果：`whileRunning: false` 证明取消前竞争者被正确阻塞；取消后 `finishedAtCancellation: false`、`leaseAcquiredBeforeRenameSettles: true`。即底层已接收的操作仍未收尾，租约已可被后继写入者取得。之后释放闸门并等待真实 IO 结束，才清理夹具。生命周期断言失败。

根因：写入和 rename 直接运行在可取消 Effect 中；取消时 ensuring 提前删除临时文件并允许外层作用域释放锁。该入口没有复用 SettledIO 的“已投递 IO 结束后才能清理和释放租约”规则。

证据：`image-final-audit.log` 第二项及 `AUDIT_IMAGE_CANCEL`。此证据证明服务在受控异步 IO 边界的所有权缺口；没有声称本机实际 OS rename 自发挂起，也没有把未测到的丢数据当成已经发生。风险是后继操作与未完成 IO/清理交叉，违反同一文档写入的互斥区间。

修复方向：与 ADD-01 在同一发布入口收口：取得后重读，取消仅撤销尚未投递的准备；发布、实际 IO 和临时文件清理排空后才能释放租约。保留取消/失败原因，不使用 Effect.ignore 隐藏清理失败。补 write、rename、清理各阶段的取消和后继写入回归。

### ADD-03 / P2：MCP 来源依赖缓存不随有效来源链更新，误报旧文件缺失

位置：`packages/opencode/src/config/config.ts:1166–1171`，缓存写入在第 1258 行。

复现：根配置提供 sample 的基础远程配置，`.opencode/opencode.json` 中的获胜配置本身包含完整 type/url；首次 mcpSource 成功后移除根配置。调用 config.invalidate，再读 config.get 与 mcpSource。

结果：普通有效配置正常得到 `https://winner.example/mcp`，但 mcpSource 仍返回 `MCP_SOURCE_READ_FAILED`。包目录复现为 0 pass、1 fail，失败仅在“当前完整来源应可读取”的断言，见 `mcp-retired-package.log` 和 `AUDIT_MCP_RETIRED`。未访问测试 URL。

根因：`sourceDependencies` 以 directory/name 保存上一次来源链。只要获胜 source 路径未变，就在重新计算当前 chain 之前无条件读取 previous.files；即使当前主加载器已不需要旧文件、显式 invalidate 过，该检查仍失败，缓存也无法进入成功更新分支。updateMcp 内部也调用 mcpSource，因而该旧依赖会阻断编辑。

修复方向：给来源依赖明确的快照/生命周期归属，按当前有效来源链重建并在来源重载后替换旧集合；不能把历史贡献过字段的文件永久当作必要依赖。必须同时保留既有“获胜文件只有 enabled 等覆盖、仍依赖基础连接信息时，必要来源消失应安全失败”的保护。补当前获胜配置自包含/仍需继承、低优先级文件移除/重建/不再贡献、同获胜路径跨代、invalidate 后读取与实际保存的对照矩阵。

## 3. 首轮执行结论与范围（历史证据保留）

有效定向复现共 3 条预期安全/正确性断言失败，对照 AtomicDocument DACL 1 条通过。没有修改产品使失败变绿，没有用夹具错误增加缺陷数，也没有宣称这 4 条执行覆盖整个项目。

ADD-01/02 共用同一根本缺口：图片设置接入了共享锁身份，却仍保留独立发布/取消/清理流程。ADD-03 是来源缓存的生命周期规则没有与当前有效配置同步。建议先处理 ADD-01/02 的共享发布入口，再处理 ADD-03 的依赖快照规则，随后重跑实际入口与跨平台保护。

上一轮 LNX-01～04 继续保持原结论，参见 [Linux 续验报告](./seven-bugs-linux-acceptance-2026-11-15.md)。macOS、原生锁和真实迁移等未验项目不能算已确认的新缺陷。此前 Windows 已执行场景的结果保留；不能将这些结果当作本报告新场景已通过。

没有重启应用、操作生产数据、重建原生模块、提交或推送。本轮隔离根的清理与文档交付差异另见证据根 cleanup.json、manifest-delivery.json；测试脚本及失败日志保留。

## 4. 第二轮深化复核（2026-11-15）

本轮未修改产品源码和仓库测试。输入为首轮交付后的同一工作区；`manifest-before.json` 与 `manifest-tested.json` 显示全部文件一致、暂存语义一致。文档更新后单列差异。第二轮证据根：

`C:\Users\zh2100\AppData\Local\Temp\opencode-deep-audit-5778a9404a844789a2b2b5799fcc1fd5`

本轮聚焦图片设置的目标选择/公开错误，以及 TUI 自动迁移的备份/目标/禁用规则。未重跑整个项目，也没有外推为全部 bug 已找齐。权限测试只使用 Windows 隔离文件和假凭据；所有测试经导入前隔离，分别在 Core、OpenCode、Server 包目录执行。正式 HTTP 验证使用真实 handler、协议编解码、真实设置服务和 loopback TCP；认证中间件使用测试许可，不验证访问控制策略本身。

| 编号 | 级别 | 确认问题 | 主要证据 | 状态 |
| --- | --- | --- | --- | --- |
| ADD-01 | P1 | 图片保存丢失原文件受保护 DACL | 首轮 image-final-audit.log | 未修复 |
| ADD-02 | P2 | 图片保存取消后，IO 未结束即释锁 | 首轮 image-final-audit.log | 未修复 |
| ADD-03 | P2 | MCP 过期依赖阻止当前合法来源读取 | 首轮 mcp-retired-package.log | 未修复 |
| ADD-04 | P2 | 图片保存仍写已失效的低优先级目标，返回成功但不生效 | image-priority-cooperative.log | 未修复 |
| ADD-05 | P2 | 图片保存的前置读取失败绕过安全错误映射，HTTP 带出绝对路径 | image-deep.log、image-http-deep.log | 未修复 |
| ADD-06 | P1 | TUI 迁移将完整配置复制到权限更宽的备份 | tui-deep.log / AUDIT_TUI_BACKUP | 未修复 |
| ADD-07 | P2 | 禁用项目配置仍触发项目文件迁移和改写 | tui-deep.log / AUDIT_TUI_DISABLED | 未修复 |
| ADD-08 | P2 | TUI 目标创建存在检查/写入竞态，覆盖已出现的新配置 | tui-deep.log / AUDIT_TUI_TARGET | 未修复 |

### ADD-04 / P2：图片保存的目标选择过期，成功回包与有效配置不一致

位置：`packages/core/src/image-generation-settings.ts:58`、第 63–79 行。

复现顺序：只有 `opencode.json`，其图片设置为禁用；启动启用保存，在已选择目标但尚未进入文档租约的边界停住。另一个写入者取得 `opencode.jsonc` 的真实文档锁，用 AtomicDocument 发布一个优先级更高、图片设置禁用的配置。随后恢复原保存，读回服务有效设置和两份磁盘文件。

结果：原保存返回 `{ enabled: true, model: "local/image", api: "openai-images" }`，低优先级 JSON 确实写入启用值；紧接着同服务 get 仍返回 `{ enabled: false }`。预期“成功必须与有效值一致，或者明确拒绝过期选择”的断言失败。第二写入者也使用真实文档锁和原子发布，因此不是靠绕过文件锁造出的覆盖。

根因：`read().at(-1)` 只在锁外执行一次。锁内仅重读已选文件，没有复核候选文件集合及获胜来源；不同文件的文档锁无法防止更高优先级候选出现。返回值直接使用提交参数，没有验证最终有效投影。

证据边界：测试闸门放在 withLock 调用入口，模拟目标已选后到真正取锁前的等待窗口；没有宣称实测某一次操作系统锁自然等待了固定时间。未注入配置合并结果或成功返回值。

修复方向：将候选发现、目标决定、锁集合与提交前复检作为同一规则。需要选择锁/候选文档锁的协作次序，并在取得锁后、发布前核对来源布局；已经冻结的目标发生变化时明确冲突，不能悄悄改写另一份文件。单纯把 rename 改成 AtomicDocument 不能修复此项。

验收补项：高优先级文件新增、删除、重建、内容变更；发生在选择前、等待中、锁后复检；成功时返回值/有效 get/磁盘一致，冲突时目标不写。用正常高优先级既有文件作为对照，并验证文件锁顺序无自等待。

### ADD-05 / P2：图片保存前置读取错误会带出服务器文件路径

位置：`packages/core/src/image-generation-settings.ts:58` 和第 81–92 行；`packages/server/src/handlers/image-generation.ts:10`。

复现：在隔离配置目录创建名为 `config.json` 的目录，使文件读取产生真实 EISDIR/BadResource。分别调用 settings.get、settings.update，以及正式 HTTP GET/PUT `/api/settings/image-generation`。

结果：get 返回 `ImageGenerationSettings.Error`，HTTP GET 为 400 且使用固定安全文案；update 返回 `PlatformError`，并非声明的领域错误。正式 HTTP PUT 也是 400，但正文 message 包含 `BadResource: FileSystem.readFile (C:\...\config.json)`，包括本机绝对路径。服务错误类型断言及 HTTP 不含路径断言均失败。没有观察到凭据正文泄漏，不将路径泄漏扩大成密钥泄漏。

根因：选择目标所用的首次 `read()` 在内部 `.pipe(Effect.catch(...))` 之外；末尾类型断言 `as Effect.Effect<..., Error>` 掩盖了实际错误通道。handler 相信服务契约，直接把该错误的 message 作为公开文案。

修复方向：把发现、读取、锁和发布的预期错误在整个服务边界统一映射成固定安全领域错误，并移除掩盖错误通道的断言；保留内部诊断且避免公开拼接原始 cause/path。未知 defect 与中断不能一概伪装为普通参数错误。若最终改变公开错误结构/状态码，才按规范更新协议和正式生成 SDK，不能手改生成物。

验收补项：EISDIR、EACCES/EPERM、EIO，以及文件不存在的正常创建；GET/PUT 服务类型、正式 HTTP 正文都验证，含目录名和假秘密标记的原始错误不得出现在公开响应。测试不能只检查状态码。

### ADD-06 / P1：TUI 自动迁移的备份复制了秘密，却没有保留源文件权限

位置：`packages/opencode/src/config/tui-migrate.ts` 的 `backupAndStripLegacy()`，尤其 `Filesystem.write(backup, source)`。

复现：隔离 `opencode.json` 包含旧 theme 和假 apiKey，DACL 设为受保护、仅当前用户 FullControl。通过真实 TuiConfig 服务加载触发迁移，读取源文件和 `.tui-migration.bak` 的 DACL 与内容。

结果：源配置经过 AtomicDocument 替换后仍保留原 DACL；备份包含完整原配置（含假 apiKey），却是继承父目录的宽 DACL。`fullSourceCopied: true`、`sourceAclPreserved: true`，而备份权限相等断言失败。实测是文件权限放宽，没有让其他主体实际读取文件。此项与 ADD-01 是不同入口，不能仅修图片设置就关闭。

根因：共享原子替换只覆盖了源配置的剥离；备份仍通过普通 write 创建。备份是完整配置副本，其敏感性没有因为后缀 `.bak` 降低。Windows mode 参数不足以保留 DACL；当前调用也未指定 mode。

修复方向：将备份纳入同一敏感文档生命周期：写入第一字节之前就应用来源安全描述符，并以独占/不可覆盖方式发布；POSIX 保留应有 owner/group/mode。不能直接调用“新建目标默认权限”的 AtomicDocument.publish 就认为已复制来源权限，需要显式的来源元数据规则。既有备份要核对身份和对应源版本，不可仅凭存在就认定备份完成；本轮未验证既有备份损坏分支，不另立已确认编号。

验收补项：完整含假密钥配置的真实 Windows DACL，以及 POSIX mode/owner/group；备份暂存、发布完成、失败清理三个阶段均不得放宽；不能只测最终源文件 ACL。旧备份存在与创建竞争需要保持原字节。

### ADD-07 / P2：禁用项目配置时，TUI 加载仍修改项目配置

位置：`packages/opencode/src/config/tui.ts` 的 loadState 调用顺序；`packages/opencode/src/config/tui-migrate.ts` 的 opencodeFiles 无条件 `Filesystem.findUp(...)`。

复现：设置 `OPENCODE_DISABLE_PROJECT_CONFIG=true`，隔离项目根仅有 `{"theme":"dark","username":"before"}`；通过真实 TuiConfig 服务 get 加载。

结果：虽然项目配置读取列表随后被禁用，迁移已先执行：原文件 theme 被剥离，额外产生 `tui.json` 和完整备份。原字节保持和“没有新增业务文件”的要求失败。这不只是多读了一份文件，而是产生持久写入。

根因：ConfigPaths.directories 已尊重禁用开关，但迁移又单独向上寻找根 JSON/JSONC，不受该开关限制；loadState 在按禁用条件选择项目 tui 文件之前运行迁移。发现规则再次分叉。

修复方向：让迁移使用有明确来源种类的统一发现结果，禁用普通项目来源时，不得读取或迁移这些来源。保留显式 OPENCODE_CONFIG、OPENCODE_CONFIG_DIR、home/global 等原本允许的来源规则，不能把禁用开关简单解释为禁止所有配置。需核对祖先项目和 `.opencode` 的归属。

验收补项：开关开/关、项目根/祖先/.opencode、显式外部文件、全局/home 配置组合；同时断言读取结果、原文件字节、备份/tui 文件是否出现，避免仅检查最终主题值。

### ADD-08 / P2：TUI 迁移目标创建不是原子“仅当不存在”，会覆盖新文件

位置：`packages/opencode/src/config/tui-migrate.ts` 中 `targetExists` 检查与后续 `Filesystem.write(target, ...)`。

复现：通过真实 TuiConfig 加载，在迁移已判断 tui.json 不存在、即将调用 Filesystem.write 的边界，用独占 `wx` 创建用户的新 tui.json，主题为 `new-user-setting`；然后放行迁移的原始 write。

结果：迁移覆盖新文件，主题变成 `legacy-setting`，且继续剥离旧配置。注入只控制竞争者创建文件的时点，真实读写与迁移逻辑不替换；`injected: true` 后“保留新文件”断言失败。此样本是一个受控创建竞争，不冒充完整双进程压力测试。

根因：锁只属于源 opencode 文件；目标的 exists + 普通截断写之间有窗口。不同源文件（JSON/JSONC）或外部编辑器不受这把源锁共同保护。即使追加目标锁，已有非协作写入者仍要求使用操作系统原子 no-replace，不能再次用 exists 判断替代。

修复方向：以临时文件加原子 no-replace 发布目标；目标已出现时退出/冲突，保留用户文件且不剥离源配置。源、目标与备份的锁如需组合，先统一排序与作用域；禁止在不同调用路径产生反向锁序。处理“目标已发布、备份/剥离失败”时的重试责任，不能仅看目标存在就永远跳过未完成收尾。

验收补项：目标在检查前/检查后出现、两种源同时迁移、目标发布失败、源剥离失败、重复启动；核对用户目标、源文件、备份三份字节和权限。若沿用 AtomicDocument，明确 before=undefined 的 no-replace 分支及失败后不剥离。

## 5. 第二轮验证账本与修复依赖

| 执行 | 结果 | 解释 |
| --- | --- | --- |
| Core image-deep.test.ts 两场景 | 0 pass、2 fail | 目标过期及前置读取错误都复现 |
| Core 目标竞争补强（合作写入者持文档锁并原子发布） | 0 pass、1 fail | 补强 ADD-04，不新增缺陷数 |
| Server image-http-deep.test.ts | 0 pass、1 fail | ADD-05 正式 HTTP 路径复现，GET 为安全文案对照 |
| OpenCode tui-deep.test.ts 三场景 | 0 pass、3 fail | 备份权限、禁用规则、目标竞争分别复现 |

本轮 7 次失败执行对应 5 个新增缺陷；同一问题的服务与 HTTP 验证不重复编号。没有为文档修改运行无关全套类型检查。临时脚本、原日志和摘要保留，失败未被重新标为通过。

建议按以下修复单元实施，每单元保持独立红测与实际入口验收：

1. **图片文档提交**：ADD-01/02/04 一起定义目标选择、租约范围、发布、确认与清理责任；ADD-05 在完整服务/HTTP 边界收口。只共用文件锁或只替换 rename 均不足以覆盖四项。
2. **MCP 来源快照**：ADD-03 单独处理依赖过期，并保留必要继承来源拒读保护，不与图片修复交叉修改。
3. **TUI 多文件迁移**：ADD-06/07/08 共同检查来源资格、敏感备份、目标 no-replace 和源剥离的顺序与恢复；必须记录每一阶段已落盘对象，保留既有备份策略，不能直接删除历史备份。
4. 固定修改后候选，按入口回归 Windows 和适用 Linux 场景，再核对上轮 LNX 门禁。macOS、Linux 原生模块、安装包和真实迁移仍按原验收状态管理。

本次发现的共同原因是共享规则只接到了部分阶段：文档锁没有自动提供来源选择的一致性、文件权限保留或异步取消收尾；源文件安全替换也没有自动保护备份和迁移目标。后续盘点应按一个动作的“发现→选择→锁→读取→发布每个对象→确认→刷新/清理”逐阶段登记，而不是以“已调用共享函数”作为完成证据。

第二轮测试前后源码及暂存内容一致。交付仅完善本记录，见 `manifest-delivery.json`。本轮创建的隔离根已按登记路径核验并清理，未删除日志/脚本；详情见 `cleanup.json`。没有提交、推送、重启用户应用或改写生产配置。截至第二轮确认 8 项；第三轮新增证据见第 6 节。以上不能作为项目不存在其他问题的证明。

## 6. 第三轮：MCP 提交投影与刷新完成顺序（2026-11-15）

本轮继续检查，未修改产品实现或仓库测试。输入快照与第二轮交付一致；`manifest-before.json`、`manifest-tested.json` 均显示源码、原有未提交文件和暂存语义未变化，HEAD 未变。所有测试仍在 `packages/opencode` 目录经导入前隔离执行。

证据根：`C:\Users\zh2100\AppData\Local\Temp\opencode-chain-audit-6cd39dac442b43108dcdbac588a7f078`。

| 编号 | 级别 | 确认问题 | 状态 |
| --- | --- | --- | --- |
| ADD-09 | P2 | MCP 继承条目只改 URL/command 时返回成功，但有效配置仍使用旧值 | 未修复 |
| ADD-10 | P2 | 新一代幂等刷新先成功，旧一代后失败时仍留下未恢复责任 | 未修复 |

ADD-01～08 保持前两轮结论，本轮没有重新跑这些用例，也没有宣告它们已修复。截至第三轮累计 10 项；以下两个场景的多次执行不重复增加编号。

### ADD-09 / P2：MCP 分片保存被解析成 enabled-only，来源页面与有效配置不一致

代码位置：

- `packages/app/src/components/settings-v2/dialog-mcp-v2.tsx:260–264`：仅修改 URL/命令时提交对应字段，只有切换类型才提交 type。
- `packages/opencode/src/config/config.ts:1291–1323`：在获胜文件原条目上合并补丁；单文件校验通过即可发布。
- `packages/core/src/v1/config/config.ts:115–117`：MCP 条目允许完整连接配置，或仅含 enabled 的分支。
- `packages/opencode/src/config/parse.ts:35–44`：解析忽略多余字段。
- `packages/opencode/src/config/config.ts:1256`：来源接口将原文链合并后再按完整条目解析。

复现前置：根 `opencode.json` 提供完整连接信息；更高优先级 `.opencode/opencode.json` 只包含 `sample: { enabled: false }`。关闭连接是为了避免测试执行命令或访问网络，不影响配置解析路径。

远程场景提交 `{ url: "https://new.example/mcp" }`，本地场景提交 `{ command: ["new-command", "new-arg"] }`。均通过真实 `Config.mcpSource` 获取 source/version，再调用真实 `Config.updateMcp`。等待配置 handoff 排空，并通过 `provideInstanceEffect` 重新建立实例后读有效配置。

两种场景都出现同一结果：

| 观察对象 | 远程 URL | 本地命令 |
| --- | --- | --- |
| updateMcp 结果 | 成功 | 成功 |
| 获胜文件磁盘字节 | new.example | new-command / new-arg |
| mcpSource 编辑来源 | new.example | new-command / new-arg |
| 重建实例后的 config.get | **old.example** | **old-command / old-arg** |

主证据 `mcp-partial.log`：0 pass、2 fail、退出码 1；两次失败均为“有效配置应包含本次补丁”的断言。假 URL 没有被访问，假命令没有被执行。并未实测 UI 点击或连接过程，不把配置服务结果称为界面验收。

根因是三条路径使用了不同的配置语义：保存校验和主加载器先校验每份文件，缺 type 的 `{ enabled: false, url/command: ... }` 会被 enabled-only 分支接纳，并静默丢弃 url/command；主加载器随后合并，保留低优先级旧值。来源接口却先合并原文，因此能显示新值。仅刷新缓存或重建实例不能解决。

对照证据 `mcp-typed-control.log`：只给相同请求增加匹配的 type，远程与本地两项均通过（2 pass、0 fail、退出码 0），磁盘、来源接口、有效配置一致。该对照用于定位，没有改产品使原失败用例变绿。

修复方向与实施边界：

1. 先统一“文件覆盖片段”与“合并后完整条目”的校验规则。当前 API 接受 URL/command 的部分补丁，不能返回成功却让加载器丢弃字段。
2. 若维持逐文件完整连接 schema，应在缺失 discriminator 时根据已核验的有效来源补入必要 type，并与本次 URL/command 补丁一起验证。对照证明该方向覆盖本次两种情况；不能将此对照直接当成所有继承组合已修复。另一种方向是正式支持部分覆盖 schema，但需同步加载、编辑来源、版本检查与兼容层，不能只放宽保存校验。
3. 校验提交后的有效投影确实接纳本次修改。投影预检失败应在落盘前明确失败；不得先写入再靠刷新掩盖不生效。
4. 仍只写本次必要修改与 schema 所需的类型信息，不把未编辑的继承 headers、env、凭据引用展开后复制到项目文件。类型切换继续删除本文件中的不兼容字段，并验证继承层不会重新引入错误含义。
5. 补 remote/local、enabled true/false、type 缺失/已有、V1/V2、JSON/JSONC、继承凭据引用及来源冲突矩阵。检查 HTTP/服务结果、磁盘、mcpSource、重新建立实例后的 get，最后补真实编辑弹窗验收。

首次脚本在保存后仍使用已销毁实例，报 `Stale instance context`。这是夹具错误，已保留为 `mcp-partial-fixture-error.log`，不计产品缺陷；修正为项目现有实例重建方式后才得到上述有效失败。

### ADD-10 / P2：刷新恢复只扫描当时已失败记录，遗漏晚到的旧失败

代码位置：`packages/opencode/src/config/refresh.ts:53–56, 87–111`；实际配置提交在 `packages/opencode/src/config/config.ts:1066–1090` 使用该管理器。退出排空检查在 `packages/opencode/src/effect/instance-work.ts:133–140`。

受控顺序：

1. 对同一个 owner 对象、同一个 step id 登记旧一代刷新，标记为 retryable；用明确的 Promise 信号确认它已进入步骤，再将其挂起。
2. 登记新一代同身份刷新，成功完成同一幂等步骤。
3. 放开旧步骤，它在执行副作用之前失败；重试也失败。
4. 检查刷新责任及 handoff 诊断。对照交换完成顺序：先让旧失败落定，再执行新成功。

结果：乱序场景出现 `refreshed: 1`、`attempts: 2`，但 `pending: 1`、failed 一条、`unrecoveredAdded: 1`。反向顺序为 pending 0。首次样本未额外恢复该记录时，测试运行时排空也实际返回 `Configuration refresh remains incomplete`。

根因：新成功仅清除扫描时 `previous.state === "failed"` 的旧记录。尚在 running/backoff 的记录未被覆盖；成功代次随后被移除，没有留下足够的完成水位。当旧记录稍后转为 failed 时，也没有回看已完成的新一代。于是相同动作仅因回包顺序不同，产生不同的恢复结论。

证据：

- `refresh-late-shutdown.log`：1 pass、2 fail、退出码 1。其中一个是目标断言失败，另一个是未恢复责任引发的运行时排空失败；不是两个独立缺陷。
- `refresh-late.log`：保留相同失败断言，finally 中再运行第三次同身份成功刷新以清理夹具责任，1 pass、1 fail、退出码 1。清理后 `pending: 0, failed: []`，运行时正常排空。反向顺序对照通过。

证据边界：这里调用的是产品 ConfigRefresh 与 InstanceWork 的真实实现，步骤函数是受控的无副作用失败/成功适配器，没有注入管理器结果。已证明责任记账与排空的时序缺口；没有声称真实页面点击或真实双 HTTP 保存已复现，也没有声称磁盘丢数据、已经达到容量上限或所有幂等操作都能无条件互相覆盖。

修复方向与实施边界：

1. 给同 owner、同 step 建立有界的成功完成水位/覆盖凭据；旧任务落定时也检查是否已有足以覆盖它的新成功，不能只在新成功瞬间扫描 failed。
2. 正在运行的旧任务仍必须排空，不能因为新成功就提前释责、取消 IO 或减少活动计数。覆盖责任与终止任务是两件事。
3. 只覆盖可证明具备相同有效投影和幂等/覆盖语义的步骤。跨 owner、不同 step、非幂等动作仍保留原失败；若旧执行可能在新成功后重新改变状态，需串行化或引入更强的版本检查，不能只删除失败记录。
4. 某一批的所有步骤完成或被合法覆盖后，才恢复该批 handoff；历史失败计数仍保留。水位和记录回收必须继续满足有界内存/容量规则。
5. 回归至少覆盖旧失败先/后、新成功先/后、backoff、before 阶段失败、多步骤部分覆盖、跨 owner/step、关闭中排空、非幂等失败，以及真实同实例两次提交路径。断言 pending、unrecovered、historicalFailures 和 drain 的一致性。

## 7. 第三轮交付与后续顺序

| 验证 | 有效结果 |
| --- | --- |
| MCP 不带 type 的实际部分更新 | 0 pass、2 fail，退出码 1 |
| 同样输入增加 type 的定位对照 | 2 pass、0 fail，退出码 0 |
| 刷新乱序及反向顺序对照（带夹具责任收尾） | 1 pass、1 fail，退出码 1 |

有效主样本共 3 条缺陷断言失败、3 条对照通过，对应两个新增缺陷。首次夹具错误及首次排空附带错误分别保留，不并入主样本计数。没有为文档修改运行无关全套类型检查。

后续 MCP 修复单元应把 ADD-03 与 ADD-09 一起核对：前者解决当前来源依赖，后者解决同一来源在保存、编辑读取和运行时加载中的语义差异。单纯清缓存无法修复 ADD-09。ADD-10 单独处理刷新责任，不用更改磁盘提交结果或吞掉全部 handoff 错误来掩盖它。图片提交、TUI 迁移及原有跨平台门禁仍按前文依赖推进。

本轮交付只追加和整理这份记录。证据根保留脚本、日志、文件摘要及清理清单；`manifest-delivery.json` 用于确认除本记录外没有文件变化。没有提交、推送、重启应用、写生产配置或切换锁协议。真实界面、跨平台和其他历史未验项保持原状态；本轮结果不代表已穷尽项目缺陷。
## 8. 第四轮：迁移优先级、部分发布与源权限（2026-11-15）

本轮在第三轮交付快照上继续检查，未修改产品实现或仓库测试。`manifest-before.json`、`manifest-tested.json` 显示工作区文件与输入快照一致，暂存语义未变化，HEAD 仍为 `6b051f12a21094df1adef83f9fddfcbb765b319e`。所有执行从 `packages/opencode` 发出，经 `script/test-isolated.mjs` 在产品导入前隔离。

证据根：`C:\Users\zh2100\AppData\Local\Temp\opencode-migration-audit-5cb0d29ce88a41e3a869971a19bbfd35`。

| 编号 | 级别 | 确认问题 | 状态 |
| --- | --- | --- | --- |
| ADD-11 | P2 | 同目录 JSON 与 JSONC 的 TUI 迁移选择低优先级设置，高优先级字段不生效 | 未修复 |
| ADD-12 | P2 | TUI 目标部分写入失败后留下损坏文件，后续加载永久跳过自动迁移，直至外部介入 | 未修复 |
| ADD-13 | P1 | 旧 TOML 配置迁移到新 JSON 时，敏感内容没有继承源文件的受限权限 | 未修复 |

ADD-01～10 保持原结论，本轮未重跑或关闭这些条目。以下是三个新触发场景，与已有问题的共享修复依赖另列；不按复现次数增加缺陷数。

### ADD-11 / P2：同目录两个旧配置迁移时，先写入的低优先级文件排除了高优先级文件

位置：`packages/opencode/src/config/tui-migrate.ts:37, 67–69, 132–138`；正常加载优先级参见 `packages/opencode/src/config/paths.ts` 的 `fileInDirectory()` 与 `files()`。

复现仅使用实际文件和真实 TuiConfig 加载，没有注入竞争或文件服务：

1. 在隔离项目的 `opencode.json` 写入 `theme: "json-low"` 和 `tui.scroll_speed: 3`。
2. 同目录 `opencode.jsonc` 写入 `theme: "jsonc-high"` 和 `tui.diff_style: "stacked"`。
3. 首次 TUI 加载触发自动迁移，读取返回配置及两份源文件、新 `tui.json`。

结果：实际主题为 **json-low**，scroll_speed 为 3，diff_style 未提供。新 `tui.json` 只有低优先级来源的字段；JSON 源已被剥离，JSONC 源仍保留原文，但其设置没有参与新 TUI 配置。该问题在没有并发时也会发生。

对照把相同语义分别放入 `tui.json` 和 `tui.jsonc`：真实加载得到 jsonc-high、scroll_speed 3、diff_style stacked，三个断言通过。因此目标要求是保持既有配置优先级和继承字段，而非自行设定一种新优先级。

根因：迁移按 JSON 后 JSONC 顺序遍历，两者却都映射到同一个 `tui.json`。JSON 首先发布目标，处理 JSONC 时看到目标已存在便退出；正常加载的“后者覆盖前者”在迁移中被变成“第一个成功创建者独占目标”。仅把 exists/write 换为原子 no-replace 仍不能解决优先级问题。

证据：`tui-recovery.log` 的 `AUDIT_TUI_PRIORITY` 及同文件对照。主题断言失败；diff_style 缺失另由观测记录确认。源文件高优先级内容没有被删除，不能表述为该源文件已丢失。

修复与验收要求：

- 先按迁移目标归组，完整发现该目标的所有合格来源，并按主加载器顺序计算有效 TUI 投影；不能遍历到一份就立即占用目标。反过来只迁移 JSONC 也不够，会丢掉它未覆盖的 JSON 字段。
- 选择保持分层的独立目标，或生成一次正确合并的目标，并明确对应的来源版本、备份、锁排序和提交责任。发布前重新核对来源集合；新增/删除/变更来源时不得静默使用旧投影。
- 用户已有目标仍须保护，不能为了重新合并而覆盖现有 tui 配置。成功发布且确认备份后才剥离各份源，不因第一份处理成功就忽略其他来源。
- 覆盖 JSON-only、JSONC-only、两者共存、覆盖字段/互补字段、JSONC 注释、global/project/.opencode、源锁占用和多源变更。检查有效 get、目标字节、每份源及备份，而非只断言目标存在。

此项与 ADD-08 不同：ADD-08 是目标创建竞争覆盖，ADD-11 是无竞争时就存在的来源合并错误；两者应放进同一个多文件迁移方案，但需要不同回归。

### ADD-12 / P2：目标截断写失败留下损坏文件，存在性检查阻止恢复

位置：`packages/opencode/src/config/tui-migrate.ts:67–86`；`packages/opencode/src/config/tui.ts` 在迁移之后加载新 tui 配置，并在解析失败时记录日志、跳过文件。

受控复现：旧源包含 `theme: "legacy-survivor"`。仅在 `Filesystem.write(target, ...)` 边界模拟一次部分写入：真实创建目标并写入 `{"theme":`，随后抛出 EIO。恢复原始 write 实现，再建立新的 TuiConfig 服务进行第二次加载。

结果：第一次写入失败后，源文件字节完整保留，目标却留下损坏 JSON；第二次加载时目标仍为同一损坏字节，旧源仍完整，返回配置的 theme 是 undefined。错误日志显示两次均跳过无效 `tui.json`。第二次没有再触发受控错误，仍不能恢复旧设置。

证据：`tui-recovery.log` 的 `AUDIT_TUI_PARTIAL`。三个前置事实分别通过真实文件检查和 injected 标志确认，最终“恢复原写入实现后，应可再次获得旧主题”的断言失败。模拟的是真实 IO 允许出现的“部分写入后失败”边界，没有声称本机磁盘实际满或真实断电。

根因：目标采用直接写入而非完整临时文件发布。失败分支只返回，不处理已经创建的半成品，也没有记录对象身份；下次启动只看目标存在就视为无需迁移。与“用户已有完整配置”相同的分支吞掉了迁移自己的失败产物。

修复与验收要求：

- 新迁移先在受控临时文件完整写入、校验和排空 IO，再原子 no-replace 发布；正常目标路径不能出现半份 JSON。与 ADD-08 共用目标发布规则。
- 记录本次创建对象的身份和阶段。失败清理只能触及本次拥有的对象；取消时等已投递写入结束，不能让清理与迟到写入竞争。
- 对历史损坏目标不能直接“解析失败就删掉重试”，否则可能删除用户自己的文件。仅在所有权和版本可证实时自动修复；无法确认时保留文件、明确提示恢复方式，可定义安全的旧配置读取回退。
- 补零字节/部分字节、写入/同步/关闭/发布失败、取消、再次加载、目标被用户替换、合法预存目标等场景。断言目标始终是原合法版本或新完整版本；源在目标未确认前不剥离。
- 目标已完整发布、备份或源剥离随后失败的恢复仍属于多阶段迁移验收项。本轮没有把该尚未执行的另一分支标为已复现。

### ADD-13 / P1：旧 TOML 迁移新建 JSON 时丢失源权限约束

位置：`packages/opencode/src/config/config.ts:590–617`，尤其第 609 行；共享发布器 `packages/core/src/config/atomic-document.ts:64, 71–80`。

隔离复现：在本轮独立全局配置目录创建旧格式 `config` TOML，包含普通 username 和 MCP headers 中的假凭据 `fake-legacy-private-marker`，连接关闭。用真实 NTFS ACL 将源设为受保护 DACL、仅当前用户 FullControl。目标 `config.json` 尚不存在。调用真实 Config 服务的 invalidate/get 触发迁移，读取新目标内容和 ACL。

结果：新 JSON 包含完整假凭据，生效的 username 为 legacy-audit；源权限描述为 `D:PAI(...)`，目标变为继承父目录的 `D:AI(...)`，包含其他主体的访问规则。权限保持断言失败。没有对其他主体执行读取，也没有使用真实凭据或发起远程连接；确认的是权限放宽，不是已发生凭据外泄。

对照先创建 `config.json`，将源和目标都设为相同受限 DACL，再执行相同迁移。新内容正确，目标 DACL 保持，1 项通过。由此区分：现有目标的原子替换权限保护有效，而“把内容从另一个文件迁到新文件”的源权限没有纳入接口。

根因：迁移调用 publish 时只传目标路径、旧目标字节和新文本，没有传来源安全元数据。AtomicDocument 的权限分支只在目标 `previous` 存在时复制目标 ACL/owner/mode；新建分支采用默认文件权限。迁移内容来自受限源文件，但“目标是新文件”并不代表内容可以采用父目录更宽权限。

证据：`legacy-acl.log`，0 pass、1 fail、退出码 1，`copiedPrivateMarker: true`；`legacy-acl-control.log`，1 pass、0 fail、退出码 0。ACL 是本机真实读写结果，没有模拟权限 API。运行结束后框架清理了 per-process test-data 目录，`legacy-post-run.json` 中的文件缺失观察明确标记为不可用于证明源退役；本结论使用清理前测试体内的内容/ACL 证据。

修复与验收要求：

1. 为跨文件迁移定义来源安全元数据的传递规则；在目标临时文件写入第一字节之前应用相应保护。不能只在发布之后 chmod/补 ACL，也不能以 Windows 的 mode 600 代替 DACL。
2. 新目标应保留源的安全约束。目标已存在时明确源与目标权限如何兼容，避免把更敏感的源内容并入更宽的既有目标；不能不经设计就覆盖用户全部权限规则。
3. 元数据复制失败须在内容发布前失败并安全清理；没有确认目标内容与权限之前，旧源不得退役。读取元数据、发布与源退役应关联同一份源身份/版本，避免读取了另一代的 ACL。
4. 扩展共享发布能力时，保持原有“普通同文件替换保留目标权限”行为；图片设置 ADD-01、TUI 备份 ADD-06 和旧 TOML 迁移分别有真实入口回归，不以共享函数单测代替。
5. 覆盖 Windows 受保护 DACL、继承规则、目标缺失/已有、元数据操作失败以及暂存阶段权限；Linux/macOS 补 owner/group/mode 的实际入口测试。本轮只验证 Windows，不能声明其他平台已经失败或通过。

此项是独立于 ADD-06 的生产迁移入口：ADD-06 为 TUI 备份普通写入，ADD-13 为旧 TOML 内容经过 AtomicDocument 新建 JSON。只把所有写入替换成 AtomicDocument，并不能自动关闭 ADD-13。

## 9. 第四轮验证账本与交付范围

| 执行 | 结果 | 说明 |
| --- | --- | --- |
| TUI 迁移优先级、部分目标恢复、原生格式优先级对照 | 1 pass、2 fail，退出码 1 | 两个新增缺陷的主证据 |
| 旧 TOML → 新 JSON 的受限 ACL | 0 pass、1 fail，退出码 1 | ADD-13 主证据 |
| 旧 TOML → 已有受限 JSON 的对照 | 1 pass、0 fail，退出码 0 | 现有目标权限保护有效 |

有效主样本共 3 条缺陷断言失败、2 条对照通过，对应三个新增缺陷。第一次 TUI 执行还有一条运行时 afterAll 超时，记录为 `tui-recovery-shutdown-timeout.log`；没有将它另计产品缺陷。仅将框架期限从 30 秒改为 60 秒，脚本和产品断言原样重跑，退出收尾成功，两个目标断言仍失败。没有通过修改断言或产品实现让失败变绿。

本轮进一步说明：迁移需要同时保持有效设置、文件完整性、来源权限及恢复责任。“目标存在”“已经使用原子发布”都不足以证明迁移正确。建议 TUI 的 ADD-06/07/08/11/12 作为一个多来源、多文件迁移单元设计；来源权限能力与 ADD-13 共享，但各入口分别验收。已确认的 P1 权限问题优先处理。

交付仅完善本记录；全部产品文件、原有未提交改动和暂存内容保持输入状态，最终差异由 `manifest-delivery.json` 核对。临时隔离根按登记清单核验后清理，日志、脚本及摘要保留。没有修改生产配置、重启用户应用、提交或推送。真实界面、历史锁迁移和跨平台待验项保持原状态，不能由本轮小范围复现推断整个项目不存在其他缺陷。
## 10. 第五轮：读取与可选迁移解耦、引用转义、全局目标一致性（2026-11-15）

输入为第四轮交付后的同一工作区。`manifest-before.json`、`manifest-tested.json` 显示源码、原有未提交文件及暂存语义与输入一致，HEAD 未变。所有测试仍从 `packages/opencode` 执行，经 `script/test-isolated.mjs` 在产品模块导入前建立独立 home/data/config/state/cache/tmp；无远程模型、真实凭据或生产数据操作。

证据根：`C:\Users\zh2100\AppData\Local\Temp\opencode-load-audit-67128e604ed2485f92e052f3abc7e3ea`。

| 编号 | 级别 | 确认问题 | 状态 |
| --- | --- | --- | --- |
| ADD-14 | P2 | 可选旧配置迁移拿不到目标锁时，合法旧设置从读取结果中消失并被缓存 | 未修复 |
| ADD-15 | P2 | 环境变量插入 JSON 字符串未转义，反斜杠被误解析、引号破坏配置 | 未修复 |
| ADD-16 | P2 | 全局保存选定目标后出现高优先级文件，仍返回成功但有效值不变 | 未修复 |

ADD-01～13 保持原状态。本轮三个编号对应三个独立入口或语义缺口，不把重复执行或同一问题的多个输入计为不同缺陷。

### ADD-14 / P2：跳过可选迁移时，也错误跳过了旧配置读取

位置：`packages/opencode/src/config/config.ts:547, 583–610, 624–636`；可选锁跳过分支在 `packages/core/src/config/document.ts:64`。

真实复现，没有注入文件或锁结果：

1. 在隔离全局目录创建旧 `config` TOML，内容为 username=legacy-lock-audit、provider=local、model=chat；`config.json` 尚不存在。
2. 获取目标 `config.json` 对应的真实 EffectFlock 文档租约，调用 `Config.getGlobal()`。
3. 验证旧文件原字节仍在、目标未创建；结束持锁作用域。
4. 再读取一次，随后显式 invalidate，再读第三次。

结果：持锁时返回值只含 schema 等字段，缺失 username/model；释放锁后的第二次读取仍是同一错误缓存。显式 invalidate 后，读取恢复 username=legacy-lock-audit、model=local/chat。`legacy-lock.log` 为 0 pass、1 fail、退出码 1；释放锁并失效缓存后的正确值是同用例内通过的对照断言。

根因：`canWrite` 表示允许执行加载器写入，并不表示实际成功取得锁或迁移成功。但旧配置只在 `!canWrite` 时无条件并入；`canWrite` 为 true 时，合并 defaults 位于 optionalWrite 的锁内。tryAcquire 返回 false 即跳过整个分支，于是读取遗漏合法旧配置。cachedGlobal 又以无限 TTL 缓存这个成功但不完整的结果，锁释放不会自动重算。

影响是读配置依赖了可选写入的成败，可能使已有模型等设置暂时甚至持续不可见。没有观察到旧文件被删除或覆盖，不将此项表述为磁盘数据丢失。

修复与验收要求：

- 将旧来源读取、解析、按优先级合并与可选迁移发布分开。允许迁移但暂时无法发布时，读取仍应使用已核验的合法源；不能把 tryAcquire false 当成源不存在。
- 写入租约内依然重读源、目标并核对身份/版本，不为了修复读取而把锁外旧快照直接写入磁盘。迁移完成后保持与当前目标优先级一致。
- 明确源读取失败、语法损坏与迁移写入失败的不同错误策略。合法配置不能因为可选发布失败而静默退回空配置。
- 测试锁空闲/被占用、目标缺失/已有、只读加载器模式、迁移失败、锁释放后重复读取与失效缓存。对每条场景同时检查读取值、源/目标字节和是否发生可选写入。

既有 `atomic-entry.test.ts` 的 I66 已检查“持锁时不写目标、保留旧源”，但没有检查 getGlobal 的返回设置。这正是当前回归漏掉的维度。此项与 ADD-13 的迁移权限问题不同，只修权限不能恢复被跳过的读取。

### ADD-15 / P2：环境变量替换缺少 JSON 字符串转义，导致配置值变形或解析失败

位置：`packages/opencode/src/config/variable.ts:38–42`；文件引用的转义对照在第 89 行。

真实服务复现：项目配置写入 `shell: "{env:OPENCODE_AUDIT_STRING}"`，经真实 Config.invalidate/get 加载。仅设置隔离测试变量，不执行 shell，也不修改用户实际环境设置。

| 变量值 | 环境引用结果 | 相同字节的文件引用对照 |
| --- | --- | --- |
| `C:\tools\new.exe` | 加载成功，但两个反斜杠被解析为 TAB 与 LF，shell 内容不等于原值 | 原值完整保留 |
| `fake-"quoted"-value` | 加载失败，插入的引号破坏 JSON 字符串 | 原值完整保留 |

证据：`env-string.log`，2 pass、2 fail、退出码 1。`AUDIT_STRING_REFERENCE` 记录输入、结果类型和实际 shell；成功但损坏的路径与直接解析失败分别有断言。两条 file 场景调用同一 Config 加载入口，仅替换引用方式，均通过。没有把 shell 执行失败或秘密外泄作为本轮已发生事实。

根因：环境变量在 JSON 解析前直接 `replace` 插入原文。原变量中的反斜杠被二次解释为 JSON 转义；引号等字符会改变文档语法。文件引用则已有 JSON.stringify 字符串转义，两类引用的语义不一致。普通字母数字变量的既有测试无法覆盖此问题。

修复与验收要求：

1. 明确替换上下文：JSON/JSONC 字符串中的引用必须保持原值的字符语义。包括完整字符串引用，以及 `Bearer {env:TOKEN}` 这类字符串片段；不能把原值预先修改成另一串字符再要求用户手工补转义。
2. 不要直接把整个替换函数统一改成 JSON.stringify：同一 helper 还用于非 JSON 的远程 URL、header 文本；如果仍支持字符串外的结构化占位符，应明确类型和校验规则。区分普通文本、JSON 字符串及受支持的结构位置，不能混用一种转义。
3. 保留原文引用落盘、不写入展开凭据的既有规则。错误诊断不得借修复之机公开完整展开文档或秘密值。
4. 补引号、单/多反斜杠、TAB/LF/CR、Unicode、空值、变量缺失、字符串片段及 JSONC 注释场景；对照 file 引用和普通文本 URL/header，覆盖主配置、TUI 与来源编辑路径使用的替换模式。
5. 通过真实 get 校验最终字符串逐字符相等；不能仅检查 JSON 能解析、字符串非空或磁盘仍有占位符。

本轮只确认 JSON 字符串上下文的两种输入。字符串外占位符、HTTP 响应脱敏和真实 shell 启动属于后续修复验收，不算本轮已执行项。

### ADD-16 / P2：全局配置保存缺少目标布局复检，成功结果与有效配置不一致

位置：`packages/opencode/src/config/config.ts:364–372, 1100–1138`；正式入口接线在 `packages/opencode/src/server/routes/instance/httpapi/handlers/global.ts:81–84`，该 handler 返回 result.info。

受控复现：隔离全局目录最初只有 `opencode.json`，username=before。调用 updateGlobal({ username: "after" })，在全局文件已经选定、文档租约即将获取的边界，通过另一条真实 ConfigDocument 租约和 AtomicDocument.publish 创建高优先级 `opencode.jsonc`，username=higher-priority；随后继续原保存。

等待配置刷新 handoff 排空，重建实例，再读取 getGlobal。结果：

- 保存返回 `changed: true`、`info.username: "after"`。
- 低优先级 JSON 确实写入 after；新 JSONC 保持 higher-priority。
- 有效 getGlobal 的 username 为 **higher-priority**，没有接纳本次修改。

对照让 JSONC 在保存开始前就存在：选中的目标是 JSONC，返回、磁盘和有效值均为 after；注入边界没有触发。主场景 `global-target.log` 0 pass、1 fail、退出码 1；对照 `global-target-control.log` 1 pass、0 fail、退出码 0。

根因：globalConfigFile 在锁外只选择一次，锁内只重读所选文件。文档锁保护该文件内容，却不保护候选集合或获胜来源。返回值是所选文件解码后的 next，不是经当前全局来源合并后核验的有效值。项目更新已有的来源布局/有效投影检查没有覆盖全局入口。

证据边界：时间窗口由文档锁入口的受控拦截建立，第二写入者也取得真实文档锁并使用共享原子发布。没有伪造配置返回值或绕过锁直接覆盖目标。复现通过真实 Config 服务，HTTP handler 仅做静态接线核对，没有把它记成完整 HTTP/UI 验收。

首次脚本在保存后使用旧实例，报 Instance is closing；保留于 `global-target-fixture-error.log`，不计产品缺陷。修正为等待 handoff 并重新提供实例后，才得到上述有效结果。

修复与验收要求：

- 为全局候选集合建立一致的选择与提交协议，包括 `config.json`、`opencode.json`、`opencode.jsonc`；取得租约后、发布前复核来源布局及必要输入。只增加当前文件锁或换成原子写入均不足够。
- 统一候选选择锁和文档锁的顺序，并让全局写入、图片设置及会创建候选文件的加载器操作遵循兼容规则；遇到冻结目标变化应明确冲突，或按有界重试重新选择，不能悄悄在过期目标上返回成功。
- 提交前验证全局有效投影会接纳补丁。区分正常项目覆盖全局设置与“同一全局层内已被更高优先级文件覆盖”，本条针对后者，不要求全局值覆盖所有项目设置。
- 验收候选文件新增/删除/重建/更新、锁等待、取消和正常已有高优先级文件；通过正式 HTTP 再比对响应、磁盘、getGlobal 和界面。公开错误若需变更，更新协议并正式生成 SDK。

ADD-04 是图片设置入口，ADD-16 是 Config.updateGlobal。两者有相同的选择一致性根因，应共享规则和修复设计，但修复其中一个不能关闭另一个。

## 11. 第五轮验证账本与交付范围

| 验证 | 结果 |
| --- | --- |
| 旧配置迁移锁竞争及释放/失效后的对照断言 | 0 pass、1 fail，退出码 1 |
| 环境字符串引用与文件引用对照 | 2 pass、2 fail，退出码 1 |
| 全局目标晚出现的竞争场景 | 0 pass、1 fail，退出码 1 |
| 高优先级目标预先存在的对照 | 1 pass、0 fail，退出码 0 |

有效测试合计 3 pass、4 fail，对应三个新增缺陷；环境引用两种输入共用 ADD-15。旧配置释放锁后的正确结果为失败用例内通过的断言，不另外增加 pass 计数。首次全局保存夹具错误不计入有效测试账本。

本轮再次发现三类验收缺口：只断言“没有写盘”而没有核对读取值；只测普通字符串而没有验证字符保持；把项目入口已具备的保护误认为其他配置入口也具备。后续验收应按每个实际入口分别检查返回值、有效配置、原始文件和阶段责任。

工作区交付仅更新本记录。证据脚本、日志、摘要及清理清单保留；最终 `manifest-delivery.json` 核对只有本文变化，暂存语义不变。所有测试隔离根仅按登记路径清理。未修改产品源码、提交、推送、重启应用或操作生产配置；没有将本轮结果外推为界面、跨平台或所有历史问题已验收。
## 12. 第六轮：扩大项目检查范围（2026-11-15）

本轮由配置专项扩大到设置页、调度、认证与目录事务、会话附件、状态同步、文件树、Server HTTP、Desktop 更新/后台生命周期及 LLM 协议。新增 **3 项 P2 产品缺陷**，累计 **19 项产品缺陷（3 P1、16 P2）**；另登记两项测试可靠性问题，后者不混入产品缺陷数量。完整覆盖账本见 [项目检查总览](./full-project-bug-review-2026-11-15.md)。

证据根：`C:\Users\zh2100\AppData\Local\Temp\opencode-project-audit-1199803213624af6a5e9ddba62f879df`。HEAD 与前轮一致。`manifest-before.json`、`manifest-tested.json` 确认检查前后源码、既有文档及暂存语义未改变。以下复现脚本位于证据根，仅测试脚本使用边界适配器；未修改仓库产品实现。

### ADD-17 / P2：定时任务列表不随服务器切换，旧任务命令发往新服务器

位置：`packages/app/src/components/settings-v2/scheduled.tsx:19–33`；父组件 `dialog-settings-v2.tsx:182–196`，SDK 响应式接线 `packages/app/src/context/sdk.tsx:22–29`。

条件：设置弹窗保持挂载，两台服务器的定时任务能力均已可用，当前项目目录字符串相同。父组件只按目录 keyed，不按服务器身份重建。

复现：编译并挂载真实 SettingsScheduledV2，Solid 使用浏览器响应式实现和 HappyDOM；语言、基础 UI、上下文和 API 边界使用夹具。A.list 返回 A-task/A-id，切换到 B，再点击列表中的提交按钮。没有连接真实调度器、没有执行模型任务。

`scheduled-scope.log` 实际调用顺序：

1. 初始仅调用 `A.list`，页面显示 A-task，初始断言通过。
2. 切到 B 后，仍仅有 `A.list`，页面仍显示 A-task，未读取 B 列表。
3. 点击后调用 **`B.run({ taskID: "A-id" })`**，接着才调用 B.list，页面才显示 B-task。

测试 0 pass、1 fail、退出码 1，失败为禁止跨服务器发送旧任务 ID 的断言。若 B 无此 ID，会操作失败；若服务器使用复制的数据、存在同 ID，则可能操作 B 的任务。后一风险本轮没有在真实服务中执行，不能记成已发生。

根因：createResource 仅提供 fetcher，没有将 scope 设为响应式 source；fetcher 内读取 serverSDK 不使资源随 scope 自动重取。操作函数则在点击时取当前 SDK，列表与命令没有共同的身份归属。

修复要求：

- 列表请求、显示数据、run/enable 以同一服务器 scope 和生命周期归属；切换时清除或隔离旧列表，自动加载当前服务器。
- 操作捕获任务所属 scope 和 SDK；归属不一致时禁止发送，不能只为列表加 refetch 而继续允许旧行命令。
- 读取及操作后刷新均保护乱序、切换、销毁和错误归属；旧请求不得覆盖新服务器列表/错误，旧成功不得刷新错误对象。
- 覆盖 A→B、A→B→A、相同目录、能力已缓存、list 迟到/失败、run/enable 进行中切换及同 ID 的不同服务器数据。
- 此证据是实际组件逻辑的隔离回归，不是完整设置页浏览器验收。修复后仍需双服务器独立页面验收。

### ADD-18 / P2：Office 提取用物理文件名代替文档关系清单，顺序错误且遗漏合法工作表

位置：两套 `packages/{core,opencode}/src/util/office-text.ts:149–159`；Core PPTX 第 246–261 行，旧运行时第 244–259 行。

`office-order.test.ts` 使用带 CRC 的 ZIP/XML 夹具，直接调用两套实际 extractOfficeText：

| 输入 | 预期 | 两套实现实际 |
| --- | --- | --- |
| XLSX workbook 声明 S1→S2 | ONE→TWO | 正确，对照通过 |
| XLSX workbook 声明 S2→S1，关系映射不变 | TWO→ONE | 仍 ONE→TWO |
| PPTX sldIdLst 声明 slide1→slide2 | ONE→TWO | 正确，对照通过 |
| PPTX sldIdLst 声明 slide2→slide1，关系映射不变 | TWO→ONE | 仍 ONE→TWO |
| XLSX 关系目标改为 worksheets/custom1.xml、custom2.xml | 保留两张表内容 | undefined，内容未提取 |

上述顺序/关系场景合计 4 pass、6 fail。夹具为受控 XML 包，没有用 Office GUI 打开并重新保存；没有把压缩包格式兼容的所有场景算成已覆盖。

根因：枚举 ZIP 内 `sheet数字.xml` / `slide数字.xml` 并按文件名排序。XLSX 虽读取关系用于表名，却不用 workbook 顺序及关系目标选择工作表；PPTX 未按 presentation 的关系顺序遍历。用户调整逻辑顺序不要求重命名内部 part，合法 part 名也不局限于该数字模板。

修复要求：

- 先解析 workbook/presentation 的有序清单，再通过 relationship ID 定位内部 part；工作表名称、幻灯片序号与逻辑顺序保持一致。
- 相对路径按所属 part 目录规范化；区分外部关系，拒绝越出包根的目标，不在提取时发网络请求。
- 缺失/重复/损坏关系采用明确策略，不静默回到文件名排序；必要兼容回退单独界定，不能覆盖合法清单。
- 两套实现复用契约用例，覆盖重排、合法非数字文件名、绝对与相对内部目标、未引用 part、属性顺序/引号和缺失目标。补真实办公软件生成样本及附件消息入口验证。

### ADD-19 / P2：XLSX 多行展开未扣累计额度，最终拒绝前可构建远超预算的中间文本

位置：两套 `office-text.ts:194–222`，调用方第 158 行。

受控输入为 20 行，每行仅 AF 列包含 X。每行输出为 31 个制表符加 X，即 32 字节。输出预算设置为 64 字节。

实际：两套实现均先展开全部 20 行，产生 **640 个字段槽及对应 640 字节行内容**，然后 appendBlock 才发现总预算不够，返回 undefined。`AUDIT_XLSX_EXPANSION` 记录 `budget:64, expanded:640, result:null`。两套预算回归共 0 pass、2 fail。

观测仅同步包装 Array.from 统计宽度为 32 的字段分配，仍调用原实现，并在 finally 恢复；输入构建在观测前完成，没有修改解码结果。小样本没有触发 OOM，也没有以 640 字节外推实际峰值内存数字。源码显示这种逐行重复额度可随行数放大；最终输出上限不能限制中间展开量。

根因：sheetRows() 收集完整 rows 数组，逐行比较同一个 writer.remaining()；直到整个 sheetRows 返回后，appendBlock 才扣预算。已有 D04 只检查最终返回 undefined，未检查预算用尽后是否继续展开。

修复要求：

- 在每行展开前扣除累计 UTF-8 字节、制表符、行间换行、表头和表间分隔符；中间展开额度和最终输出额度分别有所有者，不重复使用总剩余额度。
- 可改为逐行写入有界 writer，或显式传递并扣减剩余预算；不得用“构建所有行后再算总长”替代。
- 保留稀疏列位置、共享字符串、重复列更新和坐标合法性；对单行极宽、多行、多表、Unicode、精确边界及一字节超限验证。
- 除最终结果外，验证超预算后不再分配后续行；两套实现均需通过。预算耗尽时不得返回误导性的截断成功文本。

## 13. 第六轮测试可靠性问题（不计产品缺陷）

### QA-01 / P2：T12 使用真实时间却断言两次 runNow 必在同一秒

位置：`packages/core/test/scheduled-task-cancel.test.ts:791–852`；生产 slot 定义 `packages/core/src/scheduled-task.ts:836–849`。

- 联合调度回归 138 pass、1 fail；失败是 `again` 期望 Failure、实际 Success，之前的串行/并行完成断言通过。
- 原文件单独重跑 1 pass，不能用此覆盖首次失败。
- 临时副本仅在第二次 runNow 前加入 1100ms 等待并记录状态，其他业务实现不变；记录两条 completed 的 scheduledAt 分别为 `11:01:32.000Z` 和 `11:01:33.000Z`，再次触发相同断言失败。

原因：it.live 使用真实时钟，第一次执行、排队和 IO 后没有保证仍处于同一秒。跨秒属于新 slot，成功符合当前产品规则。本轮不能证明首次失败的精确 slot（原测试未输出），但已确定断言依赖未控制的时钟前提，并给出同路径跨秒复现。

修复：把项目串行/并行与同秒去重拆成独立用例；去重使用可控业务时钟，同秒断言冲突，显式推进一秒后断言新的合法认领。锁等待、取消超时仍用合适的真实计时或明确驱动的测试时钟，不增加等待秒数来碰运气。

证据：`core-schedule.log`、`schedule-t12-alone.log`、`t12-boundary.log`。

### QA-02 / P2：HTTP 套件更换环境根与已导入 Global 冲突，联合测试无法执行

位置：`packages/server/test/relay-auth-handler.test.ts:1–15`、`relay-commit-handler.test.ts:1–15`；`packages/core/src/global.ts:10–16`；隔离校验 `script/test-isolation.mjs:108–114`。

联合批次先运行图片设置测试并导入 Global。后两个文件顶层重新设置 XDG_* 为自己的子目录，loadGlobal 校验检测到已缓存 Global 与新 admission 的路径不一致，抛出 `isolation: product selection differs from admission`。

- 联合结果：3 pass、2 fail、2 errors；两个 relay 文件在顶层加载时被阻断，不能算它们的 HTTP 用例已运行。
- 独立进程执行 auth 文件：4 pass、0 fail；commit 文件：8 pass、0 fail。
- 隔离门禁在此正确阻止了选根漂移，没有观测到写入生产数据；禁止以删掉校验来解决。

修复：每个进程一次性选择数据根并在产品导入前准入。需要不同全局根的套件放到独立子进程，或者所有套件共享进程隔离根、通过服务层显式注入局部路径。统一 suite 收尾及测试运行入口，既测试单文件也测试联合调用。独立通过不等于联合门禁通过。

证据：`server-contract.log`、`server-auth-alone.log`、`server-commit-alone.log`。

## 14. 第七轮：技能权限归属、RTF 字符语义与 EPUB 顺序（2026-11-15）

本轮新增 **3 项 P2 产品缺陷（ADD-20～22）**，并将 EPUB 的相同遍历缺口补入 ADD-18，不重复增加编号。累计 **22 项产品缺陷（3 P1、19 P2）**；QA-01/02 仍是单列的测试可靠性问题。既有缺陷没有关闭。

证据根：`C:\Users\zh2100\AppData\Local\Temp\opencode-followup-audit-3499d7f1186a4bb187b277d56dbc3b5a`。HEAD 不变，manifest-input 来自第六轮交付；检查前后未改变产品源码或仓库测试。测试均通过 test-isolated，在对应包目录执行。

### ADD-20 / P2：技能权限列表沿用旧服务器记录，启用操作向新服务器删除旧 ID

位置：`packages/app/src/components/settings-v2/skills.tsx:38–60`；父组件 `dialog-settings-v2.tsx:151–165`。

条件：设置页保持挂载，A、B 的技能能力均已缓存为可用，项目目录字符串相同。技能数据查询会随上下文变化，但 saved 权限资源只有首次 fetcher，没有响应式 source。

真实 SettingsSkillsV2 编译为 Solid DOM，在 HappyDOM 中挂载；视图基础组件、技能查询和 SDK 边界使用夹具，组件权限读取和 toggle 逻辑没有替换。A 与 B 都有 sample 技能的 deny，但权限记录 ID 分别是 A-rule、B-rule。

`skills-scope.log`：

- 不切服务器的对照：A.listSaved(A-project) → A.removeSaved(A-rule) → A.listSaved(A-project)，断言通过。
- 切到 B：操作前仍只有 A.listSaved(A-project)，没有 B 的权限读取；启用 sample 实际发出 **B.removeSaved(A-rule)**，随后才 B.listSaved(B-project)。正确目标应是 B-rule，断言失败。

结果：1 pass、1 fail、退出码 1。夹具验证的是命令归属，不是完整服务端删除或页面验收。正式 handler 只按 params.id 调用 PermissionSaved.remove，数据库按该 id 删除（`packages/server/src/handlers/permission.ts:103–106`，`packages/core/src/permission/saved.ts`），不会把 A-rule 自动转成 B-rule。B 无此 ID 时不能解除 B 的 deny；复制数据库中 ID 相同时存在误删 B 记录的风险，后者本轮未实际执行。

根因：权限列表的服务器/项目身份与点击时取用的 SDK 分离。切换未重取权限，rule 查找基于旧数据，而 removeSaved 取当前 SDK。与 ADD-17 是同一类规则遗漏，但入口、实体和写操作不同；只修定时列表不能关闭技能权限入口。

修复要求：

1. saved 以服务器 scope、项目 ID 和生命周期为读取身份；加载/切换期间禁止使用旧权限记录发命令。
2. toggle 捕获权限记录所属身份与 SDK；读到的权限集合与发出的操作必须同属该身份。旧回包、旧失败和操作后刷新也遵守归属。
3. 权限还未就绪时不能默认把未知状态显示成可操作的“已启用”。提供加载、失败和重试状态，避免无反馈的异步失败。
4. 补同目录双服务器、A→B→A、初次慢加载、项目变化、旧读取迟到，以及 add/remove 进行中切换；读值、请求目标和服务端权限状态一起断言。
5. 完整设置页双服务器验收仍需独立环境；此处未启动或重启用户应用。

### ADD-21 / P2：RTF Unicode 回退计数按原始字符扫描，转义回退未跳过且会吞掉后续正文

位置：Core `packages/core/src/util/office-text.ts:488–526`；旧运行时 `packages/opencode/src/util/office-text.ts:486–524`。

RTF 的 `\uN` 给出 Unicode 字符，`\ucN` 指定随后用于旧阅读器的兼容字符数量。兼容字符可用普通字符、十六进制转义或转义花括号表示；它们不应再次进入 Unicode 正文。

两套真实提取函数的受控 ASCII RTF 输入：

| 输入片段 | 预期 | 两套实际 |
| --- | --- | --- |
| `\uc1\u20013?\u25991?` | 中文 | 中文，对照通过 |
| `\uc1\u20013\'3f\u25991\'3f` | 中文 | 中?文? |
| `\uc1\u123\{\u125\}` | {} | {{}} |

另通过 Core 的真实 `normalizeDocumentAttachments` 构造消息，输入 `\uc1\u20013\'3fX`：预期附件正文为 **中X**，实际为 **中?**。X 被错误当作未消费的回退字符跳过，`?` 却已被输出；结果作为成功提取文本加入消息，原附件从 files 移除。没有调用 LLM 或远程模型。

根因：skipFallback 只在普通字符分支递减，排除了反斜杠。十六进制和转义符号分支直接输出，既没跳过兼容字符，也没消费额度；后续真正的正文反而被当作回退。

修复要求：

- 先识别 RTF token，再按格式定义消费回退字符额度，不能按源代码字符数量跳过。回退中的十六进制字节、转义花括号/反斜杠及控制符号遵循统一规则。
- 正确处理组边界与局部 `\ucN`、负数 `\uN`、UTF-16 代理对及多字节代码页；兼容计数不能跨边界错误吞正文。
- 保持缓冲字节解码与回退消费的顺序；预算和非法控制数值仍需受限。
- 以完整字符串相等验证普通/hex/转义回退、尾随 ASCII/中文/空白、嵌套组及 `\uc0`；同时覆盖两套提取器和消息附件入口，不能仅断言“能读取”或“包含中文”。

证据：`document-semantics.log` 中四个失败断言（两种输入 × 两套实现），`rtf-runner.log` 中尾随 X 丢失；普通回退对照均通过。

### ADD-22 / P2：RTF 未识别应忽略的扩展目标组，将非正文内容加入附件消息

位置：Core `office-text.ts:458–476, 511–516`；旧运行时 `office-text.ts:456–474, 509–514`。

输入为 `Visible {\*\auditmeta HIDDEN} end`。RTF 的 `\*` 标记后续目标若阅读器不认识，应跳过整个组。实际两套提取器均返回 **Visible HIDDEN end**；对照 `{\info HIDDEN}` 能正确忽略，返回 Visible 后双空格再 end。

Core 消息附件入口复现使用假标记 PRIVATE-METADATA：最终消息正文包含 **Visible PRIVATE-METADATA end**，且原附件已被移除。证明错误进入待模型处理的正文构造阶段；没有执行模型请求，也没有使用或泄露真实凭据。

根因：忽略组只检查固定名称白名单。组开头匹配式把可选星号当作名称前缀，不能正确识别标准的 `\*\目标名` 两个控制项；之后控制符解析把星号丢弃，继续把未知目标的内容当正文处理。仅补一个 auditmeta 名称到白名单不能修复任意扩展目标。

修复要求：

1. 以组状态处理目标开始及 `\*`，未知目标跳过整个平衡组，嵌套组继承 ignored 状态；组结束准确恢复父状态。
2. 保留已支持的正常正文、已知目标和转义符号，避免简单按花括号字符串截断，误把 `\{`、`\}` 当组边界。
3. 补未知 starred 目标、嵌套目标、目标内部转义、正文恢复、已知 info 对照及真实附件入口；明确异常/截断组的处理策略。
4. 对模型输入断言只含可读正文，假元数据标记不出现；将输出安全性和读取成功分开验收。

这是目标组选择问题，独立于 ADD-21 的 Unicode 回退计数。修复其中一处不能关闭另一处；两项可在同一 RTF token/state 实现中统一设计。

### ADD-18 补充：EPUB 同样忽略逻辑章节顺序

位置：Core `office-text.ts:433–451`，旧运行时 `office-text.ts:431–449`。

补齐 EPUB 的 mimetype（首项且不压缩）、container、OPF manifest/spine 和 NCX 的受控包。清单 A→B 时两套结果均按 ONE→TWO，对照通过；只将 OPF spine 及 NCX 顺序改为 B→A，提取结果仍 ONE→TWO。两套实现均按 XHTML 物理文件名排序，没有读取 container/OPF/spine。

结果：2 pass、2 fail，计入 `document-semantics.log`。与 ADD-18 已确认的 XLSX/PPTX 相同，缺失的是“先读取格式的逻辑清单，再按关系选取和排序”的规则，因此扩展既有编号，不增加缺陷数量。修复范围需补 EPUB 的 container → OPF manifest → spine 关系解析及阅读顺序，不能只修 Office 两种格式。

证据边界：包由测试构造，未用 EPUB 阅读器或独立规范校验器验收。首次探索样本未完整设置 EPUB 容器规则，结果保存在 `document-semantics-initial.*`；结论使用补齐包结构后的最终日志。首次探索的“额外未引用 HTML 被包含”没有作为独立已确认问题：正文/附录/导航内容的产品提取策略还需明确，不能仅凭测试自定预期就增加编号。

## 15. 第七轮验证账本与交付

| 检查 | 结果 | 日志 |
| --- | --- | --- |
| 技能权限真实组件：同服务器对照、跨服务器 | 1 pass、1 fail，退出码 1 | skills-scope.log |
| RTF/EPUB 两套提取器最终复现 | 6 pass、8 fail，退出码 1 | document-semantics.log |
| RTF 真实消息附件入口 | 1 pass、2 fail，退出码 1 | rtf-runner.log |
| 既有 Core office-text + session-runner-message | 19 pass、0 fail，退出码 0 | core-existing.log |
| 既有 OpenCode office-text | 14 pass、0 fail，退出码 0 | opencode-existing.log |

新复现有效账本 **8 pass、11 fail**，对应三项新缺陷及 ADD-18 扩展；既有回归 **33 pass、0 fail**。首次探索脚本不重复计入。此轮没有产品修改，因此未重复上轮类型检查；既有测试通过不能关闭新增边界。

检查及记录范围保持不变：不改生产配置、不写迁移标记、不重启应用、不提交或推送。源码与仓库测试摘要不变，交付仅更新追加记录和检查总览。证据脚本、日志及摘要保留，测试隔离根按登记的绝对路径单独清理。真实界面、跨平台、R3-03B 和其他历史待验收项继续保持原状态。

## 16. 第八轮：服务器编辑状态与 XML 字符保持（2026-11-15）

新增 **3 项 P2（ADD-23～25）**，累计 **25 项产品缺陷（3 P1、22 P2）**。QA-01/02 仍单列；没有关闭已有问题。

证据目录：`C:\Users\zh2100\AppData\Local\Temp\opencode-round8-audit-1ca41b2e183948d8b4e51e6053f4eb94`。本轮继承第七轮交付摘要，HEAD 仍为 `6b051f12a21094df1adef83f9fddfcbb765b319e`；before/tested 摘要确认产品源码、仓库测试及暂存语义不变。所有测试通过 test-isolated，在对应包目录运行。

### ADD-23 / P2：编辑非当前服务器的名称，会意外切换当前服务器

位置：`packages/app/src/components/dialog-select-server.tsx:325–342`；`packages/app/src/context/server.tsx:290–302`。

隔离复现编译真实 useServerManagementController 和完整 ServerProvider 实现，服务器 add/remove/setActive 使用原实现。平台持久化、健康检查、导航、上下文容器和 mutation 调用边界使用夹具；健康检查受控成功，没有访问远程服务器，也没有写用户存储。

初始有 A、B，当前及默认服务器为 A。打开 B 的编辑表单，仅将名称改为 Renamed B，调用真实 submitForm：

- B 的名称修改成功，地址不变。
- 当前服务器从 **A 变成 B**，没有显式选择 B。
- 对照 1：修改 B 的地址，当前仍保持 A。
- 对照 2：修改当前服务器 A 的名称，当前仍是 A。

最终 `server-edit.log` 中 inactive-name 断言失败，两个对照通过。相同 URL 的凭据编辑也进入同一分支，但本轮没有单独把凭据编辑算成实测用例。

根因：相同 URL 的 edit 分支直接调用 server.add(conn)，而 add 的业务语义同时包含“保存连接”和“设置当前连接”。修改 URL 的 replaceServer 分支知道保存/恢复 active；相同 URL 分支没有，导致编辑动作隐含执行服务器选择。

修复要求：

1. 把连接信息更新与主动切换服务器分开表达；编辑非当前服务器应保留当前选择，编辑当前服务器应保留它的身份并刷新必要上下文。
2. 不要简单在网络请求结束后恢复开始时的 active：健康检查期间用户可能已主动切到 C。提交时保留最新有效选择，或用选择版本确认归属，避免修复引入旧值覆盖。
3. 保持凭据变更后服务上下文重建、名称变更不重建等既有规则；不能只修改视觉高亮。
4. 覆盖当前/非当前服务器、名称/凭据/URL 分支、检查期间切到 C、检查失败和目标被删除，核对 server.key、server.current 及实际 SDK 归属。

这是实际状态控制器与原 ServerProvider 的集成复现，不是完整设置页/真实网络验收；本轮未重启应用。

### ADD-24 / P2：修改默认服务器地址后，持久默认键仍指向已删除地址

位置：`packages/app/src/components/dialog-select-server.tsx:335–344`；默认值读写入口第 52–78 行。删除入口第 530–537 行有默认值处理，但地址替换入口没有。

沿用真实控制器/ServerProvider 夹具：默认服务器 A=`https://a.invalid`，把 A 地址改成 `https://changed.invalid`，健康检查成功。

结果：

- 列表已移除 a.invalid，保留 changed.invalid 和 B。
- 当前服务器正确变成 changed.invalid。
- 平台默认值与控制器 defaultKey 仍为 **a.invalid**，setDefaultServer 调用记录为空。

因此列表的默认标记失去对应实体，持久启动首选项与已保存连接不一致。桌面启动读取平台默认值并传给 AppInterface（`packages/desktop/src/renderer/index.tsx:404–413`）；普通远程 HTTP key 不会由 availableStartupServer 自动迁移。下次启动存在选中非预期服务器的风险，具体启动表现取决于可用列表和回退逻辑；本轮没有重启应用，未声称实测了启动失败。

根因：替换服务器只处理列表、当前选择和标签页，没有把 URL 作为键的持久默认引用纳入变更。没有检查“被替换对象是否是默认对象”，也没有迁移或明确清除旧引用。

修复要求：

- 明确地址编辑对默认选择的语义：正常保留用户的默认对象选择并迁移到新键，或者显式清除并告知；不能留下不存在的旧键。
- 读/写默认值与连接替换有一致的提交及失败处理；平台写入失败不能静默关闭并宣称所有状态已同步。
- 处理等待期间用户把默认项改成 C 的竞争；旧编辑不得把新选择覆盖回被编辑对象。
- 验收默认/非默认对象、同 URL 元数据更新、URL 变化、平台读写失败、并发改变默认值和删除；同时检查平台持久值、列表标记、当前服务器。真实启动验收需独立测试环境。

本项与 ADD-23 分别影响持久默认引用和当前会话选择，修复其中一个不能关闭另一个。

### ADD-25 / P2：XML 实体被多轮解码，合法文档中的字面文本被改写

位置：两套 `packages/{core,opencode}/src/util/office-text.ts:109–117`。

在 DOCX 的 w:t、ODT 的 text:p 中放入相同语义的 XML 字符引用，使用真实 extractDocumentText 提取。两套实现、两种格式均出现相同结果：

| XML 源文本 | 应提取的字面文本 | 实际 |
| --- | --- | --- |
| `&amp;lt;example&amp;gt;` | `&lt;example&gt;` | 正确，对照通过 |
| `&#38;lt;example&#38;gt;` | `&lt;example&gt;` | `<example>` |
| `&#x26;#65;` | `&#65;` | `A` |

`xml-entities.log`：4 pass、8 fail、退出码 1。独立使用 .NET XML 解析器读取相同三个文本片段，均得到表中的预期值，见 `xml-reference.json`。不是仅按手写测试自行定义解码规则。

根因：先替换十六进制引用，再替换十进制引用，最后依次替换命名实体；前一轮生成的 `&` 会被后一轮重新当作 XML 源语法解释。实际 XML 解析只应对源中的引用解码一次，替换生成的字符不能再次参与实体识别。不同合法写法因此产生不同正文，文档中的代码、模板和转义示例会被改变。

修复要求：

1. 只扫描原始输入中的实体一次，使用单次 token 替换或合适 XML 解析器，避免继续扫描替换生成的输出。
2. 保留 XML 五个预定义实体、十进制/十六进制数字引用、Unicode 码点和非法引用的明确处理；不能通过反复调整 replace 顺序碰巧修一个样本。
3. 两套实现共用契约样本，覆盖命名/数字 ampersand、多个相邻引用、嵌套外观的字面文本、Unicode、无效码点及原始 `&amp;`。
4. 增加 DOCX/ODT 实际提取入口，以及其他复用 decodeXml 的格式回归；最终字符串逐字符相等。预算仍按实际一次解码后的 UTF-8 文本计费。

本轮使用受控 ZIP/XML 夹具，未以 Office GUI 打开和保存；根因在公共字符解码层，已确认的产品路径为 DOCX、ODT 两套实现。未把其他格式的调用存在自动算作全部实测。

## 17. 第八轮验证账本与交付

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 真实服务器编辑控制器 + ServerProvider | 2 pass、2 fail，退出码 1 | server-edit.log |
| 两套 DOCX/ODT 实体保持 | 4 pass、8 fail，退出码 1 | xml-entities.log |
| 独立 XML 解码参考 | 3 个输入与预期一致 | xml-reference.json |
| 既有 App server 上下文及 server 工具测试 | 17 pass、0 fail，退出码 0 | server-existing.log |

最终新复现合计 **6 pass、10 fail**，对应三项缺陷。服务器首轮夹具使用了两个重复对照，已换成“修改当前服务器名称”的独立对照；首轮日志保留为 server-edit-initial，不重复计数。mutation adapter 仅调用实际 mutationFn 并维护 pending，未声称测试了 TanStack 的重试/卸载行为。没有借这些失败修改产品实现。

既有测试通过并不覆盖新增编辑分支与 XML 语义。没有产品变动，因此不重复上轮已通过的类型检查。交付仅更新两份检查文档，源码、仓库测试、HEAD 和暂存语义保持不变；测试隔离根按日志登记路径清理，证据脚本与日志保留。没有提交、重启应用、改生产配置、调用真实模型或关闭历史待验收事项。


## 18. 第九轮：定时创建提交结果与二进制附件解码（2026-11-15）

新增 **2 项 P2（ADD-26～27）**，累计 **27 项产品缺陷（3 P1、24 P2）**。QA-01/02 仍单列；未修复或关闭历史问题，没有逐一重跑全部历史复现。

证据目录：C:\Users\zh2100\AppData\Local\Temp\opencode-round9-audit-7017018416f940f4a9ae1a01b0d8c095。输入为第八轮交付；HEAD 仍为 6b051f12a21094df1adef83f9fddfcbb765b319e。before/tested 摘要确认源码、仓库测试和暂存语义与输入一致。所有产品测试先经 test-isolated，在对应包目录执行，使用独立 home/data/config/state/cache/tmp。

### ADD-26 / P2：定时任务已创建后通知失败，接口报错，重试生成第二个启用任务

位置：packages/core/src/scheduled-task.ts:200–215、813–821；packages/protocol/src/groups/scheduled-task.ts:40–79；packages/server/src/handlers/scheduled-task.ts:22–27；packages/app/src/components/settings-v2/dialog-scheduled-v2.tsx:36–83。

真实 ScheduledTaskStore、SQLite、EventV2 及锁的隔离复现中，仅让首次 Updated 的真实事件监听器抛出 defect。任务时间设为未来两小时；Session 使用现有测试的记录适配器，不执行模型。

- 无故障对照：create 成功，只有一条任务。
- 首次通知失败：create 返回 Failure，但 list 已包含一条 enabled:true 的任务。
- 相同参数重试：create 成功，list 出现两个不同 ID、均启用的任务。sessions 始终为 0。

进一步使用真实 Server handler 和独立 127.0.0.1 随机端口，核对 POST、GET 及 SQLite：

| 阶段 | HTTP/持久结果 |
| --- | --- |
| 首次创建 | POST 返回 500，响应正文为空 |
| 立即读取 | GET 已返回一条启用任务 |
| 原样重试 | POST 返回 200 |
| 再次核对 | GET 和 SQLite 都有两条启用任务，未创建执行会话 |

HTTP 服务使用既有测试层，认证及 Location 中间件按原测试受控放行；服务在测试结束关闭。这不是完整设置页验收，也未验证真实认证。本轮证实重复任务落库，没有声称重复模型执行或实际计费已经发生。

根因：create 每次分配新 task ID，先插入数据库，再等待 publish。通知失败原样传播到调用者，但数据库提交已生效。notices 记录通知异常，不是持久创建回执；公开创建契约没有稳定操作 ID。弹窗在请求失败后恢复可提交状态，无法据此识别已经提交的任务。把数据库提交、通知完成和用户看到的创建成功绑为一个结果，导致失败响应无法表示真实提交状态。

修复要求：

1. 明确“未提交、已提交、结果未知”三类结果。持久创建提交与通知结果分离；已提交任务的身份必须能够返回或恢复，不能只显示普通创建失败。
2. 为同一创建意图设计稳定操作 ID、持久回执或等价重试核对。响应丢失和提交后通知失败的重试只能恢复同一任务，不再插入新任务；不同创建意图仍可创建合法同名任务，不能按名称去重。
3. 保留通知失败诊断和取消、defect 的责任；不能简单忽略全部 Cause，也不能通过补发事件重放已执行监听器的副作用。
4. 测试提交前失败、提交后通知失败及部分投递、取消、响应丢失、同操作重试、不同意图和服务重建。核对 HTTP 结果、SQLite 行数、enabled 状态及任务身份。
5. 弹窗与服务采用同一提交语义，在隔离页面验证失败提示、重试和列表刷新。公开协议若变化，按仓库规则重新生成客户端。

### ADD-27 / P2：合法百分号编码的二进制 data URL 被当成 UTF-8 文本解码，文档无法读取

位置：packages/core/src/session/runner/to-llm-message.ts:42–47（文档消费者约第 96 行）；packages/opencode/src/util/data-url.ts:5–12；旧运行时接线 packages/opencode/src/session/prompt.ts:815–823。

两套入口的非 Base64 分支均先调用 decodeURIComponent，再用 UTF-8 编码生成 Buffer。该操作要求转义内容是有效 UTF-8，而二进制 data URL 表示的是字节，合法文件字节不受此限制。

使用相同内容，只改变 data URL 的编码形式：

| 入口/样本 | Base64 对照 | 百分号编码结果 |
| --- | --- | --- |
| 旧运行时 decodeDataUrlBytes；字节 00 FF 89 50 4B | 返回原字节，通过 | %00%ff%89%50%4b 抛出 URI error |
| Core normalizeDocumentAttachments；295 字节 DOCX ZIP，正文 Reviewed document | 生成正确附件正文，通过 | 生成 Attached document (sample.docx) could not be read.，files 同时被清空 |

独立使用 Node v24.19.0 的原生 fetch 解码 data:application/octet-stream,%00%ff%89%50%4b，得到 [0,255,137,80,75]，与预期一致，见 data-url-reference.json。该参考只访问 data 协议，没有网络请求。

Core 测到真实消息附件规范化入口；旧运行时测到实际 byte helper，并核对会话调用链，没有执行完整旧运行时 HTTP 会话。所有文档为受控 ZIP，没有调用模型。

根因：把 URL 百分号到字节的解码与正文字符编码混成一个步骤。Base64 分支直接得到 bytes，百分号分支却被 Unicode 解码器提前拒绝；后续文档解析器根本收不到原文件。

修复要求：

1. 百分号转义直接还原 octets，文件按原字节进入文档解析。文本 UTF-8/charset 解码仅在文本消费层执行，保留纯文本附件既有的严格编码规则。
2. 保留 Base64 路径，并统一 Core 与旧运行时的契约，避免只修一份 helper。
3. 明确无效百分号、大小写 hex、裸非 ASCII、逗号、加号、零字节、非法 UTF-8 二进制及限额语义；不要使用会把加号当空格的表单解码。
4. 用同一文档的 Base64 与百分号编码分别检查字节相等、提取正文相等及最终消息内容相等；补正常文本与非法编码对照。超限和错误处理不得把合法二进制当作文本拒绝。

## 19. 第九轮验证账本与交付

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 真实 Core 创建、通知失败与重试 | 1 pass、1 fail，退出码 1 | task-create-notice.log |
| 真实 HTTP 创建与 SQLite 对照 | 0 pass、1 fail，退出码 1 | task-create-http.log |
| 两种编码：旧 byte helper、Core 文档消息入口 | 2 pass、2 fail，退出码 1 | data-url-binary.log |
| 独立 Node data URL 字节参考 | 原字节完全一致 | data-url-reference.json |
| 既有 Core T18 通知 failure/interrupt/slow | 3 pass、0 fail，退出码 0；98 项被过滤，不算通过 | task-existing.log |
| 既有 Server 定时 HTTP 测试，独立进程 | 1 pass、0 fail，退出码 0 | http-existing.log |
| 既有 OpenCode data-url，按包约定显式 --timeout 30000 | 3 pass、0 fail，退出码 0 | data-url-existing-configured.log |

新增缺陷复现合计 **3 pass、4 fail**，对应两项未修复缺陷；多入口不重复计数。既有定向回归共 7 pass，但没有覆盖这两个新边界，不能据此关闭缺陷。

旧运行时既有测试的前两次命令未带包脚本要求的 --timeout 30000，均为 3 pass、1 fail、退出码 1。失败发生于全局收尾钩子动态导入 AppRuntime，日志显示 importing 到 quiescing 分别约 23.7 秒和 19.2 秒，随后 closed；三条正文断言均通过。按 package.json/bunfig.toml 指示加显式超时后通过。原始失败保留于 data-url-existing.log、data-url-existing-retry.log，不抹去、不计成新增产品缺陷，也不把多次复跑累计成独立覆盖数。

复现脚本保存在 Temp 证据根，未加入仓库；没有产品修改，因此没有重复既有类型检查。仅更新两份检查文档，保留原有未提交内容和暂存语义。测试根按本轮日志登记路径清理，删除前核对系统 Temp 父目录、固定前缀及无重解析点；脚本、日志、SHA256、清理清单和交付摘要保留。没有提交、推送、重启应用、写生产数据或调用真实模型。历史真实界面、跨平台和 R3-03B 等状态不变。


## 20. 第十轮：定时任务迁移恢复与 RTF 原始字节（2026-11-15）

新增 **2 项 P2（ADD-28～29）**，累计 **29 项产品缺陷（3 P1、26 P2）**。QA-01/02 仍单列；历史缺陷未关闭，未重跑全部历史复现。

证据目录：C:\Users\zh2100\AppData\Local\Temp\opencode-round10-audit-6f476db038694ed2a47ec3543ed868bb。输入来自第九轮交付，HEAD 仍为 6b051f12a21094df1adef83f9fddfcbb765b319e。before/tested 摘要确认检查期间源码、仓库测试及暂存语义不变。测试位于 Temp，通过 test-isolated 先设置独立根，再在对应包目录导入产品模块。

### ADD-28 / P2：定时任务迁移用表是否为空代替完成状态，删除后复活，中途失败后遗漏

位置：packages/core/src/scheduled-task.ts:777–794；删除入口第 823–834 行。

迁移每次服务构建都会执行，只在 scheduled_task 非空时跳过；源 scheduled-tasks.json 保留，没有持久迁移完成记录。tasks 和 runs 按条写入，不在一个完整迁移事务内。

**复现 A：删除最后一条迁移任务后再次导入。**

使用真实 ScheduledTaskStore、SQLite、文件读取和锁。临时旧文件存有一条启用的未来任务，内容使用实际 ScheduledTask.Info schema 编码。首次构建服务并读取后，调用真实 remove 删除，再关闭该测试作用域、对相同隔离数据根和数据库新建服务作用域。

| 阶段 | 结果 |
| --- | --- |
| 初次导入 | 一条启用任务 |
| 调用 remove 后立即 list | 空列表，删除确实生效 |
| 新建服务作用域后 list | 原 ID 的同一条任务重新出现，enabled:true |
| 无旧文件的正常对照 | 新建并删除最后一条任务后，重建仍为空 |

任务时间为未来两小时，执行会话数始终为 0。本轮证实任务恢复及启用状态，未让它到期，也没有声称实际重复执行或产生费用。重建的只是隔离测试服务，没有重启用户应用。

**复现 B：中途导入失败后，下一次加载遗漏尚未导入的任务。**

在隔离 SQLite 上安装临时 BEFORE INSERT 触发器，仅拒绝名为 second 的第二条旧任务。旧文件包含 first、second 两条合法任务。

1. 第一次服务构建失败，直接查询 SQLite 可见 first 已提交。
2. 移除受控触发器，故障已解除。
3. 再次构建服务成功，但 list 仍只有 first；second 还在旧文件中，却不再被导入。没有执行会话。

该故障注入只作用于隔离数据库；没有替换迁移实现，也没有模拟返回的 list。本轮验证的是真实写入错误后的恢复路径，不是实际杀进程实验。两种表现归入同一个迁移状态缺陷，不重复计数。

根因：当前业务表内容不是迁移进度。空表既可能表示“从未迁移”，也可能表示“用户已删除全部任务”；非空表既可能表示“迁移成功”，也可能只是“导入一半”。依赖这个条件，会分别误启动或误跳过迁移。缺少整批提交边界，使后者在数据库写入错误后可以稳定发生。

修复要求：

1. 在数据库中持久化有版本的迁移状态，不能用任务数量、源文件存在或文件改名的单一条件替代。迁移完成后，即使用户删除全部任务，也不得再次导入旧源。
2. 将任务、历史运行记录和完成标记放入同一事务，或设计等价的可恢复日志协议。中途失败不得留下会被误认为完成的半批数据；取消和重试遵守同一边界。
3. 显式处理已经存在的无标记数据库：区分既有任务、可能的部分导入与已删除记录；不能在升级时无条件补回旧文件全部任务，也不能遇到非空表就宣告迁移成功。无法证明的历史状态应提供保守恢复流程。
4. 迁移状态与源身份、重复 ID、运行记录外键及并发服务初始化保持一致；源文件清理若需要执行，应在持久提交确认后处理，清理失败不能导致重复导入。
5. 补初次迁移、空旧文件、完成后删空、新建与迁移任务共存、第 N 条任务/运行记录失败、取消、进程中断、重试和双实例竞争。核对数据库任务/运行记录、迁移状态、源文件和启用状态。
6. 用独立应用验收“导入→删除全部→重新启动”的页面行为。未完成该验收前，不把本轮服务级证据写成真实桌面验收。

### ADD-29 / P2：RTF 原始高位字节绕过代码页解码，合法中文和符号变成乱码

位置：两套 packages/{core,opencode}/src/util/office-text.ts 第 49 行；Core 第 492–495、534–539 行，旧运行时第 490–493、532–537 行。消息接线为 Core normalizeDocumentAttachments。

RTF 文件先被转为 latin1 字符串扫描。十六进制转义进入 bytes 缓冲并按 ansicpg 解码；未转义的原始字节却直接 output.push(char)。因此同样的 RTF 字符数据会因写法不同而得到不同正文。

| 声明与字节 | 正确正文 | 十六进制转义对照 | 原始字节实际输出 |
| --- | --- | --- | --- |
| ansicpg1252，80 | € | 正确 | U+0080 控制字符 |
| ansicpg936，C4 E3 BA C3 | 你好 | 正确 | ÄãºÃ |

两套真实 extractDocumentText 均复现。Core 真实 normalizeDocumentAttachments 使用 Base64 携带相同 RTF bytes，也把错误文本加入最终用户消息，不是仅 helper 的局部差异。

独立参考：将四个 RTF 文件交给 Windows System.Windows.Forms.RichTextBox.LoadFile 解析（只创建解析对象，不显示窗口）。CP1252 的两种写法均返回 €，CP936 的两种写法均返回 你好，见 rtf-reference.json。没有依赖产品解析器自行定义预期。

根因在 RTF 字节到字符的边界，与 ADD-21 的 Unicode 回退计数、ADD-22 的忽略目标组、ADD-25 的 XML 实体解码均不同；本轮没有把未测试的其他代码页宣称为已覆盖。旧运行时测到真实提取函数，没有完整旧 HTTP 会话验收；没有发送模型请求。

修复要求：

1. 在识别 RTF 语法时保留原始字节语义。普通原始文本字节和十六进制字节应在对应代码页下统一解码，不能直接把 latin1 扫描字符作为最终 Unicode 正文。
2. 字节序列应按文本编码边界解码；多字节序列、原始/转义混合、组内代码页切换与组恢复不能被逐字符 flush 拆坏。控制符、转义括号和 Unicode 指令仍须按 RTF 规则处理。
3. 与 ADD-21/22 共用 token 和状态规则，分别处理回退计数、忽略目标和字节缓冲；不要修乱码时重新输出 Unicode 回退或隐藏目标内容。
4. 两套实现使用同一组原始/转义对照。覆盖 ASCII、CP1252 特殊符号、CP936 多字节字符、混合表示、组切换、Unicode 和不完整字节序列；明确不支持代码页的行为。
5. 同时核对实际附件消息、错误处理和 UTF-8 文本预算，不能只增加局部解码 helper 单测。真实发送模型不属于这些离线回归的必要条件。

## 21. 第十轮验证账本与交付

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 删除末条任务后重建，正常对照/旧迁移 | 1 pass、1 fail，退出码 1 | task-migration.log |
| 数据库中途拒绝导入后解除故障重试 | 0 pass、1 fail，退出码 1 | task-partial-migration.log |
| 两套 RTF 提取 + Core 附件消息，原始/转义对照 | 6 pass、6 fail，退出码 1 | rtf-raw.log |
| Windows 独立 RTF 解析 | 四个输入正文符合预期 | rtf-reference.json |
| 既有 Core office-text | 12 pass、0 fail，退出码 0 | office-existing-corrected.log |
| 既有 OpenCode office-text，显式 30 秒超时 | 14 pass、0 fail，退出码 0 | legacy-office-existing.log |
| 既有 Core T05 删除 pending 任务 | 1 pass、0 fail，退出码 0；13 项被过滤 | task-delete-existing.log |

新增正确性复现合计 **7 pass、8 fail**，对应两项尚未修复缺陷。既有回归共 27 pass，不覆盖本轮迁移恢复和 RTF 原始字节边界。首次 Core office-text 命令误用 test/office-text.test.ts，未匹配文件、退出码 1；原日志 office-existing.log 保留，不算产品失败，也不算有效执行。更正为 test/util/office-text.test.ts 后的结果列于上表。

本轮没有产品修改，不重复类型检查。只更新追加记录与总览，测试根按日志中的精确路径清理，核对 Temp 父目录、固定前缀及无重解析点后删除；证据脚本、样本、日志、摘要及清理清单保留。最终交付摘要核对只有两份文档变化，HEAD 与暂存语义不变。没有提交、推送、重启应用、操作生产配置/凭据或调用真实模型。历史界面、跨平台、R3-03B 等待验收项保持原状态。
