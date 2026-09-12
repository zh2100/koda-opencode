# 雷电动画 OpenCode Fork 规划

本文是本 fork 的产品规划，不只覆盖提供商。

## 背景

当前设置页会展示官方内置提供商（Anthropic、OpenAI、Google、OpenRouter、GitHub Copilot 等），并允许用户连接官方 OAuth / 自建 endpoint。

本 fork 的真实上游只有一个固定的 OpenAI-compatible 中转站。用户侧看到的不是官方提供商，而是中转站上的**厂商槽位**：每个厂商有名称和 API Key。请求全部打到同一地址，用对应 Key 鉴权。

## 目标

| 项 | 值 |
| --- | --- |
| 实际上游 | 唯一，写死 |
| Base URL | `https://api.leidiandonghua.cn/v1`（不可编辑、不可新增其他 URL） |
| 适配器 | `@ai-sdk/openai-compatible` |
| 内置厂商 | ChatGPT、Grok |
| 可添加厂商 | 用户自定义名称，如 Gemini、Claude、KIMI |
| 已配置厂商 | 可再次打开编辑，不只是新增后只读 |
| 认证 | 分厂商 API Key，或勾选后使用统一 API Key |
| 官方提供商 | 设置页不展示，运行时不可用 |
| 项目 | 参考 Codex 桌面版：选择项目、项目列表、新建项目 |
| 子智能体 | 保留 Task / child session；主界面改成 Codex 式嵌套卡片，默认不跳转子会话 |
| 技能 / MCP | 使用官方 ChatGPT / Codex（及兼容的 Claude Agent）技能与 MCP；**不导入插件** |
| 输入条设置 | 参考 Codex 桌面版：常用设置放在输入框内，随时可改，不必先打开独立设置页 |
| 已安排任务 | 新增（OpenCode 现无）；参考 Codex：定时/每天在指定项目跑一条 prompt |

保留本地 OpenCode Server 连接能力。不保留 Ollama / LM Studio 等本地模型提供商，除非后续单独开需求。

## 需求清单（已拍板）

以下 A→F 为完整首版范围，分三个可独立验收的里程碑交付：第一阶段 A/B 与输入条，第二阶段其余 C/D/E，第三阶段 F。第一阶段不实现调度；第一、二阶段完成即可分别交付，不等待第三阶段。

| 批次 | 需求 | 要点 |
| --- | --- | --- |
| A 上游 | 单一中转站 | URL 写死 `https://api.leidiandonghua.cn/v1`；锁死官方提供商 |
| A 上游 | 厂商槽位 | 内置 ChatGPT / Grok；可添加 Gemini、Claude、KIMI 等；可编辑；用户项可删 |
| A 上游 | 密钥 | 分厂商 Key 或统一 Key；不写进源码；不回显明文 |
| A 上游 | 连通与模型 | 测试连通、获取模型列表；勾选后进管理模型；选择器只显示已勾选 |
| A 上游 | 档位 | 轻度 / 中 / 高 / 极高，按厂商显示子集 |
| B 项目 | 项目入口 | 选择 / 列表 / 真·新建目录 / 打开已有；与「打开目录」文案拆开 |
| C 布局 | 主界面 | 中对话 + 右栏，对齐 Codex 骨架，不像素级抄 |
| C 布局 | 右侧栏 | 文件 / 变更 / 任务 / 终端；变更顶 Git 只读摘要 |
| C 布局 | 输入条 | 随时改项目、模型、档位、批准；Key 走 `···` |
| D 智能体 | 子智能体 | 主时间线嵌套卡片，默认不跳转子会话 |
| E 扩展 | 技能 | 左侧栏「技能」替换插件；Codex 式面板；官方 SKILL.md |
| E 扩展 | MCP | `opencode.json` 配置；不导入插件 |
| F 调度 | 已安排任务 | 一次性或每天；桌面 daemon 到点跑；与 todo 分开 |

明确不做：官方 OAuth 提供商、改 URL、硬编码 Key、官方插件、完整 Git GUI、cron/云端任务、IDE 多列编辑。

## 非目标

- 不开放官方 Anthropic / OpenAI / Google 等连接流程。
- 不允许用户填写或修改 Base URL。
- 不在源码中硬编码任何 API Key。
- 本次不改中转站协议，沿用 OpenAI-compatible。
- 不把本地 OpenCode Server 当成模型提供商。
- 添加厂商只增加名称和 Key（以及该厂商下的模型），不增加新的上游地址。
- 不重做子智能体调度；不取消 child session 存储；UI 只展示一层卡片。
- 不导入 ChatGPT GPT、Codex 插件或 OpenCode 社区插件作为替代；扩展能力只用技能和 MCP。
- 已安排任务首版不做 cron 表达式、不做云端调度、不在纯 Web 无 daemon 时保证准时触发。

## 概念区分

不要把下面三件事混在一起：

| 概念 | 含义 | 本需求中的处理 |
| --- | --- | --- |
| 上游 / Relay | 真正发 HTTP 的地址 | 固定一个 |
| 厂商槽位 Vendor | ChatGPT、Grok、用户新增的 Gemini 等 | 设置页管理名称 + Key |
| 本地 OpenCode Server | 本机/远程 opencode 进程 | 保留，与模型提供商无关 |

产品文案里可以对用户说“提供商”，实现上应称为 **Vendor**，避免和 OpenCode 内置 Provider ID 冲突。

项目与厂商无关：切换项目不改 API Key / 上游 URL；厂商设置是全局的。

## 产品形态

设置页不再出现官方 Popular / Connect 列表。改为「中转站密钥」一页：

```text
上游（只读）
  https://api.leidiandonghua.cn/v1

[ ] 使用统一 API KEY
    勾选后，所有厂商共用下面这一把 Key。

统一 API KEY（仅勾选时显示）
  [ sk-xxxxxx                    ]

  厂商
  ChatGPT
    ChatGPT API KEY  [ sk-xxxxxx ]
    [测试连通] [获取模型列表] [编辑]
  Grok
    Grok API KEY     [ sk-xxxxxx ]
    [测试连通] [获取模型列表] [编辑]
  Gemini
    Gemini API KEY   [ sk-xxxxxx ]
    [测试连通] [获取模型列表] [编辑] [删除]

  [ + 添加厂商 ]
```

每条厂商都有 **编辑**。当前上游自定义提供商是创建后只读，本需求必须补编辑，不能要求用户删了再建。

### 统一 API KEY

- 默认不勾选：每个厂商单独填 Key。
- 勾选后：
  - 只显示一个「统一 API KEY」输入框。
  - 各厂商独立 Key 输入框隐藏或禁用。
  - 发往任意厂商模型的请求都带这把 Key。
- 取消勾选：恢复分厂商输入；已填的统一 Key 不自动写入各厂商（避免覆盖用户原 Key）。可把统一 Key 预填到空白厂商，但已有独立 Key 保持不变。

### 内置厂商

当前固定两项，不可删除：

| 显示名 | 建议 Vendor ID | API Key 标签 |
| --- | --- | --- |
| ChatGPT | `chatgpt` | ChatGPT API KEY |
| Grok | `grok` | Grok API KEY |

Key 均为用户填写，格式示例 `sk-xxxxxx`，不做本地格式强校验（中转站 Key 前缀可能变化）。

### 添加自定义厂商

用户可添加名称，例如 Gemini、Claude、KIMI。每项包含：

- 显示名（必填，界面展示）
- Vendor ID（由显示名生成，如 `gemini`；冲突时允许手动改，规则同现有 `^[a-z0-9][a-z0-9-_]*$`）
- API Key（未勾选统一 Key 时必填才能用；勾选统一 Key 时可空）
- 模型列表不手填：保存 Key 后自动从中转站拉取，并在选择对话框中呈现

可删除的只有用户添加项。ChatGPT / Grok 不可删，但 **都可以编辑**。

### 编辑已配置厂商

现有 OpenCode 自定义提供商对话框只支持创建，没有回填和保存更新。本 fork 每条厂商必须可再打开编辑。

列表操作：

| 操作 | 内置 ChatGPT / Grok | 用户添加项 |
| --- | --- | --- |
| 测试连通 | 有 | 有 |
| 获取模型列表 | 有 | 有 |
| 编辑 | 有 | 有 |
| 删除 | 无 | 有 |
| 添加 | 无（已固定） | 有 |

点编辑后打开与「添加」同一套表单，回填当前值。保存是更新，不是新建。

可编辑字段：

| 字段 | 内置厂商 | 用户添加厂商 |
| --- | --- | --- |
| 显示名 | 可改（标签随之变成「新名称 API KEY」） | 可改 |
| Vendor ID | 不可改 | 默认不改；若允许改，必须迁移该厂商下已保存模型和 session 引用 |
| API Key | 可改；留空表示不改，不把已保存 Key 清空 | 同左 |
| 模型列表 | 点「获取模型列表」拉取并勾选；勾选的进入管理模型 | 同左；还可把未分组模型勾到该厂商 |
| Base URL | 不可见、不可改 | 不可见、不可改 |

编辑规则：

- Key 输入框不回显明文。占位为已保存则显示「已设置」，未保存则空白。用户输入新值才覆盖。
- 点保存且 Key 为空：保留原 Key。
- 需要明确清空 Key 时用单独的「清除密钥」，不要靠把输入框留空当删除。
- 改显示名不改 Vendor ID，已选模型、session、统一 Key 逻辑都继续有效。
- 用户添加项若改 Vendor ID：旧 ID 数据迁到新 ID，并更新模型归属；有冲突则禁止保存。
- 编辑中途取消，不写存储。
- 勾选统一 Key 时仍可编辑厂商名称和模型；独立 Key 字段禁用，提示当前走统一 Key。
- 保存后刷新 catalog / 模型选择器，已打开 session 用新名称；Key 变更后下一次请求立即用新 Key，必要时 `global.dispose()`。

### 测试连通

设置页每条厂商都有 **测试连通**。勾选统一 Key 时，统一 Key 输入框旁再放一个总测按钮，测的是同一把 Key 打到固定上游。

测什么：

```http
GET https://api.leidiandonghua.cn/v1/models
Authorization: Bearer <resolved-key>
```

用「列出模型」而不是随便发一条 chat：更快、不耗对话额度、失败原因更接近鉴权/上游是否可达。成功且列表非空视为连通；HTTP 2xx 但空列表单独提示「已连通但未返回模型」。

用哪把 Key：

| 场景 | 使用的 Key |
| --- | --- |
| 未勾选统一 Key | 该厂商已保存 Key；编辑对话框里若刚输入了尚未保存的新 Key，优先用输入框里的值（方便保存前试） |
| 已勾选统一 Key | 只用统一 Key；各厂商行上的测试连通也走统一 Key |
| 对应 Key 为空 | 按钮禁用，提示先填写 API KEY |

