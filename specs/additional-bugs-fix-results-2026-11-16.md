# 追加缺陷修复实施记录

日期：2026-11-16。对应方案版本 1.5。状态：**实施中，未验收关闭**。

本文件只记录已执行的改动和已跑命令。未列出的编号保持待实施。通过某一测试不等于该编号已关闭。

## 已执行

### P0-A / QA-02

HTTP 套件不再在产品导入后改写 `XDG_*` 或 `OPENCODE_DB`。局部目录只作为请求头和夹具路径，并限制在已准入的 `OPENCODE_TEST_ROOT` 内。

改动：

- `packages/server/test/relay-auth-handler.test.ts`
- `packages/server/test/relay-commit-handler.test.ts`
- `packages/server/test/relay-catalog-lifecycle-handler.test.ts`
- `packages/server/test/relay-probe-completion-handler.test.ts`

联合命令（工作目录 `packages/server`，经 `script/test-isolated.mjs`）：

`test/image-generation-settings-handler.test.ts test/relay-auth-handler.test.ts test/relay-commit-handler.test.ts`

结果：14 pass，0 fail，退出码 0。隔离根为当次临时目录，未写入生产路径。交换加载顺序和另外两个 relay 文件的联合门禁尚未跑。

### P0-B / QA-01

`ScheduledTask.runNow` 增加可选槽位参数。生产调用仍用 `DateTime.now` 量化到秒。T12 的串行/并行留在 live 测试；同秒冲突与下一秒新槽改由显式槽位控制，不再依赖机器快慢。

改动：

- `packages/core/src/scheduled-task.ts`
- `packages/core/test/scheduled-task-cancel.test.ts`

命令（工作目录 `packages/core`）：

`test/scheduled-task-cancel.test.ts -t T12`

结果：2 pass，0 fail，退出码 0。全文件调度回归尚未重跑。

### P1 局部：图片设置发布入口

图片设置保存改为在租约内重读目标，并调用 `AtomicDocument.publish`。不再自建临时文件和忽略清理错误。更高优先级文件在等待期间出现时返回冲突，不写旧目标。

改动：`packages/core/src/image-generation-settings.ts`

已覆盖的真实 HTTP 入口是上面的 F34 两条。创建时访问隔离、扩展 ACL、第二主体、取消后租约竞争尚未实现，ADD-01/02/04/05/16 不能关闭。

### P1 局部：创建时暂存隔离与 Windows DACL

`AtomicDocument.publish` 改为在目标父目录内创建本操作专属暂存目录。Windows 使用 `Directory.CreateDirectory` 的创建时安全描述符，目录保护继承关闭且只授权当前用户。临时文件以 `0600` 独占创建。替换已有文件时，在写入正文前复制 Access/Owner/Group DACL；新建文件安装当前用户专用保护 DACL。清理只删除本操作登记的临时文件，空暂存目录随后非递归移除。

新增 `publishCopy`，供 TUI 迁移备份和新建 `tui.json` 在第一字节前复制源 DACL。`packages/opencode/src/config/tui-migrate.ts` 已改用该入口。

图片设置错误增加稳定 `code`：`alias`、`conflict`、`invalid`、`unavailable`、`unknown`。HTTP 映射只传 `message` 和 `kind`，不拼接底层路径或 `Error.message`。

命令（工作目录 `packages/core`）：

`test/config/atomic-document.test.ts`：19 pass，1 skip（POSIX mode 用例在 Windows 跳过），0 fail，退出码 0。其中 Windows 新建 DACL、替换 DACL、备份复制 DACL 三条通过。

`test/image-generation-settings.test.ts`：6 pass，0 fail。

Linux 扩展 ACL、macOS ACL、第二主体持有句柄回归未执行，保持待验证。不能据此关闭 ADD-01/06/13。

### IMG-R1 / IMG-R4 局部

图片发布失败改为在 `Effect.tryPromise` 的 catch 中分类：`CommitError(prepare)` 映射 unavailable，其余映射 unknown。成功通道不再检查被拒绝的 CommitError。

