import path from 'node:path';
import type { RestrictedCodexProfile } from '@/backend/services/model/adapters/codexRestrictedProfile';
import { nativeDigest } from '../flow/handlers/nativeDigest';
import { ExecutionExtensionError } from './index';
import type { ControllerNativeRequester, ControllerNativeTransport } from './controllerNativeAdapter';
import type { ControllerNativeToolTransport } from './controllerNativeTools';

type ParentTransport = ControllerNativeTransport & ControllerNativeToolTransport;
/** The build-selected Original implementation owns every decision and fence.
 * This port is server code, not a JSON registration or a public API grant. */
export interface NativeSourceParent {
  readonly transport: ParentTransport;
  readonly requester: Readonly<ControllerNativeRequester>;
  codexProfile(context: object): Promise<RestrictedCodexProfile>;
  close?(): Promise<void>;
}
type Watch = Awaited<ReturnType<ControllerNativeTransport['observe']>>;
type Active = { remote: object; abort: AbortController; watch: Watch; close?: Promise<void>; profileDigest?: string };
type NativeClient = ParentTransport & {
  codexProfile(context: object): Promise<RestrictedCodexProfile>; close(): Promise<void>;
};
const refused = () => new ExecutionExtensionError('controller_native_client_refused');

function checkedProfile(value: RestrictedCodexProfile): RestrictedCodexProfile {
  const fields = ['verifiedCliVersion','verifiedCliSha256','verifiedCliPath',
    'verifiedModelCatalogPath','verifiedModelCatalogSha256'];
  if (!value || Object.keys(value).sort().join() !== fields.sort().join()
    || value.verifiedCliVersion !== '0.157.1'
    || !/^[a-f0-9]{64}$/.test(value.verifiedCliSha256)
    || !/^[a-f0-9]{64}$/.test(value.verifiedModelCatalogSha256)
    || typeof value.verifiedCliPath !== 'string' || !path.isAbsolute(value.verifiedCliPath)
    || typeof value.verifiedModelCatalogPath !== 'string' || !path.isAbsolute(value.verifiedModelCatalogPath)) throw refused();
  return Object.freeze({ ...value });
}

/** Consumes the real Parent without moving its authority or lock into Source.
 * Parent contexts stay private; only fresh client contexts reach the adapter. */
