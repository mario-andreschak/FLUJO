import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Server as ModernServer, createMcpHandler } from '@modelcontextprotocol/server';

export const appUri = 'ui://apps-acceptance/view';
const resourceUri = 'receipt://apps-acceptance/value';
export async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}
export async function unusedPort() {
  const server = http.createServer(); const port = await listen(server);
  await new Promise(resolve => server.close(resolve)); return port;
}

/** Reference View sends real browser postMessage RPC; no host APIs are mocked. */
function viewHtml(origin, deniedOrigin) {
  return `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Apps acceptance View</title>
<style>body{font:16px system-ui;margin:12px;overflow-wrap:anywhere}button{min-height:44px;margin:4px;max-width:100%}pre{white-space:pre-wrap}h1{font-size:20px}</style>
<h1>Apps acceptance View</h1><p id="status" role="status">Initializing</p><code id="mount"></code>
<div id="controls"></div><pre id="receipt"></pre>
<script>(()=>{
 const origin=${JSON.stringify(origin)},denied=${JSON.stringify(deniedOrigin)};
 const state=window.appReceipt={mount:crypto.randomUUID(),events:[],results:{},started:{},clicks:[],violations:[]};
 document.getElementById('mount').textContent=state.mount;
 const pending=new Map();let serial=0;
 const show=()=>document.getElementById('receipt').textContent=JSON.stringify(state);
 const post=message=>parent.postMessage(message,'*');
 const rpc=(method,params)=>new Promise(resolve=>{const id='view-'+(++serial);pending.set(id,resolve);post({jsonrpc:'2.0',id,method,params});});
 const observe=event=>fetch(origin+'/observation',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mount:state.mount,event}),keepalive:true}).catch(()=>{});
 document.addEventListener('click',event=>state.clicks.push({id:event.target.id,trusted:event.isTrusted,x:event.clientX,y:event.clientY}),true);
 const add=(label,key,action)=>{const button=document.createElement('button');button.textContent=label;button.id=key;button.disabled=true;button.onclick=async()=>{state.started[key]=(state.started[key]??0)+1;try{state.results[key]=await action();}catch(error){state.results[key]={error:String(error)};}show();};document.getElementById('controls').append(button);};
 const call=(name,marker)=>rpc('tools/call',{name,arguments:{marker}});
 add('Call allowed tool','allowed',()=>call('app_echo','allowed'));
 add('Call model-only tool','hidden',()=>call('model_only','hidden'));
 add('Call another server','foreign',()=>call('apps-other__app_echo','foreign'));
 add('Read allowed resource','resource',()=>rpc('resources/read',{uri:${JSON.stringify(resourceUri)}}));
 add('Check network and frames','csp',async()=>{
   const allowed=await fetch(origin+'/allowed',{signal:AbortSignal.timeout(3000)}).then(response=>response.text());
   let blocked=false;try{await fetch(denied+'/blocked',{signal:AbortSignal.timeout(3000)});}catch{blocked=true;}
   const frame=document.createElement('iframe');frame.title='Undeclared frame';frame.src=denied+'/frame';document.body.append(frame);
   return {allowed,blocked};
 });
 add('Open safe link','safe',()=>rpc('ui/open-link',{url:origin+'/safe-link'}));
 add('Reject unsafe link','unsafe',()=>rpc('ui/open-link',{url:'javascript:window.badLinkExecuted=true'}));
 add('Download receipt','download',()=>rpc('ui/download-file',{contents:[{type:'resource',resource:{uri:'receipt://files/acceptance.txt',mimeType:'text/plain',text:'Apps browser acceptance'}}]}));
 add('Send reserved message','reserved',async()=>{post({jsonrpc:'2.0',method:'ui/notifications/sandbox-proxy-ready',params:{}});return {sent:true};});
 add('Start pending tool','pending',()=>call('app_wait','pending'));
 window.addEventListener('securitypolicyviolation',event=>{state.violations.push(event.effectiveDirective);show();});
 window.addEventListener('message',event=>{
   if(event.source!==parent||event.data?.jsonrpc!=='2.0')return;
   const message=event.data;
   if(message.method){state.events.push(message.method);}
   if(pending.has(message.id)){const resolve=pending.get(message.id);pending.delete(message.id);resolve(message);}
   if(message.id==='initialize'&&message.result){
     state.initialize=message.result;post({jsonrpc:'2.0',method:'ui/notifications/initialized',params:{}});
     state.events.push('view/initialized');document.querySelectorAll('button').forEach(button=>button.disabled=false);
     document.getElementById('status').textContent='Ready';
     post({jsonrpc:'2.0',method:'ui/notifications/size-changed',params:{height:650}});
   }
   if(message.method==='ui/resource-teardown'){
     void observe('teardown').then(()=>post({jsonrpc:'2.0',id:message.id,result:{}}));
   }else if(message.method==='ping')post({jsonrpc:'2.0',id:message.id,result:{}});
   show();
 });
 post({jsonrpc:'2.0',id:'initialize',method:'ui/initialize',params:{appInfo:{name:'Apps acceptance View',version:'1.0.0'},appCapabilities:{},protocolVersion:'2026-01-26'}});
 show();
})();</script></html>`;
}