`AtomicDocument` 的提交确认移到回执和清理之前。已提交后的目录删除失败返回 `committed: true, cleanupPending: true`，不再被外层 catch 改成 prepare。清理按操作记录文件和目录，`retryCleanup` 串行重试 retryable 记录，跳过活动、隔离和身份不明记录。

命令（`packages/core`）：`test/config/atomic-document.test.ts test/image-generation-settings.test.ts`，27 pass，1 skip，0 fail，退出码 0。CL-02～CL-10、IMG-T01～T10 和类型检查尚未全部完成，四项不能关闭。

### IMG-R1～R4 / CL-05 / CL-07 补修候选

创建责任在暂存目录创建前登记。`fs.open` 明确失败后，空目录进入 retryable 并清理；身份不能确认时转 unidentified，不按路径删除。所有删除入口经过 `cleanupOnce`，同一操作复用一个清理任务。`drainWithCause` 把已投递 IO 放到独立 fiber，结算后恢复父 fiber 的中断，失败和中断可以同时保留。既有 `drain` 未改。

已通过：

- `packages/core`：`test/config/atomic-document.test.ts test/settled-io.test.ts test/image-generation-settings.test.ts`，43 pass，1 skip（POSIX mode），0 fail，退出码 0。覆盖 CL-01～CL-07、IMG-T01、T04～T07。
- `packages/server`：图片 HTTP 定向 4 pass，0 fail，退出码 0。真实 PUT 的 unknown 为 400/`unknown`，清理未完成时仍为 200。
- `packages/server` 第 6 节 handler 联合：19 pass，0 fail，退出码 0。
- `packages/opencode`：`test/config/atomic-entry.test.ts test/config/tui.test.ts test/config/config.test.ts`，退出码 0。
- Core、Server、OpenCode `run typecheck` 在错误映射和 spy 类型修正后均退出 0。

Core 联合门禁复跑：`test/config/atomic-document.test.ts test/config/document.test.ts test/settled-io.test.ts test/image-generation-settings.test.ts test/scheduled-task-cancel.test.ts`，61 pass，1 skip，0 fail，退出码 0。首次并发负载下 IMG-T05 的 5 秒后继保存超时已记录；等待放宽到 20 秒后该用例通过。

尚未关闭：IMG-T02、T03、T08、T10、CL-08～CL-10 没有独立仓库用例。Linux/macOS ACL 和第二主体访问未验证。不构建 EXE，不关闭四项。

## 未执行

P0-C、P1-A.1、P1-A.2、P1-B 完整预留、P1-C 脱敏错误、P2～P8，以及结果矩阵的逐项关闭，均未执行。Linux/macOS 权限场景保持待验证。

### 2026-11-17 CL-05 / CL-07 句柄责任与清理认领

本轮只关闭已复现的持续 stat 失败分支和重复 retire 等待缺口，并确认 close 拒绝的保守责任管理。安全恢复能力受限、未实现，不记通过。不表示资源泄漏已全面解决，不关闭 IMG-R4。未改 HTTP 契约、锁协议和 `drainWithCause`。未构建或启动 EXE，未做 GUI。运行时是本机 Bun 1.4.3 / Windows；仓库声明的 Bun 1.3.14 兼容性未验证。POSIX 权限用例仍 skip，不算通过。

分支 `dev`，HEAD `6b051f12a21094df1adef83f9fddfcbb765b319e`，未提交。联合门禁前后 SHA-256 相同：

- `packages/core/src/config/atomic-document.ts`：`84d57a41996494736613aa7a590cce5e389c5dc9178299a1e19f27dd9c274058`
- `packages/core/test/config/atomic-document.test.ts`：`1083c543e856758f475c537df3588a41f94fab11f3230ccd26547fc7834f0cb2`
- `packages/core/src/util/settled-io.ts`：`b628fe867a7cc237390e1a98816001483e6b6c719c03e441e1105a54b1dd1ff0`（本轮未改）

已复现缺陷：

