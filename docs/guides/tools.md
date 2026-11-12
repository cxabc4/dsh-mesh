# 工具调用示例

所有工具都接受可选的 `device` 参数。**只连了一个对端时可以省略**；连了多个就必须指明，否则工具会报 `AMBIGUOUS_PEER` 而不是替你猜。

设备名是本地 `peers[].alias`（例如 `pc` / `phone`），也可以是对方的 device id。

## 连接与身份

```text
mesh_status()
→ This device: PC — `aaaaaa-bbbbbb-cccccc-dddddd` on win32/x64, Node v24.14.0
  Listener: ws://127.0.0.1:8765 (path /dsh-mesh)
  Peers:
  - phone [online] id eeeeee… url wss://tunnel:31544/dsh-mesh rtt 42ms
  Pairings:
  - eeeeee-… (code XXXXX-YYYYY)
```

```text
mesh_capabilities(device="phone")
→ device Phone [eeeeee…]
  roots: /storage/emulated/0/Download/dsh-mesh-workspace
  write: yes · exec: yes · delegate: yes
  methods (18): mesh.audit, mesh.capabilities, mesh.delegate, mesh.exec, …
```

```text
mesh_connect(device="phone")
mesh_disconnect(device="phone")
```

## 配对

```text
# 在知道对方 device id 的一侧发起
mesh_pair(action="create", device="eeeeee-ffffff-gggggg-hhhhhh")
→ pairing code XXXXX-YYYYY for eeeeee-…
  Give this line to the other device (mesh_pair action=accept):
  aaaaaa-bbbbbb-cccccc-dddddd|XXXXX-YYYYY|<base64 secret>

# 另一侧
mesh_pair(action="accept", pairingString="aaaaaa-…|XXXXX-YYYYY|<base64 secret>", alias="pc")

mesh_pair(action="list")
mesh_pair(action="remove", device="pc")
```

## 文件

```text
mesh_list(device="phone", path="/storage/emulated/0/Download/dsh-mesh-workspace")
→ /storage/… — 3 entries
  d logs/  0  2026-11-12T…
  - app.log  4096  2026-11-12T…
```

```text
mesh_read(device="pc", path="D:\\Projects\\demo\\README.md")
→ D:\Projects\demo\README.md — lines 0..12 of 12, sha256 3f2a…
  …
```

```text
# 改文件必须带上读到的版本；冲突会返回错误而不是覆盖
mesh_write(
  device="pc",
  path="D:\\Projects\\demo\\README.md",
  content="…新的全文…",
  expectedVersion="3f2a…"
)
→ updated D:\Projects\demo\README.md — 1234 bytes, new sha256 9c1b…
```

冲突长这样：

```
VERSION_CONFLICT: "D:\Projects\demo\README.md" changed since it was read: expected 3f2a…, current 77bd…
```

处理方式：重新 `mesh_read` 拿新版本，人工/模型合并后再写。**不要**重试覆盖。

## 命令

```text
mesh_exec(device="pc", cwd="D:\\Projects\\demo", command="npm test")
→ $ npm test   (cwd D:\Projects\demo)
  exit 1 in 48213ms
  …真实 stdout/stderr…
```

```text
mesh_exec(device="phone", command="uname -a")
→ $ uname -a   (cwd /storage/emulated/0/Download/dsh-mesh-workspace)
  exit 0 in 12ms
  Linux localhost 5.15.0… aarch64
```

被拒绝的写法（会报 `SHELL_NOT_ALLOWED`），因为它们等于把 shell 交出去：

```text
mesh_exec(command="bash -c 'ls && cat secrets'")     # 拒绝
mesh_exec(command="powershell -Command Get-Process") # 拒绝
mesh_exec(command="node -e '…'")                     # 拒绝
```

## 日志

```text
# 读一段
mesh_logs(device="phone", path="/storage/…/logs/app.log", offset=0, maxLines=100)
→ … nextOffset 8123 …

# 接着读新增（把上一轮的 nextOffset 传回来）
mesh_logs(device="phone", path="/storage/…/logs/app.log", offset=8123)

# 跟随一段时间，收集窗口内的新行
mesh_logs(device="phone", path="/storage/…/logs/app.log", follow=true, durationMs=120000)
```

## 传输

