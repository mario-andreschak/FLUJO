/**
 * MCP Apps (#97) — the built-in `filesystem` server's interactive UI app.
 *
 * Publishes a single `ui://filesystem/browser` resource (MIME
 * `text/html;profile=mcp-app`) — a self-contained file-browser View that talks
 * the MCP Apps postMessage dialect directly (no bundled SDK) and drives the
 * filesystem server's own tools (`list_dir`, `read_file`, `write_file`) to
 * navigate directories, preview/download files, and upload text files.
 *
 * The `list_dir` tool definition carries `_meta.ui.resourceUri` pointing here
 * (see filesystemTools.ts), so the chat renders this app whenever the model
 * lists a directory. Because the app runs in FLUJO's separate-origin sandbox
 * and brokers its tool calls back through the filesystem server (confined to
 * the configured roots), it is exactly as constrained as the tools themselves.
 */
import type { MCPResource, MCPReadResourceResult, MCPServiceResponse } from '@/shared/types/mcp';

export const FILESYSTEM_APP_URI = 'ui://filesystem/browser';
const APP_MIME_TYPE = 'text/html;profile=mcp-app';

/** resources/list for the filesystem server: just the browser app. */
export function filesystemListResources(): { resources: MCPResource[]; error?: string } {
  return {
    resources: [
      {
        uri: FILESYSTEM_APP_URI,
        name: 'filesystem_browser',
        mimeType: APP_MIME_TYPE,
        description: 'Interactive file browser (navigate, preview, upload, download) for the filesystem server.',
      },
    ],
  };
}

/** True when a URI is one this module serves. */
export function isFilesystemAppUri(uri: string): boolean {
  return uri === FILESYSTEM_APP_URI;
}

/** resources/read for `ui://filesystem/browser`. */
export function filesystemReadResource(uri: string): MCPServiceResponse<MCPReadResourceResult> {
  if (!isFilesystemAppUri(uri)) {
    return { success: false, error: `Not a filesystem app URI: ${uri}`, statusCode: 404 };
  }
  return {
    success: true,
    data: {
      contents: [
        {
          uri: FILESYSTEM_APP_URI,
          mimeType: APP_MIME_TYPE,
          text: FILESYSTEM_APP_HTML,
          // Self-contained: no external network/resources, so the default-deny
          // sandbox CSP is sufficient. An empty `ui` block still marks intent.
          _meta: { ui: { csp: {}, permissions: {} } },
        } as MCPReadResourceResult['contents'][number],
      ],
    },
  };
}

/**
 * The View HTML. Hand-rolled MCP Apps client over postMessage (window.parent is
 * the sandbox proxy, which relays to the FLUJO host bridge). Kept dependency-
 * free and backtick-free so it embeds cleanly in this template string.
 */
