# 实现笔记：踩过的坑与判断依据

记录开发过程中真实遇到的失败，以及每个决定的依据。留给下一个人（或下一个 Agent）少走弯路。

## 1. asar 归档的读取

DSH 桌面版把整个运行时打进安装目录下的 `resources\app.asar`。`read` 工具能读单个文件，但 `pwsh`/`glob`/`grep`（ripgrep 是原生进程）全部报「路径不存在」。

解决办法是自己写一个 asar 解析器（`scripts/asar-extract.mjs`）。**关键细节**：Electron 用的是 Chromium 的 Pickle 编码，布局是

```
bytes 0..7    [uint32 = 4][uint32 headerBufSize]
bytes 8..     headerBuf（长度 = headerBufSize）
              其中 [0..3] = uint32 payloadSize, [4..7] = uint32 jsonLen, [8..] = JSON
文件数据起点 = 8 + headerBufSize（4 字节对齐）
```

第一次写错成 `[0..3]=4, [4..7]=jsonLen`、数据从 `8+jsonLen` 开始，解析出来的是乱码。修改后的版本一次成功。

## 2. Node 的类型剥离不能用在 node_modules 内

`node:module.stripTypeScriptTypes` 可以对任意字符串做剥离，但 **Node 拒绝在 `node_modules` 里自动剥离 `.ts`**（`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`）。因为插件最终要被装进 profile 的 `node_modules`，所以必须有 `src/*.ts → lib/*.js` 的构建步骤。

剥离模式还有语法限制：不支持 enum、namespace、**构造函数的参数属性**（`constructor(private x: string)`）。第一次试写参数属性直接报 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`。本项目的源码全部使用可剥离语法，`scripts/build.mjs` 遇到不可剥离的语法会直接失败而不是产出半成品。

## 3. WebSocket 帧的扩展长度写错了位置

`#writeFrame` 最初写成：

```js
const header = [];
header.push(Buffer.from([first, 0x80 | 126, 0, 0]));
header[1].writeUInt16BE(length, 2);   // ← 这里
```

`header[1]` 是**第二个数组元素**（那时还不存在），不是刚才 push 进去的那个 Buffer。payload ≥ 126 字节时抛 `Cannot read properties of undefined (reading 'writeUInt16BE')`。

这个 bug 只在 hello 帧较长时触发——手写的 hello 因为字段少，短于 126 字节，所以底层探针（`debug-ws.mjs`）能过，而**拼接了 capabilities 列表的完整 hello 一定超 126 字节**，于是所有真实握手都失败。教训：扩展长度必须写进同一个 header buffer。

## 4. 拨号方会错过对端的第一帧

对端在 WebSocket 升级完成后**立刻**发 hello。拨号方拿到连接对象后还要走几步才挂 `onMessage`，这段窗口里到达的帧会丢掉——表现是链路永远停在 `handshaking` 然后超时。

修法：`WsConnection` 在没有任何监听者时把消息放进 `#inbox`，`onMessage()` 注册时**同步回放**。这个回放是同步的，又引出下一个坑。

## 5. `performHandshake` 里的 TDZ

因为上面的同步回放，`onMessage(handler)` 可能**在它返回之前**就调用了 handler。原来的写法：

```js
const unsubscribe = connection.onMessage(...)   // 回放可能在这里就 settle
```

`finish()` 里调用 `unsubscribe()`，而 `const unsubscribe` 还在 TDZ → `Cannot access 'unsubscribe' before initialization`。

修法：改用 `let stop = () => {}` 先声明，`onMessage` 返回后再赋值，并在回放导致已 settle 的情况下立刻 `stop()`。

## 6. `register()` 在重连时必须幂等

`RpcPeer.register` 原本在重复注册时抛 `DUPLICATE_HANDLER`。但同一条 link 的手握可能被触发两次（`onLinkReady` 与 `adopt` 各一次），第二次注册直接让整个 handler 表安装失败，链路可用性取决于谁先跑。

修法：**后写覆盖**，返回的 disposer 恢复前一个 handler。这符合实际语义：一条 link 跨越多轮握手，方法表应当总是最新的一份。

## 7. 测试挂住而不是失败

`node --test` 有两条会让人以为"代码没问题"的陷阱：

- **断言失败时如果没走到 `finally` 里的 teardown，监听端口会把进程留住**，runner 永远不结束。第一次的 e2e 就是这样：一个断言失败 → 后面的 `dispose` 没执行 → 进程挂死 → 看起来像"测试在跑"。
- 更隐蔽的一次：测试里 `bringUpPair()` 返回 `{a, b}` 但只解构了 `{a}`，`finally` 里 `b.manager.dispose()` 引用未定义变量抛错，`disposers` 没清干净。断言全过、输出全是 ✔，进程却不退出。

修法两条：`scripts/run-tests.mjs` 给每个测试文件加 watchdog（超时即失败并打印输出），以及所有测试统一用 `try/finally` 解构完整。

## 8. `node --test` 的输出是计数格式，不是 TAP

`# tests 4` 这种 TAP 行并不存在；实际输出是 `ℹ tests 4` / `ℹ pass 4`。第一版摘要解析全部返回 `?`，虽然"PASS"判定是对的（靠退出码），但摘要没用。按真实格式重写了解析，并同时匹配 `ℹ` 与 `#`。

