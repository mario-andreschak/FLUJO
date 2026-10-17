import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { createControllerNativeClient, type NativeSourceParent } from '@/backend/execution/extensions/controllerNativeClient';
import { createNativeSourceComposition } from '@/backend/execution/extensions/nativeSourceComposition';
import { registerExecutionExtension, executionExtensionCodexProfile, assertExecutionExtensionCurrent,
  bindExecutionExtensionRun, commitExecutionExtensionMutation, executionToolRequestMeta } from '@/backend/execution/extensions';
import type { RestrictedCodexProfile } from '@/backend/services/model/adapters/codexRestrictedProfile';

// Deterministic producer controls qualify Source consumption, not genuine
// Parent enrollment, account spending or a deployed fleet.
const claim = { runId:'parent-run',rootConversationId:'root-conversation',goalId:'goal',workspace:'workspace' };
const plan = { flowId:'flow',flowDigest:'a'.repeat(64),modelId:'luna',modelDigest:'b'.repeat(64) };
function equipment() {
  const remote = Object.freeze({});
  const abort = new AbortController();
  let held = false;
  let profile: RestrictedCodexProfile = { verifiedCliVersion:'0.157.1',verifiedCliSha256:'c'.repeat(64),
    verifiedCliPath:path.resolve('private-test-runtime/codex.exe'),
    verifiedModelCatalogPath:path.resolve('private-test-runtime/models.json'),verifiedModelCatalogSha256:'d'.repeat(64) };
  const assertRun = jest.fn(async (context: object) => { expect(context).toBe(remote); abort.signal.throwIfAborted(); });
  const close = jest.fn(async () => {});
  const parent: NativeSourceParent = {
    requester:{origin:'http://127.0.0.1:12345',authorization:`Bearer ${'A'.repeat(43)}`},
    codexProfile:jest.fn(async context => { await assertRun(context); return profile; }),
    transport:{bindingId:randomBytes(32).toString('hex'),
      toolConfig:{name:'seagulled-worker',transport:'streamable',serverUrl:'http://127.0.0.1:12346/native-source/tools/mcp',
        headers:{Authorization:`Bearer ${'B'.repeat(43)}`}},
      admit:jest.fn(async (authorization,received) => {
        if (authorization !== 'Bearer unit-only') throw new Error('Parent refused admission');
        expect(received).toEqual(claim); return remote;
      }),
      assertRun,
      readPlan:jest.fn(async context => { await assertRun(context); return { ...plan }; }),
      readChildren:jest.fn(async context => { await assertRun(context); return []; }),
      bindRun:jest.fn(async context => { await assertRun(context); }),
      readRoot:jest.fn(async context => { await assertRun(context); return { version:1 as const,workerId:'worker',goalId:claim.goalId,
        fleetRunId:claim.runId,rootConversationId:claim.rootConversationId,logicalRunId:'logical',workspace:claim.workspace,
        targetDigest:'e'.repeat(64),flowDigest:plan.flowDigest,leaseEpoch:'epoch',modelId:plan.modelId,modelDigest:plan.modelDigest }; }),
      issueTool:jest.fn(async context => { await assertRun(context); return { ticket:'C'.repeat(43) }; }),
      commit:jest.fn(async (context,task) => { await assertRun(context); held=true; try { return await task(); } finally { held=false; } }),
      observe:jest.fn(async context => { await assertRun(context); return { signal:abort.signal,close }; }),
    },
  };
  return { parent,remote,abort,close,assertRun,held:()=>held,profile:()=>profile,
    setProfile(value:RestrictedCodexProfile) { profile=value; } };
}

test('production composition delegates opaque ownership, tools, profile and the full awaited mutation fence', async () => {
  const e=equipment(), source=createNativeSourceComposition(e.parent), restore=registerExecutionExtension(source.adapter);
  let retained: Parameters<typeof assertExecutionExtensionCurrent>[0];
  try {
    await source.withWorkerRun('Bearer unit-only',claim,async context => {
      retained=context; await bindExecutionExtensionRun(context,claim.rootConversationId,'logical');
      expect(await executionExtensionCodexProfile(context)).toEqual(e.profile());
      expect(e.parent.codexProfile).toHaveBeenCalledWith(e.remote);
      await commitExecutionExtensionMutation(context,async () => {
        expect(e.held()).toBe(true); await new Promise<void>(resolve=>setImmediate(resolve)); expect(e.held()).toBe(true);
      });
      expect(e.held()).toBe(false);
      expect(await executionToolRequestMeta(context,'seagulled-worker','worker_read_file',{path:'document.txt'}))
        .toEqual({seagulledNative:{ticket:'C'.repeat(43)}});
      expect(e.parent.transport.issueTool).toHaveBeenCalledWith(e.remote,'worker_read_file',{path:'document.txt'});
    });
    expect(e.close).toHaveBeenCalledTimes(1);
    await expect(assertExecutionExtensionCurrent(retained)).rejects.toThrow();
  } finally { restore(); await source.close(); }
});