交互：

- 按钮文案：默认「测试连通」；进行中「测试中…」且禁用防连点。
- 成功：行内绿色「已连通」，可附带拉到的模型数量，如「已连通 · 12 个模型」。
- 失败：行内红色短因，如「密钥无效」「网络不可达」「上游超时」。不要弹官方 Connect Provider 流程。
- 状态只挂在这一行，不覆盖其他厂商。
- 测试成功可顺带写入该厂商模型缓存（与自动拉取同一套）；失败不清掉上次成功列表。
- 超时建议 10s，可取消。
- 不在后台静默轮询；只在用户点击、或编辑对话框里点测试时发请求。

编辑对话框里同样放「测试连通」，用当前表单中的 Key（含未保存的新值）。测试成功不是保存的前提，用户仍可先存 Key 再测。

### 获取模型列表

每条厂商另有 **获取模型列表**，与「测试连通」分开：

| 按钮 | 作用 |
| --- | --- |
| 测试连通 | 只验证 Key / 上游是否可达 |
| 获取模型列表 | 拉回该 Key 能看到的模型，用勾选决定哪些进入「管理模型」 |

Key 为空时按钮禁用。进行中文案「获取中…」，防连点。超时与测试连通相同（建议 10s）。

点按钮后：

```http
GET https://api.leidiandonghua.cn/v1/models
Authorization: Bearer <resolved-key>
```

Key 解析规则与测试连通相同（分厂商 Key / 统一 Key / 编辑框未保存的新值）。

成功则打开（或在编辑对话框内展开）勾选列表：

```text
┌ ChatGPT · 模型列表                    ┐
│ 搜索…                                 │
│ [全选] 已选 3 / 12                    │
│                                       │
│ [x] gpt-5.2                           │
│ [x] gpt-5.1-codex                     │
│ [ ] gpt-4o                            │
│ [ ] o4-mini                           │
│                                       │
│          [取消]  [应用到管理模型]     │
└───────────────────────────────────────┘
```

勾选规则：

- 拉取结果是候选，**不会**整表自动进管理模型。
- 勾选某一行：立即（或点「应用到管理模型」后，见下）把该模型加入管理模型，并设为可见。
- 取消勾选：从管理模型移除（visibility = hide），会话选择器不再出现。
- 推荐：**勾选即生效**，不必再点保存。若列表很长，可改为勾选后点「应用到管理模型」一次性提交；两种不要混用。首版用勾选即生效。
- 已在管理模型中的模型，再次获取时保持勾选。
- 上游已下架、本地仍勾选过的模型：列表里标记「已不在上游」，可取消勾选清掉；不自动删，避免会话里的模型突然消失。
- 「全选 / 全不选」只作用于当前搜索过滤结果。
- 失败：行内红字短因，不打开官方 Connect Provider；不清空已在管理模型里的项。

与管理模型的关系：

- 管理模型只显示用户勾选过的模型，按厂商分组。
- 去掉管理模型里的「连接提供商」按钮，改为引导去厂商页获取列表。
- 管理模型里的开关与获取列表里的勾选是同一份可见性：一边改，另一边同步。
- 会话里的「选择模型」对话框 **只列出管理模型中可见的项**，不是 `/v1/models` 全量。
- 某厂商一个都没勾选：该厂商不出现在选择器里，即使 Key 有效、列表已拉取。

不要和「归属到哪家厂商」混淆：获取列表决定 **有哪些模型**；勾选决定 **哪些出现在管理模型/选择器**；未分组模型仍可在编辑厂商时指定归属后再勾选。

不允许：

- 填写 URL
- 填写自定义 Header（除非后续中转站有硬性要求）
- 连接到官方 Anthropic / OpenAI 账号

### 模型选择

模型选择器按厂商分组，而不是按 OpenAI / Anthropic 官方提供商分组。模型 ID 不手填，连接后自动拉取。

未填可用 Key 的厂商：

- 统一 Key 未勾选，且该厂商 Key 为空：该厂商模型不可用，提示去设置页填写。
- 已勾选统一 Key 且统一 Key 为空：全部模型不可用。
- 已勾选统一 Key 且已填：全部已配置厂商的模型都可用。

### 自动拉取模型

厂商保存可用 Key 后（或勾选统一 Key 且已填），用该 Key 请求：

```http
GET https://api.leidiandonghua.cn/v1/models
Authorization: Bearer <resolved-key>
```

规则：

- 每个厂商用自己的有效 Key 各拉一次；勾选统一 Key 时只拉一次，再按模型 ID 分到各厂商。
- 结果写入该厂商的**候选缓存**。只有用户勾选的模型才会进入管理模型，并出现在会话选择器。
- 「获取模型列表」是把缓存展示为勾选 UI 的主入口；保存 Key / 测试连通成功可以更新缓存，但不得在未勾选时写入管理模型。
- 拉取失败：保留上次成功列表，并显示可重试错误，不阻塞改名称或改 Key。
- 打开模型对话框、保存 Key、手动刷新时重新拉取；会话进行中不自动打断。
- 缓存按 vendor + key fingerprint 分桶，换 Key 后作废旧列表。
- 中转站若无 `/v1/models` 或返回空，该厂商显示空状态和失败原因，不回退到官方 Models.dev 目录。

模型归属：

1. 先保留用户手动归属，再按已验证的 `owned_by` / `id` 前缀规则自动识别；自动识别标记来源，冲突或多重匹配进入待确认，不自动覆盖手动归属。
2. 分不出去的模型进入「未分组」，用户可在编辑厂商时勾选归属。
3. 用户添加的厂商默认没有自动匹配规则，需在编辑对话框里从已拉取列表勾选，或等后续加前缀规则。

### 模型对话框（参考 Codex 桌面版）

不要用当前 OpenCode 那种「按官方 provider 分组的长列表 + 英文 variant 下拉」。交互对齐 Codex 桌面版：

```text
┌ 选择模型 ─────────────────────────────┐
│ 搜索模型…                             │
│                                       │
│ ChatGPT                               │
│   GPT-5.2          中                 │
│   GPT-5.1 Codex    高                 │
│ Grok                                  │
│   Grok 4           高                 │
│ Gemini                                │
│   Gemini 2.5 Pro   中                 │
└───────────────────────────────────────┘

选中某一行后，对话框内出现档位条（无档位的模型不显示）：

  推理强度    ( 轻度 ) ( 中 ) ( 高 ) ( 极高 )
```

布局要求：

- 对话框，不是输入框旁一个英文 `high` 下拉。
- 左侧/上方：按厂商分组的模型列表，可搜索。
- 当前模型右侧或第二行显示当前档位中文名，如「中」。
- 选中模型后，用分段按钮选档位，不要再露出 `minimal` / `high` / `xhigh`。
- 无推理档位的模型不显示档位条。
- 只列出已勾进管理模型的模型；没勾选过的即使已拉取也不出现。
- 未拉到模型、未勾选或 Key 无效的厂商整组不出现或灰掉，并提示去设置页获取列表。
- 会话输入条只显示「厂商 · 模型 · 档位」摘要，点击才打开该对话框。

### 档位：轻度 / 中 / 高 / 极高

界面统一用中文四档，按厂商决定实际有哪几档、以及发到中转站的字段。

| 界面 | 内部 ID | 常见映射 |
| --- | --- | --- |
| 轻度 | `low` | ChatGPT `low` / `minimal`；Gemini `low` |
| 中 | `medium` | ChatGPT `medium`；无该档的厂商可隐藏 |
| 高 | `high` | ChatGPT `high`；Claude 思考开；Grok `high` |
| 极高 | `xhigh` | ChatGPT `xhigh`；Claude `max` |

厂商预设（中转站字段确认后可改表，不可让用户填 URL）：

| 厂商 | 可见档位 | 请求如何带上 |
| --- | --- | --- |
| ChatGPT | 轻度、中、高、极高 | `reasoning_effort`: `low` / `medium` / `high` / `xhigh`（若模型只支持 `minimal`，轻度对应该值） |
| Grok | 中、高、极高（若上游无轻度则不显示） | 按中转站 Grok 协议，优先 `reasoning_effort` |
| Claude | 高、极高 | Anthropic thinking：`high` → 开启+中预算，`xhigh` → max 预算 |
| Gemini | 轻度、高 | `thinking` / `budget` 低/高 |
| KIMI 及其他用户厂商 | 有推理能力才显示；默认 中、高 | 能识别则走 OpenAI-compatible `reasoning_effort`，否则不显示档位 |

规则：

- 档位集合由**厂商 + 该模型是否 reasoning**决定，不是全局四档都画出来再禁用。
- 某厂商没有「轻度」就不要出现「轻度」按钮。
- 切换模型时，若旧档位在新模型上不存在，落到该模型默认档（优先「中」，否则「高」）。
- 选档位只改当前会话/当前模型的 variant，不改 API Key，不改 URL。
- 内部仍走 OpenCode `model.variant`；对用户只显示中文。
- 不要用现有 openai-compatible 插件里那种只给 `glm-5.2` 生成 `high`/`max` 的窄逻辑；本 fork 要按厂商表生成。

## 运行时模型

### 现有 OpenCode 对接边界

本节优先级高于“参考 Codex”的视觉描述。Relay 功能必须嵌入现有 Provider、Auth、Session、Location、Skill、MCP 和 PTY 状态源，不复制一套平行运行时。

