/**
 * First-party MCP App for the built-in Bash server (issue #330).
 *
 * This is intentionally a line-oriented console over the existing piped child
 * process implementation. It does not claim PTY, curses/full-screen program,
 * cursor-positioning, alternate-screen, or resize support.
 */
import type {
  ReadResourceResult as MCPReadResourceResult,
  Resource as MCPResource,
} from '@modelcontextprotocol/sdk/types.js';
import { BASH_TERMINAL_APP_URI } from './tools.js';

const MCP_APPS_PROTOCOL_VERSION = '2026-01-26';
const APP_MIME_TYPE = 'text/html;profile=mcp-app';

type MCPServiceResponse<T> = {
  success: boolean;
  data?: T;
  error?: string;
  statusCode?: number;
};

export function bashListResources(): { resources: MCPResource[] } {
  return {
    resources: [
      {
        uri: BASH_TERMINAL_APP_URI,
        name: 'bash_terminal',
        mimeType: APP_MIME_TYPE,
        description: 'Dockable, line-oriented console for owner-scoped Bash background sessions.',
      },
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
          _meta: { ui: { csp: {}, permissions: {} } },
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
<style>
  :root { color-scheme:light; --bg:#f8fafc; --panel:#fff; --fg:#172033; --muted:#64748b; --border:#cbd5e1; --accent:#2563eb; --danger:#b91c1c; --term:#07120d; --termfg:#bbf7d0; }
  [data-theme="dark"] { color-scheme:dark; --bg:#0f172a; --panel:#111827; --fg:#e5e7eb; --muted:#94a3b8; --border:#334155; --accent:#60a5fa; --danger:#f87171; --term:#020906; --termfg:#bbf7d0; }
  * { box-sizing:border-box; }
  html,body { margin:0; min-height:100%; background:var(--bg); color:var(--fg); font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  main { display:flex; flex-direction:column; gap:8px; min-height:100vh; padding:10px; }
  .card { border:1px solid var(--border); border-radius:8px; background:var(--panel); padding:9px; }
  .row { display:flex; align-items:center; gap:7px; flex-wrap:wrap; }
  .grow { flex:1 1 220px; }
  label { color:var(--muted); font-size:12px; }
  input,select,button { min-height:32px; border:1px solid var(--border); border-radius:6px; background:var(--panel); color:var(--fg); font:inherit; padding:5px 8px; }
  input:focus,select:focus,button:focus { outline:2px solid var(--accent); outline-offset:1px; }
  button { cursor:pointer; font-weight:600; }
  button.primary { background:var(--accent); color:white; border-color:var(--accent); }
  button.danger { color:var(--danger); }
  button:disabled,input:disabled,select:disabled { cursor:not-allowed; opacity:.55; }
  #command { width:100%; font-family:ui-monospace,SFMono-Regular,Consolas,monospace; }
  #cwd { min-width:170px; }
  #sessions { min-width:210px; }
  #terminal { flex:1 1 auto; min-height:220px; margin:0; padding:12px; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; border-radius:8px; background:var(--term); color:var(--termfg); font:12.5px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace; }
  #state { min-height:20px; color:var(--muted); }
  #state.error { color:var(--danger); }
  .badge { border:1px solid var(--border); border-radius:999px; padding:2px 7px; color:var(--muted); }
  .notice { color:var(--muted); font-size:12px; }
  .stdin { flex-wrap:nowrap; }
  #line { flex:1 1 auto; font-family:ui-monospace,SFMono-Regular,Consolas,monospace; }
</style>
</head>
<body>
<main>
  <section class="card" aria-labelledby="launch-title">
    <div class="row">
      <strong id="launch-title">Bash session</strong>
      <span id="session-badge" class="badge">No session</span>
      <span class="grow"></span>
      <button id="reload-sessions" type="button">Sessions</button>
      <select id="sessions" aria-label="Owned Bash sessions"><option value="">Select a session</option></select>
    </div>
    <div class="row" style="margin-top:7px">
      <input id="command" class="grow" aria-label="Command" placeholder="Command to start in the background" autocomplete="off" />
      <input id="cwd" aria-label="Working directory" placeholder="Working directory (.)" value="." />
      <select id="shell" aria-label="Shell"><option value="default">Default shell</option><option value="pwsh">PowerShell</option><option value="bash">Bash</option></select>
      <button id="start" class="primary" type="button">Start</button>
    </div>
  </section>

  <div id="state" role="status" aria-live="polite">Ready. Start or select an owner-scoped session.</div>
  <pre id="terminal" tabindex="0" aria-label="Combined standard output and standard error">No session output.</pre>

  <section class="card">
    <div class="row stdin">
      <input id="line" aria-label="Line to send to standard input" placeholder="Send one line to stdin" autocomplete="off" disabled />
      <button id="send" type="button" disabled>Send</button>
      <button id="refresh" type="button" disabled>Refresh</button>
      <button id="stop" class="danger" type="button" disabled>Stop</button>
    </div>
    <div class="notice" style="margin-top:7px">Line-oriented console only. Full-screen TTY apps, cursor control, alternate screens, and resize negotiation require future PTY support.</div>
  </section>
</main>
<script>
(function () {
  "use strict";
  var nextId = 1;
  var pending = {};
  var sessionId = "";
  var running = false;
  var busy = false;
  var pollTimer = null;
  var pollPending = false;
  var lastToolInput = null;

  var commandEl = document.getElementById("command");
  var cwdEl = document.getElementById("cwd");
  var shellEl = document.getElementById("shell");
  var sessionsEl = document.getElementById("sessions");
  var outputEl = document.getElementById("terminal");
  var stateEl = document.getElementById("state");
  var badgeEl = document.getElementById("session-badge");
  var lineEl = document.getElementById("line");
  var startEl = document.getElementById("start");
  var sendEl = document.getElementById("send");
  var refreshEl = document.getElementById("refresh");
  var stopEl = document.getElementById("stop");

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
  function applyTheme(context) {
    var theme = context && context.theme;
    document.documentElement.setAttribute("data-theme", theme === "dark" ? "dark" : "light");
  }
  function setState(message, isError) {
    stateEl.textContent = message;
    stateEl.className = isError ? "error" : "";
  }
  function setBusy(value) {
    busy = value;
    startEl.disabled = value;
    sessionsEl.disabled = value;
    document.getElementById("reload-sessions").disabled = value;
    updateControls();
  }
  function updateControls() {
    var usable = Boolean(sessionId) && !busy;
    lineEl.disabled = !usable || !running;
    sendEl.disabled = !usable || !running;
    refreshEl.disabled = !usable;
    stopEl.disabled = !usable || !running;
    badgeEl.textContent = sessionId ? (running ? "Running" : "Ended") + " · " + sessionId : "No session";
  }
  function schedulePoll() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = running ? setTimeout(refresh, 750) : null;
  }
  function applySnapshot(data) {
    if (!data) return;
    if (typeof data.sessionId === "string" && data.sessionId) sessionId = data.sessionId;
    if (typeof data.running === "boolean") running = data.running;
    if (typeof data.output === "string") outputEl.textContent = data.output || "(no output yet)";
    var parts = [];
    if (sessionId) parts.push(running ? "Session is running" : "Session ended with exit code " + String(data.exitCode));
    if (data.truncated) parts.push("Output was truncated at the server limit");
    if (data.timedOut) parts.push("Wait timed out; the process may still be running");
    if (data.error) parts.push(String(data.error));
    setState(parts.join(". ") || "Ready.", Boolean(data.error));
    updateControls();
    schedulePoll();
    outputEl.scrollTop = outputEl.scrollHeight;
  }
  async function callTool(name, args) {
    var result = await rpc("tools/call", { name:name, arguments:args || {} });
    var data = payloadOf(result) || {};
    if (result && result.isError) throw new Error(data.error || name + " failed");
    return data;
  }
  async function refresh() {
    if (!sessionId || pollPending) return;
    pollPending = true;
    try {
      applySnapshot(await callTool("status", { sessionId:sessionId }));
    } catch (error) {
      running = false;
      setState(error && error.message ? error.message : String(error), true);
      updateControls();
    } finally {
      pollPending = false;
      schedulePoll();
    }
  }
  async function startSession() {
    var command = commandEl.value.trim();
    if (!command) { setState("Enter a command to start.", true); commandEl.focus(); return; }
    setBusy(true);
    setState("Starting command...", false);
    try {
      var data = await callTool("start", { command:command, cwd:cwdEl.value.trim() || ".", shell:shellEl.value });
      sessionId = String(data.sessionId || "");
      running = Boolean(sessionId);
      outputEl.textContent = "(waiting for output)";
      applySnapshot(data);
      await refresh();
    } catch (error) {
      setState(error && error.message ? error.message : String(error), true);
    } finally { setBusy(false); }
  }
  async function sendLine() {
    var data = lineEl.value;
    if (!sessionId || !running || !data) return;
    setBusy(true);
    try {
      await callTool("write_stdin", { sessionId:sessionId, data:data, newline:true });
      lineEl.value = "";
      await refresh();
      lineEl.focus();
    } catch (error) { setState(error && error.message ? error.message : String(error), true); }
    finally { setBusy(false); }
  }
  async function stopSession() {
    if (!sessionId || !running) return;
    setBusy(true);
    try {
      await callTool("kill", { sessionId:sessionId });
      setState("Stop requested.", false);
      await refresh();
    } catch (error) { setState(error && error.message ? error.message : String(error), true); }
    finally { setBusy(false); }
  }
  async function loadSessions() {
    setBusy(true);
    try {
      var data = await callTool("list_sessions", {});
      var list = Array.isArray(data.sessions) ? data.sessions : [];
      sessionsEl.textContent = "";
      var empty = document.createElement("option"); empty.value = ""; empty.textContent = list.length ? "Select a session" : "No owned sessions"; sessionsEl.appendChild(empty);
      list.forEach(function (item) {
        var option = document.createElement("option");
        option.value = String(item.sessionId || "");
        option.textContent = (item.running ? "● " : "○ ") + String(item.command || item.sessionId || "session");
        sessionsEl.appendChild(option);
      });
      if (sessionId) sessionsEl.value = sessionId;
      setState(list.length + " owned session(s) available.", false);
    } catch (error) { setState(error && error.message ? error.message : String(error), true); }
    finally { setBusy(false); }
  }
  function acceptToolResult(result) {
    var data = payloadOf(result) || {};
    if (lastToolInput && typeof lastToolInput.command === "string") commandEl.value = lastToolInput.command;
    if (lastToolInput && typeof lastToolInput.cwd === "string") cwdEl.value = lastToolInput.cwd;
    if (lastToolInput && typeof lastToolInput.shell === "string") shellEl.value = lastToolInput.shell;
    if (data.sessionId && data.running === undefined && lastToolInput && lastToolInput.command) running = true;
    if (data.sessionId || data.output !== undefined || data.running !== undefined) applySnapshot(data);
  }

  startEl.onclick = startSession;
  sendEl.onclick = sendLine;
  refreshEl.onclick = refresh;
  stopEl.onclick = stopSession;
  document.getElementById("reload-sessions").onclick = loadSessions;
  sessionsEl.onchange = function () {
    if (!sessionsEl.value) return;
    sessionId = sessionsEl.value;
    running = true;
    updateControls();
    refresh();
  };
  commandEl.onkeydown = function (event) { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); startSession(); } };
  lineEl.onkeydown = function (event) { if (event.key === "Enter") { event.preventDefault(); sendLine(); } };

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
    if (message.method === "ui/notifications/host-context-changed") { applyTheme(message.params); return; }
    if (message.method === "ui/notifications/tool-input") { lastToolInput = message.params && message.params.arguments; return; }
    if (message.method === "ui/notifications/tool-result") { acceptToolResult(message.params && message.params.result ? message.params.result : message.params); return; }
    if (message.method === "ping" && message.id !== undefined) { post({ jsonrpc:"2.0", id:message.id, result:{} }); return; }
    if (message.method === "ui/resource-teardown" && message.id !== undefined) {
      // A teardown can be an inline-to-dock handoff, so it must not terminate
      // the process. Live processes remain owner-scoped and are killed on an
      // explicit Stop or server shutdown; completed records expire after 10m.
      post({ jsonrpc:"2.0", id:message.id, result:{} });
    }
  });

  rpc("ui/initialize", {
    appInfo:{ name:"bash-terminal", version:"1.0.0" },
    appCapabilities:{ availableDisplayModes:["inline","fullscreen","pip"] },
    protocolVersion:"${MCP_APPS_PROTOCOL_VERSION}"
  }).then(function (result) {
    applyTheme(result && result.hostContext);
    notify("ui/notifications/initialized", {});
    updateControls();
    loadSessions();
    rpc("ui/request-display-mode", { mode:"pip" }).catch(function () {});
  }).catch(function (error) { setState("MCP App initialization failed: " + (error && error.message ? error.message : error), true); });
})();
</script>
</body>
</html>`;
