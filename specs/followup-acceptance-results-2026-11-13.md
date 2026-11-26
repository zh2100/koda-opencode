# 后续验收与新增缺陷（2026-11-13）

## 结论

本轮后续验收未全部通过，确认两处仍需修复的产品缺陷，编号 ACC-01、ACC-02。没有修改产品实现，没有提交、推送、改版本或重启用户原有应用。

| 范围 | 最终实际结果 | 结论 |
| --- | --- | --- |
| 两套真实设置页后续场景 | 6 passed、2 failed、0 skipped、0 flaky，退出码 1，80.55 秒 | 两个失败对应 ACC-01 同一个根因，不计成两个产品 Bug |
| Relay E2E 类型检查 | 退出码 0 | 新增验收用例类型通过 |
| Linux uid 1000：配置 HTTP、权限生命周期、真实 TCP 取消联合 | 61 pass、2 skip、0 fail，377 个断言，退出码 0，67.81 秒 | 按实际覆盖范围通过；skip 不计通过 |
| Linux root：POSIX mode 权限用例 | 0 pass、1 skip、0 fail，退出码 0 | 真实 root 条件下由测试框架跳过 |
| Windows：冷启动 ACL 拒绝、TCP 取消、恢复后再次读取 | 0 pass、2 fail，退出码 1 | 权限已恢复，但 HTTP 仍 503，确认 ACC-02 |
| Windows：成功预热后执行相同恢复流程 | 1 pass、1 filtered out、0 fail，退出码 0 | 仅为热实例对照，不替代冷启动失败 |

此前 FUP-02 的 9 项通过仍只覆盖其原定范围。本轮没有撤销该范围，也没有把经典布局全局切服务器错误包装成 FUP-02 已通过场景。

## 真实页面覆盖

本轮正式文件为 [relay-settings-followup.spec.ts](D:/opencode/packages/app/e2e/regression/relay-settings-followup.spec.ts)，已加入 e2e/tsconfig.relay-settings.json。设置 FUP_NEXT_E2E=1 才执行；未设置时框架跳过，不能计作通过。

| 场景 | 经典布局 | 现代布局 | 断言 |
| --- | --- | --- | --- |
| 初始认证读取被延迟时新增同名供应商 | 通过 | 通过 | 新 ID 使用 -2；原供应商完全不变；真实新模型出现 |
| 保存 ACK 被延迟，期间继续输入 | 通过 | 通过 | 继续输入不被旧 ACK 清掉；已接受地址规范化；第二次保存的真实磁盘状态正确 |
| 模型勾选、共享数据的另一进程取消勾选、实际 Reload | 通过 | 通过 | 真实 visibility/sync HTTP 成功，页面取消勾选 |
| 改供应商地址并完整等待刷新完成 | 通过 | 通过 | 新 model-second 出现，旧 model-first 不再出现 |
| 清独立密钥、补回独立密钥、删除供应商 | 通过 | 通过 | hasKey 和按钮正确变化；删除后对应 fieldset 与后端实体均消失 |
| A 刷新挂起时在经典 Servers 页切到 B | 失败 | 本轮不重跑此前现代 Picker 的通过项 | 全局指示器已为 B，Providers 仍为 A |
| 不挂起请求直接切 B，点击 Reload，再关闭重开作对照 | 失败 | 同上 | Reload 实际请求 A；关闭重开后才读取 B |

前三类页面工作流和地址/密钥/删除链路按每个布局合并为 3 个用例，因此联合是 6 pass，而不是按表格操作数累计。每个成功场景均断言无 pageerror。未覆盖聊天模型选择器、双浏览器客户端乱序、丢响应后 receipt 重试的完整页面矩阵，不据此关闭 UI01～UI08 或 UI-BF 全表。

## ACC-01：经典设置页切服务器后仍使用旧服务器（P1）

### 复现及证据

