# RA-01～RA-05 修复结果 — 2026-11-12

本轮修复上次复核确认的五项缺陷。**本机自动回归通过；设置页面仍待真实界面验收。** 不据此认定全项目没有其他缺陷，也不关闭历史 OA-06/UI01～UI08、R3-03B 整体或 RF-07 跨平台项。

主工作区：`D:/opencode`。验证副本：`C:/ocdf-dc5c7401`。沿用独立 home/XDG/managed 配置、TEMP 和内存数据库。没有提交、推送、重启当前应用或服务器，没有写入生产配置、凭据或迁移标记。

## 修复与验收范围

| 编号 | 实施结果 | 本轮状态 |
| --- | --- | --- |
| RA-01 | Promise Flock 与 EffectFlock 共用 LockOwner 诊断；只有同主机、有效 PID 被明确报告 ESRCH 时才允许回收。存活、未知、远端、权限不明均保持占用；breaker 不按年龄删除 | 本机自动验证通过 |
| RA-02 | 通用 Flock.effect 使用可取消 acquireRelease、AbortSignal 和 handoff。取消与取得竞争时等待归属收尾并释放晚到租约；Promise 获取完成后再检查取消与协议 | 本机自动验证通过，覆盖目录与原生后端 |
| RA-03 | 显示错误绑定操作种类、供应商、请求票据和实体代次。同一操作重试成功才清对应错误；旧成功、其他供应商成功、无关操作成功不能吞掉错误 | 状态回归通过，界面待验收 |
| RA-04 | 草稿绑定实体代次。删除、权威快照中消失或 builtin 身份变化会清除旧草稿、关联错误和忙碌归属；旧保存成功及失败均不能作用于同 ID 后继实体 | 状态回归通过，界面待验收 |
| RA-05 | 草稿保存 name/baseURL 比较基线。刷新接纳未编辑字段；远端与本地同时修改的字段保留冲突，重复重载不能清除。保存只提交实际修改字段，继续携带 revision | 状态回归通过，界面待验收 |

字段冲突时保存返回已有的 REVISION_CONFLICT，不发送供应商写入；用户明确编辑对应字段后解除该字段冲突。两套供应商卡片都标记冲突输入为 invalid。复用现有国际化提示，没有修改公开协议、生成客户端或 SDK。

自身保存回包只推进已提交字段的基线，不覆盖请求期间继续输入的名称、地址或密钥。未编辑地址即使带末尾斜杠，也不会因规范化而进入密钥保存的补丁。首次加载未结束时，当前可见内置供应商的密钥仍可输入；供应商已被权威快照删除后，不再创建孤立草稿。

## 自动验证

最终结果，均为退出码 0：

| 检查 | 结果 | 日志目录（证据根之下） |
| --- | --- | --- |
| App 草稿、设置状态、生命周期 3 套件 | **70 pass、0 fail，377 个断言** | `app-last/run.log` |
| Core 锁生命周期、Promise/Effect 目录锁、原生租约、协议选择、原生模块、协议复检 7 套件 | **57 pass、0 fail，159 个断言** | `core-final/run.log` |
| packages/app bun typecheck | 退出码 0 | `app-types-accepted/run.log` |
| packages/core bun typecheck | 退出码 0 | `core-final-types/run.log` |
| packages/opencode bun typecheck | 退出码 0 | `opencode-final-types/run.log` |

证据根：`C:/Users/zh2100/AppData/Local/Temp/opencode-ra-fix-20261112-1794456413654`。

命令从对应包目录执行：

```text
# packages/app
bun test --tsconfig-override ./tsconfig.test.json --conditions=browser --preload ./happydom.ts ./test-browser/relay-settings-drafts.test.ts ./test-browser/relay-settings-state.test.ts ./test-browser/relay-settings-lifecycle.test.ts --timeout 20000
bun typecheck

# packages/core
bun test ./test/util/flock-lifecycle.test.ts ./test/util/flock.test.ts ./test/util/effect-flock.test.ts ./test/util/native-lease-lifecycle.test.ts ./test/util/lock-protocol.test.ts ./test/util/native-file-lock.test.ts ./test/protocol-recheck.test.ts --timeout 20000
bun typecheck

# packages/opencode
bun typecheck
```

Core 新回归使用实际子进程持锁并阻塞心跳，staleMs=150ms、等待 350ms，竞争者超时且原进程存活；没有修改时间戳。另覆盖取消时原持锁者仍被保护、正常作用域持锁、取消竞争中的晚到租约、已退出进程回收、未知锁/breaker 保留，以及四种目录/原生 Promise/Effect 的迁移复检。此短阈值用例不替代默认 60 秒阈值的真实长暂停验收。

App 回归调用实际状态工厂，在可控 API 边界验证字段补丁、重复冲突、保存期间继续输入、删除重建与晚到成功/失败、错误清除归属、首次读取期间输入，以及原有目录分片和跨服务器生命周期边界。它们不等于完整页面或生产 HTTP 验收。

## 首轮问题与验证前提

- 原 Promise 测试中期待按年龄回收未知锁、breaker、被篡改 token 的活进程锁的三项断言，已改为保留并超时。崩溃持锁者回收仍通过。
- U09 旧夹具只返回 A，却保存不存在的 B。现夹具在读取和保存响应中都提供 A/B 两个真实实体，保留双供应商乱序补刷的原断言。
- 扩展原生套件最初失败于隔离副本缺少 `.node`，没有因此修改生产加载器或原生源码。核验现有 manifest 后复制仓库原产物及 manifest 到副本，SHA-256：`2c426d05a8b29757c41668b29794641f4bed2fe77a21ba15e06c0bdbd0dcfba8`，补齐后最终联合套件通过。
- 新增原生包装器测试最初误把 Effect v4 的 Fiber.interrupt 返回值当作 Exit；改为中断后调用 Fiber.await，最终联合套件通过。
- OpenCode 额外类型检查最初因副本的 MCP SDK 链接目标缺失而报错。仅复制主仓库已安装的同版本 SDK 到副本目标后，类型检查通过；未安装或改动主仓库依赖。
- 编辑期间 hook 曾因替换边界过宽被截短，已从本轮开始时一致的隔离源码恢复后重做。恢复源的 SHA-256 为 `6DF04B740A42B350CD0E1D356D21EFA2F3138EB727A3809420B2B82983633EDF`；最终源码通过完整类型检查、回归及主/副本摘要核对，未使用 git checkout 覆盖原有工作。

本轮修改文件及主/副本 SHA-256 对照记录在证据根的 `source-proof.json`。

## 后续真实界面验收

在独立数据目录与端口运行，覆盖两套设置页面：保存失败后重试；编辑密钥时由另一处更新地址并重载；同字段冲突重复重载及用户明确修改；保存中继续输入；删除后重建相同 ID；旧保存回包晚到；首次加载慢时输入密钥。确认字段值、错误提示、冲突标记、候选及勾选列表均与状态契约一致。

本轮没有启动或重启页面服务，因此上述项目保持待验收。未知锁与遗留 breaker 的离线处理、迁移 apply、旧版本隔离、Linux/macOS、Windows 符号链接及已安装打包产物等历史边界均未借本轮关闭。
