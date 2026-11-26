# 修复后继续复核 — 2026-11-12

> 2026-11-12 修复更新：下文保留修复前复现与根因。本轮 RA-01～RA-05 均已落地，App 状态回归 70 pass、Core 锁回归 57 pass，App/Core/OpenCode 类型检查退出码均为 0。设置页面仍待真实界面验收，历史未关闭项保持原状态。详见 [修复结果](D:/opencode/specs/postfix-bug-fix-results-2026-11-12.md)。

本轮确认 5 项尚需修复的问题，均有隔离复现。诊断套件最终为 **2 pass、5 fail**：2 项是正常对照，5 项是按正确行为编写、在当前实现上失败的缺陷断言。不是将既有正式套件的通过统计改为失败，也不代表全仓库只剩这 5 项。

审查范围为当前主工作区及对应独立副本中的通用锁、设置请求状态与草稿生命周期；复读了刚完成的嵌套浮层修复与其 34 项验收边界。本轮没有发现证据推翻 DR-01、DR-02 已通过的本机验收，也没有重跑或扩张那份结论。

## 发现概览

| 编号  | 优先级 | 状态           | 问题                                                        |
| ----- | ------ | -------------- | ----------------------------------------------------------- |
| RA-01 | P1     | 已确认、未修复 | Promise 目录锁按心跳年龄抢占仍存活的持锁者                  |
| RA-05 | P1     | 已确认、未修复 | 旧草稿使用最新 revision，把刷新后的供应商地址覆盖回旧值     |
| RA-04 | P2     | 已确认、未修复 | 删除后重建相同供应商 ID，继承旧地址和未保存密钥草稿         |
| RA-02 | P2     | 已确认、未修复 | Flock.effect 的锁等待处于不可中断获取区域，取消不能及时结束 |
| RA-03 | P2     | 已确认、未修复 | 当前保存失败后重试成功，界面仍保留上次错误                  |

## RA-01：Promise 目录锁仍可抢占存活进程

位置：[stale 判断及回收](D:/opencode/packages/core/src/util/flock.ts:162)，[按年龄删除 breaker](D:/opencode/packages/core/src/util/flock.ts:173)。

触发：业务仍走 legacy 或 path-identity-v1 目录后端；持锁进程由于事件循环阻塞、暂停或系统休眠停止心跳，超过 staleMs 后仍未退出。

当前逻辑只检查 heartbeat/meta/目录时间。达到年龄后直接删除锁目录，没有验证 metadata 中的主机和 PID 是否已明确退出；breaker 也会按年龄删除。EffectFlock 目录路径已经采用保守的进程存活诊断，但 Promise Flock 没有共享那套规则。插件元数据、插件配置、主题和 Flock.effect 使用的模型目录刷新仍有真实 Promise 锁入口。

隔离复现：

1. 创建无迁移标记的独立资源根，子进程通过真实 Flock.acquire() 取得目录锁。
2. 子进程输出 HOLDING 后用 Atomics.wait 阻塞事件循环，保持进程与租约存活。
3. 双方配置 staleMs=150ms，父进程等待 350ms 后用 process.kill(pid, 0) 确认持锁进程仍在。
4. 竞争者调用相同键的 Flock.acquire()。
5. 实际取得第二份租约：holderExit=null、contender=acquired-while-owner-alive。正确断言“不得取得”失败。

没有修改时间戳，也没有触碰正在运行的应用。这里缩短了受支持的 staleMs 参数以验证同一回收分支；没有把它记作默认 60 秒阈值下的长暂停实测。健康持锁者对照保持互斥，通过。

影响：原持锁者恢复后仍可继续原临界区，与竞争者重叠，可能覆盖彼此的写入。这是 R3-03B 仍未关闭范围内的一项具体目录锁安全缺口，与“未知锁不自动恢复”的保守限制不同；不能以原生后端长暂停通过替代本路径验证。

修复方向：让两套目录入口共用所有权诊断和回收规则；只在同主机持锁者被明确判定退出时才考虑回收，未知、存活、远端及权限不明必须保持占用。breaker 不按年龄撤销。把现有 Promise 测试中期待按年龄删除未知锁/breaker 的旧断言同步改为同一契约，并增加暂停及恢复后的真实入口对照。无需等待真实迁移 apply 才能修目录后端。

