const writeRunResourceMock = jest.fn();

jest.mock('@/backend/services/runResources', () => ({
  writeRunResource: (...args: unknown[]) => writeRunResourceMock(...args),
}));

import { boundToolResult } from '@/backend/services/runResources/boundToolResult';
import { DEFAULT_RUN_RESOURCE_SETTINGS } from '@/shared/types/runResources';

const baseInput = (content: string) => ({
  conversationId: 'conv-1',
  toolCallId: 'call-1',
  server: 'web',
  toolName: 'fetch',
  content,
  settings: { ...DEFAULT_RUN_RESOURCE_SETTINGS },
});

beforeEach(() => {
  jest.clearAllMocks();
  writeRunResourceMock.mockResolvedValue({
    uri: 'flujo://run/conv-1/res-1',
    size: 300_000,
  });
});

describe('boundToolResult FLUJO boundary', () => {
  it('keeps a result above the SDK legacy limit inline when it is below the FLUJO limit', async () => {
    const content = 'x'.repeat(60_000);

    const outcome = await boundToolResult(baseInput(content));

    expect(outcome).toEqual({ content, spilled: false });
    expect(writeRunResourceMock).not.toHaveBeenCalled();
  });

  it('spills only after the FLUJO byte limit is crossed', async () => {
    const outcome = await boundToolResult(baseInput('x'.repeat(300_000)));

    expect(outcome.spilled).toBe(true);
    expect(outcome.uri).toBe('flujo://run/conv-1/res-1');
    expect(outcome.content).toContain('flujo://run/conv-1/res-1');
    expect(writeRunResourceMock).toHaveBeenCalledTimes(1);
  });

  it('honors a larger configured FLUJO limit instead of the default', async () => {
    const content = 'x'.repeat(300_000);

    const outcome = await boundToolResult({
      ...baseInput(content),
      settings: { ...DEFAULT_RUN_RESOURCE_SETTINGS, toolResultMaxBytes: 900_000 },
    });

    expect(outcome).toEqual({ content, spilled: false });
    expect(writeRunResourceMock).not.toHaveBeenCalled();
  });
});
