# FUP-02 设置页验收（2026-11-13）

本机两套真实设置页验收通过。最终联合 9 passed、0 failed、0 skipped、0 flaky，退出码 0，98.4 秒。Relay E2E 类型检查退出码 0。本轮未发现新的产品缺陷，没有修改业务实现。

FUP-02 可按本机 Windows / Chromium、两套设置布局的并发刷新及弹窗生命周期范围验收关闭。现代设置页额外通过实际服务器选择器的跨服务器旧回包隔离；经典布局没有同样的设置页选择器，本轮没有验收其全局切服务器流程。历史完整 UI、R3-03B、RF-07 跨平台、已安装包与其他未覆盖场景均不扩大关闭。

## 实际场景

| 场景 | 经典布局 | 现代布局 | 关键断言 |
| --- | --- | --- | --- |
| A、B 都请求中，A 先完成 | 通过 | 通过 | 两行均显示 Fetching 并禁用；A 完成后 B 仍显示 Fetching 并禁用；最终两行恢复 Get models |
| A、B 都请求中，B 先完成 | 通过 | 通过 | B 完成后 A 仍显示 Fetching 并禁用；两个真实模型列表均出现 |
| B 的真实上游返回 503，A 尚未完成 | 通过 | 通过 | B 显示上游不可达、恢复按钮；A 仍处于刷新中；A 最终成功 |
| 关闭设置、重新打开并发起新刷新，再放行旧回包 | 通过 | 通过 | 新实例初始不继承旧忙状态；新请求开始后，旧请求收到合法 409 也不能清掉新请求忙状态；新请求实际成功 |
| 设置页头部服务器选择器从 A 切到 B，再放行 A 回包 | 不适用此选择器；全局切换流程未验收 | 通过 | B 的名称、地址和忙状态不被 A 改写；A 模型不出现在 B；B 最终只显示自身模型 |

上述为 9 项实际执行用例，没有把不适用或未执行项记成框架通过。最终所有用例均断言无 pageerror。测试通过真实点击、可见文本、按钮 disabled 属性、checkbox 和真实 HTTP 结果验证；不手改 store、不伪造成功响应，不通过页面重载替代请求收尾。

## 环境与隔离

主项目 D:/opencode；实际运行主工作区的前端和后端源码。前端 127.0.0.1:44444，后端 A 为 127.0.0.1:44096，后端 B 为 127.0.0.1:44098，本地测试上游为 127.0.0.1:44097。

数据根分别为 C:/fup-ui-20261113/primary/data/opencode 与 secondary/data/opencode。home/config/state/cache/managed/tmp 同样隔离。使用假供应商、假密钥、测试文件凭据适配器，不调用系统凭据库或真实供应商。后端启动时校验数据根，两个就绪日志记录了实际路径。

Playwright 独立浏览器上下文，单 worker、retries=0。请求屏障设置在浏览器发出真实 refresh 之前，解除后直接 continue 至真实后端；只有测试上游按预设场景返回成功模型或 503。同步只等待具体 UI、请求或响应，不用固定休眠。

首轮尝试使用项目指定 agent-browser，但本机未安装，使用仓库已有 Playwright。已阅读项目 E2E 规则及 Playwright 官方最佳实践、自动等待、断言、定位、网络和隔离指南。

## 证据与命令

证据根 C:/fup-ui-20261113：

| 批次 | 结果 | 日志 |
| --- | --- | --- |
| 首轮并发场景 | 6 passed，退出码 0 | app/logs/ui-first.log |
| 修正版本预期后的弹窗重开补验 | 2 passed，退出码 0 | app/logs/ui-reopen-final.log |
| 八项联合中间批次 | 8 passed，退出码 0 | app/logs/ui-final.log |
| 包含真实服务器选择器的最终联合 | 9 passed，退出码 0 | app/logs/ui-complete.log、complete-results.json |
| 最终 E2E 类型检查 | 退出码 0 | app/logs/typecheck-e2e-complete.log |

不同批次不累计为去重用例数。最终 trace 在 complete-results/ 下，21 张实际页面截图导出至 screenshots/，映射为 screenshot-manifest.json。

