import type { Flow } from '@/shared/types/flow';
import type { Model } from '@/shared/types/model';
import type { BehaviorRevision, Persona, PersonaActivity, PersonaLease, PersonaWorkItem } from '@/shared/types/enduringAgent';
import type { FlowExecutionAuthority } from '@/backend/execution/flow/types';
import type { PersonaFlowDispatchRecord } from '@/backend/services/enduringAgents/personaDispatcher';
import type { OriginalOwnerBook } from '@/backend/services/originalOwner/types';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

let runtime: {
  persona: Persona; activity: PersonaActivity; task: PersonaWorkItem; goal: PersonaWorkItem;
  revision: BehaviorRevision; lease: PersonaLease; head: PersonaLease; dispatch: PersonaFlowDispatchRecord;
};
let book: OriginalOwnerBook;
let model: Model;
let workspace = 'workspace';
let approvalCurrent = true;
let fenceCurrent = true;
let inCommit = false;
let controller: AbortController;
let roots: WeakSet<object>;
let inBook = false;
let nativeSettlement = false;
let nativeAuthenticationCurrent = true;
let beforeBookMutation: (() => Promise<void>) | undefined;
let atBookFlush: (() => Promise<void>) | undefined;
let identities: WeakMap<object, {
  workspaceId: string; personaId: string; activityId: string; dispatchId: string; taskId?: string;
  revisionId: string; leaseEpoch: string; conversationId: string; runId: string; flowDigest: string;
}>;
const commitWitness = jest.fn();
const bookWitness = jest.fn();

jest.mock('@/backend/services/enduringAgents/personaDispatcher', () => ({
  assertPersonaFlowExecutionAuthority: (value: unknown) => {
    if (!value || typeof value !== 'object' || !roots.has(value) || !Object.isFrozen(value)) {
      throw new Error('A dispatcher-owned Persona Flow authority is required.');
    }
  },
  getPersonaFlowAuthorityIdentity: (value: object) => identities.get(value),
  getPersonaFlowDispatch: async (id: string) => id === runtime.dispatch.id ? runtime.dispatch : null,
}));
jest.mock('@/backend/services/enduringAgents/store', () => ({
  getPersona: async (id: string) => id === runtime.persona.id ? runtime.persona : null,
  getPersonaActivity: async (personaId: string, id: string) => personaId === runtime.persona.id
    && id === runtime.activity.id ? runtime.activity : null,
  getPersonaWorkItem: async (personaId: string, id: string) => personaId !== runtime.persona.id ? null
    : id === runtime.task.id ? runtime.task : id === runtime.goal.id ? runtime.goal : null,
  getBehaviorRevision: async (id: string) => id === runtime.revision.id ? runtime.revision : null,
  getPersonaLease: async () => runtime.head,
  getPersonaLeaseRecord: async (id: string) => id === runtime.lease.id ? runtime.lease : null,
}));
jest.mock('@/backend/services/model', () => ({ modelService: { getModel: async () => model } }));
jest.mock('@/backend/services/originalOwner/store', () => ({
  readOriginalOwnerBook: async () => book,
  mutateOriginalOwnerBook: async <T>(task: (value: OriginalOwnerBook) => Promise<T>): Promise<T> => {
    if (!nativeSettlement) expect(inCommit).toBe(true);
    expect(inBook).toBe(false);
    inBook = true; bookWitness('acquired');
    try {
      await beforeBookMutation?.();
      const result = await task(book);
      bookWitness('store-flushed');
      return result;
    } finally { inBook = false; bookWitness('released'); }
  },
  flushOriginalOwnerBook: async () => {
    expect(inCommit).toBe(true); expect(inBook).toBe(true);
    bookWitness('explicit-flush');
    await atBookFlush?.();
  },
}));
jest.mock('@/backend/services/originalOwner/administration', () => ({ assertOriginalApproval: () => {
  if (!approvalCurrent) throw new Error('original_owner_approval_revoked');
} }));
jest.mock('@/backend/services/originalOwner/nativeAccount', () => ({
  installOriginalNativeProfile: jest.fn(),
  assertOriginalNativeAccount: async () => { if (!nativeAuthenticationCurrent) throw new Error('native login changed'); },
}));
jest.mock('@/utils/workspace', () => ({ getCurrentWorkspace: () => workspace,
  workspaceCacheKey: (...parts: string[]) => [workspace, ...parts].join('\0'),
  runWithWorkspace: <T>(_workspace: string, task: () => T) => task() }));

import { canonicalJson, hashBehaviorFlow, verifyBehaviorDependencies } from '@/backend/services/enduringAgents/behaviorRevisions';
import { personaCoreAppNodeId } from '@/backend/services/enduringAgents/personaCoreAppIdentity';
import { accountModelPlan, bytesDigest, ownerDigest } from '@/backend/services/originalOwner/types';
import {
  assertOriginalOwnerAuthority, getOriginalOwnerAuthority, getCapturedNativeOwnerRun, getNativeOriginalOwnerAuthority,
  type OriginalOwnerCaptureInput,
} from '@/backend/services/originalOwner/authority';
import { captureOriginalOwnerAuthority } from '@/backend/services/originalOwner/producer';
import { createOriginalOwnerNativeParent } from '@/backend/services/originalOwner/nativeParent';
import { createNativeSourceComposition } from '@/backend/execution/extensions/nativeSourceComposition';
import { registerExecutionExtension, validateExecutionExtensionRun, executionProtectedServerConfig, executionExtensionSignal,
  executionExtensionSharesPersonaAuthority, prepareExecutionSubflowInput } from '@/backend/execution/extensions';
import { nativeDigest } from '@/backend/execution/flow/handlers/nativeDigest';
import { subflowExecutionAuthority } from '@/backend/execution/flow/executionAuthority';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import type { SharedState } from '@/backend/execution/flow/types';

