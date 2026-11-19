// Browser half of dsh-mesh: the "远程连接" settings page.
//
// Not compiled from TypeScript. The Host loads it verbatim as a classic script through
// window.__ModuleLoader__, so it must be one self-contained plain-JavaScript file that
// imports nothing (the loader hands it `require`, which resolves only seeded modules).
//
// Design notes: a settings page is read more often than it is configured.
//   - Typography follows the host's own settings pages: 14px/20px labels, 12px/18px
//     secondary text, hairline rules between rows, no card-on-card nesting.
//   - Every colour is a host alias, so light and dark follow without a second rule.
//   - Copy is short. A page that explains the protocol is a page nobody reads; what
//     belongs here is the state, the one action that unblocks it, and two examples.
//
// Data comes from one Host route (src/peer/settings-route.ts). The page never edits
// config files: it shows what to write and leaves the profile patch alone.

window.__ModuleLoader__.load({
  id: "dsh-mesh",
  factory(require) {
    const React = require("react");
    const h = React.createElement;

    /** Host route. Must match SETTINGS_METHOD in src/peer/settings-route.ts. */
    const METHOD = "dsh-mesh/settings";

    const CSS = [
      ".m-root{width:100%;display:flex;flex-direction:column;color:var(--dsw-alias-label-primary)}",
      ".m-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding-bottom:2px}",
      ".m-title{margin:0;font-size:16px;font-weight:600;line-height:24px}",
      ".m-id{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}",
      ".m-dot{display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:7px;vertical-align:middle}",
      ".m-ok{background:var(--dsw-alias-state-success-primary,#12a37a)}",
      ".m-bad{background:var(--dsw-alias-state-error-primary,#d5534a)}",
      ".m-idle{background:var(--dsw-alias-label-tertiary,#8a8f98)}",
      ".m-sec{display:flex;flex-direction:column;margin-top:20px}",
      ".m-sec-title{margin:0 0 4px;font-size:12px;font-weight:500;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
      ".m-row{display:flex;gap:16px;padding:10px 0;border-bottom:.5px solid var(--dsw-alias-border-l2);font-size:14px;line-height:20px}",
      ".m-row:last-child{border-bottom:none}",
      ".m-k{flex:none;width:84px;color:var(--dsw-alias-label-secondary)}",
      ".m-v{flex:1;min-width:0;overflow-wrap:anywhere}",
      ".m-mono{font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:12px;line-height:18px}",
      ".m-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;margin:6px 0 0}",
      ".m-err{color:var(--dsw-alias-state-error-primary,#d5534a);font-size:12px;line-height:18px;margin:6px 0 0}",
      ".m-peer{display:flex;align-items:center;gap:8px;padding:10px 0;border-bottom:.5px solid var(--dsw-alias-border-l2);font-size:14px;line-height:20px}",
      ".m-peer:last-child{border-bottom:none}",
      ".m-peer-name{font-weight:500}",
      ".m-spacer{flex:1}",
      ".m-form{display:flex;gap:8px;margin-top:8px}",
      ".m-input{box-sizing:border-box;flex:1;min-width:0;height:32px;padding:0 10px;font-family:inherit;font-size:13px;line-height:30px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1,transparent);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,6px)}",
      ".m-input:focus{outline:none;border-color:var(--dsw-alias-state-business-primary,#2e7cf6)}",
      ".m-input::placeholder{color:var(--dsw-alias-label-tertiary)}",
      ".m-btn{box-sizing:border-box;flex:none;height:32px;padding:0 14px;font-family:inherit;font-size:13px;line-height:30px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1,transparent);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,6px);cursor:pointer}",
      ".m-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,transparent)}",
      ".m-btn:disabled{opacity:.5;cursor:default}",
      ".m-primary{color:#fff;background:var(--dsw-alias-state-business-primary,#2e7cf6);border-color:transparent}",
      ".m-small{height:26px;padding:0 9px;font-size:12px;line-height:24px}",
      ".m-pair{display:flex;align-items:center;gap:8px;padding:9px 0;border-bottom:.5px solid var(--dsw-alias-border-l2);font-size:12px;line-height:18px}",
      ".m-pair:last-child{border-bottom:none}",
      ".m-secret{flex-basis:100%;font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}",
      ".m-note{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);margin:8px 0 0}",
      ".m-alert{margin:10px 0 0;font-size:12px;line-height:18px}",
      ".m-alert-bad{color:var(--dsw-alias-state-error-primary,#d5534a)}",
      ".m-alert-ok{color:var(--dsw-alias-state-success-primary,#12a37a)}",
      ".m-example{margin:4px 0 0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}",
      ".m-example code{font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:12px;color:var(--dsw-alias-label-primary)}",
    ].join("");

    /** Small row primitive: keeps the tree shallow and the layout uniform. */
    function Row(props) {
      return h("div", { className: "m-row" },
        h("span", { className: "m-k" }, props.label),
        h("span", { className: "m-v" }, props.children));
    }

    /** One-line state word for a link, with the dot that carries it visually. */
    function stateOf(peer) {
      const state = peer && peer.state;
      if (state === "online") return { text: "在线", cls: "m-ok" };
      if (state === "failed") return { text: "已停止重试", cls: "m-bad" };
      if (state === "connecting" || state === "handshaking") return { text: "连接中", cls: "m-idle" };
      return { text: "离线", cls: "m-idle" };
    }

    function MeshSection(props) {
      const ctx = props.ctx;
      const [load, setLoad] = React.useState({ phase: "loading", data: null, error: "" });
      const [busy, setBusy] = React.useState(false);
      const [flash, setFlash] = React.useState({ text: "", bad: false });
      const [peerId, setPeerId] = React.useState("");
      const [paste, setPaste] = React.useState("");
      const liveId = React.useRef(0);

      const call = React.useCallback(
        async (payload) => {
          const rpc = ctx && ctx.connection ? ctx.connection.rpc : undefined;
          if (!rpc || typeof rpc.call !== "function") throw new Error("宿主没有提供连接通道");
          const result = await rpc.call("/api", METHOD, payload || {});
          if (!result || typeof result.ok !== "boolean") throw new Error("接口返回格式异常");
          if (!result.ok) throw new Error((result.error && result.error.message) || "宿主拒绝了这次请求");
          return result.value || {};
        },
        [ctx],
      );

      const refresh = React.useCallback(async () => {
        const id = ++liveId.current;
        try {
          const data = await call({ action: "read" });
          if (liveId.current !== id) return;
          setLoad({ phase: "ready", data, error: "" });
        } catch (error) {
          if (liveId.current !== id) return;
          setLoad({ phase: "error", data: null, error: (error && error.message) || String(error) });
        }
      }, [call]);

      React.useEffect(() => {
        let stopped = false;
        const tick = () => { if (!stopped) refresh(); };
        tick();
        const timer = setInterval(tick, 5000);
        return () => {
          stopped = true;
          clearInterval(timer);
          liveId.current++;
        };
      }, [refresh]);

      const act = async (payload, okText) => {
        setBusy(true);
        setFlash({ text: "", bad: false });
        try {
          await call(payload);
          setFlash({ text: okText, bad: false });
          await refresh();
        } catch (error) {
          setFlash({ text: (error && error.message) || String(error), bad: true });
        } finally {
          setBusy(false);
        }
      };

      const copy = async (value) => {
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(value);
            setFlash({ text: "已复制", bad: false });
            return;
          }
        } catch {
          /* fall through to the manual path */
        }
        setFlash({ text: "复制失败，请手动选中", bad: true });
      };

      if (load.phase === "loading") {
        return h("div", { className: "m-root" }, h("style", { key: "s" }, CSS),
          h("p", { className: "m-hint" }, "正在读取…"));
      }
      if (load.phase === "error") {
        return h("div", { className: "m-root" }, h("style", { key: "s" }, CSS),
          h("p", { className: "m-alert m-alert-bad" }, load.error),
          h("p", { className: "m-hint" }, "插件没拿到宿主的连接通道，这个页面读不到状态。"));
      }

      const data = load.data || {};
      const snap = data.snapshot || {};
      const device = snap.device || {};
      const server = snap.server || {};
      const peers = Array.isArray(snap.peers) ? snap.peers : [];
      const paired = Array.isArray(data.pairingStrings) ? data.pairingStrings : [];
      const perms = snap.permissions || {};
      const online = peers.filter((peer) => peer.state === "online").length;
      const roots = perms.allowedRoots && perms.allowedRoots.length ? perms.allowedRoots.join("、") : "无";

      const failLine = peers.filter((peer) => peer.lastError).map((peer) =>
        h("p", { className: "m-err", key: "e-" + (peer.alias || "") },
          (peer.alias || "对端") + "：" + peer.lastError.code));

      const peerRows = peers.map((peer, index) => {
        const view = stateOf(peer);
        const detail = [
          view.text,
          peer.roundTripMs ? peer.roundTripMs + "ms" : "",
          peer.outbound ? "我方拨出" : "对方拨入",
        ].filter(Boolean).join(" · ");
        return h("div", { className: "m-peer", key: (peer.alias || "peer") + index },
          h("span", { className: "m-dot " + view.cls }),
          h("span", { className: "m-peer-name" }, peer.alias || "未命名"),
          h("span", { className: "m-hint", style: { margin: 0 } }, detail),
          h("span", { className: "m-spacer" }),
          h("button", {
            type: "button", className: "m-btn m-small", disabled: busy,
            onClick: () => act(
              { action: peer.state === "online" ? "disconnect" : "connect", device: peer.alias },
              peer.state === "online" ? "已断开" : "已发起连接",
            ),
          }, peer.state === "online" ? "断开" : "连接"));
      });

      const pairRows = paired.map((entry) =>
        h("div", { key: entry.deviceId },
          h("div", { className: "m-pair" },
            h("span", { className: "m-mono" }, entry.deviceId),
            h("span", { className: "m-hint", style: { margin: 0 } }, entry.code),
            h("span", { className: "m-spacer" }),
            entry.pairingString
              ? h("button", { type: "button", className: "m-btn m-small", onClick: () => copy(entry.pairingString) }, "复制")
              : null,
            h("button", {
              type: "button", className: "m-btn m-small", disabled: busy,
              onClick: () => act({ action: "pair/remove", deviceId: entry.deviceId }, "已删除配对"),
            }, "删除")),
          entry.pairingString ? h("p", { className: "m-secret" }, entry.pairingString) : null));

      return h("div", { className: "m-root" },
        h("style", { key: "s" }, CSS),

        h("div", { className: "m-head" },
          h("h2", { className: "m-title" },
            h("span", { className: "m-dot " + (online > 0 ? "m-ok" : "m-idle") }),
            "远程连接"),
          h("span", { className: "m-id" }, (device.name || "") +
            (online > 0 ? " · " + online + " 个对端在线" : ""))),

        h("div", { className: "m-sec" },
          h("p", { className: "m-sec-title" }, "本机"),
          h(Row, { label: "设备 ID" }, h("span", { className: "m-mono" }, device.deviceId || "—")),
          h(Row, { label: "监听" }, server.running
            ? h("span", { className: "m-mono" }, server.url || "")
            : (server.enabled ? "已启用，尚未启动" : "已关闭")),
          h(Row, { label: "允许对方" },
            roots + (perms.allowWrite ? " · 可写" : " · 只读") + (perms.allowExec ? " · 可执行" : ""))),

        h("div", { className: "m-sec" },
          h("p", { className: "m-sec-title" }, "对端"),
          peers.length === 0
            ? h("p", { className: "m-hint" }, "还没有对端。手机配对并连上之后会出现在这里。")
            : peerRows,
          failLine),

        h("div", { className: "m-sec" },
          h("p", { className: "m-sec-title" }, "配对"),
          h("p", { className: "m-note", style: { marginTop: 0 } }, "配对一次即可，双向确认，之后自动重连。"),

          h("div", { className: "m-form" },
            h("input", {
              className: "m-input", value: peerId, placeholder: "对方设备 ID（手机 mesh_status 里那个）",
              onChange: (event) => setPeerId(event.target.value),
            }),
            h("button", {
              type: "button", className: "m-btn m-primary",
              disabled: busy || peerId.trim() === "",
              onClick: () => act({ action: "pair/create", device: peerId },
                "已生成配对串，复制后在对方设备执行 accept"),
            }, "生成配对串")),

          h("div", { className: "m-form" },
            h("input", {
              className: "m-input", value: paste, placeholder: "或粘贴对方给的整行（含配对码与密钥）",
              onChange: (event) => setPaste(event.target.value),
            }),
            h("button", {
              type: "button", className: "m-btn",
              disabled: busy || paste.trim() === "",
              onClick: () => act({ action: "pair/accept", pairingString: paste }, "已接受配对"),
            }, "接受")),

          paired.length > 0 ? pairRows : h("p", { className: "m-hint" }, "尚未配对。")),

        h("div", { className: "m-sec" },
          h("p", { className: "m-sec-title" }, "怎么用"),
          h("p", { className: "m-example" }, "配对连上后，直接说想要什么，agent 自己选工具："),
          h("p", { className: "m-example" }, "· 「用手机查一下还剩多少存储空间」"),
          h("p", { className: "m-example" }, "· 「把这份文件发到手机，然后让手机那边整理一下」"),
          h("p", { className: "m-hint" },
            h("code", null, "mesh_delegate"), " 让对方自己判断；只是取文件或跑命令时，",
            h("code", null, " mesh_read"),
            h("code", null, " / "),
            h("code", null, "mesh_exec"), " 更快。")),

        flash.text
          ? h("p", { className: "m-alert " + (flash.bad ? "m-alert-bad" : "m-alert-ok") }, flash.text)
          : null,

        h("p", { className: "m-hint", style: { marginTop: 20 } },
          "这页只读状态和做配对，不改写配置。改授权目录或端口请编辑 profile 的 cordis.patch.yml。"));
    }

    function apply(ctx) {
      if (!ctx || !ctx.slots || typeof ctx.slots.inject !== "function") return;
      try {
        ctx.slots.inject("settings.section", () =>
          ctx.slots.register(
            { name: "settings.section", id: "mesh", order: 40, label: "远程连接" },
            (props) => h(MeshSection, Object.assign({}, props, { ctx })),
          ),
        );
      } catch (error) {
        if (typeof console !== "undefined" && console.warn) console.warn("[dsh-mesh] settings page unavailable:", error);
      }
    }

    return { apply, inject: ["slots", "connection"] };
  },
});
