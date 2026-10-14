import type { Flow } from '@/shared/types/flow';
import type { Model } from '@/shared/types/model';
import type { BehaviorRevision, Persona, PersonaActivity, PersonaLease, PersonaWorkItem } from '@/shared/types/enduringAgent';
import type { FlowExecutionAuthority } from '@/backend/execution/flow/types';
import type { PersonaFlowDispatchRecord } from '@/backend/services/enduringAgents/personaDispatcher';
import type { OriginalOwnerBook } from '@/backend/services/originalOwner/types';

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
    expect(inCommit).toBe(true);
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
jest.mock('@/utils/workspace', () => ({ getCurrentWorkspace: () => workspace }));

import { canonicalJson } from '@/backend/services/enduringAgents/behaviorRevisions';
import { personaCoreAppNodeId } from '@/backend/services/enduringAgents/personaCoreAppIdentity';
import { accountModelPlan, bytesDigest, ownerDigest } from '@/backend/services/originalOwner/types';
import {
  assertOriginalOwnerAuthority, getOriginalOwnerAuthority,
  type OriginalOwnerCaptureInput,
} from '@/backend/services/originalOwner/authority';
import { captureOriginalOwnerAuthority } from '@/backend/services/originalOwner/producer';

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

it('leaves ordinary unenrolled tasks and the unimplemented native enrollment without a capability', async () => {
  const root = genuineRoot(); book.enrollments = [];
  await captureOriginalOwnerAuthority(root, input());
  await expect(getOriginalOwnerAuthority(root)).resolves.toBeUndefined();
  expect(commitWitness).not.toHaveBeenCalled();
  book.accounts[0].kind = 'codex';
  book.enrollments = [{ id: 'native', workspace: 'workspace', ownerId: 'owner', personaId: 'persona',
    taskId: 'task', accountId: 'account', modelId: 'model', workerAuthorizationDigest: 'c'.repeat(64),
    budget: { maxModelSteps: null, maxOutputTokens: null }, approval: book.accounts[0].approval,
    allowedTools: [], commands: [], state: 'active', createdAt: 1, updatedAt: 1 }];
  await captureOriginalOwnerAuthority(root, input());
  await expect(getOriginalOwnerAuthority(root)).resolves.toBeUndefined();
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
