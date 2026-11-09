# R3-03B 原生锁租约生命周期修复实施方案

日期：2026-11-09。

状态：方案已记录，本文不代表修复已实施。两项缺陷均未关闭，R3-03B 整体仍未关闭。

## 1. 目标与范围

修复 Effect 原生锁的两处已复现泄漏：取消等待后底层 Promise 继续获取锁；原生诊断取得探测锁后未释放。

主要修改文件：

| 文件 | 计划修改 |
| --- | --- |
| `packages/core/src/util/effect-flock.ts` | 修复 `acquireNative()` 的取消交接；让 `nativeLease()` 统一管理作用域释放；调整 `diagnose()`、`probeOnce()` |
| `packages/core/test/util/native-file-lock.test.ts` | 增加原生诊断、取消等待、作用域持锁的回归 |
| `packages/core/test/fixture/` | 按需增加真实持锁进程及同步信号 fixture |
| `packages/core/src/util/flock.ts` | 原则上复用现有接口；只有取消回归证明底层收尾仍存在缺口时才补充修改 |
| `specs/round3/status-2026-11-09.md` | 实施后记录实际修改、命令、结果及未完成项 |

本方案不启用迁移 `apply`，不修改生产根标记，不重启正在运行的应用，不提交代码。公共 Protocol、Server HttpApi 不在计划修改范围内，无需因此重新生成客户端。

继续保留旧根的目录锁兼容路径、已接入的 `LockProtocol.confirmCurrent()`、模块绑定的租约释放闭包和双模块回归。不得重新引入按当前模块目录释放裸 token 的接口。

## 2. 已确认缺陷与证据

### NL-01：取消等待后，后台 Promise 仍取得并遗留原生锁

优先级：P1。状态：已复现，待修复。

位置：`packages/core/src/util/effect-flock.ts` 的 `acquireNative()`。

根因：

1. `Effect.promise(async () => ...)` 没有把取消信号传给 `Flock.acquire()`。
2. 租约返回后，再通过 `flatMap` 登记 finalizer。
3. Effect 等待已被取消时，Promise 仍可能继续取得锁；此时后续登记释放的 Effect 已不会执行。

隔离复现顺序：

1. Promise 持有原生锁。
2. 启动 Effect 等待相同锁。
3. 取消 Effect 等待者，并等待其结束。
4. 释放原持有者。
5. 已取消者未进入业务，但新竞争者仍返回 `busy`。

观察结果：`exit = Failure`、`businessEntered = false`、`afterHolderRelease = busy`。修复后的测试还必须检查 Failure 的原因包含 interruption，不能仅把任意失败视为取消成功。

### NL-02：原生 diagnose 遗留探测锁

优先级：P2。状态：已复现，待修复。

位置：同文件的 `nativeLease()` 与 `diagnose()`。

根因：`nativeLease()` 已改为返回 `{ token, release }`，不再登记 finalizer；`diagnose()` 仍使用 `Effect.scoped(nativeLease(file))`，但作用域内没有实际可执行的释放登记。

隔离复现中，预先创建原生协调目录后连续诊断同一空闲锁：

| 观测点 | 当前实际结果 | 修复后应有结果 |
| --- | --- | --- |
| 第一次诊断 | `absent` | `absent` |
| 第二次诊断 | `live-owner` | `absent` |
| 诊断返回后直接获取 | `busy` | `acquired` |

上轮复核中，迁移复检、模块绑定与路径相关的现有测试 18 项通过，Core 类型检查通过。这些结果没有覆盖本节两种泄漏，不能据此关闭缺陷。

## 3. 必须保持的生命周期约束

1. 等待锁期间可取消，不能把完整等待过程放入不可中断区域。
2. 取得租约后，必须由作用域或取消清理接管。
3. 取消与获取成功同时发生时，晚到租约必须释放。
4. 释放始终调用租约自己的闭包，不重新选择原生模块。
5. 获取返回 `busy` 时，不释放任何其他持有者的锁。
6. 获取失败与释放失败分别处理；获取失败可以在取消清理中收尾，释放失败不能被吞掉。
7. 诊断返回前必须释放自己的探测租约；业务 `probe()` 的租约必须持续到调用者作用域结束。
8. 取得锁后的协议复检继续执行。复检失败必须释放租约，禁止进入业务。

