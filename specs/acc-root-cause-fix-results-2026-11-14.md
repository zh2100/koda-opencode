# ACC 根因修复实施与验证记录

日期：2026-11-14。依据：[详细实施方案](D:/opencode/specs/acc-root-cause-fix-implementation-plan-2026-11-14.md)。

## 1. 本轮结论与关闭边界

本轮已经修改产品代码并完成多组自动验证和独立页面验证，不能再记为“只编写方案”。设置错服上下文和冷启动失败缓存的原反例均已转绿；退出排空、配置原子发布和来源纯读取也已接入真实调用路径。方案中的完整 U13～U18、I01～I67 故障矩阵尚未逐格完成，所以不能宣布整份方案或全部历史 Bug 已关闭。

OBS-01 的历史 relay.auth 409 仍缺动作关联的受控定性。OBS-02 的历史 EPERM 精确占用句柄仍未复现；本轮证实并修复了后台安装取消时的锁释放责任，同时改善删除诊断与有界重试，不能把这两项证据等同于历史 EPERM 的确定根因。

不关闭 R3-03B、RF-07 跨平台整体、全部历史 UI、已安装 Electron、Bun 单文件与 macOS 验收。

## 2. 固定候选与修改边界

| 项目 | 实际记录 |
| --- | --- |
| 仓库 / 分支 | D:/opencode / dev |
| HEAD | 6b051f12a21094df1adef83f9fddfcbb765b319e |
| 初始 index SHA256 | BBD12F44DE8316E49C158D6D52929477E524373902229F91879C4894F56FCC20 |
| 实施方案初始 SHA256 | 6A1815D931922B6A99AD705376A3209A7C062206A366AD36AF185C07D3218F8B |
| Windows | NT 10.0.26300.0，zhangh/zh2100 |
| 运行时 | Bun 1.4.3；Node v24.19.0 |
| 隔离证据根 | C:/Users/zh2100/AppData/Local/Temp/opencode-acc-fix-7b2b6a71aeaa4d16a42a5079a23278df |

source-baseline.json、status-baseline.txt、environment.json 固定实施前状态。changed-from-baseline.json 记录本轮修改和新增文件摘要，无源码备份。原有未提交改动及暂存状态保留；本轮没有提交、推送、修改版本、stash/reset/clean，也没有重启用户应用或写入生产配置、凭据、锁和迁移标记。没有修改 Session/Timeline。

## 3. 产品修复与实际接入

### 3.1 ACC-01：设置服务器归属

- settings-server-picker.tsx：经典布局读取 current，现代布局读取 settings.server.selected；两者均通过 keyed 的 SettingsServerDataProviders，在同一 accessor 下绑定 SDK、Sync、QueryClient 和 Models 局部视图。
- global.tsx：同 key 但 URL、认证参数或连接类型变化时替换共享上下文；只改显示名时继续复用。签名只留在内存，没有输出凭据。
- 切服只销毁设置页局部 owner；设置页没有 clear 共享 QueryClient 或反向关闭共享事件流。
- 正式 Scope 与真实 Global provider 回归覆盖不同布局选择、A→B→A、无服务器、同 key 参数变化及已有查询数据保留。Scope 测试使用实际 TSX 和受控依赖，不能冒充全部共享消费者集成验收。

### 3.2 ACC-02：失败代与清理责任

- InstanceStore 保留 loading/ready/cleaning/failed-cleanup 及 canonical ctx；失败引导先排空本代任务，再释放该 owner 的资源，最后条件移除 Entry。
- InstanceState 记录实际创建 owner 和真实 invalidation Promise。registry 区分 owned 与借用资源，聚合同步抛错和异步拒绝；失败引导不误清借用的 PTY/Location 资源。
- reload、dispose、配置更新 hook 和退出继续观察同一份实际清理；同一清理 Promise 共用首次建立的 10 秒观察周期。超时不等于完成，也不启动后继竞争者。
- 收尾复核新增反例：旧 ctx 的 get 已拒绝，但 has/invalidate 仍能按目录访问后继缓存。两入口现与 get 共用代次准入；新增测试先失败，修复后后继对象与创建次数均保持。
- 另一条双目录红测试确认服务级 loadedEnv/loadedFile 水位会使 A 刷新后 B 仍使用旧环境配置。环境内容与显式配置文件两个反例均先失败；版本记录现按 canonical ctx 保存，失败读取也记住自己的尝试版本，不由 A 推进 B 的水位。

### 3.3 MCP 来源读取与路由装配

