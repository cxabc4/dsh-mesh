# 手机安装与连接这台电脑

这是一份从零开始的完整操作单。按顺序做，每一步都给了**怎么确认它成功了**。

前提：这台 PC 上的插件后端**已经在跑**（`127.0.0.1:8317`，樱花 `codex_private_chat` 隧道映射到 `<你的隧道域名>:<公网端口>`）。下面 PC 侧的部分只要核对，不需要重做。

---

## 0. 先核对 PC 这一侧（1 分钟）

在 PC 的 DSH 会话里直接问 Agent：

```text
运行 mesh_status
```

应该看到：

```text
This device: PC — `<PC-device-id>` on win32/x64, Node v24.21.0
Listener: ws://127.0.0.1:8317 (path /dsh-mesh)
```

- **`deviceId` 记下来**：`<PC-device-id>`。手机配对时要用它。如果你这台机器的 id 与这里不同（重装插件会生成新身份），以你实际看到的为准。
- **端口必须是 8317**。如果显示 8765，说明配置被改回去了，手机连不上（隧道映射的是 8317）。

再确认隧道在线：

```powershell
# PC 上执行
Get-NetTCPConnection -LocalPort 8317 -State Listen
```

有输出（`127.0.0.1:8317`）就说明插件在听。隧道本身在樱花客户端里跑着，不用管。

---

## 1. 手机装插件

### 1.1 打开 DSH Go 的终端

DSH Go 的 App 里进「设置」或终端页，拿到 rootfs 的 shell（不是手机系统的 shell）。确认环境：

```bash
node --version      # 应为 v24.x
dsh --version       # 应能输出版本；没有这个命令就走 1.3
```

### 1.2 安装（推荐）

```bash
dsh plugin --profile desktop add "git+https://github.com/cxabc4/dsh-mesh.git#v0.1.1"
```

等它跑完。成功的话最后几行会是：

```
+ dsh-mesh 0.1.0
Done in ... using pnpm ...
```

> 末尾的 `#v0.1.1` 是版本钉子，不要去掉。去掉就变成跟踪仓库 `main` 的最新提交，以后重装会悄悄换版本。

### 1.3 如果 `dsh` 命令不存在

用 rootfs 自带的 pnpm 直连（版本 11.28.5）：

```bash
node "$DSH_HOME/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.mjs" \
  --dir "$DSH_HOME/profiles/desktop" \
  add "git+https://github.com/cxabc4/dsh-mesh.git#v0.1.1"
```

> 路径若不对，用 `find / -name pnpm.mjs -path '*dependencies*' 2>/dev/null` 找一下。

装完还要**手工**把包名加进 profile 清单，否则不会被加载。编辑 `$DSH_HOME/profiles/desktop/package.json`，在 `dsh.profile.bundles` 数组末尾加一项：

```json
"dsh-mesh"
```

保存后该数组应该长这样：

```json
"bundles": [
  "@deepseek-ai/dsh-base",
  "...其它...",
  "dsh-mesh"
]
```

### 1.4 确认装上了

```bash
ls "$DSH_HOME/profiles/desktop/node_modules/dsh-mesh/lib/index.js"
```

能看到文件就说明装好了。这个文件是随仓库提交的编译产物，手机端不需要任何构建步骤。

### 1.5 重启 DSH Go

装完插件必须重启 App（DSH Go 没有桌面版那种热加载）。重启后新会话里应该出现 `mesh_*` 工具。

**怎么确认**：开一个新对话，问：

```text
运行 mesh_status
```

能看到 `This device: ...` 的输出，就说明插件加载成功。如果报「没有这个工具」，看文末排错。

---

## 2. 手机配置

改 `$DSH_HOME/profiles/desktop/cordis.patch.yml`（文件已存在，在末尾追加一段）：

```yaml
- id: dsh-mesh
  name: dsh-mesh
  config:
    device:
      name: "Phone"

    server:
      # 手机也监听，但只绑回环。公网连不进来，不需要暴露。
      enabled: true
      host: 127.0.0.1
      port: 8765
      tls:
        enabled: false
        # 关键：这台 PC 的隧道由樱花终止 TLS，证书是樱花的公信证书，
        # 没有你能固定的指纹 —— 所以用系统信任库校验，而不是指纹固定。
        certificatePolicy: system

    peers:
      - alias: pc
        # 必须 wss:// 不是 ws://；端口 46999 不是 29762；路径 /dsh-mesh
        url: wss://<你的隧道域名>:<公网端口>/dsh-mesh
        autoConnect: true

    permissions:
      # 手机允许这台 PC 访问哪些目录。按需最小化，先只给一个测试目录。
      allowedRoots:
        - "/storage/emulated/0/Download/dsh-mesh-workspace"
      allowWrite: true
      allowExec: true
      allowDelegate: true
```

建那个共享目录：

```bash
mkdir -p /storage/emulated/0/Download/dsh-mesh-workspace
```

