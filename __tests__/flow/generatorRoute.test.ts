const assertUnlockedMock = jest.fn();
const buildSnapshotMock = jest.fn();
const restoreMock = jest.fn();
const gatherContextMock = jest.fn();

jest.mock('@/utils/encryption/lockGate', () => ({
  assertUnlocked: (...args: unknown[]) => assertUnlockedMock(...args),
}));
jest.mock('@/backend/services/flow/systemFlows', () => ({
  buildFlowGeneratorSnapshot: (...args: unknown[]) => buildSnapshotMock(...args),
  restoreVendoredFlowGenerator: (...args: unknown[]) => restoreMock(...args),
}));
jest.mock('@/backend/services/flow/generationContext', () => ({
  gatherGenerationContext: (...args: unknown[]) => gatherContextMock(...args),
}));

import { POST, PUT } from '@/app/api/flow/generator/route';

const req = (body: unknown) => ({ json: async () => body }) as any;
const sessionFlow = {
  id: 'quickchat-flow-generator-conversation-1',
  name: 'Flow Generator Session',
  nodes: [],
  edges: [],
};

beforeEach(() => {
  jest.clearAllMocks();
  assertUnlockedMock.mockResolvedValue(null);
  gatherContextMock.mockResolvedValue({
    compile: { models: [{ id: 'model-1' }] },
  });
  buildSnapshotMock.mockResolvedValue(sessionFlow);
  restoreMock.mockResolvedValue(sessionFlow);
});

describe('/api/flow/generator', () => {
  it('passes explicit MCP-install consent into the Flow session snapshot', async () => {
    const response = await POST(req({
      conversationId: 'conversation-1',
      modelId: 'model-1',
      allowInstall: true,
    }));

    expect(response.status).toBe(200);
    expect(buildSnapshotMock).toHaveBeenCalledWith(
      'conversation-1',
      'model-1',
      { allowInstall: true },
    );
  });

  it('keeps installation off for omitted or malformed consent values', async () => {
    await POST(req({
      conversationId: 'conversation-1',
      modelId: 'model-1',
      allowInstall: 'yes',
    }));
    expect(buildSnapshotMock).toHaveBeenCalledWith(
      'conversation-1',
      'model-1',
      { allowInstall: false },
    );
  });

  it('rejects an unknown model before creating a snapshot', async () => {
    const response = await POST(req({
      conversationId: 'conversation-1',
      modelId: 'missing',
    }));
    expect(response.status).toBe(400);
    expect(buildSnapshotMock).not.toHaveBeenCalled();
  });

  it('restores the bundled experimental Flow only via PUT', async () => {
    const response = await PUT();
    expect(response.status).toBe(200);
    expect(restoreMock).toHaveBeenCalledTimes(1);
  });
});
