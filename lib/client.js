// Browser half of dsh-mesh: the "远程连接" settings page.
//
// This file is NOT compiled from TypeScript. The Host loads it verbatim as a classic
// script through its own module loader, so it has to be a single self-contained file
// written in plain JavaScript. It must not import anything: the loader hands it
// `require`, which resolves only the modules the page is seeded with (`react` here).
//
// Loaded shape (see `@deepseek-ai/dsh-client-modules` and any shipped UI plugin):
//   window.__ModuleLoader__.load({ id: "<package name>", factory: (require) => ({...}) })
//
// What it shows: this device's identity and listener, the peers it can see with why a
// link is down, the pairing flow in both directions, and the addresses to paste into
// the other device. Actions go through one Host route (`dsh-mesh/settings`), defined
// in src/peer/settings-route.ts. The page never writes config: it lists what the
// operator must put in `cordis.patch.yml`, because a page that silently rewrites a
// profile is worse than one that tells you what to write.

window.__ModuleLoader__.load({
  id: "dsh-mesh",
  factory(require) {
    const React = require("react");
    const h = React.createElement;

    /** Host route. Must match SETTINGS_METHOD in src/peer/settings-route.ts. */
    const METHOD = "dsh-mesh/settings";

    // ---- styles ---------------------------------------------------------------
    // One injected sheet, removed by the returned disposer. Colours come from the
    // host's own aliases so light/dark and future themes follow without a second rule.
    const CSS = `
.mesh-page{max-width:860px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:18px}
.mesh-head{display:flex;flex-direction:column;gap:6px}
.mesh-title{margin:0;font-size:18px;font-weight:600}
.mesh-sub{margin:0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}
.mesh-card{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:14px 16px;display:flex;flex-direction:column;gap:10px;background:var(--dsw-alias-bg-layer-2)}
.mesh-card h3{margin:0;font-size:14px;font-weight:600}
.mesh-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.mesh-kv{display:grid;grid-template-columns:150px 1fr;gap:4px 12px;font-size:13px;line-height:22px}
.mesh-kv dt{color:var(--dsw-alias-label-tertiary)}
.mesh-kv dd{margin:0;word-break:break-all}
.mesh-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px}
.mesh-badge{display:inline-flex;align-items:center;gap:5px;padding:1px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);font-size:12px;line-height:18px}
.mesh-on{color:#12a37a;border-color:#12a37a55}
.mesh-off{color:#8a8f98}
.mesh-bad{color:#d5534a;border-color:#d5534a55}
.mesh-btn{font:inherit;font-size:13px;line-height:20px;padding:5px 12px;border-radius:8px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.mesh-btn:hover{border-color:var(--dsw-alias-label-tertiary)}
.mesh-btn[disabled]{opacity:.55;cursor:not-allowed}
.mesh-primary{background:var(--dsw-alias-state-business-primary,#2e7cf6);border-color:transparent;color:#fff}
.mesh-input{font:inherit;font-size:13px;line-height:20px;padding:5px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary);min-width:0;flex:1}
.mesh-code{display:block;white-space:pre-wrap;word-break:break-all;padding:8px 10px;border-radius:8px;border:1px dashed var(--dsw-alias-border-l2);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;line-height:18px;background:var(--dsw-alias-bg-layer-1,transparent)}
.mesh-alert{color:#d5534a;font-size:13px;line-height:20px;margin:0}
.mesh-ok{color:#12a37a;font-size:13px;line-height:20px;margin:0}
.mesh-list{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none}
.mesh-item{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:4px}
.mesh-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;margin:0}
`;

    function styleTag(h) {
      // A React element rather than a DOM write: unmounting the page removes the sheet.
      return h("style", { key: "mesh-style" }, CSS);
    }

    // ---- helpers -------------------------------------------------------------
    function formatTime(value) {
      if (typeof value !== "number" || !Number.isFinite(value)) return "—";
      try {
        return new Date(value).toLocaleString();
      } catch {
        return String(value);
      }
    }

    function badge(state) {
      const label = state === "online" ? "在线" : state === "failed" ? "永久失败" : state === "connecting" || state === "handshaking" ? "连接中" : "离线";
      const cls = state === "online" ? "mesh-badge mesh-on" : state === "failed" ? "mesh-badge mesh-bad" : "mesh-badge mesh-off";
      return h("span", { className: cls }, label);
    }

    /** Copy to clipboard, falling back to selection so it still works on http origins. */
    async function copyText(value) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(value);
          return true;
        }
      } catch {
        /* fall through to the manual path */
      }
      return false;
    }

    // ---- section -------------------------------------------------------------
    function MeshSection(props) {
      const ctx = props.ctx;
      const [state, setState] = React.useState({ phase: "loading", data: null, error: "" });
      const [busy, setBusy] = React.useState("");
      const [notice, setNotice] = React.useState("");
      const [remoteId, setRemoteId] = React.useState("");
      const [pairString, setPairString] = React.useState("");
      const [alias, setAlias] = React.useState("");
      const [peerAlias, setPeerAlias] = React.useState("");
      const [peerUrl, setPeerUrl] = React.useState("");
      const loadId = React.useRef(0);

      const call = React.useCallback(
        async (payload) => {
          const rpc = ctx && ctx.connection ? ctx.connection.rpc : undefined;
          if (!rpc || typeof rpc.call !== "function") throw new Error("宿主没有提供 RPC 通道");
          const result = await rpc.call("/api", METHOD, payload || {});
          if (!result || typeof result.ok !== "boolean") throw new Error("设置接口返回格式异常");
          if (!result.ok) throw new Error((result.error && result.error.message) || "宿主拒绝了这次请求");
          return result.value || {};
        },
        [ctx],
      );

      const refresh = React.useCallback(async () => {
        const id = ++loadId.current;
        try {
          const data = await call({ action: "read" });
          if (loadId.current !== id) return;
          setState({ phase: "ready", data, error: "" });
        } catch (error) {
          if (loadId.current !== id) return;
          setState({ phase: "error", data: null, error: error && error.message ? error.message : String(error) });
        }
      }, [call]);

      React.useEffect(() => {
        refresh();
        const timer = setInterval(refresh, 4000);
        return () => {
          clearInterval(timer);
          loadId.current++;
        };
      }, [refresh]);

      const act = async (label, payload, message) => {
        setBusy(label);
        setNotice("");
        try {
          await call(payload);
          setNotice(message || "完成");
          await refresh();
        } catch (error) {
          setNotice("失败：" + (error && error.message ? error.message : String(error)));
        } finally {
          setBusy("");
        }
      };

      if (state.phase === "error") {
        return h("div", { className: "mesh-page" }, styleTag(h),
          h("p", { className: "mesh-alert", role: "alert" }, state.error),
          h("p", { className: "mesh-hint" }, "页面读不到宿主数据。若这是 CLI profile，插件可能没有 connection 服务。"));
      }
      if (state.phase === "loading") {
        return h("div", { className: "mesh-page" }, styleTag(h), h("p", { className: "mesh-sub" }, "正在读取…"));
      }

      const data = state.data || {};
      const snap = data.snapshot || {};
      const device = snap.device || {};
      const server = snap.server || {};
      const peers = Array.isArray(snap.peers) ? snap.peers : [];
      const paired = Array.isArray(data.pairingStrings) ? data.pairingStrings : [];
      const perms = snap.permissions || {};

      return h("div", { className: "mesh-page" },
        styleTag(h),

        h("div", { className: "mesh-head" },
          h("h2", { className: "mesh-title" }, "远程连接"),
          h("p", { className: "mesh-sub" },
            "一台设备和另一台设备之间的双向通道：读写对方目录、在对方跑命令、把任务交给对方的 agent。连接由手机拨向电脑，同一根 socket 双向使用。"))

        // -- this device ---------------------------------------------------------
        , h("section", { className: "mesh-card" },
          h("h3", null, "本机"),
          h("dl", { className: "mesh-kv" },
            h("dt", null, "设备名"), h("dd", null, device.name || "—"),
            h("dt", null, "设备 ID"), h("dd", { className: "mesh-mono" }, device.deviceId || "—"),
            h("dt", null, "平台"), h("dd", null, `${device.platform || "—"} / ${device.arch || "—"} · Node ${device.node || "—"}`),
            h("dt", null, "监听"), h("dd", { className: "mesh-mono" },
              server.running
                ? `${server.url || `${server.host}:${server.port}`}（${server.secure ? "TLS" : "明文"}，路径 /dsh-mesh）`
                : server.enabled ? "已启用但未起来" : "已关闭"),
            h("dt", null, "对端授权"), h("dd", null,
              `根目录 ${perms.allowedRoots && perms.allowedRoots.length ? perms.allowedRoots.join("、") : "（无）"} · 写 ${perms.allowWrite ? "允许" : "禁止"} · 执行 ${perms.allowExec ? "允许" : "禁止"} · 委托 ${perms.allowDelegate ? "允许" : "禁止"}`))
        , h("p", { className: "mesh-hint" },
          "上面的「对端授权」决定对方能在这台机器上做什么。空根目录表示对方连上后读写不了任何文件。授权范围在 profile 的 cordis.patch.yml 里改（permissions 段），改完热重载生效。")))

        // -- peers ---------------------------------------------------------------
        , h("section", { className: "mesh-card" },
          h("h3", null, "对端"),
          peers.length === 0
            ? h("p", { className: "mesh-hint" }, "还没有对端。手机拨进来之后会出现在这里；也可以在这台机器上主动拨出去（见下方「新增对端」）。")
            : h("ul", { className: "mesh-list" }, peers.map((peer, i) =>
              h("li", { className: "mesh-item", key: (peer.alias || "peer") + i },
                h("div", { className: "mesh-row" },
                  h("strong", null, peer.alias || "(未命名)"),
                  badge(peer.state),
                  h("span", { className: "mesh-hint" }, peer.outbound ? "我方拨出" : "对方拨入"),
                  peer.roundTripMs ? h("span", { className: "mesh-hint" }, `延迟 ${peer.roundTripMs}ms`) : null),
                h("div", { className: "mesh-hint mesh-mono" },
                  [peer.url || "(入站)", peer.remoteName ? `对端名 ${peer.remoteName}` : "", peer.deviceId || ""].filter(Boolean).join(" · ")),
                peer.lastError
                  ? h("p", { className: "mesh-alert" }, `${peer.lastError.code}：${peer.lastError.message}（${formatTime(peer.lastError.at)}）`)
                  : null,
                peer.nextRetryAt ? h("p", { className: "mesh-hint" }, `下次重试 ${formatTime(peer.nextRetryAt)}`) : null,
                h("div", { className: "mesh-row" },
                  h("button", { type: "button", className: "mesh-btn", disabled: busy !== "", onClick: () => act("connect", { action: "connect", device: peer.alias }, "已发起连接") }, "连接"),
                  h("button", { type: "button", className: "mesh-btn", disabled: busy !== "", onClick: () => act("disconnect", { action: "disconnect", device: peer.alias }, "已断开") }, "断开")))
            )))

        // -- pairing -------------------------------------------------------------
        , h("section", { className: "mesh-card" },
          h("h3", null, "配对"),
          h("p", { className: "mesh-hint" },
            "配对只做一次，是双向确认：一方生成一行字符串，另一方粘贴接受。两边都完成后才能连接，连接前的任何请求都会被拒绝。"),
          h("p", { className: "mesh-hint" }, "① 对方设备先跑 mesh_status，抄下它的设备 ID；② 在这里生成配对串；③ 把整行发给对方，它在 mesh_pair 里 accept。"),
          h("div", { className: "mesh-row" },
            h("input", { className: "mesh-input", placeholder: "对方的设备 ID（xxxxxx-xxxxxx-xxxxxx-xxxxxx）", value: remoteId, onChange: (e) => setRemoteId(e.target.value) }),
            h("button", { type: "button", className: "mesh-btn mesh-primary", disabled: busy !== "" || remoteId.trim() === "", onClick: () => act("pair/create", { action: "pair/create", device: remoteId }, "已生成配对串，见下方列表") }, "生成配对串")),
          h("p", { className: "mesh-hint" }, "或接受对方生成的配对串（这一条是在这台机器上执行的最后一步）："),
          h("div", { className: "mesh-row" },
            h("input", { className: "mesh-input mesh-mono", placeholder: "<对方设备ID>|<配对码>|<base64 密钥>", value: pairString, onChange: (e) => setPairString(e.target.value) }),
            h("input", { className: "mesh-input", style: { maxWidth: 120 }, placeholder: "别名(可选)", value: alias, onChange: (e) => setAlias(e.target.value) }),
            h("button", { type: "button", className: "mesh-btn", disabled: busy !== "" || pairString.trim() === "", onClick: () => act("pair/accept", { action: "pair/accept", pairingString: pairString, alias }, "已接受配对") }, "接受")),
          paired.length === 0
            ? h("p", { className: "mesh-hint" }, "还没有已完成的配对。")
            : h("ul", { className: "mesh-list" }, paired.map((entry) =>
              h("li", { className: "mesh-item", key: entry.deviceId },
                h("div", { className: "mesh-row" },
                  h("strong", { className: "mesh-mono" }, entry.deviceId),
                  h("span", { className: "mesh-hint" }, `配对码 ${entry.code} · ${formatTime(entry.createdAt)}`)),
                entry.pairingString
                  ? h("code", { className: "mesh-code" }, entry.pairingString)
                  : h("p", { className: "mesh-hint" }, "这个配对是对方发起的，本机没有对应的密钥串。"),
                h("div", { className: "mesh-row" },
                  entry.pairingString
                    ? h("button", { type: "button", className: "mesh-btn", onClick: async () => { const ok = await copyText(entry.pairingString); setNotice(ok ? "已复制到剪贴板" : "复制失败，请手动选中"); } }, "复制")
                    : null,
                  h("button", { type: "button", className: "mesh-btn", disabled: busy !== "", onClick: () => act("pair/remove", { action: "pair/remove", deviceId: entry.deviceId }, "已删除配对") }, "删除")))))

        // -- add a peer ----------------------------------------------------------
        , h("section", { className: "mesh-card" },
          h("h3", null, "新增对端（可选）"),
          h("p", { className: "mesh-hint" },
            "默认拓扑是手机拨向电脑，电脑不需要配任何对端。只有当你希望这台机器主动去连别人（同一局域网内、或对端也开了公网入口）时才需要填。"),
          h("div", { className: "mesh-row" },
            h("input", { className: "mesh-input", style: { maxWidth: 140 }, placeholder: "别名，如 phone", value: peerAlias, onChange: (e) => setPeerAlias(e.target.value) }),
            h("input", { className: "mesh-input", placeholder: "ws:// 或 wss:// 地址，末尾 /dsh-mesh", value: peerUrl, onChange: (e) => setPeerUrl(e.target.value) }),
            h("button", { type: "button", className: "mesh-btn", disabled: busy !== "" || peerUrl.trim() === "", onClick: () => act("peer/add", { action: "peer/add", alias: peerAlias || peerUrl, url: peerUrl }, "已新增对端（仅本次运行内有效）") }, "新增")),
          h("p", { className: "mesh-hint" },
            "注意：这里新增的对端只活在当前进程里。要让它下次启动也在，请写进 profile 的 cordis.patch.yml（peers 段）——这一页故意不替你改配置文件。"))

        // -- how to use ----------------------------------------------------------
        , h("section", { className: "mesh-card" },
          h("h3", null, "怎么用"),
          h("p", { className: "mesh-hint" }, "两端配对且 online 之后，在对话里让 agent 直接调这些工具："),
          h("dl", { className: "mesh-kv" },
            h("dt", { className: "mesh-mono" }, "mesh_status"), h("dd", null, "本机身份、监听、对端、配对、授权一览"),
            h("dt", { className: "mesh-mono" }, "mesh_read / mesh_write / mesh_list"), h("dd", null, "读写对端文件，路径用对端自己的写法（不要翻译路径）"),
            h("dt", { className: "mesh-mono" }, "mesh_exec"), h("dd", null, "在对端执行命令，返回真实退出码与输出"),
            h("dt", { className: "mesh-mono" }, "mesh_logs"), h("dd", null, "按字节偏移跟读对端的日志文件"),
            h("dt", { className: "mesh-mono" }, "mesh_transfer"), h("dd", null, "单文件双向搬运，按 sha256 校验"),
            h("dt", { className: "mesh-mono" }, "mesh_delegate"), h("dd", null, "把任务交给对端自己的 DSH agent，它用自己的工具和判断去做"),
            h("dt", { className: "mesh-mono" }, "mesh_task_*"), h("dd", null, "查询委托任务的进度、结果与日志")),
          h("p", { className: "mesh-hint" },
            "什么时候用委托而不是远端调用：需要对方「看一眼再决定」时用 mesh_delegate（对端的 agent 会用它的相机、传感器、本地会话）；只是拿数据或跑命令时用 mesh_read / mesh_exec，更省。"))

        // -- addresses -----------------------------------------------------------
        , h("section", { className: "mesh-card" },
          h("h3", null, "对方该填什么"),
          h("p", { className: "mesh-hint" }, "对方设备（手机）的配置里，指向这台机器的地址长这样："),
          h("code", { className: "mesh-code" },
            (server.url && server.host === "127.0.0.1"
              ? "隧道公网地址:端口/dsh-mesh"
              : (server.url || "ws://127.0.0.1:8765") + "/dsh-mesh") +
            "\n" +
            (server.secure
              ? "tls.certificatePolicy: system   # 若隧道由服务商终止 TLS"
              : "（裸 TCP 隧道时用 ws://，不需要 TLS 设置）")),
          h("p", { className: "mesh-hint" },
            "本机只绑回环，所以对方必须通过隧道进来。隧道把公网端口映射到本机 " + (server.port || 8765) + "。"))

        // -- notice --------------------------------------------------------------
        , notice
          ? h("p", { className: notice.startsWith("失败") ? "mesh-alert" : "mesh-ok", role: "status" }, notice)
          : null,

        h("p", { className: "mesh-hint" },
          "本页只读宿主状态、只做配对与临时连接；不会改写你的 profile 配置。改配置请编辑 profile 的 cordis.patch.yml。"));
    }

    // ---- plugin --------------------------------------------------------------
    function apply(ctx) {
      if (!ctx || !ctx.slots || typeof ctx.slots.inject !== "function") return;
      // `inject` (below) guarantees the slot service; the guard keeps a stripped
      // composition from losing every other registration to one throw.
      try {
        ctx.slots.inject("settings.section", () =>
          ctx.slots.register(
            {
              name: "settings.section",
              id: "mesh",
              order: 40,
              label: "远程连接",
            },
            (props) => h(MeshSection, Object.assign({}, props, { ctx })),
          ),
        );
      } catch (error) {
        // A settings page that cannot mount must not take the plugin down.
        if (typeof console !== "undefined" && console.warn) console.warn("[dsh-mesh] settings page unavailable:", error);
      }
    }

    return { apply, inject: ["slots", "connection"] };
  },
});