test('claims and local requester access cannot substitute for actual Parent admission', async () => {
  const e=equipment(), source=createNativeSourceComposition(e.parent), task=jest.fn();
  try {
    await expect(source.withWorkerRun('Bearer caller-local-api-grant',claim,task)).rejects.toThrow('Parent refused admission');
    expect(task).not.toHaveBeenCalled(); expect(e.parent.transport.readPlan).not.toHaveBeenCalled();
    expect(e.parent.codexProfile).not.toHaveBeenCalled();
  } finally { await source.close(); }
});

test('retires admitted Parent resources when initial observation fails and preserves independent cleanup failure', async () => {
  const e=equipment(), failure=new Error('observer failed'), cleanup=new Error('retirement failed');
  e.parent.transport.observe=jest.fn(async()=>{throw failure;});
  e.parent.transport.retire=jest.fn(async()=>{});
  const client=createControllerNativeClient(e.parent);
  try {
    await expect(client.admit('Bearer unit-only',claim)).rejects.toBe(failure);
    expect(e.parent.transport.retire).toHaveBeenCalledWith(e.remote);
    const second=equipment(); second.parent.transport.observe=jest.fn(async()=>{throw failure;});
    second.parent.transport.retire=jest.fn(async()=>{throw cleanup;});
    const failed=createControllerNativeClient(second.parent);
    try {
      await expect(failed.admit('Bearer unit-only',claim)).rejects.toMatchObject({errors:[failure,cleanup]});
    } finally {await failed.close();}
  } finally {await client.close();}
});

test('the client refuses copied capabilities and retires them even when observer cleanup fails', async () => {
  const e=equipment(), client=createControllerNativeClient(e.parent);
  const context=await client.admit('Bearer unit-only',claim);
  await expect(client.readPlan({...context})).rejects.toThrow('controller_native_client_refused');
  const watch=await client.observe(context), failure=new Error('unit observer close failure');
  e.close.mockRejectedValue(failure);
  await expect(watch.close()).rejects.toBe(failure);
  expect(watch.signal.aborted).toBe(true);
  await expect(client.readPlan(context)).rejects.toThrow();
  await client.close(); expect(e.close).toHaveBeenCalledTimes(1);
});

test('client forwards frozen plan expectations without a duplicate deep-current gate and rechecks revocation', async () => {
  const e=equipment();
  const expected={...plan},children=[{...plan,parentNodeId:'parent-node'}];
  const ownerAssertPlan=jest.fn(async (_context:object,_plan:typeof plan,_children:typeof children)=>{});
  e.parent.transport.assertPlan=ownerAssertPlan;
  const client=createControllerNativeClient(e.parent),context=await client.admit('Bearer unit-only',claim);
  e.assertRun.mockClear();
  try {
    await client.assertPlan!(context,expected,children);
    expect(ownerAssertPlan).toHaveBeenCalledTimes(1);
    const forwarded=ownerAssertPlan.mock.calls[0];
    expect(forwarded[0]).toBe(e.remote);
    expect(forwarded[1]).not.toBe(expected);
    expect(forwarded[2]).not.toBe(children);
    expect(Object.isFrozen(forwarded[1])).toBe(true);
    expect(Object.isFrozen(forwarded[2])).toBe(true);
    expect(Object.isFrozen(forwarded[2][0])).toBe(true);
    expect(e.assertRun).not.toHaveBeenCalled();

    let entered!:()=>void,release!:()=>void;
    const started=new Promise<void>(resolve=>{entered=resolve;});
    const gate=new Promise<void>(resolve=>{release=resolve;});
    ownerAssertPlan.mockImplementation(async()=>{entered();await gate;});
    const pending=client.assertPlan!(context,expected,children);
    await started;e.abort.abort(new Error('Parent revoked during plan gate'));release();
    await expect(pending).rejects.toThrow('Parent revoked during plan gate');
  } finally {await client.close();}
});

test('revocation while a tool ticket is pending refuses its returned authority', async () => {
  const e=equipment(), client=createControllerNativeClient(e.parent), context=await client.admit('Bearer unit-only',claim);
  let release!: (value:{ticket:string})=>void;
  jest.mocked(e.parent.transport.issueTool).mockImplementation(() => new Promise(resolve => { release=resolve; }));
  const issued=client.issueTool(context,'worker_read_file',{path:'document.txt'});
  while (!release) await new Promise<void>(resolve=>setImmediate(resolve));
  e.abort.abort(new Error('unit revocation')); release({ticket:'C'.repeat(43)});
  await expect(issued).rejects.toThrow('unit revocation'); await client.close();
});

test('revocation before observer setup closes the admitted Parent observer', async () => {
  const e=equipment(), client=createControllerNativeClient(e.parent), context=await client.admit('Bearer unit-only',claim);
  const revocation=new Error('unit pre-observation revocation');
  e.abort.abort(revocation);
  try {
    await expect(client.observe(context)).rejects.toBe(revocation);
    expect(e.close).toHaveBeenCalledTimes(1);
    await expect(client.readPlan(context)).rejects.toThrow();
  } finally { await client.close(); }
  expect(e.close).toHaveBeenCalledTimes(1);
});

