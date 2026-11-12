# dsh-mesh

DeepSeek Harness 的跨设备网格插件。两台设备装**同一个包**，经一条经过认证的全双工连接互相访问对方的真实环境，并能把任务委托给对端**原生运行的 DSH Agent**。

- **不是**远程桌面、远程聊天窗口或文件同步工具。
- **不是**把远程任务包装成 shell 命令。
- 对端执行任务时，用的是它自己的 DSH Agent、自己的工具、自己的权限。

```
   Windows PC                                         Android (DSH Go)
┌─────────────────────────┐   Sakura Frp TCP    ┌─────────────────────────┐
│  DSH + dsh-mesh          │   tunnel (PC only)  │  DSH Go + dsh-mesh       │
│  ┌───────────────────┐   │                     │  ┌───────────────────┐   │
│  │ listener :8765    │◄──┼─── 公网入口 ────────┼─►│ outbound dial      │   │
│  │ PeerServer        │   │                     │  │ PeerClient         │   │
│  └───────────────────┘   │                     │  └───────────────────┘   │
│         ▲                │                     │         │                │
│         │ 同一条 WebSocket，双向 RPC            │         │                │
│         └────────────────┼─────────────────────┼─────────┘                │
│  mesh_* tools            │                     │  mesh_* tools            │
│  SubagentProvider "mesh" │                     │  SubagentProvider "mesh" │
└─────────────────────────┘                     └─────────────────────────┘
```

手机不监听端口、不装 frpc、不需要固定公网 IP。PC 通过**手机打开的那条连接**反向调用手机，因此不需要第二条隧道。

## 状态（v0.1.0）

| 能力 | 状态 |
|---|---|
| 双向 RPC over 单条 WS，请求 ID / 超时 / 取消 | 已完成，双侧实测 |
| 设备身份（Ed25519 → 持久 device id）、配对码、握手证明 | 已完成，双侧实测 |
| 应用层加密（AES-256-GCM）+ 认证信封（HMAC + seq + 时间窗） | 已完成，单元 + 链路实测 |
| TLS 监听 + 证书指纹固定 | 已完成（未启用时明文层仍加密） |
| 文件读/写/列目录，sha256 版本校验、原子替换、根目录限制 | 已完成，双侧实测 |
| 命令执行（无 shell、策略白名单/黑名单、真实退出码） | 已完成，双侧实测 |
| 日志读取 + 流式订阅 + 偏移续读 | 已完成 |
| 分块文件传输 + 校验 | 已完成 |
| 断线重连、心跳、链路状态查询 | 已完成，双侧实测 |
| `mesh_delegate` 委托对端原生 DSH Agent | 已完成（发送端 + 接收端 + 进度 + 取消 + 去重），单机双实例实测 |
| 委托深度限制（禁止 PC→手机→PC 循环） | 已完成 |
| 任务账本、审计日志、结果与产物回报 | 已完成 |
| Android/DSH Go 真实设备联调 | **未完成** — 见 [已知限制](docs/guides/limits.md) |
| 真正的跨设备会话接续（同一会话迁移） | **未实现** — 只做任务事件同步，见 [会话与任务](docs/guides/sessions.md) |

真实设备验收记录见 [docs/acceptance.md](docs/acceptance.md)；哪些经过真实测试、哪些没有，那里逐条标明。

排错时把 `MESH_DEBUG_FILE` 指向一个文件，插件会把加载的每一步追加进去（`apply:enter` / `apply:manager-started` / `apply:ready` / `teardown:begin`）。这是区分「插件没被加载」与「插件加载了但立刻被卸载」的唯一可靠方式——两者从外部看都只是「端口不通」。

## 安装

两端安装方式相同，只是配置不同。

### 1. 安装插件

两端装的是同一份代码，从同一个公开仓库安装：

```powershell
# 桌面端：从仓库直接装（lib/ 已随仓库提交，不需要构建）
dsh plugin --profile desktop add "git+https://github.com/cxabc4/dsh-mesh.git"
```

```bash
# 手机端（DSH Go 的 rootfs 内），同一条命令
dsh plugin --profile desktop add "git+https://github.com/cxabc4/dsh-mesh.git"
```

安装会把它加进 profile 的 `dsh.profile.bundles`，**不会**改动你 profile 的 `cordis.patch.yml`。

**想改代码再装**（需要 Node ≥ 22.18，自带 TypeScript 类型剥离，无需 tsc）：

```powershell
git clone https://github.com/cxabc4/dsh-mesh.git
cd dsh-mesh
node scripts/build.mjs                          # src/*.ts -> lib/*.js
dsh plugin --profile desktop add "<克隆目录>"    # link: 安装，改完重跑 build 即生效
```

也可以用 DSH 桌面端的「设置 → 插件 → 安装本地包」指向同一路径。

> 若 `dsh` 不在 PATH：DSH 桌面自带 `.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs`，命令形如
> `node <pnpm.mjs> --dir <profile目录> add "git+https://github.com/cxabc4/dsh-mesh.git"`，随后手工把 `dsh-mesh` 加进 profile `package.json` 的 `dsh.profile.bundles`。

