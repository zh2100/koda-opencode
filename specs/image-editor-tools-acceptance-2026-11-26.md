# 图片编辑工具栏验收（2026-11-26）

## 结论与边界

隔离开发环境与生产 Web 构建均通过图片编辑专项验收；不等于已安装桌面版或真实供应商端到端验收通过。

- 使用 Chromium、专用 Vite 4343 端口、单 worker 和本地模拟接口。
- 使用合成 128×64 PNG，以及测试内生成的 2048×1024 白底 PNG；没有上传真实图片。
- 没有重启当前 Koda 或真实 server，没有修改真实配置、会话或凭据，没有发送付费供应商请求。
- 参考项目保持只读；本轮没有重新打包或安装桌面应用。
- `agent-browser` 不可用，改用项目已有 Playwright。

## 验收覆盖

1. 新旧布局的选图、拖放入口；PNG 可编辑，GIF/PDF 不误进入遮罩编辑。
2. 画笔／橡皮擦 4–120 原图像素，原生滑块键盘操作；矩形、椭圆填充选区；直线、箭头形选区。
3. 选区／保护区像素与导出遮罩极性：选中部分 alpha=0，未选中及擦除部分 alpha=255；保持原图尺寸。
4. 擦空后禁用检查请求，撤销恢复选区；清空同时移除历史与底层遮罩。
5. 31 笔绘制后最多撤销 30 笔，最旧笔保留；清空后彻底移除。
6. 50%–200% 缩放、端点按钮禁用、适应窗口；缩放不改底层 bitmap。
7. 2048×1024 大图在 LTR／RTL 下放大、水平及垂直滚动后，真实鼠标点击映射至正确原图坐标。
8. 窗口高度变化后适应比例响应更新；拖动中禁用工具；pointercancel 丢弃当前预览、不改变已提交选区；鼠标右键不绘制。
9. 英文 LTR／RTL，真实阿拉伯语生成图片场景，混合文字文件名／描述；360px 中文窄屏无编辑器横向溢出，实际可完成键盘检查／确认。
10. 空白描述不能检查，多行中文／阿拉伯语描述原样提交；检查前零请求，确认后唯一请求，返回编辑保留描述和选区。
11. 原图及结果分版本保留、继续编辑新版本、切换版本重置选区；跨会话及关闭重开不接收旧回执。
12. 自动目标状态区分中转兼容性、能力未知及检查失败；取消后仅查询同一请求。

箭头只是其覆盖像素的遮罩选区，不是模型方向指令；矩形／椭圆选中内部，而非仅边框。

## 本轮发现与修复

- **擦空后无法彻底清历史**：原来清除按钮仅按非空选区启用，完全擦除后仍有可撤销历史但不能一键重置。修为选区非空或历史非空均可清除，并补上 LTR／RTL 断言及清空后不可撤销检查。
- **类型检查覆盖缺口**：通用 E2E 配置没有包含图片编辑回归文件。新增 `bun typecheck:e2e:image-edit` 专项配置，修正测试 Canvas DOM 参数类型；被其纳入的共享 fixture 对可选文本使用空值保护。未修改生产 timeline 实现。
- 首轮新增大图测试的 Escape 会正常关闭编辑窗口，导致后续找不到画布；删除错误测试步骤后通过，不将其记为产品缺陷。

## 首轮开发环境验证

命令均从 `packages/app` 运行，格式检查除外。

| 检查                                                                    | 结果                                           |
| ----------------------------------------------------------------------- | ---------------------------------------------- |
| `bun typecheck`                                                         | 通过                                           |
| `bun typecheck:e2e`                                                     | 通过                                           |
| `bun typecheck:e2e:image-edit`                                          | 通过；实际包含本回归文件                       |
| `bun run test:unit`                                                     | 875 通过，0 失败，3465 次断言，112 文件        |
| `bun run test:browser`                                                  | 240 通过，2 跳过，0 失败，1058 次断言，28 文件 |
| `bun run test:e2e e2e/regression/masked-image-edit.spec.ts --workers=1` | 10 通过，0 失败，约 1.5 分钟                   |

组件测试的两项跳过是已有的真实 hook／TCP 丢 ACK 场景，不属于这次图片工具验收通过项。

证据：

- `.tmp/image-edit-acceptance-final.log`
- `.tmp/image-edit-acceptance-unit.log`
- `.tmp/image-edit-acceptance-components.log`
- `.tmp/image-edit-acceptance-typecheck.log`（专项类型检查输出；App 与通用 E2E 类型检查由前置命令成功执行）
- `.tmp/image-edit-acceptance-scrolled-{ltr,rtl}.png`
- `.tmp/image-edit-acceptance-large-{ltr,rtl}.png`
- `.tmp/image-edit-acceptance-chinese-review.png`

截图显示的是滚动视图，不是整张表单的全长截图；隐藏在视口外的控件由交互测试实际滚动访问。

## 生产 Web 构建复验

- 以 `OPENCODE_CHANNEL=prod` 构建至 `.tmp/image-edit-prod-web`。最终构建耗时 47.16 秒，首页引用带哈希的入口 `assets/index-BqPrEnPL.js`；构建有 chunk 超过 500 kB 的警告，不影响本轮功能验收。
- Playwright 在独立的 `127.0.0.1:4363` 通过 `vite preview` 加载构建产物，不使用开发服务器。API 由 Playwright 模拟；阻断未被 mock 接管的非本地 HTTP(S) 请求，并禁用 Service Worker。只使用合成 PNG。
- 同一套 10 项 Chromium 回归：**生产构建 10 通过、0 失败（42.7 秒）；开发环境交叉复测 10 通过、0 失败（约 1.4 分钟）**。App、通用 E2E 与图片编辑专项类型检查及所改代码的 Prettier 检查均通过。上表的 App 单元和组件测试为首轮结果，并非本轮重跑。
- 生产 RTL 用例由应用加载阿拉伯语设置进入 RTL，无需开发调试按钮或强改根节点。覆盖英文 LTR、阿拉伯语 RTL 中的英文回退与混排，以及 360px 中文界面；英文界面强制 RTL 仅在首轮开发环境验证。
- 复验发现 RTL 下英文回退的模型说明和确认提示标点错位；相应段落用 `dir="auto"`，模型与端点整行保持 LTR，并增加方向断言。中文确认截图拍摄前先滚动至确认按钮完整可见；键盘确认前为零请求，确认后仅一条模拟编辑请求。

复验证据：

- `.tmp/image-edit-production-build-final.log`
- `.tmp/image-edit-production-browser-final.log`
- `.tmp/image-edit-production-dev-final.log`
- `.tmp/image-edit-production-screenshots/`（LTR／RTL 大图及滚动、中文确认）

## 未覆盖范围

- 当前已安装 Electron 应用、重新打包后的桌面生产资源及桌面原生交互。
- 真实供应商的模型可用性、费用、接口权限、实际出图质量及保护区保真度。模拟响应不能证明供应商一定严格遵守遮罩。
- Firefox／WebKit、真实触控笔／移动设备、完整无障碍审计及大图极限性能。
- 本轮仅验收 UI 工具与既有 Web 编辑流程，没有重新执行完整后端测试矩阵或生产重启恢复验收。
