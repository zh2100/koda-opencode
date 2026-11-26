# 嵌套浮层修复与验收结果 — 2026-11-12

DR-01、DR-02 已修复，并在 Windows Chromium 的隔离生产构建中通过验收。完整浏览器套件 34 pass、0 fail、0 skip、0 flaky，退出码 0；组件套件 30 pass、0 fail，退出码 0。本结论限定于本轮两项缺陷及下述回归范围。

## 根因与修改

DR-01 的根因是父 DialogProvider 在 window 捕获阶段直接消费 Escape，早于 Kobalte 的 document 监听；共享 Popover 也有独立的全局捕获监听，无法正确识别更深层的 Select。已删除这两处手写全局关闭逻辑，统一使用 Kobalte 的 dismissable-layer、Content 事件和 onOpenChange。没有内层时父弹窗正常关闭；有内层时一次 Escape 只关闭最内层。

DR-02 的根因是 SelectV2 默认 non-modal 的 Portal 位于父 Dialog 之外，被父模态的 createHideOutside 隐藏。已在共享 Dialog 上下文增加 useDialogModal()，以真实栈和实例上下文识别当前活动父弹窗。Select、SelectV2、Popover 默认继承该模态关系，使子层通过 Kobalte 自身的可访问范围和焦点管理工作。

页面独立控件继续默认 non-modal；调用方显式传入 modal 时优先采用该值。本轮没有声称显式 modal=false 的所有嵌套组合均已验收。菜单已有的模态机制保持，通过实际 MenuV2 回归验证。

修改文件：

- [Dialog 上下文](D:/opencode/packages/ui/src/context/dialog.tsx)
- [Select](D:/opencode/packages/ui/src/components/select.tsx)
- [SelectV2](D:/opencode/packages/ui/src/v2/components/select-v2.tsx)
- [Popover](D:/opencode/packages/ui/src/components/popover.tsx)

未增加另一套全局浮层注册表，未修改本轮之前的 Kobalte autofocus 补丁内容，未修改公开接口或 SDK。

## 回归覆盖

[真实 MCP 验收](D:/opencode/packages/app/e2e/regression/mcp-dialog-acceptance.spec.ts) 新增三项：

1. 改命令但不保存，展开 Type，一次 Escape 关闭列表，编辑弹窗和原草稿保留。
2. 没有内层列表时，Escape 关闭编辑弹窗并完成内部栈收尾。
3. 可见 Type 列表及选项可以通过可访问角色定位；同时归档隐藏祖先、列表和活动元素。

[共享控件矩阵](D:/opencode/packages/app/e2e/regression/dialog-nested-layers.spec.ts) 新增十一项：

- Select、SelectV2、Popover、MenuV2 各自的可访问性、背景隐藏、单层 Escape、父草稿、焦点恢复及父关闭收尾。
- 两种 Select 的方向键及 Enter 选择。
- 真实 Popover 内再嵌套 SelectV2，三次 Escape 逐层关闭，父子草稿分别保留。
- 页面独立的 Select、SelectV2、Popover 保留非模态外部聚焦关闭及背景焦点。
- 在父弹窗可见区域发送真实鼠标点击，仅关闭内层 Popover，父草稿保留。

夹具使用真实共享控件：[nested.tsx](D:/opencode/packages/app/e2e/reproduction/dialog-lifecycle/nested.tsx)。生产构建配置和 E2E 类型检查已纳入新矩阵。原有生命周期、MCP 保存重开、旧回包归属、关闭快捷键、只写变更字段与只读来源用例继续执行。

组件 ownership 夹具原先将 Dialog mock 成只有 children 的空壳。删除全局监听后，OR-03 暴露该夹具不渲染 Kobalte Content，无法验证真实 Escape 链路。现改用真实 Dialog.Content，保留原关闭断言；没有放宽产品期望。

## 验证结果

所有命令从独立源码副本的包目录运行；主工作区依赖未重装。

