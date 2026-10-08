import { createHash } from 'node:crypto';
import type { MCPServerConfig } from '@/shared/types/mcp';
import { ExecutionExtensionError, type ExecutionExtensionAdapter } from './index';

type Gateway = Pick<ExecutionExtensionAdapter, 'isProtectedServer' | 'assertServerConfig' | 'protectedServer' |
  'authorizeHandoffs' | 'assertModelTool' | 'assertDispatch' | 'normalizeArguments' | 'requestMeta' | 'validateResult'>;
export interface ControllerNativeToolTransport {
  readonly toolConfig: Readonly<{ name: string; transport: string; serverUrl: string; headers: Readonly<Record<string,string>> }>;
  assertRun(context: object): Promise<void>;
  issueTool(context: object, name: string, args: Record<string,unknown>): Promise<{ ticket: string }>;
}
const tools = new Set(['worker_read_file','worker_write_file','worker_list_dir','worker_command']);
const refused = () => new ExecutionExtensionError('controller_native_tool_refused');
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function normalize(tool: string, args: Record<string,unknown>): Record<string,unknown> {
  if (!tools.has(tool) || !args || Array.isArray(args) || Buffer.byteLength(JSON.stringify(args))>16*1024) throw refused();
  const allowed = tool==='worker_command'?['command','cwd']:tool==='worker_write_file'?['path','content']:['path'];
  if (Object.keys(args).some(key=>!allowed.includes(key)) || Object.values(args).some(value=>typeof value!=='string'||value.includes('\0'))
    || (tool==='worker_command'?!String(args.command??'').trim():typeof args.path!=='string')
    || (tool==='worker_write_file'&&typeof args.content!=='string')) throw refused();
  const relative = tool==='worker_command'?args.cwd??'.':args.path;
  if(typeof relative!=='string'||!relative||relative.startsWith('/')||relative.includes('\\')||relative.includes(':')
    ||relative.split('/').some(segment=>!segment||segment==='..'))throw refused();
  return Object.freeze(structuredClone(args));
}

/** Trusted Source composition for the Parent's private Worker MCP endpoint.
 * Every dispatch gets a one-use Parent ticket bound to final arguments. Model
 * results contain business data only; private receipts never enter transcripts.
 * Child handoffs require a separate genuine Original implementation. */
export function createControllerNativeToolGateway(transport: ControllerNativeToolTransport): Gateway {
  const config=structuredClone(transport.toolConfig), address=new URL(config.serverUrl);
  if(config.name!=='seagulled-worker'||config.transport!=='streamable'||address.protocol!=='http:'
    ||address.hostname!=='127.0.0.1'||!address.port||address.pathname!=='/native-source/tools/mcp'
    ||address.search||address.hash||address.username||address.password
    ||Object.keys(config.headers).join()!=='Authorization'||!/^Bearer [A-Za-z0-9_-]{43}$/.test(config.headers.Authorization)
    ||typeof transport.assertRun!=='function'||typeof transport.issueTool!=='function')throw refused();
  const pending=new WeakMap<object,Map<string,{tool:string;argsDigest:string}>>();
  const current=async(context:object|undefined)=>{if(!context)throw refused();await transport.assertRun(context);};
  return {
    isProtectedServer:server=>server===config.name,
    assertServerConfig(received:MCPServerConfig) {
      if(received.name!==config.name)return;
      if(received.transport!=='streamable')throw refused();
      const authorization=received.headers?.Authorization;
      const secret=typeof authorization==='object'&&authorization!==null
        &&Object.keys(authorization).sort().join()==='metadata,value'
        &&Object.keys(authorization.metadata??{}).join()==='isSecret'&&authorization.metadata.isSecret===true;
      const headers={...received.headers,Authorization:secret?authorization.value:authorization};
      if(received.transport!=='streamable'||received.serverUrl!==config.serverUrl
        ||digest(headers)!==digest(config.headers)||'command' in received||'args' in received
        ||received.sampling?.enabled||received.elicitation?.enabled||received.exposeAsMcpServer
        ||received.enableMcpApps||received.enableMcpSkills)throw refused();
    },
    protectedServer:()=>config.name,
    authorizeHandoffs(_context,names) {
      // The Source adapter checks actual graph targets and installed child
      // plans. Detached/inline launches remain unavailable in this route.
      if(names.some(name=>!name.startsWith('handoff_to_')))throw new ExecutionExtensionError('controller_native_child_unavailable');
    },
    async assertModelTool(context,name,advertised) {
      await current(context);
      if(!name||!advertised||advertised.server!==config.name||!tools.has(advertised.tool))throw refused();
    },
    async assertDispatch(context,server,source) {
      await current(context);if(server!==config.name||source!=='model')throw refused();
    },
    normalizeArguments(_context,tool,args) {return normalize(tool,args);},
    async requestMeta(context,server,tool,args) {
      await current(context);if(server!==config.name)throw refused();
      const captured=normalize(tool,args), map=pending.get(context)??new Map<string,{tool:string;argsDigest:string}>();
      if(map.size>=100)throw refused();
      pending.set(context,map);
      const result=await transport.issueTool(context,tool,captured);
      if(!result||Object.keys(result).join()!=='ticket'||!/^[A-Za-z0-9_-]{43}$/.test(result.ticket)||map.has(result.ticket))throw refused();
      await current(context);map.set(result.ticket,{tool,argsDigest:digest(captured)});pending.set(context,map);
      return {seagulledNative:{ticket:result.ticket}};
    },
    validateResult(context,tool,result) {
      const value=result as {content?:unknown[];isError?:boolean;_meta?:{seagulledNative?:{ticket?:string;name?:string;argsDigest?:string}}};
      const receipt=value?._meta?.seagulledNative, map=pending.get(context), item=receipt?.ticket?map?.get(receipt.ticket):undefined;
      if(receipt?.ticket)map?.delete(receipt.ticket);
      if(!item||item.tool!==tool||receipt?.name!==tool||receipt.argsDigest!==item.argsDigest
        ||!Array.isArray(value.content)||value.isError)throw refused();
      // The receipt has been consumed, and Source rechecks current admission
      // before invoking this synchronous validator.
      const clean=structuredClone(result) as Record<string,unknown>;delete clean._meta;return clean;
    },
  };
}
