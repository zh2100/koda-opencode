# 七项修复验收矩阵（P6，2026-11-15）

证据根：`C:\Users\zh2100\AppData\Local\Temp\seven-bugs-20261115-036ea436c30e42c58c666d0d50cb3ed2`。最终候选：`d7a2f6ccb30bc28c1c7ec11ce242b6bf559c8fc79918b893b93d357582d7760e`。命令、退出码和子样本保存在 P6；P3/P4/P5 为细化索引。

各行的原场景与必须断言保持，子样本依P3/P4/P5矩阵，最终结果以checks.json和日志为准；本机适用子场景最终通过；两个POSIX平台skip不计通过，跨平台和外部非合作写入边界继续保留。

Linux 续验：以下行仍是 Windows P6 证据。2026-11-15 Docker Linux 批次未全过，F09 相关读取兼容契约、F10 别名断言及 F36/共享锁子进程时限仍待处理；权限等已通过子样本见 [Linux 续验报告](./seven-bugs-linux-acceptance-2026-11-15.md)，不覆盖原行或扩称全平台通过。

|ID|原场景|原必须断言|同候选证据|子场景索引|
|---|---|---|---|---|
|A01|rotate 留 pending→重建→兼容 delete 复用 id；清理成功/失败各一例|冲突，实体和版本不变，不能返回删除成功|relay-backend.log、relay-mutation-baseline-handler.log、relay-commit-handler.log|Core delete-replay/mutation-replay/create及正式TCP|
|A02|同生命周期 set/clear/create/delete 跨种类或跨目标复用|冲突，无额外配置或凭据写入|relay-backend.log、relay-mutation-baseline-handler.log、relay-commit-handler.log|Core delete-replay/mutation-replay/create及正式TCP|
|A03|兼容与受保护删除的精确重试|一次删除；最新快照；不重复增加 revision|relay-backend.log、relay-mutation-baseline-handler.log、relay-commit-handler.log|Core delete-replay/mutation-replay/create及正式TCP|
|A04|删除已提交、清理失败/取消/响应丢失后重试|已提交证据仍在，安全补清理|relay-backend.log、relay-mutation-baseline-handler.log、relay-commit-handler.log|Core delete-replay/mutation-replay/create及正式TCP|
|A05|删除后同名重建，再重放旧删除|新 entity、key、目录不变|relay-backend.log、relay-mutation-baseline-handler.log、relay-commit-handler.log|Core delete-replay/mutation-replay/create及正式TCP|
|A06|重启/缓存淘汰/只有 result 或 pending|缺证据不确认业务成功；创建持久回执例外保持|relay-backend.log、relay-mutation-baseline-handler.log、relay-commit-handler.log|Core delete-replay/mutation-replay/create及正式TCP|
|A07|配置发布失败/未知|不伪造确认；失败/未知分类及原字节保持|relay-backend.log、relay-mutation-baseline-handler.log、relay-commit-handler.log|Core delete-replay/mutation-replay/create及正式TCP|
|A08|正式 TCP，expectedEntityId 有/无|状态码和公开形状正确，无秘密或内部指纹|relay-backend.log、relay-mutation-baseline-handler.log、relay-commit-handler.log|Core delete-replay/mutation-replay/create及正式TCP|
|F01|只有根 JSON / JSONC；两者共存|固定预期目标；其他文件逐字节不变；JSONC 注释保留|config.log、config-http.log、shared-core.log、image-generation-settings-handler.log|P5/matrix.md逐子场景；目标/来源/引用/冷态/断连/收尾/共享入口|
|F02|当前目录 .opencode 两种文件与根配置组合|按加载实际顺序选择；有效 GET 符合规则|config.log、config-http.log、shared-core.log、image-generation-settings-handler.log|P5/matrix.md逐子场景；目标/来源/引用/冷态/断连/收尾/共享入口|
|F03|只有父配置/无本地配置|创建当前目录 opencode.jsonc；不写父/全局|config.log、config-http.log、shared-core.log、image-generation-settings-handler.log|P5/matrix.md逐子场景；目标/来源/引用/冷态/断连/收尾/共享入口|
|F04|两个并行首次保存，可接纳与实例换代两支|稳定 owner 下两个非冲突提交保留；未准入者因换代/冻结后冲突明确拒绝、无假成功；单一目标，无自动重放|config.log、config-http.log、shared-core.log、image-generation-settings-handler.log|P5/matrix.md逐子场景；目标/来源/引用/冷态/断连/收尾/共享入口|
|F05|显式外部配置、home .opencode、自定义配置目录|不误写外部来源；覆盖/不覆盖字段分别检查|config.log、config-http.log、shared-core.log、image-generation-settings-handler.log|P5/matrix.md逐子场景；目标/来源/引用/冷态/断连/收尾/共享入口|
|F06|项目配置 disabled|typed 403；没有新业务配置文件、临时文件或提交通知|config.log、config-http.log、shared-core.log、image-generation-settings-handler.log|P5/matrix.md逐子场景；目标/来源/引用/冷态/断连/收尾/共享入口|
|F07|环境、组织、托管覆盖及对象 sibling|覆盖字段 typed 409；无关 sibling 不误拦截；无原文泄漏|config.log、config-http.log、shared-core.log、image-generation-settings-handler.log|P5/matrix.md逐子场景；目标/来源/引用/冷态/断连/收尾/共享入口|
|F08|同文件重复加载与来源顺序变化|使用最后参与位置，变更后拒绝旧决策|config.log、config-http.log、shared-core.log、image-generation-settings-handler.log|P5/matrix.md逐子场景；目标/来源/引用/冷态/断连/收尾/共享入口|
|F09|文件损坏、拒绝读、只读、缺失/重建|typed 错误；不吞掉失败改选另一份文件|config.log、config-http.log、shared-core.log、image-generation-settings-handler.log|P5/matrix.md逐子场景；目标/来源/引用/冷态/断连/收尾/共享入口|
|F10|大小写、junction/符号链接与域外文件链接|规范化协议同域目标一致，legacy 别名明确拒绝；域外拒绝；不宣称未测平台通过|config.log、config-http.log、shared-core.log、image-generation-settings-handler.log|P5/matrix.md逐子场景；目标/来源/引用/冷态/断连/收尾/共享入口|
|F11|JSONC 注释、未展开 file/env 引用|只写补丁；不复制继承字段/展开明文|config.log、config-http.log、shared-core.log、image-generation-settings-handler.log|P5/matrix.md逐子场景；目标/来源/引用/冷态/断连/收尾/共享入口|
|F12|instructions、数组、image_generation、嵌套字段、合法 no-op 与实际写入均返回 200|领域语义正确；no-op 原字节/身份及版本不变，publish/onCommitted/新增提交通知/handoff 均为零；真实写入有提交证据与完整回读，两类成功不可混计|config.log、config-http.log、shared-core.log、image-generation-settings-handler.log|P5/matrix.md逐子场景；目标/来源/引用/冷态/断连/收尾/共享入口|
|F13|与 MCP、全局同物理文档、schema 可选注解竞争|规范路径/规范化协议下共用文档锁；legacy 不兼容别名按门禁拒绝；无自等待/反向锁序|config.log、config-http.log、shared-core.log、image-generation-settings-handler.log|P5/matrix.md逐子场景；目标/来源/引用/冷态/断连/收尾/共享入口|
|F14|D/L 冻结后新增更高候选/删除/父目录替换|提交前冲突，不自动转写新路径；不把 P 到 D 前正常首次创建混成此样本|config.log、config-http.log、shared-core.log、image-generation-settings-handler.log|P5/matrix.md逐子场景；目标/来源/引用/冷态/断连/收尾/共享入口|
|F15|真实正常 TCP PATCH→handoff→GET|ACK、目标磁盘、有效内存一致；清理重建后仍正确|config.log、config-http.log、shared-core.log、image-generation-settings-handler.log|P5/matrix.md逐子场景；目标/来源/引用/冷态/断连/收尾/共享入口|
|F16|发布已准入后断连→实际发布成功|一次发布、一次提交通知；等待完整 handoff 后 GET 新值|config.log、config-http.log、shared-core.log、image-generation-settings-handler.log|P5/matrix.md逐子场景；目标/来源/引用/冷态/断连/收尾/共享入口|
|F17|发布已准入后断连→发布拒绝|原字节、无通知、后续可读取；现有通过样本保持|config.log、config-http.log、shared-core.log、image-generation-settings-handler.log|P5/matrix.md逐子场景；目标/来源/引用/冷态/断连/收尾/共享入口|
|F18|已提交→响应挂起时断连/编码失败|不依赖响应链；无重放；新实例可读|config.log、config-http.log、shared-core.log、image-generation-settings-handler.log|P5/matrix.md逐子场景；目标/来源/引用/冷态/断连/收尾/共享入口|
|F19|提交准备故障/确认丢失/未知结果|保留 AtomicDocument 既有分类、ACL/身份保护和未知阻止|config.log、config-http.log、shared-core.log、image-generation-settings-handler.log|P5/matrix.md逐子场景；目标/来源/引用/冷态/断连/收尾/共享入口|
|F20|遗留 config.json|普通流程不读不改；显式导入若实施则单独验证版本冲突/幂等|config.log、config-http.log、shared-core.log、image-generation-settings-handler.log|P5/matrix.md逐子场景；目标/来源/引用/冷态/断连/收尾/共享入口|
|F21|A/B 目录与 workspace 路由|只改归属项目；另一目录磁盘、内存、实例 owner 不受影响|config.log、config-http.log、shared-core.log、image-generation-settings-handler.log|P5/matrix.md逐子场景；目标/来源/引用/冷态/断连/收尾/共享入口|
|F22|准备取消/已准入后取消/退出排空|分别满足不发布与保留责任；任务登记直到真实清理结束|config.log、config-http.log、shared-core.log、image-generation-settings-handler.log|P5/matrix.md逐子场景；目标/来源/引用/冷态/断连/收尾/共享入口|
|F23|持选择锁/第 N 文档锁→真实 TCP PATCH→断连→释放持锁者|preparing 真正取消，无 publish/通知；前 N-1 租约全部释放，后续竞争者可获取|config.log、config-http.log、shared-core.log、image-generation-settings-handler.log|P5/matrix.md逐子场景；目标/来源/引用/冷态/断连/收尾/共享入口|
|F24|acquire 晚到及取消与准入竞争|取消先赢无发布；准入先赢至多一次执行；无租约泄漏、重复释放或孤儿任务|config.log、config-http.log、shared-core.log、image-generation-settings-handler.log|P5/matrix.md逐子场景；目标/来源/引用/冷态/断连/收尾/共享入口|
|F25|冷实例损坏、拒读、disabled、域外/不兼容别名|CONFIG_* typed 状态/ref；预检失败不进入 store.load/handler，无业务文件/通知及泄密|config.log、config-http.log、shared-core.log、image-generation-settings-handler.log|P5/matrix.md逐子场景；目标/来源/引用/冷态/断连/收尾/共享入口|
|F26|预检通过后 bootstrap 失败、锁内来源变化、中断|handler 前后均按明确类别映射；中断不变成 400；不破坏既有 MCP/GET 错误契约|config.log、config-http.log、shared-core.log、image-generation-settings-handler.log|P5/matrix.md逐子场景；目标/来源/引用/冷态/断连/收尾/共享入口|
|F27|同域 .opencode junction/文件链接导致两逻辑候选同物理文件|规范化协议仅一份文档租约、一次释放；来源参与序列不丢，补丁/GET 正确，无自等待|config.log、config-http.log、shared-core.log、image-generation-settings-handler.log|P5/matrix.md逐子场景；目标/来源/引用/冷态/断连/收尾/共享入口|
|F28|legacy/path-identity-v1/已有 native 协议分别验证|legacy 规范路径键/哈希不变且保存正常，别名明确拒绝；新协议去重；失败不跨协议回退、不写标记|config.log、config-http.log、shared-core.log、image-generation-settings-handler.log|P5/matrix.md逐子场景；目标/来源/引用/冷态/断连/收尾/共享入口|
|F29|所有共享必写入口的 legacy 别名与规范路径|PATCH/MCP/global/图片设置均拒绝不兼容别名，无旁路写；可选注解跳过；规范路径并发仍互斥；核对各自领域/HTTP 错误|config.log、config-http.log、shared-core.log、image-generation-settings-handler.log|P5/matrix.md逐子场景；目标/来源/引用/冷态/断连/收尾/共享入口|
|F30|服务关闭分别发生在 preparing/admitted/handoff 阶段；ACK 后暂停 handoff|准备取消并清理、已准入任务排空；不自等待；记录 ACK→GET 窗口，handoff 后及重建读取均新值|config.log、config-http.log、shared-core.log、image-generation-settings-handler.log|P5/matrix.md逐子场景；目标/来源/引用/冷态/断连/收尾/共享入口|
|F31|无 $schema 的 JSON/JSONC、无本地文件、共享 bootstrap 的冷态首次 PATCH|本 PATCH 禁用 loader 可选写入；D/L 重建合法基线；第一次请求完成闭环，不依赖第二次保存或误报自冲突|config.log、config-http.log、shared-core.log、image-generation-settings-handler.log|P5/matrix.md逐子场景；目标/来源/引用/冷态/断连/收尾/共享入口|
|F32|P 为缺失→前请求首次创建→后请求取得选择锁；D/L 后再注入变化|前者作为最新初始基线，后者明确冲突；同文件重复来源全部使用 L 原文；不以循环重选/自动重放通过|config.log、config-http.log、shared-core.log、image-generation-settings-handler.log|P5/matrix.md逐子场景；目标/来源/引用/冷态/断连/收尾/共享入口|
|F33|ImageGenerationSettings.update 规范路径/缺失文件/legacy 别名及同文档竞争|正常保存回读；别名拒绝在临时写入前发生，原字节不变；同一文档与 Config/MCP/全局共用租约，不泄密|config.log、config-http.log、shared-core.log、image-generation-settings-handler.log|P5/matrix.md逐子场景；目标/来源/引用/冷态/断连/收尾/共享入口|
|F34|正式图片设置 HTTP 入口成功、别名拒绝、后续 GET|保持现有领域 Error→InvalidRequestError 失败契约，不返回假成功或未声明错误；原磁盘/内存不被失败请求改变；恢复规范路径后可保存|config.log、config-http.log、shared-core.log、image-generation-settings-handler.log|P5/matrix.md逐子场景；目标/来源/引用/冷态/断连/收尾/共享入口|
|F35|既有及补丁新 file/env 引用、有效值覆盖、依赖变化、raw 非 JSONC 的有效模板|替换后解析/解码；原文可编辑才打补丁，有效但不可编辑的目标区分 no-op 与 typed 409，非目标继承和读取保持；真正无效为 400；引用/依赖复检、重建与无明文泄露均验证|config.log、config-http.log、shared-core.log、image-generation-settings-handler.log|P5/matrix.md逐子场景；目标/来源/引用/冷态/断连/收尾/共享入口|
|F36|全部 handoff 的失败汇总、项目有限恢复、关闭/容量/其他 owner|全局/MCP/一般失败即使被 catch、早于关闭或诊断溢出仍可报告；仅项目幂等收尾有限重试；排空不丢失败、不重放成功 hook/PATCH/publish；准入预留与安全 ref 保持|config.log、config-http.log、shared-core.log、image-generation-settings-handler.log|P5/matrix.md逐子场景；目标/来源/引用/冷态/断连/收尾/共享入口|
|I01|正常根、合法 preload 子根、显式 layer 覆盖|产品导入前准入；导入后路径/身份一致；实际产物仅在登记根内|isolation-launcher.log、core-isolation.log、isolation.log|P0隔离守卫/真实Global及preload|
|I02|域外注册/config/db/tmp、junction 指向兄弟根、损坏描述|导入前拒绝，产品入口哨兵未执行；兄弟测试根无新增文件或内容变化|isolation-launcher.log、core-isolation.log、isolation.log|P0隔离守卫/真实Global及preload|
|I03|preload 重选及准入流程观察到的环境/注册漂移|新选择重新准入；不一致停止；后置失败不冒充零写入保证|isolation-launcher.log、core-isolation.log、isolation.log|P0隔离守卫/真实Global及preload|
|O01|地址保存→旧刷新未发出→名称保存|最新版本补刷，模型为新地址；旧 409 不导致丢需求|relay-frontend.log、relay-transport.log、relay-backend.log、relay-mutation-baseline-handler.log、page-final-second.log|P3/matrix.md逐子场景；本次同候选8文件/transport/Core/TCP/两布局|
|O02|地址保存→旧刷新挂起→空补丁保存|保留需求；不能误认为无字段变化就完成|relay-frontend.log、relay-transport.log、relay-backend.log、relay-mutation-baseline-handler.log、page-final-second.log|P3/matrix.md逐子场景；本次同候选8文件/transport/Core/TCP/两布局|
|O03|旧刷新挂起→手动获取|手动请求可在旧请求放行前完成，现有通过行为保留|relay-frontend.log、relay-transport.log、relay-backend.log、relay-mutation-baseline-handler.log、page-final-second.log|P3/matrix.md逐子场景；本次同候选8文件/transport/Core/TCP/两布局|
|O04|三次连接/名称保存交错|请求数量有界，排队保留最新，最终目标不丢|relay-frontend.log、relay-transport.log、relay-backend.log、relay-mutation-baseline-handler.log、page-final-second.log|P3/matrix.md逐子场景；本次同候选8文件/transport/Core/TCP/两布局|
|O05|旧刷新已到上游/ACK 晚到|旧响应不盖新结果，需求只由有效结果满足|relay-frontend.log、relay-transport.log、relay-backend.log、relay-mutation-baseline-handler.log、page-final-second.log|P3/matrix.md逐子场景；本次同候选8文件/transport/Core/TCP/两布局|
|O06|刷新成功且上游空列表|正常完成，显示空列表，不自动循环|relay-frontend.log、relay-transport.log、relay-backend.log、relay-mutation-baseline-handler.log、page-final-second.log|P3/matrix.md逐子场景；本次同候选8文件/transport/Core/TCP/两布局|
|O07|最新刷新失败→用户重试|失败可见且保存已提交；只重试抓取，配置 revision 不因补刷增长|relay-frontend.log、relay-transport.log、relay-backend.log、relay-mutation-baseline-handler.log、page-final-second.log|P3/matrix.md逐子场景；本次同候选8文件/transport/Core/TCP/两布局|
|O08|旧刷新失败晚于新成功/新失败|不能改写新状态、错误或 busy|relay-frontend.log、relay-transport.log、relay-backend.log、relay-mutation-baseline-handler.log、page-final-second.log|P3/matrix.md逐子场景；本次同候选8文件/transport/Core/TCP/两布局|
|O09|清钥期间/完成后旧刷新返回|无旧模型复活，无新凭据读取或后台自动抓取|relay-frontend.log、relay-transport.log、relay-backend.log、relay-mutation-baseline-handler.log、page-final-second.log|P3/matrix.md逐子场景；本次同候选8文件/transport/Core/TCP/两布局|
|O10|删除→同 ID 重建|旧 entityId 的任务不能影响新实体|relay-frontend.log、relay-transport.log、relay-backend.log、relay-mutation-baseline-handler.log、page-final-second.log|P3/matrix.md逐子场景；本次同候选8文件/transport/Core/TCP/两布局|
|O11|A/B 供应商并发|A 的需求/失败/结束不清除 B 的状态|relay-frontend.log、relay-transport.log、relay-backend.log、relay-mutation-baseline-handler.log、page-final-second.log|P3/matrix.md逐子场景；本次同候选8文件/transport/Core/TCP/两布局|
|O12|切服务器 A→B→A、销毁重建|scope/generation 隔离，旧运行不影响新 owner|relay-frontend.log、relay-transport.log、relay-backend.log、relay-mutation-baseline-handler.log、page-final-second.log|P3/matrix.md逐子场景；本次同候选8文件/transport/Core/TCP/两布局|
|O13|后端 catalogSync pending/notice 失败|上游需求与后端同步待办分别保留，恢复后接续|relay-frontend.log、relay-transport.log、relay-backend.log、relay-mutation-baseline-handler.log、page-final-second.log|P3/matrix.md逐子场景；本次同候选8文件/transport/Core/TCP/两布局|
|O14|Probe 的 persistDraft 与未满足需求交错|测试连接不冒充获取模型，不自等待或漏调度|relay-frontend.log、relay-transport.log、relay-backend.log、relay-mutation-baseline-handler.log、page-final-second.log|P3/matrix.md逐子场景；本次同候选8文件/transport/Core/TCP/两布局|
|O15|旧连接提交 ACK 晚于新名称提交 ACK|草稿不回退；已提交连接需求接续到当前实体版本|relay-frontend.log、relay-transport.log、relay-backend.log、relay-mutation-baseline-handler.log、page-final-second.log|P3/matrix.md逐子场景；本次同候选8文件/transport/Core/TCP/两布局|
|O16|两种 catalog 能力路径|能力/实体校验、候选/勾选合并行为保持|relay-frontend.log、relay-transport.log、relay-backend.log、relay-mutation-baseline-handler.log、page-final-second.log|P3/matrix.md逐子场景；本次同候选8文件/transport/Core/TCP/两布局|
|O17|两旧请求占槽，最新手动动作排队；标准 transport 响应 abort|从真实槽释放接续最新目标；请求数有界，不丢需求；每次发出重新捕获身份|relay-frontend.log、relay-transport.log、relay-backend.log、relay-mutation-baseline-handler.log、page-final-second.log|P3/matrix.md逐子场景；本次同候选8文件/transport/Core/TCP/两布局|
|O18|两旧 transport 忽略 abort 且始终不结束|第三次动作有界失败、busy 结束、需求保留；实际未结束请求不超过两个；无自动轮询/投递增长|relay-frontend.log、relay-transport.log、relay-backend.log、relay-mutation-baseline-handler.log、page-final-second.log|P3/matrix.md逐子场景；本次同候选8文件/transport/Core/TCP/两布局|
|O19|headers 已返回但正文挂起；冲突补发接近总截止时间|正文仍受 deadline；对账/补发不重置动作预算；超时不变成成功|relay-frontend.log、relay-transport.log、relay-backend.log、relay-mutation-baseline-handler.log、page-final-second.log|P3/matrix.md逐子场景；本次同候选8文件/transport/Core/TCP/两布局|
|O20|超时/用户取消/销毁与成功同时到达，随后晚到 resolve/reject|接纳和收尾各至多一次；无旧错误/模型回写、无未处理 rejection；timer/listener 清理|relay-frontend.log、relay-transport.log、relay-backend.log、relay-mutation-baseline-handler.log、page-final-second.log|P3/matrix.md逐子场景；本次同候选8文件/transport/Core/TCP/两布局|
|O21|保存服务端已提交但 ACK 挂起→同步接纳该版本→清钥成功→旧保存 ACK 到达|同 entityId 仍不重建需求/后台刷新；hasKey=false、模型和当前错误不回退；重复旧 ACK 同样无副作用|relay-frontend.log、relay-transport.log、relay-backend.log、relay-mutation-baseline-handler.log、page-final-second.log|P3/matrix.md逐子场景；本次同候选8文件/transport/Core/TCP/两布局|
|O22|旧连接提交 ACK 晚于新连接的刷新完成，或晚于新名称提交|新连接已覆盖时不重复抓取；仅名称更新时保留 O15 的接续，不能一律丢弃旧 ACK|relay-frontend.log、relay-transport.log、relay-backend.log、relay-mutation-baseline-handler.log、page-final-second.log|P3/matrix.md逐子场景；本次同候选8文件/transport/Core/TCP/两布局|
|O23|清钥→新密钥提交→旧清钥 ACK 晚到；权威同步发现清钥|新连接需求保留、hasKey 不回退；外部无钥仅建立观测屏障，不伪造精确提交 C；旧/新实体分开计序|relay-frontend.log、relay-transport.log、relay-backend.log、relay-mutation-baseline-handler.log、page-final-second.log|P3/matrix.md逐子场景；本次同候选8文件/transport/Core/TCP/两布局|
|O24|clear(V=1) 提交 2 且清理失败→新密钥提交 3→原 clear 重试返回快照 3|原 C 始终为 2，快照按 3 合并；新需求不被撤销；清理可完成、版本不再增长；精确命令与响应快照分开核对|relay-frontend.log、relay-transport.log、relay-backend.log、relay-mutation-baseline-handler.log、page-final-second.log|P3/matrix.md逐子场景；本次同候选8文件/transport/Core/TCP/两布局|
|O25|保存待清理重试返回更新的名称/连接快照；另一供应商使全局版本跳跃|原提交仍为冻结 V+1；不拿全局 revision 或最新 vendor revision 充当提交版本；无重复补刷/状态回退|relay-frontend.log、relay-transport.log、relay-backend.log、relay-mutation-baseline-handler.log、page-final-second.log|P3/matrix.md逐子场景；本次同候选8文件/transport/Core/TCP/两布局|
|O26|服务版本步进与不可变基线契约：普通保存、空补丁、清钥、分阶段失败和同 id 重试|一次配置提交恰好 +1；确定未提交失败不递增，已提交后收尾不二次递增，未知不保证零递增；R/V 同快照，重试 payload/id/基线不随草稿编辑漂移|relay-frontend.log、relay-transport.log、relay-backend.log、relay-mutation-baseline-handler.log、page-final-second.log|P3/matrix.md逐子场景；本次同候选8文件/transport/Core/TCP/两布局|
|O27|无新能力、丢失原基线、换 scope/实体、未知结果与旧创建回执|不伪造精确提交水位，不重放写命令；旧服务器走有界保守对账；create 全局单位不与 vendor 单位混用|relay-frontend.log、relay-transport.log、relay-backend.log、relay-mutation-baseline-handler.log、page-final-second.log|P3/matrix.md逐子场景；本次同候选8文件/transport/Core/TCP/两布局|
|O28|配置替换成功→settleCleanup 读取失败/收尾或响应故障；未知后的检查返回冲突|无其他提交时磁盘保留 V+1；已有证据不丢，前端无确认则保持未知；无回滚/新 id 自动重放/二次配置提交；后续 GET 不冒充原命令回执|relay-frontend.log、relay-transport.log、relay-backend.log、relay-mutation-baseline-handler.log、page-final-second.log|P3/matrix.md逐子场景；本次同候选8文件/transport/Core/TCP/两布局|
|O29|同编号精确/异种命令重放、旧客户端、重启及容量淘汰|已有实体 mutation 仅凭精确证据推导 V+1，缺失证据保守冲突；创建独立验证既有持久化指纹，重建/内存淘汰/删除后仍正确确认回执且不复活实体；跨种类冲突、初始化清理及签名密钥缺失保护保持|relay-frontend.log、relay-transport.log、relay-backend.log、relay-mutation-baseline-handler.log、page-final-second.log|P3/matrix.md逐子场景；本次同候选8文件/transport/Core/TCP/两布局|
|S01|语法错误；对象/数组/数字/null 值；根数组/null|typed Fail，不是 Die；文件字节不变，诊断无标记原文|relay-backend.log、relay-mutation-baseline-handler.log|Core relay-secret-boundaries/lifecycle/store：系统三态、真实Auth、文件IO屏障|
|S02|get/put/remove、系统 fallback、读取拒绝|既有错误协议，独立引用不被错误覆盖|relay-backend.log、relay-mutation-baseline-handler.log|Core relay-secret-boundaries/lifecycle/store：系统三态、真实Auth、文件IO屏障|
|S03|初始化和运行中损坏，正式 HTTP|预期构建/运行时边界；运行时 503 等既有声明；响应/日志无假密钥|relay-backend.log、relay-mutation-baseline-handler.log|Core relay-secret-boundaries/lifecycle/store：系统三态、真实Auth、文件IO屏障|
|S04|set 投递前取消|set/config commit 未调用，锁可重新获取|relay-backend.log、relay-mutation-baseline-handler.log|Core relay-secret-boundaries/lifecycle/store：系统三态、真实Auth、文件IO屏障|
|S05|set 已投递→取消→晚成功|set settled 前取消收尾不能完成；之后无孤立 key，旧 key 可解析|relay-backend.log、relay-mutation-baseline-handler.log|Core relay-secret-boundaries/lifecycle/store：系统三态、真实Auth、文件IO屏障|
|S06|系统同步 throw、Promise reject、先写后 reject，且取消在 fallback 前到达|不挂死；不启动 fallback，不提交配置；副作用按 ref 清理，旧配置保持|relay-backend.log、relay-mutation-baseline-handler.log|Core relay-secret-boundaries/lifecycle/store：系统三态、真实Auth、文件IO屏障|
|S07|取消与完成同时发生，正常成功对照|正确分界；最多一次提交/清理，无重复删除后继资源|relay-backend.log、relay-mutation-baseline-handler.log|Core relay-secret-boundaries/lifecycle/store：系统三态、真实Auth、文件IO屏障|
|S08|清理失败、再次服务初始化|journal 保留且可继续；中断/清理失败不被伪装为成功|relay-backend.log、relay-mutation-baseline-handler.log|Core relay-secret-boundaries/lifecycle/store：系统三态、真实Auth、文件IO屏障|
|S09|文件 fallback 已投递时取消|I/O 完成后清理；无 tmp、锁或 journal 的错误提前释放|relay-backend.log、relay-mutation-baseline-handler.log|Core relay-secret-boundaries/lifecycle/store：系统三态、真实Auth、文件IO屏障|
|S10|已提交后取消、ref 仍被配置使用|不删除有效凭据，提交证据与 revision 保持|relay-backend.log、relay-mutation-baseline-handler.log|Core relay-secret-boundaries/lifecycle/store：系统三态、真实Auth、文件IO屏障|
|S11|服务退出/等待观察超时|已投递责任仍持有；完成后正确排空，无 detached 写入|relay-backend.log、relay-mutation-baseline-handler.log|Core relay-secret-boundaries/lifecycle/store：系统三态、真实Auth、文件IO屏障|
|S12|无取消，系统 throw/reject/先写后 reject，文件 fallback 成功|提交一次且新 key 可解析；当前引用的系统/文件副本不被误删|relay-backend.log、relay-mutation-baseline-handler.log|Core relay-secret-boundaries/lifecycle/store：系统三态、真实Auth、文件IO屏障|
|S13|无取消，系统与文件 fallback 均失败|不提交、旧 key 可解析；已发生副作用完成清理，或保留可恢复 journal|relay-backend.log、relay-mutation-baseline-handler.log|Core relay-secret-boundaries/lifecycle/store：系统三态、真实Auth、文件IO屏障|
|S14|journal tmp write/chmod/rename 挂起时取消，并启动竞争者|实际 I/O 完成前不收尾或释锁；不 set；无晚到 tmp/rename 覆盖后继记录|relay-backend.log、relay-mutation-baseline-handler.log|Core relay-secret-boundaries/lifecycle/store：系统三态、真实Auth、文件IO屏障|
|S15|journal 发布后、set 前取消；journal 删除失败/晚完成|不 set、不提交；正确保留或完成记录；竞争者不受旧删除影响|relay-backend.log、relay-mutation-baseline-handler.log|Core relay-secret-boundaries/lifecycle/store：系统三态、真实Auth、文件IO屏障|
|S16|auth tmp/next/final rename 边界取消与竞争者|准入前不发布；准入后确认提交或未知结果；有效 ref 不被删，旧 I/O 不覆盖后继提交|relay-backend.log、relay-mutation-baseline-handler.log|Core relay-secret-boundaries/lifecycle/store：系统三态、真实Auth、文件IO屏障|
|S17|系统读取失败/明确不存在/成功，交叉文件有值/无 ref/缺文件/拒读/损坏；无系统后端对照|按 P1.1a 返回值、undefined 或 typed UnavailableError；系统成功不读取文件；真实 Auth 映射正确，文件/配置字节不变，无秘密原文|relay-backend.log、relay-mutation-baseline-handler.log|Core relay-secret-boundaries/lifecycle/store：系统三态、真实Auth、文件IO屏障|
|T01|daily/runNow 的 RateLimit|failed、可重试、任务保持启用，原计划保留|task-runner.log、llm.log、schema.log、scheduled-task-handler.log、page-final-second.log|P4/matrix.md逐子场景；真实runner/loopback、最终供应商请求体；新增正式handler/SQLite/Event|
|T02|Transport/ProviderInternal/无效输出|正确 code/retryable；不误停用|task-runner.log、llm.log、schema.log、scheduled-task-handler.log、page-final-second.log|P4/matrix.md逐子场景；真实runner/loopback、最终供应商请求体；新增正式handler/SQLite/Event|
|T03|NoRoute/Quota/Policy/未知 typed 执行错误|安全 TASK_EXECUTION_FAILED，不冒充项目错误|task-runner.log、llm.log、schema.log、scheduled-task-handler.log、page-final-second.log|P4/matrix.md逐子场景；真实runner/loopback、最终供应商请求体；新增正式handler/SQLite/Event|
|T04|requireReady 明确项目/Relay 模型/缺 key；ModelNotSelected、VariantUnavailable、UnsupportedApi|仅这些来源明确的分支暂停；等待记录正确收尾；不将歧义 ModelUnavailable 纳入本行|task-runner.log、llm.log、schema.log、scheduled-task-handler.log、page-final-second.log|P4/matrix.md逐子场景；真实runner/loopback、最终供应商请求体；新增正式handler/SQLite/Event|
|T05|自动 daily、手动 daily、自动 once|区分 advance：自动 once 原本停用，不重新启用|task-runner.log、llm.log、schema.log、scheduled-task-handler.log、page-final-second.log|P4/matrix.md逐子场景；真实runner/loopback、最终供应商请求体；新增正式handler/SQLite/Event|
|T06|执行中用户停用，再失败/中断/成功|数据库与 GET 保持停用，终态事件 task.enabled=false；run 结果正确，不用旧快照恢复状态|task-runner.log、llm.log、schema.log、scheduled-task-handler.log、page-final-second.log|P4/matrix.md逐子场景；真实runner/loopback、最终供应商请求体；新增正式handler/SQLite/Event|
|T07|同项目后继任务、跨项目、失败/取消/通知故障|项目锁释放与串并行规则保持|task-runner.log、llm.log、schema.log、scheduled-task-handler.log、page-final-second.log|P4/matrix.md逐子场景；真实runner/loopback、最终供应商请求体；新增正式handler/SQLite/Event|
|T08|假 HTTP 429 走真实 LLM/runner→调度边界|不仅测试分类 helper 或 resume 替身|task-runner.log、llm.log、schema.log、scheduled-task-handler.log、page-final-second.log|P4/matrix.md逐子场景；真实runner/loopback、最终供应商请求体；新增正式handler/SQLite/Event|
|T09|后续正常到期执行、数据库重建读取、事件|任务仍可按计划执行；不重放失败旧 run|task-runner.log、llm.log、schema.log、scheduled-task-handler.log、page-final-second.log|P4/matrix.md逐子场景；真实runner/loopback、最终供应商请求体；新增正式handler/SQLite/Event|
|T10|typed、纯 defect、中断+defect、清理/恢复失败均带假秘密标记|实际执行日志、DB、事件、API/适用页面无标记；内部中断保持；新 code 可解码显示；至少一例经过真实 SessionExecution 日志出口|task-runner.log、llm.log、schema.log、scheduled-task-handler.log、page-final-second.log|P4/matrix.md逐子场景；真实runner/loopback、最终供应商请求体；新增正式handler/SQLite/Event|
|T11|requireReady 成功后，以屏障让真实 model resolver 的 Relay 凭据读取临时失败|经过真实 AuthError→ModelUnavailableError 包装；本次失败、任务仍启用；不能只手造模型错误|task-runner.log、llm.log、schema.log、scheduled-task-handler.log、page-final-second.log|P4/matrix.md逐子场景；真实runner/loopback、最终供应商请求体；新增正式handler/SQLite/Event|
|T12|普通供应商真实模型缺失，走 ModelUnavailableError|按保守策略不暂停；与 T04 明确配置错误对照；用户可见安全 MODEL_UNAVAILABLE|task-runner.log、llm.log、schema.log、scheduled-task-handler.log、page-final-second.log|P4/matrix.md逐子场景；真实runner/loopback、最终供应商请求体；新增正式handler/SQLite/Event|
|T13|真实 SecretStore→Auth→requireReady：系统读取失败且无文件副本；有副本/确实不存在对照|前者 SECRET_STORE_UNAVAILABLE 且不暂停；有副本继续执行；明确不存在才 KEY_MISSING 并暂停；不只手造 AuthError|task-runner.log、llm.log、schema.log、scheduled-task-handler.log、page-final-second.log|P4/matrix.md逐子场景；真实runner/loopback、最终供应商请求体；新增正式handler/SQLite/Event|
|T14|终态读取后发布挂起时停用、停用先赢、停用再启用、任务删除、发布失败/取消|按 P4.2a 顺序核对 DB/GET/事件；旧 epoch 不停用新计划；无旧任务复活、锁自等待或重复通知；不同任务不被阻塞|task-runner.log、llm.log、schema.log、scheduled-task-handler.log、page-final-second.log|P4/matrix.md逐子场景；真实runner/loopback、最终供应商请求体；新增正式handler/SQLite/Event|
|T15|LLMError、流内 provider-error、工具异常的错误/metadata 带假秘密；正常/中断对照|真实 Step/Tool 失败事件、消息投影、读取 API、运行记录及适用日志/页面无原文；内部 Cause/中断和正常输出保持|task-runner.log、llm.log、schema.log、scheduled-task-handler.log、page-final-second.log|P4/matrix.md逐子场景；真实runner/loopback、最终供应商请求体；新增正式handler/SQLite/Event|
|T16|tick 扫描后认领前停用/删除/停用再启用；runNow 等待期间停用；重复时段；准入先赢再停用；once/daily 对照|区段内复检拒绝旧候选且零认领/推进；成功认领与推进同事务；旧快照不写回 enabled；启动前 epoch 复检，不执行旧 pending；自动 once 已认领运行保持|task-runner.log、llm.log、schema.log、scheduled-task-handler.log、page-final-second.log|P4/matrix.md逐子场景；真实runner/loopback、最终供应商请求体；新增正式handler/SQLite/Event|
|T17|tool-error 与 tool-result(error) 的字符串/对象/嵌套 value、metadata 标记；本地/合法托管/未知格式；成功对照|error/result 均安全，存储/读取无诊断原文；可续接分支的请求保持工具失败语义；未知托管格式按 T20 拒绝；执行次数及成功输出保持|task-runner.log、llm.log、schema.log、scheduled-task-handler.log、page-final-second.log|P4/matrix.md逐子场景；真实runner/loopback、最终供应商请求体；新增正式handler/SQLite/Event|
|T18|publish 前取消；首监听者接收后第二监听者失败/取消；失败点不明；正常发布与慢消费者|未投递/部分交付/未知/发布完成按证据区分；正常入队不冒充页面消费；不重复投递或重写状态，释放区段后后继操作可继续|task-runner.log、llm.log、schema.log、scheduled-task-handler.log、page-final-second.log|P4/matrix.md逐子场景；真实runner/loopback、最终供应商请求体；新增正式handler/SQLite/Event|
|T19|精确同槽手动/自动先到；活动/终态/历史旧 epoch；重启、并发、回滚、通知失败及非同槽对照|同槽只一次尝试；合法自动路径只补推进一次，不重复会话/工具/终态通知；once 不卡旧时间，daily 后续正常；停用与原 runNow 错误语义保持|task-runner.log、llm.log、schema.log、scheduled-task-handler.log、page-final-second.log|P4/matrix.md逐子场景；真实runner/loopback、最终供应商请求体；新增正式handler/SQLite/Event|
|T20|Anthropic 各已支持托管工具错误、OpenAI store/引用组合、未知/损坏协议字段、本地工具对照|经真实 parser/事件/消息到最终 HTTP body；必要结构和引用正确、无诊断原文；无法安全重建时请求前 typed 拒绝且零 HTTP，不改变成功路径|task-runner.log、llm.log、schema.log、scheduled-task-handler.log、page-final-second.log|P4/matrix.md逐子场景；真实runner/loopback、最终供应商请求体；新增正式handler/SQLite/Event|
|V01|勾选已提交 ACK 挂起→名称保存先回包→勾选 ACK|至少一次足够新的 sync；页面与持久目录一致|relay-frontend.log、relay-transport.log、page-final-second.log|P3/matrix.md逐子场景及queued/sent/committed×退休矩阵；两布局|
|V02|无交错正常勾选；名称保存失败|基本行为保持，错误有正确归属|relay-frontend.log、relay-transport.log、page-final-second.log|P3/matrix.md逐子场景及queued/sent/committed×退休矩阵；两布局|
|V03|勾选排队时名称/空补丁提交|合法 intent 不静默消失，写入顺序保持|relay-frontend.log、relay-transport.log、page-final-second.log|P3/matrix.md逐子场景及queued/sent/committed×退休矩阵；两布局|
|V04|勾选 ACK 前发出的 sync 晚到；ACK 后另一 sync|前者不能完成新责任，后者按水位接纳|relay-frontend.log、relay-transport.log、page-final-second.log|P3/matrix.md逐子场景及queued/sent/committed×退休矩阵；两布局|
|V05|true→false；不同模型/供应商；sync 中又有 ACK|最终状态等于最后实际提交，分片互不覆盖，无丢唤醒|relay-frontend.log、relay-transport.log、page-final-second.log|P3/matrix.md逐子场景及queued/sent/committed×退休矩阵；两布局|
|V06|已提交后 sync 失败/超时，再显式重试|写次数不增加，责任保留直至成功或实体退休|relay-frontend.log、relay-transport.log、page-final-second.log|P3/matrix.md逐子场景及queued/sent/committed×退休矩阵；两布局|
|V07|未投递/已投递/已提交三个阶段遇删除、重建、换服、销毁|旧实体不污染新实体；不得靠“全部返回成功”跳过|relay-frontend.log、relay-transport.log、page-final-second.log|P3/matrix.md逐子场景及queued/sent/committed×退休矩阵；两布局|
|V08|清钥/换地址、旧错误晚到|不恢复旧连接状态；错误票据正确|relay-frontend.log、relay-transport.log、page-final-second.log|P3/matrix.md逐子场景及queued/sent/committed×退休矩阵；两布局|
|V09|新目录协议与明确旧服务器样本|各自既有兼容契约；旧快照不直接覆盖当前状态|relay-frontend.log、relay-transport.log、page-final-second.log|P3/matrix.md逐子场景及queued/sent/committed×退休矩阵；两布局|
|V10|经典与现代真实设置页|勾选、名称、目录和 HTTP/磁盘四层一致；刷新失败可恢复|relay-frontend.log、relay-transport.log、page-final-second.log|P3/matrix.md逐子场景及queued/sent/committed×退休矩阵；两布局|
