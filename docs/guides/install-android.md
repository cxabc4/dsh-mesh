# DSH Go / Android 安装（手机端）

手机端装的是**同一个插件包**。差异只有配置：它对外拨号，不监听公网端口。

## 前置事实（已核实，不是猜测）

- DSH Go 不是「Go 写的 DSH」，而是 Flutter + Kotlin 的 Android 应用，内嵌 Ubuntu 24.04 rootfs + Node.js 24.22.1 + `@deepseek-ai/dsh 0.2.2-rc.1`，用 proot 跑 `dsh web --host 127.0.0.1 --port 3080`。
- 插件机制与桌面版**同一套 cordis**。手机端插件跑在 rootfs 里那台 Node 上，所以它发起的出站 WebSocket 是普通 Node 行为，不受 Android「只能出站」的限制——那个限制约束的是 App 的 Dart 层。
- `dsh web` 会拒绝绑定通配地址（原话大意：绑定所有网卡等于暴露远程代码执行），`network_security_config.xml` 也只对 `127.0.0.1` / `localhost` 放行明文。所以**手机不会、也不该监听公网端口**。
- 手机的本地 3080 是给 App 自己连的，不能当作跨设备入口。

结论：手机必须**出站拨号**。PC 通过手机建立的那条连接反向调用手机，同一条 socket 双向用，不建第二条隧道。

## 1. 把插件放进手机

DSH Go 的插件安装有两条路：

1. **插件市场**（设置 → 插件 → 插件市场）：适合发布到 npm 或已在市场索引里的包。DSH Go 的能力是「先卸再装」，没有 in-place 升级。
2. **`dsh plugin` 命令**（rootfs 内）：等价桌面版的安装方式，底层转发给 rootfs 自带的 pnpm（11.28.5）。

dsh-mesh 发布在公开仓库，所以从 git 地址装最省事——**不需要在手机上构建**，`lib/` 已经随仓库提交：

```bash
# 在 DSH Go 的终端 / rootfs shell 中
dsh plugin --profile desktop add "git+https://github.com/cxabc4/dsh-mesh.git"
```

`package.json` 里没有 `prepare` / `prepack` / `postinstall`，所以 pnpm 拉到仓库后不会尝试跑任何构建脚本——手机端没有 TypeScript 也能装。

如果 rootfs 里没有 `dsh` 命令，改用自带 pnpm 直连：

```bash
node <pnpm>/pnpm.mjs --dir "$DSH_HOME/profiles/desktop" add "git+https://github.com/cxabc4/dsh-mesh.git"
```

也可以先把仓库 clone 到手机本地目录再装本地路径（`add /path/to/dsh-mesh`），两者等价；git 形式的好处是以后重装能直接拿到仓库里的新版本。

然后确认 profile 的 `package.json` 的 `dsh.profile.bundles` 里有 `dsh-mesh`。

