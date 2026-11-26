# 图片设置锁等待证据：阶段 0 实施结果

## 状态

**最小 seam、replacement 和真实等待验证已实施；API surface 门禁未通过，阶段 0 整体尚未关闭。不得进入 T07a/T10 正式测试改造或升级验收矩阵。**

## 本轮变更

- `packages/core/src/util/effect-flock.ts`：增加 `@internal` 的 `EffectFlock.layerWith({ onWait })` 与只包含 `key`、`lockfile` 的 `WaitObservation`；默认 `layer = layerWith()`，公开 `Interface` 不变。
- 通知只发生在 `waitWhileHeld` 中：目标 lockfile 的 stat 成功、没有 breaker、diagnosis 为 `live-owner`，且即将返回 `NotAcquired`。stat 错误仍保守地进入原有 busy 分支，但不产生等待证据。
- 观察回调同步调用，异常被隔离；默认路径不构造观察事件。非阻塞是调用方约束，不能从运行时强制保证任意回调不会阻塞。
- `packages/core/test/support/effect-flock-test-layer.ts`：只组装真实 Layer，显式声明 Global/FSUtil 依赖，不复制锁实现。
- `packages/core/test/util/effect-flock-test-layer.test.ts`：验证 service、name、global tag、依赖、类型兼容、默认锁复用、真实等待和回调异常隔离。通过 pass-through spy 验证 settings 传给 ConfigDocument 的 flock 与直接获取的服务为同一对象；spy 不发送等待通知。
- 正式 IMG-T07a/T10 文件没有修改。

## 验证

环境：Windows；Bun 1.4.3 (c6da4a4d3)。

从 `packages/core` 执行：

```text
bun typecheck
node D:/opencode/script/test-isolated.mjs test test/util/effect-flock-test-layer.test.ts test/config/document.test.ts test/image-generation-settings.test.ts
```

- Core typecheck：退出码 0。
- 最终联合测试：29 pass / 0 fail，196 expect，3 文件；其中阶段 0 测试 5 个。
- 早期最小测试：4 pass / 0 fail（增加 API audit 用例前，不是最终候选）。
- 日志：`specs/evidence/image-settings-lock-wait-stage0-2026-11-17/`。
- 初次类型检查发现当前 Effect 不支持 `interruptWhen`，已改用当前仓库存在的 forkChild / Fiber.interrupt / Fiber.await；最终包级检查通过。

## 未通过的 API surface 门禁

Core package.json 已存在 `"./*": "./src/*.ts"` 通配符导出。只要在现有 `EffectFlock` namespace 导出 `layerWith`，它就可通过 `@opencode-ai/core/util/effect-flock` 访问；`@internal` 注释不会限制实际导入。阶段 0 API audit 测试刻意确认了这一事实，其测试通过表示审计复现成功，不表示隔离门禁通过。

本轮未修改 package exports，也未新增 SDK、barrel 或运行时配置入口；但不能据此声称 seam 未进入对外包入口。按照方案的严格标准，该项失败。

后续需另行确定一种边界：

1. 调整内部实现的模块/导出边界，让测试从相对源码路径访问工厂，同时保持现有 EffectFlock 公共入口不暴露 hook；或
2. 明确接受 private Core 包中可直接导入但不受支持的 internal seam，并修订原有严格 API 隔离要求；或
3. 按原方案评估 B，但不能将普通 stat 误作 live-owner/NotAcquired 边界证据。

本轮保留可审查实现，不自动扩大为包出口重构或方案 B。

## 后续风险

方案 4.5 仍存在“异常时一律释放 holder”和 T07a“保存 fiber 未终止不得释放 holder”的冲突。阶段 0 测试采用同一父 fiber 持锁、子 fiber 保存并在正常路径确认中断，不等同于落实正式测试的极端超时终止方案。正式测试改造前仍需解决不响应中断时的隔离进程/终止策略，不声称 scope 清理可以强制终止任意协作式 fiber。

未运行 Docker、其他 Bun 版本、Server/OpenCode 门禁、GUI/EXE；未验证跨平台、第二主体或崩溃持久恢复。此前完整候选哈希门禁不能覆盖本轮新候选。
