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
});