> 版本提示：手机是 `0.2.2-rc.1`。dsh-mesh 的依赖面已按该版本核对过（见 [install-desktop.md 的版本兼容](install-desktop.md#版本兼容)）。npm 上 `@deepseek-ai/*` 包的 `dist-tags.latest` 是错的（指向 `0.0.1-rc.1`），**如果将来要依赖它们，必须写死精确版本**；当前插件不依赖任何 `@deepseek-ai/*` 包。

## 2. 配置

```yaml
- id: dsh-mesh
  name: dsh-mesh
  config:
    device:
      name: "Phone"
    server:
      # 手机也开监听，但只绑回环：给本机 App / 调试用，公网到不了。
      enabled: true
      host: 127.0.0.1
      port: 8765
      tls:
        enabled: false
        fingerprintSha256: ""   # 连 wss:// 的 PC 时，这里必须填 PC 证书指纹
    peers:
      - alias: pc
        url: wss://你的樱花隧道域名:端口/dsh-mesh
        autoConnect: true
    permissions:
      allowedRoots:
        - "/storage/emulated/0/Download/dsh-mesh-workspace"
        - "/data/data/com.termux/files/home"    # 仅当确实存在并需要时
      allowWrite: true
      allowExec: true
      allowDelegate: true
```

手机端的 `allowedRoots` 取决于 rootfs 里真实可见的路径。不要照抄 PC 的 Windows 路径——路径由目标设备自己解析，插件从不翻译。

## 3. 配对

手机端先 `mesh_status` 拿到自己的 device id，然后：

```text
# PC
> mesh_pair action=create device=<手机的 device id>
# 把打印出的 pairingString 完整发到手机

# 手机
> mesh_pair action=accept pairingString="<那一整行>"
```

再在手机 `peers` 里填 PC 的隧道地址（或反过来让 PC 连手机的内网地址，见下）。

## 4. 连接方向

默认拓扑：**手机连 PC**。

- 手机 `peers: [{ alias: pc, url: wss://<隧道域名>:<公网端口>/dsh-mesh }]`
- PC 不需要配 `peers`；它会在手机拨入后自动登记这条 link，并能反向调用手机。

反过来（PC 连手机）只在同一局域网内可行，因为手机不暴露公网端口。这种情况下把 PC 的 `peers` 指向手机的内网地址，手机 `server.host` 需要临时改成 `0.0.0.0`——**不建议**，除非你清楚这意味着什么。

## 5. Android 特有的行为

| 场景 | 会发生什么 | 应对 |
|---|---|---|
| App 切到后台 | DSH Go 使用 `foregroundService` + `PARTIAL_WAKE_LOCK`，进程保持存活 | 无操作；但系统仍可能在极端省电模式下冻结进程 |
| Wi-Fi ↔ 移动数据切换 | socket 断开，插件进入 `offline` 并按指数退避重连 | 心跳 20s + 退避 1s→30s；切换后通常数十秒内恢复 |
| 运营商 NAT 超时 | 长连接被静默丢弃（socket 看起来还开着） | 心跳会探测失败并主动 destroy，触发重连 |
| 手机重启 | 身份与 pairing 保存在 `$DSH_HOME/dsh-mesh`，不会丢 | 重启后自动重连 |
| 系统杀掉 App | 任务中断 | 任务账本标记 `lost`，重连后用同一个 task id 查询，不会重复执行 |

## 6. Android 原生工具

手机原生能力（通知、相册、剪贴板、传感器等）由 DSH Go 自己的 `phone` 工具族提供，不走 dsh-mesh 的远程 RPC。也就是说：

- 手机上的 DSH Agent 被委托任务时，**它能用这些原生工具**——因为它就是手机本地的 DSH Agent。
- PC 上的 DSH 通过 `mesh_*` 远程调用时，只能用到 dsh-mesh 暴露的那组文件/命令/日志能力，**不能**直接调手机的相册之类。

这是设计选择：原生工具属于 DSH Go 的插件平台，若要让远端也能用，应当通过「委托任务」而不是「远端工具直调」。

如果某项手机能力确实不可用，插件不会假装成功：`mesh_capabilities` 会如实列出对端支持的 RPC 方法，不包含的调用会得到 `UNKNOWN_METHOD`。

## 7. 验证清单

1. 手机 `mesh_status` 显示 listener 在 `127.0.0.1:8765`（这证明 rootfs 内 Node 起得来）。
2. 手机 `mesh_connect(device="pc")` 后状态变 `[online]`。
3. PC 侧 `mesh_status` 出现手机这条 link，`outbound: false`。
4. PC 调 `mesh_exec(device="phone", command="uname -a")`，返回 rootfs 的 `Linux … aarch64`。
5. 手机调 `mesh_read(device="pc", path="D:\\Projects\\demo\\README.md")` 能读到。

## 8. 排错

| 现象 | 排查 |
|---|---|
| 插件加载了但工具没出现 | `inject: ["tools"]` 的服务不存在时 Cordis 会静默跳过 apply；检查是否在手机端 preset 里裁掉了 tools |
| `wss://` 连不上，`lastError: CERT_UNPINNED` | 手机端没填 PC 证书指纹，或 PC 没开 TLS |
| 连上后很快掉线 | 隧道断或心跳失败；看 PC 日志与手机 `mesh_status` 的 `lastError` |
| `mesh_delegate` 报 `DELEGATION_UNAVAILABLE` | 手机端 DSH 组合里没有 `ctx.subagents`（部分精简 preset 会裁掉） |
| `mesh_delegate` 报 `NO_INITIATOR` | 从非 Agent 上下文（例如插件回调）调用了委托；必须从 Agent 回合里调 |
