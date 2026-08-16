/**
 * Regression test for the "Conversation completed badge on a fresh
 * conversation" bug.
 *
 * Root cause: the PATCH /v1/chat/conversations/:id handler built its response
 * summary with `status: updatedState.status || 'completed'`. A newly created
 * conversation has status undefined (it has never run), so the moment the user
 * selected a flow the PATCH response reported 'completed', the frontend list
 * adopted it, and the chat view showed a "Conversation completed" banner for a
 * conversation that never executed anything.
 *
 * The fix passes the stored status through unchanged.
 */
import type { SharedState } from '@/backend/execution/flow/types';
import { NextRequest } from 'next/server';
import { makeLocalRequest } from '../utils/localRequest';

// The route module imports the flow engine and services at top level; none of
// them are exercised by PATCH, so stub them to keep the test hermetic.
jest.mock('@/backend/execution/flow/FlowExecutor', () => ({
  FlowExecutor: { conversationStates: new Map() },
}));
jest.mock('@/backend/services/flow', () => ({ flowService: {} }));
jest.mock('@/backend/services/model', () => ({ modelService: {} }));
let mockPersonaDeleted = false;
const mockGetPersona = jest.fn(async (_personaId: string) => ({
  id: 'persona-target',
  provisioningState: 'ready',
  lifecycleState: 'idle',
}));
const mockGetPersonaDeletionTombstone = jest.fn(async (_personaId: string) =>
  mockPersonaDeleted ? { status: 'completed' } : null);
jest.mock('@/backend/services/enduringAgents', () => ({
  getPersona: (personaId: string) => mockGetPersona(personaId),
  getPersonaDeletionTombstone: (personaId: string) =>
    mockGetPersonaDeletionTombstone(personaId),
}));
jest.mock('@/backend/execution/flow/conversationLog', () => ({
  readConversationLog: jest.fn(),
  projectMessages: jest.fn(() => []),
  flushConversationLog: jest.fn(),
  deleteConversationLog: jest.fn(),
  repairTruncatedConversationLog: jest.fn(async () => undefined),
}));

// In-memory storage backing the route's loadItem/saveItem.
const stored: Record<string, SharedState> = {};
jest.mock('@/utils/storage/backend', () => ({
  loadItem: jest.fn(async (key: string) => stored[key]),
  saveItem: jest.fn(async (key: string, value: SharedState) => {
    stored[key] = value;
  }),
}));

import {
  DELETE,
  GET,
  PATCH,
} from '@/app/v1/chat/conversations/[conversationId]/route';
import { withConversationExecutionLock } from '@/backend/execution/flow/conversationExecutionLock';

function seedConversation(id: string, status: SharedState['status']) {
  stored[`conversations/${id}`] = {
    conversationId: id,
    title: 'Test',
    flowId: 'flow-1',
    trackingInfo: { executionId: 'e1', startTime: 1, nodeExecutionTracker: [] },
    messages: [],
    status,
    createdAt: 1,
    updatedAt: 1,
  } as SharedState;
}

function patchRequest(body: unknown) {
  return makeLocalRequest({ body });
}