保存后**再重启一次 DSH Go**，让配置生效。

### 三个容易填错的地方

| 位置 | 对 | 错 | 错了会怎样 |
|---|---|---|---|
| 协议 | `wss://` | `ws://` | 樱花节点回 `501 Not Implemented`，永远连不上 |
| 端口 | `46999` | `29762` | 29762 是另一条隧道，那条指向 6201，不是插件 |
| 路径 | `/dsh-mesh` | `/` 或其它 | 插件只服务这一个路径，其它一律 404 |

为什么必须 `wss://`：这条隧道开了 `auto_https = auto`，樱花节点在前面**终止 TLS**，把明文转给 PC。明文 HTTP 到节点那里会被它当成普通 HTTP 请求，WebSocket 升级不成立，所以只能走 TLS。

---

## 3. 配对（人工一次）

配对是双向确认，需要两个人眼可见的信息：**两边的 device id** 和**一行配对字符串**。

### 3.1 手机先拿自己的 device id

手机 DSH 里：

```text
运行 mesh_status
```

输出第一行里 `` `xxxxxx-xxxxxx-xxxxxx-xxxxxx` `` 就是手机的 device id。**整个复制下来**。

### 3.2 PC 生成配对字符串

PC DSH 里：

```text
mesh_pair action=create device="<手机的 device id>"
```

输出会是这样（示例，你的值不同）：

```
pairing code XXXXX-YYYYY for <手机 id>

Give this line to the other device (mesh_pair action=accept):
<PC-device-id>|XXXXX-YYYYY|<base64 secret>

Paste the pairingString into `mesh_pair` on the other device (action: accept), ...
```

**把中间那一整行**（`PC 的 id | code | secret`）复制出来，通过手机能看到的方式发过去（微信传文件、直接手输、扫码都行）。这一行包含密钥，别发到公开的地方。

### 3.3 手机接受配对

手机 DSH 里：

```text
mesh_pair action="accept" pairingString="<PC-device-id>|XXXXX-YYYYY|<base64 secret>" alias="pc"
```

两边都成功的话，手机 `mesh_pair action="list"` 会显示一条 pairing，PC 侧的 `mesh_status` 的 `Pairings:` 里会出现你的手机 id。

> 顺序不能反：`create` 需要知道对方的 device id，所以必须**手机先出自己的 id**，PC 再造配对字符串。

---

## 4. 建立连接

手机 DSH 里：

```text
mesh_connect device="pc"
```

然后：

```text
mesh_status
```

手机端应该看到 `pc [online]`。同时 **PC 端** `mesh_status` 应该出现一条 `outbound: false` 的 link——`false` 表示连接是手机拨进来的。

如果手机端状态是 `[offline]`，看 `lastError`：

| lastError | 含义 | 怎么办 |
|---|---|---|
| `CERT_UNTRUSTED` / `CERT_UNPINNED` | 手机端没设 `certificatePolicy: system` | 回去改配置，重启 App |
| `NOT_PAIRED` | 配对没做或做在 PC 那侧 | 重做第 3 步，注意 `create` 在 PC、`accept` 在手机 |
| `CONNECT_FAILED` / `TIMEOUT` | 隧道断了或地址不对 | PC 侧确认 8317 在听；樱花客户端里确认隧道在线 |
| `HANDSHAKE_TIMEOUT` | 通了但对方没应答 | 检查 PC 插件是否真的在跑（`mesh_status`） |

---

## 5. 连通后先跑这几条验证

在 PC 的 DSH 里：

```text
mesh_capabilities device="phone"
```

应该列出手机允许你做的事、授权目录。然后：

```text
mesh_exec device="phone" command="uname -a"
```

应该返回手机的 `Linux ... aarch64`。这条通了，说明**PC 真的在手机环境里执行了命令**，不是模拟。

反向验证（手机 DSH 里）：

```text
mesh_exec device="pc" command="git --version"
```

再试委托：

```text
mesh_delegate device="phone" task="报告一下 /storage/emulated/0/Download 目录里有哪些文件，以及手机当前剩余存储空间" label="手机环境体检"
```

拿到 task id 后：

```text
mesh_task_result taskId="<上一步返回的 id>"
```

这条返回的是**手机上那台 DSH Agent 自己的判断和工具调用结果**，不是 PC 代它查的。

---

## 6. 打开 PC 的文件权限（可选）

现在 PC 的 `allowedRoots` 是空数组——手机可以连、可以委托任务，但**读写不了 PC 上的任何文件**。

要让手机能读 PC 的某个目录，在 PC 上改
`C:\Users\24811\.dsh\profiles\desktop\cordis.patch.yml` 的 dsh-mesh 段：

```yaml
    permissions:
      allowedRoots:
        - "D:\\Projects\\demo"        # 换成你要共享的目录
```

改完 DSH 会热重载，不用重启。然后手机侧：

```text
mesh_read device="pc" path="D:\\Projects\\demo\\README.md"
```