const FILESYSTEM_APP_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  :root { --bg:#fff; --fg:#1a1a1a; --muted:#666; --border:#e0e0e0; --accent:#1565c0; --hover:#f5f5f5; }
  [data-theme="dark"] { --bg:#1e1e1e; --fg:#e8e8e8; --muted:#9e9e9e; --border:#3a3a3a; --accent:#64b5f6; --hover:#2a2a2a; }
  * { box-sizing: border-box; }
  html,body { margin:0; padding:0; }
  body { font: 13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; background:var(--bg); color:var(--fg); }
  #wrap { padding:10px; }
  .bar { display:flex; align-items:center; gap:6px; margin-bottom:8px; flex-wrap:wrap; }
  .bar button, .bar label { font:inherit; cursor:pointer; border:1px solid var(--border); background:var(--bg); color:var(--fg); border-radius:5px; padding:3px 9px; }
  .bar button:hover, .bar label:hover { background:var(--hover); }
  .path { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--muted); word-break:break-all; flex:1 1 200px; }
  ul { list-style:none; margin:0; padding:0; border:1px solid var(--border); border-radius:6px; overflow:hidden; }
  li { display:flex; align-items:center; gap:8px; padding:5px 10px; cursor:pointer; border-bottom:1px solid var(--border); }
  li:last-child { border-bottom:none; }
  li:hover { background:var(--hover); }
  .ico { width:16px; text-align:center; }
  .nm { flex:1; word-break:break-all; }
  .sz { color:var(--muted); font-size:11px; }
  .dl { border:1px solid var(--border); background:var(--bg); color:var(--fg); border-radius:4px; padding:1px 7px; font-size:11px; cursor:pointer; }
  .sel { border-color:var(--accent); color:var(--accent); font-weight:600; }
  .msg { color:var(--muted); padding:8px 2px; }
  .err { color:#d32f2f; }
  pre { background:var(--hover); border:1px solid var(--border); border-radius:6px; padding:10px; max-height:320px; overflow:auto; white-space:pre-wrap; word-break:break-word; margin:8px 0 0; }
  h4 { margin:10px 0 4px; }
</style>
</head>
<body>
<div id="wrap">
  <div class="bar">
    <button id="up" title="Parent directory">&#8593; Up</button>
    <button id="refresh" title="Refresh">&#8635;</button>
    <label>&#8593; Upload<input id="upload" type="file" style="display:none" /></label>
    <span class="path" id="path"></span>
  </div>
  <div id="list"></div>
  <div id="preview"></div>
</div>
<script>
(function () {
  var parentWin = window.parent;
  var idc = 1;
  var pending = {};
  var cwd = ".";

  function post(msg) { parentWin.postMessage(msg, "*"); }
  function rpc(method, params) {
    return new Promise(function (resolve, reject) {
      var id = idc++;
      pending[id] = { resolve: resolve, reject: reject };
      post({ jsonrpc: "2.0", id: id, method: method, params: params || {} });
    });
  }
  function notify(method, params) { post({ jsonrpc: "2.0", method: method, params: params || {} }); }

  function applyTheme(ctx) {
    var theme = ctx && ctx.theme ? ctx.theme : "light";
    document.documentElement.setAttribute("data-theme", theme === "dark" ? "dark" : "light");
  }

  function sendSize() {
    try {
      var h = Math.ceil(document.documentElement.getBoundingClientRect().height);
      notify("ui/notifications/size-changed", { width: 0, height: h });
    } catch (e) {}
  }

  function payloadOf(result) {
    if (!result) return null;
    if (result.structuredContent) return result.structuredContent;
    try {
      var t = result.content && result.content[0] && result.content[0].text;
      return t ? JSON.parse(t) : null;
    } catch (e) { return null; }
  }

  function parentPath(p) {
    var norm = p.replace(/[\\\\]+/g, "/").replace(/\\/+$/, "");
    var i = norm.lastIndexOf("/");
    if (i <= 0) return norm;
    return norm.slice(0, i);
  }
  function joinPath(base, name) {
    var norm = base.replace(/[\\\\]+/g, "/").replace(/\\/+$/, "");
    return norm + "/" + name;
  }

  var listEl = document.getElementById("list");
  var pathEl = document.getElementById("path");
  var previewEl = document.getElementById("preview");

  function setMsg(el, text, isErr) {
    el.innerHTML = "";
    var d = document.createElement("div");
    d.className = "msg" + (isErr ? " err" : "");
    d.textContent = text;
    el.appendChild(d);
    sendSize();
  }

  async function navigate(path) {
    previewEl.innerHTML = "";
    setMsg(listEl, "Loading " + path + " ...");
    try {
      var res = await rpc("tools/call", { name: "list_dir", arguments: { path: path } });
      if (res && res.isError) throw new Error((payloadOf(res) || {}).error || "list_dir failed");
      var data = payloadOf(res) || {};
      cwd = data.path || path;
      pathEl.textContent = cwd;
      renderEntries(data.entries || []);
    } catch (e) {
      setMsg(listEl, "Error: " + (e && e.message ? e.message : e), true);
    }
  }

  function renderEntries(entries) {
    entries.sort(function (a, b) {
      var ad = a.type === "directory" ? 0 : 1, bd = b.type === "directory" ? 0 : 1;
      if (ad !== bd) return ad - bd;
      return String(a.name).localeCompare(String(b.name));
    });
    listEl.innerHTML = "";
    if (!entries.length) { setMsg(listEl, "(empty directory)"); return; }
    var ul = document.createElement("ul");
    entries.forEach(function (ent) {
      var li = document.createElement("li");
      var isDir = ent.type === "directory";
      var ico = document.createElement("span"); ico.className = "ico"; ico.textContent = isDir ? "\\uD83D\\uDCC1" : "\\uD83D\\uDCC4";
      var nm = document.createElement("span"); nm.className = "nm"; nm.textContent = ent.name;
      li.appendChild(ico); li.appendChild(nm);
      if (!isDir) {
        var sz = document.createElement("span"); sz.className = "sz"; sz.textContent = fmtSize(ent.size); li.appendChild(sz);
        var sel = document.createElement("button"); sel.className = "dl sel"; sel.textContent = "Select";
        sel.onclick = function (e) { e.stopPropagation(); selectFile(joinPath(cwd, ent.name)); };
        li.appendChild(sel);
        var dl = document.createElement("button"); dl.className = "dl"; dl.textContent = "Download";
        dl.onclick = function (e) { e.stopPropagation(); downloadFile(joinPath(cwd, ent.name), ent.name); };
        li.appendChild(dl);
        li.onclick = function () { preview(joinPath(cwd, ent.name), ent.name); };
      } else {
        li.onclick = function () { navigate(joinPath(cwd, ent.name)); };
      }
      ul.appendChild(li);
    });
    listEl.appendChild(ul);
    sendSize();
  }

  function fmtSize(n) {
    if (typeof n !== "number") return "";
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    return (n / 1048576).toFixed(1) + " MB";
  }

  async function preview(path, name) {
    previewEl.innerHTML = "";
    var h = document.createElement("h4"); h.textContent = name; previewEl.appendChild(h);
    var pre = document.createElement("pre"); pre.textContent = "Loading..."; previewEl.appendChild(pre);
    sendSize();
    try {
      var res = await rpc("tools/call", { name: "read_file", arguments: { path: path } });
      if (res && res.isError) throw new Error((payloadOf(res) || {}).error || "read_file failed");
      var data = payloadOf(res) || {};
      pre.textContent = typeof data.content === "string" ? data.content : "(no text content)";
    } catch (e) {
      pre.textContent = "Error: " + (e && e.message ? e.message : e);
      pre.className = "err";
    }
    sendSize();
  }

  function selectFile(path) {
    // The picker action: hand the chosen path back to the assistant as a user
    // message (ui/message). The host injects it into the conversation, which
    // resumes the waiting model.
    rpc("ui/message", { role: "user", content: [{ type: "text", text: "Selected file: " + path }] })
      .then(function () { setMsg(previewEl, "Selected " + path + " — sent to the assistant."); })
      .catch(function (e) { setMsg(previewEl, "Select failed: " + (e && e.message ? e.message : e), true); });
  }

  async function downloadFile(path, name) {
    try {
      var res = await rpc("tools/call", { name: "read_file", arguments: { path: path } });
      if (res && res.isError) throw new Error((payloadOf(res) || {}).error || "read_file failed");
      var data = payloadOf(res) || {};
      await rpc("ui/download-file", {
        contents: [{ type: "resource", resource: { uri: "file:///" + name, mimeType: "text/plain", text: String(data.content == null ? "" : data.content) } }]
      });
    } catch (e) {
      setMsg(previewEl, "Download failed: " + (e && e.message ? e.message : e), true);
    }
  }

  document.getElementById("upload").onchange = function (ev) {
    var file = ev.target.files && ev.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = async function () {
      try {
        await rpc("tools/call", { name: "write_file", arguments: { path: joinPath(cwd, file.name), content: String(reader.result) } });
        navigate(cwd);
      } catch (e) {
        setMsg(previewEl, "Upload failed: " + (e && e.message ? e.message : e), true);
      }
    };
    reader.readAsText(file);
    ev.target.value = "";
  };
  document.getElementById("up").onclick = function () { navigate(parentPath(cwd)); };
  document.getElementById("refresh").onclick = function () { navigate(cwd); };

  // --- MCP Apps message handling ---
  window.addEventListener("message", function (event) {
    var m = event.data;
    if (!m || m.jsonrpc !== "2.0") return;
    if (m.id !== undefined && (m.result !== undefined || m.error !== undefined)) {
      var p = pending[m.id];
      if (!p) return;
      delete pending[m.id];
      if (m.error) p.reject(new Error(m.error.message || "RPC error"));
      else p.resolve(m.result);
      return;
    }
    // Host-initiated requests/notifications.
    if (m.method === "ui/notifications/host-context-changed") { applyTheme(m.params); return; }
    if (m.method === "ui/notifications/tool-input") {
      var args = m.params && m.params.arguments;
      if (args && typeof args.path === "string" && !started) { started = true; navigate(args.path); }
      return;
    }
    if (m.method === "ping" && m.id !== undefined) { post({ jsonrpc: "2.0", id: m.id, result: {} }); return; }
    if (m.method === "ui/resource-teardown" && m.id !== undefined) { post({ jsonrpc: "2.0", id: m.id, result: {} }); return; }
  });

  var started = false;

  // Handshake: initialize -> initialized -> initial navigation.
  rpc("ui/initialize", {
    appInfo: { name: "filesystem-browser", version: "1.0.0" },
    appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
    protocolVersion: "2026-01-26"
  }).then(function (result) {
    applyTheme(result && result.hostContext);
    notify("ui/notifications/initialized", {});
    // If no tool-input arrives shortly, start at the data directory (".").
    setTimeout(function () { if (!started) { started = true; navigate("."); } }, 400);
  }).catch(function (e) {
    setMsg(listEl, "Failed to initialize app: " + (e && e.message ? e.message : e), true);
  });
})();
</script>
</body>
</html>`;
