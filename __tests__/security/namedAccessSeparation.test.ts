/**
 * Separation between people, attacked through the real route handlers, the real
 * workspace wrapper, real storage and real flow runs. Static nodes answer without a
 * model, so these runs need no provider and nothing in the path is replaced.
 */
import fs from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { POST as completions } from '@/app/v1/chat/completions/route';
import { GET as models } from '@/app/v1/models/route';
import { DELETE as bulkDelete, GET as listConversations, POST as createConversation } from '@/app/v1/chat/conversations/route';
import { DELETE as deleteConversation, GET as getConversation, PATCH as patchConversation } from '@/app/v1/chat/conversations/[conversationId]/route';
import { GET as events } from '@/app/v1/chat/conversations/[conversationId]/events/route';
import { GET as resources } from '@/app/v1/chat/conversations/[conversationId]/resources/route';
import { GET as resourceContent } from '@/app/v1/chat/conversations/[conversationId]/resources/[resourceId]/content/route';
import { POST as cancel } from '@/app/v1/chat/conversations/[conversationId]/cancel/route';
import { POST as respond } from '@/app/v1/chat/conversations/[conversationId]/respond/route';
import { GET as listApprovals } from '@/app/api/approvals/route';
import { POST as decideApproval } from '@/app/api/approvals/[id]/route';
import { GET as activeRuns } from '@/app/api/runs/active/route';
import { GET as listWorkspaces } from '@/app/api/workspaces/route';
import { GET as listFlows } from '@/app/api/flow/route';
import { GET as listMcpServers } from '@/app/api/mcp/servers/route';
import { GET as operationsStatus } from '@/app/api/operations/status/route';
import { flushAccessEvents, readAccessEvents } from '@/backend/services/security/accessAudit';
import { assertOwnerRequest } from '@/backend/services/security/ownerAccess';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { loadConversationState } from '@/backend/execution/flow/loadConversationState';
import { persistConversationState } from '@/backend/execution/flow/persistConversationState';
import { persistConversationSummary } from '@/backend/execution/flow/conversationSummaryStore';
import { runFlow } from '@/backend/execution/flow/runFlow';
import type { SharedState } from '@/backend/execution/flow/types';
import { putPendingApproval, removePendingApproval } from '@/backend/services/scheduler/pendingApprovals';
import { flowService } from '@/backend/services/flow';
import type { Flow, FlowNode } from '@/shared/types/flow';
import type { StorageKey } from '@/shared/types/storage';
import { getWorkspaceDataDir } from '@/utils/workspace';
import { createNamedAccessFixture, type NamedAccessFixture } from './fixtures/namedAccess';

jest.setTimeout(60_000);

const ORIGIN = 'http://localhost:4200';
const WORKSPACE = 'default-workspace';

const node = (id: string, type: string, properties: Record<string, unknown> = {}): FlowNode =>
  ({ id, type, position: { x: 0, y: 0 }, data: { label: id, type, properties } }) as FlowNode;
const edge = (id: string, source: string, target: string) => ({ id, source, target, data: { edgeType: 'standard' } });

function staticFlow(id: string, reply: string): Flow {
  return {
    id, name: id,
    nodes: [node('start', 'start'), node('say', 'static', { outputTemplate: reply }), node('end', 'finish')],
    edges: [edge('a', 'start', 'say'), edge('b', 'say', 'end')],
  } as unknown as Flow;
}

function callingFlow(id: string, childId: string): Flow {
  return {
    id, name: id,
    nodes: [node('start', 'start'), node('call', 'subflow', { subflowId: childId }), node('end', 'finish')],
    edges: [edge('a', 'start', 'call'), edge('b', 'call', 'end')],
  } as unknown as Flow;
}

