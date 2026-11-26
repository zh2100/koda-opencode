# 图片设置剩余项：最新本机修复与验收结果

日期：2026-11-17。最新入口；历史进度不覆盖。

## 结论

本次列出的 CL-09、IMG-T07a/b、IMG-T08、IMG-T09 普通异常、IMG-T10 直接断言缺口已补齐，并通过同候选 Windows 自动门禁。新增真实服务回归发现并修复一处 **BOM 配置无法保存** 的实际缺陷。完整 IMG-R4、跨平台及 uncertain 安全恢复仍不宣布通过。

## 生产修复与失败证据

唯一生产调整位于 `packages/core/src/image-generation-settings.ts`：图片设置读取从 `readFileString` 改为 `readFile` 后 Buffer UTF-8 解码，保留 BOM。Effect 的字符串解码会剥离 BOM，而 AtomicDocument 使用保留 BOM 的原始 UTF-8 文本作版本核对，导致既有 BOM 文件被误判为版本冲突。补丁同时保留原有读取错误、安全分类和锁内重读流程。

新增 `IMG-T10 normal save agrees with get and disk while preserving BOM CRLF and comments` 在修改生产代码前实际失败：81 pass / 1 skip / 1 fail，退出 1；原始输出和当时哈希在 `specs/evidence/image-settings-remaining-2026-11-17/bom-red/`。同一测试不放宽断言，修复后通过。

普通 Error 继续归类 unknown/reconciliation；只有明确 prepare 的 CommitError 才承诺未替换。不改 HTTP 契约、AtomicDocument、锁协议或 drainWithCause；无需重新生成 SDK。

## 永久回归补齐

- CL-09：create、replace、publishCopy 各自提交后 rmdir 失败，显式 retryCleanup 不重新准备/发布，字节及 inode 不变；retire EACCES 保留责任与恢复；同 inode 摘要变化拒绝；publishCopy 竞争创建拒绝覆盖。权限及版本适用范围逐入口映射，不给 retire 或 publishCopy 添加不存在的接口承诺。
- IMG-T07b：取得真实租约后在 publication 投递前中断，publish=0，已有文本不变、无阶段残留、租约可再次取得。
- IMG-T08 alias：增加 code、固定安全文案、路径/原文不泄露和 publication=0；与初始读取、持锁读取及无效文档四项分别验收。
- IMG-T10：真实锁等待期间创建高优先级文件，放锁后 conflict，两份文本不变且 publish=0；正常保存另验证返回/get/磁盘和 BOM/CRLF/注释。
- HTTP 成功待清理：故障持续时计数 1/1；恢复清零，只发布一次，字节/inode 不变，无阶段残留。
- F1-07/F2-05 恢复直接改写的 writeFile，F2-04/F2-05 收拢并等待扫描任务。

## 最新同候选门禁

全部从包目录经 `node D:/opencode/script/test-isolated.mjs` 执行。开始/结束时间、完整命令、工作目录、隔离根、日志 SHA-256 和退出码见 `runs.json`，完整 stdout/stderr 合流原文见对应 `.log`。

| 门禁 | 实际结果 | 退出码 |
| --- | --- | --- |
| Core 定向三文件 | 82 pass / 1 skip / 0 fail；467 expect | 0 |
| 并发定向第 1 轮 | 19 pass / 0 fail；124 expect | 0 |
| 并发定向第 2 轮 | 19 pass / 0 fail；124 expect | 0 |
| 并发定向第 3 轮 | 19 pass / 0 fail；124 expect | 0 |
| Core 联合五文件 | 100 pass / 1 skip / 0 fail；555 expect | 0 |
| Server 联合五文件 | 22 pass / 0 fail；262 expect | 0 |
| OpenCode 联合三文件 | 198 pass / 0 fail；531 expect | 0 |
| Core 隔离 run typecheck | 完整检查通过 | 0 |
| Server 隔离 run typecheck | 完整检查通过 | 0 |
| OpenCode 隔离 run typecheck | 完整检查通过 | 0 |

唯一 skip：`POSIX replacement preserves owner, group and restricted mode`，原因是 Windows。三轮为三个独立进程/隔离根，不合并重复通过数充当新增覆盖。

## 候选与归档

证据目录：[`evidence/image-settings-remaining-2026-11-17/`](./evidence/image-settings-remaining-2026-11-17/)。

- `baseline.json` / `final.json`：覆盖三包 src/test、包配置、锁文件、隔离 runner 等 1486 个文件（含未跟踪文件），门禁前后 `changed: []`。
- `runs.json`：十次门禁的完整运行元数据；`.log`：原始输出。
- `matrix.md`：IMG-T01～10、CL-01～10、相关 F1/F2/C 的逐断言映射及限制。
- `bom-red/`：修复前真实失败，不伪造历史红测。
- `bom-green-before-http-strengthening/`：HTTP 增强前的中间绿色候选，保留历史；不是最新验收候选。
- `verify.py`：此次实际运行的采集脚本。

HEAD 为 `6b051f12a21094df1adef83f9fddfcbb765b319e`，分支 dev，Windows / Bun 1.4.3。工作区未提交，HEAD 不足以唯一确定候选，以 baseline/final 文件哈希为准。

关键摘要：

| 文件 | SHA-256 |
| --- | --- |
| core/src/config/atomic-document.ts | 27d9ee118ff8a0941cc2376b8af9ca8154955e34ae98dc8b53f9fe044e416a46 |
| core/src/image-generation-settings.ts | 43de82f3e8aab4c64bc3b880367e4b88a57ae157634a85161171347df4b31226 |
| core/test/config/atomic-document.test.ts | 69db96a878b2a6908826e7a4dc4d75c238b9d3a45cc641f2dea22f9219e765b3 |
| core/test/image-generation-settings.test.ts | dbdc1d72d2860ab242ce12bc6989431b03d6b8c4aecd290549186035708601a3 |

路径表中的包文件均以 `packages/` 为前缀；HTTP 最新摘要以 baseline.json 为准。

## 不扩大结论

- uncertain close rejection 仍保守保留，不自动重试关闭、不按裸 fd 关闭、不误删、不把子进程退出或夹具回收当成产品恢复。
- Bun 1.3.14、Linux/macOS 权限准备失败、第二主体访问、恶意路径替换窗口、GUI/EXE、崩溃持久恢复均未运行。
- B2 的本机直接方法恢复/任务排空已增强；并未重构每个历史用例的全部异常收尾，亦未新增覆盖全部 close 竞争组合的独立闸门。因此不声称原方案 A～E 所有强化子项或完整 IMG-R4 全部关闭。
- 未构建/启动 EXE、未提交/推送、未 reset/stash、未覆盖或删除无关工作区修改。
