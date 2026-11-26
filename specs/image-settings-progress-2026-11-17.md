# 图片设置剩余修复：2026-11-17 本轮进度

> 此为此前进度快照。后续补测、BOM 实际缺陷修复及同候选原始证据已完成，最新结论见 [剩余项结果](./image-settings-remaining-results-2026-11-17.md)；以下历史计数与缺口不覆盖最新记录。

## 结论

本轮新增永久回归并执行三包联合门禁；尚不宣布剩余方案全部完成或 IMG-R4 完整通过。

## 实际修改

- `packages/core/test/config/atomic-document.test.ts`：新增 CL-09 replace、publishCopy 提交后 rmdir 一次失败；验证 cleanupPending、显式 retryCleanup 清零、目标字节及 inode 不变、无二次准备；publishCopy 另验证源不变和已有目标拒绝。
- `packages/core/test/image-generation-settings.test.ts`：新增 IMG-T07a 真实锁持有期间取消、无发布/无租约泄漏；原取消项命名 IMG-T07b；新增 IMG-T08 初始读取失败、持锁后读取失败、无效文档，验证安全错误、无发布、旧字节不变、无阶段目录、租约可获取。
- `packages/server/test/image-generation-settings-handler.test.ts`：新增普通 Error 经真实 Service/HTTP 的安全映射和单次 publish 调用。
- 生产错误映射曾临时改为将普通 Error 归类 unavailable，随后撤回：普通 Error 本身不能证明未提交。当前保留 unknown/reconciliation，只有明确 prepare 的 CommitError 才承诺未替换。初始失败是测试预期不正确，不据此登记产品缺陷。
- 未改 HTTP 契约、锁协议或 drainWithCause。

## 实际测试记录

所有测试从对应包目录使用 `node D:/opencode/script/test-isolated.mjs test --timeout 30000 ...`；Bun 1.4.3 (c6da4a4d3)，Windows。

| 包 | 测试文件参数 | 结果 | 退出码 | 隔离根末段 |
| --- | --- | --- | --- | --- |
| core | test/config/atomic-document.test.ts test/config/document.test.ts test/settled-io.test.ts test/image-generation-settings.test.ts test/scheduled-task-cancel.test.ts | 95 pass / 1 skip / 0 fail；511 expect | 0 | opencode-owned-test-kruLE5 |
| server | test/image-generation-settings-handler.test.ts test/relay-auth-handler.test.ts test/relay-commit-handler.test.ts test/relay-catalog-lifecycle-handler.test.ts test/relay-probe-completion-handler.test.ts | 22 pass / 0 fail；255 expect | 0 | opencode-owned-test-pmAvuh |
| opencode | test/config/atomic-entry.test.ts test/config/tui.test.ts test/config/config.test.ts | 198 pass / 0 fail；531 expect | 0 | opencode-owned-test-ILqH9c |

完整隔离根前缀：`C:\Users\zh2100\AppData\Local\Temp\`。

Core / Server 的最近一次 `bun typecheck` 均退出 0；OpenCode `bun typecheck` 在本轮此前执行退出 0。并非方案要求的隔离 runner typecheck，不冒充完成该项。

OpenCode 联合门禁输出被工具保存至 `C:\Users\zh2100\.local\share\opencode\tool-output\tool_1e8f7068c001HTSLd9T2OzkpE4`；摘要及退出码已明确返回。其余联合日志仅在工具调用记录中，未伪造为已保存的原始日志文件。

唯一 skip：POSIX replacement preserves owner, group and restricted mode。Windows skip 不代表 POSIX 通过。

## 仍需完成

- CL-09 完整适用权限/版本矩阵仍需逐入口映射，不能仅凭新增两个清理测试关闭全部 CL-09。
- IMG-T07b 原测试为执行前取消；还需增强已存在文件字节及租约直接断言，不能与新增 T07a 合并后宣称完整闭合。
- IMG-T10 当前是在取得锁后、锁内重读前制造目标变化；不等同真实等待锁期间变化，标题不能替代语义证据。
- IMG-T08 alias 可参考 F29/F33，但仍需逐断言映射安全错误和 publication 计数。
- 并发定向连续三轮尚未执行。
- 同候选原始日志归档、开始结束时间、候选前后 SHA-256 清单及最终矩阵尚未完成。
- uncertain 安全恢复未实现；Bun 1.3.14、Linux/macOS、第二主体、恶意路径替换窗口、GUI/EXE、崩溃持久恢复未验证。

没有提交/推送、reset/stash、构建或启动 EXE，没有清理无关工作区改动。
