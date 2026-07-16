/**
 * Tier 3 — `${res:NAME}` resolution (the read-back side of captureResource).
 *
 * Mirrors resolveRunVars' total semantics: unknown names → '' (never the raw
 * token), text inlined as a delimited block, binary/link as a URI stub, a
 * resource:read event per successful resolution, and no interference with
 * `${var:NAME}` or `${resource:...}` pills (different scanners).
 */

const findByNameMock = jest.fn();
const readMock = jest.fn();
jest.mock('@/backend/services/runResources', () => ({
  findRunResourceByName: (...args: unknown[]) => findByNameMock(...args),
  readRunResource: (...args: unknown[]) => readMock(...args),
}));

import { resolveRunResourceRefs, hasRunResourceRef, RES_REF_SCAN } from '@/backend/execution/flow/resolveRunResourceRefs';

const textEntry = {
  id: 'r1',
  uri: 'flujo://run/conv-1/r1',
  conversationId: 'conv-1',
  name: 'report',
  mimeType: 'text/markdown',
  size: 11,
  kind: 'text',
  encoding: 'utf8',
  createdAt: 1,
  producedBy: { source: 'capture' },
  readBy: [],
};

const blobEntry = {
  ...textEntry,
  id: 'r2',
  uri: 'flujo://run/conv-1/r2',
  name: 'shot',
  mimeType: 'image/png',
  kind: 'image',
  encoding: 'base64',
  size: 2048,
};

beforeEach(() => {
  findByNameMock.mockReset();
  readMock.mockReset();
});

describe('resolveRunResourceRefs', () => {
  it('inlines a text resource as a delimited block and emits resource:read', async () => {
    findByNameMock.mockResolvedValue(textEntry);
    readMock.mockResolvedValue({
      entry: textEntry,
      contents: { contents: [{ uri: textEntry.uri, mimeType: 'text/markdown', text: '# weekly report' }] },
    });
    const emit = jest.fn();

    const out = await resolveRunResourceRefs('Summarize: ${res:report}', 'conv-1', emit, { nodeId: 'n1' });

    expect(out).toContain('# weekly report');
    expect(out).toContain(textEntry.uri); // delimited framing names the source
    expect(out).not.toContain('${res:');
    expect(readMock).toHaveBeenCalledWith(textEntry.uri, expect.objectContaining({ source: 'res-ref', nodeId: 'n1' }));
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'resource:read', server: 'flujo', uri: textEntry.uri, name: 'report', source: 'res-ref',
    }));
  });

  it('renders binary resources as a URI stub, never base64', async () => {
    findByNameMock.mockResolvedValue(blobEntry);
    readMock.mockResolvedValue({
      entry: blobEntry,
      contents: { contents: [{ uri: blobEntry.uri, mimeType: 'image/png', blob: 'QUJDRA==' }] },
    });

    const out = await resolveRunResourceRefs('See ${res:shot}', 'conv-1');

    expect(out).toContain(blobEntry.uri);
    expect(out).toContain('image/png');
    expect(out).not.toContain('QUJDRA==');
  });

  it("unknown name → '' (never leaks the literal token)", async () => {
    findByNameMock.mockResolvedValue(null);
    const out = await resolveRunResourceRefs('x=${res:missing}!', 'conv-1');
    expect(out).toBe('x=!');
  });

  it("no conversationId (design-time / ephemeral) → refs resolve to ''", async () => {
    const out = await resolveRunResourceRefs('x=${res:anything}!', undefined);
    expect(out).toBe('x=!');
    expect(findByNameMock).not.toHaveBeenCalled();
  });

  it('a store failure resolves that ref to empty and keeps the rest', async () => {
    findByNameMock.mockRejectedValue(new Error('disk gone'));
    const out = await resolveRunResourceRefs('a ${res:x} b', 'conv-1');
    expect(out).toBe('a  b');
  });

  it('duplicate refs resolve once per name, substituted everywhere', async () => {
    findByNameMock.mockResolvedValue(textEntry);
    readMock.mockResolvedValue({
      entry: textEntry,
      contents: { contents: [{ uri: textEntry.uri, text: 'DATA' }] },
    });
    const out = await resolveRunResourceRefs('${res:report} … ${res:report}', 'conv-1');
    expect(findByNameMock).toHaveBeenCalledTimes(1);
    expect(out.match(/DATA/g)).toHaveLength(2);
  });

  it('does not touch ${var:...} or ${resource:...} pills', async () => {
    const text = 'v=${var:keep} p=${resource:srv__uri://x}';
    const out = await resolveRunResourceRefs(text, 'conv-1');
    expect(out).toBe(text);
    expect(findByNameMock).not.toHaveBeenCalled();
  });

  it('hasRunResourceRef + RES_REF_SCAN agree', () => {
    expect(hasRunResourceRef('has ${res:x}')).toBe(true);
    expect(hasRunResourceRef('none ${var:x}')).toBe(false);
    RES_REF_SCAN.lastIndex = 0;
    expect(RES_REF_SCAN.exec('${res:my-name}')?.[1]).toBe('my-name');
  });
});
