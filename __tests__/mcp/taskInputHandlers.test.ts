import { registerRootsHandler } from '@/backend/services/mcp/roots';
const getModel = jest.fn();
const completion = jest.fn();
jest.mock('@/backend/services/model', () => ({ modelService: { getModel: (...args: unknown[]) => getModel(...args), resolveAndDecryptApiKey: jest.fn(async () => 'offline') } }));
jest.mock('@/backend/services/model/adapters', () => ({ getCompletionAdapter: () => ({ createCompletion: (...args: unknown[]) => completion(...args) }) }));
const emit = jest.fn();
jest.mock('@/backend/execution/flow/engine/ExecutionEventBus', () => ({ executionEventBus: { emitterFor: () => emit } }));
import { dispatchTaskInputRequest, registerTaskInputHandler } from '@/backend/services/mcp/taskInputHandlers';
import { registerSamplingHandler } from '@/backend/services/mcp/sampling';
import { registerElicitationHandler } from '@/backend/services/mcp/elicitation';
import { setElicitationContext, clearElicitationContext } from '@/backend/services/mcp/elicitationContext';
import { resolveElicitation, clearAllElicitations } from '@/backend/services/mcp/elicitationRegistry';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { MCPServerConfig } from '@/shared/types/mcp';

const request = { method: 'sampling/createMessage', params: { maxTokens: 20, messages: [{ role: 'user', content: { type: 'text', text: 'offline' } }] } };
function clientFixture() {
  const inbound = new Map<unknown, (request: {params?:unknown}) => Promise<unknown>>();
  const client = { setRequestHandler: (schema: unknown, handler: (request: {params?:unknown}) => Promise<unknown>) => inbound.set(schema, handler) } as unknown as Client;
  return { client, inbound };
}
beforeEach(() => { getModel.mockReset().mockResolvedValue({name:'offline',ApiKey:'offline',adapter:'openai'}); completion.mockReset().mockResolvedValue({completion:{choices:[{message:{content:'answer'}}]}}); emit.mockClear(); });
afterEach(() => { clearAllElicitations(); clearElicitationContext('input-test'); });

it('requires registered policy and rejects unknown methods or malformed request/result', async () => {
  const client = {};
  await expect(dispatchTaskInputRequest(client, request)).rejects.toThrow('not registered');
  await expect(dispatchTaskInputRequest(client, {method:'tools/call'})).rejects.toThrow('Unsupported');
  const handler = jest.fn(async () => ({role:'assistant',content:{type:'text',text:'ok'},model:'offline'}));
  registerTaskInputHandler(client, 'sampling/createMessage', handler);
  await expect(dispatchTaskInputRequest(client, {...request,params:{}})).rejects.toThrow();
  expect(handler).not.toHaveBeenCalled();
  handler.mockResolvedValue({} as never);
  await expect(dispatchTaskInputRequest(client, request)).rejects.toThrow();
});

it('shares the legacy sampling limiter across keyed inputs on one live client', async () => {
  const {client,inbound}=clientFixture();
  registerSamplingHandler(client, {name:'input-test',sampling:{enabled:true,modelId:'offline',maxCallsPerMinute:1}} as MCPServerConfig);
  await [...inbound.values()][0](request);
  await expect(dispatchTaskInputRequest(client,request)).rejects.toThrow('rate limit');
  expect(completion).toHaveBeenCalledTimes(1);
  const other=clientFixture().client;
  registerSamplingHandler(other, {name:'input-test',sampling:{enabled:true,modelId:'offline',maxCallsPerMinute:1}} as MCPServerConfig);
  await expect(dispatchTaskInputRequest(other,request)).resolves.toMatchObject({content:{text:'answer'}});
});

it('checks cancellation and generation after model lookup before invoking a provider', async () => {
  const {client}=clientFixture();
  registerSamplingHandler(client,{name:'input-test',sampling:{enabled:true,modelId:'offline'}} as MCPServerConfig);
  const controller=new AbortController();
  getModel.mockImplementation(async () => {controller.abort();return {name:'offline'};});
  await expect(dispatchTaskInputRequest(client,request,{signal:controller.signal})).rejects.toThrow();
  expect(completion).not.toHaveBeenCalled();
});