### 2. 授权目录与配置

配置写在插件的 `cordis.patch.yml` 里（随包分发），或在 profile 的 `cordis.patch.yml` 里用同 id 覆盖：

```yaml
- id: dsh-mesh
  name: dsh-mesh
  config:
    device:
      name: "PC"                       # 手机端写 "Phone"
    server:
      enabled: true                    # 手机端也要开；它由本地 DSH 监听，只绑 127.0.0.1
      host: 127.0.0.1
      port: 8765
    peers:
      - alias: phone                   # 手机端写 pc
        url: wss://你的隧道域名:端口/dsh-mesh
        autoConnect: true
    permissions:
      allowedRoots:                    # 对端能碰的目录，按需最小化
        - "D:\\Projects\\demo"
      allowWrite: true
      allowExec: true
      allowDelegate: true
```

### 3. 首次配对（手动，v0.1 不做二维码）

```text
# 在 PC 的 DSH 会话里
> 运行 mesh_status，告诉我这台设备的 deviceId

# 在手机的 DSH 会话里
> 用 mesh_pair，action=accept，装置 A 给的那行 pairingString

# 回到 PC
> 用 mesh_pair，action=create，device=手机的 deviceId
> 把那行 pairingString 发给手机
```

两侧都拿到同一份 pairing 后，`mesh_connect` 即可连上；连接成功前不会有任何 RPC 被受理。

樱花 FRP 的隧道配置、TLS 指纹生成、以及两端分别的完整步骤见：

- [Windows 安装](docs/guides/install-desktop.md)
- [DSH Go / Android 安装](docs/guides/install-android.md)
- [樱花 FRP 隧道](docs/guides/frp-tunnel.md)
- [认证与权限](docs/guides/security.md)

## 工具

| 工具 | 做什么 |
|---|---|
| `mesh_status` | 本机身份、监听状态、每个对端的连接状态与权限 |
| `mesh_capabilities` | 对端允许你做什么（目录、写、执行、委托、命令策略） |
| `mesh_list` | 列对端目录 |
| `mesh_read` | 读对端文件（带 sha256 版本） |
| `mesh_write` | 写对端文件（必须带版本，冲突返回而不是覆盖） |
| `mesh_exec` | 在对端跑一个程序，拿真实退出码与输出 |
| `mesh_logs` | 读对端日志，支持偏移续读与流式跟随 |
| `mesh_transfer` | 双向分块传输，整文件 sha256 校验 |
| `mesh_delegate` | 把任务交给**对端原生 DSH Agent** |
| `mesh_task_status` / `_result` / `_logs` / `_list` / `_cancel` | 委托任务的进度、结果、产物、取消 |
| `mesh_pair` / `mesh_connect` / `mesh_disconnect` | 配对与连接管理 |

调用示例见 [docs/guides/tools.md](docs/guides/tools.md)。

## 设计要点

- **一条连接双向用**。网络连接方向不等于主从关系：手机主动连 PC，PC 仍可通过这条连接调用手机工具、把任务委托给手机 Agent。
- **路径属于目标设备**。`D:\…` 只对 Windows 有意义，`/home/…` 只对 Android 有意义；插件不翻译路径，两端各自解析。
- **认证不等于授权**。握手证明设备身份；每个 RPC 仍在目标设备上重新检查 `permissions`，被拒绝的动作带稳定错误码返回。
- **不需要跳过安全检查的通道**。远端委托使用的是 DSH 自己的 Agent 与工具，因此目标设备原有的审批、沙箱、工具限制照常生效。
- **一次执行，不重放**。委托任务有唯一 ID 与幂等键，断线重连后查询同一任务而不是重新执行。
- **默认深度 1**。被委托的任务不能再委托回去。

## 开发

```powershell
node scripts/build.mjs          # src/*.ts -> lib/*.js（类型剥离 + 相对导入改写）
node scripts/check-imports.mjs # 校验相对导入都能解析
node scripts/run-tests.mjs     # 构建 + 导入检查 + 全部测试（每文件带 watchdog）
```

测试分四类，互不替代：

- `tests/smoke.test.mjs` — 插件真的能被加载（身份落盘、工具注册、监听启动、TLS 缺证书时拒绝启动）。
- `tests/security.test.mjs` — 身份不可伪造、配对绑定双方、信封拒绝伪造/重放/错址/过期、路径越界拒绝、命令策略、环境变量清洗、原子写冲突。
- `tests/e2e.test.mjs` — **两个真实运行时** + 一条真实 WebSocket：双向 RPC、跨端读写、版本冲突、真实命令退出码、越界拒绝、审计、断线重连、未配对拒绝。
- `tests/delegation.test.mjs` — 委托的收发两端：真跑 `agents.create` seam 创建子 Agent、进度转发、取消走 DSH 的 cancel、幂等去重、并发上限、深度拒绝。

## 许可证

MIT。上游 `ccch1mneyyy/dsh-go` 是 AGPL-3.0：本插件**不包含**其源码，只依赖其运行时装载能力。
