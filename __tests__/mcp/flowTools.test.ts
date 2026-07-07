/**
 * Tests for the built-in FLUJO MCP server's flows-as-tools logic (#38, Item D).
 * The route's transport plumbing is the official SDK + fetch-to-node (shared with
 * /mcp-proxy and verified with a real client); here we pin the list/call mapping
 * we own — that tools/list and tools/call agree on the same deterministic name ->
 * flow mapping, and that runFlow results map to MCP tool results.
 */

// Self-contained mocks (factories can't close over outer consts — see jest-test-harness notes).
jest.mock('@/backend/services/flow/index', () => ({
  flowService: { loadFlows: jest.fn() },
}));
jest.mock('@/backend/execution/flow/runFlow', () => ({
  runFlow: jest.fn(),
}));
// Mock the description synthesizer so this suite doesn't drag in the live model/
// MCP services; its own behaviour is covered by handoffDescription tests.
jest.mock('@/backend/execution/flow/buildHandoffDescription', () => ({
  buildFlowToolDescription: jest.fn(async (flow: { name: string }) => `desc for ${flow.name}`),
}));

import { flowToolsListTools, flowToolsCallTool } from '@/backend/services/mcp/flowTools';
import { flowService } from '@/backend/services/flow/index';
import { runFlow } from '@/backend/execution/flow/runFlow';

const loadFlows = (flowService as unknown as { loadFlows: jest.Mock }).loadFlows;
const runFlowMock = runFlow as unknown as jest.Mock;

beforeEach(() => jest.clearAllMocks());

describe('flowToolsListTools', () => {
  it('exposes each flow as a tool with a slug name, synthesized description, and input schema', async () => {
    loadFlows.mockResolvedValue([
      { id: 'f1', name: 'Web Research', nodes: [] },
      { id: 'f2', name: 'Daily Digest', nodes: [] },
    ]);

    const { tools } = await flowToolsListTools();

    expect(tools.map((t) => t.name)).toEqual(['web_research', 'daily_digest']);
    expect(tools[0].description).toBe('desc for Web Research');
    expect(tools[0].inputSchema).toMatchObject({
      type: 'object',
      properties: { input: { type: 'string' } },
      required: ['input'],
    });
  });

  it('disambiguates flows whose names slug identically', async () => {
    loadFlows.mockResolvedValue([
      { id: 'a', name: 'Research', nodes: [] },
      { id: 'b', name: 'Research', nodes: [] },
    ]);
    const { tools } = await flowToolsListTools();
    expect(tools.map((t) => t.name)).toEqual(['research', 'research_2']);
  });

  it('returns no tools when there are no flows', async () => {
    loadFlows.mockResolvedValue([]);
    const { tools } = await flowToolsListTools();
    expect(tools).toEqual([]);
  });
});

describe('flowToolsCallTool', () => {
  const flows = [
    { id: 'f1', name: 'Web Research', nodes: [] },
    { id: 'f2', name: 'Daily Digest', nodes: [] },
  ];

  it('resolves the tool name back to the flow id and runs it ephemerally, returning its output', async () => {
    loadFlows.mockResolvedValue(flows);
    runFlowMock.mockResolvedValue({ status: 'completed', outputText: 'the answer' });

    const result = await flowToolsCallTool('web_research', { input: 'find X' });

    expect(runFlowMock).toHaveBeenCalledWith(
      expect.objectContaining({ flowId: 'f1', prompt: 'find X', mode: 'ephemeral' }),
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([{ type: 'text', text: 'the answer' }]);
  });

  it('returns an MCP error result for an unknown tool name (and never runs a flow)', async () => {
    loadFlows.mockResolvedValue(flows);
    const result = await flowToolsCallTool('nope', { input: 'x' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('nope');
    expect(runFlowMock).not.toHaveBeenCalled();
  });

  it('maps a flow execution error to an MCP error result', async () => {
    loadFlows.mockResolvedValue(flows);
    runFlowMock.mockResolvedValue({ status: 'error', outputText: '', error: { message: 'boom', statusCode: 500 } });
    const result = await flowToolsCallTool('daily_digest', { input: 'go' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('boom');
  });

  it('maps flowNotFound to an MCP error result', async () => {
    loadFlows.mockResolvedValue(flows);
    runFlowMock.mockResolvedValue({ status: 'error', outputText: '', flowNotFound: { name: 'Web Research' } });
    const result = await flowToolsCallTool('web_research', { input: 'go' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('not found');
  });

  it('tolerates a missing/non-string input by sending an empty prompt', async () => {
    loadFlows.mockResolvedValue(flows);
    runFlowMock.mockResolvedValue({ status: 'completed', outputText: 'ok' });
    await flowToolsCallTool('web_research', {});
    expect(runFlowMock).toHaveBeenCalledWith(expect.objectContaining({ prompt: '' }));
  });

  it('surfaces a thrown runFlow error as an MCP error result (no throw)', async () => {
    loadFlows.mockResolvedValue(flows);
    runFlowMock.mockRejectedValue(new Error('kaboom'));
    const result = await flowToolsCallTool('web_research', { input: 'go' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('kaboom');
  });
});
