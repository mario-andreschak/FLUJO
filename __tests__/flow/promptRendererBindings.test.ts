/**
 * Regression tests for PromptRenderer binding resolution (#15 + pill-format rework).
 *
 * Verifies that:
 *  - resource pills are ALWAYS inlined with their contents,
 *  - tool pills are left as the readable pill (raw mode, current default),
 *  - legacy `${_-_-_server_-_-_tool}` pills still parse and pass through.
 *
 * flow/model/mcp services are mocked so no real flow store, model, or MCP server runs.
 */

const getFlowMock = jest.fn();
jest.mock('@/backend/services/flow', () => ({
  flowService: { getFlow: (...a: unknown[]) => getFlowMock(...a) },
}));

jest.mock('@/backend/services/model', () => ({
  modelService: { getModel: jest.fn(async () => null) },
}));

const getServerStatusMock = jest.fn();
const readResourceMock = jest.fn();
const listServerToolsMock = jest.fn();
jest.mock('@/backend/services/mcp', () => ({
  mcpService: {
    getServerStatus: (...a: unknown[]) => getServerStatusMock(...a),
    connectServer: jest.fn(async () => ({ success: true })),
    listServerTools: (...a: unknown[]) => listServerToolsMock(...a),
    readResource: (...a: unknown[]) => readResourceMock(...a),
  },
}));

import { promptRenderer } from '@/backend/utils/PromptRenderer';

// A flow whose target node carries the given prompt template; exclusions on so only the
// node prompt (plus resolved bindings) is rendered.
const flowWith = (promptTemplate: string) => ({
  id: 'flow-1',
  nodes: [
    { id: 'start', type: 'start', data: { properties: { promptTemplate: '' } } },
    {
      id: 'node-1',
      type: 'process',
      data: {
        properties: {
          promptTemplate,
          excludeModelPrompt: true,
          excludeStartNodePrompt: true,
        },
      },
    },
  ],
});

beforeEach(() => {
  getFlowMock.mockReset();
  readResourceMock.mockReset();
  getServerStatusMock.mockReset();
  listServerToolsMock.mockReset();
  getServerStatusMock.mockResolvedValue({ status: 'connected' });
  listServerToolsMock.mockResolvedValue({ tools: [] });
});

describe('PromptRenderer binding resolution', () => {
  it('inlines resource pill contents', async () => {
    getFlowMock.mockResolvedValue(flowWith('Context: ${resource:files__file:///a.txt} done'));
    readResourceMock.mockResolvedValue({
      success: true,
      data: { contents: [{ uri: 'file:///a.txt', text: 'FILE BODY' }] },
    });

    const result = await promptRenderer.renderPrompt('flow-1', 'node-1');

    expect(result).toContain('FILE BODY');
    expect(result).toContain('[Resource file:///a.txt (from files)]');
    expect(result).not.toContain('${resource:'); // pill was consumed
    expect(readResourceMock).toHaveBeenCalledWith('files', 'file:///a.txt');
  });

  it('leaves tool pills as the readable pill (raw mode)', async () => {
    getFlowMock.mockResolvedValue(flowWith('Use ${tool:files__read} now'));

    const result = await promptRenderer.renderPrompt('flow-1', 'node-1');

    expect(result).toContain('${tool:files__read}');
    expect(readResourceMock).not.toHaveBeenCalled();
  });

  it('still understands legacy tool pills', async () => {
    getFlowMock.mockResolvedValue(flowWith('Legacy ${_-_-_files_-_-_read} ref'));

    const result = await promptRenderer.renderPrompt('flow-1', 'node-1');

    // Raw mode leaves the (legacy) pill text in place; it must not be mangled or dropped.
    expect(result).toContain('${_-_-_files_-_-_read}');
  });

  it('emits a visible note when a resource cannot be read', async () => {
    getFlowMock.mockResolvedValue(flowWith('${resource:files__file:///missing}'));
    readResourceMock.mockResolvedValue({ success: false, error: 'not found' });

    const result = await promptRenderer.renderPrompt('flow-1', 'node-1');

    expect(result).toContain('could not be read');
    expect(result).toContain('not found');
  });

  it('invokes onResourceRead once per successfully resolved resource pill (Tier 3)', async () => {
    getFlowMock.mockResolvedValue(flowWith('${resource:files__file:///a.txt}'));
    readResourceMock.mockResolvedValue({
      success: true,
      data: { contents: [{ uri: 'file:///a.txt', mimeType: 'text/plain', text: 'FILE BODY' }] },
    });
    const onResourceRead = jest.fn();

    await promptRenderer.renderPrompt('flow-1', 'node-1', { onResourceRead });

    expect(onResourceRead).toHaveBeenCalledTimes(1);
    expect(onResourceRead).toHaveBeenCalledWith({
      server: 'files',
      uri: 'file:///a.txt',
      mimeType: 'text/plain',
      size: 'FILE BODY'.length,
    });
  });

  it('does not invoke onResourceRead for failed reads, and a throwing observer never breaks rendering', async () => {
    getFlowMock.mockResolvedValue(flowWith('${resource:files__file:///missing} and ${resource:files__file:///ok}'));
    readResourceMock
      .mockResolvedValueOnce({ success: false, error: 'not found' })
      .mockResolvedValueOnce({ success: true, data: { contents: [{ uri: 'file:///ok', text: 'OK' }] } });
    const onResourceRead = jest.fn(() => { throw new Error('observer bug'); });

    const result = await promptRenderer.renderPrompt('flow-1', 'node-1', { onResourceRead });

    expect(onResourceRead).toHaveBeenCalledTimes(1); // only the successful read
    expect(result).toContain('OK'); // rendering survived the throwing observer
  });

  it('renders binary blobs as an actionable reference instead of silently omitting them', async () => {
    getFlowMock.mockResolvedValue(flowWith('${resource:files__file:///img.png}'));
    readResourceMock.mockResolvedValue({
      success: true,
      data: { contents: [{ uri: 'file:///img.png', mimeType: 'image/png', blob: 'QUJDRA==' }] },
    });

    const result = await promptRenderer.renderPrompt('flow-1', 'node-1');

    expect(result).not.toContain('QUJDRA=='); // never inline base64
    expect(result).toContain('image/png');
    expect(result).toContain('file:///img.png'); // the model can read it back via MCP
    expect(result).toContain('resources/read');
  });
});

