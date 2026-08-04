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
:root{--bg:#fff;--fg:#171717;--muted:#666;--border:#d7d9dc;--accent:#1565c0;--panel:#f3f4f6;--danger:#b42318;--toolbar:#eef0f3}
[data-theme="dark"]{--bg:#171717;--fg:#eee;--muted:#aaa;--border:#444;--accent:#64b5f6;--panel:#242424;--danger:#ff8a80;--toolbar:#202225}
*{box-sizing:border-box}html,body{margin:0;min-height:100%}body{font:13px/1.45 system-ui,sans-serif;background:var(--bg);color:var(--fg)}
#wrap{padding:8px}.row{display:flex;gap:5px;align-items:center;margin-bottom:6px;flex-wrap:wrap}.toolbar{padding:6px;border:1px solid var(--border);border-radius:8px;background:var(--toolbar)}input,button{font:inherit;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);padding:6px 8px}button{cursor:pointer;min-width:34px}button:hover,button:focus-visible{border-color:var(--accent);outline:none}#url{flex:1;min-width:180px}.grow{flex:1;min-width:160px}.status{color:var(--muted);min-height:19px}.error{color:var(--danger)}.viewport{position:relative;border:1px solid var(--border);border-radius:8px;background:var(--panel);min-height:220px;display:grid;place-items:center;overflow:hidden;user-select:none}.viewport img{display:block;width:100%;height:auto;cursor:default;outline:none}.viewport img:focus{box-shadow:inset 0 0 0 2px var(--accent)}.empty{color:var(--muted);padding:35px}.meta,.artifact{font-size:12px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin:3px 1px}.artifact{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}.hint{font-size:12px;color:var(--muted);margin-left:auto}details{margin-top:7px}summary{cursor:pointer}pre{white-space:pre-wrap;word-break:break-word;max-height:180px;overflow:auto;background:var(--panel);padding:7px;border-radius:5px}.advanced{padding:6px 0}.kbd{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;border:1px solid var(--border);border-radius:4px;padding:1px 4px}
</style>
</head>
<body>
<div id="wrap">
  <div class="row toolbar"><button id="back" title="Back">&#8592;</button><button id="forward" title="Forward">&#8594;</button><button id="reload" title="Reload">&#8635;</button><input id="url" type="url" placeholder="https://example.com" /><button id="go">Go</button><button id="refresh" title="Refresh viewport">View</button><button id="fullscreen" title="Open fullscreen">&#x26F6;</button><button id="close" title="Close session">Close</button></div>
  <div class="row"><input id="pageText" class="grow" placeholder="Type into the focused page element" /><button id="sendText">Type</button><button id="enter">Enter</button><span class="hint">Click, type, and scroll on the viewport. <span class="kbd">Ctrl+L</span> focuses the address bar.</span></div>
  <div id="status" class="status">Initializing isolated browser…</div>
  <div id="meta" class="meta"></div><div id="artifact" class="artifact"></div>
  <div id="viewport" class="viewport"><div class="empty">No screenshot yet.</div></div>
  <details><summary>Advanced selector controls</summary><div class="row advanced"><input id="selector" class="grow" placeholder="CSS selector" /><button id="selectorClick">Click</button><input id="selectorText" class="grow" placeholder="Text to fill" /><button id="selectorFill">Fill</button></div></details>
  <details><summary>Visible page text</summary><pre id="snapshot"></pre></details>
</div>
<script>
(function(){
  var parentWin=window.parent,idc=1,pending={},sessionId="",started=false,actionQueue=Promise.resolve(),typed="",typeTimer=0,scrollX=0,scrollY=0,scrollTimer=0;
  var statusEl=document.getElementById("status"),metaEl=document.getElementById("meta"),artifactEl=document.getElementById("artifact"),viewEl=document.getElementById("viewport"),snapEl=document.getElementById("snapshot"),urlEl=document.getElementById("url");
  function post(m){parentWin.postMessage(m,"*")}
  function rpc(method,params){return new Promise(function(resolve,reject){var id=idc++;pending[id]={resolve:resolve,reject:reject};post({jsonrpc:"2.0",id:id,method:method,params:params||{}})})}
  function notify(method,params){post({jsonrpc:"2.0",method:method,params:params||{}})}
  function setStatus(text,error){statusEl.textContent=text;statusEl.className="status"+(error?" error":"")}
  function errorText(e){return e&&e.message?e.message:String(e)}
  function payload(result){if(result&&result.structuredContent)return result.structuredContent;try{var t=result&&result.content&&result.content[0]&&result.content[0].text;return t?JSON.parse(t):{}}catch(e){return{}}}
  function failMessage(result){var p=payload(result);return p&&p.error&&p.error.message?p.error.message:"Browser operation failed"}
  function apply(data){if(!data)return;if(data.sessionId)sessionId=data.sessionId;if(data.url){urlEl.value=data.url;metaEl.textContent=(data.title?data.title+" — ":"")+data.url}if(typeof data.text==="string")snapEl.textContent=data.text;if(typeof data.path==="string")artifactEl.textContent=data.path}
  function imageOf(result){var items=result&&result.content||[];for(var i=0;i<items.length;i++){if(items[i].type==="image"&&items[i].data)return "data:"+(items[i].mimeType||"image/png")+";base64,"+items[i].data}return""}
  async function call(name,args){setStatus("Working…");var result=await rpc("tools/call",{name:name,arguments:args||{}});if(result&&result.isError)throw new Error(failMessage(result));apply(payload(result));return result}
  function size(){try{notify("ui/notifications/size-changed",{width:0,height:Math.ceil(document.documentElement.getBoundingClientRect().height)})}catch(e){}}
  async function refresh(restoreFocus){if(!sessionId)return;var result=await call("browser_screenshot",{sessionId:sessionId});var image=imageOf(result);viewEl.innerHTML="";if(image){var img=document.createElement("img");img.src=image;img.alt="Interactive server-side browser viewport";img.tabIndex=0;viewEl.appendChild(img);if(restoreFocus)img.focus()}else{viewEl.innerHTML='<div class="empty">Screenshot was not available.</div>'}var snap=await call("browser_snapshot",{sessionId:sessionId});apply(payload(snap));setStatus("Ready — viewport is interactive");size()}
  function queue(task){actionQueue=actionQueue.then(task,task).catch(function(e){setStatus(errorText(e),true)});return actionQueue}
  function interact(name,args){var restoreFocus=document.activeElement&&document.activeElement.tagName==="IMG";return queue(async function(){if(!sessionId)throw new Error("Open a browser session first.");await call(name,Object.assign({sessionId:sessionId},args||{}));await refresh(restoreFocus)})}
  async function open(initialUrl,requestedId){if(started)return;started=true;try{var args={};if(initialUrl)args.url=initialUrl;if(requestedId)args.sessionId=requestedId;var result=await call("browser_open",args);apply(payload(result));await refresh()}catch(e){started=false;setStatus(errorText(e),true)}}
  function navigate(){var url=urlEl.value.trim();if(!url)return setStatus("Enter an HTTP(S) URL.",true);if(!sessionId){started=false;return open(url,"")}return interact("browser_navigate",{url:url})}
  function flushTyped(){if(typeTimer){clearTimeout(typeTimer);typeTimer=0}if(!typed)return;var text=typed;typed="";interact("browser_type",{text:text})}
  function queueTyped(text){typed+=text;if(typeTimer)clearTimeout(typeTimer);typeTimer=setTimeout(flushTyped,90)}
  function press(key){flushTyped();interact("browser_press",{key:key})}
  document.getElementById("go").onclick=navigate;urlEl.onkeydown=function(e){if(e.key==="Enter"){e.preventDefault();navigate()}};
  document.getElementById("back").onclick=function(){interact("browser_back",{})};document.getElementById("forward").onclick=function(){interact("browser_forward",{})};document.getElementById("reload").onclick=function(){interact("browser_reload",{})};document.getElementById("refresh").onclick=function(){queue(refresh)};
  document.getElementById("fullscreen").onclick=function(){rpc("ui/request-display-mode",{mode:"fullscreen"}).catch(function(e){setStatus(errorText(e),true)})};
  document.getElementById("sendText").onclick=function(){var input=document.getElementById("pageText"),text=input.value;if(!text)return;input.value="";interact("browser_type",{text:text})};document.getElementById("enter").onclick=function(){press("Enter")};
  document.getElementById("pageText").onkeydown=function(e){if(e.key==="Enter"){e.preventDefault();document.getElementById("sendText").click()}};
  document.getElementById("selectorClick").onclick=function(){var selector=document.getElementById("selector").value.trim();if(!selector)return setStatus("Enter a selector.",true);interact("browser_click",{selector:selector})};
  document.getElementById("selectorFill").onclick=function(){var selector=document.getElementById("selector").value.trim();if(!selector)return setStatus("Enter a selector.",true);interact("browser_type",{selector:selector,text:document.getElementById("selectorText").value})};
  document.getElementById("close").onclick=function(){queue(async function(){if(!sessionId)return;await call("browser_close",{sessionId:sessionId});sessionId="";started=false;viewEl.innerHTML='<div class="empty">Browser session closed.</div>';setStatus("Closed");size()})};
  viewEl.addEventListener("click",function(e){var img=e.target;if(!img||img.tagName!=="IMG")return;img.focus();var r=img.getBoundingClientRect(),x=(e.clientX-r.left)*(img.naturalWidth/r.width),y=(e.clientY-r.top)*(img.naturalHeight/r.height);interact("browser_click",{x:Math.max(0,Math.min(img.naturalWidth-1,x)),y:Math.max(0,Math.min(img.naturalHeight-1,y)),button:"left"})});
  viewEl.addEventListener("contextmenu",function(e){var img=e.target;if(!img||img.tagName!=="IMG")return;e.preventDefault();img.focus();var r=img.getBoundingClientRect(),x=(e.clientX-r.left)*(img.naturalWidth/r.width),y=(e.clientY-r.top)*(img.naturalHeight/r.height);interact("browser_click",{x:Math.max(0,Math.min(img.naturalWidth-1,x)),y:Math.max(0,Math.min(img.naturalHeight-1,y)),button:"right"})});
  viewEl.addEventListener("wheel",function(e){if(!sessionId)return;e.preventDefault();scrollX+=e.deltaX;scrollY+=e.deltaY;if(scrollTimer)clearTimeout(scrollTimer);scrollTimer=setTimeout(function(){var x=scrollX,y=scrollY;scrollX=0;scrollY=0;interact("browser_scroll",{deltaX:x,deltaY:y})},80)},{passive:false});
  viewEl.addEventListener("keydown",function(e){if(!e.target||e.target.tagName!=="IMG")return;if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="l"){e.preventDefault();urlEl.focus();urlEl.select();return}var modifiers=[];if(e.ctrlKey)modifiers.push("Control");if(e.metaKey)modifiers.push("Meta");if(e.altKey)modifiers.push("Alt");if(e.shiftKey&&e.key.length>1)modifiers.push("Shift");if(modifiers.length){e.preventDefault();press(modifiers.concat([e.key.length===1?e.key.toUpperCase():e.key]).join("+"));return}if(e.key.length===1){e.preventDefault();queueTyped(e.key);return}if(["Enter","Tab","Backspace","Delete","Escape","ArrowUp","ArrowDown","ArrowLeft","ArrowRight","PageUp","PageDown","Home","End"].indexOf(e.key)>=0){e.preventDefault();press(e.key)}});
  window.addEventListener("message",function(event){var m=event.data;if(!m||m.jsonrpc!=="2.0")return;if(m.id!==undefined&&(m.result!==undefined||m.error!==undefined)){var p=pending[m.id];if(!p)return;delete pending[m.id];if(m.error)p.reject(new Error(m.error.message||"RPC error"));else p.resolve(m.result);return}if(m.method==="ui/notifications/host-context-changed"){var theme=m.params&&m.params.theme;document.documentElement.setAttribute("data-theme",theme==="dark"?"dark":"light");return}if(m.method==="ui/notifications/tool-input"){var a=m.params&&m.params.arguments||{};if(!started)open(typeof a.url==="string"?a.url:"",typeof a.sessionId==="string"?a.sessionId:"");return}if(m.method==="ui/notifications/tool-result"){apply(payload(m.params));return}if(m.method==="ping"&&m.id!==undefined){post({jsonrpc:"2.0",id:m.id,result:{}});return}if(m.method==="ui/resource-teardown"&&m.id!==undefined){post({jsonrpc:"2.0",id:m.id,result:{}});return}});
  rpc("ui/initialize",{appInfo:{name:"flujo-browser-view",version:"2.0.0"},appCapabilities:{availableDisplayModes:["inline","fullscreen","pip"]},protocolVersion:"${MCP_APPS_PROTOCOL_VERSION}"}).then(function(result){var theme=result&&result.hostContext&&result.hostContext.theme;document.documentElement.setAttribute("data-theme",theme==="dark"?"dark":"light");notify("ui/notifications/initialized",{});setTimeout(function(){if(!started)open("","")},400)}).catch(function(e){setStatus("App initialization failed: "+errorText(e),true)});
})();
</script>
</body>
</html>`;
