# 平台协议与接入边界：office-capability-kit 0.5

本源代码工具包采用六个既定任务的平台中立契约。逐项官方公开 URL、commit、官方源码 SHA 与许可证见 [PLATFORM_PROTOCOL_SOURCES.json](PLATFORM_PROTOCOL_SOURCES.json)。这些是静态 source pins，不是已部署版本、浏览器回执或原生集成结果。

## 结论与最小 adapter

0.5 的默认路径应是 **generic standalone web app + 明确的任务本地宿主能力接口**。它能承载真正的 HTML/JS 或前端小项目，任务、输入、产物、工具账本与验收规则可独立于某个平台复用。这里的“可移植”是平台中立的契约及可替换 adapter，不是已经兼容所有平台。

最小接口只需覆盖四类能力：

1. 读取任务源文件及其版本、写权限；明确 null/失败语义。
2. 以已读 revision 保存限定 draft，区分 confirmed、conflict、read_only、结果未确认；重读用于恢复真实状态。
3. 调用预先声明的确定性工具；记录原始请求、接收/拒绝、实际 effect 和结果，禁止真实模型/agent、邮件或审批提交等未授权效果。
4. 在实际用户操作后交付文件，保留下载字节/哈希与文件状态证据。

这些是 **kit 自有能力契约**，不冒充 Dust、A2UI、Counso 或通用行业 SDK。UI source/package、输入文件、宿主能力和测试证据分开即可，无需实现新的 UI 框架。候选提交真实小项目代码，宿主负责受控执行与证据；固定参考实现只证明测量工程可运行，不能证明模型已经生成成功。

选择边界：

| 路径 | 0.5 范围 | 此研究实际可证明 |
| --- | --- | --- |
| Standalone web app | 默认 | 技术上不依赖上述平台；功能 PASS 仍须该项目实际浏览器事件、工具/文件证据 |
| Dust Frames | 可选 adapter | 官方源码契约可得；原生部署/发布/交互 UNKNOWN |
| A2UI | 可选 adapter | 官方协议和 renderer 源码可得；尚未安装、接入或测试 |
| Counso native MiniApps | 未解锁 | 官方产品与文档索引可读；产品源码、精确接入及原生执行 UNKNOWN |

不会因某平台不可得而删除任务，也不会用未知证据重归一分数。协议映射/renderer 故障属于 PROTOCOL_INTEGRATION 或 UNKNOWN_SOURCE；不能自动当作业务错误、安全副作用或模型质量 0。

## Dust Frames：当前官方静态契约

