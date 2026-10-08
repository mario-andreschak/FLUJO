import { createHash, randomBytes } from 'node:crypto';
import { createControllerNativeToolGateway } from '@/backend/execution/extensions/controllerNativeTools';
import type { MCPServerConfig } from '@/shared/types/mcp';

const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function equipment() {
  const context=Object.freeze({});let active=true;
  const toolConfig={name:'seagulled-worker',transport:'streamable' as const,serverUrl:'http://127.0.0.1:12345/native-source/tools/mcp',
    headers:{Authorization:`Bearer ${'A'.repeat(43)}`},disabled:false,rootPath:'',env:{},_buildCommand:'',_installCommand:''};
  const calls:{tool:string;args:Record<string,unknown>;ticket:string}[]=[];
  const gateway=createControllerNativeToolGateway({toolConfig,
    async assertRun(received){if(received!==context||!active)throw new Error('Not current');},
    async issueTool(received,tool,args){expect(received).toBe(context);const ticket=randomBytes(32).toString('base64url');calls.push({tool,args,ticket});return {ticket};},
  });
  return {context,gateway,calls,toolConfig,stop(){active=false;}};
}

test('gateway pins the trusted private server and refuses configuration changes',()=>{
  const e=equipment();expect(e.gateway.isProtectedServer('seagulled-worker')).toBe(true);
  e.gateway.assertServerConfig(e.toolConfig as MCPServerConfig);
  for(const changed of [{serverUrl:'http://foreign/'},{headers:{Authorization:'Bearer foreign'}},{command:'sh'},
    {sampling:{enabled:true}},{exposeAsMcpServer:true}]) {
    expect(()=>e.gateway.assertServerConfig({...e.toolConfig,...changed} as MCPServerConfig)).toThrow();
  }
});

test('only model dispatch from the actual remote context reaches the owned tools',async()=>{
  const e=equipment();await e.gateway.assertDispatch(e.context,'seagulled-worker','model');
  await e.gateway.assertModelTool(e.context,'offered-name',{server:'seagulled-worker',tool:'worker_command'});
  for(const [context,server,source] of [[undefined,'seagulled-worker','model'],[{},'seagulled-worker','model'],
    [e.context,'filesystem','model'],[e.context,'seagulled-worker','host']] as const) {
    await expect(e.gateway.assertDispatch(context,server,source)).rejects.toThrow();
  }
  await expect(e.gateway.assertModelTool(e.context,'local-shell',undefined)).rejects.toThrow();
  e.stop();await expect(e.gateway.requestMeta(e.context,'seagulled-worker','worker_command',{command:'fixture only'})).rejects.toThrow();
  expect(e.calls).toHaveLength(0);
});

test('final arguments receive one-use receipts and private metadata is removed',async()=>{
  const e=equipment(), args={path:'repo/file',content:'fixture'};
  const metadata=await e.gateway.requestMeta(e.context,'seagulled-worker','worker_write_file',args);
  const ticket=(metadata.seagulledNative as {ticket:string}).ticket;
  const result={content:[{type:'text',text:'fixture'}],_meta:{seagulledNative:{ticket,name:'worker_write_file',argsDigest:hash(args)}}};
  expect(e.gateway.validateResult(e.context,'worker_write_file',result)).toEqual({content:result.content});
  expect(()=>e.gateway.validateResult(e.context,'worker_write_file',result)).toThrow();
  expect(e.calls[0].args).toEqual(args);expect(e.calls[0].args).not.toBe(args);
});

test('mismatched and foreign receipts cannot become model results',async()=>{
  const e=equipment(), args={path:'repo/file'};
  const metadata=await e.gateway.requestMeta(e.context,'seagulled-worker','worker_read_file',args);
  const ticket=(metadata.seagulledNative as {ticket:string}).ticket;
  const result={content:[],_meta:{seagulledNative:{ticket,name:'worker_write_file',argsDigest:hash(args)}}};
  expect(()=>e.gateway.validateResult(e.context,'worker_read_file',result)).toThrow();
  result._meta.seagulledNative.name='worker_read_file';
  expect(()=>e.gateway.validateResult(e.context,'worker_read_file',result)).toThrow();
  expect(()=>e.gateway.validateResult({},'worker_read_file',result)).toThrow();
});

test('concurrent tool calls retain separate receipts on the same context',async()=>{
  const e=equipment();const args=[{path:'repo/a'},{path:'repo/b'}];
  const issued=await Promise.all(args.map(arg=>e.gateway.requestMeta(e.context,'seagulled-worker','worker_read_file',arg)));
  issued.forEach((meta,index)=>expect(e.gateway.validateResult(e.context,'worker_read_file',{content:[],
    _meta:{seagulledNative:{...(meta.seagulledNative as {ticket:string}),name:'worker_read_file',argsDigest:hash(args[index])}}})).toEqual({content:[]}));
});

test('gateway refuses caller routing, traversal, unknown tools and unimplemented children',async()=>{
  const e=equipment();
  for(const args of [{path:'../db/auth'},{path:'repo/file',target:'foreign'},{path:'/host/auth'}]) {
    await expect(e.gateway.requestMeta(e.context,'seagulled-worker','worker_read_file',args)).rejects.toThrow();
  }
  await expect(e.gateway.requestMeta(e.context,'seagulled-worker','local_shell',{command:'fixture'})).rejects.toThrow();
  expect(()=>e.gateway.authorizeHandoffs(e.context,['start_subflow_'])).toThrow('controller_native_child_unavailable');
  expect(e.calls).toHaveLength(0);
});
