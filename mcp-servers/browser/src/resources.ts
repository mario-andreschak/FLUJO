import type { Resource, ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';

const MCP_APPS_PROTOCOL_VERSION = '2026-01-26';
const APP_MIME_TYPE = 'text/html;profile=mcp-app';
export const BROWSER_APP_URI = 'ui://browser/view';

export function browserListResources(): { resources: Resource[] } {
  return {
    resources: [{
      uri: BROWSER_APP_URI,
      name: 'browser_view',
      mimeType: APP_MIME_TYPE,
      description: 'Interactive view of the isolated server-side Patchright browser session.',
    }],
  };
}

export function browserReadResource(uri: string): ReadResourceResult {
  if (uri !== BROWSER_APP_URI) throw new Error(`Unknown browser resource: ${uri}`);
  return {
    contents: [{
      uri,
      mimeType: APP_MIME_TYPE,
      text: BROWSER_APP_HTML,
      _meta: {
        ui: {
          csp: { connectDomains: [], resourceDomains: [] },
          permissions: {},
        },
      },
    } as ReadResourceResult['contents'][number]],
  };
}

const BROWSER_APP_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
:root{--bg:#fff;--fg:#171717;--muted:#666;--border:#ddd;--accent:#1565c0;--panel:#f6f7f8;--danger:#b42318}
[data-theme="dark"]{--bg:#171717;--fg:#eee;--muted:#aaa;--border:#444;--accent:#64b5f6;--panel:#242424;--danger:#ff8a80}
*{box-sizing:border-box}html,body{margin:0;min-height:100%}body{font:13px/1.45 system-ui,sans-serif;background:var(--bg);color:var(--fg)}
#wrap{padding:10px}.row{display:flex;gap:6px;align-items:center;margin-bottom:7px;flex-wrap:wrap}input,button{font:inherit;border:1px solid var(--border);border-radius:5px;background:var(--bg);color:var(--fg);padding:5px 8px}button{cursor:pointer}button:hover{border-color:var(--accent)}#url{flex:1;min-width:220px}.selector{flex:1;min-width:150px}.status{color:var(--muted);min-height:19px}.error{color:var(--danger)}.viewport{border:1px solid var(--border);border-radius:7px;background:var(--panel);min-height:160px;display:grid;place-items:center;overflow:auto}.viewport img{display:block;max-width:100%;height:auto}.empty{color:var(--muted);padding:25px}.meta{font-size:12px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin:5px 0}details{margin-top:7px}pre{white-space:pre-wrap;word-break:break-word;max-height:180px;overflow:auto;background:var(--panel);padding:7px;border-radius:5px}
</style>
</head>
<body>
<div id="wrap">
  <div class="row"><input id="url" type="url" placeholder="https://example.com" /><button id="go">Go</button><button id="refresh">Refresh view</button><button id="close">Close</button></div>
  <div class="row"><input id="selector" class="selector" placeholder="CSS selector" /><button id="click">Click</button><input id="text" class="selector" placeholder="Text to fill" /><button id="fill">Fill</button></div>
  <div id="status" class="status">Initializing isolated browser…</div>
  <div id="meta" class="meta"></div>
  <div id="viewport" class="viewport"><div class="empty">No screenshot yet.</div></div>
  <details><summary>Visible page text</summary><pre id="snapshot"></pre></details>
</div>
<script>
(function(){
  var parentWin=window.parent,idc=1,pending={},sessionId="",started=false;
  var statusEl=document.getElementById("status"),metaEl=document.getElementById("meta"),viewEl=document.getElementById("viewport"),snapEl=document.getElementById("snapshot");
  function post(m){parentWin.postMessage(m,"*")}
  function rpc(method,params){return new Promise(function(resolve,reject){var id=idc++;pending[id]={resolve:resolve,reject:reject};post({jsonrpc:"2.0",id:id,method:method,params:params||{}})})}
  function notify(method,params){post({jsonrpc:"2.0",method:method,params:params||{}})}
  function setStatus(text,error){statusEl.textContent=text;statusEl.className="status"+(error?" error":"")}
  function payload(result){if(result&&result.structuredContent)return result.structuredContent;try{var t=result&&result.content&&result.content[0]&&result.content[0].text;return t?JSON.parse(t):{}}catch(e){return{}}}
  function failMessage(result){var p=payload(result);return p&&p.error&&p.error.message?p.error.message:"Browser operation failed"}
  function apply(data){if(!data)return;if(data.sessionId)sessionId=data.sessionId;if(data.url){document.getElementById("url").value=data.url;metaEl.textContent=(data.title?data.title+" — ":"")+data.url}if(typeof data.text==="string")snapEl.textContent=data.text}
  function imageOf(result){var items=result&&result.content||[];for(var i=0;i<items.length;i++){if(items[i].type==="image"&&items[i].data)return "data:"+(items[i].mimeType||"image/png")+";base64,"+items[i].data}return""}
  async function call(name,args){setStatus("Working…");var result=await rpc("tools/call",{name:name,arguments:args||{}});if(result&&result.isError)throw new Error(failMessage(result));apply(payload(result));return result}
  async function refresh(){if(!sessionId)return;try{var result=await call("browser_screenshot",{sessionId:sessionId});var image=imageOf(result);viewEl.innerHTML="";if(image){var img=document.createElement("img");img.src=image;img.alt="Current server-side browser viewport";viewEl.appendChild(img)}else{viewEl.textContent="Screenshot was not available."}var snap=await call("browser_snapshot",{sessionId:sessionId});apply(payload(snap));setStatus("Ready");size()}catch(e){setStatus(e&&e.message?e.message:String(e),true)}}
  async function open(initialUrl,requestedId){if(started)return;started=true;try{var args={};if(initialUrl)args.url=initialUrl;if(requestedId)args.sessionId=requestedId;var result=await call("browser_open",args);apply(payload(result));await refresh()}catch(e){setStatus(e&&e.message?e.message:String(e),true)}}
  async function navigate(){var url=document.getElementById("url").value.trim();if(!url)return setStatus("Enter an HTTP(S) URL.",true);try{if(!sessionId){started=false;await open(url,"")}else{await call("browser_navigate",{sessionId:sessionId,url:url});await refresh()}}catch(e){setStatus(e&&e.message?e.message:String(e),true)}}
  async function click(){var selector=document.getElementById("selector").value.trim();if(!selector)return setStatus("Enter a selector.",true);try{await call("browser_click",{sessionId:sessionId,selector:selector});await refresh()}catch(e){setStatus(e&&e.message?e.message:String(e),true)}}
  async function fill(){var selector=document.getElementById("selector").value.trim();if(!selector)return setStatus("Enter a selector.",true);try{await call("browser_type",{sessionId:sessionId,selector:selector,text:document.getElementById("text").value});await refresh()}catch(e){setStatus(e&&e.message?e.message:String(e),true)}}
  function size(){try{notify("ui/notifications/size-changed",{width:0,height:Math.ceil(document.documentElement.getBoundingClientRect().height)})}catch(e){}}
  document.getElementById("go").onclick=navigate;document.getElementById("refresh").onclick=refresh;document.getElementById("click").onclick=click;document.getElementById("fill").onclick=fill;
  document.getElementById("close").onclick=async function(){if(!sessionId)return;try{await call("browser_close",{sessionId:sessionId});sessionId="";viewEl.innerHTML='<div class="empty">Browser session closed.</div>';setStatus("Closed");size()}catch(e){setStatus(e&&e.message?e.message:String(e),true)}};
  window.addEventListener("message",function(event){var m=event.data;if(!m||m.jsonrpc!=="2.0")return;if(m.id!==undefined&&(m.result!==undefined||m.error!==undefined)){var p=pending[m.id];if(!p)return;delete pending[m.id];if(m.error)p.reject(new Error(m.error.message||"RPC error"));else p.resolve(m.result);return}if(m.method==="ui/notifications/host-context-changed"){var theme=m.params&&m.params.theme;document.documentElement.setAttribute("data-theme",theme==="dark"?"dark":"light");return}if(m.method==="ui/notifications/tool-input"){var a=m.params&&m.params.arguments||{};if(!started)open(typeof a.url==="string"?a.url:"",typeof a.sessionId==="string"?a.sessionId:"");return}if(m.method==="ui/notifications/tool-result"){apply(payload(m.params));return}if(m.method==="ping"&&m.id!==undefined){post({jsonrpc:"2.0",id:m.id,result:{}});return}if(m.method==="ui/resource-teardown"&&m.id!==undefined){post({jsonrpc:"2.0",id:m.id,result:{}});return}});
  rpc("ui/initialize",{appInfo:{name:"flujo-browser-view",version:"1.0.0"},appCapabilities:{availableDisplayModes:["inline","fullscreen","pip"]},protocolVersion:"${MCP_APPS_PROTOCOL_VERSION}"}).then(function(result){var theme=result&&result.hostContext&&result.hostContext.theme;document.documentElement.setAttribute("data-theme",theme==="dark"?"dark":"light");notify("ui/notifications/initialized",{});setTimeout(function(){if(!started)open("","")},400)}).catch(function(e){setStatus("App initialization failed: "+(e&&e.message?e.message:e),true)});
})();
</script>
</body>
</html>`;