本工具包的官方源码 pin 是 [f0d8be778a81eaf0dda8400cf0724e3064248c44](https://github.com/dust-tt/dust/commit/f0d8be778a81eaf0dda8400cf0724e3064248c44)，当前 source pin 没有声称任何发布 tag，也不代表 Dust SaaS 或 Counso 的部署版本。

### UI stack、SDK 与 manifest

- [viz/package.json](https://github.com/dust-tt/dust/blob/f0d8be778a81eaf0dda8400cf0724e3064248c44/viz/package.json) 声明 Node >=24.16.0、Next ^14.2.35、React/ReactDOM ^18.3.1、TypeScript ^5.7.2、react-runner、Recharts、Radix/shadcn、SWR 等。该 package 为 private；这些是源码声明，不是本次安装验证。
- Frame 是 React/TSX code，runtime imports 有受控名单。[runtime scope](https://github.com/dust-tt/dust/blob/f0d8be778a81eaf0dda8400cf0724e3064248c44/viz/app/lib/frame-runtime-scope.ts) 绑定 react、recharts、shadcn、papaparse、lucide-react、motion/react、文档/幻灯片组件、@dust/frame 与 @dust/react-hooks 等。不能由这些 alias 推断存在可 npm install 的公开 @dust/frame/@dust/react-hooks SDK，也不能承诺任意 npm imports。
- [FrameRoot](https://github.com/dust-tt/dust/blob/f0d8be778a81eaf0dda8400cf0724e3064248c44/viz/components/dust/frame/index.tsx) 是主题 CSS 变量容器，不是通用声明式 UI renderer。
- [manifest schema](https://github.com/dust-tt/dust/blob/f0d8be778a81eaf0dda8400cf0724e3064248c44/front/types/api/frame_manifest.ts) 的 version 是 1，默认 uiEntryPoint 为 index.tsx，可声明 functions、databases（最多 4）；entry path 必须是安全相对路径。函数有 executionMode、defaultStake；函数与数据库名称不能重复。**产品 Frames v2 与 manifest version 1 是两个概念。**
- [路由](https://github.com/dust-tt/dust/blob/f0d8be778a81eaf0dda8400cf0724e3064248c44/front/lib/api/actions/servers/interactive_content/index.ts) 按 workspace 的 frames_v2 flag 选择 legacy/v2。任何实际 workspace 的 flag 与版本均未测。

### 文件、RPC 与函数权限

[RPC 类型](https://github.com/dust-tt/dust/blob/f0d8be778a81eaf0dda8400cf0724e3064248c44/viz/app/types.ts) 与 [RPCDataAPI](https://github.com/dust-tt/dust/blob/f0d8be778a81eaf0dda8400cf0724e3064248c44/viz/app/lib/data-apis/rpc-data-api.ts) 通过 host 的 getFile/writeFile/callFunction 等命令操作，并不是 A2UI component-message stream。

- useFile 的表面返回是 File|null；readFile 返回 {file, revision:string|null, canWrite:boolean}|null。读失败/null 不能区分文件缺失、权限失败或网络错误。缺 revision 必须禁写。
- writeFile(path, content, {revision, contentType?}) 的 content 是 string，revision 必需。结果是 {success:true,revision} 或 {success:false,error:{code,message}}。
- [host 写入](https://github.com/dust-tt/dust/blob/f0d8be778a81eaf0dda8400cf0724e3064248c44/front/lib/swr/frame_files.ts) 先检查 canWrite，将路径限制到明确的 packageRoot，PUT 携带 X-Dust-If-Revision-Match。412 对应 conflict，401/403 对应 read_only；不可靠回执、网络失败或没有新 revision 对应 save_failed。仅确认新 revision 后返回成功。
- [函数引用](https://github.com/dust-tt/dust/blob/f0d8be778a81eaf0dda8400cf0724e3064248c44/front/types/api/frame_function_reference.ts) 仅接 bare manifest function name，由可信 host 拼接 frameId/name；legacy 明确拒绝函数调用。客户端显示的身份属性不构成服务端授权。
- [函数执行](https://github.com/dust-tt/dust/blob/f0d8be778a81eaf0dda8400cf0724e3064248c44/front/types/api/sandbox_functions.ts) 分 fast/durable，默认 durable；durable 可以通过 dsbx tools 调 Dust 工具，fast 仍能读写状态、运行程序或外连。defaultStake 默认 low，允许 never_ask/low/high。**callFunction、fast 或 low 都不保证无 LLM/agent/网络/副作用。** 本 kit 只接任务限定、确定性的受控工具。

### 创建与发布界限

[Frames v2 MCP allowlist](https://github.com/dust-tt/dust/blob/f0d8be778a81eaf0dda8400cf0724e3064248c44/front/lib/api/actions/servers/interactive_content_v2/tools/index.ts) 保留从 template 创建与 legacy export；inline 创建、edit、publish 不在此 MCP server 中。任意 source/package 的发布需要相应 Computer/文件系统及 [CLI call/share-link/publish](https://github.com/dust-tt/dust/blob/f0d8be778a81eaf0dda8400cf0724e3064248c44/cli/dust-sandbox/src/commands/frame/mod.rs)。[CLI HTTP client](https://github.com/dust-tt/dust/blob/f0d8be778a81eaf0dda8400cf0724e3064248c44/cli/dust-sandbox/src/api/client.rs) 有 sandbox/frames/publish 路由；它是源码中的接入，不是本次已验收的公开通用 REST 服务。不要推荐未核实存在的 dsbx frame validate。

[官方产品文档](https://docs.dust.tt/docs/user-documentation/agents/frames/overview) 说明交互、持续修改、分享及 PDF/PNG/template 导出。这是产品说明；本次没有真实发布、导出、分享或原生写入 PASS。

## A2UI：真实协议、renderer 与工具交互

[a2ui.org](https://a2ui.org/) 现链接 [a2ui-project/a2ui](https://github.com/a2ui-project/a2ui)。官方 source pin 为 commit [ce03d005c0575ff6708da583d9e7658a34df2d5d](https://github.com/a2ui-project/a2ui/commit/ce03d005c0575ff6708da583d9e7658a34df2d5d)，2026-10-10 02:12:56 UTC。

版本必须分清：

- 官方 README 与 specification 标识 **v0.9.1 current production，v1.0 release candidate，v0.8 legacy**。
- [renderer 支持表](https://github.com/a2ui-project/a2ui/blob/ce03d005c0575ff6708da583d9e7658a34df2d5d/docs/public/reference/renderers.md) 列 React/Lit/Angular 的 v0.9.1 stable、v1.0 planned。这是官方维护声明，不是本地 renderer 验收。
- 源码中的 React/Lit/web_core package.version 是 0.13.0；它不等于协议 v0.9.1，也不证明 npm 已发布或这里已安装。此检查未核实 protocol git tag，不能把协议版本字符串当作已验证 git tag。

[协议 v0.9.1](https://github.com/a2ui-project/a2ui/blob/ce03d005c0575ff6708da583d9e7658a34df2d5d/specification/v0_9_1/docs/a2ui_protocol.md) 是传输无关的声明式 JSON：

- Agent→renderer 有 createSurface、updateComponents、updateDataModel、deleteSurface。UI 是按 ID 关联的组件列表，数据模型独立，JSON Pointer 绑定；renderer 必须实现 lifecycle、reactivity、两向输入与 action。
- [server schema](https://github.com/a2ui-project/a2ui/blob/ce03d005c0575ff6708da583d9e7658a34df2d5d/specification/v0_9_1/json/server_to_client.json)、common types、basic catalog 共同决定合法 payload。该 source 的 v0_9_1 schemas 仍保留 v0_9 的 $id，version enum 接 v0.9/v0.9.1；[basic catalog](https://github.com/a2ui-project/a2ui/blob/ce03d005c0575ff6708da583d9e7658a34df2d5d/specification/v0_9_1/catalogs/basic/catalog.json) 的实际 catalogId 也保留 v0_9 路径。不要凭目录名改写 ID；应绑定实际 catalog 与 renderer 版本，记录文档示例/源码差异。
- [client action schema](https://github.com/a2ui-project/a2ui/blob/ce03d005c0575ff6708da583d9e7658a34df2d5d/specification/v0_9_1/json/client_to_server.json) 要求 name、surfaceId、sourceComponentId、timestamp、context，context 为解析后的值。它不是“保存到业务系统已成功”的证明，也没有替 kit 自动实现 revision/CAS 或 idempotency。
- Catalog 是可信组件/函数的边界。任意生成 TSX、小项目代码不能直接塞进 A2UI JSON；自定义组件需要预先可信的实现及 schema。A2UI 可以表达生成/组合界面，但不能把所有 UI 自定义代码能力等同于 catalog composition。

[React 官方例](https://github.com/a2ui-project/a2ui/blob/ce03d005c0575ff6708da583d9e7658a34df2d5d/renderers/react/README.md) 用 MessageProcessor、basicCatalog、A2uiSurface 与 /v0_9 imports；固定 messages 可以离线处理，不必为了协议检查调用模型。后续选择 A2UI 时应复用现有官方 renderer，而非写新 renderer，再把解析后的 action 显式映射到 kit 的受控工具/文件能力。此 0.5 尚未实现或测试该 adapter。

[A2UI over MCP guide](https://github.com/a2ui-project/a2ui/blob/ce03d005c0575ff6708da583d9e7658a34df2d5d/docs/public/guides/a2ui_over_mcp.md) 描述 application/a2ui+json、资源模板、tool 返回 updateDataModel、_meta.ui.resourceUri 链接、action→tool call。它有自己的 capability/catalog 协商示例，部分示例仍写 v0.9。不能由“平台支持 MCP”推断它也支持 A2UI renderer、这些 metadata 或完整 action 回路；MCP Apps/HTML app 与 A2UI 也不能混为同一协议。

## Counso 与 Mini App 的可得性

可读的 [Counso 官方主页](https://counso.ai/) 描述团队 AI workspace、Pods、交互 Mini Apps；[integrations](https://counso.ai/product/integrations/) 描述办公来源和 MCP；[官方 docs 首页](https://docs.counso.ai/) 列 MiniApps、MCP client、client-side MCP 与开发/API 入口。

这足以确认产品定位与文档索引存在。详细 MiniApps/MCP 文档链接及 llms.txt 本次返回 cache miss/不可读取；未取得可由官方站认证的产品源码仓库、许可证、SDK/schema 版本、可调用接口或部署 commit。搜索到同名 docs 仓库不构成官方身份，因此未拿来替代证据。**这不是“Counso 无 API/源码”的断言；准确结果是这些具体证据仍 UNKNOWN。**

Mini App/MiniApps 在这里是产品名或小型互动应用的泛称，不是可从名称推出的统一协议。不能由相似概念或界面推断 Counso 使用 reviewed Dust commit、Frames v2 flag、A2UI，或接口签名完全相同。

受控本地 SDK/mock、静态官方源码和原生平台服务是不同层。不能把本工具包的 synthetic host 叫作原生 Counso SDK 或原生验收。

## 依赖与许可证门槛

- 当前 standalone 首选浏览器标准能力与已有 kit 依赖；本研究不引入第三方运行库，也不把 Dust 全站 stack 变成便携套件的必需依赖。
- Dust 根 [LICENSE](https://github.com/dust-tt/dust/blob/f0d8be778a81eaf0dda8400cf0724e3064248c44/LICENSE) 是 MIT；复制实质源码需保留版权/许可。新 adapter 若复用，必须明确精确版本、完整锁图及各包许可，不必装 Next/Recharts/全 shadcn 才能做默认独立应用。
- A2UI 根 [LICENSE](https://github.com/a2ui-project/a2ui/blob/ce03d005c0575ff6708da583d9e7658a34df2d5d/LICENSE) 为 Apache-2.0，另列 eval/bin/transcrypt 的 MIT exception。选定源码/renderer 要保留适用许可和 notices、标注修改；这不自动授予商标或服务访问。
- 可选 [@a2ui/react source](https://github.com/a2ui-project/a2ui/blob/ce03d005c0575ff6708da583d9e7658a34df2d5d/renderers/react/package.json) 依赖 @a2ui/web_core、@a2ui/markdown-it、clsx、markdown-it、zod，peer React/ReactDOM 18 或 19、zod；[Lit source](https://github.com/a2ui-project/a2ui/blob/ce03d005c0575ff6708da583d9e7658a34df2d5d/renderers/lit/package.json) 依赖 web_core、lit、signals/context、zod 等。workspace:* 与 semver ranges 不是可重复安装锁图；所有 transitive licenses、registry availability、完整安装与 browser compatibility 本次未验收。暂缓添加这些依赖最符合 0.5 的有界工程范围。
- Counso 产品源码许可 UNKNOWN；不能把 Dust MIT 或 A2UI Apache-2.0 归给 Counso。继续接入前需要其实际授权环境、可信接口/源码与 license 条款，不在本任务创建账户或获得新凭证。

## 何时可以升级为集成 PASS

每种 adapter 分别固定 deployed/source 版本、能力/schema/import allowlist、权限和依赖锁图，并完成同一六任务的真实 UI 事件、source update、revision conflict/Reapply/Discard、重复操作恢复、实际 add/remove/save、工具 effect 与文件交付验证。声明式 schema validate、代码编译、mock 成功 toast 或截图都不充分。

没有对应浏览器/服务证据时记 UNKNOWN，禁止把源码可读或适配器存在当作原生成功。对拒绝的只读查询可记协议违规，但不能凭此推出不安全副作用。可见“已完成”要与受接收工具账本或独立完整状态检查绑定；纯自然语言 regex 不产生 critical。本源代码工具包不附带模型结果或排名/稳定性测量。