it('checks freshness after a handler completes and rejects an obsolete answer', async () => {
  const client={}; let current=true;
  registerTaskInputHandler(client,'sampling/createMessage',async()=>{current=false;return {role:'assistant',content:{type:'text',text:'old'},model:'offline'};});
  await expect(dispatchTaskInputRequest(client,request,{assertCurrent:()=>{if(!current)throw new Error('obsolete');}})).rejects.toThrow('obsolete');
});

it('cancels attended form input immediately and removes its real pending registry entry', async () => {
  const {client}=clientFixture();
  registerElicitationHandler(client,{name:'input-test',elicitation:{enabled:true}} as MCPServerConfig);
  setElicitationContext('input-test',{conversationId:'offline-conversation',getUnattended:()=>false});
  const controller=new AbortController();
  const pending=dispatchTaskInputRequest(client,{method:'elicitation/create',params:{mode:'form',message:'Offline input',requestedSchema:{type:'object',properties:{}}}},{signal:controller.signal});
  const rejection=expect(pending).rejects.toThrow();
  for(let turn=0;turn<12 && !emit.mock.calls.length;turn++) await Promise.resolve();
  const event=emit.mock.calls.find(([event])=>event.type==='run:awaiting_elicitation')?.[0];
  expect(event).toBeDefined();
  controller.abort(); await rejection;
  expect(resolveElicitation(event.elicitationId,{action:'accept',content:{}})).toBe(false);
  expect(emit).toHaveBeenCalledWith({type:'run:elicitation_cancelled',elicitationId:event.elicitationId});
});

it('awaits asynchronous generation validation before dispatch', async () => {
  const client={}; const handler=jest.fn(async()=>({action:'cancel'}));
  registerTaskInputHandler(client,'elicitation/create',handler);
  await expect(dispatchTaskInputRequest(client,{method:'elicitation/create',params:{mode:'form',message:'offline',requestedSchema:{type:'object',properties:{}}}},{assertCurrent:async()=>{await Promise.resolve();throw new Error('generation retired');}})).rejects.toThrow('generation retired');
  expect(handler).not.toHaveBeenCalled();
});
it('releases an aborted task caller while leaving a separate pending owner operation intact', async () => {
  const client={}; let finish!: (value: unknown)=>void;
  const pending=new Promise(resolve=>{finish=resolve;});
  const handler=jest.fn(()=>pending);
  registerTaskInputHandler(client,'elicitation/create',handler);
  const controller=new AbortController();
  const result=dispatchTaskInputRequest(client,{method:'elicitation/create',params:{mode:'url',message:'OAuth',elicitationId:'owned',url:'https://example.invalid/oauth'}},{signal:controller.signal});
  const rejection=expect(result).rejects.toThrow();
  for(let turn=0;turn<12&&!handler.mock.calls.length;turn++)await Promise.resolve();
  expect(handler).toHaveBeenCalledTimes(1);
  controller.abort(); await rejection;
  finish({action:'accept'}); await pending;
});

it('denies unregistered roots input and validates the registered roots result', async () => {
  const client={};
  await expect(dispatchTaskInputRequest(client,{method:'roots/list'})).rejects.toThrow('not registered');
  registerTaskInputHandler(client,'roots/list',async()=>({roots:[{uri:'https://example.invalid/not-a-file-root'}]}));
  await expect(dispatchTaskInputRequest(client,{method:'roots/list'})).rejects.toThrow();
});

it('uses the exact live roots closure and preserves isolated-server empty roots', async () => {
  const {client,inbound}=clientFixture();
  registerRootsHandler(client,{name:'input-test',transport:'stdio',isolation:{profileId:'offline'},roots:['/sensitive-host-root']} as unknown as MCPServerConfig);
  const legacy=await [...inbound.values()][0]({});
  expect(legacy).toEqual({roots:[]});
  await expect(dispatchTaskInputRequest(client,{method:'roots/list'})).resolves.toEqual(legacy);
});