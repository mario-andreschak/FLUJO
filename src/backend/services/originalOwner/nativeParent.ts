import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { NativeSourceParent } from '@/backend/execution/extensions/controllerNativeClient';
import type { ExecutionNativeWorkerRootRequest } from '@/backend/execution/extensions';
import type { RestrictedCodexProfile } from '@/backend/services/model/adapters/codexRestrictedProfile';
import { modelService } from '@/backend/services/model';
import { nativeDigest } from '@/backend/execution/flow/handlers/nativeDigest';
import { flowAssertionRoot } from '@/backend/execution/flow/executionAuthority';
import { getCurrentWorkspace, runWithWorkspace } from '@/utils/workspace';
import { getPersonaActivity } from '@/backend/services/enduringAgents/store';
import type { FlowRunInput } from '@/backend/execution/flow/runFlow';
import { controllerNativeSourceFor } from '@/backend/execution/extensions/controllerNativeAdapter';
import { bindExecutionExtensionRun, bindNativeExecutionPersonaAuthority, assertExecutionExtensionCurrent } from '@/backend/execution/extensions';
import { getCapturedNativeOwnerRun, getNativeOriginalOwnerAuthority, retireNativeOriginalOwnerAuthority,
  type CapturedNativeOwnerRun, type OriginalOwnerAuthority } from './authority';
import { installOriginalNativeProfile } from './nativeAccount';
import { readOriginalOwnerBook, mutateOriginalOwnerBook, flushOriginalOwnerBook } from './store';
import { nativeModelPlan, ownerDigest, bytesDigest, refuse, type OriginalOwnerBook,
} from './types';
import { prepareNativeToolEffect, NativeToolTeardownError } from './nativeToolEffects';

const id = z.string().min(1).max(160).refine(value => !/[\r\n\0]/.test(value));
const ClaimSchema = z.object({ runId: id, rootConversationId: id, goalId: id, workspace: id }).strict();
type Claim = z.infer<typeof ClaimSchema>;
type Plan = { flowId: string; flowDigest: string; modelId: string; modelDigest: string };
type Options = { sourceOrigin: string; toolOrigin: string; codexProfile: RestrictedCodexProfile };
type Ticket = { context: Admission; id: string; name: string; args: Record<string, unknown>; argsDigest: string };
type Admission = { captured: CapturedNativeOwnerRun; claim: Claim; plan: Plan; children: Array<Plan & { parentNodeId: string }>;
  controller: AbortController; context: object; id: string; tickets: Set<string>; boundRun?: string;
  effects: Set<Promise<unknown>>; cleanupFailures: Set<unknown>; claimed: boolean; observed: boolean; closed: boolean; close?: Promise<void>; timer?: ReturnType<typeof setTimeout>;
  onAbort?: () => void };
