# 验收记录

区分四类证据，**它们互不替代**：

- **A 类｜真实设备**：两台真机（Windows PC + Android/DSH Go）。
- **B 类｜两个真实运行时**：本机两个独立 DSH 运行时实例 + 一条真实 TCP WebSocket。
- **C 类｜单元**：纯函数与协议层，用真实 crypto / 真实文件系统，不 mock。
- **D 类｜stub 对端**：真实传输与真实生命周期，但对端的"模型"是脚本 stub。

以下逐条对照规范第十一节的 14 个验收场景。

| # | 验收场景 | 状态 | 证据类 | 具体做法 / 结果 |
|---|---|---|---|---|
| 1 | 两端用同一个插件包，分别加载成功 | 部分 | B + C + R | 同一份 `dsh-mesh` 源码：`tests/smoke.test.mjs` 用假 Cordis 上下文真实 `apply()`，17 个工具 + `mesh` provider + prompt section 全部注册；`tests/e2e.test.mjs` 起两个独立运行时并各自监听。**手机端加载未验证**（无真机） |
| 2 | 手机不装额外穿透软件，经樱花 FRP 主动连接 | 未验证 | — | 需要真实隧道凭据与手机。设计已保证手机只做出站拨号 |
| 3 | PC 读取手机指定目录的真实文件 | 未验证 | — | 反向的同类路径已由 #4 覆盖（同一 RPC、同一实现） |
| 4 | 手机读取并修改 PC 指定测试目录的文件 | 已测（模拟） | B | `files cross the link with version conflict detection`：真实写盘、真实读回、真实 sha256；磁盘内容被断言；陈旧版本被拒绝且文件未被修改；无版本覆盖被拒绝；越界与 `..` 被拒绝 |
| 5 | 手机发起 PC 编译任务，拿到真实退出码与编译日志 | 部分 | B | `commands run remotely…`：真实 `git --version` 返回 exit 0 与真实 stdout；失败命令返回非零 exit 与 stderr。**"编译"未用真实项目**——机制相同，但未在真实工程上跑 |
| 6 | PC 订阅手机运行日志并收到新增内容 | 已测（模拟） | B | `mesh.logs.read` + `mesh.logs.follow`（偏移、轮转检测、取消窗口）在 e2e 与 handlers 层实测。真实手机日志文件未测 |
| 7 | PC 把独立任务交给手机原生 DSH 处理，拿到真实 Agent 结果 | 部分 | B + D | 发送端（provider）、接收端（runner）、真实 `agents.create` seam、进度回流、结果映射全部实测；**远端的"脑子"是 stub** |
| 8 | 手机把代码修改/测试任务交给 PC 原生 DSH | 部分 | 同上 | 同一份实现双向对称；方向翻转不需要不同代码。stub 对端同上 |
| 9 | 断网重连后不重复执行有副作用的任务 | 已测（模拟） | B + C | 幂等键命中返回原 taskId（`repeating the same requestKey…`）；链路断开时任务记 `lost` 而不是重发（provider 实现内断言）；重连后 RPC 恢复（`disconnect and reconnect…`） |
| 10 | 主 Agent 取消远程子任务，远端正确终止或明确报告无法取消 | 已测（模拟） | C + D | `cancelling an inbound task…`：取消走 `agent.cancel({kind:'parent'})`（断言收到的取消原因），账本落 `cancelled`；无法取消时返回 `uncancelable` + 理由 |
| 11 | 两端同时改同一文件能检测冲突，不静默覆盖 | 已测 | B + C | `VERSION_CONFLICT` / `VERSION_REQUIRED` 在 e2e 与单元两层断言；被拒绝后文件内容不变；原子写不留临时文件 |
| 12 | 任一设备离线时另一端仍可独立工作 | 已测 | B | e2e 中 `disconnect` 后 A 仍可继续本地调用；所有 mesh 工具失败都是明确的 `OFFLINE`，不会拖住本端 Agent |
| 13 | 认证失败与未授权访问被拒绝 | 已测 | B + C | 未配对拨入被拒（`NOT_PAIRED`，且监听方未产生 online link）；伪造 MAC / 重放 seq / 错址 / 过期时间戳四类信封攻击均被拒并断链；越界路径、相对路径、`..` 均被拒；shell 与解释器被拒；子进程环境不含凭据 |
| 14 | 所有文件修改与任务执行留下可审计记录 | 已测 | B | 远端 `audit.jsonl` 记录 peer + action + detail + outcome，`mesh_audit` 可读；e2e 断言写入动作在审计里；任务侧由 `tasks.jsonl` 账本记录 |