## RA-05：刷新后以新 revision 提交旧地址

位置：[草稿缓存完整字段](D:/opencode/packages/app/src/hooks/use-relay-settings.ts:623)，[保存完整草稿及当前 revision](D:/opencode/packages/app/src/hooks/use-relay-settings.ts:436)。

触发：

1. 供应商初始地址为 https://old.example/v1。
2. 用户只修改密钥。setDraft() 同时把当前 name/baseURL 复制进整份草稿。
3. 重新加载取得另一处已更新的配置：地址为 https://fresh.example/v1，revision=2。
4. 用户保存密钥。

实际请求仍提交 baseURL=https://old.example/v1，并带 revision=2；最新配置的并发版本检查无法识别这个过时字段。对照中没有旧草稿时，同样的 reload/save 会提交 fresh 地址并通过。

服务端 [RelayAuth.setVendor](D:/opencode/packages/core/src/relay-auth.ts:524) 对有效且非 undefined 的 baseURL 直接写入，因此这不只是输入框显示旧值：旧地址已进入真实保存请求，正常服务端会接受并覆盖新地址。隔离客户端复现记录了真实状态工厂的请求参数，未向生产后端发送请求。

修复方向：草稿记录字段 dirty 状态和比较基线。新 auth 到达时更新未编辑字段；用户编辑字段与远端变更相冲突时明确保留冲突，不能用最新 revision 为旧草稿背书。保存按实际修改字段生成补丁，同时保留服务端 revision 检查。不要简单清空所有草稿，否则会丢掉用户正在输入的值。

## RA-04：删除后重建同 ID 继承旧草稿

位置：[deleteVendor 只清目录分片](D:/opencode/packages/app/src/hooks/use-relay-settings.ts:521)，[draft 只按 vendor.id 读取](D:/opencode/packages/app/src/hooks/use-relay-settings.ts:620)。

触发：对 review 供应商输入未保存密钥；删除它；在同一设置生命周期重新添加名称为 review 的供应商，使用新地址和新密钥。ID 可以合法复用为 review。

实际：auth 已是 https://new.example/v1，draft.baseURL 仍是 https://old.example/v1，且 draft.key 仍是删除前的未保存样本。当前新建实体会显示旧草稿，后续保存或 Fetch models 的 persistDraft() 路径还可能将旧字段再写回。

复现只记录 inheritedOldDraft=true，没有输出密钥内容；所有密钥都是假数据。

修复方向：草稿必须绑定供应商实体生命周期。删除成功、auth 中实体消失以及同 ID 新建时淘汰上一实体的草稿、密钥和关联错误。异步旧操作的收尾也必须检查实体归属，不能清掉后继实体草稿。原有目录 identity/generation 防护不能替代草稿失效。

## RA-02：Flock.effect 取消仍被屏蔽

位置：[Flock.effect](D:/opencode/packages/core/src/util/flock.ts:421)，真实入口：[ModelsDev.refresh](D:/opencode/packages/core/src/models-dev.ts:233)。

Flock.effect 仍将整个 Promise 获取放入默认不可中断的 Effect.acquireRelease，未传 interruptible 选项。虽然 Effect.promise 收到 signal，但外层屏蔽了中断，signal 在等待期间无法按预期响应。依赖源码确认 acquireRelease 只有 options.interruptible 为真时才 restore(acquire)。

隔离复现：先持有同键目录锁；等 waiter 的真实 onWait 通知后请求 Fiber.interrupt；继续持有原锁 1 秒，取消仍未完成。随后释放持锁者，waiter 才完成收尾。不是在请求发出前随意睡眠猜测其是否进入等待。

影响：取消或作用域退出可能一直等到锁释放或获取超时；默认锁超时为 5 分钟。本轮实际观测 1 秒窗口，没有声称真实等满了 5 分钟。

修复方向：通用 Flock.effect 复用已验证的可取消 handoff 与晚到租约释放机制，将等待和不可中断发布所有权区分开。不能只加 interruptible=true 而遗漏取消与取得租约竞争时的释放责任。NL-01 修复在 EffectFlock.acquireNative()，没有覆盖这个独立的通用包装器。