> 注意目录写成 Windows 形式、双反斜杠（YAML 里 `\` 要转义）。手机侧不要写 `/storage/...` 给 PC——路径由目标设备自己解析，插件从不翻译。

---

## 7. 常驻与重连

- **不用做任何操作**维持连接：心跳 20 秒一次，断了自动重连（退避 1s → 30s）。
- **App 切后台**：DSH Go 用前台服务 + 部分唤醒锁，进程通常还活着。极端省电模式可能冻结它，冻住后连接会断，回到前台自动恢复。
- **Wi-Fi / 流量切换**：连接会断，几十秒内自动重连。
- **手机重启**：身份和配对存在 `$DSH_HOME/dsh-mesh`，不会丢，重启后自动重连。
- **PC 重启**：手机侧会自动重连；PC 的插件要在 DSH 启动后才起来，所以顺序是「先开 PC 的 DSH，再等手机连上」。

### 「自启动」到底意味着什么

插件本身**不需要**单独设置自启动：它是 profile 的一个 bundle 行，DSH 一启动就会加载它，随即监听配置里的端口。所以「插件随 DSH 启动」这件事是自动成立的，没有任何开关。

不成立的是另一层——**DSH 不会随 Windows 开机启动**。默认情况下：

1. 开机后樱花 FRP 客户端会自己起来（它在启动文件夹里），隧道立刻映射到本机端口；
2. 但 DSH 没起，端口后面没有服务，隧道转发过来的连接被拒绝；
3. 手机侧会一直按退避重连（最长 30 秒一次），直到有人手动打开 DSH。

打开 DSH 后大约 4 秒内插件开始监听，手机在下一次重试时就连上了，**不需要在手机上做任何操作**。

想让「开机就能连」，把 DSH 也加进开机启动项（这一步会改系统启动项，按需自行决定）：

```powershell
$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut("$([Environment]::GetFolderPath('Startup'))\DeepSeek Harness.lnk")
$lnk.TargetPath = 'D:\DSH\DeepSeek Harness.exe'   # 换成你的实际路径
$lnk.WorkingDirectory = 'D:\DSH'
$lnk.Save()
```

插件自己**不可能**拉起 DSH：它跑在 DSH 进程内部。DSH 退出后插件随之消失，做不了任何事。

### 设置页什么时候出现

插件从 `v0.2.0` 起带一个浏览器半，会在 **设置 → 远程连接** 注册一页。这一页需要**重启一次 DSH** 才会出现：DSH 会把「这个包没有浏览器半」的判定按包名缓存到进程结束，所以第一次加上它必须重启。之后再改这个页面的代码就可以热更新。

重启后打开设置，左边导航末尾应该多出一项「远程连接」。

---

## 8. 排错

### 手机上工具没出现

```bash
ls "$DSH_HOME/profiles/desktop/node_modules/dsh-mesh/lib/index.js"
grep -n "dsh-mesh" "$DSH_HOME/profiles/desktop/package.json"
```

两处都要有。缺第二处就是没加进 `dsh.profile.bundles`。

还是不行就开追踪，重启 App 后看那个文件：

```bash
MESH_DEBUG_FILE=/tmp/mesh.log dsh web ...
```

`/tmp/mesh.log` 里应该有 `apply:enter` → `apply:ready` 这几行。**只有 `apply:enter` 没到 `apply:ready`**，说明 `apply` 中途抛了；**完全没有写入**，说明包根本没被加载（bundles 没写对）。
如果出现 `teardown:begin` 紧接着 `apply:ready`，那是插件被立刻卸载了——不该发生，把日志发我。

### 连接一直 offline

在 PC 上从外部验一次隧道（这一步很关键，它把"隧道问题"和"插件问题"分开）：

```powershell
# PC 上跑，走公网地址
node -e "fetch('https://<你的隧道域名>:<公网端口>/dsh-mesh').then(r=>console.log('HTTP',r.status)).catch(e=>console.log('ERR',e.message))"
```

- 报 `ERR` 或超时 → **隧道问题**：樱花开着吗？`codex_private_chat` 那条隧道在线吗？PC 的 8317 在听吗？
- 返回 `HTTP 400` → **隧道是通的**，问题在插件或配对（400 是插件对非 WebSocket 请求的正确回应）

### 连上了但读不了文件

```
OUTSIDE_ROOTS: path "..." is outside every allowed root
```

这是目标设备的授权目录限制，不是 bug。去改**那台设备**的 `allowedRoots`。

---

## 9. 一句话版本

```bash
# 手机：装 + 配置 + 配对 + 连
dsh plugin --profile desktop add "git+https://github.com/cxabc4/dsh-mesh.git#v0.1.1"
# 改 cordis.patch.yml：certificatePolicy: system + url wss://<你的隧道域名>:<公网端口>/dsh-mesh
# 重启 App → mesh_status 拿手机 id → PC 上 mesh_pair create → 手机 mesh_pair accept → mesh_connect
```
