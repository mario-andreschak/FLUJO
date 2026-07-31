/** First-party, PTY-backed MCP App for the built-in Bash server. */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type {
  ReadResourceResult as MCPReadResourceResult,
  Resource as MCPResource,
} from '@modelcontextprotocol/sdk/types.js';
import { BASH_TERMINAL_APP_URI } from './tools.js';

const MCP_APPS_PROTOCOL_VERSION = '2026-01-26';
const APP_MIME_TYPE = 'text/html;profile=mcp-app';
const require = createRequire(import.meta.url);

type MCPServiceResponse<T> = {
  success: boolean;
  data?: T;
  error?: string;
  statusCode?: number;
};

function browserAsset(packageName: string, relativePath?: string): string {
  const entry = require.resolve(packageName);
  const file = relativePath ? path.join(path.dirname(path.dirname(entry)), relativePath) : entry;
  return fs.readFileSync(file, 'utf8');
}

function safeInlineScript(source: string): string {
  return source.replace(/<\/script/gi, '<\\/script');
}

const XTERM_JS = safeInlineScript(browserAsset('@xterm/xterm'));
const XTERM_CSS = browserAsset('@xterm/xterm', 'css/xterm.css').replace(/<\/style/gi, '<\\/style');
const XTERM_FIT_JS = safeInlineScript(browserAsset('@xterm/addon-fit'));

export function bashListResources(): { resources: MCPResource[] } {
  return {
    resources: [
      {
        uri: BASH_TERMINAL_APP_URI,
        name: 'Interactive Terminal',
        title: 'Interactive Terminal',
        mimeType: APP_MIME_TYPE,
        description: 'A real PTY/ConPTY terminal with ANSI rendering, keyboard input, copy/paste, and resize support.',
        _meta: { ui: { csp: {}, permissions: { clipboardWrite: {} }, prefersBorder: true } },
      } as MCPResource,
    ],
  };
}

export function isBashAppUri(uri: string): boolean {
  return uri === BASH_TERMINAL_APP_URI;
}

export function bashReadResource(uri: string): MCPServiceResponse<MCPReadResourceResult> {
  if (!isBashAppUri(uri)) {
    return { success: false, error: `Not a Bash app URI: ${uri}`, statusCode: 404 };
  }
  return {
    success: true,
    data: {
      contents: [
        {
          uri,
          mimeType: APP_MIME_TYPE,
          text: BASH_TERMINAL_APP_HTML,
          _meta: { ui: { csp: {}, permissions: { clipboardWrite: {} }, prefersBorder: true } },
        } as MCPReadResourceResult['contents'][number],
      ],
    },
  };
}