- CL-05 / F1-01：持续 stat 失败且 close 可执行时，产品在 publish 结算前关闭已获得句柄，恰好一次。结果保持 prepare，`document.tmp` 保留，目标未创建，责任未归零，也没有已结束操作永久停在 active。此结论不覆盖 close 失败恢复。
- CL-07：重复 retire 在 unlink 完成前都不返回；两次调用观察同一个 `EBUSY`，unlink 一次，文件当时仍在。注入解除后的 `retryCleanup` 才能清掉该已知文件。这不是 close 失败恢复，也不消除身份检查到 unlink 之间的替换窗口。

关闭失败责任管理：close 拒绝后句柄停在 uncertain，不自动重试、不删除已知临时文件、不把 prepare 改成成功。已知身份不会仅因 close 失败被标成 unidentified。保留引用不等于资源已释放；隔离子进程退出释放操作系统句柄，不能当成产品恢复成功。

安全恢复能力：Bun 1.4.3 的 `FileHandle.close` 会在 `close(fd)` 完成前把 fd 置为 -1，再次 close 会空成功。本轮没有产品可观察的安全重试证据，因此 F1-03、F1-04、F1-10 的成功恢复子项记为受限/未实现，不记 pass。对应的 uncertain 禁止重试已由 close 拒绝用例通过。

取消矩阵未关闭。既有 IMG-T04、T05、T06、T07 在联合门禁中仍通过，但第 8 节完整 helper/服务矩阵没有新增。F2-07 仍只由既有用例保证后台扫描跳过已有任务。

命令均从对应包目录执行，退出码都是 0：

- Core 定向三轮新进程：`test/config/atomic-document.test.ts`，每轮 31 pass，1 skip，0 fail。
- Core 联合：`atomic-document`、`document`、`settled-io`、`image-generation-settings`、`scheduled-task-cancel`，64 pass，1 skip，0 fail。
- Server handler 联合：19 pass，0 fail。
- OpenCode：`atomic-entry`、`tui`、`config`，198 pass，0 fail。
- Core、Server、OpenCode `run typecheck` 均退出 0。

尚未关闭：完整取消矩阵、F1/F2 其余未单列场景、Linux/macOS 权限、第二主体访问、GUI、EXE，以及原文档其余验收。IMG-R4 保持未关闭。

### 2026-11-17 保守关闭、取消矩阵与内部 close cause

本轮只记录新候选的限定结果。纳入内部原始 close cause 保真，不授予重试，不改变 uncertain、cleanupPending、prepare 或 unknown。不表示资源已释放，不关闭 IMG-R4。未改 HTTP 契约、锁协议和 `drainWithCause`。未构建或启动 EXE，未做 GUI，未提交。运行时是本机 Bun 1.4.3 / Windows；仓库声明的 Bun 1.3.14 兼容性未验证。POSIX 权限用例仍 skip，不算通过。

分支 `dev`，HEAD `6b051f12a21094df1adef83f9fddfcbb765b319e`，未提交。相关 Core 文件仍是未跟踪文件，空 `git diff` 不能代表内容未变。本候选摘要：

- `packages/core/src/config/atomic-document.ts`：`27d9ee118ff8a0941cc2376b8af9ca8154955e34ae98dc8b53f9fe044e416a46`
- `packages/core/test/config/atomic-document.test.ts`：`11da82e9903e478dc6a3870e3e57d9b6dba6c97709e697769fafaf2558ac163f`
- `packages/core/src/util/settled-io.ts`：`b628fe867a7cc237390e1a98816001483e6b6c719c03e441e1105a54b1dd1ff0`（与上一候选相同，本轮未改）
- `packages/core/test/settled-io.test.ts`：`c63823742bc82b22b9fb3311efa3f286115100b3f6d4a71212ca6be9699ce3bf`
- `packages/core/test/image-generation-settings.test.ts`：`e0ba524a9566cd7bd9fd8d44f59f7b3bd07450259133295d678cee2d7bd2ca67`
- `packages/core/src/image-generation-settings.ts`：`0d8d551515fe268781c8a9ccec1c26bab115e0abb4314ef2f955628df7200a07`（本轮未改；此前结果文档没有它的摘要）