test('pre-observation revocation retains an independent observer cleanup failure', async () => {
  const e=equipment(), client=createControllerNativeClient(e.parent), context=await client.admit('Bearer unit-only',claim);
  const revocation=new Error('unit pre-observation revocation'), cleanup=new Error('unit observer cleanup failure');
  e.abort.abort(revocation); e.close.mockRejectedValue(cleanup);
  try {
    await expect(client.observe(context)).rejects.toMatchObject({errors:[revocation,cleanup]});
    expect(e.close).toHaveBeenCalledTimes(1);
  } finally { e.close.mockResolvedValue(undefined); await client.close(); }
});

test('private profile is pinned per run and ordinary CLI or injected extra fields stay refused', async () => {
  const e=equipment(), client=createControllerNativeClient(e.parent), context=await client.admit('Bearer unit-only',claim);
  try {
    expect(Object.isFrozen(await client.codexProfile(context))).toBe(true);
    e.setProfile({...e.profile(),verifiedCliVersion:'0.162.1'});
    await expect(client.codexProfile(context)).rejects.toThrow('controller_native_client_refused');
    e.setProfile({...e.profile(),verifiedCliVersion:'0.157.1',verifiedCliSha256:'f'.repeat(64)});
    await expect(client.codexProfile(context)).rejects.toThrow('controller_native_client_refused');
    e.setProfile({...e.profile(),ApiKey:'unit-only'} as RestrictedCodexProfile);
    await expect(client.codexProfile(context)).rejects.toThrow('controller_native_client_refused');
  } finally { await client.close(); }
});

test('Parent config rotation and duplicate Parent contexts refuse new use', async () => {
  const e=equipment(), client=createControllerNativeClient(e.parent), context=await client.admit('Bearer unit-only',claim);
  try {
    await expect(client.admit('Bearer unit-only',claim)).rejects.toThrow('controller_native_client_refused');
    const before=e.assertRun.mock.calls.length;
    Object.assign(e.parent.transport.toolConfig.headers,{Authorization:`Bearer ${'D'.repeat(43)}`});
    await expect(client.assertRun(context)).rejects.toThrow('controller_native_client_refused');
    expect(e.assertRun.mock.calls).toHaveLength(before);
  } finally { await client.close(); }
});

test('invalid installed plan closes the observer and preserves independent cleanup errors', async () => {
  const e=equipment(), source=createNativeSourceComposition(e.parent);
  jest.mocked(e.parent.transport.readPlan).mockResolvedValue({...plan,flowDigest:'invalid'});
  const failure=new Error('unit cleanup failure'); e.close.mockRejectedValue(failure);
  try {
    await expect(source.withWorkerRun('Bearer unit-only',claim,async()=>{})).rejects.toMatchObject({
      errors:[expect.objectContaining({code:'controller_native_source_refused'}),failure],
    });
    expect(e.close).toHaveBeenCalledTimes(1);
  } finally { await source.close(); }
});

test('cold selected server graphs share the actual composed adapter and its opaque registry', async () => {
  const e=equipment();
  type Extensions = typeof import('@/backend/execution/extensions');
  type Selected = typeof import('@/backend/execution/extensions/configuredNativeSource');
  const state=globalThis as typeof globalThis & {__flujoExecutionExtensions?:unknown};
  const previous=state.__flujoExecutionExtensions;
  delete state.__flujoExecutionExtensions;
  const graph=() => {
    let extensions!:Extensions, selected!:Selected;
    jest.isolateModules(() => {
      jest.doMock('@/backend/execution/extensions/configuredNativeParent',()=>({nativeSourceParent:e.parent}));
      jest.doMock('@/backend/execution/extensions/configuredAdapter',()=>require('@/backend/execution/extensions/configuredNativeSource'));
      extensions=require('@/backend/execution/extensions');
      selected=require('@/backend/execution/extensions/configuredNativeSource');
    });
    return {extensions,selected};
  };
  let first: ReturnType<typeof graph> | undefined;
  try {
    first=graph(); const second=graph();
    expect(first.extensions.executionExtensionAdapter()).toBe(first.selected.configuredExecutionAdapter);
    expect(second.extensions.executionExtensionAdapter()).toBe(first.selected.configuredExecutionAdapter);
    await first.selected.configuredNativeSource.withWorkerRun('Bearer unit-only',claim,async context=>{
      await second.extensions.assertExecutionExtensionCurrent(context);
      expect(await second.extensions.executionExtensionCodexProfile(context)).toEqual(e.profile());
    });
  } finally {
    await first?.selected.configuredNativeSource.close();
    state.__flujoExecutionExtensions=previous;
    jest.dontMock('@/backend/execution/extensions/configuredNativeParent');
    jest.dontMock('@/backend/execution/extensions/configuredAdapter');
  }
});
