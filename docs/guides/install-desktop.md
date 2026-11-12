# Windows 安装（PC 端）

PC 是这条链路的**监听端**：它跑本地服务，由现有的樱花 FRP 隧道映射到公网，手机主动连上来。

## 前置条件

- Windows 上有可用的 DSH 桌面版（本文按 `0.2.1-rc.5` 写成；`0.2.2-rc.1` 的 API 兼容性见 [版本兼容](#版本兼容)）。
- Node.js ≥ 22.18（DSH 桌面自带运行时；确认方式见下）。
- 已经装好樱花 FRP 客户端并能建 TCP 隧道（本文不重复 FRP 客户端的安装）。

确认 DSH 自带的 Node 版本：

```powershell
node -e "console.log(process.version)"           # 本机 v24.14.0
node -e "console.log(typeof require('node:module').stripTypeScriptTypes)"   # function
```

## 1. 构建插件

```powershell
cd <克隆目录>
node scripts/build.mjs
node scripts/check-imports.mjs
```

两条都应输出 `problems: 0` / 正常构建数字。构建只依赖 Node 内置的 TypeScript 类型剥离，不需要 `tsc`、`esbuild` 或任何第三方包。

> 为什么需要构建步骤：DSH profile 里跑的是 `.js`，Node 明确拒绝对 `node_modules` 内的 `.ts` 做类型剥离（`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`）。`src/` 是作者源码，`lib/` 是随包分发的产物。

## 2. 装进 profile

```powershell
dsh plugin --profile desktop add "<克隆目录>"
```

如果 `dsh` 不在 PATH：

```powershell
$pnpm = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs"
node $pnpm --dir "$env:USERPROFILE\.dsh\profiles\desktop" add "<克隆目录>"
```

随后确认 profile 的 `package.json` 里出现了 bundles 条目：

```jsonc
{
  "dsh": {
    "profile": {
      "bundles": [ /* … 其它 */, "dsh-mesh" ]
    }
  }
}
```

安装动作做的是：把依赖写成 `link:<克隆目录>`、在 profile 的 `node_modules` 建 junction、把包名追加进 `dsh.profile.bundles`。它**不会**改 profile 的 `cordis.patch.yml`。

> 注意：装完后**不要**手工编辑 profile 的 `cordis.patch.yml` 去改 dsh-mesh 的配置行 —— 那会导致重装时配置被覆盖。改插件自己的 `cordis.patch.yml`，或在 profile patch 里用 `- id: dsh-mesh` 显式覆盖。

## 3. 配置

编辑插件目录下的 `cordis.patch.yml`（它随包分发，重装会保留你 profile 层的覆盖）：

```yaml
- id: dsh-mesh
  name: dsh-mesh
  config:
    device:
      name: "PC"
    server:
      enabled: true
      host: 127.0.0.1        # 只绑回环；公网暴露交给 FRP
      port: 8765
      tls:
        enabled: false       # 见「TLS」一节；先跑通再开
    peers: []
    permissions:
      allowedRoots:
        - "D:\\Projects\\demo"
      allowWrite: true
      allowExec: true
      allowDelegate: true
      maxDelegationDepth: 1
```

`allowedRoots` 是**对端**（也就是手机）能读写的目录。先只放一个测试项目，确认链路正常后再加。

## 4. 启动并确认监听

重启 DSH 桌面（或等它热重载）。日志里应看到：

```
dsh-mesh ready: device <device-id>, listener enabled on /dsh-mesh, 0 configured peer(s)
```

确认端口：

```powershell
Get-NetTCPConnection -LocalPort 8765 -State Listen | Select-Object LocalAddress,LocalPort,OwningProcess
```

应只有一条 `127.0.0.1:8765`。**如果看到 `0.0.0.0:8765`**，说明配置里的 `server.host` 被改过，立即改回 `127.0.0.1` —— 那等于把接口暴露到整个局域网。

## 5. 拿到本机 device id

在 DSH 会话里让 Agent 调一次 `mesh_status`，输出里 `This device … — `<device-id>`` 就是手机配对时要用到的 id。这个 id 由首次启动生成的 Ed25519 公钥派生，重装插件、换 IP、换隧道都不会改变；删掉状态目录才会换。

## 6. 配对

见 [README 的首次配对](../README.md#3-首次配对手动v01-不做二维码)，或更详细的 [security.md](security.md)。

## 7. 打通隧道

见 [frp-tunnel.md](frp-tunnel.md)。隧道建好后把 `peers` 里那条 `url` 填成隧道给出的公网地址，手机上填对端 url 指向它。

## TLS

默认关闭。关闭时**应用层仍然全程加密**（每条帧都是 AES-256-GCM 密文 + HMAC 信封），隧道只能看到密文和一次 cleartext 握手。开启 TLS 的额外收益是连握手也藏起来。

开启需要一张证书（自签即可，因为客户端用指纹固定而不是 CA 链验证）：

```powershell
# 需要 OpenSSL；Windows 可用 git 自带的
openssl req -x509 -newkey rsa:2048 -nodes -days 825 `
  -keyout mesh-key.pem -out mesh-cert.pem `
  -subj "/CN=dsh-mesh" `
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
```

取指纹（sha256，去掉冒号、小写）：

```powershell
$cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new("mesh-cert.pem")
$sha = [System.Security.Cryptography.SHA256]::Create().ComputeHash($cert.RawData)
([BitConverter]::ToString($sha) -replace '-','').ToLower()
```

填进配置：

```yaml
server:
  tls:
    enabled: true
    certPath: "D:\\path\\to\\mesh-cert.pem"
    keyPath: "D:\\path\\to\\mesh-key.pem"
```

指纹填到**手机端**的 `server.tls.fingerprintSha256`（手机用它校验 PC 的证书）。任何 `wss://` 对端在没有配置指纹时会被拒绝连接 —— 这是刻意的：公网上不固定的证书等于可以被中间人替换。

> 单元格大小写：`fingerprintSha256` 只接受十六进制，冒号会被自动清掉。

## 验证清单

装完后依次确认：

1. `mesh_status` 显示 `Listener: ws://127.0.0.1:8765`；
2. 手机连上后，PC 的 `mesh_status` 里对应 peer 变成 `[online]`；
3. `mesh_capabilities(device="phone")` 能读到手机的授权目录；
4. `mesh_exec(device="phone", command="uname -a")` 返回真实输出；
5. 反向：手机 `mesh_read(device="pc", path="D:\\Projects\\demo\\README.md")` 能读到内容。

## 版本兼容

本插件在 `0.2.1-rc.5` 与手机端 `0.2.2-rc.1` 上使用同一份源码。实测两版之间以下 API 稳定：`ctx.tools.register`、`ctx.subagents.registerProvider` / `startActivation`、`ctx.agents`、`ctx.effect`、`@deepseek-ai/schemastery`。

已知 `dsh-tools` 在 `0.2.2-rc.1` 移除了 10 个根导出（`jsonSchemaToTs`、`renderToolsSdk`、`ToolPresentationMode` 等）并删除了 `./types` 子路径。**dsh-mesh 不 import 这些** —— 它只依赖 Node 内置模块和自己的相对模块，因此不受影响。若你要在本插件里加功能，请保持这条约束。

## 排错

| 现象 | 原因 | 处理 |
|---|---|---|
| 日志没有 `dsh-mesh ready` | 插件未进 bundles，或 `inject: ["tools"]` 的服务缺失（Cordis 会静默跳过 apply） | 设 `MESH_DEBUG_FILE=<某个文件>` 再启动：零写入 = 包没进组合；有 `apply:enter` 后接 `teardown:begin` = 插件被立刻卸载（不正常） |
| 日志有 `ready` 但端口连不上 | 插件被卸载，或端口被别的实例占用 | 先看 `MESH_DEBUG_FILE` 里有没有 `teardown:begin`；再 `Get-NetTCPConnection -LocalPort 8765` 确认占用者 |
| peer 一直 `[offline]` + `lastError: NOT_PAIRED` | 一端没有配对 | 用 `mesh_pair` 双向确认 |
| `lastError: CERT_UNPINNED` / `CERT_MISMATCH` | `wss://` 但指纹没配或配错 | 见上面 TLS 一节 |
| `lastError: UNEXPECTED_PEER` | 这条 link 连到了另一个设备 id | 检查 `peers[].url` 是否指向了别的设备 |
| 端口已有进程占用 | 另一个 DSH 实例在跑 | 改 `server.port` 或关掉旧实例 |
| 手机连不上但 PC 本地能连 | FRP 隧道没映射 TCP 或端口不对 | 见 [frp-tunnel.md](frp-tunnel.md) |
