# Koda：按模型和接入显示推理强度（待实施）

## 现场与边界（2026-11-23）

只读查询当前本地服务 `GET /api/model`（工作目录 `D:\opencode`）：返回 13 个启用模型，providerID 均为 `leidiandonghua`，全部 `variants` 为空。下表使用上游 API ID；完整目录 ID 为 `custom:<路由>:<上游 ID>`。这不是所有用户或所有供应商的全局目录。

`packages/core/src/relay-catalog.ts` 的 `apply` 将 `item.vendorId` 和 `item.modelId` 交给 `RelayCapability.variants`；`packages/core/src/relay-capability.ts` 的规则键是 `chatgpt/grok/claude/gemini/kimi`，不是此处实际传入的 `gpt/sub2api`。未匹配时返回空数组。`packages/app/src/context/global-sync/utils.ts` 转录服务端 variants，输入控件不应自行补全。简单添加两个供应商别名也不够：现有 `chatgpt` 列表缺 `max`，Grok 列表缺 `low`，而且供应商名称不是上游协议保证。

## 精确模型矩阵

下表是原生聊天 API 的文档能力或图像路由的 UI 处置。A = `low/medium/high/xhigh/max`；B = `low/medium/high/xhigh`。协议的 `none` 是显式关闭，不等于不传参数。用户另行确认其 `gpt-6.2-astra` 中转支持 `reasoning_effort: "ultra"`；不据此推断其他模型或中转也支持。

| 路由 | 上游 ID | 文档档位或 UI 处置 | 证据 |
| --- | --- | --- | --- |
| gpt | gpt-6.2-astra | A + Ultra（`native-ultra` 选项发送 `ultra`；历史 `ultra` 选项仍发送 `xhigh`） | [1]；Ultra 由用户确认 |
| gpt | gpt-6.2-sol | A | [1] |
| gpt | gpt-6.1-terra | none + A | [1] |
| gpt | gpt-6-astra | A | [2] |
| gpt | gpt-6.1-sol | A | [2] |
| sub2api | grok-4.6 | B；默认 high | [3] |
| sub2api | grok-4.7 | B；默认 high | [3] |
| gpt | gpt-image-2 | 不展示聊天推理强度 | 图像路由 |
| gpt | gpt-image-2.5-sunburst | 不展示聊天推理强度 | 图像路由 |
| gpt | gpt-image-2.5-flare | 不展示聊天推理强度 | 图像路由 |
| sub2api | grok-imagine-image | 不展示聊天推理强度 | 图像路由 |
| sub2api | grok-imagine-image-2.0 | 不展示聊天推理强度 | 图像路由 |
| sub2api | grok-imagine-image-quality | 不展示聊天推理强度 | 图像路由 |

[1] https://developers.openai.com/api/docs/models

[2] https://developers.openai.com/api/docs/guides/deployment-checklist

[3] https://docs.x.ai/developers/model-capabilities/text/reasoning

## 实施及放行条件

1. 在 Core 模型目录生成处统一解析：已配置的逐模型 variants 优先；否则按上游精确 ID 查文档能力，并按路由声明的协议与可转发参数缩减。对未知路由不凭名称分配档位。先查中转方的模型元数据或兼容说明；没有中转声明时不把原生表当作已验证结果，允许维护者显式配置该路由的子集。不要硬编码用户自定义路由名为厂商，更不要把所有 Grok 或 GPT 都映射为一组。
2. 核查 Relay.Effort、目录刷新和缓存版本；同时核查 V2 选中 variant 后使用的适配器、服务端合并优先级与实际序列化。Chat Completions 的 `reasoning_effort` 和 Responses 的 `reasoning.effort` 分开处理。若路由不支持所需的工具调用组合，不静默改协议、关工具或降档；标记限制。不要改动图像 quality、分辨率或 API 选择。
3. App 只本地化已提供的档位。选择器显示“推理强度：默认/当前档位”；`none/low/medium/high/xhigh/max` 对应“关闭/轻度/中/高/极高/Max”。“默认”不附加用户强度覆盖。历史 `ultra` 只有确认是原有 `xhigh` 别名时才兼容，不改写历史消息；将来路由若声明独立预设，应保留。使用完整提供方和模型 ID 隔离偏好；换模型不继承不合法档位，回到目标模型有效偏好或默认。
4. 验收：13 行目录表驱动测试；另测未知模型、改名路由、同一 ID 两种接入、显式子集和缓存刷新。App 验证新建与已有会话、切换及重启；本地 HTTP 替身捕获最终端点与请求体（默认不写入，`none` 显式发送，`max` 不被丢弃，图像无聊天字段）。离线测试只能证明 Koda 正确发送；真实中转接受性单列，需另行授权后才发起可能收费的请求。服务端拒绝时保留错误并提示切换，不自动重复付费尝试。

## 本次实施结果

已增加当前 7 个聊天模型的精确上游 ID 档位映射，独立于用户路由命名；保留既有其他模型规则。扩展 Relay.Effort 的 none/max 并重新生成 Client。保留旧 ultra ID 以兼容已保存会话，只有其请求体明确为 xhigh 时界面显示极高；独立 Ultra 不重命名。修复切换模型携带前一模型强度，以及显式默认被保存偏好覆盖的问题。

Core 定向测试 31 通过，App 121 通过；两包类型检查通过。未重新打包、未做真实中转收费验收。当前实现使用文档能力投影，不含新的路由能力声明/逐模型覆盖配置机制；中转接受性仍未核实，不应当成端到端能力保证。