## 4. 实施步骤

### 步骤一：先补失败回归

先增加第 5 节的诊断和取消回归。在未修改实现时确认 NL-01、NL-02 的核心用例失败，并保存具体断言输出。

测试必须使用隔离资源根和真实原生模块。导入会初始化 Global 的模块前，先设置隔离的 HOME/XDG 环境；不要让测试读取或写入生产根。

等待阶段使用可观察的同步信号，不能仅以“原持有者的锁文件存在”认定等待者已经进入获取流程。交接边界需要受控 Promise 或 Deferred；若为此提取桥接 helper，该 helper 必须实际服务于生产入口，不在测试中复制实现，也不替换全局函数。

### 步骤二：修复 acquireNative 的取消与租约交接

使用当前 Effect 版本已有的 `Effect.callback` 与 `Effect.acquireRelease(..., { interruptible: true })`。

具体顺序：

1. 在 callback 中创建一次 `Flock.acquire()` Promise。
2. 将 callback 提供的 `AbortSignal` 传入 `Flock.acquire()`。
3. 获取成功后，用 `resume(Effect.succeed(lease))` 交给资源管理入口。
4. 获取失败后，用 `resume(Effect.fail(nativeError(cause)))` 返回现有错误通道。
5. callback 返回取消清理 Effect：等待同一个 Promise 结束；若获得晚到租约，释放它。
6. 外层 acquireRelease 为正常获取到的租约登记作用域释放。
7. 删除现有 acquired/blocked 中间结果包装及“Promise 返回后再自行登记 finalizer”的路径。

参考结构如下，落地后仍需运行类型检查和竞态测试：

```ts
const acquireNative = (key: string, dir?: string) =>
  Effect.acquireRelease(
    Effect.callback<Flock.Lease, LockCompromisedError>((resume, signal) => {
      const pending = Flock.acquire(key, {
        context: global.lockContext,
        dir,
        signal,
        timeoutMs: TIMEOUT_MS,
      })

      pending.then(
        (lease) => resume(Effect.succeed(lease)),
        (cause) => resume(Effect.fail(nativeError(cause))),
      )

      return Effect.promise(() =>
        pending.then(
          (lease) => lease.release(),
          () => undefined,
        ),
      ).pipe(Effect.orDie)
    }),
    (lease) => Effect.promise(() => lease.release()).pipe(Effect.orDie),
    { interruptible: true },
  ).pipe(Effect.asVoid)
```

上面取消清理中的 rejection 分支仅处理“获取没有成功”。如果 `lease.release()` 拒绝，错误继续暴露，不能被该分支吞掉。取消清理需等待底层 Promise 收尾，避免测试或调用者已经结束，后台仍在获取资源。

### 步骤三：让 nativeLease 统一登记作用域释放

将一次同步、非阻塞的原生获取包装为作用域资源。

```ts
const nativeLease = (file: string) =>
  Effect.acquireRelease(
    Effect.try({
      try: () => NativeFileLock.tryAcquire(file),
      catch: nativeError,
    }),
    (result) =>
      result.status === "busy"
        ? Effect.void
        : Effect.try({
            try: () => result.release(),
            catch: nativeError,
          }).pipe(Effect.orDie),
  ).pipe(
    Effect.map((result) =>
      result.status === "acquired" ? result.token : undefined,
    ),
  )
```

这里保留 acquireRelease 默认的不可中断获取，因为原生调用只尝试一次，不包含等待或退避。这样取得锁与登记释放之间没有可中断空档。

删除 helper 中已被资源管理替代的手动释放状态与返回的 release 字段。不要新增另一套根据裸 token 查找模块的释放机制。

### 步骤四：调整诊断与单次探测入口

| 入口 | 具体修改 | 租约结束时间 |
| --- | --- | --- |
| `diagnose()` | 保留内部 `Effect.scoped(nativeLease(file))`，使用新的作用域 helper | 诊断返回前 |
| `probeOnce()` 的 native 分支 | 使用新的 helper；删除手动登记 `held.release` 的代码 | 调用者作用域结束时 |
| `probe()` / `tryAcquire()` | 保持现有调用者 Scope 语义，复查返回值转换 | 同上 |

不要在 probeOnce 内增加局部 scoped，否则它会在返回 acquired 前释放锁，破坏调度恢复所依赖的互斥。原生获取与 finalizer 登记也不能拆成“只保护获取、随后在可取消区域登记释放”的两段。

