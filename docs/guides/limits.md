# 已知限制与未验证项

这份文档是诚实的边界声明。没有经过真实测试的东西不会被写成"已完成"。

## 未在本机验证（需要真实设备）

| 项 | 状态 | 卡点 |
|---|---|---|
| 插件在 **DSH Go** 真实 Android 设备上加载 | 未验证 | 本机没有 Android 设备与 DSH Go 环境 |
| 手机经**樱花 FRP 真实隧道**拨入 PC | 未验证 | 没有真实隧道凭据；隧道行为、节点限速未实测 |
| 手机 rootfs 内 Node 的 `net`/`tls` 在 proot 下的实际表现 | 未验证（有强证据） | 上游仓库的 `dsh-go-bridge/lib/native/ws.js` 是同一套团队写的纯 Node WebSocket，且 dsh-go 自己的远程层用出站 WSS 长连接——说明这条路可行，但**不是**在 dsh-mesh 上跑出来的 |
| DSH Go 插件安装（`dsh plugin` / 插件市场）在手机上对本地源码包的实际行为 | 未验证 | 只在桌面 profile 上验证过 `pnpm add <本地路径>` |
| 手机端 `allowedRoots` 的可见路径 | 未验证 | Android 存储权限与 proot 映射在真机上才确定 |
| App 进入后台后长连接的存活时长 | 未验证（有依据） | DSH Go 用 `foregroundService` + `PARTIAL_WAKE_LOCK`，但极端省电模式仍可能冻结进程 |

以上任一项都需要在真机上跑过才能改成"已验证"。

## 已在本机验证的（但用的是模拟对端）

`mesh_delegate` 的端到端链路是**两个真实 DSH 运行时**之间的真实 WebSocket，但**接收端的"模型"是 stub**：测试里的 `agents.create` 返回一个按脚本产生 `tool/call`、`assistant/message`、`turn/end` 事件的假 Agent。

这意味着：

- ✅ 传输、协议、生命周期、取消、去重、并发、深度限制、账本 —— 都是真的；
- ❌ "远端 Agent 靠自己的推理把任务做出来" —— 没有被验证。

后者需要两台真机各自配好模型凭据，并进行一次人工可复查的委托。这不在本机自动测试能覆盖的范围。

## 功能上的限制

### 会话接续

没有实现真正的跨设备会话迁移。明确只做了"单会话执行归属 + 任务事件同步"。三个概念的区别见 [sessions.md](sessions.md)。

### 没有远程 UI

没有二维码配对、没有远程对话窗口、没有面板。v0.1 的配对靠人工复制一行字符串。

### 传输

- 只有单向的"内容完整性校验 + 原子落地"，**没有断点续传**。分块失败要整文件重来。
- 单块上限 4 MB，整文件一次性读进内存；超大文件（>数百 MB）会把内存顶高，不建议。
- 目录同步不支持，只传单文件。

### 日志跟随

`mesh_logs` 的 `follow` 是一个有限窗口（默认 60 s，最长 10 min）的收集，不是常驻订阅。窗口结束返回这一批；要持续跟就再调一次，用上一轮的 `nextOffset`。

### 命令执行

- 只允许"程序 + 参数"，**没有 shell**。带管道的复合命令做不到。
- 解释器（node/python/bash/…）被一律拒绝，所以传播手脚本的方式不可用。
- Windows 下 `.bat` / `.cmd` 由 cmd 解释执行：实测 `spawn(..., {shell:false})` 对 `.bat` 抛 `EINVAL`、对 `.cmd` 在部分条件下仍能跑，因此**按后缀一律拒绝**（`.bat/.cmd/.ps1/.vbs/.js/.msi` 等返回 `SCRIPT_NOT_ALLOWED`），不是只靠 `cmd` 这个名字在禁用列表里。
- 超时只杀直接子进程；子进程自己再派生的孙进程不保证被清理。

### 委托

- 委托的 `SubagentProvider` 四项 capability 全为 `false`（`agentOptions` / `agentPreset` / `outputSchema` / `depthLimit`）。这是刻意的：远端进程里的子 Agent 无法被本端强制这些属性，DSH 会**在发起前**拒绝这类请求，而不是接受后忽略。副作用是：驱动这个 provider 的工具必须配 `maxDepth: 'provider-managed'`，否则注册时就会 throw（`dsh-tool-subagent` 的既有行为）。
- external provider 是**一次性执行**，不支持续聊（`sendMessage` 会对它抛 `NOT_CONTINUABLE`）。要"接着聊"必须重新委托一个新任务。
- 委托进度只有粗粒度事件（工具调用摘要 + assistant 文本片段），不是完整流式 token。
- 本端 provider 的 `result` **永不 reject**：失败会以 `stopReason: "error"` + diagnostic 返回。这是 DSH 的要求 —— 一个 reject 的 result 会挂住父 Agent 的 teardown。

### 版本

- 桌面 `0.2.1-rc.5` 与手机 `0.2.2-rc.1` 的 API 差异已核对。`dsh-tools` 在 rc.1 移除了 10 个根导出并删了 `./types` 子路径；dsh-mesh **不导入它们**，所以同源码可用。若后续加功能破坏这条约束，手机端会加载失败。
- npm 上 `@deepseek-ai/*` 的 `dist-tags.latest` 是错的（指向 `0.0.1-rc.1`）。当前插件不依赖它们；将来要依赖必须写死精确版本。

### 安全

- 无前向保密（会话密钥由静态配对密钥派生）。
- 无证书链验证（TLS 用指纹固定，需要人工确认指纹一次）。
- 审计是两端各自的，不汇总。
- 配对字符串含密钥，必须带外传递；没有 SAS 短码校验。

## 明确"没有做"的事

- 不修改 DSH / DSH Go 核心代码。
- 不自动推送任何远程仓库。
- 不提供远程桌面、远程聊天窗口、UI 投射。
- 不提供跨设备会话迁移（见上）。
- 不依赖 `ws`、`tsc`、esbuild 或任何 `@deepseek-ai/*` 包 —— 插件只用 Node 内置模块，因此在 profile 的 `node_modules` 里只有它自己也能跑。