- 来源 GET 使用轻量 ConfigContextMiddleware，不通过完整 InstanceStore bootstrap；PATCH 保留完整引导，构建期关闭可选 schema 写入，避免 GET 所读版本被 PATCH 自己注解为过时。
- mcpSource 不再触发全目录销毁、全局 invalidateAll 或插件初始化。共享来源加载顺序的只读分支跳过 gitignore、依赖安装、schema 注解、默认初始化、TOML 写迁移和插件/命令扫描。
- 保留原来源优先级及远程、组织、环境、托管、.opencode、重复文件位置和未展开引用。必要祖先或获胜文件消失时不从缓存补回连接。
- 公开 HTTP 路径和错误协议未改变。Client 与旧 JS SDK 生成已执行；生成结果与本轮基线一致。
- 架构边界：实现是共享加载器的严格只读分支，尚未把全部来源处理提取为独立纯模块；不能把行为回归通过写成全部 P8 架构义务完成。

### 3.4 原子文档发布与六类写入入口

- 新增 Core AtomicDocument；普通项目保存、全局保存、MCP 保存、schema 注解、默认初始化和旧 TOML 迁移均接入。
- 同目录 exclusive 临时文件写入、sync、close、读回校验；发布前检查逻辑来源、父目录、目标身份和字节版本。调用者继续持有原 ConfigDocument 锁，不在原语中再次取锁。
- 首次创建用原子 no-replace hardlink，已有文件在 POSIX rename、Windows File.Replace；没有截断原文或 unlink 后写回的降级路径。
- Windows 在写临时文件内容前复制原目标安全描述符，替换后保持真实受保护 DACL；POSIX 保持 uid/gid/mode。只读、非普通文件、多硬链接目标提前拒绝。
- helper 确认丢失后核对目标身份与字节：已确认发布保持 committed；未知结果保留目标/临时责任并阻止重放，不当作缺失。
- 收尾复核发现并修复跨文档并发漏洞：全局 retryCleanup 曾能删除另一个仍在写入的临时文件。现在 active publication 与可重试清理分开；真实文件屏障测试先红后绿。
- 旧 TOML 先捕获源身份和摘要，目标提交后才精确 retire；JSON 已有值优先，引用不展开落盘。残留清理失败保持可观察责任。

### 3.5 已投递任务、长期生产者和退出

- 新增 InstanceWork：投递前登记有限任务，等待者取消不冒充真实执行完成；已接纳任务可以通过 active permit 派生必要子任务。
- EffectBridge、run-service 与 AppRuntime 接通 canonical ctx/permit。关闭开始后，在建立服务前拒绝新公共入口；晚到旧 ctx 不能初始化后继资源。
- Snapshot 的周期 timer 注册停止责任；先停未来 tick，再等已经接纳的有限执行，最后才启动原始 runtime.dispose。公开快照方法也接入任务登记。
- Config mutation 在真实发布点标 committed，在服务层 ensuring 登记 handoff，不依赖响应编码或 pre-response callback 是否执行。失败 handoff 保留，不自动重放保存。
- RuntimeShutdown 区分观察 Promise 与实际关闭 Promise；重复退出共享同一任务，10 秒观察超时保留原失败，晚到完成才更新 actualClosed。
- Core Npm 只在已投递的 Arborist reify Promise 边界等待真实成功/拒绝；锁等待与准备阶段仍可取消。两种真实持锁竞争用例验证取消后没有提前释放。

## 4. 验证结果（各批独立计数）

| 批次 / 日志 | 结果 | 说明 |
| --- | --- | --- |
| app-joint-isolated.log | 132 pass，0 fail，719 assertions | 设置 Scope、Global 与相关状态联合 |
| ui/playwright-final.log | 17 pass，0 fail；retries=0 | 原两条经典切服失败直接转绿，没有关闭重开代替修复 |
| core-final-faults.log | 25 pass，1 skip，0 fail，88 assertions | 原子提交、真实 Npm；Windows skip POSIX mode |
| linux-atomic-release.log | 18 pass，1 skip，0 fail，74 assertions | Linux uid 1000、无网络、仓库只读绑定；含最后补充的故障注入，Windows ACL 平台 skip |
| instance-final-stale.log | 32 pass，0 fail，88 assertions | 真实实例缓存、旧代失效、任务排空、bridge 与运行时入口 |
| preload-cleanup-final.log | 4 pass，0 fail，14 assertions | 正常删除、未排空保留根、临时 EPERM、永久 EPERM |
| snapshot-settled.log | 51 pass，5 skip，0 fail，715 assertions | 快照保护性回归；Windows 不支持样本如实 skip |
| routes-protection.log | 12 pass，4 skip，0 fail，33 assertions | context/workspace、v2 Location；Windows PTY skip |
| opencode-unified-final3.log | 257 pass，2 skip，0 fail，880 assertions | 最后两处保护补修之前的统一候选，不能代替最终候选 |
| opencode-unified-final4.log | 257 pass，2 skip，3 fail，2 errors | 子进程冷导入/父测试超时，保留失败，详见第 5 节 |
| opencode-unified-final5.log | 260 pass，2 skip，0 fail，897 assertions | 子进程责任修正后的统一批次，早于最后的双目录环境水位修复 |
| opencode-unified-final6.log | 262 pass，2 skip，0 fail，905 assertions；429.75 秒，退出码 0 | 含双目录环境水位修复的最新候选，11 个文件同批完成 |

