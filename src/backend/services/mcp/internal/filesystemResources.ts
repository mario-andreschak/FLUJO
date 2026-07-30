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
import path from 'path';
import { promises as fs } from 'fs';
import type { MCPResource, MCPReadResourceResult, MCPServiceResponse } from '@/shared/types/mcp';
import { createLogger } from '@/utils/logger';
import { MCP_APPS_PROTOCOL_VERSION } from '../appsProtocol';
import { FILESYSTEM_SERVER_NAME } from './registry';
import { isInside, loadEffectiveRoots } from './confinement';

const resLog = createLogger('backend/services/mcp/internal/filesystemResources');

export const FILESYSTEM_APP_URI = 'ui://filesystem/browser';
/**
 * #216: the docked "dev canvas" diff app. A `pip`-capable, persistent surface
 * that the mutation tools (`write_file`, `edit_file`) point their `_meta.ui`
 * link at, so every edit feeds the SAME docked tab and updates in place instead
 * of spawning a fresh iframe per write.
 */
export const DEVCANVAS_DIFF_URI = 'ui://devcanvas/diff';
const APP_MIME_TYPE = 'text/html;profile=mcp-app';

/**
 * #287: expose files the filesystem tools have read/written as MCP resources so
 * a client can track which files a session touched. We keep a lightweight,
 * bounded, newest-first in-memory registry of DESCRIPTORS (path, op, size,
 * timestamp) — NOT copies of file bodies — and read the current content live
 * (re-enforcing path confinement) only when a resource is actually read. That
 * avoids duplicating potentially large/sensitive file contents into any store.
 */
export type TouchedFileOp = 'read' | 'write';
interface TouchedFileEntry {
  uri: string;
  filePath: string;
  op: TouchedFileOp;
  size?: number;
  at: number;
}

/** Cap the registry so long sessions can't grow it without bound. */
const MAX_TOUCHED_FILES = 200;
/** Output cap when serving a tracked file's content as a resource. */
const MAX_RESOURCE_CHARS = 200_000;
/** Keyed by URI; insertion order is oldest→newest (Map preserves it). */
const touchedFiles = new Map<string, TouchedFileEntry>();

/** Build a `file://` URI for an absolute host path (Windows/POSIX safe). */
function pathToFileUri(absPath: string): string {
  const norm = absPath.replace(/\\/g, '/');
  return norm.startsWith('/') ? `file://${norm}` : `file:///${norm}`;
}

/**
 * Record that a filesystem tool touched `filePath`. Never throws — resource
 * tracking must not be able to break a tool call.
 */
export function recordTouchedFile(filePath: string, op: TouchedFileOp, size?: number): void {
  try {
    if (typeof filePath !== 'string' || !filePath) return;
    const uri = pathToFileUri(filePath);
    // Refresh position (delete+set moves the key to newest) and merge size.
    const prev = touchedFiles.get(uri);
    touchedFiles.delete(uri);
    touchedFiles.set(uri, { uri, filePath, op, size: size ?? prev?.size, at: Date.now() });
    while (touchedFiles.size > MAX_TOUCHED_FILES) {
      const oldest = touchedFiles.keys().next().value;
      if (oldest === undefined) break;
      touchedFiles.delete(oldest);
    }
  } catch (err) {
    resLog.debug('recordTouchedFile ignored error', err);
  }
}

/** Test seam: clear the touched-file registry. */
export function _clearTouchedFilesForTests(): void {
  touchedFiles.clear();
}

/** MCP resource descriptors for the tracked files, newest-first. */
function touchedFileResources(): MCPResource[] {
  return [...touchedFiles.values()].reverse().map((e) => ({
    uri: e.uri,
    name: path.basename(e.filePath),
    mimeType: 'text/plain',
    description: `${e.op === 'write' ? 'Written' : 'Read'} by the filesystem server: ${e.filePath}`,
    ...(typeof e.size === 'number' ? { size: e.size } : {}),
  }));
}

/** True when a URI refers to a tracked (read/written) file resource. */
export function isTouchedFileUri(uri: string): boolean {
  return touchedFiles.has(uri);
}

/**
 * resources/read for a tracked file: read the current content LIVE, re-enforcing
 * the filesystem server's confinement roots (a file recorded earlier could now
 * be outside a narrowed root). Content is capped like `read_file`.
 */
export async function readTouchedFileResource(uri: string): Promise<MCPServiceResponse<MCPReadResourceResult>> {
  const entry = touchedFiles.get(uri);
  if (!entry) {
    return { success: false, error: `Not a tracked filesystem resource: ${uri}`, statusCode: 404 };
  }
  let roots: string[] = [];
  try {
    roots = await loadEffectiveRoots(FILESYSTEM_SERVER_NAME, 'FLUJO_FS_ROOTS');
  } catch (err) {
    resLog.warn('readTouchedFileResource: could not load roots', err);
  }
  if (roots.length === 0 || !roots.some((root) => isInside(root, entry.filePath))) {
    return { success: false, error: `Path "${entry.filePath}" is outside the configured filesystem roots.`, statusCode: 403 };
  }
  try {
    let text = await fs.readFile(entry.filePath, 'utf8');
    if (text.length > MAX_RESOURCE_CHARS) text = text.slice(0, MAX_RESOURCE_CHARS) + '\n…[truncated]';
    return {
      success: true,
      data: { contents: [{ uri, mimeType: 'text/plain', text } as MCPReadResourceResult['contents'][number]] },
    };
  } catch (err) {
    return { success: false, error: `Could not read tracked file: ${err instanceof Error ? err.message : String(err)}`, statusCode: 500 };
  }
}