## 9. DSH 的三条硬约束（源码核实，不是猜测）

| 约束 | 证据 | 对本项目的影响 |
|---|---|---|
| `startActivation.request.parent` 必须是注册表里那个 Agent **对象本身** | `dsh-subagent/lib/index.js:3045` | `mesh_delegate` 通过 `ctx.agents.currentInitiator()` 拿 parent，而不是自己造一个 `{id}` |
| 未实现 `prepareContinuable` → 走 external 分支；实现了 → 永远走 local | `dsh-subagent/lib/index.js:3047` | `MeshSubagentProvider` 故意只实现 `start` |
| 驱动 `depthLimit:false` 的 provider 时，`tool-subagent` 必须配 `maxDepth:'provider-managed'` | `dsh-tool-subagent/lib/index.js:364` | 已写进安装文档；这是 DSH 既有行为 |
| external 的 `result` 一旦 reject 会挂住父级 teardown | `dsh-subagent/lib/index.js:1991-1997`（`finishDisposal` 会 `await run.result`）| provider 所有失败路径都 resolve 成 `stopReason:"error"` |
| `start()` 返回后，调用方的 abort 信号不再转发给 provider | `dsh-subagent/lib/index.js:1790-1792` | 取消走 `interrupt()`/`dispose()`，provider 自己持有 `AbortController` |

## 10. 版本落差

桌面 `0.2.1-rc.5`，手机端 DSH Go 内嵌 `0.2.2-rc.1`。核对结论：

- `ctx.subagents`、`ctx.agents`、`ctx.effect`、`schemastery` 跨版本无破坏性变化；
- `dsh-tools` 在 rc.1 移除了 10 个根导出并删除 `./types` 子路径；
- cordis 4.1.0 把 `LoggerLevel` 的 INFO/WARN 数值互换。

因此本插件的**硬约束是：不 import 任何 `@deepseek-ai/*` 包**。全部只用 Node 内置模块 + 相对路径。这条约束不是洁癖，是同源码两端可加载的前提，也是 profile `node_modules` 里只有它自己时仍能跑的前提。

## 11. 失败的调查分支（避免重复投入）

- **ACP over stdio** 与 **SDK JSON-RPC over stdio** 都被否掉：它们要求本地 `spawn` 子进程，跨设备时那个进程在另一台机器上。两个包的 README 都明确写了"仅本地工作区 / 需要独立后端"。
- `dsh-subagent-dsh-sdk` / `dsh-subagent-acp` 这两个包在桌面版里**没有安装**，源码里也不存在（在 GitHub 上有，但不在发布的运行时里）。
- `ctx.webServer.registerUpgrade()` 确实可以让插件挂自己的 WebSocket 路由，但它是 Host 的内部机制、会与 DSH 自己的 `/api` 路由共享端口；dsh-mesh 选择自己监听一个端口（8765），这样隧道配置与权限边界都更清楚。

## 12. `ctx.effect` 的真实语义（最严重的一个坑）

Cordis 的 `ctx.effect(callback)` **立即执行 callback**，并把 callback 的**返回值**登记为 disposer（`Fiber._execute`：返回函数就 `collect`，返回 Promise 就 `await` 后 collect 它的结果）。

最初写成：

```js
ctx.effect(async () => {
  await runner.dispose();
  await manager.dispose();
});
```

这等于**在 apply 期间立刻执行 teardown**：监听器在 `apply:manager-started` 之后 1 毫秒就被关掉，然后在 `apply:ready` 打日志。从外部看，插件"加载成功"、工具注册齐全、`dump-config` 里也有这一行，但端口上永远连不上——和"插件根本没加载"的表现一模一样。

发现方式：给 `apply` 加了可选的 `MESH_DEBUG_FILE` 文件追踪，才看到 `teardown:begin` 出现在 `apply:ready` **之前**。没有这个追踪，症状会指向"Loader 没加载插件"，方向完全错。

正确写法是 `ctx.effect(() => () => { ... })`（或 generator 形式 yield disposers）。修复后 `MESH_DEBUG_FILE` 里只剩 `apply:enter → config → before-manager-start → manager-started → ready`，且真实 DSH profile 启动后 `127.0.0.1:8765` 持续可连。

回归测试：`tests/smoke.test.mjs` 的 stub `ctx.effect` 现在**模拟真实语义**（执行 callback、收集返回值），并在 apply 返回后真的去连一次监听端口。如果以后有人再把 teardown 体直接传给 `ctx.effect`，这条测试会失败而不是"通过但端口不通"。

同类注意：`tests/smoke.test.mjs` 里的 stub 必须与真实 Cordis 语义一致，否则测试会**帮你确认 bug 不存在**。

## 13. 未解决的已知缺陷

- 命令超时只杀直接子进程，孙进程不保证清理。
- 文件传输无断点续传，失败要整文件重来。
- 没有前向保密（会话密钥由静态配对密钥派生）。
- `scripts/probe-real-composition.mjs` 需要先停掉本机监听 8765 的实例；端口被占时它的结果不可信（脚本没有做占用检测）。
- 早期版本允许 `mesh_exec` 直接调用 `.bat` / `.cmd`（已修复：按后缀拒绝并返回 `SCRIPT_NOT_ALLOWED`，见 `docs/guides/limits.md`）。
