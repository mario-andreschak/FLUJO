import type { Resource, ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import { ensureBrowserGateway, browserSandboxAllowAll, type BrowserGatewayEndpoint } from './gateway.js';

const MCP_APPS_PROTOCOL_VERSION = '2026-01-26';
const APP_MIME_TYPE = 'text/html;profile=mcp-app';
export const BROWSER_APP_URI = 'ui://browser/view';

export function browserListResources(): { resources: Resource[] } {
  return {
    resources: [{
      uri: BROWSER_APP_URI,
      name: 'browser_view',
      mimeType: APP_MIME_TYPE,
      description: 'Live view of the isolated server-side Patchright browser session.',
    }],
  };
}

/**
 * Read the MCP App resource.
 *
 * The returned document is only a shell: it performs the MCP handshake, opens
 * the browser session, and then frames the real UI served by the loopback
 * gateway. The gateway origin is granted here through `_meta.ui.csp`, and the
 * bearer token is templated into the shell so it never reaches the model.
 */
export async function browserReadResource(uri: string): Promise<ReadResourceResult> {
  if (uri !== BROWSER_APP_URI) throw new Error(`Unknown browser resource: ${uri}`);
  const gateway = await ensureBrowserGateway();
  const origins = gateway ? [gateway.origin] : [];
  // Escape hatch: when the persisted `network.allowAllMcpAppContent` setting is
  // enabled (propagated as FLUJO_MCP_APP_SANDBOX_ALLOW_ALL), widen the CSP so
  // the shell can frame the gateway regardless of origin. This is intended only
  // for hosted deployments behind a rewriting reverse proxy.
  const allowAll = browserSandboxAllowAll();
  const frameDomains = allowAll ? ['*'] : origins;
  const connectDomains = allowAll ? ['*'] : origins;
  const resourceDomains = allowAll ? ['*'] : origins;
  return {
    contents: [{
      uri,
      mimeType: APP_MIME_TYPE,
      text: renderBrowserAppHtml(gateway),
      _meta: {
        ui: {
          prefersBorder: false,
          csp: {
            // frameDomains carries the live view; connect/resource keep the
            // screenshot fallback working when the gateway is unavailable.
            frameDomains,
            connectDomains,
            resourceDomains,
          },
          permissions: {},
        },
      },
    } as ReadResourceResult['contents'][number]],
  };
}

/**
 * The MCP App shell.
 *
 * Kept deliberately small: everything the host's app CSP would restrict
 * (workers, blob URLs, media pipelines) lives in the framed gateway document
 * instead. The shell owns the MCP bridge, so navigation still travels the tool
 * channel and stays visible to the model.
 */
export function renderBrowserAppHtml(gateway?: BrowserGatewayEndpoint): string {
  const config = JSON.stringify({
    origin: gateway?.origin ?? '',
    token: gateway?.token ?? '',
  }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
:root{--bg:#fff;--fg:#202124;--muted:#5f6368;--border:#dadce0;--danger:#c5221f}
html[data-theme="dark"]{--bg:#202124;--fg:#e8eaed;--muted:#9aa0a6;--border:#3c4043;--danger:#f28b82}
*{box-sizing:border-box}html,body{height:100%;margin:0;overflow:hidden}
body{background:var(--bg);color:var(--fg);font:13px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
#frame{width:100%;height:100%;border:0;display:block;background:var(--bg)}
#fallback{display:none;height:100%;flex-direction:column}
#fallback.show{display:flex}
#frame.hide{display:none}
.bar{display:flex;gap:6px;align-items:center;padding:6px;border-bottom:1px solid var(--border)}
.bar input{flex:1;min-width:0;font:inherit;padding:6px 10px;border:1px solid var(--border);border-radius:14px;background:var(--bg);color:inherit}
.bar button{font:inherit;padding:6px 10px;border:1px solid var(--border);border-radius:14px;background:var(--bg);color:inherit;cursor:pointer}
#shot{flex:1;min-height:0;display:grid;place-items:center;overflow:hidden}
#shot img{max-width:100%;max-height:100%;display:block}
#note{padding:6px 10px;color:var(--muted);font-size:12px}
#note.error{color:var(--danger)}
</style>
</head>
<body>
<iframe id="frame" title="Live browser view" allow="autoplay; clipboard-read; clipboard-write; fullscreen" referrerpolicy="no-referrer"></iframe>
<div id="fallback">
  <div class="bar">
    <button id="fbBack" title="Back">&#8592;</button>
    <button id="fbForward" title="Forward">&#8594;</button>
    <button id="fbReload" title="Reload">&#8635;</button>
    <input id="fbUrl" type="text" placeholder="https://example.com" />
    <button id="fbGo">Go</button>
  </div>
  <div id="shot"></div>
  <div id="note"></div>
</div>
<script>
(function(){
  "use strict";
  var GATEWAY = ${config};
  var parentWin = window.parent, idc = 1, pending = {}, sessionId = "", starting = false;
  var frame = document.getElementById("frame");
  var fallback = document.getElementById("fallback");
  var shot = document.getElementById("shot");
  var note = document.getElementById("note");
  var fbUrl = document.getElementById("fbUrl");
  var theme = "light", pollTimer = 0, usingFallback = false;
  // null = host did not report its sandbox CSP grant (unknown policy);
  // [] = host reported a grant that excludes the gateway (denied).
  var grantedFrameDomains = null, viewReady = false, readyTimer = 0;

  function post(m){ parentWin.postMessage(m, "*"); }
  function rpc(method, params){
    return new Promise(function(resolve, reject){
      var id = idc++;
      pending[id] = { resolve: resolve, reject: reject };
      post({ jsonrpc: "2.0", id: id, method: method, params: params || {} });
    });
  }
  function notify(method, params){ post({ jsonrpc: "2.0", method: method, params: params || {} }); }
  function errorText(e){ return e && e.message ? e.message : String(e); }
  function payload(result){
    if (result && result.structuredContent) return result.structuredContent;
    try {
      var t = result && result.content && result.content[0] && result.content[0].text;
      return t ? JSON.parse(t) : {};
    } catch (e) { return {}; }
  }
  function failMessage(result){
    var p = payload(result);
    return p && p.error && p.error.message ? p.error.message : "Browser operation failed";
  }
  async function call(name, args){
    var result = await rpc("tools/call", { name: name, arguments: args || {} });
    if (result && result.isError) throw new Error(failMessage(result));
    return result;
  }
  function toView(message){
    if (usingFallback || !frame.contentWindow) return;
    try { frame.contentWindow.postMessage(Object.assign({ source: "flujo-browser-shell" }, message), "*"); } catch (e) {}
  }
  function setNote(text, isError){
    note.textContent = text || "";
    note.className = isError ? "error" : "";
  }

  /* ---------- live view ---------- */
  // Whether the host's effective frame-src grant covers the gateway origin.
  // Grants may be exact origins, the loopback port-wildcard form
  // (http://127.0.0.1:*), or the allow-all escape hatch.
  function frameGrantCovers(origin){
    if (grantedFrameDomains === null) return true; /* unknown policy: probe, the ready watchdog still guards */
    var o = String(origin || "").toLowerCase();
    for (var i = 0; i < grantedFrameDomains.length; i++){
      var d = String(grantedFrameDomains[i] || "").toLowerCase();
      if (d === "*" || d === o) return true;
      if (d.slice(-2) === ":*" && o.indexOf(d.slice(0, -1)) === 0) return true;
    }
    return false;
  }
  function mountLiveView(){
    frame.src = GATEWAY.origin + "/view?s=" + encodeURIComponent(sessionId) + "&t=" + encodeURIComponent(GATEWAY.token);
    // A CSP-blocked or unreachable iframe fires neither load nor error, so a
    // silent live view must degrade to screenshots on its own.
    clearTimeout(readyTimer);
    readyTimer = setTimeout(function(){
      if (!viewReady) useFallback("The live view is not reachable from this browser; showing periodic screenshots.");
    }, 8000);
  }

  /* ---------- screenshot fallback ---------- */
  function useFallback(reason){
    if (usingFallback) return;
    usingFallback = true;
    clearTimeout(readyTimer);
    frame.classList.add("hide");
    fallback.classList.add("show");
    setNote(reason || "Live streaming is unavailable; showing periodic screenshots.", true);
    pollOnce();
  }
  async function pollOnce(){
    if (!usingFallback || !sessionId) return;
    try {
      var result = await call("browser_screenshot", { sessionId: sessionId });
      var items = (result && result.content) || [];
      for (var i = 0; i < items.length; i++){
        if (items[i].type === "image" && items[i].data){
          shot.innerHTML = "";
          var img = document.createElement("img");
          img.src = "data:" + (items[i].mimeType || "image/png") + ";base64," + items[i].data;
          img.alt = "Browser viewport";
          shot.appendChild(img);
          break;
        }
      }
      var state = payload(result);
      if (state.url && document.activeElement !== fbUrl) fbUrl.value = state.url;
      setNote("Screenshot fallback \\u2014 updated " + new Date().toLocaleTimeString());
    } catch (e) {
      setNote(errorText(e), true);
    }
    clearTimeout(pollTimer);
    pollTimer = setTimeout(pollOnce, 2000);
  }
  function fallbackAction(kind, url){
    return async function(){
      try {
        if (kind === "navigate") await call("browser_navigate", { sessionId: sessionId, url: url() });
        else await call("browser_" + kind, { sessionId: sessionId });
        pollOnce();
      } catch (e) { setNote(errorText(e), true); }
    };
  }
  document.getElementById("fbBack").onclick = fallbackAction("back");
  document.getElementById("fbForward").onclick = fallbackAction("forward");
  document.getElementById("fbReload").onclick = fallbackAction("reload");
  document.getElementById("fbGo").onclick = fallbackAction("navigate", function(){ return fbUrl.value.trim(); });
  fbUrl.onkeydown = function(e){ if (e.key === "Enter"){ e.preventDefault(); document.getElementById("fbGo").click(); } };

  /* ---------- session ---------- */
  async function start(initialUrl, requestedId){
    if (starting) return;
    starting = true;
    try {
      var args = {};
      if (initialUrl) args.url = initialUrl;
      if (requestedId) args.sessionId = requestedId;
      var result = await call("browser_open", args);
      var state = payload(result);
      sessionId = state.sessionId || "";
      if (!sessionId) throw new Error("The browser session did not report an id.");
      if (!GATEWAY.origin || !GATEWAY.token) useFallback("The live stream gateway is disabled, so this view falls back to screenshots.");
      else if (!frameGrantCovers(GATEWAY.origin)) useFallback("This deployment cannot frame the local live-view gateway; showing periodic screenshots.");
      else mountLiveView();
    } catch (e) {
      starting = false;
      useFallback(errorText(e));
    }
  }

  /* ---------- commands relayed from the framed view ---------- */
  async function runViewCommand(data){
    try {
      if (data.type === "navigate" && data.url) await call("browser_navigate", { sessionId: sessionId, url: data.url });
      else if (data.type === "back") await call("browser_back", { sessionId: sessionId });
      else if (data.type === "forward") await call("browser_forward", { sessionId: sessionId });
      else if (data.type === "reload") await call("browser_reload", { sessionId: sessionId });
      else if (data.type === "close"){
        await call("browser_close", { sessionId: sessionId });
        notify("ui/notifications/request-teardown", {});
      } else if (data.type === "fullscreen"){
        await rpc("ui/request-display-mode", { mode: "fullscreen" });
      }
    } catch (e) {
      toView({ type: "error", message: errorText(e) });
    } finally {
      toView({ type: "loading", value: false });
    }
  }

  window.addEventListener("message", function(event){
    var m = event.data;
    if (m && m.source === "flujo-browser-view"){
      if (event.source !== frame.contentWindow) return;
      if (m.type === "ready"){ viewReady = true; clearTimeout(readyTimer); toView({ type: "theme", theme: theme }); }
      else void runViewCommand(m);
      return;
    }
    if (!m || m.jsonrpc !== "2.0") return;
    if (m.id !== undefined && (m.result !== undefined || m.error !== undefined)){
      var p = pending[m.id];
      if (!p) return;
      delete pending[m.id];
      if (m.error) p.reject(new Error(m.error.message || "RPC error"));
      else p.resolve(m.result);
      return;
    }
    if (m.method === "ui/notifications/host-context-changed"){
      theme = (m.params && m.params.theme) === "dark" ? "dark" : "light";
      document.documentElement.setAttribute("data-theme", theme);
      toView({ type: "theme", theme: theme });
      return;
    }
    if (m.method === "ui/notifications/tool-input"){
      var a = (m.params && m.params.arguments) || {};
      if (!starting) void start(typeof a.url === "string" ? a.url : "", typeof a.sessionId === "string" ? a.sessionId : "");
      return;
    }
    if (m.method === "ping" && m.id !== undefined){ post({ jsonrpc: "2.0", id: m.id, result: {} }); return; }
    if (m.method === "ui/resource-teardown" && m.id !== undefined){
      clearTimeout(pollTimer);
      post({ jsonrpc: "2.0", id: m.id, result: {} });
      return;
    }
  });

  rpc("ui/initialize", {
    appInfo: { name: "flujo-browser-view", version: "3.0.0" },
    appCapabilities: { availableDisplayModes: ["inline", "fullscreen", "pip"] },
    protocolVersion: "${MCP_APPS_PROTOCOL_VERSION}"
  }).then(function(result){
    var sandboxCaps = result && result.capabilities && result.capabilities.sandbox;
    if (sandboxCaps) grantedFrameDomains = (sandboxCaps.csp && sandboxCaps.csp.frameDomains) || [];
    theme = (result && result.hostContext && result.hostContext.theme) === "dark" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", theme);
    notify("ui/notifications/initialized", {});
    notify("ui/notifications/size-changed", { width: 0, height: 640 });
    setTimeout(function(){ if (!starting) void start("", ""); }, 300);
  }).catch(function(e){
    useFallback("App initialization failed: " + errorText(e));
  });
})();
</script>
</body>
</html>`;
}
