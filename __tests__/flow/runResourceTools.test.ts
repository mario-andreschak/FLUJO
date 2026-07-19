/**
 * Tier 3 (issue #161) — the explicit `write_resource` produce tool that
 * replaced ProcessNode's broken passive capture.
 *
 * Pins:
 *  - buildRunResourceTools only offers write_resource when a PRODUCE-role run
 *    artifact is wired (byte-identical [] otherwise → #89 prefix-cache safety);
 *  - executeRunResourceTool writes the model-supplied content under the given
 *    name, emits resource:write (source 'capture'), and enforces the run
 *    chokepoints (no conversationId / ephemeral / missing name / store cap).
 */

const writeRunResourceMock = jest.fn();
const readRunResourceMock = jest.fn();
jest.mock('@/backend/services/runResources', () => ({
  writeRunResource: (...args: unknown[]) => writeRunResourceMock(...args),
  readRunResource: (...args: unknown[]) => readRunResourceMock(...args),
  parseRunResourceUri: (uri: unknown) => {
    const SCHEME = 'flujo://run/';
    if (typeof uri !== 'string' || !uri.startsWith(SCHEME)) return null;
    const parts = uri.slice(SCHEME.length).split('/');
    if (parts.length !== 2) return null;
    return { conversationId: parts[0], id: parts[1] };
  },
}));

import {
  buildRunResourceTools,
  buildReadResourceTool,
  executeRunResourceTool,
  isRunResourceToolName,
  WRITE_RESOURCE_TOOL_NAME,
  READ_RESOURCE_TOOL_NAME,
} from '@/backend/execution/flow/handlers/runResourceTools';
import type { ResourceNodeReference } from '@/backend/execution/flow/types';

const produceNode = (runName: string): ResourceNodeReference => ({
  id: `res-${runName}`,
  role: 'produce',
  properties: { scope: 'run', runName },
});

const consumeNode = (runName: string): ResourceNodeReference => ({
  id: `res-${runName}`,
  role: 'consume',
  properties: { scope: 'run', runName },
});

const written = {
  uri: 'flujo://run/conv-1/res-9',
  mimeType: 'text/markdown',
  size: 6,
};

beforeEach(() => {
  writeRunResourceMock.mockReset();
  writeRunResourceMock.mockResolvedValue(written);
});

describe('buildRunResourceTools', () => {
  it('returns [] when no produce node is wired', () => {
    expect(buildRunResourceTools(undefined)).toEqual([]);
    expect(buildRunResourceTools([consumeNode('report')])).toEqual([]);
    // A produce node without a runName is not a run artifact → no tool.
    expect(buildRunResourceTools([{ id: 'x', role: 'produce', properties: { scope: 'run' } }])).toEqual([]);
  });

  it('offers write_resource naming each wired produce artifact', () => {
    const tools = buildRunResourceTools([produceNode('report'), produceNode('summary')]);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe(WRITE_RESOURCE_TOOL_NAME);
    expect(tools[0].description).toContain('report');
    expect(tools[0].description).toContain('summary');
    expect(tools[0].inputSchema).toMatchObject({ required: ['name', 'content'] });
  });
});

describe('isRunResourceToolName', () => {
  it('matches the synthetic run-resource tools', () => {
    expect(isRunResourceToolName(WRITE_RESOURCE_TOOL_NAME)).toBe(true);
    expect(isRunResourceToolName(READ_RESOURCE_TOOL_NAME)).toBe(true);
    expect(isRunResourceToolName('handoff_to_x')).toBe(false);
  });
});

describe('buildReadResourceTool (#168)', () => {
  it('is deterministic and takes a single required uri', () => {
    const a = buildReadResourceTool();
    const b = buildReadResourceTool();
    expect(a).toEqual(b); // no per-run interpolation → prefix-cache stable
    expect(a.name).toBe(READ_RESOURCE_TOOL_NAME);
    expect(a.inputSchema).toMatchObject({ required: ['uri'] });
  });
});