内部 cause 保真已裁定纳入，并且只覆盖内部错误链。close 拒绝时，`closeOwned` 保存原始拒绝；`descriptorStillOpen` 把它放进 `Error.cause`。F1-03/F1-04 和 F1-08 断言该链的 `code` 仍是 `EIO`。准备失败同时 close 拒绝时，抛出的主 cause 仍是 `ENOSPC`，序列化结果不含 `secret-close`；这只证明主失败不被覆盖，不证明 close 拒绝同时出现在这条抛出链上。保真不进入公开错误：服务把 `CommitError` 换成固定的 unavailable 或 unknown 文案，HTTP 只转发 `message` 和 `code`。既有 IMG-T09 覆盖 unknown 发布的 `secret-token` 和路径脱敏，没有单独的 HTTP close-secret 用例。

取消与责任证据：

- C-01 六组合通过。成功值在运行时是 `published`；`drainWithCause` 的推断成功类型在测试边界收成 `void`，断言因此改用未知值比较。这不是产品类型修复，也未改 `drainWithCause`。
- C-02：中断和 prepare 失败同时保留，正文含 `not replaced`，不含 `secret-token` 或夹具路径；发布一次，旧字节不变。持有期间同锁探测为 `busy`，结算后为 `acquired`，后继保存成功。后继成功只说明 prepare 没有隔离目标，不能证明 uncertain 句柄已释放。
- C-03：发布一次，中断和 unknown 同时保留，正文要求 reconciliation，不含 `secret-token` 或 `not replaced`。持有期间探测为 `busy`，结算后为 `acquired`。随后的 `local/replayed` 保存仍是 unknown，字节与保留正文相同。租约可再次探测不等于资源恢复。
- F1-05 映射到 open 拒绝用例：`prepare`/`EACCES`，目标字节不变，阶段目录已清理，`retryCleanup` 为 0。
- F1-06 只作分项映射，不整项关闭。部分写入用例断言 `prepare`、原 cause code、目标身份和临时对象清理；检查失败用例断言句柄已关闭并只清理自己的临时文件。写入路径没有单独断言“先关闭再清理”的顺序。
- F1-07 只证明活动写入期间临时文件仍在，且原保存最终提交。没有 close 计数，不能记成“活动句柄未被关闭”。
- F2-04 映射到即时清理并发用例：`.tmp` 的 unlink 一次，后续责任为 0。没有单独的 rmdir 计数。
- F2-05 的并发不重入没有独立用例，记 not-run。顺序的 prepare 保留不能代替它。
- F2-07 只证明另一文件能在已有 retire 任务挂起时提交；不证明新认领任务也不阻塞。

F1-03、F1-04、F1-10 的成功恢复子项仍是受限/未实现，不记 pass。同一用例已证明故障注入解除后 close 仍只有一次，两个 `retryCleanup` 都不能清掉 uncertain 对象。

本候选命令都从对应包目录执行，退出码都是 0。隔离根是当次临时目录，未写入生产路径：

- Core 联合：`atomic-document`、`document`、`settled-io`、`image-generation-settings`、`scheduled-task-cancel`，81 pass，1 skip，0 fail。隔离根 `opencode-owned-test-TXXq9H`。
- Server handler 联合：19 pass，0 fail。隔离根 `opencode-owned-test-dIzI4w`。
- OpenCode：`atomic-entry`、`tui`、`config`，198 pass，0 fail。隔离根 `opencode-owned-test-KmtsWu`。
- Core、Server、OpenCode `run typecheck` 均退出 0。Core 类型检查是在成功断言改为未知值比较之后重跑的。

尚未关闭：F1-06 的关闭顺序、F1-07 的活动句柄、F2-04 的 rmdir 计数、F2-05 并发不重入、成功恢复、Linux/macOS 权限、第二主体访问、路径替换窗口、GUI、EXE 和 IMG-R4。子进程退出、GC 或 fixture 清理都不是产品恢复。

