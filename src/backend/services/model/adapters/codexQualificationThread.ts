import type { ThreadEvent, ThreadItem, Usage } from '@openai/codex-sdk';
import { startOwnedCodexAppServer, type CodexOwnedProcessRegistration } from './codexAppServerProcess';
import { nativeCodexStartupArguments, nativeCodexThreadConfiguration } from './codexNativeStartup';

type RecordValue = Record<string, unknown>;
type Notification = Readonly<{method?: string; params?: unknown}>;
type OwnedUsage = Omit<Usage,'cache_write_input_tokens'> & Partial<Pick<Usage,'cache_write_input_tokens'>>;
type OwnedEvent = Exclude<ThreadEvent, {type: 'turn.completed'}> | {type: 'turn.completed'; usage?: OwnedUsage};
const object = (value: unknown): RecordValue => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid owned Codex protocol value.');
  return value as RecordValue;
};
const identifier = (value: unknown): string => {
  if (typeof value !== 'string' || !value || value.length > 256) throw new Error('Invalid owned Codex protocol identity.');
  return value;
};
const token = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid Codex token usage.');
  return value;
};
function usage(value: unknown): OwnedUsage {
  const input = object(value);
  return {input_tokens:token(input.inputTokens),cached_input_tokens:token(input.cachedInputTokens),
    ...(input.cacheWriteInputTokens===undefined?{}:{cache_write_input_tokens:token(input.cacheWriteInputTokens)}),
    output_tokens:token(input.outputTokens),reasoning_output_tokens:token(input.reasoningOutputTokens)};
}

/** One accepted Original owns one public app-server turn and one born child.
 * Its caller must register against the durable Original and gate the prompt.
 * CLI user-turn counts are distinct from Claude SDK agentic iteration counts.
 */
