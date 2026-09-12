# Koda Desktop

Koda 是数元AI打造的 AI 编程桌面应用，将项目管理、AI 对话、代码修改和终端工具整合到同一个工作空间，帮助你理解项目、编写代码和排查问题。

当前版本：**v1.0.0**。

[下载安装](https://github.com/zh2100/koda-opencode/releases/tag/Koda) · [GitHub 仓库](https://github.com/zh2100/koda-opencode) · [报告问题](https://github.com/zh2100/koda-opencode/issues/new)

## 主要功能

- **项目与会话管理**：打开本地项目，按任务组织 AI 对话，继续已有工作。
- **AI 编程协作**：结合项目上下文进行代码分析、修改和问题排查。
- **模型与密钥管理**：配置提供商和智联AI密钥，选择账号可用的模型。
- **开发工具集成**：在工作空间内查看文件、检查修改并使用终端。
- **扩展能力**：支持配置 MCP 服务与技能，接入更多工具。

## 安装

目前已构建 Windows x64 安装包：`Koda-desktop-win-x64.exe`。

1. 打开[发布页面](https://github.com/zh2100/koda-opencode/releases/tag/Koda)，下载该页面提供的 Windows 安装包。
2. 运行安装程序，选择安装路径并完成安装。
3. 启动 Koda，打开本地项目，在设置中配置提供商和模型。

macOS 与 Linux 安装包以发布页面实际提供的文件为准。

## 配置智联AI密钥

进入 **设置 → 提供商 → 智联AI密钥**，填写密钥并勾选需要使用的模型。

点击 **获取密钥** 可打开[密钥管理页面](https://api.leidiandonghua.cn/console/token)。ChatGPT和Grok等需要单独新建密钥。实际可用模型取决于对应密钥的权限和服务端提供的模型。

请勿将密钥提交到 Git 仓库或附在公开的问题报告中。

## 检查更新

在 **帮助 → 检查更新** 中检查 Koda 发布版本。发现新版本时，应用会提示升级，可打开[发布页面](https://github.com/zh2100/koda-opencode/releases/tag/Koda)下载安装包。

## 本地开发与构建

项目使用 Bun 工作区，Bun 版本为 **1.3.14**。在仓库根目录安装依赖：

```powershell
bun install
```

启动桌面开发环境：

```powershell
bun run dev:desktop
```

在 Windows 上构建 v1.0.0 正式版安装包：

```powershell
cd packages/desktop
$env:OPENCODE_CHANNEL = "prod"
bun typecheck
bun run build
bunx electron-builder --win --x64 --config electron-builder.config.ts --publish never
```

安装包输出至 `packages/desktop/dist/Koda-desktop-win-x64.exe`。`prod` 表示正式构建渠道，`dev` 表示开发渠道；构建与打包时需使用同一渠道。

测试应在对应包目录执行，不要在仓库根目录运行测试。

## 反馈与贡献

欢迎通过 [GitHub Issues](https://github.com/zh2100/koda-opencode/issues/new) 报告问题。请提供应用版本、操作系统、复现步骤和必要的错误日志，并移除密钥等敏感信息。

## 维护与许可

维护方：**数元AI**。

本项目遵循 [MIT 许可证](LICENSE)，原有版权及许可声明保留于许可证文件中。