export function createControllerNativeClient(parent: NativeSourceParent): NativeClient {
  const owner = parent?.transport;
  if (!owner || !/^[a-f0-9]{64}$/.test(owner.bindingId)
    || typeof parent.codexProfile !== 'function'
    || ['admit','readPlan','assertRun','bindRun','readRoot','commit','observe','issueTool']
      .some(name => typeof owner[name as keyof ParentTransport] !== 'function')) throw refused();
  // Configuration cannot rotate underneath a live capability. The gateway
  // separately verifies the protected endpoint/header projection.
  const toolConfig = structuredClone(owner.toolConfig);
  Object.freeze(toolConfig.headers); Object.freeze(toolConfig);
  const bindingId = owner.bindingId;
  const contexts = new WeakMap<object, Active>();
  const seen = new WeakSet<object>();
  const active = new Set<Active>();
  let closed = false;
  const get = (context: object) => {
    const value = contexts.get(context);
    if (closed || !value || !active.has(value)) throw refused();
    value.abort.signal.throwIfAborted(); value.watch.signal.throwIfAborted();
    if (owner.bindingId !== bindingId || nativeDigest(owner.toolConfig) !== nativeDigest(toolConfig)) throw refused();
    return value;
  };
  const current = async (context: object) => {
    const value = get(context);
    await owner.assertRun(value.remote); get(context);
    return value;
  };
  const retire = (value: Active) => value.close ??= (async () => {
    value.abort.abort(refused()); active.delete(value);
    await value.watch.close();
  })();
  const client: NativeClient = {
    bindingId, toolConfig,
    async admit(authorization, claim) {
      if (closed || active.size >= 100 || typeof authorization !== 'string' || !authorization
        || Buffer.byteLength(authorization) > 4096 || /[\r\n\0]/.test(authorization)) throw refused();
      if (!claim || Object.keys(claim).sort().join() !== 'goalId,rootConversationId,runId,workspace'
        || Object.values(claim).some(value => typeof value !== 'string' || !value || value.length > 160 || /[\r\n\0]/.test(value))) throw refused();
      const remote = await owner.admit(authorization,Object.freeze(structuredClone(claim)));
      if (!remote || typeof remote !== 'object' || Array.isArray(remote) || seen.has(remote)) throw refused();
      seen.add(remote);
      let watch: Watch | undefined;
      try {
        watch = await owner.observe(remote);
        if (!watch || !(watch.signal instanceof AbortSignal) || typeof watch.close !== 'function') throw refused();
      }
      catch (error) {
        try { if (owner.retire) await owner.retire(remote); else if (typeof watch?.close === 'function') await watch.close(); }
        catch (cleanup) { throw new AggregateError([error,cleanup],'Parent observation and admission cleanup failed.'); }
        throw error;
      }
      const value: Active = { remote, watch, abort: new AbortController() };
      if (closed || active.size >= 100 || watch.signal.aborted) { await retire(value); throw refused(); }
      const context = Object.freeze({}); contexts.set(context,value); active.add(value);
      try { await current(context); return context; }
      catch (error) {
        try { await retire(value); }
        catch (cleanup) { throw new AggregateError([error,cleanup],'Parent admission and observer cleanup failed.'); }
        throw error;
      }
    },
    async assertRun(context: object, expected?: Parameters<ControllerNativeTransport['assertRun']>[1]) {
      const value = get(context); await owner.assertRun(value.remote,expected); get(context);
    },
    async readPlan(context) {
      const value = await current(context), result = await owner.readPlan(value.remote);
      await current(context); return Object.freeze(structuredClone(result));
    },
    async readChildren(context) {
      const value = await current(context), result = await owner.readChildren?.(value.remote) ?? [];
      await current(context); return structuredClone(result);
    },
    ...(owner.assertPlan ? { async assertPlan(context: object,
      expectedPlan: Parameters<NonNullable<ControllerNativeTransport['assertPlan']>>[1],
      expectedChildren: Parameters<NonNullable<ControllerNativeTransport['assertPlan']>>[2]) {
      const value = get(context);
      const plan = Object.freeze(structuredClone(expectedPlan));
      const children = structuredClone(expectedChildren).map(child => Object.freeze(child));
      Object.freeze(children);
      await owner.assertPlan!(value.remote, plan, children);
      get(context);
    } } : {}),
    ...(owner.validateOwnerRunInput ? { async validateOwnerRunInput(context: object,
      input: Parameters<NonNullable<ControllerNativeTransport['validateOwnerRunInput']>>[1]) {
      const value = await current(context);
      await owner.validateOwnerRunInput!(value.remote,input); await current(context);
    } } : {}),
    async bindRun(context, conversation, run) {
      const value = await current(context); await owner.bindRun(value.remote,conversation,run); await current(context);
    },
    async readRoot(context, expected) {
      const value = await current(context), result = await owner.readRoot(value.remote,Object.freeze({ ...expected }));
      await current(context); return Object.freeze(structuredClone(result));
    },
    async issueTool(context, name, args) {
      const value = await current(context), result = await owner.issueTool(value.remote,name,Object.freeze(structuredClone(args)));
      await current(context); return Object.freeze(structuredClone(result));
    },
    async commit(context, task) {
      const value = await current(context);
      return owner.commit(value.remote,async () => {
        await current(context); const result = await task(); await current(context); return result;
      });
    },
    async observe(context) {
      // A known admission still owns its observer when revocation makes get()
      // fail before the adapter has installed its run cleanup.
      const value = contexts.get(context);
      if (!value) throw refused();
      try { await current(context); }
      catch (error) {
        try { await retire(value); }
        catch (cleanup) { throw new AggregateError([error,cleanup],'Parent observation and cleanup failed.'); }
        throw error;
      }
      return { signal: AbortSignal.any([value.abort.signal,value.watch.signal]), close: () => retire(value) };
    },
    async retire(context) {
      const value = contexts.get(context);
      if (value) await retire(value);
    },
    ...(owner.complete ? { async complete(context: object, source: Parameters<NonNullable<ControllerNativeTransport['complete']>>[1]) {
      const value = await current(context); await owner.complete!(value.remote,source); await current(context);
    } } : {}),
    async codexProfile(context) {
      const value = await current(context), profile = checkedProfile(await parent.codexProfile(value.remote));
      await current(context);
      const digest = nativeDigest(profile);
      if (value.profileDigest && value.profileDigest !== digest) throw refused();
      value.profileDigest = digest;
      // Source subsequently rereads and hashes these exact binary/catalog paths
      // before its own qualification and credential-bearing Native launch.
      return profile;
    },
    async close() {
      if (closed) return; closed = true;
      const results = await Promise.allSettled([...active].map(retire));
      const failures = results.filter(result=>result.status==='rejected').map(result=>result.reason);
      if (failures.length) throw new AggregateError(failures,'Parent observers failed to close.');
    },
  };
  return Object.freeze(client);
}
