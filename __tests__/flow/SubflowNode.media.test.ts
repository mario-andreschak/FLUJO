/** Regression coverage for media-only subflow returns. */

const runFlowMock = jest.fn();
jest.mock('@/backend/execution/flow/runFlow', () => ({
  runFlow: (...args: unknown[]) => runFlowMock(...args),
}));

const copyRunResourceMock = jest.fn();
const writeRunResourceMock = jest.fn();
jest.mock('@/backend/services/runResources', () => ({
  copyRunResourceToConversation: (...args: unknown[]) => copyRunResourceMock(...args),
  writeRunResource: (...args: unknown[]) => writeRunResourceMock(...args),
}));

const getFlowMock = jest.fn(async (id: string) => ({ id, name: `flow-${id}` }));
jest.mock('@/backend/services/flow/index', () => ({
  flowService: { getFlow: (id: string) => getFlowMock(id) },
}));

import { SubflowNode } from '@/backend/execution/flow/nodes/SubflowNode';
import type { SharedState, SubflowNodeParams } from '@/backend/execution/flow/types';
import type { FlujoChatMessage } from '@/shared/types/chat';

function makeShared(overrides: Record<string, unknown> = {}): SharedState {
  return {
    conversationId: 'parent-conv',
    flowId: 'parent-flow',
    runDepth: 0,
    messages: [],
    trackingInfo: { nodeExecutionTracker: [] },
    ...overrides,
  } as unknown as SharedState;
}

function makeParams(properties: Record<string, unknown>): SubflowNodeParams {
  return {
    id: 'subflow-node',
    type: 'subflow',
    properties: { name: 'Clip generator', ...properties },
  } as unknown as SubflowNodeParams;
}

function makeNode(): SubflowNode {
  const node = new SubflowNode();
  (node as unknown as { successors: Record<string, unknown> }).successors = { NEXT: {} };
  return node;
}

function copiedEntry(sourceUri: string) {
  const sourceId = sourceUri.split('/').at(-1)!;
  return {
    id: `parent-${sourceId}`,
    uri: `flujo://run/parent-conv/parent-${sourceId}`,
    conversationId: 'parent-conv',
    mimeType: 'video/mp4',
    kind: 'blob',
    size: 123,
  };
}

beforeEach(() => {
  runFlowMock.mockReset();
  copyRunResourceMock.mockReset();
  writeRunResourceMock.mockReset();
  getFlowMock.mockClear();
  copyRunResourceMock.mockImplementation(async ({ uri }: { uri: string }) => copiedEntry(uri));
});

describe('SubflowNode media output promotion', () => {
  it('turns a media-only child response into a completed parent artifact result', async () => {
    const childUri = 'flujo://run/child-conv/clip-1';
    runFlowMock.mockResolvedValue({
      status: 'completed',
      outputText: '',
      outputMedia: [{
        type: 'video',
        mimeType: 'video/mp4',
        resourceUri: childUri,
        url: '/old-child-url',
      }],
    });
    const node = makeNode();
    const params = makeParams({ subflowId: 'video-flow', inputMode: 'isolated' });
    const shared = makeShared();

    const prep = await node.prep(shared, params);
    const exec = await node.execCore(prep);
    const action = await node.post(prep, exec, shared, params);

    expect(action).toBe('NEXT');
    expect(copyRunResourceMock).toHaveBeenCalledWith(expect.objectContaining({
      uri: childUri,
      conversationId: 'parent-conv',
      producedBy: expect.objectContaining({ source: 'capture', nodeId: 'subflow-node' }),
    }));
    const folded = shared.messages.at(-1) as FlujoChatMessage;
    expect(folded.content).toContain('Returned result from sub-agent');
    expect(folded.content).toContain('Completed artifacts:');
    expect(folded.content).toContain('flujo://run/parent-conv/parent-clip-1');
    expect(folded.content).not.toContain('finished and returned control to you with no output');
    expect(folded.media).toEqual([expect.objectContaining({
      type: 'video',
      resourceUri: 'flujo://run/parent-conv/parent-clip-1',
      url: '/v1/chat/conversations/parent-conv/resources/parent-clip-1/content',
    })]);
    expect(shared.lastResponse).toContain('Use `read_resource`');
  });

  it('preserves deterministic lane order when promoting parallel media', async () => {
    runFlowMock.mockImplementation(async ({ prompt }: { prompt: string }) => ({
      status: 'completed',
      outputText: '',
      outputMedia: [{
        type: 'video',
        mimeType: 'video/mp4',
        resourceUri: `flujo://run/child-${prompt}/${prompt}`,
      }],
    }));
    const node = makeNode();
    const params = makeParams({
      subflowId: 'video-flow',
      inputMode: 'isolated',
      spawnBriefs: ['first', 'second'],
      concurrencyLimit: 2,
    });
    const shared = makeShared();

    const prep = await node.prep(shared, params);
    const exec = await node.execCore(prep);
    await node.post(prep, exec, shared, params);

    expect(exec.outputMedia?.map(part => part.resourceUri)).toEqual([
      'flujo://run/child-first/first',
      'flujo://run/child-second/second',
    ]);
    expect((shared.messages.at(-1) as FlujoChatMessage).media?.map(part => part.resourceUri)).toEqual([
      'flujo://run/parent-conv/parent-first',
      'flujo://run/parent-conv/parent-second',
    ]);
  });
});