### 步骤五：确认协议门禁与模块身份没有回退

1. 保留 Promise 获取过程中的 confirmCurrent 与取得后的确认。
2. 保留 Effect 目录锁的取得后复检。
3. 复跑四种迁移门禁组合，确认拒绝写入后可以重新获取原锁。
4. 复跑双模块回归，确认模块目录变化后仍只释放原模块的租约。
5. 对 probe 分支复核“先登记释放，再作取得后校验，再返回 acquired”的顺序；任何校验失败都不能遗留租约。

## 5. 回归测试清单

| 编号 | 场景 | 必须断言 |
| --- | --- | --- |
| NL-T01 | 原持有者未释放时取消 Effect 等待者 | 在有界时限内取消；退出原因包含 interruption；原持有者仍有效 |
| NL-T02 | 取消完成后释放原持有者 | 新竞争者取得锁；已取消者不进入业务；没有后台遗留租约 |
| NL-T03 | 取消与获取成功发生在交接边界 | 晚到租约被释放；最终竞争者可以取得锁 |
| NL-T04 | 连续两次诊断空闲原生锁 | 两次均为 absent |
| NL-T05 | diagnose 返回后立即获取 | 直接获取成功，并可释放 |
| NL-T06 | 诊断另一个进程持有的锁 | 返回 live-owner；原持有者仍能正常释放 |
| NL-T07 | probe 返回 acquired 后保持作用域打开 | 独立竞争者返回 busy |
| NL-T08 | probe 的调用者作用域结束 | 竞争者可取得锁 |
| NL-T09 | 持锁业务成功、失败和取消 | 三条路径结束后均能再次获取，不遗留锁 |
| NL-T10 | 释放过程失败 | 失败可见，不伪装成成功或普通 busy |
| NL-T11 | Promise/Effect × 目录锁/原生锁迁移复检 | migrating 阻止业务；失败收尾释放资源 |
| NL-T12 | 双模块各生成相同 token | 释放 A 不释放 B；A 能重新取得，B 保持占用 |

实施测试的约束：

- 实际互斥与锁释放必须在持锁测试进程仍存活时验证，不能依赖退出钩子代替实现释放。
- worker 用 ready、release 等同步信号控制；超时只用于防止测试挂住，不以固定 sleep 证明正确性。
- 可以在最后清理时结束自己创建的 worker，但要等待实际进程 close 后再删除目录。
- 核心失败回归应在修改前暴露问题，修改后通过；不能只检查没有抛异常。
- 需要受控失败的桥接单元测试使用实际生产 helper 的参数边界，避免全局 monkeypatch。

## 6. 验证命令

从 `D:\opencode\packages\core` 执行，不从仓库根目录运行测试：

```powershell
bun test test/util/native-file-lock.test.ts test/protocol-recheck.test.ts test/path-resolution.test.ts --timeout 15000
bun test test/util/effect-flock.test.ts test/util/flock.test.ts --timeout 30000
bun typecheck
```

如果新增独立测试文件，将其加入第一组命令。只有真实需要的慢跨进程测试才设置合适时限；记录首次超时和重跑结果，不通过放宽时限掩盖锁遗留。

本方案不要求重新构建 C++ 模块：计划修改集中在 TypeScript 租约生命周期。若实施中发现必须改原生源码，应另列原因、重新构建并验证模块摘要与清单，不能继续沿用旧产物的验收结论。

## 7. 实施完成记录与关闭条件

实施后在状态记录追加：

1. 实际修改的文件和生产入口。
2. NL-T01 至 NL-T12 的覆盖位置、实际输出与未覆盖项。
3. 测试命令、通过/失败数量、退出码；首次失败与重跑分别记录。
4. Core 类型检查结果。
5. 是否修改原生源码、是否重建产物，以及使用的平台与运行时。

仅当取消后无遗留锁、诊断后无遗留锁、probe 的作用域互斥正确、模块绑定释放正确，且原四种迁移门禁组合继续通过，才能关闭 NL-01 与 NL-02。

即使本方案全部完成，也不关闭 R3-03B 整体。Linux/macOS、已安装 Electron、真实迁移等既有验收范围继续单独记录；迁移 apply 仍保持禁用。