- **Provider 注册与过滤**：现有 `Provider.Info.source` 支持 `env`、`config`、`custom`、`api`，Provider catalog 也会使用 Models.dev。必须在 Server/Core 的注册、catalog、`provider.available()`、默认模型解析和 Session prompt 校验层统一过滤，只允许 `leidiandonghua`；设置页隐藏官方 Provider 不是安全边界。
- **Relay catalog 分层**：`GET /v1/models` 的结果先进入 Relay 候选缓存，再由用户勾选写入 Relay 管理模型登记，最后映射为现有 `Provider.Model`（仍使用 `providerID + modelID`）。候选缓存不可直接注入现有全量 Provider catalog；未勾选模型不得进入默认模型、Session 选择器或自动解析。
- **Vendor 归属**：现有公共模型协议只有 `providerID`、`modelID` 和 `variant`，不新增前端传递的 `vendorId`。Server 维护 `(providerID, modelID) → vendorId` 元数据，在请求鉴权前解析实际 Key；前端不能自行附加 Authorization。若同一模型 ID 被多个 Vendor 认领，必须进入待确认状态或使用显式管理登记，不能按最后一次拉取覆盖。
- **认证 API**：现有 SDK 仍有 `PUT/DELETE /auth/{providerID}` 的一 Provider 一认证接口。Relay 需要新增或扩展专用认证 HttpApi，支持统一 Key、Vendor Key、版本号和幂等更新；不能把多个 Vendor Key 编码成不透明的单字符串后继续假装一把 Provider Key。公开 Protocol/HttpApi 变更后从 `packages/client` 运行 `bun run generate`，禁止手改生成目录。
- **Session prompt**：现有 prompt 接受 `{ providerID, modelID }` 和 `variant`。Server 必须重新校验 Provider、Vendor 归属、模型可见性、Key 状态和档位能力；旧官方 Provider 引用在打开时提示失效，在发送入口再次拒绝，不静默换模型。
- **Session 执行**：调度任务每次运行创建新的 Session 和新的 prompt message ID，通过 `SessionV2.prompt` 先持久化输入再唤醒 `SessionExecution`。只对尚未开始准入的输入补跑；已进入 Provider/tool 阶段但结果未知的 run 标为中断待确认，不自动重放。
- **Project/Location/Workspace**：项目列表是当前 Server/用户的路径注册表；真正执行位置仍由现有 `Location(directory, workspace)` 决定。普通项目不能被强行建成 workspace；切换项目不迁移现有 Session，不改变运行中终端 cwd。路径和权限在每次实际访问时重新校验。
- **技能**：现有 `SkillV2` 通过注册 source 加载，并由 `PermissionV2.evaluate("skill", ...)` 过滤。Server 注册 `.claude/skills`、`.agents/skills` 等目录，UI 只调用 `/api/skill`；关闭技能映射到权限规则，不在前端维护第二套磁盘扫描状态。
- **MCP**：复用现有 Location 级 MCP、OAuth、连接状态和权限过滤；`opencode.json` 是配置入口，不代表全部运行时状态。OAuth token 不与模型 Key 混存，授权过期和连接失败必须单独显示。
- **终端与布局**：现有 `TerminalPanel`/`TerminalPanelV2` 共享 PTY 与 tab 状态。右栏只是容器位置变化，不重新创建 PTY；v1/v2 不能各自维护终端 tabs。项目切换后新终端使用新 Location，旧终端可后台运行但不在新项目面板中显示。
- **子智能体**：现有 `AgentPart`/`SubtaskPart`、child session 和权限事件是事实来源；嵌套卡片只做投影，不新增平行子任务存储。


推荐：**一个 OpenCode Provider + 多个 Vendor Key**。

- Provider ID：`leidiandonghua`
- `baseURL` 写死
- 认证存储不再是「一个 provider 一把 key」，而是：

```ts
{
  unified: boolean
  unifiedKey?: string
  vendors: {
    chatgpt: { name: "ChatGPT", key?: string, builtin: true }
    grok: { name: "Grok", key?: string, builtin: true }
    gemini?: { name: "Gemini", key?: string, builtin: false }
    // ...
  }
}
```

发请求时：

1. 根据当前选中模型解析所属 vendor。
2. 若 `unified === true`，使用 `unifiedKey`。
3. 否则使用该 vendor 的 `key`。
4. 仍无 Key 则拒绝请求，提示补 Key。
5. `Authorization: Bearer <key>` 打到 `https://api.leidiandonghua.cn/v1`。

不推荐把每个厂商做成独立 OpenCode Provider（各自一套 catalog）。原因：URL 相同，官方 provider 过滤会变复杂，统一 Key 也要在多个 provider 间同步。

### 锁死官方提供商

以下路径只允许 `leidiandonghua`：

- Web / Desktop 设置页
- TUI 提供商连接与模型选择
- Provider catalog / `provider.available()`
- Session 模型解析与默认模型
- 环境变量带入的官方提供商
- `opencode.json` 里的其他 `provider` 配置
- 旧 session 里的 `anthropic/...`、`openai/...` 等模型

可用 V2 policy：

```jsonc
{
  "experimental": {
    "policies": [
      { "effect": "deny", "action": "provider.use", "resource": "*" },
      { "effect": "allow", "action": "provider.use", "resource": "leidiandonghua" }
    ]
  }
}
```

V1 仍在使用时，对其他 provider 做 `disabled_providers` 或等价过滤。

## 现有模块 → Relay 新增模块 → 不允许改动的边界

下表是实现和代码评审的边界清单。若新增需求无法落入“Relay 新增模块”，必须先更新本节和对应的 Protocol/迁移方案；不得通过前端绕过现有服务边界。

| 现有模块 / 当前事实 | Relay 新增或改造模块 | 不允许改动的边界 |
| --- | --- | --- |
| `packages/opencode/src/provider/provider.ts`：Provider catalog、`Provider.Info`、`Provider.Model`、`providerID/modelID` 解析 | 增加 `leidiandonghua` 内置 Provider；增加 Relay catalog 适配层；在 catalog、`available()`、默认模型和 prompt 校验处加入 Provider policy | 不把每个 Vendor 建成独立 OpenCode Provider；不删除公共 `Provider.Model` 结构；不让未勾选模型进入默认模型或公开选择器 |
| `packages/opencode/src/provider/provider.ts` + `packages/core/src/models-dev.ts`：支持 env/config/custom/api 和 Models.dev | 增加 Relay 专用模型来源和过滤器；官方 Provider 过滤在 Server/Core 生效 | 不通过 UI 隐藏来代替运行时过滤；不使用 Models.dev 补回 Relay 未返回的模型、价格或档位 |
| `packages/llm/src/providers/openai-compatible.ts`、OpenAI-compatible route | 增加 Relay Provider profile、固定 base URL、Vendor Key resolver、厂商 variant 映射 | 不修改通用 OpenAI-compatible 协议来迁就单一 Relay；不允许请求携带用户自定义 base URL/header；不从前端拼 Authorization |
| 现有 `PUT/DELETE /auth/{providerID}` 和 `packages/opencode/src/auth/index.ts` | 增加 Relay 认证 HttpApi/服务：unified Key、Vendor Key、Key 状态、revision、幂等更新、清除密钥 | 不把多把 Key 拼进一个字符串继续伪装成单 Key；不让浏览器直接读取密钥库；不在普通 JSON/localStorage 保存明文 Key |
| `packages/llm/src/route/auth.ts` 的 `Credential`、`Redacted`、Bearer header 抽象 | 接入 Server 端密钥库适配层和按模型解析的 Credential；增加 Windows Credential Manager / macOS Keychain / Linux Secret Service 适配目标 | 不绕过 `Redacted` 暴露明文；密钥库不可用时不降级为明文落盘；MCP OAuth token 不与模型 Key 混存 |
| 现有 Session prompt API（`providerID`、`modelID`、`variant`、`messageID`） | 在 Server 增加 Relay 模型归属、可见性、variant 能力校验和错误码 | 不向现有公共 prompt API 强行加入 `vendorId`；不信任客户端传来的 Vendor/档位；旧官方模型在发送入口必须拒绝 |
| V2 `SessionV2.prompt` → `SessionExecution.wake` → Location-scoped runner | Scheduled Task 运行器；TaskRun 去重/锁；任务输入持久化和补跑策略 | 不绕过 `SessionV2.prompt` 直接调用 Provider；不把 Session ID 交给跨进程执行协调器；Provider 执行中断后不自动重放未知副作用 |
| `ProjectV2`、`Location(directory, workspace)`、现有 project/workspace API | 桌面 Project 注册表（名称、路径、最近使用、状态）；项目选择/新建/打开适配器 | 不把普通项目强制创建为 workspace；不把项目切换实现为 Session 迁移；不假设跨 Server 同路径是同一项目 |
| `packages/app/src/pages/session.tsx`、session layout、`TerminalPanel`/`TerminalPanelV2` | Codex 式中间对话 + 可折叠左轨 + 右栏 Tab 容器；复用现有 PTY/tab 状态 | 不复制终端状态；右栏迁移不得重建 PTY；v1/v2 不得各维护一套 terminal tab；不在移动端强制三栏 |
| `ReviewPanelV2`、file tree、diff、todo API | 右栏文件/变更/任务 Tab 的编排和性能限制；Git 只读摘要 | 不实现完整 Git GUI；不把 Todo 与子智能体列表混为一表；不因每条流式消息触发全量 diff |
| `AgentPart`、`SubtaskPart`、child session、permission/question 事件 | 父时间线嵌套卡片、状态投影、父会话审批和重试入口 | 不新增平行子智能体持久化模型；不默认路由到 child session；不在子卡片提供独立 composer |
| `SkillV2`、SkillDiscovery、`PermissionV2.evaluate("skill", ...)`、`/api/skill` | 注册 `.claude/skills`、`.agents/skills` 等 source；技能面板、来源显示和权限编辑 | UI 不直接扫描磁盘；关闭技能映射到权限规则；不建立插件商店或插件导入器 |
| MCP service、Location scope、OAuth、连接和权限状态 | `opencode.json` 配置编辑器；本地/远程服务器状态、启停和错误展示 | 不把 MCP 伪装成技能/插件；不把 OAuth token 当模型 Key；不因固定 Provider 禁用 MCP OAuth |
| Desktop/CLI daemon 基础设施、Effect schedule 约定 | 第三阶段 Scheduled Task daemon、SQLite run 记录、时区计算、补跑和通知 | 不假设当前已有定时任务功能；不做云端/多机调度；不使用 cron 表达式；不重复执行同一 `(taskId, scheduledAt)` |
| `packages/client` 生成 SDK、OpenAPI/Protocol schema | 新增 Relay auth/catalog/task 端点和 Schema；生成并提交客户端类型 | 不编辑 `src/generated` 或 `src/generated-effect`；Protocol 改动后必须从 `packages/client` 运行 `bun run generate` |
| 现有日志、诊断、导出和遥测 | Relay 错误码映射、requestId、脱敏诊断和迁移报告 | 不记录完整 Key、Authorization、内部 HMAC 指纹或用户绝对路径；不把上游原始错误体直接返回用户 |
| 现有配置迁移与 `opencode.json` | Relay schema 版本、备份、官方 Provider 清理和回滚流程 | 不以迁移为由重新开放官方 Provider；不静默删除旧 session 消息；迁移失败不得留下明文 Key |

### 依赖方向

- Schema 定义 Relay Vendor、模型登记、认证状态、错误码和任务运行记录；Schema 只能被 Core/Protocol 依赖。
- Core 提供 Relay catalog、Vendor Key resolver、密钥库抽象、模型能力和调度领域逻辑；Core 不依赖 Server 或 Client。
- Protocol/Server 暴露认证、模型、项目和任务 HttpApi，并在入口执行 Provider/Vendor/Location 权限校验。
- Client 只依赖 Schema/Protocol，通过生成 SDK 调用 Server；不得依赖 Core 或 Server 实现。
- `sdk-next` 可以组合 Client、Core 和 Server；UI 不直接绕过 Client 访问 Core。
- Relay 的运行时 Provider、Session runner、Tool registry、权限和文件系统继续遵守 Location scope；Vendor 是全局配置概念，不改变执行位置。