## 最终演示（规范要求的完整闭环）

规范要求的最终演示是：

> 手机 DSH 请求电脑修改一个测试项目，电脑 DSH 作为子代理完成修改和编译；随后手机 DSH 在自己的原生环境继续验证，并汇总两端日志和测试结果。

本机能做到的部分已经做到并测过：委托原语、进度、结果、产物、取消、幂等、深度限制。**最后一跳"电脑 DSH 真的用模型把代码改对并编译通过"需要一台真实配置好模型凭据的设备**——在本次会话里没有执行。这是要明确写出来的一条，不能含糊过去。

反向（电脑为主、手机为子代理）同理。

## 复现方式

```powershell
cd <克隆目录>
node scripts/build.mjs
node scripts/check-imports.mjs
node scripts/run-tests.mjs
```

期望输出：

```
PASS delegation.test.mjs  tests=8 pass=8 fail=0
PASS e2e.test.mjs         tests=7 pass=7 fail=0
PASS security.test.mjs    tests=13 pass=13 fail=0
PASS smoke.test.mjs       tests=4 pass=4 fail=0

run-tests: 4 file(s) passed, 0 failed
```

**R 类｜真实 DSH 组合**（本机新增证据）：在隔离的 $DSH_HOME 里用 DSH 自己的 Loader 组合一个只含 @deepseek-ai/dsh-base + @deepseek-ai/dsh-web-app + dsh-mesh 的 profile，--dump-config 输出里有 - id: dsh-mesh，启动后 pply 的追踪写入了 pply:enter → config → before-manager-start → manager-started → ready，且 127.0.0.1:8765 在进程存活期间持续接受 TCP 连接。这条证据来自 MESH_DEBUG_FILE 追踪（见 scripts/probe-real-composition.mjs）。<br><br>另有若干独立探针脚本，用来在排错时逐步骤观察（不进测试套件）：

| 脚本 | 作用 |
|---|---|
| `scripts/debug-ws.mjs` | 裸 WS + 握手 + 双向加密 RPC，排除管理器逻辑干扰 |
| `scripts/debug-handshake.mjs` | 两个管理器的完整握手与链路状态变化 |
| `scripts/debug-e2e.mjs` | 逐步骤跑文件/命令/审计/重连场景并打印结果 |
| `scripts/debug-leak.mjs` | dispose 之后还有哪些句柄活着 |
| `scripts/asar-extract.mjs` | 从 DSH 的 `app.asar` 里抽出源码用于核对 API |

## 真实设备验收的步骤（待执行）

要在真机上把上面标"未验证"的项变成已验证，需要：

1. PC 装好插件并确认 `mesh_status` 里有 listener；
2. 手机装好 DSH Go 与同一插件包，确认 `mesh_status` 起得来；
3. 建樱花 FRP TCP 隧道，用外网 `curl` 确认端口可达（返回 400 是正确结果）；
4. 两侧 `mesh_pair` 完成配对，手机 `mesh_connect`；
5. 依次跑：`mesh_list`（手机目录）→ `mesh_exec`（手机 `uname -a`）→ 反向 `mesh_read`（PC 文件）→ 反向 `mesh_exec`（PC `git --version`）→ `mesh_logs`（手机日志）；
6. 双向 `mesh_delegate`，远端各配真实模型；
7. 中途断网（关 Wi-Fi）验证重连与不重复执行；
8. 检查两端 `audit.jsonl` 与 `tasks.jsonl`。

第 6 步是唯一还需要人参与判断的一步（要看远端 Agent 是否真的靠推理完成了任务，而不只是返回了一段话）。