export type OriginalOwnerNativeParent = NativeSourceParent & {
  withCapturedRun<T>(input: FlowRunInput, task: (input: FlowRunInput) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};
const scope = globalThis as typeof globalThis & { __flujoOriginalNativeParents?: Map<string, OriginalOwnerNativeParent> };
const parents = scope.__flujoOriginalNativeParents ??= new Map<string, OriginalOwnerNativeParent>();

function loopback(value: string): URL {
  const address = new URL(value);
  if (address.protocol !== 'http:' || address.hostname !== '127.0.0.1' || !address.port
    || address.pathname !== '/' || address.username || address.password || address.search || address.hash) {
    refuse('original_owner_native_origin_refused');
  }
  return address;
}

const toolDefinitions = ['worker_read_file', 'worker_write_file', 'worker_list_dir', 'worker_command'].map(name => ({
  name, description: name === 'worker_command' ? 'Run an exact command granted by the task owner.'
    : name === 'worker_write_file' ? 'Write a file in the task directory.'
      : name === 'worker_read_file' ? 'Read a file in the task directory.' : 'List the task directory.',
  inputSchema: { type: 'object' as const, additionalProperties: false,
    properties: name === 'worker_command' ? { command: { type: 'string' }, cwd: { type: 'string' } }
      : name === 'worker_write_file' ? { path: { type: 'string' }, content: { type: 'string' } }
        : { path: { type: 'string' } },
    required: name === 'worker_command' ? ['command'] : name === 'worker_write_file' ? ['path', 'content'] : ['path'] },
}));

/** Production Parent. Only dispatcher-captured live Native roots are admitted;
 * this service never creates Persona, task, graph, lease or account authority. */
export function createOriginalOwnerNativeParent(options: Options): OriginalOwnerNativeParent {
  const source = loopback(options.sourceOrigin), endpoint = loopback(options.toolOrigin);
  if (source.origin === endpoint.origin) refuse('original_owner_native_origins_overlap');
  const bindingId = nativeDigest({ source: source.origin, tools: endpoint.origin, profile: options.codexProfile });
  const existing = parents.get(bindingId);
  if (existing) return existing;
  if (parents.size >= 4) refuse('original_owner_native_parent_limit');
  installOriginalNativeProfile(options.codexProfile);
  const requester = Object.freeze({ origin: source.origin, authorization: `Bearer ${randomBytes(32).toString('base64url')}` });
  const toolAuthorization = `Bearer ${randomBytes(32).toString('base64url')}`;
  const toolConfig = Object.freeze({ name: 'seagulled-worker', transport: 'streamable',
    serverUrl: `${endpoint.origin}/native-source/tools/mcp`, headers: Object.freeze({ Authorization: toolAuthorization }) });
  const contexts = new WeakMap<object, Admission>(), active = new Set<Admission>(), tickets = new Map<string, Ticket>();
  const internalAuthorizations = new Map<string, OriginalOwnerAuthority>(), operations = new Set<Promise<unknown>>();
  const retirements = new Set<Promise<void>>(), retirementFailures = new Set<unknown>();
  let closed = false, start: Promise<void> | undefined, httpServer: http.Server | undefined;
  const inWorkspace = <T>(item: Admission, task: () => Promise<T>) => runWithWorkspace(item.claim.workspace, task);

  function get(context: object): Admission {
    const item = contexts.get(context);
    if (closed || !item || item.closed || !active.has(item)) refuse('original_owner_native_context_refused');
    item.controller.signal.throwIfAborted();
    return item;
  }
  async function current(item: Admission): Promise<void> {
    if (closed || item.closed || !active.has(item)) refuse('original_owner_native_context_refused');
    item.controller.signal.throwIfAborted();
    await inWorkspace(item, () => item.captured.authority.assertCurrent());
    item.controller.signal.throwIfAborted();
  }
  async function records(item: Admission, book: OriginalOwnerBook) {
    await current(item);
    const binding = item.captured.authority.binding;
    const enrollment = book.enrollments.find(value => value.id === binding.enrollmentId);
    const account = book.accounts.find(value => value.id === binding.accountId);
    if (!enrollment || !account || account.kind !== 'codex' || !account.nativeProfile
      || enrollment.state !== 'active' || account.state !== 'active') refuse('original_owner_native_records_changed');
    return { enrollment, account };
  }
  const commit = <T>(item: Admission, task: (book: OriginalOwnerBook) => Promise<T>) => inWorkspace(item, () => (
    item.captured.authority.commitWhileCurrent(() => mutateOriginalOwnerBook(async book => {
      await records(item, book);
      const result = await task(book);
      await current(item);
      return result;
    }))
  ));
  const retire = (item: Admission): Promise<void> => {
    if (item.close) return item.close;
    item.close = (async () => {
    item.closed = true; item.controller.abort(); active.delete(item);
    clearTimeout(item.timer);
    if (item.onAbort) item.captured.authority.signal.removeEventListener('abort', item.onAbort);
    for (const token of item.tickets) tickets.delete(token);
    item.tickets.clear();
    const effects = await Promise.allSettled([...item.effects]);
    if (!item.claimed) return;
    // Observer closure is not completion proof. Unobserved bound runs remain
    // unknown across new leases/rounds; inference receipts stay in the host.
    await inWorkspace(item, () => mutateOriginalOwnerBook(async book => {
      const row = book.steps.find(value => value.id === item.id && value.kind === 'native');
      if (row?.state === 'sending') { row.state = item.boundRun ? 'unknown' : 'aborted'; row.updatedAt = Date.now(); }
      for (const step of book.steps.filter(value => value.kind === 'tool' && value.nativeRunId === item.id)) {
        if (step.state === 'issued') { step.state = 'aborted'; step.updatedAt = Date.now(); }
      }
    }));
    const cleanup = [...new Set([...item.cleanupFailures, ...effects
      .filter(value => value.status === 'rejected' && value.reason instanceof NativeToolTeardownError)
      .map(value => (value as PromiseRejectedResult).reason)])];
    if (cleanup.length) throw new AggregateError(cleanup,'Native effect teardown failed.');
    })();
    const operation = item.close;
    retirements.add(operation);
    operation.then(() => retirements.delete(operation), error => {
      retirements.delete(operation); retirementFailures.add(error);
    });
    return operation;
  };
  const invalidate = (item: Admission, reason: unknown) => {
    item.controller.abort(reason);
    // Cleanup is owned here even if Source never reaches its finally block.
    // Its cached close promise still delivers an independent cleanup failure.
    void retire(item).catch(() => {});
  };
  const settle = (item: Admission, ticket: Ticket, state: 'completed' | 'unknown') => inWorkspace(item, () => (
    mutateOriginalOwnerBook(async book => {
      const row = book.steps.find(value => value.id === ticket.id && value.nativeRunId === item.id);
      if (row?.state === 'sending') { row.state = state; row.updatedAt = Date.now(); }
    })
  ));

  async function callTool(name: string, args: Record<string, unknown>, meta: unknown): Promise<CallToolResult> {
    const token = (meta as { seagulledNative?: { ticket?: unknown } } | undefined)?.seagulledNative?.ticket;
    if (typeof token !== 'string') refuse('original_owner_native_ticket_required');
    const ticket = tickets.get(token);
    // Spend locally before the first await; the durable row independently
    // refuses another process or a restarted producer.
    tickets.delete(token); ticket?.context.tickets.delete(token);
    if (!ticket || ticket.name !== name || ticket.argsDigest !== ownerDigest(args)) refuse('original_owner_native_ticket_refused');
    const item = ticket.context;
    let result: Awaited<ReturnType<Awaited<ReturnType<typeof prepareNativeToolEffect>>['start']>> | undefined;
    let completion: Promise<NonNullable<typeof result>> | undefined;
    try {
      await current(item);
      const enrollment = await inWorkspace(item, async () => (await records(item, await readOriginalOwnerBook())).enrollment);
      const effect = await prepareNativeToolEffect(enrollment, name, ticket.args, item.controller.signal);
      await commit(item, async book => {
        const row = book.steps.find(value => value.id === ticket.id && value.nativeRunId === item.id);
        if (!row || row.state !== 'issued' || row.authorityDigest !== bytesDigest(token)
          || row.argsDigest !== ticket.argsDigest || row.tool !== name) refuse('original_owner_native_ticket_spent');
        row.state = 'sending'; row.updatedAt = Date.now(); await flushOriginalOwnerBook();
        await current(item);
        completion = effect.start();
        item.effects.add(completion);
        completion.catch(error => { if (error instanceof NativeToolTeardownError) item.cleanupFailures.add(error); });
        completion.finally(() => item.effects.delete(completion!)).catch(() => {});
        // Keep bounded file operations under the actual fences. A shell is
        // spawned under them, but completion waits outside both owner locks.
        completion.catch(() => {});
        if (name !== 'worker_command') result = await completion;
      });
      result ??= await completion!;
      await settle(item, ticket, 'completed');
      await current(item);
      return { ...result, _meta: { seagulledNative: { ticket: token, name, argsDigest: ticket.argsDigest } } };
    } catch (error) {
      item.controller.abort(error);
      if (completion) await Promise.allSettled([completion]);
      // A failed command may already have effects. Keep uncertainty durable,
      // rather than manufacturing a safe retry or exposing diagnostic secrets.
      await settle(item, ticket, 'unknown').catch(cleanup => {
        throw new AggregateError([error, cleanup], 'Native tool outcome could not be recorded.');
      });
      throw new Error('original_owner_native_tool_refused');
    }
  }

  const ensureServer = () => start ??= new Promise<void>((resolve, reject) => {
    if (closed) { reject(new Error('original_owner_native_parent_closed')); return; }
    const expected = Buffer.from(toolAuthorization);
    httpServer = http.createServer(async (request, response) => {
      const supplied = Buffer.from(typeof request.headers.authorization === 'string' ? request.headers.authorization : '');
      if (closed || request.url !== '/native-source/tools/mcp' || request.method !== 'POST'
        || request.headers.host !== endpoint.host || request.headers.origin !== undefined
        || request.socket.remoteAddress !== '127.0.0.1'
        || request.headers['content-type']?.split(';')[0].trim() !== 'application/json'
        || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        response.writeHead(403).end(); return;
      }
      const server = new Server({ name: 'seagulled-worker', version: '1.0.0' }, { capabilities: { tools: {} } });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefinitions }));
      server.setRequestHandler(CallToolRequestSchema, async message => {
        const operation = callTool(message.params.name, message.params.arguments ?? {}, message.params._meta);
        operations.add(operation);
        try { return await operation; }
        catch { return { content: [{ type: 'text', text: 'This task cannot use that tool now.' }], isError: true }; }
        finally { operations.delete(operation); }
      });
      try {
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of request) {
          size += chunk.length; if (size > 32 * 1024) throw new Error('bound'); chunks.push(Buffer.from(chunk));
        }
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('shape');
        await server.connect(transport); await transport.handleRequest(request, response, body);
      } catch {
        if (!response.headersSent) response.writeHead(400).end(); else response.end();
      } finally {
        await Promise.allSettled([server.close(), transport.close()]);
      }
    });
    httpServer.requestTimeout = 5000; httpServer.headersTimeout = 5000;
    httpServer.on('error', error => {
      reject(error);
      for (const item of [...active]) invalidate(item,new Error('original_owner_native_listener_failed'));
    });
    httpServer.listen(Number(endpoint.port), '127.0.0.1', resolve);
    httpServer.unref();
  });

  const transport: NativeSourceParent['transport'] = {
    bindingId, toolConfig,
    async admit(authorization, input) {
      const internal = internalAuthorizations.get(authorization);
      internalAuthorizations.delete(authorization);
      const claim = ClaimSchema.parse(input);
      if (closed || active.size >= 100 || claim.workspace !== getCurrentWorkspace()
        || typeof authorization !== 'string' || !/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization)) {
        refuse('original_owner_native_admission_refused');
      }
      const captured = await getCapturedNativeOwnerRun(claim);
      if (!captured) refuse('original_owner_native_dispatcher_required');
      const binding = captured.authority.binding;
      const model = await modelService.getModel(binding.modelId);
      if (!model || model.adapter !== 'codex-cli') refuse('original_owner_native_model_changed');
      if (captured.flow.nodes.some(node => (node.type === 'process' || node.data.type === 'process')
        && node.data.properties?.boundModel !== model.id)) refuse('original_owner_native_model_plan_refused');
      const plan: Plan = Object.freeze({ flowId: captured.flow.id, flowDigest: nativeDigest(captured.flow),
        modelId: model.id, modelDigest: nativeDigest(nativeModelPlan(model)) });
      const childNodes = captured.flow.nodes.filter(node => node.data.type === 'subflow');
      if (childNodes.length > 1) refuse('original_owner_native_child_plan_refused');
      const children = childNodes.map(node => {
        const child = captured.flow.executionDependencies?.flows.find(value => value.flowId === node.data.properties?.subflowId);
        if (!child || child.flowSnapshot.nodes.some(value => value.data.type === 'process'
          && value.data.properties?.boundModel !== model.id)) refuse('original_owner_native_child_plan_refused');
        return Object.freeze({ ...plan, parentNodeId: node.id, flowId: child.flowId, flowDigest: nativeDigest(child.flowSnapshot) });
      });
      const context = Object.freeze({}), controller = new AbortController();
      const item: Admission = { captured, claim: Object.freeze(claim), plan, children, context, controller,
        id: ownerDigest(['native-admission', binding.originalRunId]), tickets: new Set(), effects: new Set(), cleanupFailures: new Set(),
        claimed: false, observed: false, closed: false };
      contexts.set(context, item); active.add(item);
      try {
        await commit(item, async book => {
          const { enrollment } = await records(item, book);
          const expected = Buffer.from(enrollment.workerAuthorizationDigest, 'hex');
          const received = Buffer.from(bytesDigest(authorization), 'hex');
          if ((internal !== captured.authority && (expected.length !== received.length || !timingSafeEqual(expected, received)))
            || book.steps.some(row => row.id === item.id)
            || book.steps.some(row => row.enrollmentId === enrollment.id && ['sending', 'unknown'].includes(row.state))) {
            refuse('original_owner_native_worker_refused');
          }
          const now = Date.now();
          book.steps.push({ id: item.id, enrollmentId: enrollment.id, accountId: binding.accountId,
            kind: 'native', originalRunId: binding.originalRunId, leaseId: binding.leaseId,
            modelDigest: plan.modelDigest, state: 'sending', usage: null, createdAt: now, updatedAt: now });
          item.claimed = true;
          await flushOriginalOwnerBook();
        });
        await ensureServer(); await current(item); return context;
      } catch (error) {
        await retire(item).catch(cleanup => { throw new AggregateError([error, cleanup], 'Native admission cleanup failed.'); });
        throw error;
      }
    },
    async assertRun(context: object, expected?: { conversationId?: string; runId?: string; graphHash?: string }) {
      const item = get(context); await current(item);
      if (expected?.conversationId !== undefined && expected.conversationId !== item.claim.rootConversationId
        || expected?.runId !== undefined && expected.runId !== item.boundRun
        || expected?.graphHash !== undefined && expected.graphHash !== item.plan.flowDigest) {
        refuse('original_owner_native_run_changed');
      }
    },
    async readPlan(context) { const item = get(context); await current(item); return item.plan; },
    async readChildren(context) { const item = get(context); await current(item); return [...item.children]; },
    async assertPlan(context, expectedPlan, expectedChildren) {
      const item = get(context);
      await current(item);
      if (nativeDigest(expectedPlan) !== nativeDigest(item.plan)
        || nativeDigest(expectedChildren) !== nativeDigest(item.children)) {
        refuse('original_owner_native_plan_changed');
      }
      // Recheck the synchronous retirement/abort state after the single
      // authority fence; the immutable admission snapshot cannot drift here.
      get(context);
    },
    async validateOwnerRunInput(context, input) {
      const item = get(context); await current(item);
      const binding = item.captured.authority.binding;
      if (input.source === 'subflow') {
        const { FlowExecutor } = await import('@/backend/execution/flow/FlowExecutor');
        const verify = () => {
          const child = item.children.find(value => value.parentNodeId === input.lane?.parentNodeId
            && value.flowId === input.flowId);
          const parent = FlowExecutor.conversationStates.get(binding.conversationId);
          const invocation = input.lane?.invocationId && parent?.subflowInvocations?.[input.lane.invocationId];
          const lane = invocation && invocation.lanes.find(value => value.id === input.lane?.laneId);
          if (!child || !input.executionAuthority || input.executionAuthority === item.captured.personaAuthority
            || flowAssertionRoot(input.executionAuthority) !== item.captured.personaAuthority
            || input.personaAttribution?.personaId !== binding.personaId
            || input.personaAttribution?.activityId !== binding.activityId
            || input.personaAttribution?.behaviorRevisionId !== binding.revisionId
            || input.personaInstructionContext !== undefined || input.personaCoreAppRefs !== undefined
            || input.depth !== 1 || input.mode !== 'conversation' || input.parentRunId !== binding.conversationId
            || !input.conversationId || input.conversationId === binding.conversationId
            || input.flowDefinition?.id !== child.flowId || nativeDigest(input.flowDefinition) !== child.flowDigest
            || parent?.executionAuthority !== item.captured.personaAuthority || parent.logicalRunId !== item.boundRun
            || parent.runDepth !== 0 || parent.isCancelled || parent.status !== 'running'
            || nativeDigest(parent.flowSnapshot) !== item.plan.flowDigest
            || !invocation || invocation.version !== 1 || invocation.status !== 'running'
            || invocation.parentConversationId !== binding.conversationId || invocation.parentRunId !== binding.conversationId
            || invocation.parentNodeId !== child.parentNodeId || invocation.lanes.length !== 1
            || !lane || lane.status !== 'running' || lane.subflowId !== child.flowId
            || lane.conversationId !== input.conversationId) refuse('original_owner_native_child_input_changed');
        };
        verify(); await current(item); verify(); return;
      }
      const activity = await inWorkspace(item, () => getPersonaActivity(binding.personaId,binding.activityId));
      if (input.executionAuthority !== item.captured.personaAuthority
        || input.personaAttribution?.personaId !== binding.personaId
        || input.personaAttribution?.activityId !== binding.activityId
        || input.personaAttribution?.behaviorRevisionId !== binding.revisionId
        || nativeDigest(input.flowDefinition) !== item.plan.flowDigest
        || !activity || nativeDigest(input.personaInstructionContext) !== nativeDigest(activity.instructionContext)
        || nativeDigest(input.personaCoreAppRefs ?? []) !== nativeDigest(activity.coreAppRefs ?? [])) {
        refuse('original_owner_native_dispatcher_input_changed');
      }
      await current(item);
    },
    async bindRun(context, conversation, run) {
      const item = get(context); await current(item);
      if (conversation !== item.claim.rootConversationId || run !== item.captured.authority.binding.runId
        || item.boundRun && item.boundRun !== run) refuse('original_owner_native_run_changed');
      item.boundRun = run;
    },
    async readRoot(context, expected: ExecutionNativeWorkerRootRequest) {
      const item = get(context); await transport.assertRun(context, { conversationId: expected.conversationId, runId: expected.runId });
      if (expected.workspace !== item.claim.workspace || expected.flowId !== item.plan.flowId
        || expected.flowDigest !== item.plan.flowDigest || expected.modelId !== item.plan.modelId
        || expected.modelDigest !== item.plan.modelDigest) refuse('original_owner_native_root_changed');
      const binding = item.captured.authority.binding;
      return Object.freeze({ version: 1 as const, workerId: binding.enrollmentId, goalId: binding.goalId,
        fleetRunId: binding.dispatchId, rootConversationId: binding.conversationId, logicalRunId: item.boundRun!,
        workspace: binding.workspace, targetDigest: nativeDigest([binding.enrollmentDigest, binding.accountDigest]),
        flowDigest: item.plan.flowDigest, leaseEpoch: binding.leaseEpoch, modelId: item.plan.modelId, modelDigest: item.plan.modelDigest });
    },
    commit: (context, task) => commit(get(context), task),
    async complete(context, sourceContext) {
      const item = get(context);
      await assertExecutionExtensionCurrent(sourceContext,{ conversationId: item.claim.rootConversationId,runId: item.boundRun });
      await commit(item,async book => {
        const { FlowExecutor } = await import('@/backend/execution/flow/FlowExecutor');
        const state = FlowExecutor.conversationStates.get(item.claim.rootConversationId);
        if (!state || state.executionExtensionContext !== sourceContext || state.logicalRunId !== item.boundRun
          || (state.runDepth ?? 0) !== 0 || state.isCancelled || !['completed','capped'].includes(state.status ?? '')
          || nativeDigest(state.flowSnapshot) !== item.plan.flowDigest) return;
        const row = book.steps.find(value => value.id === item.id && value.kind === 'native');
        if (!row || row.state !== 'sending') refuse('original_owner_native_completion_refused');
        row.state = 'completed'; row.operation = 'source-terminal-observed'; row.updatedAt = Date.now();
        await flushOriginalOwnerBook();
      });
    },
    async retire(context) {
      const item = contexts.get(context);
      if (!item) refuse('original_owner_native_context_refused');
      await retire(item);
    },
    async observe(context) {
      const item = get(context); await current(item);
      if (item.observed) refuse('original_owner_native_observer_reused');
      item.observed = true;
      item.onAbort = () => invalidate(item,item.captured.authority.signal.reason);
      item.captured.authority.signal.addEventListener('abort', item.onAbort, { once: true });
      const check = async () => {
        try { await current(item); }
        catch (error) { invalidate(item,error); return; }
        if (!item.closed) { item.timer = setTimeout(() => { void check(); }, 1000); item.timer.unref(); }
      };
      if (item.captured.authority.signal.aborted) item.onAbort();
      else { item.timer = setTimeout(() => { void check(); }, 1000); item.timer.unref(); }
      return { signal: item.controller.signal, close: () => retire(item) };
    },
    async issueTool(context, name, args) {
      const item = get(context);
      if (item.tickets.size >= 100 || tickets.size >= 10000) refuse('original_owner_native_ticket_limit');
      const captured = Object.freeze(structuredClone(args));
      const token = randomBytes(32).toString('base64url');
      const ticket: Ticket = { context: item, id: bytesDigest(token), name, args: captured, argsDigest: ownerDigest(captured) };
      await commit(item, async book => {
        const { enrollment } = await records(item, book);
        await prepareNativeToolEffect(enrollment, name, captured, item.controller.signal);
        const binding = item.captured.authority.binding, now = Date.now();
        book.steps.push({ id: ticket.id, enrollmentId: enrollment.id, accountId: binding.accountId,
          kind: 'tool', originalRunId: binding.originalRunId, nativeRunId: item.id, leaseId: binding.leaseId,
          modelDigest: item.plan.modelDigest, authorityDigest: bytesDigest(token), argsDigest: ticket.argsDigest,
          tool: name, state: 'issued', usage: null, createdAt: now, updatedAt: now });
        await flushOriginalOwnerBook();
      });
      await current(item); tickets.set(token, ticket); item.tickets.add(token);
      return Object.freeze({ ticket: token });
    },
  };
  const parent: OriginalOwnerNativeParent = Object.freeze({ transport: Object.freeze(transport), requester,
    async withCapturedRun<T>(input: FlowRunInput, task: (input: FlowRunInput) => Promise<T>) {
      const authority = await getNativeOriginalOwnerAuthority(input.executionAuthority);
      if (!authority) refuse('original_owner_native_dispatcher_required');
      const source = controllerNativeSourceFor(bindingId);
      if (!source || closed) refuse('original_owner_native_source_not_configured');
      const binding = authority.binding, token = `Bearer ${randomBytes(32).toString('base64url')}`;
      internalAuthorizations.set(token,authority);
      try {
        return await source.withWorkerRun(token, { workspace: binding.workspace, runId: binding.dispatchId,
          goalId: binding.goalId, rootConversationId: binding.conversationId }, async context => {
          await bindExecutionExtensionRun(context,binding.conversationId,binding.runId);
          await bindNativeExecutionPersonaAuthority(context,input.executionAuthority!);
          return task({ ...input, executionExtensionContext: context });
        },input.abortSignal);
      } finally {
        internalAuthorizations.delete(token);
        retireNativeOriginalOwnerAuthority(input.executionAuthority!);
      }
    },
    async codexProfile(context: object) {
      const item = get(context);
      return inWorkspace(item, async () => {
        const { account } = await records(item, await readOriginalOwnerBook());
        return Object.freeze({ ...account.nativeProfile! });
      });
    },
    async close() {
      if (closed) return; closed = true; parents.delete(bindingId);
      const results = await Promise.allSettled([...active].map(retire));
      results.push(...await Promise.allSettled([...retirements]));
      await Promise.allSettled([...operations]);
      internalAuthorizations.clear();
      if (httpServer) {
        httpServer.closeAllConnections();
        await new Promise<void>((resolve, reject) => httpServer!.close(error => {
          if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error); else resolve();
        }));
      }
      const failures = [...new Set([...retirementFailures,...results.filter(value => value.status === 'rejected').map(value => value.reason)])];
      if (failures.length) throw new AggregateError(failures, 'Native Parent cleanup failed.');
    },
  });
  parents.set(bindingId, parent); return parent;
}

/** Dispatcher integration keeps its real attribution, frozen instructions and
 * App grants. Ordinary and Original model-sender runs use their existing path. */
export async function runOriginalOwnerNativeFlow<T>(input: FlowRunInput,
  task: (input: FlowRunInput) => Promise<T>): Promise<T> {
  if (!await getNativeOriginalOwnerAuthority(input.executionAuthority)) return task(input);
  if (parents.size !== 1) refuse('original_owner_native_source_not_configured');
  return [...parents.values()][0].withCapturedRun(input,task);
}