## 数据与接口契约

以下为逻辑字段和行为契约，实施时复用现有 Project/Session/Location 身份及存储约定，不另造平行实体。公共类型归 Schema/Protocol，服务实现归 Core/Server，Client 不依赖 Core/Server；修改公开 Protocol 或 HttpApi 后从 `packages/client` 运行 `bun run generate`。

| 实体 | 必要字段与约束 |
| --- | --- |
| Vendor | `id`、`name`、`builtin`、可选 `keyRef`、`createdAt`、`updatedAt`、`revision`；ID 首版不可改，内置 ID 不可删除 |
| 密钥策略 | `unified`、可选 `unifiedKeyRef`、`revision`；只存引用，明文由服务端密钥存储提供 |
| 候选模型缓存 | Server/认证配置身份、Vendor、内部 Key 指纹、`modelId`、`fetchedAt`、`ownedBy`；与可见模型登记分开 |
| 模型登记 | 以 `(vendorId, modelId)` 为唯一键；`displayName`、`visible`、`reasoningCapabilities`、`assignmentSource`、`lastSeenAt`、`upstreamPresent`；同一上游 ID 在不同 Key 下可以分别登记 |
| Project | 复用项目 ID/Location，提供 `name`、`path`、`lastUsedAt`、`status`；跨 Server 的同路径不视作同一项目 |
| ScheduledTask | `id`、项目/Location、`prompt`、`schedule`、`timezone`、`model`、`variant`、`approvalMode`、`enabled`、`revision`、`nextRun`、`lastRun`；时间戳用 UTC，日历时区用 IANA 名称 |
| TaskRun | `id`、`taskId`、`scheduledAt`、配置版本快照、`status`、`sessionId`、`promptMessageId`、开始/结束时间、错误码；运行记录不含密钥 |

### 更新、缓存与删除

- 操作按“创建/更新厂商、设置/清除密钥、切换统一模式、测试、刷新候选、修改可见性”区分；接口路径沿用 Server HttpApi 约定，不能用一个保存接口同时触发隐式删除。
- 创建使用客户端操作 ID：相同 ID 和相同请求返回同一结果，内容冲突返回 409；Vendor ID 已存在时不能悄悄覆盖。
- 更新携带 `revision`，旧版本返回 409，前端保留输入并提示刷新；不让多个窗口互相覆盖。可见性更新提交明确布尔值，不能使用容易重放翻转的 toggle。
- 密钥字段缺席或留空表示保持；清除走独立操作。显示名更新和 Key 持久化不以模型拉取成功为前提。
- `GET /v1/models` 采用 10 秒超时，支持取消；仅有效成功响应替换对应缓存。401/403 将当前 Key 标为不可用，禁止发送；失败不删除已登记模型，旧缓存仅作为带时间戳的过期数据展示。
- 切换 Key/统一策略时递增配置版本；迟到响应必须同时匹配请求的版本、Vendor 和 Key 指纹才可提交。切回旧 Key 也需刷新确认权限，不能把旧成功状态直接视作当前有效。
- 批量可见性更新原子提交；保存失败回滚 UI 并给出重试入口。“全选”仅作用于当前过滤结果。
- 删除自定义 Vendor 前列出受影响模型和历史会话数量；原子移除密钥引用、缓存和可选登记。历史消息保持，原引用标记失效，继续发送需重选；不能把删除后的模型自动归给另一把 Key。
- Vendor 表单草稿（名称、Key、Vendor 设置）取消即丢弃；模型可见性是独立的即时操作，勾选后立即保存并明确标识“已自动保存”。编辑中未保存的 Key 只用于临时测试，不能因为取消表单而留下 Key 或模型归属副作用。

### 密钥存储与迁移

- Windows 本地 Server/daemon 需要新增同一用户身份访问 Credential Manager 的适配层；macOS 目标为 Keychain，Linux 目标为 Secret Service。元数据只保存不透明引用，前端不直接读系统密钥库。
- Web 通过当前连接的 Server 使用密钥库，浏览器 localStorage/IndexedDB 不存 Key；当前仓库尚无跨平台密钥库实现，未完成适配时禁止明文降级。无桌面密钥库的服务部署需单独配置受保护的加密存储，主密钥来自部署秘密管理且与数据库分离；未配置时明确报不可用，不静默明文落盘。
- 前端密钥状态仅返回 `hasKey`、`updatedAt`；不返回完整 Key、内部指纹或可逆密文。Key 指纹仅服务端使用带服务秘密的 HMAC，不进入日志或遥测。
- 密钥只在配置它的 Server/认证身份范围生效，不因切换项目改变，也不自动同步到其他 Server。切换 Server 后重载模型、权限及密钥状态。
- 保存失败保留安全输入供用户重试，取消/关闭后清除内存值；未保存 Key 不出现在 URL、通知或诊断导出中。
- 旧配置迁移记录 schema 版本，写前备份非秘密配置；旧明文密钥先导入安全存储并校验成功，再原子更新引用。需要保留的含密钥备份必须加密、限制当前用户访问，不额外制造明文副本。
- 迁移失败保留原始数据供恢复，回滚仅恢复配置结构和引用，固定 Provider 策略仍生效，不重新放开官方 Provider。

### 稳定错误码

错误响应包含 `code`、中文可映射文案、`retryable`、`requestId` 和安全详情；前端按错误码渲染，不解析上游字符串。上游响应体先脱敏，不直接转发给用户。

| code | 场景 / 修复入口 |
| --- | --- |
| `KEY_MISSING` | 补填当前生效密钥 |
| `KEY_REJECTED` | 上游 401/403，重新设置或测试密钥 |
| `UPSTREAM_UNREACHABLE` / `UPSTREAM_TIMEOUT` | 网络或 10 秒超时，提供重试 |
| `UPSTREAM_RATE_LIMITED` | 429，显示可用的重试时间，不自动重复发送对话 |
| `UPSTREAM_INVALID_RESPONSE` | 模型响应格式错误，保留旧数据并允许重试 |
| `MODEL_UNAVAILABLE` / `MODEL_VENDOR_MISMATCH` | 模型不可用或引用归属不符，重新选择模型 |
| `PROVIDER_DISABLED` | 旧 Provider 引用失效，重新选择中转站模型 |
| `PROJECT_INVALID` | 路径不存在或无权限，重新定位项目 |
| `REVISION_CONFLICT` / `REQUEST_CONFLICT` | 并发覆盖或操作 ID 冲突，保留表单并刷新 |
| `SECRET_STORE_UNAVAILABLE` | 服务端密钥库不可用，修复服务配置 |

## 默认配置草案

```jsonc
{
  "provider": {
    "leidiandonghua": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "雷电动画",
      "options": {
        "baseURL": "https://api.leidiandonghua.cn/v1"
      }
    }
  }
}
```

厂商列表、统一 Key 开关、各 API Key **不进这份默认配置**，只进本机认证存储。内置厂商 ChatGPT / Grok 由代码写死，不靠用户配置文件创建。

内置厂商写死，模型不写死：

```ts
const builtinVendors = [
  { id: "chatgpt", name: "ChatGPT", efforts: ["low", "medium", "high", "xhigh"] },
  { id: "grok", name: "Grok", efforts: ["medium", "high", "xhigh"] },
]
```

模型列表来自 `/v1/models` 缓存。档位中文标签：

```ts
const effortLabel = {
  low: "轻度",
  medium: "中",
  high: "高",
  xhigh: "极高",
}
```

## 项目（参考 Codex 桌面版）

OpenCode 已有首页项目列表和「打开项目」（选已有目录）。本 fork 要在**会话界面**做成 Codex 那样的一等入口，并补上真正的「新建项目」，不能只是打开已有文件夹。

会话顶栏或输入条旁始终显示当前项目：

```text
┌ 项目 ▾  GPT-5.2 · 中  … ┐
│ 我的动画                    │
└────────────────────────────┘
```

点开后：

```text
┌ 项目                              ┐
│ 搜索项目…                          │
│                                   │
│ 最近                              │
│   我的动画                         │
│   Default Project                 │
│ 全部                              │
│   …                               │
│                                   │
│ [ 新建项目 ]   [ 打开已有项目 ]    │
└───────────────────────────────────┘
```

### 选择项目

- 点列表中的一项：切换当前工作目录，后续对话、文件树、搜索都落在该项目。
- 当前项目高亮。
- 可按名称 / 路径搜索。
- 空列表时主按钮是「新建项目」，次按钮是「打开已有项目」。
- 切换项目不改厂商 Key、不改已勾选的管理模型。

### 项目列表

首页侧栏和会话里的下拉共用同一份项目数据：

- 已打开的本地目录
- 最近关闭（可再打开）
- 显示名称（目录名或用户改过的名字）、路径、可选图标
- 可关闭（移出列表，不删磁盘）
- 可编辑显示名 / 图标（沿用现有编辑项目对话框）
- 桌面端可在资源管理器中显示该文件夹

列表不要再按官方 provider 分组；按最近使用排序，搜索时按名称和路径过滤。

### 新建项目

与「打开已有项目」必须分开。现有 `session.new.project.new` 文案是「新建项目」，实现却是打开目录选择器，本需求要改掉。

| 操作 | 含义 |
| --- | --- |
| 打开已有项目 | 选一个已存在的文件夹，加入项目列表并切过去 |
| 新建项目 | 创建新文件夹，加入列表并切过去 |

新建流程：

```text
┌ 新建项目                         ┐
│ 名称    [ 我的动画            ]  │
│ 位置    [ D:\Projects     浏览 ] │
│ 路径预览 D:\Projects\我的动画    │
│                                  │
│              [取消]  [创建]      │
└──────────────────────────────────┘
```

规则：

- 名称必填；非法路径字符当场提示。
- 位置默认用户主目录或上次新建用的父目录；可浏览。
- 目标已存在且非空：禁止覆盖，提示改名或改用「打开已有项目」。
- 目标不存在：创建目录。
- 空目录：直接作为项目打开，不强制 `git init`（若现有 `project.initGit` 在空目录会建仓库，新建时改为可选「初始化 Git」，默认不勾）。
- 创建成功：写入项目列表、设为当前项目、打开新会话。
- 权限失败 / 磁盘失败：行内错误，不进官方 Connect 流程。

桌面端用系统选目录；Web / 无文件对话框时用现有 directory picker。

### 打开已有项目

保留现有选目录能力，文案用「打开已有项目」，不要写成「新建」。选中后：

- 已在列表中：只切换过去
- 不在列表中：加入后再切换

