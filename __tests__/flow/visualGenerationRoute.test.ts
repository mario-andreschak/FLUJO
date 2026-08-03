const assertUnlockedMock = jest.fn();
const generateVisuallyMock = jest.fn();

jest.mock('@/utils/encryption/lockGate', () => ({
  assertUnlocked: (...args: unknown[]) => assertUnlockedMock(...args),
}));
jest.mock('@/backend/services/flow/visualGeneration', () => ({
  generateFlowVisually: (...args: unknown[]) => generateVisuallyMock(...args),
}));

import { POST } from '@/app/api/flow/generate/visual/route';

const request = (body: unknown) => ({
  json: async () => body,
  signal: new AbortController().signal,
}) as any;

beforeEach(() => {
  jest.clearAllMocks();
  assertUnlockedMock.mockResolvedValue(null);
  generateVisuallyMock.mockImplementation(async (
    _input: unknown,
    emit: (event: unknown) => void,
  ) => emit({ type: 'activity', message: 'working' }));
});

describe('POST /api/flow/generate/visual', () => {
  it('clamps nesting to eight and streams typed NDJSON events', async () => {
    const response = await POST(request({
      description: 'Build an agent hierarchy',
      modelId: 'model-1',
      maxDepth: 99,
      allowInstall: true,
    }));
    expect(response.status).toBe(200);
    expect(generateVisuallyMock).toHaveBeenCalledWith(
      expect.objectContaining({ maxDepth: 8, allowInstall: true }),
      expect.any(Function),
      expect.any(AbortSignal),
    );
    expect(await response.text()).toBe('{"type":"activity","message":"working"}\n');
  });

  it('rejects missing descriptions before opening a stream', async () => {
    const response = await POST(request({ modelId: 'model-1' }));
    expect(response.status).toBe(400);
    expect(generateVisuallyMock).not.toHaveBeenCalled();
  });
});