function genuineRoot(capturedInput = input()): FlowExecutionAuthority {
  const root = Object.freeze({ signal: controller.signal,
    assertCurrent: async () => {
      if (inCommit) throw new Error('Persona lock was recursively acquired');
      controller.signal.throwIfAborted();
      if (!fenceCurrent) throw new Error('Persona lease lost');
    },
    commitWhileCurrent: async <T>(task: () => Promise<T>): Promise<T> => {
      if (inCommit) throw new Error('Persona lock was recursively acquired');
      if (!fenceCurrent) throw new Error('Persona lease lost');
      controller.signal.throwIfAborted();
      inCommit = true;
      commitWitness('acquired');
      try { return await task(); }
      finally { inCommit = false; commitWitness('released'); }
    },
  });
  roots.add(root);
  identities.set(root, { workspaceId: workspace, personaId: capturedInput.personaId,
    activityId: capturedInput.activityId, dispatchId: capturedInput.dispatchId, taskId: capturedInput.taskId,
    revisionId: capturedInput.revisionId, leaseEpoch: capturedInput.leaseEpoch,
    conversationId: capturedInput.conversationId, runId: capturedInput.runId,
    flowDigest: ownerDigest(capturedInput.flow) });
  return root;
}

function input(): OriginalOwnerCaptureInput {
  return { personaId: 'persona', activityId: 'activity', dispatchId: 'dispatch', taskId: 'task',
    revisionId: 'revision', conversationId: 'conversation', runId: 'run',
    leaseEpoch: bytesDigest(canonicalJson({ workspaceId: 'workspace', personaId: 'persona',
      activityId: 'activity', leaseId: 'lease', holderId: 'holder', fencingToken: 1 })),
    flow: structuredClone(runtime.revision.flowSnapshot) };
}

async function capture() {
  const root = genuineRoot();
  await captureOriginalOwnerAuthority(root, input());
  const authority = await getOriginalOwnerAuthority(root);
  expect(authority).toBeDefined();
  return { root, authority: authority! };
}

beforeEach(() => {
  workspace = 'workspace'; approvalCurrent = true; fenceCurrent = true; inCommit = false;
  controller = new AbortController(); roots = new WeakSet(); identities = new WeakMap(); commitWitness.mockClear();
  inBook = false; beforeBookMutation = undefined; atBookFlush = undefined; bookWitness.mockClear();
  nativeSettlement = false; nativeAuthenticationCurrent = true;
  model = { id: 'model', name: 'saved-model', adapter: 'openai', provider: 'openai', ApiKey: '',
    ownerCredentialBinding: { ownerId: 'owner', credentialId: 'account' } } as Model;
  const flow = { id: 'flow', name: 'Saved Core', nodes: [{ id: 'process', type: 'process',
    position: { x: 0, y: 0 }, data: { label: 'Model', type: 'process', properties: { boundModel: 'model' } } }],
    edges: [] } as Flow;
  const task = { id: 'task', personaId: 'persona', parentGoalId: 'goal', status: 'in_progress',
    title: 'Existing task', dependencyIds: [] } as unknown as PersonaWorkItem;
  const goal = { id: 'goal', personaId: 'persona', status: 'open', title: 'Existing goal', dependencyIds: [],
    goal: { state: 'active', rounds: 2, pendingTaskId: 'task', pendingDispatchId: 'dispatch',
      successCriteria: 'Existing acceptance' } } as unknown as PersonaWorkItem;
  const lease = { id: 'lease', workspaceId: 'workspace', personaId: 'persona', activityId: 'activity',
    holderId: 'holder', fencingToken: 1, status: 'active', expiresAt: Date.now() + 60_000 } as PersonaLease;
  runtime = {
    persona: { id: 'persona', lifecycleState: 'busy' } as Persona,
    activity: { id: 'activity', personaId: 'persona', status: 'running',
      source: { kind: 'assignment', sourceId: 'task' }, behaviorRevisionId: 'revision',
      coreFlowId: 'flow', coreFlowRevisionId: 'revision', coreAppRefs: [], leaseId: 'lease',
      conversationId: 'conversation', runId: 'run' } as unknown as PersonaActivity,
    task, goal, revision: { id: 'revision', contentHash: 'revision-hash', flowSnapshot: flow } as BehaviorRevision,
    lease, head: structuredClone(lease), dispatch: { id: 'dispatch', workspaceId: 'workspace',
      personaId: 'persona', activityId: 'activity', behaviorRevisionId: 'revision', state: 'running',
      admission: { kind: 'assignment', source: { kind: 'assignment', sourceId: 'task' } },
      flowInput: { conversationId: 'conversation', runId: 'run' } } as PersonaFlowDispatchRecord,
  };
  const approval = { ownerId: 'owner', credentialId: 'administrator', policyRevision: 'a'.repeat(64) };
  book = { version: 1, accounts: [{ id: 'account', ownerId: 'owner', modelId: 'model', kind: 'openai',
    modelDigest: ownerDigest(accountModelPlan(model)), credential: 'encrypted-fixture',
    routingHeaders: { 'http-referer': '', 'x-title': '', 'openai-organization': '', 'openai-project': '' },
    state: 'active', approval, createdAt: 1, updatedAt: 1 }], enrollments: [{ id: 'enrollment', workspace: 'workspace',
    ownerId: 'owner', personaId: 'persona', taskId: 'task', accountId: 'account', modelId: 'model',
    workerAuthorizationDigest: 'b'.repeat(64), budget: { maxModelSteps: null, maxOutputTokens: null },
    approval, allowedTools: [], commands: [], state: 'active', createdAt: 1, updatedAt: 1 }], steps: [] };
});