### 会话与首页

- 首页：项目列表 + 新建 + 打开已有，点项目进入该项目的会话。
- 会话页：随时可再选 / 新建 / 打开，不必先回到首页。
- 无当前项目时，输入条旁显示「新建项目」，不允许在未选项目时对不明目录写文件。

## 主界面布局（对齐 Codex 桌面版）

目标：会话主界面的分区、密度、顶栏和右侧栏与 Codex 桌面版同一套结构。不追求像素级抄图标/动画，但用户一眼应能按 Codex 习惯找到项目、对话、文件、变更、终端。

### 目标骨架

```text
┌──────────────────────────────────────────────────────────────┐
│ 项目 ▾    会话标题              模型 · 档位     设置         │
├─────────────┬────────────────────────────┬───────────────────┤
│             │                            │ 文件 | 变更 | 任务 | 终端 │
│  （可选）   │         对话时间线         │                   │
│  会话列表   │                            │  树 / diff / PTY  │
│             │                            │                   │
│             ├────────────────────────────┤                   │
│             │ 输入条（项目·模型·档位·批准·更多设置） │                   │
└─────────────┴────────────────────────────┴───────────────────┘
```

和当前 OpenCode 的差异：

| 区域 | 现在 | Codex 对齐后 |
| --- | --- | --- |
| 项目入口 | 偏左侧栏 + 首页 | 顶栏 / 输入条旁一等选择器（见上一节） |
| 会话列表 | 左侧栏为主 | 可收进左侧窄栏或顶栏下拉，不占 Codex 那种大左栏 |
| 对话 | 中间 | 保持中间，占主宽度 |
| 文件 / 变更 | 已有右侧 `SessionSidePanel` | 固定为右侧栏，Tab 化 |
| 终端 | 多在底部；v2 可叠在右栏 | 收进右侧栏「终端」Tab，默认不占满底 |
| Todo | 输入条上方 dock | 右侧栏「任务」Tab 为完整列表；输入条 dock 只保留进行中摘要 |
| 模型 / 档位 | 输入条旁英文 variant | 输入条内随时改：厂商·模型·档位 |
| 会话设置 | 独立设置对话框为主 | 输入条内随时改常用项；完整设置仍可从「更多」进入 |

### 右侧栏首版范围（只补齐已判定可行的）

不另起布局、不新协议。在现有 `SessionSidePanel` 上收成四个 Tab，外加变更区顶部的 Git 只读摘要。

| Tab | 首版要做成 | 数据来源 |
| --- | --- | --- |
| 文件 | 默认随会话打开；分段「全部 / 变更」；点文件在右侧打开，不挤掉中间对话 | `FileTree` / file browser |
| 变更 | 独立 Tab：脏文件列表 + diff；无变更时空状态 | Review panel + fileTree `changes` |
| 任务 | 完整 todo 列表（pending / in_progress / completed）；进行中可钉在栏顶 | `session.data.todo` |
| 终端 | 作为右栏 Tab；可多 PTY；关 Tab 默认不杀进程 | `TerminalPanelV2`（已能叠在右列） |

Git **只读摘要**挂在「变更」Tab 顶，不单独成第五个 Tab：

- 显示：当前分支名、脏文件数、简短 status
- 不显示：commit / push / pull / PR
- 非 git 仓库：摘要隐藏，变更 Tab 仍可用（未跟踪文件）

Todo 分工（避免两处重复）：

- 右侧「任务」= 完整列表
- 输入条上方 dock = 仅进行中一条摘要；无进行中则隐藏

右侧栏外壳：

- 桌面宽度默认打开；可拖宽、可折叠成图标轨。
- 同一时间一个主 Tab；终端与文件可按 Codex 习惯分上下（上文件/变更，下终端），对应现有 `sessionPanelLayout.stacked`。
- 无项目时右侧栏空状态引导「新建 / 打开项目」，不渲染错误工作区的文件树。
- 移动端不强制右侧栏，沿用现有底部 Tab。

明确不做（已判定不可行或超出首版）：

- 完整 Git 客户端（commit / push / PR）
- IDE 级多列编辑
- 把 MCP / LSP / 插件设置塞进右侧栏
- 从零重画布局、丢掉 `SessionSidePanel`
- 终端继续独占底栏
- 把左侧项目栏整段搬到右侧

v1 与 `newLayoutDesigns` **两套都要改**，默认走新布局。

## 输入条内随时设置（对齐 Codex 桌面版）

常用会话设置放在**输入框工具栏**，发消息前就能改，不必先去左侧「设置」或顶栏设置页。完整厂商 Key / MCP 仍走设置页，但从输入条「更多」能跳过去。

```text
┌─────────────────────────────────────────────────────────┐
│  输入…                                                  │
│  项目 ▾   GPT-5.2 ▾   中 ▾   批准 ▾   ···               │
└─────────────────────────────────────────────────────────┘
```

输入条上的控件（从左到右，参考 Codex 密度）：

| 控件 | 随时可改 | 点开 |
| --- | --- | --- |
| 项目 | 是 | 项目列表 / 新建 / 打开已有 |
| 模型 | 是 | Codex 式模型对话框（厂商分组 + 已勾选模型） |
| 档位 | 是 | 轻度 / 中 / 高 / 极高（按当前模型显示子集） |
| 批准模式 | 是 | 询问（ask）/ 自动批准（`--auto` 等价）/ 只读规划（Plan） |
| 更多 `···` | — | 技能面板、管理模型、厂商与 API Key、MCP；即现有设置页的入口，不把 Key 输入直接摊在输入条上 |

规则：

- 改模型 / 档位 / 批准立即对**下一轮**请求生效；进行中的一轮不中途换档，除非用户先停止。
- 批准模式对应现有 `permission`：询问 = 工具 `ask`；自动批准 = 非 deny 自动 allow；只读规划 = 切到 Plan 智能体（edit/bash 为 ask 或 deny）。
- API Key、添加厂商、获取模型列表**不**做进输入条，避免误触和密钥暴露。
- 「已安排任务」入口可放在输入条 `···` 或左侧栏，不占输入条主按钮。

## 已安排任务（对齐 Codex 桌面版）

OpenCode **没有** Codex 那种到点自动跑的任务。会话 todo、排队跟进、失败重试都不是定时任务。本 fork **要加**，且判定可行。

依据：桌面端已有后台 CLI daemon（`packages/desktop/src/main/background-cli.ts`、`packages/cli/src/services/daemon.ts`）。调度挂在本地 server 上，不新造云服务。

### 产品

左侧栏或 `···` 打开「已安排任务」面板（样式参考 Codex）：

```text
┌ 已安排任务                         ┐
│ [ + 安排任务 ]                     │
│                                    │
│ 每天 09:00  检查依赖更新    我的动画 │
│ 明天 18:00  生成周报        Default  │
│                                    │
│ 空状态：还没有已安排的任务          │
└────────────────────────────────────┘
```

创建/编辑：

| 字段 | 首版 |
| --- | --- |
| 名称 | 必填 |
| Prompt | 必填，到点作为用户消息发给该项目新会话；首版不复用指定会话 |
| 项目 | 必选，已有项目列表 |
| 时间 | 一次性（日期+时刻）或每天（时刻） |
| 模型 | 必须解析为可用模型，初始选当前输入条模型；保存明确的模型与档位，不在执行时静默换模型；任务每次运行创建新 Session，TaskRun 关联该 Session |
| 批准 | 默认「自动批准」，表单、列表和运行记录持续显示该状态；可改为「询问」，遇 ask 则等待用户处理 |

列表操作：启用/暂停、编辑、删除、立即运行一次。到点后开新会话跑 prompt，完成后通知（沿用现有桌面通知）。失败写入该任务的上次错误，不自动死循环重试（可手动再跑）。

### 运行约束

- **仅桌面 / 本地 daemon 在跑时**准时触发。应用退出且 daemon 停了：错过的一次性任务在下次启动补跑（距计划时间未超过 24h）；每天任务跑最近一次应跑而未跑的，不补历史每一天。
- 纯远程 Web、无本机 server：**不保证**定时；面板可建任务但标明「需本机 OpenCode 在运行」。
- 到点没有可用 API Key：记录配置错误并暂停任务；项目目录失效同样暂停，修复后由用户恢复，不弹官方 Connect。
- 与右侧「任务」Tab 的 todo **分开**：todo = 当前会话清单；已安排 = 未来定时任务。
- 不在输入条把 prompt 误存成定时任务；必须进「安排任务」表单。

### 不做（首版）

- cron 表达式、每周/每月复杂日历
- 云端、多机同步
- 依赖「用户一直开着会话窗口」
- 到点自动 git push / 发邮件（除非 prompt 里模型自己做且批准允许）

### 可行性

**可行。** 存储用本机 JSON/SQLite + daemon 轮询或系统定时即可。风险是 Windows 休眠错过触发，用启动补跑兜底。

输入条补充（属于上一节，勿与任务调度混淆）：

- 输入条始终可见（含新会话空状态），设置不必先有消息。
- 窄宽度时：模型+档位收成一颗摘要按钮；批准保留短标签，不能藏进 `···` 后让用户看不到当前模式。
- 不要再把「设置」主要放在左侧栏底部当唯一入口；左侧可留齿轮，但会话内默认用手边的输入条。

### 已拍板（右侧栏）

右侧栏按上表补齐，全部可行、全部纳入首版。顺序：

1. 右栏 Tab 壳：文件 / 变更 / 任务 / 终端，桌面默认打开
2. 任务列表接入 `session.data.todo`；dock 降为进行中摘要
3. 终端迁入右栏 Tab（需要时与上方面板 stacked）
4. 变更 Tab 顶加 Git 只读摘要
5. 再调顶栏项目 + 模型摘要密度

## 子智能体（对齐 Codex 桌面版）

OpenCode **已支持**子智能体（`mode: subagent`，Task 工具，内置 General / Explore / Scout，可 `@` 调用）。缺的是 Codex 式呈现，不是再造一套调度。

现状：子智能体开**子会话**，用户切进去看；子会话不能继续打字（`session.child.promptDisabled`）。Codex 桌面则把子任务嵌在**主对话时间线**里，用户一般不离开当前会话。

### 目标交互

主时间线里每条 subagent 是一张可折叠卡片，而不是跳走：

```text
主会话
  用户：帮我查登录逻辑并改 bug
  助手：
    ┌ Explore · 查找登录相关代码          进行中 ▾ ┐
    │ 正在搜索 auth、login …                        │
    │ read src/auth.ts                              │
    └───────────────────────────────────────────────┘
    ┌ General · 修复校验                           ┐
    │ 已完成 · 点开看改动                           │
    └───────────────────────────────────────────────┘
```

