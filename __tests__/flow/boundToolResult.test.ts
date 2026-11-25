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

  it('honors a larger custom FLUJO limit instead of the default', async () => {
    const content = 'x'.repeat(300_000);

    const outcome = await boundToolResult({
      ...baseInput(content),
      settings: {
        ...DEFAULT_RUN_RESOURCE_SETTINGS, toolResultTruncationEnabled: true,
        toolResultLimitMode: 'custom', toolResultMaxBytes: 900_000,
      },
      contextWindow: 1_000_000,
    });

    expect(outcome).toEqual({ content, spilled: false });
    expect(writeRunResourceMock).not.toHaveBeenCalled();
  });

  it('sizes the automatic limit from the model context window (#1226)', async () => {
    // 200,000 tokens / 8 * 4 bytes = 100,000 bytes.
    const settings = { ...DEFAULT_RUN_RESOURCE_SETTINGS, toolResultTruncationEnabled: true, toolResultLimitMode: 'auto' as const };
    const under = await boundToolResult({ ...baseInput('x'.repeat(99_000)), settings, contextWindow: 200_000 });
    expect(under.spilled).toBe(false);
    const over = await boundToolResult({ ...baseInput('x'.repeat(101_000)), settings, contextWindow: 200_000 });
    expect(over.spilled).toBe(true);
    expect(over.reason).toBe('limit');
    // The same 101,000 bytes fit an eighth of a 1M-token window.
    const big = await boundToolResult({ ...baseInput('x'.repeat(101_000)), settings, contextWindow: 1_000_000 });
    expect(big.spilled).toBe(false);
  });

  it('lowers a custom limit the model cannot take to the safety ceiling, with a note', async () => {
    // A 32,000-token window gives a 64,000-byte ceiling, below the 900,000-byte custom limit.
    const outcome = await boundToolResult({
      ...baseInput('x'.repeat(70_000)),
      settings: {
        ...DEFAULT_RUN_RESOURCE_SETTINGS, toolResultTruncationEnabled: true,
        toolResultLimitMode: 'custom', toolResultMaxBytes: 900_000,
      },
      contextWindow: 32_000,
    });
    expect(outcome.spilled).toBe(true);
    expect(outcome.reason).toBe('safety');
    expect(outcome.content).toContain("too large for the model's context window (32000 tokens)");
    expect(Buffer.byteLength(outcome.content, 'utf8')).toBeLessThan(70_000);
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

  it('keeps results inline when the limit is off and they fit the model', async () => {
    // Off: no line limit and no user byte limit; 300,000 bytes is under half of a 200K window.
    const content = Array.from({ length: 20_000 }, () => 'x'.repeat(14)).join('\n');

    const outcome = await boundToolResult({
      ...baseInput(content),
      settings: { ...DEFAULT_RUN_RESOURCE_SETTINGS, toolResultTruncationEnabled: false },
      contextWindow: 200_000,
    });

    expect(outcome).toEqual({ content, spilled: false });
    expect(writeRunResourceMock).not.toHaveBeenCalled();
  });

  it.each(['stored', 'refused'])('still moves a result too big for the model when the limit is off (%s spill)', async (spill) => {
    // Unknown window ⇒ 128K tokens ⇒ a 262,144-byte safety ceiling.
    const content = `START${'x'.repeat(300_000)}END`;
    if (spill === 'refused') writeRunResourceMock.mockResolvedValue({ skipped: 'size-cap' });

    const outcome = await boundToolResult({
      ...baseInput(content),
      settings: { ...DEFAULT_RUN_RESOURCE_SETTINGS, toolResultTruncationEnabled: false },
    });

    expect(outcome.spilled).toBe(true);
    expect(outcome.reason).toBe('safety');
    expect(outcome.content.startsWith('START')).toBe(true);
    expect(outcome.content.endsWith('END')).toBe(true);
    expect(outcome.content).toContain("too large for the model's context window (131072 tokens)");
    expect(outcome.content).toContain('even though the tool result size limit allows more');
    expect(Buffer.byteLength(outcome.content, 'utf8')).toBeLessThanOrEqual(262_144 + 1_024);
    expect(writeRunResourceMock).toHaveBeenCalledWith(expect.objectContaining({ data: { text: content } }));
    if (spill === 'stored') {
      expect(outcome.uri).toBe('flujo://run/conv-1/res-1');
      expect(outcome.content).toContain('use max_chars and start_char to read it in parts');
    } else {
      expect(outcome.content).toContain('the full result could not be stored');
    }
  });
});