## RA-03：重试保存成功后错误仍显示

位置：[beginAction](D:/opencode/packages/app/src/hooks/use-relay-settings.ts:149)，[saveVendor 成功路径](D:/opencode/packages/app/src/hooks/use-relay-settings.ts:446)。

触发：同一当前供应商的第一次保存返回 UPSTREAM_UNREACHABLE；用户再次保存，第二次正常成功，revision 前进到 2。

实际：store.error 仍为 settings.relay.error.UPSTREAM_UNREACHABLE。当前页面仍渲染错误与 Retry，让用户难以确认实际保存结果。没有旧请求晚到、跨服务器或销毁参与。

根因：clearError() 仅用于 load()；beginAction() 分配新票据但不清除错误，保存等成功路径也没有按错误归属完成清理。

修复方向：错误应绑定产生它的操作与实体，并在当前重试成功后清除相应错误；保留“旧成功不能清掉新失败”和“其他供应商失败不能被无关成功吞掉”的既有契约，不能在任意 Promise 成功后全局清空。

## 为何现有通过项未发现这些问题

- 目录锁有 Promise Flock、通用 Flock.effect、EffectFlock 三个入口，恢复和取消实现没有统一。既有 EffectFlock/NL 验收不能外推至其他包装器，部分 Promise 测试仍期待按时间回收未知锁。
- 设置层已有 catalog 分片的 identity/version 防护，但草稿只按稳定字符串 ID 保存，未覆盖实体删除重建与字段基线变化。
- 错误回归覆盖旧回包不覆盖当前错误，却未覆盖当前操作失败后成功重试的清除。
- 本轮 5 个问题没有证据表明由 DR-01/DR-02 的共享浮层修改引入；不把相邻发现时间当成引入时间。

## 证据与复现边界

证据根：C:/Users/zh2100/AppData/Local/Temp/opencode-postfix-audit-20261112-1794455635221

- [Core 最终日志](C:/Users/zh2100/AppData/Local/Temp/opencode-postfix-audit-20261112-1794455635221/core-final/review.log)：1 pass、2 fail、退出 1。
- [App 最终日志](C:/Users/zh2100/AppData/Local/Temp/opencode-postfix-audit-20261112-1794455635221/app-final/review.log)：1 pass、3 fail、退出 1。
- [Core 临时复现源码](C:/Users/zh2100/AppData/Local/Temp/opencode-postfix-audit-20261112-1794455635221/core-review.test.ts)
- [暂停持锁进程夹具](C:/Users/zh2100/AppData/Local/Temp/opencode-postfix-audit-20261112-1794455635221/postfix-review-worker.ts)
- [App 临时复现源码](C:/Users/zh2100/AppData/Local/Temp/opencode-postfix-audit-20261112-1794455635221/app-review.test.ts)
- [主源与独立副本 SHA-256 对照](C:/Users/zh2100/AppData/Local/Temp/opencode-postfix-audit-20261112-1794455635221/source-proof.json)

命令分别从独立副本 C:/ocdf-dc5c7401 的 packages/core、packages/app 执行：

```text
bun test ./test/util/postfix-review.test.ts --timeout 10000
bun test --tsconfig-override ./tsconfig.test.json --conditions=browser --preload ./happydom.ts ./test-browser/postfix-review.test.ts --timeout 10000
```

归档源码需要放回上述对应包测试目录重放；暂停 worker 与 Core 测试同目录。通过 REVIEW_AUDIT_ROOT 指向独立资源目录，沿用隔离 home/XDG/managed 配置及内存数据库。审查结束后已移除独立副本中本轮三份临时复现文件，证据保留在日志目录。

App 复现调用实际 createRelaySettingsState 工厂，API 为可控边界；不是完整设置页或真实服务端 HTTP 验收。Core 复现使用实际目录锁、实际子进程与 Effect 运行时，不加载原生后端。

仅新增本报告，未修改业务代码、主工作区依赖、公开协议或 SDK。没有提交、推送、重启应用或服务器；没有写生产配置、凭据或迁移标记。持锁子进程均由测试 finally 终止并等待退出。

历史 OA-06/UI01～UI08、R3-03B 和 RF-07 跨平台等仍保持未关闭，完整边界以此前记录为准。