function strictPersonaPatchRequest(
  headers: Record<string, string> = {},
) {
  return new NextRequest('http://localhost/v1/chat/conversations/conv', {
    method: 'PATCH',
    headers: {
      host: 'localhost',
      origin: 'http://localhost',
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify({ personaTargetId: 'persona-target' }),
  });
}

async function patchFlow(conversationId: string) {
  const res = await PATCH(patchRequest({ flowId: 'flow-2' }), {
    params: Promise.resolve({ conversationId }),
  });
  expect(res.status).toBe(200);
  return res.json();
}

describe('PATCH /v1/chat/conversations/:id status pass-through', () => {
  beforeEach(() => {
    for (const key of Object.keys(stored)) delete stored[key];
    mockPersonaDeleted = false;
    mockGetPersona.mockClear();
    mockGetPersonaDeletionTombstone.mockClear();
  });

  it('does not report a never-run conversation as completed when its flow changes', async () => {
    seedConversation('conv-fresh', undefined);
    const summary = await patchFlow('conv-fresh');
    expect(summary.flowId).toBe('flow-2');
    expect(summary.status).toBeUndefined();
  });

  it('preserves a real terminal status', async () => {
    seedConversation('conv-done', 'completed');
    expect((await patchFlow('conv-done')).status).toBe('completed');

    seedConversation('conv-err', 'error');
    expect((await patchFlow('conv-err')).status).toBe('error');
  });

  it('does not let the legacy PATCH route rewrite a Persona-owned snapshot', async () => {
    seedConversation('conv-persona', 'completed');
    stored['conversations/conv-persona'].personaAttribution = {
      personaId: 'persona-1',
      activityId: 'activity-1',
      behaviorRevisionId: 'revision-1',
    };

    const response = await PATCH(patchRequest({ flowId: 'flow-2' }), {
      params: Promise.resolve({ conversationId: 'conv-persona' }),
    });

    expect(response.status).toBe(409);
    expect(stored['conversations/conv-persona'].flowId).toBe('flow-1');
  });

  it('re-reads an anonymized draft after waiting and preserves its archive on rename', async () => {
    const id = 'conv-persona-draft-race';
    seedConversation(id, undefined);
    stored[`conversations/${id}`].flowId = '';
    stored[`conversations/${id}`].personaTargetId = 'persona-target';

    let release!: () => void;
    let entered!: () => void;
    const enteredLock = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const anonymization = withConversationExecutionLock(id, async () => {
      entered();
      await gate;
      const archived = { ...stored[`conversations/${id}`], personaArchived: true as const };
      delete archived.personaTargetId;
      stored[`conversations/${id}`] = archived;
    });
    await enteredLock;

    const patch = PATCH(patchRequest({ title: 'Renamed archive' }), {
      params: Promise.resolve({ conversationId: id }),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    release();
    await anonymization;

    const response = await patch;
    expect(response.status).toBe(200);
    expect(stored[`conversations/${id}`]).toMatchObject({
      title: 'Renamed archive',
      personaArchived: true,
    });
    expect(stored[`conversations/${id}`]).not.toHaveProperty('personaTargetId');
  });

  it('keeps Persona-target PATCH direct-loopback-only and rejects forwarding metadata', async () => {
    const previousMode = process.env.FLUJO_EXPOSURE_MODE;
    process.env.FLUJO_EXPOSURE_MODE = 'localhost';
    try {
      seedConversation('conv-direct-persona', undefined);
      const direct = await PATCH(strictPersonaPatchRequest(), {
        params: Promise.resolve({ conversationId: 'conv-direct-persona' }),
      });
      expect(direct.status).toBe(200);
      expect(stored['conversations/conv-direct-persona']).toMatchObject({
        flowId: '',
        personaTargetId: 'persona-target',
      });

      for (const header of [
        'forwarded',
        'x-forwarded-for',
        'x-forwarded-host',
        'x-forwarded-proto',
        'x-real-ip',
      ]) {
        const id = `conv-forwarded-${header}`;
        seedConversation(id, undefined);
        const response = await PATCH(strictPersonaPatchRequest({ [header]: 'for=203.0.113.10' }), {
          params: Promise.resolve({ conversationId: id }),
        });
        expect(response.status).toBe(403);
        expect(stored[`conversations/${id}`]).toMatchObject({ flowId: 'flow-1' });
        expect(stored[`conversations/${id}`]).not.toHaveProperty('personaTargetId');
      }
    } finally {
      if (previousMode === undefined) delete process.env.FLUJO_EXPOSURE_MODE;
      else process.env.FLUJO_EXPOSURE_MODE = previousMode;
    }
  });

  it.each([
    ['network exposure', 'network', { host: 'localhost', origin: 'http://localhost' }],
    ['public exposure', 'public', { host: 'localhost', origin: 'http://localhost' }],
    ['non-loopback Host', 'localhost', { host: 'flujo.example.com', origin: 'http://localhost' }],
    ['cross-origin Origin', 'localhost', { host: 'localhost', origin: 'https://attacker.example' }],
    ['malformed Origin', 'localhost', { host: 'localhost', origin: 'not a URL' }],
  ])('rejects Persona-target PATCH for %s', async (_label, mode, headers) => {
    const previousMode = process.env.FLUJO_EXPOSURE_MODE;
    process.env.FLUJO_EXPOSURE_MODE = mode;
    const id = `conv-rejected-${mode}-${headers.host}`;
    seedConversation(id, undefined);
    try {
      const response = await PATCH(strictPersonaPatchRequest(headers), {
        params: Promise.resolve({ conversationId: id }),
      });
      expect(response.status).toBe(403);
      expect(stored[`conversations/${id}`]).toMatchObject({ flowId: 'flow-1' });
      expect(stored[`conversations/${id}`]).not.toHaveProperty('personaTargetId');
    } finally {
      if (previousMode === undefined) delete process.env.FLUJO_EXPOSURE_MODE;
      else process.env.FLUJO_EXPOSURE_MODE = previousMode;
    }
  });

  it('revalidates deletion after waiting before converting a Flow draft to a Persona', async () => {
    const id = 'conv-flow-to-deleted-persona';
    seedConversation(id, undefined);

    let release!: () => void;
    let entered!: () => void;
    const enteredLock = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const deletion = withConversationExecutionLock(id, async () => {
      entered();
      await gate;
    });
    await enteredLock;

    const patch = PATCH(patchRequest({ personaTargetId: 'persona-target' }), {
      params: Promise.resolve({ conversationId: id }),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    mockPersonaDeleted = true;
    release();
    await deletion;

    const response = await patch;
    expect(response.status).toBe(409);
    expect(stored[`conversations/${id}`]).toMatchObject({ flowId: 'flow-1' });
    expect(stored[`conversations/${id}`]).not.toHaveProperty('personaTargetId');
  });

  it('re-reads ownership after a paused Persona-target PATCH before deleting', async () => {
    const id = 'conv-delete-target-race';
    seedConversation(id, undefined);
    let lookupStarted!: () => void;
    let releaseLookup!: () => void;
    const startedLookup = new Promise<void>((resolve) => { lookupStarted = resolve; });
    const lookupGate = new Promise<void>((resolve) => { releaseLookup = resolve; });
    mockGetPersona.mockImplementationOnce(async () => {
      lookupStarted();
      await lookupGate;
      return {
        id: 'persona-target',
        provisioningState: 'ready',
        lifecycleState: 'idle',
      };
    });

    const patch = PATCH(patchRequest({ personaTargetId: 'persona-target' }), {
      params: Promise.resolve({ conversationId: id }),
    });
    await startedLookup;
    const deletion = DELETE(makeLocalRequest(), {
      params: Promise.resolve({ conversationId: id }),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseLookup();

    expect((await patch).status).toBe(200);
    const deleteResponse = await deletion;
    expect(deleteResponse.status).toBe(409);
    expect(stored[`conversations/${id}`]).toMatchObject({
      flowId: '',
      personaTargetId: 'persona-target',
    });
  });

  it('does not let the generic read/delete route expose or erase Persona state', async () => {
    seedConversation('conv-persona', 'completed');
    stored['conversations/conv-persona'].personaAttribution = {
      personaId: 'persona-1',
      activityId: 'activity-1',
      behaviorRevisionId: 'revision-1',
    };

    const deleteResponse = await DELETE(makeLocalRequest(), {
      params: Promise.resolve({ conversationId: 'conv-persona' }),
    });
    expect(deleteResponse.status).toBe(409);
    expect(stored['conversations/conv-persona']).toBeDefined();

    const previousMode = process.env.FLUJO_EXPOSURE_MODE;
    process.env.FLUJO_EXPOSURE_MODE = 'public';
    try {
      const getResponse = await GET(new NextRequest(
        'https://flujo.example.com/v1/chat/conversations/conv-persona',
        { headers: { host: 'flujo.example.com' } },
      ), {
        params: Promise.resolve({ conversationId: 'conv-persona' }),
      });
      expect(getResponse.status).toBe(403);
    } finally {
      if (previousMode === undefined) delete process.env.FLUJO_EXPOSURE_MODE;
      else process.env.FLUJO_EXPOSURE_MODE = previousMode;
    }
  });
});