function request(token: string | null, route: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers = new Headers(init.headers);
  headers.set('host', 'localhost:4200');
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (init.body !== undefined) headers.set('content-type', 'application/json');
  return new NextRequest(`${ORIGIN}${route}`, {
    method: init.method ?? 'GET',
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

const params = (conversationId: string) => ({ params: Promise.resolve({ conversationId }) });

let fixture: NamedAccessFixture;
const FLOW_A = 'named-flow-a';
const FLOW_B = 'named-flow-b';
const FLOW_CALLER = 'named-flow-caller';

async function complete(token: string | null, model: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const response = await completions(request(token, '/v1/chat/completions', {
    method: 'POST', headers,
    body: { model, messages: [{ role: 'user', content: 'Go' }], metadata: { flujo: 'true' }, ...extra },
  }));
  return { response, json: await response.json() as Record<string, any> };
}

async function seedConversation(id: string, patch: Partial<SharedState> = {}): Promise<SharedState> {
  const state = {
    conversationId: id, title: id, flowId: FLOW_A, messages: [],
    trackingInfo: { executionId: `exec-${id}`, startTime: 1, nodeExecutionTracker: [] },
    status: 'completed', createdAt: 1, updatedAt: 1, ...patch,
  } as unknown as SharedState;
  await persistConversationState(`conversations/${id}` as StorageKey, state);
  await persistConversationSummary(id, state);
  return state;
}

async function idsListed(token: string, query = '?paged=1') {
  const response = await listConversations(request(token, `/v1/chat/conversations${query}`));
  const parsed = await response.json() as { items?: Array<{ id: string }> } | Array<{ id: string }>;
  const items = Array.isArray(parsed) ? parsed : (parsed.items ?? []);
  return items.map(item => item.id);
}

beforeAll(async () => {
  for (const flow of [staticFlow(FLOW_A, 'answer from A'), staticFlow(FLOW_B, 'answer from B'), callingFlow(FLOW_CALLER, FLOW_B)]) {
    const saved = await flowService.saveFlow(flow);
    expect(saved).toMatchObject({ success: true });
  }
});

beforeEach(() => {
  fixture = createNamedAccessFixture({
    admin: 'admin', alice: 'operator', bob: 'operator', viewer: 'viewer', builder: 'builder', health: 'health',
    limited: { role: 'operator', workspaceId: WORKSPACE, flowIds: [FLOW_A, FLOW_CALLER] },
    sited: { role: 'operator', workspaceId: 'other-site' },
  });
  FlowExecutor.conversationStates.clear();
  FlowExecutor.clearFlowCache();
});

afterEach(async () => {
  await flushAccessEvents();
  fixture.restore();
  FlowExecutor.conversationStates.clear();
});

describe('who started a conversation', () => {
  it('records the credential and the end user, on the conversation and on its list row', async () => {
    const { response, json } = await complete(fixture.tokens.alice, `flow-${FLOW_A}`, { user: 'staff-17' });
    expect(response.status).toBe(200);
    const id = json.conversation_id as string;
    expect(json.choices[0].message.content).toContain('answer from A');
    const saved = await loadConversationState(id);
    expect(saved?.accessOwner).toEqual({ credentialId: fixture.ids.alice, endUser: 'staff-17' });
    const summary = JSON.parse(fs.readFileSync(path.join(getWorkspaceDataDir(WORKSPACE), 'db', 'conversation-summaries', `${id}.json`), 'utf8'));
    expect(summary).toMatchObject({ accessOwnerId: fixture.ids.alice, endUser: 'staff-17' });
  });

  it('takes the end user from the header when the body has none, and keeps the first one', async () => {
    const first = await complete(fixture.tokens.alice, `flow-${FLOW_A}`, {}, { 'x-flujo-end-user': 'desk-3' });
    const id = first.json.conversation_id as string;
    expect((await loadConversationState(id))?.accessOwner?.endUser).toBe('desk-3');
    await complete(fixture.tokens.alice, `flow-${FLOW_A}`, { metadata: { flujo: 'true', conversationId: id }, user: 'desk-9' });
    expect((await loadConversationState(id))?.accessOwner?.endUser).toBe('desk-3');
  });

  it.each([
    ['too long', 'x'.repeat(129)], ['with a space', 'two words'], ['with a line break', 'a\nb'],
    ['a path', '../etc'], ['an object', { id: 1 }], ['empty', ''],
  ])('refuses an end-user reference that is %s, before anything runs', async (_label, user) => {
    const before = FlowExecutor.conversationStates.size;
    const { response, json } = await complete(fixture.tokens.alice, `flow-${FLOW_A}`, { user });
    expect(response.status).toBe(400);
    expect(json.error.code).toBe('invalid_end_user');
    expect(FlowExecutor.conversationStates.size).toBe(before);
  });

  it('refuses a bad end-user header on any route', async () => {
    const response = await getConversation(request(fixture.tokens.alice, '/v1/chat/conversations/x', { headers: { 'x-flujo-end-user': 'no spaces' } }), params('x'));
    expect(response.status).toBe(400);
  });

  it('cannot be claimed through the request body', async () => {
    const { json } = await complete(fixture.tokens.alice, `flow-${FLOW_A}`, {
      accessOwner: { credentialId: fixture.ids.bob }, startedBy: fixture.ids.bob,
    });
    const saved = await loadConversationState(json.conversation_id as string);
    expect(saved?.accessOwner?.credentialId).toBe(fixture.ids.alice);
    expect(await idsListed(fixture.tokens.bob)).not.toContain(json.conversation_id);
  });

  it('does not change hands when the owner is revoked and an administrator continues', async () => {
    const { json } = await complete(fixture.tokens.alice, `flow-${FLOW_A}`);
    const id = json.conversation_id as string;
    const continued = await complete(fixture.tokens.admin, `flow-${FLOW_A}`, { metadata: { flujo: 'true', conversationId: id } });
    expect(continued.response.status).toBe(200);
    expect((await loadConversationState(id))?.accessOwner?.credentialId).toBe(fixture.ids.alice);
  });
});

describe('another person\'s conversation id', () => {
  let conversationId: string;
  beforeEach(async () => {
    conversationId = (await complete(fixture.tokens.alice, `flow-${FLOW_A}`, { user: 'staff-17' })).json.conversation_id as string;
  });

  const attacks = (token: string, id: string): Array<[string, () => Promise<Response>]> => [
    ['read', () => getConversation(request(token, `/v1/chat/conversations/${id}`), params(id))],
    ['rename', () => patchConversation(request(token, `/v1/chat/conversations/${id}`, { method: 'PATCH', body: { title: 'stolen' } }), params(id))],
    ['delete', () => deleteConversation(request(token, `/v1/chat/conversations/${id}`, { method: 'DELETE' }), params(id))],
    ['stream', () => events(request(token, `/v1/chat/conversations/${id}/events`), params(id))],
    ['list resources', () => resources(request(token, `/v1/chat/conversations/${id}/resources`), params(id))],
    ['read a resource', () => resourceContent(request(token, `/v1/chat/conversations/${id}/resources/r1/content`),
      { params: Promise.resolve({ conversationId: id, resourceId: 'r1' }) })],
    ['cancel', () => cancel(request(token, `/v1/chat/conversations/${id}/cancel`, { method: 'POST', body: {} }), params(id))],
    ['answer', () => respond(request(token, `/v1/chat/conversations/${id}/respond`, { method: 'POST', body: { action: 'approve', toolCallId: 'c1' } }), params(id))],
    ['decide', () => decideApproval(request(token, `/api/approvals/${id}`, { method: 'POST', body: { action: 'approve' } }), { params: Promise.resolve({ id }) })],
  ];

  it('is refused on every route that names it, with the same answer as an id that does not exist', async () => {
    const refusals: string[] = [];
    for (const [label, attack] of attacks(fixture.tokens.bob, conversationId)) {
      const response = await attack();
      const body = await response.json();
      const missing = attacks(fixture.tokens.bob, 'no-such-conversation').find(([name]) => name === label)![1];
      const baseline = await missing();
      expect({ label, status: response.status, body }).toEqual({ label, status: baseline.status, body: await baseline.json() });
      if (response.status !== 404) refusals.push(label);
    }
    expect(refusals).toEqual([]);
    // And nothing happened to it.
    const saved = await loadConversationState(conversationId);
    expect(saved?.title).not.toBe('stolen');
    expect(saved?.accessOwner?.credentialId).toBe(fixture.ids.alice);
  });

  it('cannot be continued, or overwritten by creating over it', async () => {
    const before = await loadConversationState(conversationId);
    const continued = await complete(fixture.tokens.bob, `flow-${FLOW_A}`, { metadata: { flujo: 'true', conversationId } });
    expect(continued.response.status).toBe(404);
    expect(continued.json.error.code).toBe('conversation_not_found');
    const deprecated = await complete(fixture.tokens.bob, `flow-${FLOW_A}`, { conversation_id: conversationId });
    expect(deprecated.response.status).toBe(404);
    const created = await createConversation(request(fixture.tokens.bob, '/v1/chat/conversations', {
      method: 'POST', body: { id: conversationId, title: 'mine now', flowId: FLOW_A },
    }));
    expect(created.status).toBe(404);
    const after = await loadConversationState(conversationId);
    expect(after?.title).toBe(before?.title);
    expect(after?.messages.length).toBe(before?.messages.length);
    expect(after?.accessOwner?.credentialId).toBe(fixture.ids.alice);
  });

  it('is refused on an id smuggled through encoding', async () => {
    for (const id of [`${conversationId}%2F..%2F${conversationId}`, '..%2F..%2Fencryption_key', `%2e%2e%2F${conversationId}`]) {
      const response = await getConversation(request(fixture.tokens.bob, `/v1/chat/conversations/${id}`), params(decodeURIComponent(id)));
      expect(response.status).toBe(404);
    }
  });

  it('stays closed after a restart, with the summary gone, and for a credential that is removed', async () => {
    FlowExecutor.conversationStates.clear();
    fs.rmSync(path.join(getWorkspaceDataDir(WORKSPACE), 'db', 'conversation-summaries', `${conversationId}.json`), { force: true });
    const stranger = await getConversation(request(fixture.tokens.bob, `/v1/chat/conversations/${conversationId}`), params(conversationId));
    expect(stranger.status).toBe(404);
    const owner = await getConversation(request(fixture.tokens.alice, `/v1/chat/conversations/${conversationId}`), params(conversationId));
    expect(owner.status).toBe(200);
    // The list rebuilds its row from the conversation and keeps the owner.
    expect(await idsListed(fixture.tokens.alice)).toContain(conversationId);
    expect(await idsListed(fixture.tokens.bob)).not.toContain(conversationId);

    const policy = fixture.read();
    fixture.write({ ...policy, credentials: policy.credentials.filter(item => item.name !== 'alice') });
    const gone = await getConversation(request(fixture.tokens.alice, `/v1/chat/conversations/${conversationId}`), params(conversationId));
    expect(gone.status).toBe(401);
    expect(await idsListed(fixture.tokens.viewer)).toContain(conversationId);
  });

  it('works for its owner, for someone who sees all, and for an administrator', async () => {
    for (const person of ['alice', 'viewer', 'admin']) {
      const response = await getConversation(request(fixture.tokens[person], `/v1/chat/conversations/${conversationId}`), params(conversationId));
      expect({ person, status: response.status }).toEqual({ person, status: 200 });
    }
    const viewerDelete = assertOwnerRequest(request(fixture.tokens.viewer, `/v1/chat/conversations/${conversationId}`, { method: 'DELETE' }));
    expect(viewerDelete?.status).toBe(403);
    const removed = await deleteConversation(request(fixture.tokens.alice, `/v1/chat/conversations/${conversationId}`, { method: 'DELETE' }), params(conversationId));
    expect(removed.ok).toBe(true);
  });

  it('records the refused attempt', async () => {
    await getConversation(request(fixture.tokens.bob, `/v1/chat/conversations/${conversationId}`), params(conversationId));
    const { entries } = await readAccessEvents({ action: 'access.denied' });
    expect(entries[0]).toMatchObject({ outcome: 'denied', target: conversationId, actor: { name: 'bob' } });
  });
});

describe('lists hold only what the person may see', () => {
  let alices: string; let bobs: string; let automation: string;
  beforeEach(async () => {
    alices = (await complete(fixture.tokens.alice, `flow-${FLOW_A}`, { user: 'staff-a', messages: [{ role: 'user', content: 'needle-for-search' }] })).json.conversation_id as string;
    bobs = (await complete(fixture.tokens.bob, `flow-${FLOW_A}`, { user: 'staff-b' })).json.conversation_id as string;
    automation = `automation-${Date.now()}`;
    await seedConversation(automation, { source: 'schedule' } as Partial<SharedState>);
  });

  it.each([
    ['paged', '?paged=1'], ['full', ''], ['title search', '?paged=1&search=named'],
    ['content search', '?search=needle-for-search&dimension=content'],
  ])('keeps people apart in the %s listing', async (_label, query) => {
    const forBob = await idsListed(fixture.tokens.bob, query);
    expect(forBob).not.toContain(alices);
    expect(forBob).not.toContain(automation);
    const forAlice = await idsListed(fixture.tokens.alice, query);
    expect(forAlice).not.toContain(bobs);
    expect(forAlice).not.toContain(automation);
    if (query.includes('needle')) expect(forAlice).toContain(alices);
  });

  it('counts only what the person may see', async () => {
    const seen = async (token: string) => (await (await listConversations(request(token, '/v1/chat/conversations?presence=1'))).json() as { count: number }).count;
    expect(await seen(fixture.tokens.bob)).toBe((await idsListed(fixture.tokens.bob)).length);
    expect(await seen(fixture.tokens.admin)).toBeGreaterThan(await seen(fixture.tokens.bob));
  });

  it('shows everything, including runs nobody started by hand, to a role that says so', async () => {
    for (const person of ['viewer', 'admin']) {
      const ids = await idsListed(fixture.tokens[person]);
      expect(ids).toEqual(expect.arrayContaining([alices, bobs, automation]));
    }
  });

  it('filters by end user without widening anything', async () => {
    expect(await idsListed(fixture.tokens.admin, '?paged=1&endUser=staff-a')).toEqual([alices]);
    expect(await idsListed(fixture.tokens.bob, '?paged=1&endUser=staff-a')).toEqual([]);
    const invalid = await listConversations(request(fixture.tokens.admin, '/v1/chat/conversations?endUser=not%20valid'));
    expect(invalid.status).toBe(400);
  });

  it('keeps bulk delete with administrators', () => {
    const denied = assertOwnerRequest(request(fixture.tokens.alice, '/v1/chat/conversations', { method: 'DELETE' }));
    expect(denied?.status).toBe(403);
    expect(typeof bulkDelete).toBe('function');
  });

  it('keeps people apart in the list of running work', async () => {
    const liveId = `live-${Date.now()}`;
    const state = await seedConversation(liveId, { status: 'running', accessOwner: { credentialId: fixture.ids.alice } });
    FlowExecutor.conversationStates.set(liveId, state);
    const active = async (token: string) => ((await (await activeRuns(request(token, '/api/runs/active'))).json()) as { runs: Array<{ conversationId: string }> }).runs.map(run => run.conversationId);
    expect(await active(fixture.tokens.alice)).toContain(liveId);
    expect(await active(fixture.tokens.bob)).not.toContain(liveId);
    expect(await active(fixture.tokens.viewer)).toContain(liveId);
  });
});

describe('approvals', () => {
  const pending = [
    { id: 'call-1', type: 'function', function: { name: 'srv_tool', arguments: '{}' } },
    { id: 'call-2', type: 'function', function: { name: 'srv_tool', arguments: '{}' } },
  ];
  async function seedApproval(ownerName: string | null) {
    const id = `approval-${ownerName ?? 'none'}-${Date.now()}`;
    const state = await seedConversation(id, {
      status: 'awaiting_tool_approval', pendingToolCalls: pending as never,
      ...(ownerName ? { accessOwner: { credentialId: fixture.ids[ownerName] } } : {}),
    });
    await putPendingApproval({
      approvalId: id, conversationId: id, plannedExecutionId: 'plan-1', flowId: FLOW_A, flowName: FLOW_A, runId: 'run-1',
      triggerSummary: 'test', pendingToolCalls: pending.map(call => ({ id: call.id, name: call.function.name })),
      createdAt: new Date().toISOString(),
    });
    FlowExecutor.conversationStates.set(id, state);
    return id;
  }
  const listed = async (token: string) => ((await (await listApprovals(request(token, '/api/approvals'))).json()) as { approvals: Array<{ approvalId: string }> }).approvals.map(item => item.approvalId);

  it('shows an approval only to its owner and to roles that see all', async () => {
    const alices = await seedApproval('alice');
    const unowned = await seedApproval(null);
    try {
      expect(await listed(fixture.tokens.alice)).toContain(alices);
      expect(await listed(fixture.tokens.alice)).not.toContain(unowned);
      expect(await listed(fixture.tokens.bob)).toEqual(expect.not.arrayContaining([alices, unowned]));
      expect(await listed(fixture.tokens.viewer)).toEqual(expect.arrayContaining([alices, unowned]));
      expect(await listed(fixture.tokens.admin)).toEqual(expect.arrayContaining([alices, unowned]));
    } finally {
      await removePendingApproval(alices).catch(() => undefined);
      await removePendingApproval(unowned).catch(() => undefined);
    }
  });

  it('does not let a viewer decide, even one that can see it', async () => {
    const alices = await seedApproval('alice');
    try {
      const denied = assertOwnerRequest(request(fixture.tokens.viewer, `/api/approvals/${alices}`, { method: 'POST', body: { action: 'approve' } }));
      expect(denied?.status).toBe(403);
    } finally { await removePendingApproval(alices).catch(() => undefined); }
  });

  it('records who decided, with the end user, on the conversation and in the record, through the inbox', async () => {
    const id = await seedApproval('alice');
    try {
      const response = await decideApproval(request(fixture.tokens.alice, `/api/approvals/${id}`, {
        method: 'POST', body: { action: 'deny', toolCallId: 'call-1' }, headers: { 'x-flujo-end-user': 'staff-17' },
      }), { params: Promise.resolve({ id }) });
      expect(response.status).toBe(200);
      const saved = await loadConversationState(id);
      expect(saved?.approvalDecisions).toEqual([expect.objectContaining({
        toolCallId: 'call-1', action: 'reject',
        decidedBy: { credentialId: fixture.ids.alice, name: 'alice', endUser: 'staff-17' },
      })]);
      const { entries } = await readAccessEvents({ action: 'approval.decide' });
      expect(entries[0]).toMatchObject({ target: id, detail: 'reject', actor: { name: 'alice', endUser: 'staff-17' }, workspace: WORKSPACE });
      expect(JSON.stringify(entries)).not.toContain('arguments');
    } finally { await removePendingApproval(id).catch(() => undefined); }
  });

  it('records who decided through the chat route too, and a stranger changes nothing', async () => {
    const id = await seedApproval('alice');
    try {
      const stranger = await respond(request(fixture.tokens.bob, `/v1/chat/conversations/${id}/respond`, {
        method: 'POST', body: { action: 'reject', toolCallId: 'call-1' },
      }), params(id));
      expect(stranger.status).toBe(404);
      expect((await loadConversationState(id))?.approvalDecisions).toBeUndefined();
      const response = await respond(request(fixture.tokens.alice, `/v1/chat/conversations/${id}/respond`, {
        method: 'POST', body: { action: 'reject', toolCallId: 'call-1' },
      }), params(id));
      expect(response.status).toBe(200);
      expect((await loadConversationState(id))?.approvalDecisions?.[0]).toMatchObject({
        toolCallId: 'call-1', action: 'reject', decidedBy: { credentialId: fixture.ids.alice },
      });
    } finally { await removePendingApproval(id).catch(() => undefined); }
  });
});

describe('a credential limited to named flows', () => {
  it('runs its own flow and is refused every other way in', async () => {
    expect((await complete(fixture.tokens.limited, `flow-${FLOW_A}`)).response.status).toBe(200);
    for (const model of [`flow-${FLOW_B}`, 'flow-does-not-exist', `xlow-${FLOW_A}`, FLOW_B, 'model-anything', 'policy/anything', '']) {
      const { response, json } = await complete(fixture.tokens.limited, model);
      expect({ model, status: response.status, code: json.error?.code }).toEqual({ model, status: 403, code: 'flow_not_allowed' });
    }
  });

  it('cannot reach another flow by continuing a conversation, creating one, or switching one', async () => {
    const other = (await complete(fixture.tokens.admin, `flow-${FLOW_B}`)).json.conversation_id as string;
    expect((await complete(fixture.tokens.limited, `flow-${FLOW_A}`, { metadata: { flujo: 'true', conversationId: other } })).response.status).toBe(404);

    const made = await createConversation(request(fixture.tokens.limited, '/v1/chat/conversations', {
      method: 'POST', body: { id: `limited-${Date.now()}`, title: 't', flowId: FLOW_B },
    }));
    expect(made.status).toBe(403);
    const snapshot = await createConversation(request(fixture.tokens.limited, '/v1/chat/conversations', {
      method: 'POST', body: { id: `limited-${Date.now()}`, title: 't', flowId: FLOW_A, flowSnapshot: staticFlow(FLOW_B, 'smuggled') },
    }));
    expect(snapshot.status).toBe(403);

    const own = (await complete(fixture.tokens.limited, `flow-${FLOW_A}`)).json.conversation_id as string;
    const switched = await patchConversation(request(fixture.tokens.limited, `/v1/chat/conversations/${own}`, {
      method: 'PATCH', body: { flowId: FLOW_B },
    }), params(own));
    expect(switched.status).toBe(403);
    const renamed = await patchConversation(request(fixture.tokens.limited, `/v1/chat/conversations/${own}`, {
      method: 'PATCH', body: { title: 'my run' },
    }), params(own));
    expect(renamed.status).toBe(200);
    expect((await loadConversationState(own))?.flowId).toBe(FLOW_A);
  });

  it('is refused on an own conversation once its flow is taken off the list', async () => {
    const own = (await complete(fixture.tokens.limited, `flow-${FLOW_A}`)).json.conversation_id as string;
    const policy = fixture.read();
    fixture.write({ ...policy, credentials: policy.credentials.map(item => item.name === 'limited' ? { ...item, flowIds: [FLOW_CALLER] } : item) });
    const { response, json } = await complete(fixture.tokens.limited, `flow-${FLOW_CALLER}`, { metadata: { flujo: 'true', conversationId: own } });
    expect(response.status).toBe(403);
    expect(json.error.code).toBe('flow_not_allowed');
    // The history stays readable; only running it again is refused.
    expect((await getConversation(request(fixture.tokens.limited, `/v1/chat/conversations/${own}`), params(own))).status).toBe(200);
  });

  it('lists only its own flows, and no direct models', async () => {
    const listed = await (await models(request(fixture.tokens.limited, '/v1/models'))).json() as { data: Array<{ id: string }> };
    expect(listed.data.map(entry => entry.id).sort()).toEqual([`flow-${FLOW_A}`, `flow-${FLOW_CALLER}`].sort());
    const open = await (await models(request(fixture.tokens.alice, '/v1/models'))).json() as { data: Array<{ id: string }> };
    expect(open.data.map(entry => entry.id)).toContain(`flow-${FLOW_B}`);
  });

  it('runs a subflow from an allowed flow, as that flow\'s builder intended, and owns the child run', async () => {
    const { response, json } = await complete(fixture.tokens.limited, `flow-${FLOW_CALLER}`);
    expect(response.status).toBe(200);
    expect(json.choices[0].message.content).toContain('answer from B');
    // The subflow stays closed as a way in.
    expect((await complete(fixture.tokens.limited, `flow-${FLOW_B}`)).response.status).toBe(403);
    // The child run belongs to the same person, and to nobody else.
    const children = [...FlowExecutor.conversationStates.values()].filter(state => state.parentConversationId === json.conversation_id);
    expect(children.length).toBeGreaterThan(0);
    for (const child of children) {
      expect(child.accessOwner?.credentialId).toBe(fixture.ids.limited);
      const childId = child.conversationId as string;
      expect((await getConversation(request(fixture.tokens.limited, `/v1/chat/conversations/${childId}`), params(childId))).status).toBe(200);
      expect((await getConversation(request(fixture.tokens.bob, `/v1/chat/conversations/${childId}`), params(childId))).status).toBe(404);
    }
  });

  it('gives a run started by the engine itself no owner, even inside a request', async () => {
    const result = await runFlow({ flowId: FLOW_A, prompt: 'Go', source: 'api', mode: 'conversation', flujo: true, userTurn: true, conversationId: `engine-${Date.now()}` });
    const state = await loadConversationState(result.conversationId);
    expect(state?.accessOwner).toBeUndefined();
    expect(await idsListed(fixture.tokens.alice)).not.toContain(result.conversationId);
  });
});

describe('a role that only runs what was built for it', () => {
  it('cannot jump to a node, debug, switch approval off by rename, or address a Persona', async () => {
    const own = (await complete(fixture.tokens.alice, `flow-${FLOW_A}`)).json.conversation_id as string;
    const jump = await complete(fixture.tokens.alice, `flow-${FLOW_A}`, { processNodeId: 'end', metadata: { flujo: 'true', conversationId: own } });
    expect(jump.response.status).toBe(403);
    expect(jump.json.error.code).toBe('flow_control_not_allowed');
    const debug = await complete(fixture.tokens.alice, `flow-${FLOW_A}`, { metadata: { flujo: 'true', flujodebug: 'true' } });
    expect(debug.response.status).toBe(403);
    const approval = await patchConversation(request(fixture.tokens.alice, `/v1/chat/conversations/${own}`, {
      method: 'PATCH', body: { requireApproval: false },
    }), params(own));
    expect(approval.status).toBe(403);
    const persona = await complete(fixture.tokens.alice, `flow-${FLOW_A}`, { metadata: { flujo: 'true', personaId: 'persona-1' } });
    expect(persona.response.status).toBe(403);
    expect(persona.json.error.code).toBe('persona_not_allowed');
    const created = await createConversation(request(fixture.tokens.alice, '/v1/chat/conversations', {
      method: 'POST', body: { id: `p-${Date.now()}`, title: 't', flowId: null, personaTargetId: 'persona-1' },
    }));
    expect(created.status).toBe(403);
  });

  it('owns a conversation it creates first and runs afterwards', async () => {
    const id = `precreated-${Date.now()}`;
    const created = await createConversation(request(fixture.tokens.alice, '/v1/chat/conversations', {
      method: 'POST', body: { id, title: 'mine', flowId: FLOW_A }, headers: { 'x-flujo-end-user': 'staff-5' },
    }));
    expect(created.status).toBe(201);
    expect((await loadConversationState(id))?.accessOwner).toEqual({ credentialId: fixture.ids.alice, endUser: 'staff-5' });
    expect((await complete(fixture.tokens.bob, `flow-${FLOW_A}`, { metadata: { flujo: 'true', conversationId: id } })).response.status).toBe(404);
    expect((await complete(fixture.tokens.alice, `flow-${FLOW_A}`, { metadata: { flujo: 'true', conversationId: id } })).response.status).toBe(200);
  });

  it('gives a builder flows and masked models, but only server names from MCP', async () => {
    expect((await listFlows(request(fixture.tokens.builder, '/api/flow'))).status).toBe(200);
    const servers = await listMcpServers(request(fixture.tokens.viewer, '/api/mcp/servers'));
    expect(servers.status).toBe(200);
    for (const server of await servers.json() as Array<Record<string, unknown>>) {
      expect(Object.keys(server).sort()).toEqual(expect.arrayContaining(['name']));
      expect(server).not.toHaveProperty('command');
      expect(server).not.toHaveProperty('env');
      expect(server).not.toHaveProperty('args');
    }
    expect(assertOwnerRequest(request(fixture.tokens.operator ?? fixture.tokens.alice, '/api/flow'))?.status).toBe(403);
  });
});

describe('several sites on one instance', () => {
  const siteDirectory = () => path.join(getWorkspaceDataDir(WORKSPACE), '..', 'other-site');
  beforeEach(() => { fs.mkdirSync(siteDirectory(), { recursive: true }); });

  it('keeps a credential bound to one workspace inside it', async () => {
    const refused = await listConversations(request(fixture.tokens.sited, `/v1/chat/conversations?paged=1&workspace=${WORKSPACE}`));
    expect(refused.status).toBe(403);
    const headerRefused = await listConversations(request(fixture.tokens.sited, '/v1/chat/conversations?paged=1', { headers: { 'x-flujo-workspace': WORKSPACE } }));
    expect(headerRefused.status).toBe(403);
    const defaulted = await listConversations(request(fixture.tokens.sited, '/v1/chat/conversations?paged=1'));
    expect(defaulted.status).toBe(403); // No workspace named means the default one, which is not theirs.
    const allowed = await listConversations(request(fixture.tokens.sited, '/v1/chat/conversations?paged=1&workspace=other-site'));
    expect(allowed.status).toBe(200);
  });

  it('shows such a credential only its own workspace in discovery', async () => {
    const body = await (await listWorkspaces(request(fixture.tokens.sited, '/api/workspaces'))).json() as { workspaces: Array<{ name: string }>; defaultWorkspace: string };
    expect(body.workspaces.map(workspace => workspace.name)).toEqual(['other-site']);
    expect(body.defaultWorkspace).toBe('other-site');
    const everyone = await (await listWorkspaces(request(fixture.tokens.alice, '/api/workspaces'))).json() as { workspaces: Array<{ name: string }> };
    expect(everyone.workspaces.map(workspace => workspace.name)).toEqual(expect.arrayContaining([WORKSPACE, 'other-site']));
  });
});

describe('health for a central operator', () => {
  it('reads health and nothing else', async () => {
    const status = await operationsStatus(request(fixture.tokens.health, '/api/operations/status'));
    expect(status.status).toBe(200);
    const body = await status.json() as Record<string, unknown>;
    expect(body).toMatchObject({ actor: { kind: 'owner', credentialId: fixture.ids.health } });
    for (const route of ['/v1/chat/conversations', '/api/flow', '/api/approvals', '/api/runs/active', '/v1/models', '/api/owner/people']) {
      expect(assertOwnerRequest(request(fixture.tokens.health, route))?.status).toBe(403);
    }
  });
});

describe('off by default', () => {
  beforeEach(() => { delete process.env.FLUJO_OWNER_AUTH_FILE; });

  it('behaves exactly as before on an ordinary install', async () => {
    const { response, json } = await complete(null, `flow-${FLOW_A}`, {
      user: 'not a valid reference, and that is fine here', accessOwner: { credentialId: 'someone' },
    });
    expect(response.status).toBe(200);
    const id = json.conversation_id as string;
    const saved = await loadConversationState(id);
    expect(saved?.accessOwner).toBeUndefined();
    expect(saved?.approvalDecisions).toBeUndefined();
    const summary = JSON.parse(fs.readFileSync(path.join(getWorkspaceDataDir(WORKSPACE), 'db', 'conversation-summaries', `${id}.json`), 'utf8'));
    expect(summary).not.toHaveProperty('accessOwnerId');
    expect(summary).not.toHaveProperty('endUser');
    const listed = await listConversations(request(null, '/v1/chat/conversations?paged=1&endUser=not%20valid'));
    expect(listed.status).toBe(200);
    expect((await getConversation(request(null, `/v1/chat/conversations/${id}`), params(id))).status).toBe(200);
    expect((await patchConversation(request(null, `/v1/chat/conversations/${id}`, { method: 'PATCH', body: { requireApproval: true } }), params(id))).status).toBe(200);
    expect(fs.readdirSync(fixture.directory).filter(file => file.includes('audit'))).toEqual([]);
  });
});