const BASH_TERMINAL_APP_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<style>${XTERM_CSS}</style>
<style>
  :root { color-scheme:dark; --bar:#111827; --border:#334155; --fg:#e5e7eb; --muted:#94a3b8; --accent:#60a5fa; --danger:#f87171; }
  * { box-sizing:border-box; }
  html,body { width:100%; height:100%; margin:0; overflow:hidden; background:#050a07; color:var(--fg); font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  body { display:flex; flex-direction:column; }
  #toolbar { display:flex; align-items:center; gap:7px; min-height:40px; padding:5px 8px; background:var(--bar); border-bottom:1px solid var(--border); }
  #terminal { flex:1 1 auto; min-height:180px; padding:5px; }
  #status { flex:1 1 auto; min-width:0; color:var(--muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .live { color:#86efac !important; }
  .error { color:var(--danger) !important; }
  button,select,input { min-height:28px; border:1px solid var(--border); border-radius:5px; background:#0f172a; color:var(--fg); font:inherit; padding:3px 7px; }
  button { cursor:pointer; }
  button:disabled { opacity:.5; cursor:not-allowed; }
  #cwd { width:min(28vw,260px); }
  #shell { max-width:125px; }
  .xterm { height:100%; }
  .xterm-viewport { scrollbar-color:#475569 #07120d; }
</style>
<script>${XTERM_JS}</script>
<script>${XTERM_FIT_JS}</script>
</head>
<body>
  <div id="toolbar">
    <select id="shell" aria-label="Shell"><option value="default">Automatic</option><option value="pwsh">PowerShell</option><option value="bash">Bash</option><option value="cmd">cmd</option></select>
    <input id="cwd" aria-label="Working directory" value="." title="Working directory" />
    <button id="new" type="button">New</button>
    <button id="copy" type="button" title="Copy selection">Copy</button>
    <button id="clear" type="button">Clear</button>
    <button id="close" type="button">Close</button>
    <span id="status">Initializing terminal…</span>
  </div>
  <div id="terminal" aria-label="Interactive terminal"></div>
<script>
(function () {
  "use strict";
  var nextId = 1;
  var pending = {};
  var sessionId = "";
  var cursor = 0;
  var running = false;
  var pollTimer = null;
  var pollBusy = false;
  var opening = false;
  var inputQueue = "";
  var inputBusy = false;
  var resizeTimer = null;
  var lastToolInput = {};

  var statusEl = document.getElementById("status");
  var shellEl = document.getElementById("shell");
  var cwdEl = document.getElementById("cwd");
  var terminal = new Terminal({
    cursorBlink:true,
    convertEol:false,
    scrollback:10000,
    fontFamily:'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize:13,
    theme:{ background:'#050a07', foreground:'#d1fae5', cursor:'#86efac', selectionBackground:'#2563eb88' }
  });
  var fitAddon = new FitAddon.FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(document.getElementById("terminal"));
  fitAddon.fit();

  function post(message) { window.parent.postMessage(message, "*"); }
  function rpc(method, params) {
    return new Promise(function (resolve, reject) {
      var id = nextId++;
      pending[id] = { resolve:resolve, reject:reject };
      post({ jsonrpc:"2.0", id:id, method:method, params:params || {} });
    });
  }
  function notify(method, params) { post({ jsonrpc:"2.0", method:method, params:params || {} }); }
  function payloadOf(result) {
    if (!result) return null;
    if (result.structuredContent) return result.structuredContent;
    try {
      var text = result.content && result.content[0] && result.content[0].text;
      return text ? JSON.parse(text) : null;
    } catch (e) { return null; }
  }
  async function callTool(name, args) {
    var result = await rpc("tools/call", { name:name, arguments:args || {} });
    var data = payloadOf(result) || {};
    if (result && result.isError) throw new Error(data.error || name + " failed");
    return data;
  }
  function setStatus(message, kind) {
    statusEl.textContent = message;
    statusEl.className = kind || "";
  }
  function schedulePoll(delay) {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = sessionId ? setTimeout(poll, delay == null ? (running ? 60 : 500) : delay) : null;
  }
  function acceptSession(data) {
    if (!data || !data.sessionId) return false;
    sessionId = String(data.sessionId);
    cursor = Number(data.cursor || data.nextCursor || 0);
    running = data.running !== false;
    setStatus((running ? "● " : "○ ") + (data.shell || "terminal") + " — " + (data.cwd || sessionId), running ? "live" : "");
    schedulePoll(0);
    terminal.focus();
    return true;
  }
  async function openTerminal() {
    if (opening) return;
    opening = true;
    document.getElementById("new").disabled = true;
    try {
      if (sessionId && running) await callTool("terminal_close", { sessionId:sessionId }).catch(function () {});
      terminal.reset();
      terminal.clear();
      var data = await callTool("open_terminal", {
        shell:shellEl.value,
        cwd:cwdEl.value.trim() || ".",
        cols:terminal.cols,
        rows:terminal.rows
      });
      acceptSession(data);
    } catch (error) {
      setStatus(error && error.message ? error.message : String(error), "error");
      terminal.writeln("\\r\\n\\x1b[31m" + (error && error.message ? error.message : String(error)) + "\\x1b[0m");
    } finally {
      opening = false;
      document.getElementById("new").disabled = false;
    }
  }
  async function poll() {
    if (!sessionId || pollBusy) return;
    pollBusy = true;
    try {
      var data = await callTool("terminal_read", { sessionId:sessionId, cursor:cursor });
      if (data.reset) { terminal.reset(); terminal.clear(); }
      if (typeof data.chunk === "string" && data.chunk) terminal.write(data.chunk);
      cursor = Number(data.nextCursor == null ? cursor : data.nextCursor);
      running = data.running !== false;
      setStatus((running ? "● " : "○ ") + (data.shell || "terminal") + " — " + (data.cwd || sessionId) + (running ? "" : " — exited " + String(data.exitCode)), running ? "live" : "");
    } catch (error) {
      running = false;
      setStatus(error && error.message ? error.message : String(error), "error");
    } finally {
      pollBusy = false;
      schedulePoll();
    }
  }
  async function flushInput() {
    if (inputBusy || !inputQueue || !sessionId || !running) return;
    inputBusy = true;
    var data = inputQueue;
    inputQueue = "";
    try { await callTool("terminal_write", { sessionId:sessionId, data:data }); }
    catch (error) { setStatus(error && error.message ? error.message : String(error), "error"); }
    finally { inputBusy = false; if (inputQueue) setTimeout(flushInput, 0); }
  }
  function sendResize() {
    if (!sessionId || !running) return;
    callTool("terminal_resize", { sessionId:sessionId, cols:terminal.cols, rows:terminal.rows }).catch(function () {});
  }
  function acceptToolResult(result) {
    var data = payloadOf(result) || {};
    acceptSession(data);
  }

  terminal.onData(function (data) {
    inputQueue += data;
    setTimeout(flushInput, 0);
  });
  terminal.onResize(function () {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(sendResize, 100);
  });
  window.addEventListener("resize", function () { try { fitAddon.fit(); } catch (e) {} });
  document.getElementById("new").onclick = openTerminal;
  document.getElementById("clear").onclick = function () { terminal.clear(); };
  document.getElementById("copy").onclick = function () {
    var text = terminal.getSelection();
    if (!text) { setStatus("Select terminal text first.", ""); return; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { setStatus("Selection copied.", ""); }).catch(function () { setStatus("Copy was denied by the host.", "error"); });
    }
  };
  document.getElementById("close").onclick = async function () {
    if (!sessionId) return;
    await callTool("terminal_close", { sessionId:sessionId }).catch(function () {});
    running = false;
    setStatus("Terminal closed.", "");
  };

  window.addEventListener("message", function (event) {
    var message = event.data;
    if (!message || message.jsonrpc !== "2.0") return;
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      var waiting = pending[message.id];
      if (!waiting) return;
      delete pending[message.id];
      if (message.error) waiting.reject(new Error(message.error.message || "RPC error"));
      else waiting.resolve(message.result);
      return;
    }
    if (message.method === "ui/notifications/tool-input") {
      lastToolInput = message.params && message.params.arguments || {};
      if (typeof lastToolInput.cwd === "string") cwdEl.value = lastToolInput.cwd;
      if (typeof lastToolInput.shell === "string") shellEl.value = lastToolInput.shell;
      return;
    }
    if (message.method === "ui/notifications/tool-result") { acceptToolResult(message.params && message.params.result ? message.params.result : message.params); return; }
    if (message.method === "ping" && message.id !== undefined) { post({ jsonrpc:"2.0", id:message.id, result:{} }); return; }
    if (message.method === "ui/resource-teardown" && message.id !== undefined) {
      // Dock/fullscreen transitions tear down Views; the owner-scoped PTY stays
      // alive so the replacement View can reattach through terminal_list.
      post({ jsonrpc:"2.0", id:message.id, result:{} });
    }
  });

  rpc("ui/initialize", {
    appInfo:{ name:"bash-terminal", version:"2.0.0" },
    appCapabilities:{ availableDisplayModes:["inline","fullscreen","pip"] },
    protocolVersion:"${MCP_APPS_PROTOCOL_VERSION}"
  }).then(async function () {
    notify("ui/notifications/initialized", {});
    try { fitAddon.fit(); } catch (e) {}
    setTimeout(async function () {
      if (sessionId) return;
      try {
        var listed = await callTool("terminal_list", {});
        var sessions = Array.isArray(listed.sessions) ? listed.sessions : [];
        var active = sessions.filter(function (item) { return item.running; }).pop();
        if (!acceptSession(active)) await openTerminal();
      } catch (e) { await openTerminal(); }
    }, 350);
    rpc("ui/request-display-mode", { mode:"pip" }).catch(function () {});
  }).catch(function (error) { setStatus("MCP App initialization failed: " + (error && error.message ? error.message : error), "error"); });
})();
</script>
</body>
</html>`;