类型检查：App、Core、OpenCode、Client、旧 JS SDK、relay E2E 均为退出码 0；最终 Core 检查保存在 core-typecheck-last.log，最新 OpenCode 检查为 opencode-typecheck-final6.log，均已确认退出码 0。后续新增测试不改公开接口。

最终后端命令（工作目录 packages/opencode）：

```text
bun test --timeout 60000 ./test/config/config.test.ts ./test/config/document-concurrency.test.ts ./test/config/atomic-entry.test.ts ./test/project/instance.test.ts ./test/project/instance-bootstrap.test.ts ./test/effect/instance-state.test.ts ./test/effect/instance-work.test.ts ./test/effect/run-service.test.ts ./test/effect/preload-shutdown.test.ts ./test/server/httpapi-config.test.ts ./test/server/config-read-permission.test.ts
```

Core 命令为在 packages/core 执行 `bun test --timeout 60000 ./test/config/atomic-document.test.ts ./test/npm.test.ts`。Linux 最后一批只运行 AtomicDocument 正式测试，不能将其计作完整后端或 RF-07 的跨平台通过。

页面候选限制：前端页面使用本轮 ACC-01 修复；独立后端服务启动后又补了后端排空、原子提交和代次边界。17 条页面结果不能声称覆盖了所有最后追加的后端改动，最新后端以正式自动测试为证。本轮没有重启用户应用以补验收。

## 5. 首次失败、修正和未抹去的证据

1. app-joint.log：全局 mock.module 污染后续真实 hook 导出。改为只定向替换测试编译副本的依赖，删除全局模块覆盖；联合 132 项通过。
2. core-atomic-final.log / core-atomic-acl-final.log：复制未修改的 FileSecurity 对象没有真正应用 ACL。改为新建 FileSecurity、设置捕获的 SDDL；真实临时文件写入前和替换后均核对。
3. config-joint-final.log 等：并发夹具只改 Global.Path.config 没改锁资源域。每条改用独立根并显式提供对应 lockContext；保留此前失败。
4. opencode-unified-final.log / final2.log：全局/home .opencode 来源夹具残留空目录，真实 bootstrap 触发不属于测试目标的 registry 安装。只清理由用例自己新建的空目录，并在不验证安装的 bootstrap/HTTP 测试中准备 settled metadata。真实 Npm 另有本地包及取消持锁测试，不能说 metadata 夹具验证了真实 registry 安装。
5. atomic-active-red.log：跨文档清理误删 active temp，预期 1 个临时文件、实际 0 个；active 集合补修后 Windows/Linux 均通过。
6. instance-stale-red.log：旧代 has/invalidate 成功，未能拒绝旧 owner。三入口统一校验后 32 项联合通过。
7. ui/playwright-joint.log：16 pass、1 fail，首次导航 domcontentloaded 超时，未进入供应商动作；后续单批 17 pass 不覆盖这份失败记录，也不把导航时间直接归因于 Vite。
8. opencode-unified-final4.log：3 条新增子进程用例被父测试 60 秒总时限终止，并出现超时后的断言继续运行。runtime-diagnostic.log 单独观察到从启动到 AppRuntime 导入约 32 秒、关闭约 2 毫秒，证明启动和实际退出不能混用同一个测试总时限。修正为子测试启动/钩子额度 120 秒、父 Effect 等待 150 秒、Bun 测试上限 180 秒，并由 acquireRelease 在超时/取消时终止且等待自己创建的子进程。增加导入、quiescing、closed 阶段时间诊断；产品关闭观察仍是 10 秒。该诊断没有证明 final4 每一次延迟的底层系统原因，最终通过必须另记，不能只靠扩大额度关闭产品问题。
9. config-env-owner-red.log：OPENCODE_CONFIG_CONTENT、OPENCODE_CONFIG 两条双目录样本均为第四个断言失败，B 返回旧 username。按 owner 记录环境版本后，两条均在最终 262 项联合中通过，不用 A 的成功代替 B 的复验。

## 6. 方案覆盖和剩余工作

