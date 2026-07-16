/**
 * Tier 3 — auto-capture decision matrix for MCP tool results.
 *
 * captureToolResult decides, per content item, what is a data artifact worth
 * tracking vs trivial inline output:
 *  - image/audio → captured, item REPLACED by a URI stub (base64 in a tool
 *    message is pure context damage);
 *  - resource_link → registered as a payload-less 'link' (native tracking),
 *    item KEPT;
 *  - embedded resource blob → captured with origin, REPLACED;
 *  - large text (>= threshold) → captured; replaced only when
 *    replaceLargeTextWithStub is on (off by default — lossy);
 *  - short text ("file exists") → never captured;
 *  - isError results and store failures → passthrough untouched.
 */

const writeRunResourceMock = jest.fn();
jest.mock('@/backend/services/runResources', () => ({
  writeRunResource: (...args: unknown[]) => writeRunResourceMock(...args),
}));

import { captureToolResult } from '@/backend/services/runResources/capture';
import { DEFAULT_RUN_RESOURCE_SETTINGS } from '@/shared/types/runResources';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const settings = { ...DEFAULT_RUN_RESOURCE_SETTINGS, textThresholdChars: 100 };

const base = {
  conversationId: 'conv-1',
  server: 'srv',
  toolName: 'tool',
  toolCallId: 'call-1',
  nodeId: 'node-1',
  settings,
};

let entryCounter = 0;
function fakeEntry(overrides: Record<string, unknown> = {}) {
  const id = `id-${++entryCounter}`;
  return {
    id,
    uri: `flujo://run/conv-1/${id}`,
    conversationId: 'conv-1',
    size: 42,
    kind: 'text',
    encoding: 'utf8',
    createdAt: 1,
    producedBy: { source: 'tool-result' },
    readBy: [],
    ...overrides,
  };
}

beforeEach(() => {
  writeRunResourceMock.mockReset();
  writeRunResourceMock.mockImplementation(async (input: { kind: string; mimeType?: string }) =>
    fakeEntry({ kind: input.kind, mimeType: input.mimeType }));
});

describe('captureToolResult decision matrix', () => {
  it('captures an image and replaces it with a stub carrying the URI', async () => {
    const result: CallToolResult = {
      content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }],
    };
    const outcome = await captureToolResult({ ...base, result });

    expect(outcome.captured).toHaveLength(1);
    expect(writeRunResourceMock).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'image',
      mimeType: 'image/png',
      data: { base64: 'aGVsbG8=' },
      producedBy: expect.objectContaining({ toolCallId: 'call-1', server: 'srv', nodeId: 'node-1' }),
    }));
    const item = outcome.result.content[0] as { type: string; text: string };
    expect(item.type).toBe('text');
    expect(item.text).toContain('flujo://run/conv-1/');
    expect(item.text).not.toContain('aGVsbG8=');
  });

  it('registers a resource_link natively and keeps the item', async () => {
    const result: CallToolResult = {
      content: [{ type: 'resource_link', uri: 'srv://files/a.csv', name: 'a.csv', mimeType: 'text/csv' }],
    };
    const outcome = await captureToolResult({ ...base, result });

    expect(writeRunResourceMock).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'link',
      origin: { server: 'srv', uri: 'srv://files/a.csv' },
      producedBy: expect.objectContaining({ source: 'mcp-link' }),
    }));
    expect(outcome.result.content[0]).toEqual(result.content[0]); // kept verbatim
  });

  it('captures an embedded resource blob with origin and replaces it', async () => {
    const result: CallToolResult = {
      content: [{ type: 'resource', resource: { uri: 'srv://img/1', mimeType: 'image/jpeg', blob: 'QUJD' } }],
    };
    const outcome = await captureToolResult({ ...base, result });

    expect(writeRunResourceMock).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'blob',
      data: { base64: 'QUJD' },
      origin: { server: 'srv', uri: 'srv://img/1' },
    }));
    expect((outcome.result.content[0] as { type: string }).type).toBe('text');
  });

  it('captures large text but KEEPS it inline by default', async () => {
    const bigText = 'x'.repeat(500);
    const result: CallToolResult = { content: [{ type: 'text', text: bigText }] };
    const outcome = await captureToolResult({ ...base, result });

    expect(writeRunResourceMock).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'text', data: { text: bigText },
    }));
    expect((outcome.result.content[0] as { text: string }).text).toBe(bigText); // untouched
  });

  it('replaces large text with head+stub when replaceLargeTextWithStub is on', async () => {
    const bigText = 'y'.repeat(2000);
    const result: CallToolResult = { content: [{ type: 'text', text: bigText }] };
    const outcome = await captureToolResult({
      ...base,
      settings: { ...settings, replaceLargeTextWithStub: true },
      result,
    });

    const text = (outcome.result.content[0] as { text: string }).text;
    expect(text).toContain('y'.repeat(1024)); // 1 KB head survives
    expect(text).toContain('flujo://run/conv-1/');
    expect(text.length).toBeLessThan(bigText.length);
  });

  it('never captures short text', async () => {
    const result: CallToolResult = { content: [{ type: 'text', text: 'file exists' }] };
    const outcome = await captureToolResult({ ...base, result });

    expect(writeRunResourceMock).not.toHaveBeenCalled();
    expect(outcome.captured).toHaveLength(0);
    expect(outcome.result).toBe(result); // identity: nothing rewritten
  });

  it('skips capture entirely for isError results', async () => {
    const result: CallToolResult = {
      isError: true,
      content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }],
    };
    const outcome = await captureToolResult({ ...base, result });

    expect(writeRunResourceMock).not.toHaveBeenCalled();
    expect(outcome.result).toBe(result);
  });

  it('keeps the original item when the store skips (cap) or throws', async () => {
    writeRunResourceMock.mockResolvedValueOnce({ skipped: 'size-cap' });
    const img: CallToolResult = { content: [{ type: 'image', data: 'QUJD', mimeType: 'image/png' }] };
    let outcome = await captureToolResult({ ...base, result: img });
    expect(outcome.captured).toHaveLength(0);
    expect(outcome.result.content[0]).toEqual(img.content[0]); // kept, not stubbed

    writeRunResourceMock.mockRejectedValueOnce(new Error('disk full'));
    outcome = await captureToolResult({ ...base, result: img });
    expect(outcome.captured).toHaveLength(0);
    expect(outcome.result.content[0]).toEqual(img.content[0]);
  });

  it('handles mixed content: stubs the image, keeps the short text', async () => {
    const result: CallToolResult = {
      content: [
        { type: 'text', text: 'Here is your screenshot:' },
        { type: 'image', data: 'aW1n', mimeType: 'image/png' },
      ],
    };
    const outcome = await captureToolResult({ ...base, result });

    expect(outcome.captured).toHaveLength(1);
    expect((outcome.result.content[0] as { text: string }).text).toBe('Here is your screenshot:');
    expect((outcome.result.content[1] as { type: string; text: string }).type).toBe('text');
    expect((outcome.result.content[1] as { text: string }).text).toContain('flujo://run/');
  });
});