首版要对齐的：

| 能力 | 做法 |
| --- | --- |
| 自动调用 | 保留 Task 工具，主智能体按 description 拉起子智能体 |
| `@` 手动调用 | 保留；菜单文案可改成更短的中文角色名 |
| 主时间线嵌套 | 父会话时间线渲染子任务卡片：名称、状态（进行中/完成/失败）、一行摘要 |
| 展开详情 | 点卡片展开该子会话的工具/输出，默认不路由到子会话页 |
| 并行 | 多张卡片同时进行中 |
| 后台 | 已有 background subagent；卡片显示「后台运行」，不挡主输入 |
| 权限 | 子智能体 ask/deny 仍在父会话处理，不把用户丢进子会话才能点允许 |
| 输入条 | 始终打给当前主会话；子卡片上不放独立 composer |

仍可进子会话（次要路径）：卡片菜单「在独立会话中打开」，给要看完整日志的人。默认路径是嵌在父时间线。

### 右侧栏

「任务」Tab 列的是 todo，不是子智能体列表。进行中的 subagent 只出现在主时间线卡片；数量可在顶栏或任务 Tab 顶用一行摘要，如「2 个子任务进行中」。不要把 Explore/General 和 todo 混成一张表。

### 可行性

**可行，且应做。** 不改模型协议。

- 子会话、Task 工具、父子导航、TUI subagent footer 已有
- 桌面端已有 child session 标题和「不能向子会话发 prompt」
- 要改的是：父时间线消费 child session 事件，画 Codex 式卡片；默认不 `navigate` 到 child

不做：

- 取消子会话存储（仍用 child session 当实现）
- 让子智能体在父会话里再套一层无限深度 UI（后端 `subagent_depth` 默认 1，UI 只展示一层卡片）
- 在卡片里再开一套完整 ChatGPT 式对话

## 技能与 MCP（官方，不导入插件）

扩展能力只走两条路：**技能**和 **MCP**。不导入官方 ChatGPT / Codex 插件，也不把 OpenCode 的 JS/TS plugin hook 当成官方插件的兼容层。

官方插件（GPT Actions、Codex 扩展、ChatGPT 侧边栏插件）和 OpenCode `plugin` 不是同一套 API，无法直接加载。能共用的能力改用 `SKILL.md` 或 MCP 服务器接进来。

### 技能

沿用 OpenCode 已有发现路径，优先读官方 / Claude 兼容目录，不必先改写成 `.opencode/skills`：

| 位置 | 用途 |
| --- | --- |
| `.claude/skills/<name>/SKILL.md` | 项目内官方/Claude 技能 |
| `~/.claude/skills/<name>/SKILL.md` | 用户全局 |
| `.agents/skills/`、`~/.agents/skills/` | Agent 兼容技能 |
| `.opencode/skills/`、`~/.config/opencode/skills/` | 仅当官方目录没有、需要本 fork 补一份时 |

规则：

- `SKILL.md` 需有 `name` + `description`；目录名与 `name` 一致。
- 主智能体通过现有 `skill` 工具按需加载。
- 关闭外部技能扫描用现有环境变量即可，不另做导入器。
- **不提供插件入口。** 左侧栏用「技能」替换任何插件/扩展入口。

### 左侧栏技能面板（参考 Codex 桌面版）

首页与会话左侧栏底部（设置 / 帮助旁）增加 **技能**，不要出现「插件」。

点开后是独立面板（对话框或右侧/浮层），样式对齐 Codex 桌面技能面板，不是设置页里一长串开关。

```text
┌ 技能                              ┐
│ 搜索技能…                          │
│                                   │
│ 已启用                            │
│   git-release          [开]  …    │
│   pdf-reader           [开]  …    │
│                                   │
│ 可添加                            │
│   从文件夹添加                     │
│   已发现但未启用的技能…            │
│                                   │
│ [ + 添加技能 ]                    │
└───────────────────────────────────┘
```

面板内容：

| 区 | 行为 |
| --- | --- |
| 已启用 | 当前 allow 的技能：名称、一句 description、开/关 |
| 可添加 | 已发现但未启用（deny / 未纳入）的技能；点添加 → allow |
| 添加技能 | 选一个含 `SKILL.md` 的文件夹，或指向 `.claude/skills` 下已有目录；校验 name/description 后加入 |
| 搜索 | 按名称、描述过滤 |
| 详情 | 点一项可看完整 SKILL.md 摘要；可设 allow / ask / deny |

规则：

- 「可添加」不是 ChatGPT 插件商店，只扫描官方兼容技能目录 + 用户自选文件夹。
- 添加成功后出现在已启用列表，会话里的 `skill` 工具立刻能看到。
- 关掉 = 对该技能 `deny`（对模型隐藏），不删磁盘上的 `SKILL.md`。
- 删除/移除仅对用户自己添加的路径；内置发现目录里的技能只能关，不能从磁盘删。
- 文案全程用「技能」，不用「插件」「GPTs」「扩展」。
- 窄左侧栏只显示图标；展开后显示「技能」。

### MCP

把 ChatGPT / Codex 里用的 MCP 服务器抄到 `opencode.json` 的 `mcp`：

- 本地：`type: "local"`，`command` 数组（与官方配置里的启动命令对应）
- 远程：`type: "remote"`，`url` + 可选 `headers` / OAuth

设置页保留 MCP 列表：启用/禁用、本地命令、远程 URL。不把 MCP 伪装成「插件」。

同一套 MCP 服务器进程可与 ChatGPT / Codex 共用；只是配置文件要写成 OpenCode 的 `mcp` 字段，不能直接读 Codex 的 `config.toml` 当唯一源。若后续要自动同步官方 MCP 列表，另开需求，首版手工（或文档说明）迁移即可。

### 不做

- 安装或运行 ChatGPT GPT / Codex 插件包
- 为官方插件写 OpenCode plugin 适配器
- 在设置或左侧栏提供「导入插件」入口
- 把 MCP 工具或技能显示成插件商店
- 左侧栏保留「插件」字样或入口

## 体验与设计补充（Codex 桌面版方向）

本节是对前述需求的实现约束，优先保证主流程清晰、低频设置不打扰对话，并避免各页面各自解释“参考 Codex”。

### 分阶段交付

按以下顺序交付，后一阶段不得阻塞前一阶段的核心可用性：

1. **核心可用**：固定中转站、厂商与密钥、模型拉取/勾选、模型选择、项目新建/打开/切换、输入条设置。
2. **桌面体验**：中间对话 + 右栏、文件/变更/任务/终端、子智能体卡片、技能面板。
3. **后台能力**：一次性与每天任务、daemon 补跑、运行记录和失败重试。

### 统一设计系统

- 间距只使用 4/8/12/16/24/32px；圆角、边框和阴影使用共享 token，不在页面内自定义。
- 按钮分为主操作、次操作、文字操作和危险操作；删除、清除密钥等危险操作必须二次确认。
- 所有交互组件具备默认、悬停、键盘焦点、按下、禁用、加载、成功和失败状态。
- 桌面布局：左侧窄轨 56px，展开宽度约 240px；右栏默认 320px，可在 280–480px 拖动；宽屏对话区保留至少 560px。所有尺寸加上分隔线与留白后必须能容纳于窗口。
- 以实际可用宽度决策：三栏放不下时先把左栏收为窄轨，再把右栏改为抽屉；小于 960px 默认右栏抽屉，小于 700px 左右栏均为覆盖层，对话区允许缩至窗口宽度。禁止用 560px 最小宽度撑出页面横向滚动。
- 文本、按钮和状态颜色满足 WCAG AA；支持完整键盘导航和 `prefers-reduced-motion`。

### 编辑状态边界

- Vendor 表单草稿与模型可见性分离：名称、Key、Vendor 设置遵守取消不落盘；候选模型勾选属于管理模型即时操作，勾选即写入并显示已自动保存。
- 编辑中输入的新 Key 只可用于当前表单的测试和候选拉取；保存前不得更新持久化 Key 引用，取消后清理内存值和临时缓存。
- 运行中的请求固定其 Session/Location、模型、Vendor 和 Key 配置快照；输入条后续修改只影响下一条输入。

### 输入条与状态反馈

- 输入条固定显示项目、厂商/模型、档位和批准模式；模型/档位共用前述模型对话框，项目与批准使用轻量菜单。无推理能力时不显示档位。
- `···` 只放 API Key、MCP、技能和高级会话设置等低频操作。
- 无项目时禁止发送，并提供“新建项目”和“打开已有项目”两个直接入口。
- 没有 Key、模型未拉取、项目路径失效时，错误提示必须带可执行的修复入口。
- 切换项目时保留未发送草稿；项目切换后文件树、终端和 Git 状态必须同步切换。

### 厂商与模型界面

- 厂商列表使用卡片：首行显示名称、密钥状态、可见模型数量和连接状态；编辑/删除放入更多菜单。
- 统一 Key 启用时显示“使用统一密钥”，隐藏或禁用独立 Key 输入，不让用户误以为两套 Key 同时生效。
- 模型选择器支持搜索、键盘上下选择、Enter 确认和最近使用置顶。
- 没有可见模型的厂商显示“去设置获取模型”；模型已下架时保留并明确标记。
- 管理模型和候选模型必须共享同一份可见性状态，禁止维护两套相互独立的开关。

### 项目与右栏状态

- 项目列表分为“最近使用”和“所有项目”，显示名称、路径和最近使用时间。
- 项目不存在、无权限或被移动时显示可恢复错误，不加载旧目录的文件树或终端。
- 右栏四个 Tab 的状态按项目保存，并显示未读/变更数量。
- 变更 Tab 在非 Git 目录显示空状态；终端始终显示当前项目路径。
- 任务 Tab 展示完整 Todo；输入条 dock 只展示进行中摘要，避免重复。

### 子智能体卡片

- 卡片状态至少包括进行中、等待权限、完成、失败和后台运行。
- 等待权限时可在父时间线直接批准/拒绝；失败时提供错误原因和重试。
- 输出默认折叠，卡片只展示名称、状态、摘要、耗时和修改文件数；详情可展开。
- UI 只展示一层嵌套；“在独立会话中打开”作为次要操作保留。

### 技能、MCP 与安全

- 技能权限统一为开启、询问、禁用，并显示来源（项目、用户全局、手动添加）。
- MCP 显示服务器连接状态和服务器级错误，不把 MCP 错误混入模型错误。
- API Key 按“密钥存储与迁移”执行；日志、错误、遥测和崩溃报告必须脱敏。
- 旧 Provider 配置迁移前自动备份；迁移失败可回滚。
- 加载层同时过滤旧配置、环境变量和 `opencode.json` 中的官方 Provider，不能只隐藏设置页入口。
- 删除厂商前提示受影响的模型和 session；改 Vendor ID 时必须完成数据迁移或拒绝保存。