it('joins the genuine live root and keeps a stable Original run across a new lease capture', async () => {
  const first = await capture();
  assertOriginalOwnerAuthority(first.authority);
  expect(Object.isFrozen(first.authority)).toBe(true);
  expect(Object.isFrozen(first.authority.binding)).toBe(true);
  expect(first.authority.binding).toMatchObject({ workspace: 'workspace', ownerId: 'owner',
    enrollmentId: 'enrollment', accountId: 'account', modelId: 'model', leaseId: 'lease',
    taskId: 'task', goalId: 'goal', activityId: 'activity', dispatchId: 'dispatch', revisionId: 'revision' });
  await expect(first.authority.assertModelPlan({ nodeId: 'process', modelId: 'model',
    conversationId: 'conversation', runId: 'run', flowId: 'flow', flowSnapshot: input().flow })).resolves.toBeUndefined();
  await expect(first.authority.assertRunPlan({ conversationId: 'conversation', runId: 'run',
    flowId: 'flow', flowSnapshot: input().flow })).resolves.toBeUndefined();
  runtime.lease.id = 'next-lease'; runtime.lease.fencingToken = 2;
  runtime.head = structuredClone(runtime.lease); runtime.activity.leaseId = runtime.lease.id;
  const replacement = input();
  replacement.leaseEpoch = bytesDigest(canonicalJson({ workspaceId: 'workspace', personaId: 'persona',
    activityId: 'activity', leaseId: 'next-lease', holderId: 'holder', fencingToken: 2 }));
  const nextRoot = genuineRoot(replacement); await captureOriginalOwnerAuthority(nextRoot, replacement);
  const next = (await getOriginalOwnerAuthority(nextRoot))!;
  expect(next.binding.originalRunId).toBe(first.authority.binding.originalRunId);
  expect(next.binding.leaseId).not.toBe(first.authority.binding.leaseId);
  expect(book.runs).toHaveLength(1);
  await expect(first.authority.assertCurrent()).rejects.toThrow('original_owner_lease_or_goal_changed');
});

it('does not admit JSON, inherited roots, local enrollment intent or cloned capabilities', async () => {
  await expect(getOriginalOwnerAuthority(JSON.parse(JSON.stringify(input())))).resolves.toBeUndefined();
  const fake = Object.freeze({ signal: controller.signal, assertCurrent: async () => {},
    commitWhileCurrent: async <T>(task: () => Promise<T>) => task() });
  await expect(captureOriginalOwnerAuthority(fake, input())).rejects.toThrow('dispatcher-owned');
  expect(book.runs).toBeUndefined(); expect(bookWitness).not.toHaveBeenCalled();
  const { root, authority } = await capture();
  await expect(getOriginalOwnerAuthority(Object.create(root))).resolves.toBeUndefined();
  await expect(getOriginalOwnerAuthority({ ...root })).resolves.toBeUndefined();
  expect(() => assertOriginalOwnerAuthority(Object.freeze({ ...authority }))).toThrow('original_owner_runtime_authority_required');
  expect(() => assertOriginalOwnerAuthority(JSON.parse(JSON.stringify(authority.binding)))).toThrow('original_owner_runtime_authority_required');
});

it('durably claims the exact admitted Original root before exposing any runtime capability', async () => {
  const root = genuineRoot();
  atBookFlush = async () => {
    expect(book.runs).toHaveLength(1);
    await expect(getOriginalOwnerAuthority(root)).resolves.toBeUndefined();
  };
  await captureOriginalOwnerAuthority(root, input());
  const authority = (await getOriginalOwnerAuthority(root))!;
  expect(book.runs).toEqual([{ id: authority.binding.originalRunId, enrollmentId: 'enrollment', ownerId: 'owner',
    workspace: 'workspace', personaId: 'persona', taskId: 'task', activityId: 'activity', dispatchId: 'dispatch',
    revisionId: 'revision', conversationId: 'conversation', runId: 'run', modelId: 'model',
    modelDigest: book.accounts[0].modelDigest, flowId: 'flow', planDigest: authority.binding.planDigest,
    createdAt: expect.any(Number) }]);
  expect(bookWitness.mock.calls).toEqual([['acquired'], ['explicit-flush'], ['store-flushed'], ['released']]);
});

it('rechecks enrollment under the book writer after waiting for its lock', async () => {
  const root = genuineRoot();
  beforeBookMutation = async () => { book.enrollments[0].state = 'revoked'; };
  await expect(captureOriginalOwnerAuthority(root, input())).rejects.toThrow('original_owner_enrollment_changed');
  expect(book.runs).toBeUndefined();
  await expect(getOriginalOwnerAuthority(root)).resolves.toBeUndefined();
});

it('never exposes a runtime capability when durable claim publication fails or its fence changes', async () => {
  const root = genuineRoot();
  atBookFlush = async () => { throw new Error('Claim durability failed'); };
  await expect(captureOriginalOwnerAuthority(root, input())).rejects.toThrow('Claim durability failed');
  await expect(getOriginalOwnerAuthority(root)).resolves.toBeUndefined();
  atBookFlush = async () => { controller.abort(new Error('Owner stopped before capture returned')); };
  const nextRoot = genuineRoot();
  await expect(captureOriginalOwnerAuthority(nextRoot, input())).rejects.toThrow('Owner stopped before capture returned');
  await expect(getOriginalOwnerAuthority(nextRoot)).resolves.toBeUndefined();
});

it.each(['ownerId', 'enrollmentId', 'workspace', 'personaId', 'taskId', 'activityId', 'dispatchId',
  'revisionId', 'conversationId', 'runId', 'modelId', 'modelDigest', 'flowId', 'planDigest'] as const)(
  'refuses to overwrite a saved Original claim with changed %s', async field => {
    await capture();
    const prior = book.runs![0];
    const changed = { ...prior, [field]: field.endsWith('Digest') ? 'f'.repeat(64) : 'other-identity' };
    book.runs = [changed];
    const root = genuineRoot();
    await expect(captureOriginalOwnerAuthority(root, input())).rejects.toThrow('original_owner_run_claim_changed');
    expect(book.runs).toEqual([changed]);
    await expect(getOriginalOwnerAuthority(root)).resolves.toBeUndefined();
  },
);