```text
# 从对端拉到我这里
mesh_transfer(device="phone", direction="pull",
  remotePath="/storage/…/logs/app.log",
  localPath="D:\\tmp\\phone-app.log")

# 从我这里推过去
mesh_transfer(device="phone", direction="push",
  remotePath="/storage/…/fixtures/build.zip",
  localPath="D:\\Projects\\demo\\dist\\build.zip")
```

两侧都会在落地前校验整文件 sha256；源文件在中途变了会报 `CHECKSUM_MISMATCH` 并保留原文件不动。

## 委托任务（重点）

```text
mesh_delegate(
  device="phone",
  task="检查 /storage/emulated/0/Download/dsh-mesh-workspace/logs/app.log 里最近一次启动崩溃的原因。必要时跑 uname 和 df 确认环境，最后给出结论和涉及的日志行号。",
  label="android startup crash",
)
→ delegated to phone: task 3f8c2d1e-… (android startup crash)
```

任务在手机的本地 DSH Agent 里真实执行。之后：

```text
mesh_task_status(taskId="3f8c2d1e-…")
→ task 3f8c… — running (out phone, depth 0)
  progress lines 6, tool calls 2
  recent progress:
    tool …: {"path":"…/app.log"}
    turn ended: completed

mesh_task_logs(taskId="3f8c2d1e-…", limit=20)
mesh_task_result(taskId="3f8c2d1e-…")
→ <远端 Agent 的最终答复>
  artifacts:
  - [file] /storage/…/logs/app.log (write)     ← 只有它真的改过才会有
  remote session: dsh-mesh-3f8c…
  source: peer

mesh_task_list(direction="out")
mesh_task_cancel(taskId="3f8c2d1e-…")
```

取消的语义：远端用 DSH 自己的 `agent.cancel({kind:'parent'})`，在步边界停下，不是硬杀进程。如果远端有子进程正在跑，它会收到同一个取消信号（`mesh.exec` 的 handler signal）。远端若确实无法取消，会返回 `uncancelable` 并给理由，而不是假装停掉了。

### 一次完整的两端协作

```text
# 手机侧发起：让 PC 改代码并编译
mesh_delegate(device="pc",
  task="在 D:\\Projects\\demo 里把 parse 函数对空输入的处理改成提前返回，然后跑 npm test，把退出码和失败用例原样贴回来。",
  cwd="D:\\Projects\\demo",
  label="fix empty-input parse")

# PC 的 Agent 会：读文件 → 改 → 跑测试 → 回报退出码与失败信息
# PC 返回后，手机继续在自己的环境里验证

mesh_task_result(taskId="…")           # 拿到 PC Agent 的结论、改了哪些文件、测试退出码
mesh_exec(device="pc", command="git diff --stat")   # 再核对一次真实的 diff
```

这就是验收要求里"手机请求电脑修改测试项目，电脑 DSH 作为子代理完成修改和编译，手机再在原生环境验证并汇总"的流程。

## 常见错误码速查

| 错误码 | 含义 | 处理 |
|---|---|---|
| `OFFLINE` | 对端离线 / 隧道断 | `mesh_status` 看状态，`mesh_connect` 重连 |
| `NO_ONLINE_PEER` | 没有任何在线对端 | 同上 |
| `AMBIGUOUS_PEER` | 多个在线对端，未指定 device | 显式传 `device` |
| `UNKNOWN_PEER` | 没有这个 alias/deviceId | 用 `mesh_status` 看别名 |
| `OUTSIDE_ROOTS` | 路径不在对端授权目录内 | 让对方调整 `allowedRoots`，或换路径 |
| `RELATIVE_PATH` | 传了相对路径 | 用绝对路径 |
| `VERSION_REQUIRED` / `VERSION_CONFLICT` | 覆盖写缺版本 / 版本过期 | 重新 `mesh_read` 再写 |
| `SHELL_NOT_ALLOWED` / `COMMAND_DENIED` | 命令策略拒绝 | 直接调程序，不要套 shell |
| `TIMEOUT` / `CANCELLED` | 超时 / 被取消 | 检查任务是否还在远端跑 |
| `DELEGATION_UNAVAILABLE` | 对端组合里没有 subagents 服务 | 让对端装配 `ctx.subagents` |
| `UNKNOWN_METHOD` | 对端不提供该 RPC | `mesh_capabilities` 看支持列表 |
