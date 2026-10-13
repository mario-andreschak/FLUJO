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
  settings: { ...DEFAULT_RUN_RESOURCE_SETTINGS, toolResultTruncationEnabled: true },
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
      settings: { ...DEFAULT_RUN_RESOURCE_SETTINGS, toolResultTruncationEnabled: true, toolResultMaxBytes: 900_000 },
    });

    expect(outcome).toEqual({ content, spilled: false });
    expect(writeRunResourceMock).not.toHaveBeenCalled();
  });

  // ModelHandler serializes MCP JSON on one line. Exercise the shared helper's
  // independent line bound with a multiline diagnostic below the byte limit.
  it.each(['stored', 'refused'])('preserves diagnostic ends under the line limit with a %s spill below the byte limit', async (spill) => {
    const content = ['START_DIAGNOSTIC', ...Array.from({ length: 8 }, (_, index) => `MIDDLE_${index} ${'café🙂'.repeat(30)}`), 'END_DIAGNOSTIC'].join('\n');
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThan(10_000);
    writeRunResourceMock.mockResolvedValue(spill === 'stored'
      ? { uri: 'flujo://run/conv-1/error-lines', size: Buffer.byteLength(content, 'utf8') } : { skipped: 'size-cap' });
    const outcome = await boundToolResult({ ...baseInput(content), settings: {
      ...DEFAULT_RUN_RESOURCE_SETTINGS, toolResultTruncationEnabled: true, toolResultMaxBytes: 10_000, toolResultMaxLines: 2,
    } });
    expect(outcome.spilled).toBe(true);
    expect(outcome.content.startsWith('START_DIAGNOSTIC')).toBe(true);
    expect(outcome.content.endsWith('END_DIAGNOSTIC')).toBe(true);
    expect(outcome.content).not.toContain('MIDDLE_');
    expect(writeRunResourceMock).toHaveBeenCalledTimes(1);
    expect(writeRunResourceMock).toHaveBeenCalledWith(expect.objectContaining({ data: { text: content },
      producedBy: expect.objectContaining({ toolCallId: 'call-1', payloadRole: 'tool-message' }) }));
    if (spill === 'stored') expect(outcome.uri).toBe('flujo://run/conv-1/error-lines');
    else {
      expect(outcome.uri).toBeUndefined();
      expect(outcome.content).toContain('the full result could not be stored');
    }
  });

  it('does not truncate when toolResultTruncationEnabled is false', async () => {
    const content = 'x'.repeat(300_000);

    const outcome = await boundToolResult({
      ...baseInput(content),
      settings: { ...DEFAULT_RUN_RESOURCE_SETTINGS, toolResultTruncationEnabled: false },
    });

    expect(outcome).toEqual({ content, spilled: false });
    expect(writeRunResourceMock).not.toHaveBeenCalled();
  });
});
