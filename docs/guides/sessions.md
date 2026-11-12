# 会话与任务：做到哪一步，没做到哪一步

规范要求区分三件容易被混为一谈的事。这份文档把边界划清楚，避免把"远程 UI 切换"当成"会话迁移已完成"。

| # | 概念 | 本插件状态 |
|---|---|---|
| 1 | **远程查看另一台设备的会话** | 不提供。没有远程 UI，也不接管对端界面。 |
| 2 | **在本地 DSH 真正接续同一会话** | **未实现**。 |
| 3 | **在当前会话内调用另一台设备的原生 Agent** | **已实现**（`mesh_delegate`）。 |

## 第 3 项是怎么做到的

`mesh_delegate` 走的是 DSH 自己的子代理机制：

1. 本端注册一个名为 `mesh` 的 `SubagentProvider`，只实现 `start()`（**不实现** `prepareContinuable`）。这一点很关键：实现了它就会切换成"本地子进程"路径，远端就没了。
2. 工具调用时通过 `ctx.subagents.startActivation({ provider: "mesh", delivery: "caller" })` 发起，DSH 负责激活、取消信号、结果投递与资源回收。
3. 本端 provider 把任务参数（目标设备、远端工作目录、深度预算、幂等键）编进 prompt 的一行控制头，然后向对端发 RPC `mesh.delegate`。
4. 对端收到后，用 `ctx.agents.create()` 建一个**真实的子 Agent**（`meta.origin = "subagent"`，`delegationDepth = 1`），把任务 `followup` 给它，并订阅它的 `session/event`。
5. 子 Agent 的 `tool/call` 与 `assistant/message` 被转成 `tool` / `progress` 事件，实时回流到本端并写进任务账本。
6. 子 Agent 空闲后，取它最后一条 assistant 文本作为结果，连同它实际写入的文件与执行的命令作为 artifacts 返回。
7. 本端 provider 把结果映射成 DSH 期望的 `SubagentResult`（`output` + `stopReason`），父 Agent 因此拿到的是**普通子代理结果的形态**，不需要额外适配。

对端那条链路上：任务、进度、取消、结果都在账本里有一条记录，`mesh_task_status` / `_result` / `_logs` 读的就是它。

## 为什么没做第 2 项

真正"同一会话在两台设备上接续"需要的是会话日志的跨设备复制与冲突仲裁，而 DSH 的会话持久化是本地后端（JSONL/SQLite）。要做成，需要：

- 把 `SessionEvent` 流按 seq 复制到对端，并在对端重建 `Session`；
- 解决两端同时推进时 seq 冲突；
- 让 Agent 的所有权（`ctx.agents` 的 registry 条目）在两端之间可迁移。

这不是靠插件接口能解决的，也不该在 v0.1 里假装完成。`api/remotes` 包的官方说明也写明它"不拥有物理传输或 Host 服务发现"，没有现成的跨设备会话通道可接。

**因此 v0.1 明确只做"单会话执行归属 + 任务事件同步"**：

- 某个会话的某次任务由哪台设备执行，账本里记着（`direction` + `peer` + `taskId`）。
- 任务的事件（进度、工具调用、状态）两端都能看到。
- 切换设备后，新会话可以用 `mesh_task_list` / `mesh_task_result` 恢复"上次那个任务怎么样了"。

留了接口：任务账本是 append-only JSONL，`taskId` 是全局 UUID；如果将来要接真正的会话复制，可以在同一个账本上加一层 `sessionId ↔ deviceId` 映射，而不必重写传输层。

## 同一会话同一时刻只有一个有效执行者

这条要求由实现机制天然满足：任务是在**对端**的新子 Agent 里跑的，本端父 Agent 只是在等待结果。不存在两端同时"代表同一个会话"发模型请求的情况。父 Agent 等待期间可以继续做别的事（并行工具、别的委托），但它的回合仍然只有一个。

## 事件流

| 事件 | 何时发出 | 载荷 |
|---|---|---|
| `state` | 任务进入 running / completed / failed / cancelled | `{ state, sessionId?, toolCalls? }` |
| `tool` | 远端子 Agent 调用工具 | `{ name, detail }`（detail 是参数的前 400 字） |
| `progress` | 远端子 Agent 产出一条 assistant 文本或一轮结束 | `{ line }` |
| `progress`（超时） | 超过 `maxTaskMs` | `{ line }`；随后取消 |

这些事件既回流到本端账本，也会推到本端 `mesh_task_logs` 读的那个进度数组里。

## 断线时会发生什么

| 时刻 | 结果 |
|---|---|
| 任务提交前断线 | RPC 直接 `OFFLINE`，没有任务被创建 |
| 提交后、执行中断线 | 本端账本记 `lost`；**远端继续跑**。重连后用同一 taskId 查 `mesh_task_result` 拿到真实结果 |
| 重连后重复调用 `mesh_delegate` | 幂等键命中，返回原 taskId，**不会**再建第二个远端任务 |
| 任务完成但结果没送达 | 账本在远端已有 `completed`；重连后 `mesh_task_result` 从对端读出来 |

## 委托深度

`maxDelegationDepth` 默认 **1**。含义：

- 本端主 Agent（depth 0）可以委托一次；
- 被委托的远端子 Agent 的预算是 `maxDelegationDepth - depth - 1 = 0`；
- 预算为 0 时，远端在创建子 Agent 时通过 `tools.restrict({ deny: [...] })` 把 `mesh_delegate` 等委托工具**从该子 Agent 的工具集里隐藏**，它无法再委托回去。

这既堵住 PC→手机→PC 的无限递归，也保证"被委托的任务就是干活的，不是再转手的"。

如果确实需要多跳，把 `maxDelegationDepth` 调到 2+，但要清楚：每一跳都是一次真实的模型调用，成本按跳数乘。
