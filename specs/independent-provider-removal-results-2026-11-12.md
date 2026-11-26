# 统一密钥及智联入口移除结果

日期：2026-11-12

## 完成范围

本轮已移除统一密钥模式、统一密钥保存与清除、智联获取密钥入口、固定中转地址、内置中转供应商及旧凭据自动导入。保留用户自定义供应商的独立名称、地址、API Key、模型获取、勾选和模型调用。

两套供应商设置页均已移除相关入口。首次打开空数据根不再显示内置供应商。旧服务器缺少 `independent-vendors-v1` 能力时，前端禁止写入，避免新旧认证语义混用。

认证接口中的模式、统一密钥与回退操作已删除；HTTP 回归确认四条退休路由返回 404。公开 Schema、Protocol、Server 与前端同步调整，Client 与旧 JS SDK 已执行生成命令，未手写生成文件。

## 已有数据与兼容

认证存储升级为 migrationVersion 2。旧的统一密钥字段仅用于读取旧存储并退休引用，不再作为公开状态或调用凭据。内置供应商及没有独立地址的旧供应商被退休；已有自定义供应商的地址、独立凭据引用、实体身份、创建回执及 HMAC 元数据保留。

升级先提交配置，再清理不再被引用的凭据。配置提交失败不删除旧凭据；清理失败保留待清理记录，服务重建后继续清理，不重复增加 revision。原始 auth.json 保持字节不变，历史智联凭据不再自动导入。

内部 `leidiandonghua` Provider ID 暂作为历史自定义模型聚合命名空间保留，避免现有自定义模型选择失效；它不再提供默认中转地址或共享密钥。独立模型使用供应商隔离的 custom 模型 ID，不继承旧智联裸模型 ID。

本轮只修改源码，没有运行生产数据迁移，也没有操作生产系统凭据。上述升级在加载新版代码时执行；没有重启当前应用。

## 验证结果

所有自动验证均在 C:/obf-20261112 隔离副本及独立 HOME、XDG、临时目录与测试数据根内执行。测试从对应包目录运行。

| 验证批次 | 结果 |
| --- | --- |
| Core 认证、目录、创建、事务、插件及调度模型身份 | 107 pass，0 fail |
| Core 跨进程竞争、崩溃恢复及调用入口 | 22 pass，0 fail |
| Core runner、图片工具、ask/auto/plan 授权与调度、凭据及模型插件 | 47 pass，0 fail |
| App 设置状态、草稿、生命周期、协议及翻译 | 104 pass，0 fail |
| OpenCode 供应商及真实 HTTP 独立地址、密钥、上游模型调用 | 108 pass，0 fail |
| Server 真实 HTTP、清理、退休路由及同步 | 4 pass，0 fail |
| Client 契约 | 14 pass，0 fail |
| Schema | 8 pass，0 fail |

批次存在重叠，不将这些数字相加视为唯一测试总数。

Core、App、Server、OpenCode、Schema、Protocol、Client、旧 JS SDK 的最终 bun typecheck 均退出 0；App relay E2E 专项类型检查也退出 0。

真实 Chrome/Playwright 定向验收覆盖经典与新版两种布局，2 pass、0 skip、0 flaky。验收检查新根无内置商与旧入口，并实际执行添加、修改供应商、模型获取与勾选、跨服务刷新、旧身份保存冲突保护。场景中故意制造的跨窗口配置冲突提示属于预期保护行为。

## 同步与证据

本轮按修改前 SHA256 核对主工作区没有并发漂移后，仅将已验证清单中的 110 个文件同步回 D:/opencode；同步后逐文件校验与隔离副本一致，暂存区内容未改变。其他原有未提交内容保留。

本地证据目录：C:/relay-removal-20261112。包含 before.json、changes.json、synced.json、ui-results.json、ui-results.log、ui-classic.png、ui-modern.png。

自动验证日志目录：C:/Users/zh2100/AppData/Local/Temp/opencode-bf-implementation-20261112/logs。主要日志为 remove-core-relay3.log、remove-core-callers.log、remove-final-callers2.log、remove-final-app.log、remove-legacy-provider2.log、remove-final-server.log、remove-client.log 及 remove-final-schema-tests.log。

本轮自建隔离服务已停止。没有提交、推送或更改版本，没有重启当前应用。

## 未因本轮关闭的事项

本轮不代表所有项目缺陷均已修复。RF-BF-01（跨进程旧 vendorStamp 清除另一进程有效刷新 token）、RF-BF-02（构建原始 snapshot 未校验持久化 vendorEntities）仍需独立处理。R3-03B、RF-07 跨平台以及其他历史完整界面验收保持原状态；本轮两个定向页面用例不替代全部历史验收。
