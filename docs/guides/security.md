# 认证与权限

这份文档说明：连接怎么被认证、每个动作怎么被授权、拒绝是什么样子。

## 三条独立防线

1. **设备身份**。每台设备首次启动生成一对 Ed25519 密钥，持久化在 `$DSH_HOME/dsh-mesh/identity.json`（权限 0600，Windows 走 profile 目录的 ACL）。device id 是公钥的 sha256 前 16 字节的 base32，形如 `aaaaaa-bbbbbb-cccccc-dddddd`（四组 base32，共 24 个字符加三个连字符）。**device id 不能凭空声称**——声明的 id 必须等于出示公钥的哈希。

2. **显式配对**。任何未知设备在握手阶段就被拒绝，没有 trust-on-first-use 回退。配对材料是一段 32 字节随机密钥，经人工复制的一次性字符串（`<deviceId>|<code>|<base64 secret>`）传给对方。配对码由密钥派生，所以复制不完整会立刻被发现（`CODE_MISMATCH`）。

3. **应用层加密 + 认证信封**。配对密钥 + 双方 device id 派生出 AES-256-GCM 加密密钥与 HMAC-SHA256 认证密钥。每条帧是：

   ```
   { k: "env", from, to, seq, ts, mac, body }
   ```

   `body` 是密文，`mac` 覆盖 `from/to/seq/ts/body`。因此：
   - 隧道看到的是密文；
   - 伪造帧 MAC 校验失败，链路立即断开；
   - 重放帧 `seq` 不递增，拒绝；
   - 过期帧时间窗 ±5 分钟，拒绝；
   - 换个接收设备的帧（`to` 不匹配）拒绝。

   **一条坏帧即断开**，不是跳过继续——跳过正是降级攻击能溜过去的方式。

## 握手时序

```
连接建立（WebSocket 升级完成）
   ↓
双方各自立即发 hello（明文帧，只在此时刻）：
   { from: deviceId, pk: 公钥 PEM, nonce: 随机, proof: sign(nonce), name, capabilities }
   ↓
各自验证对方：
   1. deviceId == sha256(pk) 的前缀          → 否则 IDENTITY_MISMATCH
   2. sign(nonce) 用对方 pk 验签通过          → 否则 BAD_PROOF
   3. 本地已存在针对该 deviceId 的 pairing    → 否则 NOT_PAIRED
   4. pairing 的双方正是这两台设备            → 否则 PAIRING_MISMATCH
   5. （拨出方）对方 deviceId 是本条 link 预期的 → 否则 UNEXPECTED_PEER
   ↓
派生会话密钥，之后所有帧走加密信封
```

任一步失败：本地回一帧 `hello-error { code, message }` 然后关闭 socket。拨出方看到的是**永久失败**（`failed`），不会定时重试——否则会持续向陌生设备宣告自己的公钥。

## 授权：认证 ≠ 授权

握手只证明"你是我配对过的那台设备"。每个 RPC 在**目标设备上**重新检查策略：

| 动作 | 授权检查 |
|---|---|
| `mesh.fs.list` / `stat` / `read` | 路径必须落在 `permissions.allowedRoots` 内；相对路径拒绝；`..` 与指向根外的符号链接拒绝 |
| `mesh.fs.write` / `mkdir` | 同上 + `permissions.allowWrite`；已存在文件必须带正确的 `expectedVersion` |
| `mesh.exec` | `permissions.allowExec` + 工作目录在根内 + 命令策略（denyPatterns / allowCommands / 禁止 shell 与解释器） |
| `mesh.logs.read/follow` | 路径在根内 |
| `mesh.transfer.*` | 路径在根内 + `allowWrite`（写入方向） |
| `mesh.delegate` | `permissions.allowDelegate` + 并发上限 + 超时预算 |
| `mesh.audit` | 只读，返回本机最近审计记录 |

被拒绝的动作返回稳定错误码，例如：

```
OUTSIDE_ROOTS:  path "D:\secret.txt" is outside every allowed root (allowed: D:\Projects\demo)
VERSION_REQUIRED: "…\notes.txt" already exists; pass the version you read (sha256) …
VERSION_CONFLICT: "…\notes.txt" changed since it was read: expected <a>, current <b>
SHELL_NOT_ALLOWED: interpreters and shells are not runnable on behalf of a peer (refused: bash)
DELEGATE_DISABLED: this device does not accept delegated tasks
```