it('preserves an existing claim creation time and appends a genuinely distinct root without overwriting it', async () => {
  await capture();
  book.runs![0].createdAt = 1;
  const prior = structuredClone(book.runs![0]);
  const sameRoot = genuineRoot();
  await captureOriginalOwnerAuthority(sameRoot, input());
  expect(book.runs).toEqual([prior]);
  runtime.activity.runId = 'next-run'; runtime.dispatch.flowInput!.runId = 'next-run';
  const nextInput = input(); nextInput.runId = 'next-run';
  const nextRoot = genuineRoot(nextInput);
  await captureOriginalOwnerAuthority(nextRoot, nextInput);
  const authority = (await getOriginalOwnerAuthority(nextRoot))!;
  expect(book.runs).toHaveLength(2); expect(book.runs![0]).toEqual(prior);
  expect(book.runs![1]).toMatchObject({ id: authority.binding.originalRunId, runId: 'next-run' });
  expect(authority.binding.originalRunId).not.toBe(prior.id);
});

it('leaves ordinary unenrolled tasks without a capability and separates captured Native authority', async () => {
  const root = genuineRoot(); book.enrollments = [];
  await captureOriginalOwnerAuthority(root, input());
  await expect(getOriginalOwnerAuthority(root)).resolves.toBeUndefined();
  expect(commitWitness).not.toHaveBeenCalled();
  book.accounts[0].kind = 'codex';
  model.adapter = 'codex-cli'; model.name = 'gpt-6-luna'; delete model.ownerCredentialBinding;
  book.accounts[0].modelDigest = ownerDigest(accountModelPlan(model));
  book.enrollments = [{ id: 'native', workspace: 'workspace', ownerId: 'owner', personaId: 'persona',
    taskId: 'task', accountId: 'account', modelId: 'model', workerAuthorizationDigest: 'c'.repeat(64),
    budget: { maxModelSteps: null, maxOutputTokens: null }, approval: book.accounts[0].approval,
    allowedTools: [], commands: [], state: 'active', createdAt: 1, updatedAt: 1 }];
  await captureOriginalOwnerAuthority(root, input());
  await expect(getOriginalOwnerAuthority(root)).resolves.toBeUndefined();
  await expect(getNativeOriginalOwnerAuthority(root)).resolves.toBeDefined();
  const captured = await getCapturedNativeOwnerRun({ workspace, runId: 'dispatch', goalId: 'goal', rootConversationId: 'conversation' });
  expect(captured?.personaAuthority).toBe(root);
  expect(captured?.authority.binding.runId).toBe('run');
  expect(captured?.authority.binding.dispatchId).toBe('dispatch');
  await expect(getCapturedNativeOwnerRun({ workspace, runId: 'run', goalId: 'goal', rootConversationId: 'conversation' }))
    .resolves.toBeUndefined();
  controller.abort();
  await expect(getCapturedNativeOwnerRun({ workspace, runId: 'dispatch', goalId: 'goal', rootConversationId: 'conversation' }))
    .resolves.toBeUndefined();
});