### 会话设置、草稿与性能

- 每个已提交 prompt 固定所属 Session/Location 和模型设置；生成途中改模型、档位或批准模式仅影响下一条新输入，不能改变进行中的工具审批或请求。界面显示“下一条消息使用”。
- 切换项目只切换导航与后续新会话位置，不搬迁现有 session、不改变运行中终端 cwd；旧项目终端与生成可继续后台运行，新项目只展示自己的实例。
- 草稿按 Server + 项目 + session 保存；新会话有单独草稿槽。切换后恢复对应草稿，不把旧项目草稿自动带到新项目。发送成功后清除，失败保留；密钥表单不参与草稿持久化。
- 发送前按优先级反馈项目失效、无可用模型、密钥问题；生成中提供停止及已有的 steer/queue 交互，等待权限在父会话显示审批入口，避免全局禁用输入造成死路。
- 模型对话框先展示可见登记和最近缓存，手动刷新不阻塞搜索；只有候选列表拉取/有效 Key 状态更新完成才更新对应数据。
- 右栏按需加载：首次打开文件 Tab 只列首层，展开目录再取内容；单目录超过 500 项分批加载，超过 200 行用虚拟列表并提供“加载更多”。
- Git 摘要由文件事件合并刷新（500ms 防抖），只取当前所需摘要/所选文件 diff；不在每条流式消息时运行全量 diff。大型或超时结果显示部分加载状态和手动刷新。
- 终端渲染缓冲每实例最多 10,000 行；超过后丢弃最旧显示记录并标记，不影响进程。清屏仅清显示，停止进程另有按钮；详情输出和长工具日志按需展开。
- 右栏宽度、开关按 Server/项目保存，Todo 按 session 隔离；只有有意义的 Tab 显示计数，不能把 Todo 数量当成子智能体数量。

### 调度一致性

- 首版调度数据使用本机 SQLite，原子创建唯一 `(taskId, scheduledAt)` 的运行记录；多窗口共享同一个 daemon。手动运行用独立操作 ID，双击与网络重试不能产生两次运行。
- 按项目串行调度自动任务，不限制用户主动创建的不同 Session 并发；到期任务已被锁定时不另开一份。持久化触发去重与进程内 Session 协调分离，不实现跨机器执行租约。
- 调度创建稳定 Session ID 和 prompt message ID，通过 `SessionV2.prompt` 持久化准入；重试必须保持 Session、prompt 与 delivery mode 完全一致，复用现有精确重试语义，不绕过 runner。
- 补跑只处理从未开始准入的漏触发：24h 内一次性任务补一次，每天任务只补最近一次；超过窗口标为“已错过”。已经准入或开始执行但崩溃后结果未知的 run 标“中断待确认”，不自动重放 provider/tool 工作。
- 每天按保存的 IANA 时区计算；系统换时区不改变任务时区。夏令时缺失时刻顺延到首个有效时刻，重复时刻只执行首次；一次性时间保存为明确 UTC 时刻。
- 首版不自动重试模型/工具失败；用户手动重试产生关联的新 run 并提示核查已有副作用。停止仅作用于活动执行，不承诺撤销已完成工具；暂停阻止后续触发，不等于停止当前 run。
- Key 被清除、模型被移除或项目失效时暂停并记录原因；修复后手动恢复。自动批准始终以配置快照显示，工具实际权限仍遵循系统既有 deny/ask 边界。

### 已安排任务补充规则

- 保存时明确时区、执行时间、使用的项目、模型、档位和批准模式。
- 首版只保证一次性和每天任务；不支持 cron 表达式或云端调度。
- daemon 重启后的补跑、同项目串行和崩溃中断按“调度一致性”执行；不把正在运行但状态未知的任务当成未执行任务重跑。
- 每次运行保存开始时间、结束时间、状态、错误摘要和关联 session；失败提供手动重试和停止入口。
- 项目被删除或路径失效时，任务暂停并要求用户重新选择项目。

## 改动范围

### UI

- `packages/app/src/components/settings-providers.tsx`
- `packages/app/src/components/settings-v2/providers.tsx`
- 新的厂商表单：添加与编辑共用，编辑时回填；替换现有只创建、不更新的自定义提供商对话框
- `packages/app/src/components/dialog-connect-provider.tsx`（去掉官方列表）
- `packages/app/src/hooks/use-providers.ts`
- 模型选择对话框：按 vendor 分组，自动展示拉取结果；档位用轻度/中/高/极高分段按钮（参考 Codex 桌面版）
- 会话输入条：项目、模型、档位、批准模式随时可改；`···` 进入完整设置（厂商 Key / MCP / 技能）
- 会话顶栏 / 输入条旁的项目选择器：当前项目、项目列表、新建项目、打开已有项目（参考 Codex 桌面版）
- 主界面改成 Codex 式：中对话、右栏 Tab（文件 / 变更 / 终端 / 任务）
- `packages/app/src/pages/session/session-side-panel.tsx` 及 terminal / review / file-tree / todo dock
- 父会话时间线：子智能体改为 Codex 式嵌套卡片，默认不跳转子会话页
- TUI 对应连接 / 模型 / 档位界面，文案同样用中文档位名
- 左侧栏「技能」入口（替换插件）；打开 Codex 式技能面板：已启用 / 可添加 / 添加技能
- 已安排任务面板：创建一次性/每天任务，daemon 到点开项目会话跑 prompt
- 设置页可保留 MCP 列表；技能以左侧面板为主，无「导入插件」

### 核心

- 内置 `leidiandonghua` provider（URL 写死）
- 认证存储扩展为 unified + vendors
- 请求发出前按 vendor / 统一 Key 选择 `Authorization`
- 用有效 Key 请求中转站 `/v1/models` 作为候选缓存；「测试连通」和「获取模型列表」走同一接口
- 勾选候选模型 → `setVisibility(..., show)`，写入管理模型；取消勾选 → hide
- 会话模型选择器只读管理模型中 visible 的项，不读全量拉取结果
- 按厂商表生成 variant（轻度/中/高/极高），写入请求 body
- Catalog 过滤 / provider policy
- 默认模型解析只落在该 provider
- 已安排任务：本机持久化 + daemon 调度；到点 `session` 发 prompt

### 不改

- 本地 / 远程 OpenCode Server 连接、健康检查、server picker
- OpenCode plugin 运行时（不接官方插件，也不新写适配器）
- 完整 Git 客户端；右侧栏只带变更区只读摘要

## 实施步骤

1. 增加内置 `leidiandonghua` provider，URL 写死。
2. 认证改为「统一 Key + 分厂商 Key」。
3. 设置页改为厂商列表：内置 ChatGPT / Grok，可添加、可编辑；用户项可删除；带统一 Key 勾选。
4. 厂商表单支持回填与更新，禁止「只能删了再建」。
5. 去掉官方 popular / connect / 自定义 URL 入口。
6. 请求层按当前模型所属厂商选 Key。
7. 设置页提供「测试连通」和「获取模型列表」，均请求 `/v1/models`。
8. 获取列表后展示勾选；勾选的模型自动进入管理模型并在会话选择器可见。
9. 模型对话框按 Codex 桌面版呈现，且只显示管理模型中已勾选的项；档位为轻度/中/高/极高。
10. Catalog 与模型解析只允许该 provider。
11. TUI 同步限制，已配置厂商可编辑，档位文案一致。
12. 处理旧配置、环境变量、其他 provider 残留。
13. 会话与首页补齐 Codex 式项目入口：选择项目、项目列表、新建项目（真建目录）、打开已有项目。
14. 主界面按 Codex 骨架改：中对话，右侧栏 Tab 化；输入条内随时改项目 / 模型 / 档位 / 批准模式。
15. 右侧栏首版补齐：文件 / 变更 / 任务 / 终端；变更顶栏加 Git 只读摘要。todo 完整列表在侧栏，dock 只留进行中摘要。
16. 子智能体：父时间线嵌套卡片（进行中/完成/失败、可展开），默认不进入子会话；权限在父会话处理。
17. 左侧栏用「技能」替换插件入口；打开 Codex 式技能面板（已启用 / 可添加 / 添加 SKILL.md 文件夹）。MCP 仍走配置，不进该面板当插件。
18. 第三阶段实现已安排任务：面板 + 一次性/每天调度；桌面 daemon 到点跑；错过则启动补跑。与会话 todo 分开。
19. 补设置页、获取列表勾选、管理模型同步、测试连通、档位映射、统一 Key、请求鉴权、新建/切换项目、右侧栏 Tab、子智能体卡片、技能面板、已安排任务测试。

## 已确定决策与待验证协议

以下产品决策已收口，不再作为实施前审批项：

| 项目 | 决策 |
| --- | --- |
| 上游与厂商显示名 | 上游“雷电动画”；内置厂商“ChatGPT”“Grok”；Claude 使用正确拼写 |
| 密钥切换 | 统一和独立 Key 均保留，只切换解析方式；不互相覆盖 |
| 旧 session | 保留历史消息与原模型标识；模型失效时禁止继续发送，提示重选，不静默迁至 ChatGPT |
| Vendor ID | 首版创建后不可修改；名称可改。未来支持改 ID 必须迁移缓存、可见性与 session 引用 |
| 模型归属 | 手动归属优先；自动识别冲突进入待确认；自定义厂商从候选列表认领，不手填 ID |
| 档位 | 使用经验证的模型能力；low/minimal 同时存在时轻度映射最低有效档；未知能力不展示档位 |
| TUI | 固定 Provider、厂商密钥管理、模型获取与可见性、中文档位；不做桌面项目侧栏、右栏、技能面板或调度面板 |
| 布局 | 可折叠左轨、中间对话、右栏 Tab；终端可与文件/变更上下分栏 |
| 调度 | 第三阶段交付一次性与每天任务；默认自动批准，创建页和运行中持续显示；可选择询问 |
| 中文 | Desktop/Web 默认中文，新增界面与错误文案提供中文 |

仍需通过上游文档或获授权的测试确认：`owned_by` 实际取值、模型能力来源、各模型的推理参数和上下文限制。`GET /v1/models` 通常不足以证明这些能力。未验证字段不凭厂商名称猜测；保留版本化能力表，未知项用普通兼容请求并隐藏未证实的推理选项。协议验证不改变固定 URL 或引入官方 catalog。

## 风险