## 命令执行的具体边界

`mesh_exec` 不是远程 shell：

- 命令字符串按空白/引号切成 **程序 + 参数**，`shell: false` 启动，所以 `&&`、`|`、`>`、`$(…)`、`*` **都不会生效**，无法借此链接第二条命令。
- 拒绝常见解释器与 shell（`sh/bash/zsh/…/cmd/powershell/pwsh/python/node/perl/ruby`）——否则一条 `bash -c '…'` 就绕过了所有参数级检查。
- 可按 `allowCommands` 白名单收敛到具体程序（例如只允许 `git`、`npm`）。
- `denyPatterns` 默认含 `rm -rf /`、`mkfs`、`format c:`、`shutdown`、`chmod 777 /` 等。
- 子进程环境被清洗：`DSH_*` 全部移除，形如 `*_KEY`、`TOKEN`、`PASSWORD`、`AWS_*`、`OPENAI_*`、`GITHUB_*` 的变量不继承。调用方传入的 `env` 也走同一过滤——对端不能把凭据塞进它控制的进程。

## 高风险操作仍然受目标设备自己的限制

委托任务时用的是**目标设备自己的 DSH Agent**，因此那边原有的审批、沙箱、工具限制照常生效。dsh-mesh 不提供任何"远程提权"：

- 主 Agent 的权限不会传给远端；远端 Agent 用本地权限。
- 远端 Agent 想做的事情如果本地不允许，它就会被本地机制拦住。
- 插件不修改 DSH / DSH Go 的核心代码，也不绕过它们的审批。

## 凭据保存

| 文件 | 内容 | 权限 |
|---|---|---|
| `identity.json` | Ed25519 私钥 + 公钥 + device id | 0600（POSIX）/ profile ACL（Windows）|
| `pairings.json` | 每个对端的配对码与 32 字节密钥（base64）| 0600 |
| `tasks.jsonl` | 任务账本（label、进度、产物路径）| 默认 |
| `audit.jsonl` | 对端动作审计 | 默认 |

**这些文件永不进入日志、工具结果或 `mesh_status` 输出**。`mesh_status` 只显示 device id 和配对码（code），不显示密钥本身。重新展示配对字符串需要显式调用 `mesh_pair`（`action=create`）。

`mesh_pair action=list` 只返回 device id 与 code —— 即使 Agent 被诱导调用，也拿不到密钥。

## 首次配对的操作顺序

因为配对字符串包含密钥，必须走带外通道（人眼 / 可信即时通讯），不要通过本插件自己的连接传。

```text
PC:      mesh_pair action=create device=<phone deviceId>
         → 输出 joining 字符串
人:      把那一整行发给手机
Phone:   mesh_pair action=accept pairingString="<整行>"
```

顺序不能反：手机先 `accept` 时用的 deviceId 必须正是 PC 的 id，而 `create` 时也必须填手机的 id——两边都填错任何一位都会在 `CODE_MISMATCH` 或握手阶段暴露。

## 撤销

```text
mesh_pair action=remove device=<alias 或 deviceId>
```

删除后：该对端的本地 link 立即销毁，之后它再拨入会在握手阶段被拒绝（`NOT_PAIRED`）。对端仍持有一份旧密钥，但无法再通过认证；如需彻底作废，两端都应删除。

## 审计

每个被受理或被拒绝的动作写一条 `audit.jsonl`：

```json
{"time": 1789…, "peer": "<对方 deviceId>", "action": "fs.write", "detail": "D:\\Projects\\demo\\notes.txt", "outcome": "ok"}
```

`mesh_audit` 可读最近若干条。默认保留 5000 条，超出后淘汰最旧的。

## 已知的不足

- **没有证书链验证**。TLS 用指纹固定，不是 CA 验证。指纹要在配对阶段人工确认一次（见 [install-desktop.md](install-desktop.md#tls)）。
- **配对没有 QR / SAS 校验**。v0.1 靠人工复制字符串。如果复制通道被完整窃取，配对密钥会泄露——这是为什么字符串必须带外传递。
- **没有前向保密**。会话密钥由静态配对密钥派生；配对密钥泄露意味着历史流量可解。轮换配对可以补救。
- **审计是本地的**。两端各自记录自己的那半，不汇总。跨设备的关联要靠 task id。