describe('production Native Parent using captured dispatcher authority', () => {
  const authorization = `Bearer ${'w'.repeat(43)}`;
  const claim = { workspace: 'workspace', runId: 'dispatch', goalId: 'goal', rootConversationId: 'conversation' };
  const profile = { verifiedCliVersion: '0.157.1', verifiedCliSha256: 'a'.repeat(64),
    verifiedCliPath: path.resolve('private-codex'), verifiedModelCatalogPath: path.resolve('private-catalog'),
    verifiedModelCatalogSha256: 'b'.repeat(64) };
  let directory: string;
  let parent: ReturnType<typeof createOriginalOwnerNativeParent>;
  let root: FlowExecutionAuthority;
  let client: Client | undefined;
  let context: object;
  let installedChild: Flow;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(),'flujo-native-parent-'));
    nativeSettlement = true;
    model.adapter = 'codex-cli'; model.name = 'gpt-6-luna'; delete model.ownerCredentialBinding;
    Object.assign(book.accounts[0], { kind: 'codex', credential: '', routingHeaders: {}, nativeProfile: profile,
      nativeAccountScope: 'd'.repeat(64), modelDigest: ownerDigest(accountModelPlan(model)) });
    Object.assign(book.enrollments[0], { workerAuthorizationDigest: bytesDigest(authorization), directory,
      allowedTools: ['worker_read_file','worker_write_file','worker_list_dir','worker_command'],
      commands: ['node -e "process.stdout.write(\'native-parent-ok\')"'] });
    const childNode = (id: string, type: string) => ({ id, type, position: { x: 0, y: 0 },
      data: { label: id, type, properties: type === 'process' ? { boundModel: model.id } : {} } });
    installedChild = { id: 'native-child', name: 'Installed child',
      nodes: [childNode('child-start','start'),childNode('child-process','process'),childNode('child-finish','finish')],
      edges: [{ id: 'child-a',source: 'child-start',target: 'child-process',sourceHandle: 'start-bottom',targetHandle: 'process-top' },
        { id: 'child-b',source: 'child-process',target: 'child-finish',sourceHandle: 'process-bottom',targetHandle: 'finish-top' }] };
    runtime.revision.flowSnapshot.nodes.push({ id: 'installed-subflow', type: 'subflow',position: { x: 0,y: 0 },
      data: { label: 'Installed child',type: 'subflow',properties: { subflowId: installedChild.id } } });
    runtime.revision.flowSnapshot.executionDependencies = { schemaVersion: 1,workspaceId: workspace,
      flows: [{ flowId: installedChild.id,contentHash: hashBehaviorFlow(installedChild),flowSnapshot: installedChild }] };
    verifyBehaviorDependencies(runtime.revision.flowSnapshot);
    root = genuineRoot(); await captureOriginalOwnerAuthority(root,input());
    const probe = http.createServer();
    await new Promise<void>(resolve => probe.listen(0,'127.0.0.1',resolve));
    const address = probe.address(); if (!address || typeof address === 'string') throw new Error('missing test port');
    await new Promise<void>(resolve => probe.close(() => resolve()));
    parent = createOriginalOwnerNativeParent({ sourceOrigin: 'http://127.0.0.1:4200',
      toolOrigin: `http://127.0.0.1:${address.port}`, codexProfile: profile });
  });
  afterEach(async () => {
    controller.abort();
    const results = await Promise.allSettled([client?.close(),parent?.close()]); client = undefined;
    await fs.rm(directory,{ recursive: true, force: true });
    const failures = results.filter(result => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(value => (value as PromiseRejectedResult).reason));
  });
  async function admit() {
    context = await parent.transport.admit(authorization,claim);
    await parent.transport.bindRun(context,'conversation','run');
    return context;
  }
  async function connect() {
    client = new Client({ name: 'native-parent-regression',version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(parent.transport.toolConfig.serverUrl),
      { requestInit: { headers: parent.transport.toolConfig.headers } }));
    return client;
  }

  it('authenticates the actual enrollment, preserves distinct fleet/logical IDs and refuses replay', async () => {
    await expect(parent.transport.admit(`Bearer ${'x'.repeat(43)}`,claim)).rejects.toThrow('worker_refused');
    await admit();
    const plan = await parent.transport.readPlan(context);
    expect(plan.flowDigest).toBe(nativeDigest(input().flow));
    const selected = await parent.transport.readRoot(context, { ...plan,workspace,conversationId: 'conversation',runId: 'run' });
    expect(selected).toMatchObject({ fleetRunId: 'dispatch',logicalRunId: 'run',workerId: 'enrollment',goalId: 'goal' });
    await expect(parent.transport.admit(authorization,claim)).rejects.toThrow('worker_refused');
    expect(book.steps.filter(step => step.kind === 'native')).toHaveLength(1);
  });
  it('combines current authority with exact installed plan and children verification', async () => {
    await admit();
    const plan = await parent.transport.readPlan(context);
    const children = await parent.transport.readChildren!(context);
    await expect(parent.transport.assertPlan!(context,plan,children)).resolves.toBeUndefined();
    await expect(parent.transport.assertPlan!(context,{ ...plan,modelDigest:'f'.repeat(64) },children)).rejects.toThrow();
    await expect(parent.transport.assertPlan!(context,plan,[{ ...plan,parentNodeId:'forged-parent' }])).rejects.toThrow();
    controller.abort(new Error('unit authority revoked'));
    await expect(parent.transport.assertPlan!(context,plan,children)).rejects.toThrow();
  });
  it('authenticates a pinned causal child against the actual live Parent lane without granting Persona abilities', async () => {
    const composition = createNativeSourceComposition(parent), restore = registerExecutionExtension(composition.adapter);
    try {
      const attribution = { personaId: 'persona',activityId: 'activity',behaviorRevisionId: 'revision' };
      await parent.withCapturedRun({ source: 'internal',flowId: 'flow',conversationId: 'conversation',runId: 'run',
        flowDefinition: input().flow,executionAuthority: root,personaAttribution: attribution },async selected => {
        const state = { conversationId: 'conversation',logicalRunId: 'run',flowId: 'flow',flowSnapshot: input().flow,
          status: 'running',runDepth: 0,executionAuthority: root,executionExtensionContext: selected.executionExtensionContext,
          subflowInvocations: { invocation: { version: 1,id: 'invocation',parentConversationId: 'conversation',
            parentRunId: 'conversation',parentNodeId: 'installed-subflow',status: 'running',
            lanes: [{ id: 'lane',conversationId: 'child-conversation',subflowId: installedChild.id,status: 'running' }] } },
        } as unknown as SharedState;
        FlowExecutor.conversationStates.set('conversation',state);
        const childInput = { source: 'subflow' as const,flowId: installedChild.id,flowDefinition: installedChild,
          conversationId: 'child-conversation',parentRunId: 'conversation',depth: 1,mode: 'conversation' as const,
          executionAuthority: subflowExecutionAuthority(root),personaAttribution: attribution,
          lane: { invocationId: 'invocation',laneId: 'lane',parentNodeId: 'installed-subflow',laneIndex: 0,laneCount: 1 } };
        const delegated = await prepareExecutionSubflowInput(childInput);
        expect(delegated?.executionExtensionContext).toBeDefined();
        expect(delegated?.executionExtensionContext).not.toBe(selected.executionExtensionContext);
        await validateExecutionExtensionRun(delegated!);
        expect(executionExtensionSharesPersonaAuthority(delegated!.executionExtensionContext,childInput.executionAuthority)).toBe(true);
        const invalid = [
          { executionAuthority: root },
          { executionAuthority: Object.freeze({ signal: root.signal,assertCurrent: () => root.assertCurrent(),commitWhileCurrent: root.commitWhileCurrent }) },
          { flowDefinition: { ...installedChild,name: 'Substituted graph' } },
          { personaAttribution: { ...attribution,activityId: 'foreign-activity' } },
          { personaCoreAppRefs: [] },
          { personaInstructionContext: { schemaVersion: 1 } },
        ];
        for (const delta of invalid) await expect(validateExecutionExtensionRun({ ...delegated!,...delta } as never)).rejects.toThrow();
        state.subflowInvocations!.invocation.lanes[0].status = 'completed';
        await expect(validateExecutionExtensionRun(delegated!)).rejects.toThrow();
        state.subflowInvocations!.invocation.lanes[0].status = 'running';
        state.logicalRunId = 'foreign-run';
        await expect(validateExecutionExtensionRun(delegated!)).rejects.toThrow();
      });
    } finally { FlowExecutor.conversationStates.delete('conversation');restore();await composition.close(); }
  });
  it('holds both real capability fences throughout awaited Source commits and checks revocation', async () => {
    await admit();
    await parent.transport.commit(context,async () => {
      expect(inCommit).toBe(true); expect(inBook).toBe(true);
      await new Promise(resolve => setTimeout(resolve,10));
      expect(inCommit).toBe(true); expect(inBook).toBe(true);
    });
    approvalCurrent = false;
    await expect(parent.transport.commit(context,async () => { throw new Error('must not run'); })).rejects.toThrow('approval_revoked');
  });
  it('executes actual HTTP Worker effects once and returns private argument-bound receipts', async () => {
    await admit(); const connected = await connect();
    const args = { path: 'result.txt',content: 'native-parent-evidence' };
    const issued = await parent.transport.issueTool(context,'worker_write_file',args);
    const response = await connected.callTool({ name: 'worker_write_file',arguments: args,
      _meta: { seagulledNative: issued } });
    expect(response.isError).not.toBe(true);
    expect(response._meta).toEqual({ seagulledNative: { ticket: issued.ticket,name: 'worker_write_file',argsDigest: ownerDigest(args) } });
    expect(await fs.readFile(path.join(directory,'result.txt'),'utf8')).toBe('native-parent-evidence');
    expect((await connected.callTool({ name: 'worker_write_file',arguments: args,_meta: { seagulledNative: issued } })).isError).toBe(true);
    expect(book.steps.filter(step => step.kind === 'tool')).toEqual([expect.objectContaining({ state: 'completed',argsDigest: ownerDigest(args) })]);
  });
  it('spends altered-argument tickets and refuses missing tickets and revoked accounts', async () => {
    await admit(); const connected = await connect();
    const issued = await parent.transport.issueTool(context,'worker_list_dir',{ path: '.' });
    expect((await connected.callTool({ name: 'worker_list_dir',arguments: { path: 'foreign' },_meta: { seagulledNative: issued } })).isError).toBe(true);
    expect((await connected.callTool({ name: 'worker_list_dir',arguments: { path: '.' },_meta: { seagulledNative: issued } })).isError).toBe(true);
    expect((await connected.callTool({ name: 'worker_list_dir',arguments: { path: '.' } })).isError).toBe(true);
    book.accounts[0].state = 'revoked';
    await expect(parent.transport.issueTool(context,'worker_list_dir',{ path: '.' })).rejects.toThrow();
  });
  it('observes subscription identity drift, aborts on OFF and closes its observer', async () => {
    await admit(); const watch = await parent.transport.observe(context);
    nativeAuthenticationCurrent = false;
    await expect(parent.transport.assertRun(context)).rejects.toThrow('native login changed');
    controller.abort(); expect(watch.signal.aborted).toBe(true);
    await watch.close(); await expect(parent.transport.assertRun(context)).rejects.toThrow();
    expect(book.steps.find(step => step.kind === 'native')?.state).toBe('unknown');
  });
  it('runs the genuine dispatcher input through Source without losing attribution or the Persona fence', async () => {
    const composition = createNativeSourceComposition(parent), restore = registerExecutionExtension(composition.adapter);
    try {
      const runInput = { source: 'internal' as const,flowId: 'flow',conversationId: 'conversation',runId: 'run',
        flowDefinition: input().flow,executionAuthority: root,
        personaAttribution: { personaId: 'persona',activityId: 'activity',behaviorRevisionId: 'revision' } };
      const result = await parent.withCapturedRun(runInput,async selected => {
        await validateExecutionExtensionRun(selected);
        expect(selected.personaAttribution).toEqual(runInput.personaAttribution);
        expect(selected.flowDefinition).toEqual(runInput.flowDefinition);
        expect(executionExtensionSharesPersonaAuthority(selected.executionExtensionContext,root)).toBe(true);
        expect(executionExtensionSharesPersonaAuthority(selected.executionExtensionContext,subflowExecutionAuthority(root))).toBe(true);
        expect(executionExtensionSharesPersonaAuthority(selected.executionExtensionContext,Object.freeze({
          signal: root.signal,assertCurrent: () => root.assertCurrent(),commitWhileCurrent: root.commitWhileCurrent,
        }))).toBe(false);
        const config = executionProtectedServerConfig('seagulled-worker');
        expect(config?.transport).toBe('streamable');
        expect(config && 'headers' in config ? config.headers : undefined).toEqual(parent.transport.toolConfig.headers);
        FlowExecutor.conversationStates.set('conversation',{ conversationId: 'conversation',logicalRunId: 'run',
          flowId: 'flow',flowSnapshot: input().flow,status: 'completed',runDepth: 0,
          executionExtensionContext: selected.executionExtensionContext } as SharedState);
        return 'actual-owned-worker-scope';
      });
      expect(result).toBe('actual-owned-worker-scope');
      expect(book.steps.find(step => step.kind === 'native')).toMatchObject({ state: 'completed',operation: 'source-terminal-observed' });
    } finally { FlowExecutor.conversationStates.delete('conversation'); restore(); await composition.close(); }
  });
  it('dispatches a private Worker through MCPService with no public catalog row and a real Parent receipt', async () => {
    const composition = createNativeSourceComposition(parent), restore = registerExecutionExtension(composition.adapter);
    const { MCPService } = await import('@/backend/services/mcp');
    const service = new MCPService();
    const publicCatalog = jest.spyOn(service, 'loadServerConfigs').mockResolvedValue([]);
    let connected = false;
    let serviceClient: Client | undefined;
    try {
      const runInput = { source: 'internal' as const, flowId: 'flow', conversationId: 'conversation', runId: 'run',
        flowDefinition: input().flow, executionAuthority: root,
        personaAttribution: { personaId: 'persona', activityId: 'activity', behaviorRevisionId: 'revision' } };
      await parent.withCapturedRun(runInput, async selected => {
        const extensionContext = selected.executionExtensionContext;
        if (!extensionContext) throw new Error('Native Source did not install its execution context.');
        FlowExecutor.conversationStates.set('conversation', { conversationId: 'conversation', logicalRunId: 'run',
          flowId: 'flow', flowSnapshot: input().flow, status: 'running', runDepth: 0,
          executionExtensionContext: extensionContext } as SharedState);

        // The protected endpoint is resolved from the registered trusted Source adapter.
        // The ordinary server catalog deliberately has no seagulled-worker row.
        expect(await service.loadServerConfigs()).toEqual([]);
        const connection = await import('@/backend/services/mcp/connection');
        const privateConfig = executionProtectedServerConfig('seagulled-worker');
        if (!privateConfig) throw new Error('Trusted Source adapter did not resolve its private MCP config.');
        const resolvedConfig = await connection.resolveConfigHeaders(privateConfig);
        serviceClient = connection.createNewClient(resolvedConfig);
        const transport = connection.createTransport(resolvedConfig);
        await serviceClient.connect(transport);
        (service as any).clients.set('seagulled-worker', serviceClient);
        (service as any).activeTransports.set('seagulled-worker', transport);
        connected = true;
        const reused = await service.connectServer('seagulled-worker', extensionContext);
        expect(reused.success).toBe(true);
        const listed = await service.listServerTools('seagulled-worker', 'model', extensionContext);
        expect(listed.error).toBeUndefined();
        expect(listed.tools.map(tool => tool.name)).toContain('worker_write_file');

        const args = { path: 'mcp-service-private-dispatch.txt', content: 'service-to-parent-evidence' };
        const result = await service.callTool('seagulled-worker', 'worker_write_file', args, 10_000, undefined,
          undefined, executionExtensionSignal(extensionContext), 'model', undefined, undefined, extensionContext);
        expect(result.success).toBe(true);
        expect(await fs.readFile(path.join(directory, args.path), 'utf8')).toBe(args.content);
        expect(book.steps.filter(step => step.kind === 'tool')).toEqual([
          expect.objectContaining({ state: 'completed', tool: 'worker_write_file', argsDigest: ownerDigest(args) }),
        ]);
      });
      expect(publicCatalog).toHaveBeenCalled();
    } finally {
      if (connected) {
        (service as any).deregisterClient('seagulled-worker');
        await serviceClient?.close();
      }
      publicCatalog.mockRestore();
      FlowExecutor.conversationStates.delete('conversation');
      restore();
      await composition.close();
    }
  });
});