// A flow whose target node exposes configurable exclusion flags (issue #67).
const flowWithFlags = (flags: {
  excludeModelPrompt?: boolean;
  excludeStartNodePrompt?: boolean;
  excludeSystemPrompt?: boolean;
}) => ({
  id: 'flow-1',
  nodes: [
    { id: 'start', type: 'start', data: { properties: { promptTemplate: '' } } },
    {
      id: 'node-1',
      type: 'process',
      data: {
        properties: {
          promptTemplate: 'Node instruction body',
          ...flags,
        },
      },
    },
  ],
});

const SYSTEM_BLOCK_MARKER = '# GENERAL INFORMATION:';

describe('PromptRenderer excludeSystemPrompt (issue #67)', () => {
  it('includes the hardcoded system block by default', async () => {
    getFlowMock.mockResolvedValue(flowWithFlags({}));

    const result = await promptRenderer.renderPrompt('flow-1', 'node-1');

    expect(result).toContain(SYSTEM_BLOCK_MARKER);
  });

  it('omits the hardcoded system block when excludeSystemPrompt is true', async () => {
    getFlowMock.mockResolvedValue(flowWithFlags({ excludeSystemPrompt: true }));

    const result = await promptRenderer.renderPrompt('flow-1', 'node-1');

    expect(result).not.toContain(SYSTEM_BLOCK_MARKER);
    // The node's own prompt still renders.
    expect(result).toContain('Node instruction body');
  });

  it('honours the excludeSystemPrompt option override over the node property', async () => {
    getFlowMock.mockResolvedValue(flowWithFlags({ excludeSystemPrompt: false }));

    const result = await promptRenderer.renderPrompt('flow-1', 'node-1', {
      excludeSystemPrompt: true,
    });

    expect(result).not.toContain(SYSTEM_BLOCK_MARKER);
  });

  it('is independent of excludeModelPrompt: system block stays when only the model prompt is excluded', async () => {
    getFlowMock.mockResolvedValue(
      flowWithFlags({ excludeModelPrompt: true, excludeSystemPrompt: false })
    );

    const result = await promptRenderer.renderPrompt('flow-1', 'node-1');

    // Model prompt excluded but the system block is now independently controlled.
    expect(result).toContain(SYSTEM_BLOCK_MARKER);
  });

  it('is independent of excludeModelPrompt: system block can be dropped while model prompt stays', async () => {
    getFlowMock.mockResolvedValue(
      flowWithFlags({ excludeModelPrompt: false, excludeSystemPrompt: true })
    );

    const result = await promptRenderer.renderPrompt('flow-1', 'node-1');

    expect(result).not.toContain(SYSTEM_BLOCK_MARKER);
  });
});