/** resources/list for the filesystem server: the browser app + diff canvas + tracked files. */
export function filesystemListResources(): { resources: MCPResource[]; error?: string } {
  return {
    resources: [
      {
        uri: FILESYSTEM_APP_URI,
        name: 'filesystem_browser',
        mimeType: APP_MIME_TYPE,
        description: 'Interactive file browser (navigate, preview, upload, download) for the filesystem server.',
      },
      {
        uri: DEVCANVAS_DIFF_URI,
        name: 'devcanvas_diff',
        mimeType: APP_MIME_TYPE,
        description: 'Docked diff canvas that shows file writes/edits live as they happen (pip display mode).',
      },
      ...touchedFileResources(),
    ],
  };
}

/** True when a URI is one this module serves. */
export function isFilesystemAppUri(uri: string): boolean {
  return uri === FILESYSTEM_APP_URI || uri === DEVCANVAS_DIFF_URI;
}

/** resources/read for the filesystem server's built-in MCP Apps. */
export function filesystemReadResource(uri: string): MCPServiceResponse<MCPReadResourceResult> {
  if (!isFilesystemAppUri(uri)) {
    return { success: false, error: `Not a filesystem app URI: ${uri}`, statusCode: 404 };
  }
  const html = uri === DEVCANVAS_DIFF_URI ? DEVCANVAS_DIFF_HTML : FILESYSTEM_APP_HTML;
  return {
    success: true,
    data: {
      contents: [
        {
          uri,
          mimeType: APP_MIME_TYPE,
          text: html,
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
      if (res && res.isError) {
        var errMsg = (payloadOf(res) || {}).error || "list_dir failed";
        // Detect the unconfigured-roots scenario and provide actionable guidance.
        if (errMsg.indexOf("outside the configured filesystem roots") !== -1) {
          errMsg = "No filesystem roots configured. "
            + "To browse files: go to MCP Manager → Filesystem → Roots and add a directory, "
            + "or set the FLUJO_FS_ROOTS environment variable. "
            + "In Docker, also add a host bind-mount to docker-compose.yml.";
        }
        throw new Error(errMsg);
      }
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
    protocolVersion: "${MCP_APPS_PROTOCOL_VERSION}"
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


/**
 * #216 — the docked diff canvas View. Dependency-free, backtick-free MCP Apps
 * client over postMessage (same dialect as the file browser above). It
 * advertises `pip` support so FLUJO can dock it, and renders a live, newest-
 * first log of file writes/edits fed through the standard tool-result channel.
 * Each `write_file` / `edit_file` result appends a change card; re-feeds for the
 * same docked tab update it in place (no new iframe).
 */
const DEVCANVAS_DIFF_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  :root { --bg:#fff; --fg:#1a1a1a; --muted:#666; --border:#e0e0e0; --accent:#1565c0; --add:#e6ffed; --addln:#22863a; --hover:#f5f5f5; }
  [data-theme="dark"] { --bg:#1e1e1e; --fg:#e8e8e8; --muted:#9e9e9e; --border:#3a3a3a; --accent:#64b5f6; --add:#0f2f18; --addln:#7bd88f; --hover:#2a2a2a; }
  * { box-sizing: border-box; }
  html,body { margin:0; padding:0; height:100%; }
  body { font: 13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; background:var(--bg); color:var(--fg); }
  #wrap { padding:10px; }
  h3 { margin:0 0 8px; font-size:14px; }
  .empty { color:var(--muted); padding:10px 2px; }
  .card { border:1px solid var(--border); border-radius:6px; margin-bottom:8px; overflow:hidden; }
  .card h4 { margin:0; padding:6px 10px; background:var(--hover); font-size:12px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; word-break:break-all; display:flex; gap:8px; align-items:center; }
  .badge { font-size:11px; padding:1px 6px; border-radius:10px; border:1px solid var(--border); color:var(--muted); }
  .stat { font-size:11px; color:var(--addln); }
  pre { margin:0; padding:8px 10px; max-height:220px; overflow:auto; white-space:pre-wrap; word-break:break-word; background:var(--bg); }
  .del { color:#d32f2f; }
</style>
</head>
<body>
<div id="wrap">
  <h3>Diff canvas</h3>
  <div id="log"><div class="empty">Waiting for file writes / edits...</div></div>
</div>
<script>
(function () {
  var parentWin = window.parent;
  var logEl = document.getElementById("log");
  var changes = [];
  var seen = 0;

  function post(msg) { parentWin.postMessage(msg, "*"); }
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

  function render() {
    if (!changes.length) { logEl.innerHTML = '<div class="empty">Waiting for file writes / edits...</div>'; sendSize(); return; }
    logEl.innerHTML = "";
    for (var i = changes.length - 1; i >= 0; i--) {
      var c = changes[i];
      var card = document.createElement("div"); card.className = "card";
      var h = document.createElement("h4");
      var nm = document.createElement("span"); nm.textContent = c.path || "(unknown path)"; nm.style.flex = "1";
      h.appendChild(nm);
      if (c.mode) { var b = document.createElement("span"); b.className = "badge"; b.textContent = c.mode; h.appendChild(b); }
      if (c.stat) { var s = document.createElement("span"); s.className = "stat"; s.textContent = c.stat; h.appendChild(s); }
      card.appendChild(h);
      if (c.body) { var pre = document.createElement("pre"); pre.textContent = c.body; card.appendChild(pre); }
      logEl.appendChild(card);
    }
    sendSize();
  }

  function addFromResult(payload, args) {
    if (!payload && !args) return;
    var p = payload || {};
    var a = args || {};
    if (p.snapshotDiff) {
      var sd = p.snapshotDiff;
      var files = Array.isArray(sd.changedFiles) ? sd.changedFiles : [];
      var change = {
        path: (sd.nodeName || sd.nodeId || "Snapshot") + " — " + (sd.root || ""),
        mode: "snapshot",
        stat: files.length + " file(s)",
        body: files.map(function (f) { return (f.status || "?") + "  " + (f.path || ""); }).join("\n")
          + (sd.resourceUri ? "\n\nPatch resource: " + sd.resourceUri : "")
      };
      changes.push(change);
      render();
      if (sd.resourceUri) {
        rpc("resources/read", { uri: sd.resourceUri }).then(function (result) {
          var contents = result && result.contents;
          var text = contents && contents[0] && contents[0].text;
          if (typeof text === "string" && text.length) {
            change.body = text;
            render();
          }
        }).catch(function () {});
      }
      return;
    }
    var change = { path: p.path || a.path || "", mode: p.mode || (a.edits ? "edit" : (a.diff ? "diff" : undefined)), stat: "", body: "" };
    if (p.diff && (typeof p.diff.added === "number" || typeof p.diff.removed === "number")) {
      change.stat = "+" + (p.diff.added || 0) + " -" + (p.diff.removed || 0);
    } else if (typeof p.bytesWritten === "number") {
      change.stat = p.bytesWritten + " B";
    } else if (typeof p.editsApplied === "number") {
      change.stat = p.editsApplied + " edit(s)";
    } else if (typeof p.applied === "number") {
      change.stat = p.applied + " edit(s)";
    }
    if (typeof a.content === "string") change.body = a.content.slice(0, 4000);
    else if (typeof a.diff === "string") change.body = a.diff.slice(0, 4000);
    changes.push(change);
    render();
  }

  var lastArgs = null;
  window.addEventListener("message", function (event) {
    var m = event.data;
    if (!m || m.jsonrpc !== "2.0") return;
    if (m.method === "ui/notifications/host-context-changed") { applyTheme(m.params); return; }
    if (m.method === "ui/notifications/tool-input") { lastArgs = m.params && m.params.arguments; return; }
    if (m.method === "ui/notifications/tool-result") {
      addFromResult(payloadOf(m.params && m.params.result ? m.params.result : m.params), lastArgs);
      lastArgs = null;
      return;
    }
    if (m.method === "ping" && m.id !== undefined) { post({ jsonrpc: "2.0", id: m.id, result: {} }); return; }
    if (m.method === "ui/resource-teardown" && m.id !== undefined) { post({ jsonrpc: "2.0", id: m.id, result: {} }); return; }
  });

  // Handshake: advertise pip so the host can dock this app.
  var idc = 1; var pending = {};
  function rpc(method, params) {
    return new Promise(function (resolve, reject) {
      var id = idc++; pending[id] = { resolve: resolve, reject: reject };
      post({ jsonrpc: "2.0", id: id, method: method, params: params || {} });
    });
  }
  window.addEventListener("message", function (event) {
    var m = event.data;
    if (!m || m.jsonrpc !== "2.0") return;
    if (m.id !== undefined && (m.result !== undefined || m.error !== undefined)) {
      var pr = pending[m.id]; if (!pr) return; delete pending[m.id];
      if (m.error) pr.reject(new Error(m.error.message || "RPC error")); else pr.resolve(m.result);
    }
  });
  rpc("ui/initialize", {
    appInfo: { name: "devcanvas-diff", version: "1.0.0" },
    appCapabilities: { availableDisplayModes: ["inline", "fullscreen", "pip"] },
    protocolVersion: "${MCP_APPS_PROTOCOL_VERSION}"
  }).then(function (result) {
    applyTheme(result && result.hostContext);
    notify("ui/notifications/initialized", {});
    sendSize();
  }).catch(function () { sendSize(); });
})();
</script>
</body>
</html>`;