it('does not let a genuine root claim a different saved task, run, flow or lease', async () => {
  const changed = input(); changed.runId = 'foreign-run';
  await expect(captureOriginalOwnerAuthority(genuineRoot(), changed)).rejects.toThrow('original_owner_dispatcher_capture_changed');
  const wrongFlow = input(); wrongFlow.flow.nodes[0].data.properties!.boundModel = 'foreign-model';
  await expect(captureOriginalOwnerAuthority(genuineRoot(wrongFlow), wrongFlow)).rejects.toThrow('original_owner_plan_changed');
  const wrongLease = input(); wrongLease.leaseEpoch = 'f'.repeat(64);
  await expect(captureOriginalOwnerAuthority(genuineRoot(wrongLease), wrongLease)).rejects.toThrow('original_owner_lease_or_goal_changed');
  runtime.dispatch.admission.source.sourceId = 'other-task';
  await expect(captureOriginalOwnerAuthority(genuineRoot(), input())).rejects.toThrow('original_owner_dispatch_not_current');
});

it('cannot use a legitimate root A to mint the separate valid persisted run B', async () => {
  const rootA = genuineRoot();
  runtime.activity.id = 'activity-b'; runtime.activity.runId = 'run-b';
  runtime.dispatch.id = 'dispatch-b'; runtime.dispatch.activityId = 'activity-b';
  runtime.dispatch.flowInput!.runId = 'run-b'; runtime.goal.goal!.pendingDispatchId = 'dispatch-b';
  runtime.lease.activityId = 'activity-b'; runtime.head.activityId = 'activity-b';
  const sourceB = input();
  sourceB.activityId = 'activity-b'; sourceB.dispatchId = 'dispatch-b'; sourceB.runId = 'run-b';
  sourceB.leaseEpoch = bytesDigest(canonicalJson({ workspaceId: 'workspace', personaId: 'persona',
    activityId: 'activity-b', leaseId: 'lease', holderId: 'holder', fencingToken: 1 }));
  await expect(captureOriginalOwnerAuthority(rootA, sourceB)).rejects.toThrow('original_owner_dispatcher_capture_changed');
  const rootB = genuineRoot(sourceB);
  await captureOriginalOwnerAuthority(rootB, sourceB);
  await expect(getOriginalOwnerAuthority(rootB)).resolves.toBeDefined();
});

