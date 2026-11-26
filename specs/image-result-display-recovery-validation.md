# 图片结果展示修复：本地验证记录

## 实施

- 修改 `httpapi-codegen` 的 Promise SSE 模板，并从 `packages/client` 执行 `bun run generate`，没有手改生成客户端。
- SSE 专用 `SseOptions`：默认单事件 1 MiB；桌面 V2 全局订阅显式设置 8 MiB；`onReady` 在状态、Content-Type、body 校验后调用。
- 在原始字节流上识别 CR/LF/CRLF，按字段行及行结束符统计单事件 UTF-8 字节，不计结束空行；超限返回带安全原因的 `MalformedResponse` 并释放 reader。
- 断流通知先 flush 已排队事件，再立即调度只读恢复；重连 ready 再校准。恢复通知合并、成功请求冷却、失败指数退避，provider cleanup 停止后续调度。
- 当前 pin 会话强制 GET；已缓存未打开会话标记 dirty，下次 sync 强制刷新。
- 历史转换补齐工具各状态及文件附件；分页补用户轮次根，缺失时抛错而非假成功。原始历史合并排序后重新投影，保留读取期间触达的新事件。

## 通过的验证

- Client：24 tests，117 assertions，全通过；`bun typecheck` 通过。
- App：server-sdk、server-session、server-session-v2-reducer、server-stream-recovery、global-sync/bootstrap 共 129 tests，229 assertions，全通过；`bun typecheck` 通过。
- Desktop：`bun typecheck` 通过。
- httpapi-codegen：`bun typecheck` 通过。完整测试 63 pass / 3 fail；失败分别是 Windows `URL.pathname` 生成 `/D:/...` 无效目录，以及两个断言硬编码 POSIX 路径分隔符。未改动这些跨平台测试；不能宣称生成器全绿。
- `git diff --check` 未发现空白错误（存在 Git CRLF 提示）。
- 已有真实 PNG 的纯本地 SSE 回放：PNG 2,949,652 bytes，data URI 3,932,894 字符，收到 1 个完整事件，附件内容逐字符相等。使用注入的本地 Response，无网络请求。
- 新回归覆盖大图片、多事件同块、UTF-8 分块、限额边界、未结束超限事件、取消释放、ready 校验时序、无业务事件 ready、注释/多行/CR-only、断流立即查询、通知合并/重试/冷却、历史图片附件、跨页补父用户、缺父用户失败、未打开会话 dirty、V2 实时更新与旧快照竞态。

## 验收边界

- 没有重发 prompt、resume 或生图请求，没有调用付费供应商。
- 没有终止正在运行的 Koda、替换安装包或重新打包。本次修改尚未进入当前安装版本。
- 尚未在新桌面安装包中完成实际断流后图片出现、服务器切换、窗口关闭及重新打开历史的交互验收。
- cleanup 取消恢复调度，但已发出的历史 GET 沿用现有请求生命周期，并非新增 AbortSignal 物理取消；响应保留在所属 ServerSession 实例，不写入新服务器实例。