示例截图：

- [经典布局：B 已完成、A 仍刷新](C:/fup-ui-20261113/screenshots/classic-second-one-still-refreshing.png)
- [现代布局：A 旧回包返回后，B 仍保持刷新](C:/fup-ui-20261113/screenshots/modern-server-picker-late-primary-keeps-secondary-busy.png)

最终命令从 packages/app 运行，服务已事先在隔离根启动：

```powershell
. C:\fup-ui-20261113\env.ps1 -Service app
$env:FUP_RELAY_E2E = '1'
bun node_modules/@playwright/test/cli.js test --config C:/fup-ui-20261113/playwright.config.mts
bun typecheck:e2e:relay
```

正式用例为 packages/app/e2e/regression/relay-settings-busy.spec.ts；已纳入 e2e/tsconfig.relay-settings.json。未设置 FUP_RELAY_E2E=1 时按框架跳过，不会把普通运行误报为通过。测试与配置摘要见 test-source-final.json。

## 首次失败及处理

保留全部失败日志、trace 和截图，没有只保留最后一次通过：

1. 隔离后端首次启动失败：测试脚本指向不存在的仓库根 effect 入口。改用已安装的包内入口后正常启动；失败发生在产品请求处理之前。
2. 旧切服务器脚本先后等待主页 Status 按钮和已移除的会话标签栏，分别超时；另一次夹具创建的是 legacy 会话，当前页面按 v2 查询也不适配。ui-scope.log、ui-scope-second.log 保留这两轮 2 failed 的结果。这些脚本没有到达目标切换行为，不能作为产品缺陷证据。最终删除不适用的用例，使用实际现代设置页头部服务器选择器完成补验。
3. 弹窗重开首次 2 failed：错误地要求旧刷新成功。真实请求分别携带 expectedVendorRevision=2、3；第二次 Get models 先保存新版本，旧版本收到 409 REQUEST_CONFLICT（resource=relay.auth）是正确保护。改为精确断言版本递增和 409，再验证旧失败不清新忙状态、新请求实际成功；修复的是验收断言，不是产品接口。日志 ui-reopen.log 保留。
4. 早期超时的 route 收尾可能在浏览器关闭后抛错，原脚本会跳过后续测试数据清理。正式用例已用嵌套 finally 保证后续 API 清理仍执行；本轮遗留的假供应商也已清理，记录 failed-fixture-cleanup.json。没有修改产品收尾逻辑。

## 交付与清理

业务源码运行前后校验 6 个相关文件，SHA256 不匹配 0，见 source-before.json、source-verification.json。本轮仅新增正式 E2E、更新 E2E 类型检查范围及追加验收状态文档。没有提交、推送、改版本或重新生成 SDK。

两个测试后端最终供应商数量均为 0，见 final-test-data.json。按 PID、完整命令行、创建时间确认后，仅停止本轮测试服务及其子进程；44096、44097、44098、44444 最终无监听。记录 cleanup-final-processes.json、cleanup-final.json。没有重启或关闭用户原有应用，没有操作生产配置、凭据、锁或迁移标记。
## 后续验收发现 ACC-01 / ACC-02（2026-11-13）

本节晚于前述 FUP-02 局部验收，不撤销其原范围。新增正式后续页面联合 6 pass、2 fail、0 skip；两个失败指向同一处经典布局切服务器后仍读取 A 的缺陷 ACC-01。Relay E2E 类型检查通过。Linux uid 1000 联合 61 pass、2 skip、0 fail；真实 root mode 用例 0 pass、1 skip、0 fail。Windows 冷启动 ACL 恢复后仍 503，确认失败缓存缺陷 ACC-02；热实例和直接目录缓存失效仅为定位对照，不能作为修复。

详见 [后续验收、根因与修复出口](D:/opencode/specs/followup-acceptance-results-2026-11-13.md)。RF-07 仅 Linux 已覆盖子范围通过，macOS 和 Windows 冷启动恢复仍未关闭；经典布局、历史完整 UI、R3-03B 与目标产物仍不扩大关闭。没有修改产品实现、提交或重启用户原有应用；本轮隔离服务和专用容器已清理。