- 只改 UI，用户仍可通过配置文件或环境变量使用其他官方提供商。
- 设置页有 v1 和 settings-v2 两套，漏改一套会回流官方列表。
- TUI 有独立连接界面，桌面/Web 改完后终端仍可能连官方提供商。
- 多把 Key 若仍走现有「一 provider 一 key」存储，统一 Key / 分厂商 Key 会对不上，必须扩展 auth 结构。
- 模型与厂商映射错误时，会把 GPT 请求带到 Grok 的 Key（或反过来）。
- API Key 不能写进仓库或前端包体。
- 勾选统一 Key 后若仍读取各厂商旧 Key，会出现“界面显示统一、实际用了别的 Key”。
- 现有自定义提供商只有创建路径；若不做更新 API，编辑会变成重复 ID 或用户只能删除重建并丢失 Key。
- 编辑时把 Key 回显到输入框有泄露风险；留空当“不修改”若未讲清，会被当成清空。
- 改 Vendor ID 但不迁模型归属，会出现名称变了、请求仍走旧槽位。
- `/v1/models` 若返回全量模型且不分 `owned_by`，所有厂商会看到同一张表，必须有归属规则或手动勾选。
- 用官方 Models.dev 补全名称/档位会把已删除的官方提供商间接引回来，禁止。
- 现有 openai-compatible variant 插件几乎不生成档位，不扩展的话界面四档选了也不进请求。
- 把四档画死在所有模型上，Claude/Gemini 会发出上游不认的 `xhigh`。
- 测试连通若误发 chat completion，会消耗额度且更慢；必须用 `GET /v1/models`。
- 编辑框未保存的新 Key 与已存 Key 不一致时，测试必须明确用哪一把，否则会出现「测通了但保存后仍失败」。
- 拉取成功后若把全部模型自动标为可见，管理模型和选择器会被上百个 ID 刷屏；必须默认不勾选，由用户勾选后才进入管理模型。
- 管理模型与获取列表若各维护一份可见性，会出现一边勾了另一边没有。
- 现有「新建项目」实际是打开已有目录；若不拆开，用户会以为建了新文件夹，其实只是选了旧路径。
- 空目录自动 `git init` 会让「新建项目」多出用户没要的仓库。
- 未选项目就允许发消息，工具可能写到错误工作目录。
- 会话存在 v1 / `newLayoutDesigns` 两套 DOM，只改一套会出现「有的窗口像 Codex、有的仍是底栏终端」。
- Todo 若只搬到右侧栏、输入条 dock 不处理，进行中任务会重复出现两处；要规定：侧栏为完整列表，dock 仅为进行中摘要或去掉其一。
- 文件树默认关闭时，用户会觉得右侧栏「没补齐」。必须改默认打开策略。
- 规划文档文件名仍是 `single-relay-provider.md`，范围已远超提供商；实施时以文内需求清单为准。
- 首版同时含布局改造、认证改造、调度 daemon，工作量很大；必须按 A→F 批次交付，不要平行铺开。

## 统一验收标准

### 功能验收

- 设置页看不到官方提供商，也不能新增其他 URL。
- URL 不可编辑，恒为 `https://api.leidiandonghua.cn/v1`。
- 默认有 ChatGPT、Grok 两个 Key 输入；标签分别为 `ChatGPT API KEY`、`Grok API KEY`。
- 可添加 Gemini / Claude / KIMI 等厂商名称，每项有独立 Key。
- 已配置厂商（含 ChatGPT / Grok 和用户添加项）都可以再编辑；保存为更新，不必删除重建。
- 编辑时 Key 不回显明文；输入框留空表示保持原 Key。
- 内置厂商不可删除；用户添加项可删除。
- 编辑不能改 Base URL。
- 勾选「使用统一 API KEY」后，只填一把 Key，所有厂商请求都用它。
- 取消勾选后回到分厂商 Key，不丢失已保存的独立 Key。
- 未填可用 Key 时不能发对应厂商的模型请求。
- 本地 OpenCode Server 连接入口仍可用。
- 环境变量、旧 `opencode.json`、旧 session 不能再启用 Anthropic / OpenAI 等官方提供商。
- TUI 在 Provider 限制、厂商密钥、模型可见性和中文档位上与 Desktop/Web 一致；不承担桌面布局与调度面板验收。
- 保存 Key 不会把全量模型自动写入管理模型；需点「获取模型列表」后勾选。
- 模型对话框可搜索、按厂商分组；选中后用分段按钮选档位，文案为轻度 / 中 / 高 / 极高。
- 不同厂商只出现自己有的档位；无推理档位的模型不显示档位条。
- 会话输入条可随时改项目、模型、档位、批准模式，不必先打开独立设置页；交互参考 Codex 桌面版。
- API Key / 添加厂商 / MCP 从输入条 `···` 进入，不直接摊在输入框上。
- 批准模式：询问 / 自动批准 / 只读规划，对下一轮生效。
- 拉模型失败时保留上次列表并允许重试，不回退到官方提供商目录。
- 每条厂商有「测试连通」；勾选统一 Key 时也可测统一 Key。
- 测试走 `GET /v1/models`，成功显示已连通（可带模型数），失败显示短因且不打开官方连接流程。
- Key 为空时测试按钮禁用；测试中防连点；未保存的新 Key 可在编辑框里先测再存。
- 每条厂商有「获取模型列表」；拉回的是候选，勾选后自动加入管理模型并在会话选择器出现。
- 取消勾选后该模型从管理模型和选择器消失。
- 管理模型与获取列表共用同一份可见性；管理模型不再提供「连接官方提供商」。
- 未勾选的模型即使已拉取，也不出现在会话选择器。
- 会话里可选择项目、查看项目列表、新建项目、打开已有项目，交互参考 Codex 桌面版。
- 「新建项目」会创建新文件夹并加入列表；「打开已有项目」只选已存在的目录。两者文案和流程分开。
- 切换项目后文件树和后续会话落在新目录，厂商 Key 与管理模型不变。
- 无当前项目时不能对不明目录写文件，输入条引导去新建或打开项目。
- 主界面为中对话 + 右栏。右栏首版四个 Tab：文件 / 变更 / 任务 / 终端；变更顶栏有 Git 只读摘要。可折叠、可改宽。
- 任务完整列表在右侧栏；输入条 dock 仅进行中摘要。
- 终端在右栏，不独占底栏；v1 与新布局都要改到这一套。
- 无项目时右侧栏不加载错误目录；移动端不强制右栏。
- 不做完整 Git GUI、不做 IDE 多列编辑。
- 子智能体保留现有 Task / child session；主界面用 Codex 式嵌套卡片，默认不跳转子会话。
- 用户输入始终留在主会话；子卡片可展开详情，可选「在独立会话打开」。
- 不导入 ChatGPT / Codex / OpenCode 插件；扩展只用官方兼容的技能（`SKILL.md`）和 MCP。
- 左侧栏是「技能」不是「插件」；点开为 Codex 式面板：已启用、可添加、添加技能（选 SKILL.md 文件夹）。
- 能发现 `.claude/skills`、`~/.claude/skills`、`.agents/skills` 中的技能；添加/开启后会话里 skill 工具可用。
- 关闭技能不删文件；无插件商店、无导入插件入口。
- MCP 在 `opencode.json` 配置后可作为工具调用；不出现在技能面板里冒充插件。
- 可创建/暂停/删除已安排任务（一次性或每天）；到点在指定项目开会话跑 prompt。
- 已安排任务与会话内 todo 分开；桌面 daemon 未运行时不保证准时，启动可补跑错过的任务。
- 首版无 cron、无云端调度。

### 体验验收

- 新用户首次启动到发送第一条消息不超过三个必要步骤。
- 常用设置（项目、模型、档位、批准模式）在输入条内最多两次点击可修改。
- 模型选择器和右栏 Tab 可完全用键盘操作。
- 所有页面都有明确的空、加载、成功、失败和重试状态。
- 桌面窗口缩窄时不出现横向滚动；右栏按断点折叠为抽屉或覆盖层。
- v1 与新布局对项目、模型、批准模式、Key 和 MCP 的行为保持一致。
- 日志、遥测和诊断导出不包含 Key、Authorization 或用户绝对路径；项目选择器与终端可向当前用户显示必要的真实路径。

### 量化验证与故障用例
- 通过配置文件、环境变量、旧 session 和直接 HttpApi 请求尝试 Anthropic/OpenAI/Google 时，均在 Server/Core 层返回 `PROVIDER_DISABLED`；不能只验证设置页没有入口。
- 未勾选模型不会出现在现有 Provider catalog、默认模型解析、Session prompt 可选模型或管理模型 API 中；候选缓存只能在 Relay 管理界面可见。
- 两个窗口同时编辑 Vendor 时，旧 `revision` 返回 `REVISION_CONFLICT`；迟到的模型拉取响应不能覆盖新 Key 或新归属。
- 项目切换后检查 `Location(directory, workspace)`、文件树、PTY cwd 和 Session ID：新输入使用新 Location，旧运行继续留在原 Location。
- UI 关闭技能后检查 `/api/skill` 和 System Prompt 均不再暴露该技能；MCP OAuth 过期只影响对应服务器，不影响模型 Key 状态。

- 首次使用按“选择/新建项目 → 设置 Key 并勾选模型 → 发送”三个流程阶段验收，不把每次点击算一个阶段；持有有效 Key、网络正常的新用户目标 3 分钟内完成。
- 输入条单项设置打开不超过一次点击，批准/档位等单项选择不超过两次；新增项目、填写 Key 和搜索输入不计作两次点击目标。
- 在固定记录的 Windows 测试机、生产构建、已有缓存且 1,000 个模型候选条件下，连续 20 次打开模型对话框的 p95 可交互时间小于 300ms；冷启动和网络刷新分别记录，不能用网络耗时掩盖本地卡顿。
- 模型请求到 10 秒超时；用户取消后 1 秒内恢复按钮，迟到结果不覆盖新 Key 状态。覆盖超时、401/403、429、格式错误和取消后返回五类用例。
- 800/960/1280/1440px 宽度及 200% 缩放均无页面横向滚动；代码块/终端可内部滚动。拖动右栏、刷新后宽度恢复，窄窗口按容量收缩。
- 项目选择、模型选择、聚焦输入框、右栏开关、停止生成均有可发现且可配置的快捷键；不覆盖终端自身按键。菜单 Esc 关闭并恢复触发点焦点；中英文输入法组合期间 Enter 不误发消息。
- 两个窗口同时修改厂商、切换统一 Key 后旧请求返回、发送后切换项目：分别验证版本冲突、过期响应丢弃、运行继续留在原 Session/Location。
- 模拟 daemon 重启、双窗口触发、同一任务重复请求、休眠超过 24h 和准入后崩溃：分别验证去重、错过状态和不自动恢复模型执行。
- 用专用测试 Key 检查网络响应、日志与诊断导出，确认无密钥回显；密钥库不可用时拒绝明文降级。配置备份可恢复且不能重新启用官方 Provider。