1. 两个独立真实后端 A=44096、B=44098 分别持有相同 ID、不同名称的假供应商。
2. 打开经典设置页，读取 A 的 Primary unique / Cold primary。
3. 进入真实 Servers 页，点击 B。断言全局服务器按钮已显示 127.0.0.1:44098；模态框外的按钮使用 includeHidden 进行角色查找，随后仍检查实际可见性。
4. 切回 Providers，实际仍是 A 的名称。带旧刷新挂起的场景在精确名称断言上失败。
5. 无挂起请求的独立对照中，点击 Reload settings，真实 /api/relay/models/sync 的 origin 为 http://127.0.0.1:44096，预期为 44098。保存了精确请求目标和可见名称的附件。
6. 保留该失败，继续关闭并重新打开设置，B 的 Cold secondary 正常出现。由此排除 B 数据不可用或只由挂起刷新造成。

最终两个失败均保留在 results-final.json、results-final/*/trace.zip 和 app/logs/ui-final.log。截图与映射见证据根 screenshots/、screenshot-manifest.json。已确认错服读取；同一 SDK 上下文还承担保存、清 key、删除等操作，存在错服写入风险，本轮没有为验证该风险执行跨服写操作。

### 根因

- [SettingsServerScope](D:/opencode/packages/app/src/components/settings-server-picker.tsx:14) 只对现代布局建立独立服务器数据上下文；经典布局直接 fallback 到原 children。
- [ServerKey](D:/opencode/packages/app/src/app.tsx:548) 随全局服务器变化重建服务端作用域。
- [Dialog 的 mount](D:/opencode/packages/ui/src/context/dialog.tsx:94) 按创建时的 owner 建立独立 root，弹窗可跨过原路由/服务器作用域的销毁。
- [ServerSDKProvider](D:/opencode/packages/app/src/context/server-sdk.tsx:407) 提供的是该作用域的 memo。经典弹窗继续引用创建时的旧上下文；页面全局选择已变，弹窗中的 SDK 没有随之获得新服务器归属。

关闭重开会获取 B 的新 owner，因此恢复。修复不能仅在旧 hook 内再加一个响应序号：当前问题是发出的请求本身仍指向 A。

### 修复出口

1. 明确定义经典设置页也跟随当前全局服务器，使用不依赖已销毁路由 owner 的明确服务器上下文；按服务器身份重新建立 QueryClient、ServerSDK、ServerSync、Models。
2. 供应商与模型页使用同一边界，避免只修当前 tab。若选择切换时关闭旧弹窗，必须让后续界面明确重新进入 B，不能继续展示 A 的可编辑内容。
3. 切换时销毁 A 的草稿、忙状态和错误归属；A 的晚到回包不能写入 B。保留现代 Picker 自己的选择语义。
4. 当前两个正式失败用例均转绿，再补实际保存/清 key/删除的服务器目标断言；恢复/重开对照仍须通过。
5. 复跑此前 FUP-02 两套布局的并发、重开与现代 Picker 用例，并检查 Models 页，不以一次手动刷新绕过上下文问题。

## ACC-02：Windows 首次读取拒绝后，失败缓存阻止恢复（P1）

### 复现及证据

使用真实 Server.listen、真实 TCP、Windows ACL，仅操作本轮临时目录中的配置文件。

1. 未对该项目预热。withConfigReadDenied 投递并完成真实 ACL 修改，直接 readFile 确认 EPERM。
2. 真实 /config/mcp/review 返回 503 MCP_SOURCE_READ_FAILED，带 ref，不含配置原文或假凭据。
3. 客户端 fetch/AbortController 取消挂起的测试包装请求。包装器的 TCP close 中断夹具工作流，并等待夹具收尾；并非把断开连接等同于权限恢复。
4. 夹具 stage=restored；权限恢复完成，直接 readFile 成功，文件内容与原文相同。无注入失败时恢复 1 次，有一次受控恢复校验失败时恢复 2 次，原中断及清理错误均保留。
5. 同一项目再次通过真实 HTTP 读取，仍为 503。原始两个样本均失败，见 permission/logs/transport-first.log。
6. 普通 disposeAllInstances 对照后仍 503；直接对该隔离目录执行 instance-registry.disposeInstance 后，同一 HTTP 请求返回 200，见 transport-cache-control.log、transport-probe.log。这是定位对照，不是生产修复，不计成验收通过。
7. 先成功读取一次的热实例对照可在相同权限恢复后返回 200，见 transport-baseline.log。该对照不替代冷启动失败。

Windows 预检对照实测为：existsSync=true、access(R_OK)=success、readFile=EPERM，见 transport-probe.log。没有根据 access 成功推断真实读取可用。

### 根因

- [bootstrap 的来源预检](D:/opencode/packages/opencode/src/project/bootstrap.ts:58) 使用 access(R_OK)。本机 Windows ACL 下该检查成功，不能拦住真实读取拒绝。
- 随后的 Config.get 首次读取失败进入目录级 [InstanceState ScopedCache](D:/opencode/packages/opencode/src/effect/instance-state.ts:31)。
- [InstanceStore.completeLoad](D:/opencode/packages/opencode/src/project/instance-store.ts:75) 在引导失败后只移除外层 Entry；没有在该失败边界完成目录服务失败缓存的收尾。
- 普通 disposeAll 只遍历仍有外层 Entry 的目录。失败目录已经被移除，后续引导再次碰到同一失败缓存，无法进入 mcpSource 的正常重载恢复路径。
- 直接调用该目录注册的 disposers 后恢复 200，证实问题在失败的目录服务状态，而非 ACL 仍未恢复。

### 修复出口

1. 预检以真实读取能力为依据，不能把 Windows 的 access 成功作为 ACL 读取成功。禁止改成忽略所有读取错误或返回空配置。
2. 在失败引导的所有权边界清理该次创建的目录服务状态。保持失败条目/代次的所有权直到清理完成，防止先删 Entry、后按路径清理时误伤新一轮加载。
3. 保留原始 typed 503/ref 与取消语义；清理失败不得吞掉原错，也不能把整个等待移入无界不可中断区。
4. 回归覆盖冷启动与热实例、失败后无重启重读、两个并发首次请求、失败旧代与成功新代交错、服务退出、清理失败。每个测试都须实际重读原目录；读取新目录不是恢复证据。
5. Windows 真实 ACL、Linux 非 root 和 root 跳过统计分别保留。两个冷启动失败样本必须转绿，且不调用测试专用 disposeInstance、预热或重启来代替产品恢复。

## RF-07 平台与传输范围

Linux 容器基于本机已有 oven/bun:1.4-alpine（Bun 1.4.3）。主工作区只读挂载至 /mnt/host/d/opencode，保持现有依赖链接可解析；未重装或更改项目依赖。容器内补装 git、ripgrep，仅用于隔离夹具，测试以 uid=1000/gid=1000 执行，临时文件在容器 /tmp。

联合覆盖：真实项目 mode 拒绝时返回脱敏 503/ref、权限和内容恢复；夹具完整生命周期；真实 TCP 客户端取消；一次恢复校验失败后第二次恢复成功仍保留原错误/中断。TCP 测试使用 Node HTTP 包装器承载夹具，内部请求真实产品 Server.listen；不声称生产接口会修改/恢复 ACL，也不把它当成所有生产路由的断连取消验收。

Linux 两个 skip 分别是 Windows ACL 用例和历史 T13 的无条件框架 skip。T13 不代表 root 已验收；root 另在 uid=0 下实际运行 HTTP mode 用例，输出 0 pass、1 skip、0 fail。macOS 仍未执行。RF-07 的 Linux 子范围可按上述证据通过，整体仍受 macOS 和 ACC-02 限制，不关闭。

## 命令与日志

证据根：C:/fup-next-20261113。不同批次不累计为去重数量。

```powershell
# packages/app；事先仅启动本轮隔离服务
. C:/fup-next-20261113/env.ps1 -Service app
$env:FUP_NEXT_E2E = '1'
bun node_modules/@playwright/test/cli.js test --config C:/fup-next-20261113/playwright-final.config.mts
bun typecheck:e2e:relay

# Linux，源码只读挂载，Bun 配置仍加载正式 test/preload.ts，未加载无关的终端 JSX preload
docker exec --user 1000:1000 fup-rf07-20261113 sh -c 'id; uname -a; bun test --config /proof/bunfig.toml --timeout 60000 ./test/server/httpapi-config.test.ts ./test/server/config-read-permission.test.ts /proof/transport.test.ts'
docker exec fup-rf07-20261113 sh -c 'id; bun test --config /proof/bunfig.toml --timeout 30000 ./test/server/httpapi-config.test.ts --test-name-pattern "config mode denies read"'
```

主要日志：

- app/logs/ui-final.log、results-final.json、results-final/：最终 6 pass/2 fail、trace、截图；正式 E2E 摘要见 source-hashes.json。
- app/logs/typecheck-e2e.log：退出码 0。
- linux/final-joint.log：61 pass/2 skip/0 fail。
- linux/root-mode.log：真实 uid=0，0 pass/1 skip/0 fail。
- permission/logs/transport-first.log：Windows 原始两项失败。
- permission/logs/transport-diagnosis.log、transport-cache-control.log、transport-probe.log：恢复后 503、缓存失效 200 与 ACL 预检差异。
- permission/logs/transport-baseline.log：热实例正常恢复的对照。

## 首次失败保留

1. 页面初批 4 pass/3 fail，见 ui-first.log。经典清 key 在刷新尚未完整收尾时返回合法 revision 冲突；补上可见 Get models 恢复为 enabled 的完成断言后，相关完整顺序场景通过，不把原冲突隐去，也不据此保证任意交错动作均成功。
2. 现代删除按钮实际名称是 Delete vendor，初脚本错误使用 Delete；已修定位。经典切换初脚本等待不存在的 B auth 请求超时，又被收尾错误遮住；随后修正模态框外按钮的可访问性定位，最终仍在真实供应商/请求目标断言上失败，确认 ACC-01。
3. Linux 第一次参数布局没有真正执行用例，空日志不计通过；非 root 初次因容器缺 git 失败。补装验收工具后执行正式套件，原日志保留。
4. TCP 诊断首次错误地把 Effect 4 的 Fiber.interrupt 返回值当成 Exit，0 pass/2 fail；改为 interrupt 后 Fiber.await，Linux 两项通过。修改的是测试观察方式，不是产品实现。
5. Windows 真实冷启动恢复失败在诊断和对照中继续保留。没有为全绿改成预热、跳过或先调用 disposers。

## 隔离、交付与仍未执行范围

前端 44444、后端 A 44096、B 44098、共享 A 数据的第三进程 44100，本地上游 44097。所有地址仅监听 127.0.0.1。home/data/config/state/cache/managed/tmp 独立，假密钥，使用测试文件凭据适配器，不访问系统凭据库。B 与 A 数据独立，第三进程只共享本轮 A 的隔离数据。

仅新增正式 E2E、更新 E2E 类型检查范围、写验收文档和追加状态。没有修改产品源码、原生模块、迁移标记、生产配置或凭据。源码摘要见 source-hashes.json；工作区与暂存区核对见 workspace-before.json、workspace-after.json、workspace-verification.json。

三个隔离后端最终供应商数均为 0，见 final-test-data.json。已按 PID、命令行、创建时间核验，仅停止本轮进程及其子进程；专用容器按完整 ID 核验后删除。44096、44097、44098、44100、44444 无监听，见 cleanup-processes.json、cleanup-final.json。用户启动的 Docker 引擎保持运行，用户原有应用未操作。

历史任务 UI、附件失败后继续聊天、完整 MCP 多服务器 UI/macOS plutil、R3-03B 迁移和真实长暂停、已安装 Electron/Bun 编译产物等本轮没有验收，不标通过。此次是有明确反例的部分验收结果，不能宣布后续全部完成或所有 Bug 已修复。
