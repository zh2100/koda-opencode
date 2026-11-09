# NL-01 / NL-02 本机 Windows 分项验收报告

日期：2026-11-09。

结论：**NL-01、NL-02 本机 Windows 自动验收通过，可以按该范围关闭。R3-03B 整体仍未关闭。**

本报告来自本次实际重跑，不以先前复核结果代替验收。本轮只新增验收文档与证据、追加状态记录，没有修改业务代码、重建模块、重启应用、启用迁移 apply 或写生产标记，没有提交代码。

## 1. 验收范围与基线

- 范围：Effect 原生锁等待取消与晚到租约收尾；诊断探测锁释放；probe 调用者作用域持锁；相关模块身份与迁移门禁回归。
- 平台：Windows / win32 / x64。
- 测试运行时：Bun 1.4.3。独立验收进程的 `process.version` 为 v26.3.0，这是 Bun 报告的兼容版本。
- 本机独立 Node CLI：v24.19.0。本次核心验收由 Bun 执行，不把本机 Node CLI 版本当作此次执行运行时。
- 仓库 HEAD：`b80464fbe6cb7f1df67feeaae8887d51b201840b`。工作区存在未提交修改，结论对应工作区文件摘要，而非仅对应 HEAD。
- 原生产物：`packages/core/native/dist/process-lock-win32-x64.node`，使用现有产物，没有重新构建。
- 模块 SHA-256：`2c426d05a8b29757c41668b29794641f4bed2fe77a21ba15e06c0bdbd0dcfba8`，与现有清单一致。

机器可读证据：[nl-acceptance-evidence-2026-11-09.json](./nl-acceptance-evidence-2026-11-09.json)。其中保存了独立场景结果、源码和测试文件摘要，以及原生产物摘要。

## 2. 自动回归与类型检查

所有命令均从 `D:\opencode\packages\core` 执行。

| 验收项 | 实际命令 | 结果 | 退出码 |
| --- | --- | --- | --- |
| 生命周期、迁移复检、路径与原生锁 | `bun test test/util/native-file-lock.test.ts test/util/native-lease-lifecycle.test.ts test/protocol-recheck.test.ts test/path-resolution.test.ts --timeout 20000` | 19 通过，0 失败，64 个 expect，36.15 秒 | 0 |
| 通用 Effect / Promise 锁回归 | `bun test test/util/effect-flock.test.ts test/util/flock.test.ts --timeout 30000` | 29 通过，0 失败，72 个 expect，26.37 秒 | 0 |
| Core 类型检查 | `bun typecheck` | 通过 | 0 |

本次共 48 项自动测试通过，没有失败后重跑或临时放宽用例断言。工作区历史记录中的 ready 超时属于之前执行，本次没有重复出现。

## 3. 独立隔离验收

在自动测试之外，通过独立 Bun 进程直接调用真实 `EffectFlock`、`Flock`、`NativeFileLock`，使用临时 HOME/XDG 资源根和完成注册的 os-lock-v1 根。所有验证在进程仍存活时完成，不依赖退出钩子释放来证明成功。

| 场景 | 实际观察 | 结论 |
| --- | --- | --- |
| 连续两次诊断空闲原生锁 | 两次均为 absent；随后直接获取为 acquired | 通过，未复现 NL-02 |
| 原持有者占用时取消 Effect 等待者 | 退出原因包含 interruption；业务没有进入；取消后原锁仍为 busy | 通过，取消没有破坏原持有者 |
| 取消后释放原持有者 | 再经过一个观察窗口后，竞争者取得 acquired 并显式释放 | 通过，未复现 NL-01 后台遗留锁 |
| probe 调用者作用域 | 作用域内 probe 为 acquired，竞争者为 busy；作用域结束后竞争者为 acquired | 通过，持锁范围正确 |
| 持锁业务正常结束 | 结束后可取得相同锁 | 通过 |
| 持锁业务失败 | 确认业务失败退出后，可取得相同锁 | 通过 |
| 持锁业务被取消 | 先通过同步信号确认已经进入持锁业务，再取消；结束后可取得相同锁 | 通过 |

证据 JSON 将“取消等待者及原持有者收尾”作为一个场景，因此独立场景数为 6。不要将这些场景数与自动测试项数混为一组测试计数。

## 4. 方案验收点映射

| 方案编号 | 本次验收证据 |
| --- | --- |
| NL-T01、NL-T02 | 生命周期自动回归，以及独立取消等待者与再次获取验证 |
| NL-T03 | 生产 `NativeFileLock.handoff` 的受控晚到租约测试，验证取消后不 resume、释放一次 |
| NL-T04、NL-T05 | 生命周期自动回归，以及独立连续诊断、返回后直接获取验证 |
| NL-T06 | 真实持锁进程的诊断回归，原持有者随后正常释放 |
| NL-T07、NL-T08 | 自动回归与独立 probe 作用域内 busy、作用域外 acquired 验证 |
| NL-T09 | 自动回归，以及独立成功、失败、取消三条路径分别验证重新获取 |
| NL-T10 | 生产 handoff 的释放拒绝测试，确认失败可见；没有注入真实操作系统 UnlockFileEx / CloseHandle 失败 |
| NL-T11 | Promise / Effect × 目录锁 / 原生锁四项迁移门禁回归 |
| NL-T12 | 双模块绑定释放回归 |

边界测试与真实入口测试承担不同证据范围：晚到交接、释放拒绝由生产 helper 的受控测试覆盖；取消、诊断、持锁范围由真实模块和业务入口覆盖。本报告不将 helper 的受控错误测试写成操作系统失败注入验收。

## 5. 关闭结论与保留项

| 项目 | 状态 |
| --- | --- |
| NL-01：取消等待后后台取得并遗留原生锁 | 本机 Windows 自动验收通过，关闭 |
| NL-02：diagnose 遗留探测锁 | 本机 Windows 自动验收通过，关闭 |
| R3-03B 整体 | 未关闭 |
| Linux/macOS | 未在本次验收 |
| 已安装 Electron、Bun 编译单文件 | 未在本次验收 |
| 真实离线迁移、旧协议切换及生产目录保护 | 未在本次验收；apply 仍禁用 |
| 设置列表、刷新等真实界面流程 | 未在本次验收，保持原界面待验收状态 |

本报告仅批准上述两项在本机 Windows 的自动验证范围。部署环境、跨平台、安装包和界面验收不能由这次结果替代。