### 2026-11-17 关闭顺序与并发不重入补测

上一候选列出的四项断言缺口已补测。只改测试，不改生产实现，不授予重试，不表示资源已释放，不关闭 IMG-R4。未构建或启动 EXE，未做 GUI，未提交。运行时是本机 Bun 1.4.3 / Windows；仓库声明的 Bun 1.3.14 兼容性未验证。POSIX 权限用例仍 skip，不算通过。

分支 `dev`，HEAD `6b051f12a21094df1adef83f9fddfcbb765b319e`，未提交。本候选只改变测试文件：

- `packages/core/src/config/atomic-document.ts`：`27d9ee118ff8a0941cc2376b8af9ca8154955e34ae98dc8b53f9fe044e416a46`（与上一候选相同）
- `packages/core/test/config/atomic-document.test.ts`：`19b131ec486d15174c0cfad9f2218c839d04d7c914d8ea43ceb41d653f48a3f9`
- `packages/core/src/util/settled-io.ts`：`b628fe867a7cc237390e1a98816001483e6b6c719c03e441e1105a54b1dd1ff0`（未改）
- `packages/core/test/settled-io.test.ts`：`c63823742bc82b22b9fb3311efa3f286115100b3f6d4a71212ca6be9699ce3bf`（未改）
- `packages/core/test/image-generation-settings.test.ts`：`e0ba524a9566cd7bd9fd8d44f59f7b3bd07450259133295d678cee2d7bd2ca67`（未改）
- `packages/core/src/image-generation-settings.ts`：`0d8d551515fe268781c8a9ccec1c26bab115e0abb4314ef2f955628df7200a07`（未改）

补上的断言：

- F1-06：写入抛出 `EACCES` 后，顺序是一次 close、一次 `.tmp` unlink、一次阶段目录 rmdir。抛出仍是 `prepare`，cause code 仍是 `EACCES`。目标字节和 inode 不变，目录只剩目标文件，`retryCleanup` 为 0。这覆盖写入失败的关闭顺序和身份清理，没有单独注入 Windows DACL 脚本失败。
- F1-07：写入被闸住时，后台 `retryCleanup` 期间 close 次数为 0，活动 `.tmp` 仍在。原保存提交后 close 次数为 1。扫描期间没有关闭活动句柄，也没有删除活动对象。
- F2-04：即时清理持有 `.tmp` unlink 时，并发 `retryCleanup` 在放行前已返回，unlink 为 1，rmdir 为 0。放行后 unlink 仍为 1，阶段 rmdir 为 1。后台扫描跳过已有任务，没有重复删除。
- F2-05：prepare 清理持有 unlink 时，并发 `retryCleanup` 在放行前已返回，unlink 为 1，rmdir 为 0。放行后 unlink 仍为 1，rmdir 为 1。抛出仍是 `prepare`/`EACCES`，目标身份不变，后续责任为 0。顺序的 prepare 保留不再代替这项并发证据。

本候选命令都从对应包目录执行，退出码都是 0。隔离根是当次临时目录，未写入生产路径：

- Core 定向：`atomic-document`，42 pass，1 skip，0 fail。隔离根 `opencode-owned-test-ePMGpv`。
- Core 联合：83 pass，1 skip，0 fail。隔离根 `opencode-owned-test-HJZPoh`。
- Server handler 联合：19 pass，0 fail。隔离根 `opencode-owned-test-austNQ`。
- OpenCode：`atomic-entry`、`tui`、`config`，198 pass，0 fail。隔离根 `opencode-owned-test-uJ79Xz`。
- Core、Server、OpenCode `run typecheck` 均退出 0。隔离根分别是 `opencode-owned-test-jYrxMz`、`opencode-owned-test-m5BB9P`、`opencode-owned-test-wm03dh`。

尚未关闭：成功恢复、Linux/macOS 权限、第二主体访问、路径替换窗口、Windows DACL 准备失败的单独注入、GUI、EXE 和 IMG-R4。子进程退出、GC 或 fixture 清理都不是产品恢复。