export function createQualificationCodexThread(input: {
  executable: string; env: NodeJS.ProcessEnv; cwd: string; owner: object;
  model: string; effort?: string; config: RecordValue; configOverrides?: readonly string[];
  register(process: CodexOwnedProcessRegistration): Promise<void>;
  beforePrompt(threadId:string): Promise<void>;
  observeUsage(value: {type:'codex-app-server-usage'; appServerTurns:1; usage:OwnedUsage}): Promise<void>;
  signal?: AbortSignal;
}) {
  let child: Awaited<ReturnType<typeof startOwnedCodexAppServer>> | undefined;
  let started=false, processClosed=false, threadId: string | undefined, turnId: string | undefined;
  let notificationBytes=0;
  const notifications: Notification[]=[];
  let wake: (()=>void) | undefined;
  const onNotification=(message: Notification) => {
    if(!started)return;
    notificationBytes+=Buffer.byteLength(JSON.stringify(message));
    if(notifications.length>=512 || notificationBytes>4*1024*1024)throw new Error('Owned Codex notification bound exceeded.');
    notifications.push(message);wake?.();
  };
  const close=async()=>{
    if (!child) return;
    await child.stop();
    const exit = await child.registration.exit;
    await child.registration.close;
    if (exit.code !== 0 || exit.signal !== null) {
      throw new Error('Codex qualification process exited unsuccessfully.');
    }
  };
  const result=Object.freeze({
    close,
    async runStreamed(prompt: string | Array<{type:'text';text:string}|{type:'local_image';path:string}>,options: {signal?:AbortSignal}={}) {
      async function* events(): AsyncGenerator<OwnedEvent> {
        if(started)throw new Error('Owned Codex Original cannot start a replacement turn.');
        started=true;
        input.signal?.throwIfAborted();options.signal?.throwIfAborted();
        let lastUsage: OwnedUsage | undefined;
        const text = new Map<string,string>();
        let primaryFailure: unknown;
        const abort=()=>{child?.registration.requestStop();wake?.();};
        options.signal?.addEventListener('abort',abort,{once:true});
        try {
          const authentication = input.config.model_provider === 'inventory' ? 'offline-inventory'
            : input.env.CODEX_API_KEY ? 'api-key' : 'chatgpt';
          child=await startOwnedCodexAppServer({executable:input.executable,
            args:['app-server','--stdio',...nativeCodexStartupArguments({cwd:input.cwd,config:input.config,
              authentication,neutralTrustOverrides:input.configOverrides})],env:input.env,cwd:input.cwd,
            owner:input.owner,register:input.register,signal:input.signal,onNotification});
          void child.registration.close.then(()=>{processClosed=true;wake?.();});
          options.signal?.throwIfAborted();
          await child.request('initialize',{clientInfo:{name:'flujo_source',title:'FLUJO Source',version:'3.46.3'}});
          child.notify('initialized');
          const thread=object(await child.request('thread/start',{model:input.model,cwd:input.cwd,
            sandbox:'read-only',approvalPolicy:'never',ephemeral:false,
            config:nativeCodexThreadConfiguration(input.config,authentication)}));
          if(thread.model!==input.model)throw new Error('Owned Codex thread changed the selected model.');
          threadId=identifier(object(thread.thread).id);
          yield {type:'thread.started',thread_id:threadId};
          await input.beforePrompt(threadId);
          input.signal?.throwIfAborted();options.signal?.throwIfAborted();
          const turn=object(await child.request('turn/start',{threadId,model:input.model,
            ...(input.effort?{effort:input.effort}:{}),input:typeof prompt==='string'?[{type:'text',text:prompt}]:prompt.map(item=>item.type==='text'?item:{type:'localImage',path:item.path})}));
          turnId=identifier(object(turn.turn).id);
          yield {type:'turn.started'};
          let completed=false;
          while(!completed) {
            input.signal?.throwIfAborted();options.signal?.throwIfAborted();
            if(!notifications.length) {
              let timer: NodeJS.Timeout | undefined;
              try {await new Promise<void>(resolve=>{wake=resolve;timer=setTimeout(resolve,1000);});}
              finally{wake=undefined;if(timer)clearTimeout(timer);}
              if(!notifications.length) {
                if(processClosed)throw new Error('Owned Codex process closed before turn completion.');
              }
              continue;
            }
            const message=notifications.shift()!;notificationBytes-=Buffer.byteLength(JSON.stringify(message));
            const params=object(message.params??{});
            if(params.threadId!==undefined && params.threadId!==threadId)continue;
            if(params.turnId!==undefined && params.turnId!==turnId)continue;
            if(message.method==='model/rerouted')throw new Error('Owned Codex model rerouting is not authorized.');
            if(message.method==='thread/tokenUsage/updated') {
              lastUsage=usage(object(params.tokenUsage).last);continue;
            }
            if(message.method==='item/agentMessage/delta') {
              const id=identifier(params.itemId);
              if(typeof params.delta!=='string')throw new Error('Invalid Codex message delta.');
              const accumulated=(text.get(id)??'')+params.delta;text.set(id,accumulated);
              yield {type:'item.updated',item:{type:'agent_message',id,text:accumulated}};continue;
            }
            if(message.method==='item/started' || message.method==='item/completed') {
              const item=object(params.item);const id=identifier(item.id);
              let mapped: ThreadItem | undefined;
              if(item.type==='agentMessage') {
                if(typeof item.text!=='string')throw new Error('Invalid Codex agent message.');
                mapped={type:'agent_message',id,text:item.text};
              } else if(item.type==='reasoning')mapped={type:'reasoning',id,text:''};
              else if(item.type==='mcpToolCall') {
                const status=item.status==='inProgress'?'in_progress':item.status;
                if(status!=='in_progress'&&status!=='completed'&&status!=='failed')throw new Error('Invalid Codex MCP status.');
                const nativeResult=item.result?object(item.result):undefined;
                if(nativeResult && !Array.isArray(nativeResult.content))throw new Error('Invalid Codex MCP result.');
                mapped={type:'mcp_tool_call',id,server:identifier(item.server),tool:identifier(item.tool),arguments:item.arguments,status,
                  ...(nativeResult?{result:{content:nativeResult.content as never,structured_content:nativeResult.structuredContent,_meta:nativeResult._meta}}:{}),
                  ...(item.error?{error:{message:String(object(item.error).message)}}:{})};
              } else if(item.type!=='userMessage' && item.type!=='contextCompaction')throw new Error('Owned Codex produced an unapproved native item.');
              if(mapped)yield {type:message.method==='item/started'?'item.started':'item.completed',item:mapped};
              continue;
            }
            if(message.method==='turn/completed') {
              const terminal=object(params.turn);
              if(terminal.id!==turnId)continue;
              if(terminal.status==='completed') {
                if(lastUsage)await input.observeUsage({type:'codex-app-server-usage',appServerTurns:1,usage:lastUsage});
                yield {type:'turn.completed',usage:lastUsage};completed=true;
              } else if(terminal.status==='failed' || terminal.status==='interrupted') {
                yield {type:'turn.failed',error:{message:terminal.status==='interrupted'?'Codex turn interrupted.':'Codex app-server turn failed.'}};completed=true;
              } else throw new Error('Invalid Codex terminal status.');
            }
          }
        } catch (error) {
          primaryFailure = error;
          throw error;
        } finally {
          options.signal?.removeEventListener('abort',abort);
          try { await close(); }
          catch (closureError) {
            if (primaryFailure !== undefined) throw new AggregateError([primaryFailure, closureError],
              'Codex qualification failed and process closure remains unconfirmed.');
            throw closureError;
          } finally { notifications.length=0;notificationBytes=0; }
        }
      }
      return {events:events()};
    },
  });
  return result;
}
