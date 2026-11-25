/**
 * The Human step answer API (#1095): list waiting steps, open one, answer it.
 *
 * Runs a real flow to a real wait in a throwaway data folder. Only the unlock and
 * local-request guards are replaced. The answer route replies with a receipt first and
 * continues the run in the background, so the tests wait for the saved state to move on.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Flow, FlowNode } from '@/shared/types/flow';

jest.mock('@/utils/encryption/lockGate', () => ({ assertUnlocked: async () => null }));
const assertLocalRequestMock = jest.fn((): Response | null => null);
jest.mock('@/utils/http/localRequest', () => ({
  assertLocalRequest: (...args: unknown[]) => assertLocalRequestMock(...(args as [])),
}));
jest.mock('@/backend/services/mcp', () => {
  const known: Record<string, unknown> = { loadServerConfigs: async () => [], setNodeRoots: () => undefined };
  return { mcpService: new Proxy(known, { get: (target, name: string) => target[name] ?? (async () => ({})) }) };
});
jest.mock('@/backend/services/flow', () => ({
  flowService: { getFlow: async () => null, loadFlows: async () => [] },
}));
jest.mock('@/backend/execution/flow/validateFlowForRun', () => ({
  validateFlowForRun: async () => ({ isRunnable: true, issues: [] }),
  validateFlowObjectForRun: async () => ({ isRunnable: true, issues: [] }),
}));

import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { runFlow } from '@/backend/execution/flow/runFlow';
import { GET as list } from '@/app/api/human-tasks/route';
import { GET as read, POST as answer } from '@/app/api/human-tasks/[requestId]/route';
import { parseHumanTaskCall } from '@/utils/shared/humanStep';

jest.setTimeout(30_000);

function node(id: string, type: string, properties: Record<string, unknown> = {}): FlowNode {
  return { id, type, position: { x: 0, y: 0 }, data: { label: id, type, properties } } as FlowNode;
}

function reviewFlow(id: string): Flow {
  return {
    id,
    name: id,
    nodes: [
      node('start', 'start'),
      node('draft', 'static', { outputTemplate: 'Draft text.' }),
      node('review', 'human', { mode: 'edit', title: 'Check the email', prompt: 'Fix anything wrong.' }),
      node('send', 'static', { outputTemplate: 'Sent: ${var:review.value}' }),
      node('end', 'finish'),
    ],
    edges: [
      { id: 'a', source: 'start', target: 'draft', data: { edgeType: 'standard' } },
      { id: 'b', source: 'draft', target: 'review', data: { edgeType: 'standard' } },
      { id: 'c', source: 'review', target: 'send', data: { edgeType: 'standard' } },
      { id: 'd', source: 'send', target: 'end', data: { edgeType: 'standard' } },
    ],
  } as unknown as Flow;
}

const params = (requestId: string) => ({ params: Promise.resolve({ requestId }) });
const post = (requestId: string, body: unknown) => answer(new Request(`http://localhost/api/human-tasks/${requestId}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}) as never, params(requestId) as never);
const open = (requestId: string) => read(new Request(`http://localhost/api/human-tasks/${requestId}`) as never, params(requestId) as never);

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !check(); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(check()).toBe(true);
}

describe('/api/human-tasks', () => {
  let dataDir: string;
  let previousDataDir: string | undefined;

  beforeEach(async () => {
    previousDataDir = process.env.FLUJO_DATA_DIR;
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-human-tasks-'));
    process.env.FLUJO_DATA_DIR = dataDir;
    await fs.mkdir(path.join(dataDir, 'workspaces', 'default-workspace', 'db'), { recursive: true });
    FlowExecutor.clearFlowCache();
    FlowExecutor.conversationStates.clear();
    assertLocalRequestMock.mockReset().mockReturnValue(null);
  });

  afterEach(async () => {
    FlowExecutor.conversationStates.clear();
    if (previousDataDir === undefined) delete process.env.FLUJO_DATA_DIR;
    else process.env.FLUJO_DATA_DIR = previousDataDir;
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
  });

  async function waitingStep(conversationId: string) {
    const result = await runFlow({
      conversationId, flowDefinition: reviewFlow(conversationId), prompt: 'Go.',
      source: 'api', mode: 'conversation', flujo: true, userTurn: true,
    });
    return parseHumanTaskCall(result.pendingToolCalls![0])!;
  }

  it('lists waiting steps without their content', async () => {
    const view = await waitingStep('listed');

    const body = await (await list(new Request('http://localhost/api/human-tasks') as never)).json();

    expect(body.tasks).toEqual([expect.objectContaining({
      requestId: view.requestId, conversationId: 'listed', title: 'Check the email', mode: 'edit', status: 'waiting',
    })]);
    expect(JSON.stringify(body)).not.toContain('Draft text.');
    expect(JSON.stringify(body)).not.toContain('Fix anything wrong.');
  });

  it('shows one step with its content and digest, and reading changes nothing', async () => {
    const view = await waitingStep('opened');

    const response = await open(view.requestId);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      requestId: view.requestId, status: 'waiting', candidate: 'Draft text.', prompt: 'Fix anything wrong.', digest: view.digest,
    });
    expect(FlowExecutor.conversationStates.get('opened')?.status).toBe('awaiting_tool_approval');
  });

  it('saves an answer, replies with a receipt at once, then continues the run', async () => {
    const view = await waitingStep('answered');

    const response = await post(view.requestId, { action: 'submit', digest: view.digest, value: 'Better text.', idempotencyKey: 'tap-1' });
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(body).toMatchObject({ status: 'decided', repeat: false, receipt: { requestId: view.requestId, outcome: 'submitted' } });
    await waitFor(() => FlowExecutor.conversationStates.get('answered')?.status === 'completed');
    expect(FlowExecutor.conversationStates.get('answered')?.messages.at(-1)?.content).toBe('Sent: Better text.');

    // A client that lost the reply can send the same answer again and get the same receipt.
    const again = await post(view.requestId, { action: 'submit', digest: view.digest, value: 'Better text.', idempotencyKey: 'tap-1' });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ status: 'applied', repeat: true, receipt: { decisionId: body.receipt.decisionId } });
    expect((await post(view.requestId, { action: 'decline' })).status).toBe(409);
    const after = await (await open(view.requestId)).json();
    expect(after).toMatchObject({ status: 'applied', receipt: { decisionId: body.receipt.decisionId, outcome: 'submitted' } });
  });

  it('refuses an answer without the digest, and a wrong one, and keeps waiting', async () => {
    const view = await waitingStep('refused');

    expect((await post(view.requestId, { action: 'approve', value: 'x' })).status).toBe(409);
    expect((await post(view.requestId, { action: 'approve', digest: 'sha256:old', value: 'x' })).status).toBe(409);
    expect((await post(view.requestId, { action: 'maybe' })).status).toBe(400);
    expect(FlowExecutor.conversationStates.get('refused')?.status).toBe('awaiting_tool_approval');
  });

  it('declines without a digest and stops the run', async () => {
    const view = await waitingStep('declined');

    const response = await post(view.requestId, { action: 'decline' });

    expect(response.status).toBe(202);
    await waitFor(() => FlowExecutor.conversationStates.get('declined')?.status === 'completed');
    expect(FlowExecutor.conversationStates.get('declined')?.messages.at(-1)?.content).toBe('Not approved.');
  });

  it('keeps the same local-request guard as the chat answer route', async () => {
    const view = await waitingStep('guarded');
    assertLocalRequestMock.mockReturnValue(Response.json({ error: 'Forbidden' }, { status: 403 }));

    expect((await post(view.requestId, { action: 'decline' })).status).toBe(403);
    expect((await open(view.requestId)).status).toBe(403);
  });

  it('returns 404 for a step it does not know', async () => {
    expect((await post('no-such-step', { action: 'decline' })).status).toBe(404);
  });
});
