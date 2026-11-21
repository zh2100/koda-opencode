# Koda Desktop

Koda 是数元AI维护的 AI 编程桌面应用。打开本地项目后，你可以在同一个工作空间里与 AI 讨论代码、查看文件和修改记录、运行终端命令，也可以通过 MCP 服务和技能接入项目需要的工具。

**安装桌面版** · [下载最新公开版本](https://github.com/zh2100/koda-opencode/releases/latest)

截至 2026 年 11 月 21 日，GitHub 最新公开安装包为 **v1.0.5**，提供 Windows x64 安装程序、macOS Apple 芯片 DMG，以及 Linux amd64 和 arm64 的 DEB 包。Windows 用户请在发布页的 **Assets** 中下载并运行 `Koda-desktop-win-x64.exe`。已安装的用户可以从 **帮助 → 检查更新** 查看新版本。

当前 `dev` 分支的桌面源码为 **v1.0.6**。要使用下文的提供商模型列表和独立图像生成设置，可以按本文末尾的步骤从源码构建。

## 连接提供商并选择模型

1. 打开项目，进入 **设置 → 提供商**。选择已有提供商，或在 **添加厂商** 中填写名称、提供商给出的 API 基础 URL 和 API 密钥。
2. 保存后点击提供商名称展开详情，再点击 **获取模型列表**。可用模型由提供商和密钥权限决定。
3. 在列表中勾选要在聊天中显示的模型。列表会根据可用宽度显示两列或三列。
4. 回到对话，在模型选择器中选一个已勾选的模型，即可开始提问。你可以按任务创建会话，之后回到项目继续已有对话。

## 在对话中生成图像

进入 **设置 → 模型 → 独立图像生成**，启用图像生成工具，从已连接的模型中选择生图模型，或手动填写 `provider/model`。生图工具使用对应提供商的 API 密钥，可以与当前聊天使用不同的模型。

按提供商文档选择**图像接口**。即使供应商都标注「OpenAI 兼容」，具体选项仍取决于生图请求发往哪个端点。

| 提供商文档给出的生图方式 | 在 Koda 中选择 |
| --- | --- |
| 通过 `/images/generations` 返回 `b64_json` | OpenAI Images |
| 通过 `/chat/completions` 在对话响应中返回 Base64 图像 | OpenAI 兼容对话 |
| 使用 Gemini 或阿里云 DashScope 的原生生图协议 | Google Gemini 或阿里云 DashScope |

点击 **保存生图设置** 后，可在会话中提出绘图要求，例如「生成一张展示项目模块关系的示意图」。提供商需要返回内嵌的 Base64 图像数据，仅返回图片网址的接口无法使用。生成图像可能按提供商费率计费。

## 本地开发与构建

仓库使用 Bun 工作区，声明的 Bun 版本为 **1.3.14**。在仓库根目录执行以下命令即可启动桌面开发环境。

```powershell
bun install
bun run dev:desktop
```

要在 **Windows x64** 上构建正式渠道的安装包，请先安装 x64 Node.js、Python 和带有「使用 C++ 的桌面开发」工作负载的 Visual Studio Build Tools，供 `node-gyp` 编译原生锁模块。完成上面的依赖安装后，在仓库根目录打开 PowerShell 并执行以下命令。

```powershell
cd packages/desktop
$env:OPENCODE_CHANNEL = "prod"
bun ../core/script/build-process-lock.ts --build
bun run build
bun run package:win -- --x64 --publish never
```

安装包输出到 `packages/desktop/dist/Koda-desktop-win-x64.exe`。正式渠道会从当前源码编译随包分发的 CLI。若需随包提供 GDAL，可在打包前将 `KODA_GDAL_HOME` 指向完整的 Windows x64 GDAL 运行目录，并设置 `KODA_BUNDLE_GDAL=1`。

运行测试时请先进入对应的包目录，例如 `packages/core`。仓库根目录设有测试守卫。

## 反馈与许可

报告问题时请附上 Koda 版本、操作系统、复现步骤和相关错误提示，并从日志或截图中移除 API 密钥。[提交 GitHub Issue](https://github.com/zh2100/koda-opencode/issues/new)

本项目由数元AI维护，采用 [MIT 许可证](LICENSE)。