describe('read_resource execution (#168)', () => {
  const node = { nodeId: 'proc-1', nodeName: 'Step', nodeType: 'process' as const };
  const uri = 'flujo://run/conv-1/res-9';

  beforeEach(() => {
    readRunResourceMock.mockReset();
    readRunResourceMock.mockResolvedValue({
      entry: { uri, name: 'evidence', mimeType: 'text/plain', size: 12, kind: 'text' },
      contents: { contents: [{ uri, mimeType: 'text/plain', text: 'FULL CONTENT' }] },
    });
  });

  it('reads a stored URI, emits resource:read (tool-read) and appends tool-read lineage', async () => {
    const emit = jest.fn();
    const outcome = await executeRunResourceTool(
      READ_RESOURCE_TOOL_NAME,
      { uri },
      { conversationId: 'conv-1', node, emit },
    );
    expect(readRunResourceMock).toHaveBeenCalledWith(
      uri,
      expect.objectContaining({ source: 'tool-read', nodeId: 'proc-1' }),
    );
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'resource:read', server: 'flujo', uri, source: 'tool-read',
    }));
    expect(outcome).toMatchObject({ success: true, data: { uri, content: 'FULL CONTENT' } });
  });

  it('rejects a non-run URI', async () => {
    const outcome = await executeRunResourceTool(READ_RESOURCE_TOOL_NAME, { uri: 'http://example.com' }, { conversationId: 'conv-1' });
    expect(outcome.success).toBe(false);
    expect(readRunResourceMock).not.toHaveBeenCalled();
  });

  it('rejects an empty uri', async () => {
    const outcome = await executeRunResourceTool(READ_RESOURCE_TOOL_NAME, {}, { conversationId: 'conv-1' });
    expect(outcome.success).toBe(false);
    expect(readRunResourceMock).not.toHaveBeenCalled();
  });

  it('refuses a URI from a different conversation', async () => {
    const outcome = await executeRunResourceTool(
      READ_RESOURCE_TOOL_NAME,
      { uri: 'flujo://run/other-conv/res-9' },
      { conversationId: 'conv-1' },
    );
    expect(outcome.success).toBe(false);
    expect(readRunResourceMock).not.toHaveBeenCalled();
  });

  it('reports a missing resource', async () => {
    readRunResourceMock.mockResolvedValue(null);
    const outcome = await executeRunResourceTool(READ_RESOURCE_TOOL_NAME, { uri }, { conversationId: 'conv-1' });
    expect(outcome.success).toBe(false);
    expect(outcome.error).toContain('not found');
  });
});

describe('executeRunResourceTool', () => {
  const node = { nodeId: 'proc-1', nodeName: 'Step', nodeType: 'process' as const };

  it('writes the artifact and emits resource:write', async () => {
    const emit = jest.fn();
    const outcome = await executeRunResourceTool(
      WRITE_RESOURCE_TOOL_NAME,
      { name: 'report', content: 'HELLO' },
      { conversationId: 'conv-1', node, emit },
    );
    expect(writeRunResourceMock).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'conv-1',
      name: 'report',
      kind: 'text',
      data: { text: 'HELLO' },
      producedBy: expect.objectContaining({ source: 'capture', nodeId: 'proc-1' }),
    }));
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'resource:write', server: 'flujo', name: 'report', source: 'capture', uri: written.uri,
    }));
    expect(outcome).toMatchObject({ success: true, data: { written: true, name: 'report' } });
  });

  it('refuses when there is no conversation or the run is ephemeral', async () => {
    expect((await executeRunResourceTool(WRITE_RESOURCE_TOOL_NAME, { name: 'r', content: 'x' }, {})).success).toBe(false);
    expect((await executeRunResourceTool(WRITE_RESOURCE_TOOL_NAME, { name: 'r', content: 'x' }, { conversationId: 'c', ephemeral: true })).success).toBe(false);
    expect(writeRunResourceMock).not.toHaveBeenCalled();
  });

  it('refuses a missing name', async () => {
    const outcome = await executeRunResourceTool(WRITE_RESOURCE_TOOL_NAME, { content: 'x' }, { conversationId: 'c' });
    expect(outcome.success).toBe(false);
    expect(writeRunResourceMock).not.toHaveBeenCalled();
  });

  it('surfaces a store cap skip as a failure and emits nothing', async () => {
    writeRunResourceMock.mockResolvedValue({ skipped: 'size-cap' });
    const emit = jest.fn();
    const outcome = await executeRunResourceTool(WRITE_RESOURCE_TOOL_NAME, { name: 'r', content: 'x' }, { conversationId: 'c', emit });
    expect(outcome.success).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });
});