export async function createAppsFixture() {
  const sessions = new Map(), activeWaits = new Set();
  const state = { calls: [], reads: [], observations: [], deniedRequests: 0, allowedRequests: 0, cancelledWaits: 0 };
  const denied = http.createServer((request, response) => {
    if (request.url === '/health') { response.end('Healthy deny target'); return; }
    state.deniedRequests++; response.end('Unexpected request');
  });
  // Local grants deliberately normalize ports to '*'. Use a different hostname
  // to probe undeclared access rather than misrepresenting that existing policy.
  const deniedOrigin = `http://localhost:${await listen(denied)}`;
  assert.equal(await (await fetch(deniedOrigin + '/health')).text(), 'Healthy deny target');
  let origin;
  const tools = [
    { name: 'open_view', inputSchema: { type: 'object', properties: {} }, _meta: { ui: { resourceUri: appUri } } },
    { name: 'app_echo', inputSchema: { type: 'object', properties: { marker: { type: 'string' } } }, _meta: { ui: { visibility: ['app'] } } },
    { name: 'app_wait', inputSchema: { type: 'object', properties: { marker: { type: 'string' } } }, _meta: { ui: { visibility: ['app'] } } },
    { name: 'model_only', inputSchema: { type: 'object', properties: {} }, _meta: { ui: { visibility: ['model'] } } },
  ];
  const catalog = () => ({ resources: [{ name: 'Apps acceptance View', uri: appUri, mimeType: 'text/html;profile=mcp-app' }] });
  const read = (generation, uri) => {
    state.reads.push({ generation, uri });
    if (uri === resourceUri) return { contents: [{ uri, mimeType: 'text/plain', text: 'Actual server resource' }] };
    assert.equal(uri, appUri);
    return { contents: [{ uri, mimeType: 'text/html;profile=mcp-app', text: viewHtml(origin, deniedOrigin),
      _meta: { ui: { csp: { connectDomains: [origin], resourceDomains: [], frameDomains: [] } } } }] };
  };
  const call = async (generation, params, signal) => {
    assert.ok(signal instanceof AbortSignal, 'Reference tool handler must receive the SDK generation\'s real request signal');
    state.calls.push({ generation, name: params.name, marker: params.arguments?.marker });
    if (params.name === 'app_wait') {
      await new Promise(resolve => {
        const stop = () => { activeWaits.delete(stop); state.cancelledWaits++; resolve(); };
        activeWaits.add(stop); signal?.addEventListener('abort', stop, { once: true });
      });
    }
    return { content: [{ type: 'text', text: `Actual ${generation} tool result` }], structuredContent: { marker: params.arguments?.marker ?? 'opened' } };
  };
  const capabilities = { tools: {}, resources: {}, extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } };
  const modern = createMcpHandler(() => {
    const server = new ModernServer({ name: 'apps-modern', version: '1.0.0' }, { capabilities });
    server.setRequestHandler('tools/list', () => ({ tools }));
    server.setRequestHandler('resources/list', catalog);
    server.setRequestHandler('resources/templates/list', () => ({ resourceTemplates: [] }));
    server.setRequestHandler('resources/read', request => read('modern', request.params.uri));
    server.setRequestHandler('tools/call', (request, context) => call('modern', request.params, context.mcpReq.signal));
    return server;
  }, { legacy: 'reject' });
  const server = http.createServer(async (request, response) => {
    response.setHeader('access-control-allow-origin', '*'); response.setHeader('access-control-allow-headers', 'content-type');
    if (request.method === 'OPTIONS') { response.end(); return; }
    if (request.url === '/allowed') { state.allowedRequests++; response.end('Declared connection works'); return; }
    if (request.url === '/safe-link') { response.end('<title>Safe link destination</title>Safe link destination'); return; }
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const bytes = Buffer.concat(chunks); assert.ok(bytes.length <= 256 * 1024);
      const body = bytes.length ? JSON.parse(bytes.toString()) : undefined;
      if (request.url === '/observation') { state.observations.push(body); response.end('{}'); return; }
      if (request.url === '/modern') {
        const controller = new AbortController(); response.once('close', () => { if (!response.writableEnded) controller.abort(); });
        const result = await modern.fetch(new Request(origin + '/modern', { method: request.method, headers: request.headers,
          signal: controller.signal, ...(body ? { body: JSON.stringify(body) } : {}) }));
        response.writeHead(result.status, Object.fromEntries(result.headers));
        if (result.body) { const readable = Readable.fromWeb(result.body); response.once('close', () => readable.destroy()); readable.on('error', () => response.destroy()); readable.pipe(response); }
        else response.end(); return;
      }
      assert.ok(['/legacy', '/other'].includes(request.url));
      const generation = request.url === '/other' ? 'other' : 'legacy';
      let session = sessions.get(request.headers['mcp-session-id']);
      if (!session && body?.method === 'initialize') {
        const legacy = new Server({ name: 'apps-legacy', version: '1.0.0' }, { capabilities });
        legacy.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
        legacy.setRequestHandler(ListResourcesRequestSchema, catalog);
        legacy.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({ resourceTemplates: [] }));
        legacy.setRequestHandler(ReadResourceRequestSchema, request => read(generation, request.params.uri));
        legacy.setRequestHandler(CallToolRequestSchema, (request, extra) => call(generation, request.params, extra.signal));
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
        session = { server: legacy, transport }; await legacy.connect(transport);
      }
      assert.ok(session); await session.transport.handleRequest(request, response, body);
      if (session.transport.sessionId) sessions.set(session.transport.sessionId, session);
    } catch (error) { if (!response.headersSent) response.writeHead(500); response.end(String(error)); }
  });
  origin = `http://127.0.0.1:${await listen(server)}`;
  return { origin, deniedOrigin, state, activeWaits, async close() {
    for (const stop of activeWaits) stop();
    for (const session of sessions.values()) await session.server.close();
    await modern.close();
    for (const listener of [server, denied]) { listener.closeAllConnections(); await new Promise(resolve => listener.close(resolve)); }
  } };
}