it.each([
  ['Persona OFF', () => { runtime.persona.lifecycleState = 'disabled'; }],
  ['goal paused', () => { runtime.goal.goal!.state = 'paused'; }],
  ['new goal round', () => { runtime.goal.goal!.rounds += 1; }],
  ['dispatch cancellation', () => { runtime.dispatch.cancellationRequestedAt = Date.now(); }],
  ['different pending task', () => { runtime.goal.goal!.pendingTaskId = 'other-task'; }],
  ['task stopped', () => { runtime.task.goalControlState = 'stopped'; }],
  ['task completed', () => { runtime.task.status = 'completed'; }],
  ['lease expired', () => { runtime.lease.expiresAt = Date.now() - 1; }],
  ['lease successor', () => { runtime.head.fencingToken += 1; }],
  ['Activity waiting', () => { runtime.activity.status = 'waiting'; }],
  ['Activity interruption', () => { runtime.activity.interruptionRequestedAt = Date.now(); }],
  ['saved revision changed', () => { runtime.revision.flowSnapshot.nodes[0].data.properties!.maxTokens = 4; }],
  ['task plan changed', () => { runtime.task.description = 'Changed intent'; }],
  ['enrollment revoked', () => { book.enrollments[0].state = 'revoked'; }],
  ['enrollment moved', () => { book.enrollments[0].workspace = 'other-workspace'; }],
  ['enrollment owner changed', () => { book.enrollments[0].ownerId = 'other-owner'; }],
  ['account revoked', () => { book.accounts[0].state = 'revoked'; }],
  ['private credential changed', () => { book.accounts[0].credential = 'changed-encrypted-fixture'; }],
  ['routing changed', () => { book.accounts[0].routingHeaders['openai-project'] = 'changed'; }],
  ['budget changed', () => { book.enrollments[0].budget.maxModelSteps = 1; }],
  ['saved model changed', () => { model.name = 'changed-model'; }],
  ['saved output limit changed', () => { model.maxTokens = 7; }],
  ['saved credential injected', () => { model.ApiKey = 'not-an-owner-credential'; }],
  ['owner approval revoked', () => { approvalCurrent = false; }],
  ['workspace changed', () => { workspace = 'other-workspace'; }],
] as const)('rechecks %s before a claimed effect', async (_name, mutate) => {
  const { root, authority } = await capture();
  mutate();
  const effect = jest.fn(async () => 'effect');
  await expect(authority.commitWhileCurrent(effect)).rejects.toThrow();
  expect(effect).not.toHaveBeenCalled();
  await expect(getOriginalOwnerAuthority(root)).rejects.toThrow();
});