| 义务 | 本轮证据 | 尚未覆盖 / 不能关闭 |
| --- | --- | --- |
| U13～U18 | 真实 Scope/Global 自动测试，原切服页面反例，既有 17 条真实页面 | 独立共享消费者/SSE/共享 query 的取消全过程、切服后各写动作逐项 A/B 磁盘对账尚未全表执行 |
| I01～I29 | 失败缓存清理、同目录重试、不同目录、来源只读、HTTP 错误、真实 Windows ACL 冷启动恢复、路由保护 | 完整资源/插件副作用/多等待者的每种失败和晚到组合未逐格补齐；PTY Windows 样本 skip |
| I30～I39 | 提交 handoff 接入、取消后任务保留、桥接、真实 runtime 入口、preload 子进程 | 真实客户端 disconnect、响应编码失败、提交后取消及共享冷启动请求的全部 TCP 故障注入尚未逐项执行 |
| I40～I43 | 真实锁竞争、取消持有者排空、必要子任务、原始 dispose 观察 | 全部入口各阶段的组合未做穷举 |
| I44～I55 | 首次防覆盖、部分 EIO/ENOSPC、读回失败、确认丢失、未知结果、只读/硬链接、别名、ACL/mode、清理重试和 active temp 并发 | Windows 真实共享句柄、每个 fsync/替换阶段故障、各阶段取消、未知结果的产品 reconcile 命令等仍未全验 |
| I56～I59 | Snapshot 正常保护套件、producer 停止/排空机制 | 真实 tick 写入中停机、所有订阅机制的晚到回调及 stop 失败/未知专项仍需补充。Project/Vcs 既有 unsubscribe 已盘点，但不能据此认定所有长期生产者均已完成审计 |
| I60～I67 | 真实默认初始化、三项环境门禁、TOML 新建/JSON 优先、三种 loader tryWithLock、同文档并发与自等待保护 | 旧 TOML 身份变化/删除失败、迁移结果未知与取消/退出竞争的全部矩阵尚未逐项验证 |
| OBS-01 | 17 条页面正常路径通过 | 保存、自动刷新、手动刷新及 finally 删除的动作关联交错仍待专项定性；不是 MCP schema 自冲突的同一问题 |
| OBS-02 | Npm 真正结束前不释放锁；关闭前排空；EPERM/EBUSY 有界重试、失败可见、根身份复检 | 历史 EPERM 的精确失败路径/占用句柄仍待实证；受控 fs.rm 拒绝只证明收尾机制 |

来源纯读取还需按 P8 评估是否进一步提取独立模块；未知发布结果保持保守阻止，不以自动重放解除责任。不能将当前内存清理账本宣称为已经完成的跨进程持久恢复协议。外部不合作写入者的 pathname race 也不在现有普通文件 API 下被证明完全消除。

## 7. 隔离资源与最终核对

- ui/service-cleanup.json：本轮四个服务 wrapper、其 Bun/conhost 及 Vite esbuild 后代经创建时间、父子树和命令行复核后停止；44096、44097、44098、44100、44444 均无监听。清理验证不匹配时先中止，没有按端口终止未知进程。
- ui/data-cleanup.json：仅删除本轮 primary/secondary 的 cache/config/data/home/managed/state/tmp；保留 logs、trace、截图和结果文件。凭据为测试文件适配器中的假值，没有系统凭据或生产目录清理。
- Docker 用 --rm、--network none、--user 1000:1000、只读仓库绑定；本轮专用容器已退出，用户 Docker 引擎继续运行。
- 限定本轮修改文件的 diff-check 退出码 0；测试生成的 .acc.compiled.ts 已删除。全工作区原有 packages/opencode/test/mcp/auth.test.ts 的 EOF 空行告警不属于本轮，不通过改用户文件掩盖。
- index 文件最终字节摘要为 C1F4E932CC73091758D88DDDD3299B0D2BF8A6AB2B878AA5CF7DA3924932B5CD，与初始文件摘要不同；不宣称 index 文件逐字节未变。实施前 status 清单显示没有暂存修改，最终 git diff --cached 仍为空，因此暂存内容保留，未执行 add/reset。详情见 workspace-final-check.json。
- 本轮差异为 37 个文件：25 个修改、12 个新增；35 个在 packages 下，另含实施方案状态更新和本报告。实施前清单中没有文件被删除。最后产品/测试摘要保存在 candidate-final.json，验证结果汇总为 validation-summary.json。
- 没有承诺所有历史临时目录均无残留；未知/未完成责任按方案保留，不能扫描删除整个 Temp。

最终状态以本报告的明确证据与剩余项为准，不用测试总数代替方案逐项关闭。
