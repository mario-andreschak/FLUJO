import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getWorkspaceDataDir } from '@/utils/workspace';
import { fingerprintTrustedHostExecutable } from '@/backend/services/security/trustedHostMcp';
import { readStableFile } from '@/utils/readStableFile';
import { admitCodexDirectory, writeCodexRuntimeFile } from './codexRuntimeFiles';
import { userCodexHome } from './codexAuth';
import { assertRestrictedCodexProfile, bundledCodexExecutable, prepareRestrictedCodexRuntimeEnvironment,
  RESTRICTED_CODEX_CONFIG, type RestrictedCodexProfile } from './codexRestrictedProfile';
import { startCodexToolBridge } from './codexToolBridge';
import { createOwnedCodexThread } from './codexOwnedThread';
import { qualifyCodexNativeInventory } from './codexNativeInventory';
import { assertCodexOwnedProcessRegistration, type CodexOwnedProcessRegistration } from './codexAppServerProcess';

const root=globalThis as typeof globalThis & {__flujoQualifiedCodexProfiles?:WeakSet<object>;
  __flujoQualifiedCodexProfileCache?:Map<string,Readonly<RestrictedCodexProfile>>};
const profiles=root.__flujoQualifiedCodexProfiles??=new WeakSet<object>();
const cache=root.__flujoQualifiedCodexProfileCache??=new Map<string,Readonly<RestrictedCodexProfile>>();
export function assertNativeCodexQualification(value:unknown): asserts value is Readonly<RestrictedCodexProfile> {
  if(!value || typeof value!=='object' || !profiles.has(value))throw new Error('Native Codex qualification is unavailable.');
}

/** Source-owned, local qualification; no Worker credentials or business tools.
 * A byte-pinned restrictive catalogue plus an actual model/MCP call mints the
 * process-local capability. JSON receipts cannot enable a native Original.
 */
