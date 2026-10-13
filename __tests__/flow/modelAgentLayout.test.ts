import { createModelAgent } from '@/backend/services/flow/modelAgent';
import type { Flow } from '@/shared/types/flow';
import { hasOverlaps } from '@/shared/utils/flowLayout/layoutGeometry';

const mockGetFlow = jest.fn();
const mockSaveFlow = jest.fn();
const mockGather = jest.fn();
jest.mock('@/backend/services/flow', () => ({
  flowService: { getFlow: (...args: unknown[]) => mockGetFlow(...args), saveFlow: (...args: unknown[]) => mockSaveFlow(...args) },
}));
jest.mock('@/backend/services/flow/generationContext', () => ({
  gatherGenerationContext: (...args: unknown[]) => mockGather(...args),
}));

const creationId = '8e7a0b5b-cb8a-44be-9e42-a88117958da2';
const request = { creationId, modelId: 'model-1', name: 'Layout_Agent' };

describe('backend model-to-agent layout boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetFlow.mockResolvedValue(undefined);
    mockSaveFlow.mockResolvedValue({ success: true });
    mockGather.mockResolvedValue({
      blocks: { models: [{ id: 'model-1', name: 'GPT' }], servers: [{ name: 'files', connected: true }], flows: [] },
      compile: { models: [{ id: 'model-1', name: 'GPT' }], serverTools: { files: ['read_file', 'list_dir'] } },
      catalog: '', validatorServers: [],
    });
  });

  it('persists the validated graph with shared layout and filtered MCP tools', async () => {
    const result = await createModelAgent({ ...request, servers: [{ name: 'files', enabledTools: ['read_file', 'unknown'] }] });
    expect(result).toEqual({ success: true, flowId: creationId, name: 'Layout_Agent' });
    expect(mockSaveFlow).toHaveBeenCalledTimes(1);
    const saved = mockSaveFlow.mock.calls[0][0] as Flow;
    expect(saved.id).toBe(creationId);
    expect(saved.personaOwnership).toBeUndefined();
    expect(hasOverlaps(saved.nodes)).toBe(false);
    expect(saved.nodes.find(({ type }) => type === 'process')?.data.properties?.boundModel).toBe('model-1');
    expect(saved.nodes.find(({ type }) => type === 'mcp')?.data.properties?.enabledTools).toEqual(['read_file']);
    const flowNodes = ['start', 'process', 'finish'].map((type) => saved.nodes.find((node) => node.type === type)!);
    expect(flowNodes[0].position.y).toBeLessThan(flowNodes[1].position.y);
    expect(flowNodes[1].position.y).toBeLessThan(flowNodes[2].position.y);
  });

  it('keeps a retry on the existing creation id idempotent', async () => {
    mockGetFlow.mockResolvedValue({ id: creationId, name: 'Already_Saved', nodes: [{ type: 'process', data: { properties: { boundModel: 'model-1' } } }] });
    expect(await createModelAgent(request)).toEqual({ success: true, flowId: creationId, name: 'Already_Saved', reused: true });
    expect(mockGather).not.toHaveBeenCalled();
    expect(mockSaveFlow).not.toHaveBeenCalled();
  });

  it('does not save a graph when the selected model has disappeared', async () => {
    expect(await createModelAgent({ ...request, modelId: 'gone' })).toMatchObject({ success: false, statusCode: 400 });
    expect(mockSaveFlow).not.toHaveBeenCalled();
  });

  it('does not save a graph for a disconnected MCP server', async () => {
    mockGather.mockResolvedValue({ blocks: { models: [{ id: 'model-1' }], servers: [{ name: 'files', connected: false }], flows: [] } });
    expect(await createModelAgent({ ...request, servers: [{ name: 'files' }] })).toMatchObject({ success: false, statusCode: 400 });
    expect(mockSaveFlow).not.toHaveBeenCalled();
  });

  it('retains the canonical persistence failure instead of reporting creation success', async () => {
    mockSaveFlow.mockResolvedValue({ success: false, error: 'fixture storage failure' });
    expect(await createModelAgent(request)).toEqual({ success: false, error: 'fixture storage failure', statusCode: 500 });
  });
});