it('observes signal cancellation and the real fence without trusting saved state alone', async () => {
  const { authority } = await capture();
  fenceCurrent = false;
  await expect(authority.assertCurrent()).rejects.toThrow('Persona lease lost');
  fenceCurrent = true; controller.abort(new Error('Owner stopped'));
  await expect(authority.assertCurrent()).rejects.toThrow('Owner stopped');
});

it('keeps bounded callbacks under the real Persona commit without recursively acquiring it', async () => {
  const { authority } = await capture();
  commitWitness.mockClear();
  await expect(authority.commitWhileCurrent(async binding => {
    expect(inCommit).toBe(true);
    expect(binding).toBe(authority.binding);
    return 42;
  })).resolves.toBe(42);
  expect(commitWitness.mock.calls).toEqual([['acquired'], ['released']]);
  await expect(authority.commitWhileCurrent(async () => {
    runtime.goal.goal!.state = 'stopped';
  })).rejects.toThrow('original_owner_lease_or_goal_changed');
});

it.each([
  { nodeId: 'foreign-node', modelId: 'model' },
  { nodeId: 'process', modelId: 'foreign-model' },
  { nodeId: 'process', modelId: 'model', runId: 'foreign-run' },
  { nodeId: 'process', modelId: 'model', conversationId: 'foreign-conversation' },
  { nodeId: 'process', modelId: 'model', flowId: 'foreign-flow' },
])('rejects a model request outside the captured plan: %j', async plan => {
  const { authority } = await capture();
  await expect(authority.assertModelPlan(plan)).rejects.toThrow('original_owner_model_plan_changed');
});

it('requires the full captured root run before an extension context is installed', async () => {
  const { authority } = await capture();
  await expect(authority.assertRunPlan({ conversationId: 'conversation', runId: 'run' }))
    .rejects.toThrow('original_owner_run_plan_changed');
  await expect(authority.assertRunPlan({ conversationId: 'foreign', runId: 'run', flowSnapshot: input().flow }))
    .rejects.toThrow('original_owner_run_plan_changed');
  const changed = input().flow; changed.nodes[0].data.properties!.temperature = '0.1';
  await expect(authority.assertRunPlan({ conversationId: 'conversation', runId: 'run', flowSnapshot: changed }))
    .rejects.toThrow('original_owner_run_plan_changed');
});

it('reuses only its actual live Original fence for nested mutation and current checks', async () => {
  const { authority } = await capture();
  commitWitness.mockClear();
  await authority.commitWhileCurrent(async () => {
    await authority.assertCurrent();
    await authority.commitWhileCurrent(async () => { await authority.assertCurrent(); });
  });
  expect(commitWitness.mock.calls).toEqual([['acquired'], ['released']]);
  fenceCurrent = false;
  await expect(authority.assertCurrent()).rejects.toThrow('Persona lease lost');
});

it('captures an independent frozen plan and accepts only the saved known App projection', async () => {
  const source = input();
  const app = 'Existing App'; runtime.activity.coreAppRefs = [app];
  source.flow.nodes[0].data.properties!.mcpNodes = [{ id: personaCoreAppNodeId(app),
    properties: { boundServer: app, enabledTools: ['existing_tool'] } }];
  const root = genuineRoot(source); await captureOriginalOwnerAuthority(root, source);
  source.flow.nodes[0].data.properties!.boundModel = 'foreign-model';
  const authority = (await getOriginalOwnerAuthority(root))!;
  await expect(authority.assertModelPlan({ nodeId: 'process', modelId: 'model' })).resolves.toBeUndefined();
  await expect(authority.assertModelPlan({ nodeId: 'process', modelId: 'model', flowSnapshot: source.flow }))
    .rejects.toThrow('original_owner_model_plan_changed');
  const changed = input();
  changed.flow.nodes[0].data.properties!.mcpNodes = [{ id: personaCoreAppNodeId(app),
    properties: { boundServer: 'Foreign App' } }];
  await expect(captureOriginalOwnerAuthority(genuineRoot(changed), changed)).rejects.toThrow('original_owner_plan_changed');
});