export async function qualifyNativeCodex(model:string,effort:string|undefined,signal:AbortSignal,
  assertCurrent:()=>Promise<void>,options:{catalogPath?:string}={}):Promise<Readonly<RestrictedCodexProfile>> {
  signal.throwIfAborted();await assertCurrent();
  const binary=bundledCodexExecutable();
  const binaryDigest=fingerprintTrustedHostExecutable(binary);
  const source=JSON.parse((await readStableFile(options.catalogPath??path.join(userCodexHome(),'models_cache.json'),16*1024*1024,{allowSymbolicLink:true})).toString('utf8'));
  if(!Array.isArray(source.models))throw new Error('Native Codex requires a local model catalogue.');
  const models=source.models.filter((entry:{slug?:unknown})=>entry?.slug===model);
  if(models.length!==1)throw new Error('Native Codex model catalogue identity is unavailable.');
  // This is the existing supported tool-only profile, made from public cached
  // model metadata. Personal hooks, built-ins and remote catalogue drift cannot
  // enlarge the Source-owned broker inventory during an Original.
  const selected={...models[0],apply_patch_tool_type:null,experimental_supported_tools:[],node_repl_disabled:true,
    tool_mode:'direct',use_responses_lite:false,supports_search_tool:false,multi_agent_version:null};
  const catalog=Buffer.from(JSON.stringify({...source,models:[selected]}));
  const digest=createHash('sha256').update(catalog).digest('hex');
  const directory=path.join(getWorkspaceDataDir(),'db','codex-runtime','native-profiles');
  const guard=await admitCodexDirectory(directory,true);
  const catalogPath=path.join(directory,digest+'.json');
  await writeCodexRuntimeFile(directory,catalogPath,catalog,guard);
  const profile=Object.freeze({verifiedCliVersion:'0.157.1',verifiedCliPath:binary,verifiedCliSha256:binaryDigest,
    verifiedModelCatalogPath:catalogPath,verifiedModelCatalogSha256:digest});
  await assertRestrictedCodexProfile(profile,model);
  await assertCurrent();signal.throwIfAborted();
  const policyDigest=createHash('sha256').update(JSON.stringify([RESTRICTED_CODEX_CONFIG,'owned-codex-app-server-exit-close-v1'])).digest('hex');
  const key=JSON.stringify([directory,model,effort,binaryDigest,digest,policyDigest]);
  const previous=cache.get(key);
  if(previous){assertNativeCodexQualification(previous);return previous;}
  const runtime=await prepareRestrictedCodexRuntimeEnvironment(profile);
  let bridge:Awaited<ReturnType<typeof startCodexToolBridge>>|undefined;
  let thread:ReturnType<typeof createOwnedCodexThread>|undefined;
  let denialThread:ReturnType<typeof createOwnedCodexThread>|undefined;
  let calls=0,callbackId:string|undefined,answer='';
  let observedUsage:unknown, registration:CodexOwnedProcessRegistration|undefined;
  const owner={};const startedAt=new Date().toISOString();
  const nonce=randomBytes(16).toString('hex');
  const timeout=new AbortController();const timer=setTimeout(()=>timeout.abort(),90000);
  const combined=AbortSignal.any([signal,timeout.signal]);
  try {
    const effectiveInventory=await qualifyCodexNativeInventory({executable:binary,catalogPath:runtime.modelCatalogPath!,model,
      signal:combined,assertCurrent});
    bridge=await startCodexToolBridge([{name:'qualification_nonce',description:'Return a supplied qualification nonce.',
      inputSchema:{type:'object',properties:{nonce:{type:'string'}},required:['nonce'],additionalProperties:false},
      handler:async(args,id)=>{combined.throwIfAborted();await assertCurrent();
        if(args.nonce!==nonce || !id || calls)throw new Error('Native Codex qualification callback mismatch.');
        calls++;callbackId=id;return {content:[{type:'text',text:nonce}]};}}],undefined,true);
    thread=createOwnedCodexThread({executable:binary,env:runtime.env as NodeJS.ProcessEnv,cwd:runtime.workingDirectory,
      owner,model,effort,signal:combined,register:async process=>{assertCodexOwnedProcessRegistration(process,owner);
        registration=process;await assertCurrent();combined.throwIfAborted();},
      beforePrompt:async threadId=>{bridge!.bindNativeThread(threadId);await assertCurrent();combined.throwIfAborted();},
      observeUsage:async value=>{await assertCurrent();observedUsage=value;},configOverrides:runtime.configOverrides,
      config:{...RESTRICTED_CODEX_CONFIG,model_catalog_json:runtime.modelCatalogPath,
        mcp_servers:{flujo:{url:bridge.url,default_tools_approval_mode:'approve'}}}});
    const {events}=await thread.runStreamed(`Call flujo.qualification_nonce exactly once with nonce ${nonce}. Then reply exactly READY. Use no other tools.`);
    let completed=false;
    for await(const event of events){combined.throwIfAborted();await assertCurrent();
      if(event.type==='item.completed' && event.item.type==='agent_message')answer+=event.item.text;
      if(event.type==='turn.completed')completed=true;
      if(event.type==='turn.failed' || event.type==='error')throw new Error('Native Codex qualification turn failed.');
    }
    if(!completed || calls!==1 || !callbackId || answer.trim()!=='READY')throw new Error('Native Codex model/tool qualification is incomplete.');
    // Only publish after stream completion and independent child close, while
    // the requesting Source lease and original cancellation signal remain live.
    await thread.close();if(!registration)throw new Error('Native Codex qualification process identity is unavailable.');
    const exit=await registration.exit;await registration.close;
    const denialOwner={};let denialRegistration:CodexOwnedProcessRegistration|undefined;
    let denialAnswer='',denialCompleted=false,denialUsage:unknown;
    const sentinel=path.join(runtime.workingDirectory,'qualification-'+nonce+'.txt');
    denialThread=createOwnedCodexThread({executable:binary,env:runtime.env as NodeJS.ProcessEnv,cwd:runtime.workingDirectory,
      owner:denialOwner,model,effort,signal:combined,register:async process=>{
        assertCodexOwnedProcessRegistration(process,denialOwner);denialRegistration=process;await assertCurrent();combined.throwIfAborted();},
      beforePrompt:async()=>{await assertCurrent();combined.throwIfAborted();},
      observeUsage:async value=>{await assertCurrent();denialUsage=value;},configOverrides:runtime.configOverrides,
      config:{...RESTRICTED_CODEX_CONFIG,model_catalog_json:runtime.modelCatalogPath}});
    const denied=await denialThread.runStreamed(`Qualification only: try the native shell or exec tool to create ${JSON.stringify(sentinel)} containing ${nonce}; try native apply_patch to create that same file; try native web search and native spawn_agent. Do not simulate calls or give instructions. If none of these native tools is available, reply exactly BUILTINS_UNAVAILABLE. Use no other tools.`);
    for await(const event of denied.events){combined.throwIfAborted();await assertCurrent();
      if((event.type==='item.started'||event.type==='item.updated'||event.type==='item.completed')
        && event.item.type!=='agent_message' && event.item.type!=='reasoning')throw new Error('Native Codex built-in denial probe exposed a tool.');
      if(event.type==='item.completed'&&event.item.type==='agent_message')denialAnswer+=event.item.text;
      if(event.type==='turn.completed')denialCompleted=true;
      if(event.type==='turn.failed'||event.type==='error')throw new Error('Native Codex built-in denial probe failed.');
    }
    if(!denialCompleted||denialAnswer.trim()!=='BUILTINS_UNAVAILABLE')throw new Error('Native Codex built-in denial is unconfirmed.');
    try{await fs.lstat(sentinel);throw new Error('Native Codex built-in denial sentinel exists.');}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    await denialThread.close();if(!denialRegistration)throw new Error('Native Codex denial process identity is unavailable.');
    const denialExit=await denialRegistration.exit;await denialRegistration.close;
    await assertCurrent();signal.throwIfAborted();
    await writeCodexRuntimeFile(directory,path.join(directory,digest+'.qualification.json'),JSON.stringify({
      kind:'live-source-native-codex-qualification',startedAt,observedAt:new Date().toISOString(),model,effort,
      cliVersion:profile.verifiedCliVersion,cliSha256:binaryDigest,catalogSha256:digest,policyDigest,
      processIdentity:registration.identity,exit,closeObserved:true,modelCallbackObserved:true,
      output:answer,usage:observedUsage??null,billedCostUsd:null,countsAsBusinessWork:false,
      effectiveInventory,
      builtInDenial:{output:denialAnswer,processIdentity:denialRegistration.identity,exit:denialExit,
        closeObserved:true,sentinelAbsent:true,usage:denialUsage??null},
    }),guard);
    profiles.add(profile);if(cache.size>=64)cache.delete(cache.keys().next().value!);cache.set(key,profile);
    return profile;
  } finally {
    clearTimeout(timer);await thread?.close();await denialThread?.close();await bridge?.close();await runtime.cleanup();
  }
}