| 检查                                       | 最终结果                                             |
| ------------------------------------------ | ---------------------------------------------------- |
| 生产构建 + Chromium，workers=1、retries=0  | 34 pass，0 fail，0 skip，0 flaky，134.706 秒，退出 0 |
| Provider 生命周期 + MCP ownership 组件回归 | 30 pass，0 fail，125 个断言，退出 0                  |
| packages/app：bun typecheck                | 退出 0                                               |
| packages/app：bun typecheck:e2e:dialog     | 退出 0                                               |
| packages/ui：bun typecheck                 | 退出 0                                               |
| 本轮文件 Prettier check                    | 通过                                                 |
| 本轮路径 git diff --check                  | 通过                                                 |

本次全仓 git diff --check 另发现既有 packages/opencode/test/mcp/auth.test.ts:138 的 EOF 空行。该文件不属本轮改动，未为消除提示而改写。

失败与中间运行保留：

- 修复前确认：1 pass、2 fail，见[原复核](D:/opencode/specs/dialog-nested-review-2026-11-12.md)。
- 首轮修复后真实 MCP 与旧回归：23 pass、0 fail。
- 首轮组件：29 pass、1 fail，失败来自上述无 Content 的 mock；修正后 30 pass。
- 首轮完整矩阵：33 pass、1 fail。外部点击用例按角色寻找被子模态有意隐藏的父按钮，停在定位阶段；没有执行点击，不能据此判断产品外部点击失败。现按 includeHidden 找到仍可见区域的几何位置，再发送真实鼠标点击，不使用 force，也不重复状态动作。最终完整 34 项通过。

## 证据

本轮证据根：C:/Users/zh2100/AppData/Local/Temp/opencode-nested-fix-20261112-d23479e3968c48

- [最终浏览器日志](C:/Users/zh2100/AppData/Local/Temp/opencode-nested-fix-20261112-d23479e3968c48/final/browser.log)
- [最终 Playwright JSON](C:/Users/zh2100/AppData/Local/Temp/opencode-nested-fix-20261112-d23479e3968c48/final/playwright-results.json)
- [HTML 报告](C:/Users/zh2100/AppData/Local/Temp/opencode-nested-fix-20261112-d23479e3968c48/final/html-report/index.html)
- [组件日志](C:/Users/zh2100/AppData/Local/Temp/opencode-nested-fix-20261112-d23479e3968c48/components-final/components.log)
- [App 类型检查](C:/Users/zh2100/AppData/Local/Temp/opencode-nested-fix-20261112-d23479e3968c48/types-app/typecheck.log)
- [UI 类型检查](C:/Users/zh2100/AppData/Local/Temp/opencode-nested-fix-20261112-d23479e3968c48/types-ui/typecheck.log)
- [E2E 类型检查](C:/Users/zh2100/AppData/Local/Temp/opencode-nested-fix-20261112-d23479e3968c48/types-e2e-final/typecheck.log)
- [主源与隔离副本 SHA-256 对照](C:/Users/zh2100/AppData/Local/Temp/opencode-nested-fix-20261112-d23479e3968c48/source-proof.json)
- [独立端口释放证明](C:/Users/zh2100/AppData/Local/Temp/opencode-nested-fix-20261112-d23479e3968c48/port-cleanup.json)

最终每项保留截图和 trace；已查看 MCP 下拉 Escape 后编辑草稿保留及可访问性截图。三轮独立端口 51547、63949、59227 均已释放。组件临时编译文件已清理。

## 验收边界

本轮使用 Windows Chromium、真实前端生产构建及受控 API 路由，未连接生产后端，未验证读屏软件实际语音输出、其他浏览器、macOS/Linux 或已安装 Electron 包。真实 MCP 与共享浮层两项可以按该范围关闭；不能由此宣称全项目无缺陷。

OA-06/UI01～UI08 的完整供应商与模型设置界面验收、R3-03B 整体、RF-07 跨平台及真实 HTTP 取消仍保持原状态。

没有提交、推送、重启当前应用或服务器；没有操作生产配置、凭据或迁移标记。主工作区 node_modules 未重装，当前运行应用尚未加载本轮源码和此前依赖补丁，需按正常发布流程进入后续运行版本。
