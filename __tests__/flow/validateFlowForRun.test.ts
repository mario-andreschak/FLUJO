/**
 * Tests for the backend pre-run guard (validateFlowForRun). It loads the flow + current
 * models/servers and delegates to the shared validator. These tests mock the three
 * services to assert wiring: a deleted bound model blocks the run, a clean flow passes,
 * a missing flow is reported, and a failed model/server load skips that family of checks
 * (rather than falsely blocking).
 */
jest.mock('@/backend/services/flow', () => ({ flowService: { getFlow: jest.fn() } }));
jest.mock('@/backend/services/model', () => ({ modelService: { loadModels: jest.fn() } }));
jest.mock('@/backend/services/mcp', () => ({ mcpService: { loadServerConfigs: jest.fn() } }));

import { flowService } from '@/backend/services/flow';
import { modelService } from '@/backend/services/model';
import { mcpService } from '@/backend/services/mcp';
import { validateFlowForRun } from '@/backend/execution/flow/validateFlowForRun';

const getFlow = flowService.getFlow as jest.Mock;
const loadModels = modelService.loadModels as jest.Mock;
const loadServerConfigs = mcpService.loadServerConfigs as jest.Mock;

const flowFixture = (boundModel = 'm1') => ({
  id: 'f1',
  name: 'F1',
  nodes: [
    { id: 'start', type: 'start', data: { label: 'Start', type: 'start', properties: {} } },
    { id: 'p', type: 'process', data: { label: 'P', type: 'process', properties: { boundModel } } },
    { id: 'finish', type: 'finish', data: { label: 'Finish', type: 'finish', properties: {} } },
  ],
  edges: [
    { id: 'start-p', source: 'start', target: 'p', data: { edgeType: 'standard' } },
    { id: 'p-finish', source: 'p', target: 'finish', data: { edgeType: 'standard' } },
  ],
});

beforeEach(() => {
  getFlow.mockReset();
  loadModels.mockReset();
  loadServerConfigs.mockReset();
});

describe('validateFlowForRun', () => {
  it('blocks when the bound model no longer exists', async () => {
    getFlow.mockResolvedValue(flowFixture('deleted-model'));
    loadModels.mockResolvedValue([{ id: 'other', name: 'x' }]);
    loadServerConfigs.mockResolvedValue([]);

    const result = await validateFlowForRun('f1');
    expect(result.isRunnable).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('process-model-missing');
  });

  it('passes a clean flow', async () => {
    getFlow.mockResolvedValue(flowFixture('m1'));
    loadModels.mockResolvedValue([{ id: 'm1', name: 'gpt' }]);
    loadServerConfigs.mockResolvedValue([]);

    const result = await validateFlowForRun('f1');
    expect(result.isRunnable).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('skips (does not block) when the flow cannot be loaded — the engine reports that', async () => {
    getFlow.mockResolvedValue(null);

    const result = await validateFlowForRun('missing');
    expect(result.isRunnable).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('skips model checks when the model load fails (does not falsely block)', async () => {
    getFlow.mockResolvedValue(flowFixture('m1'));
    loadModels.mockRejectedValue(new Error('storage down'));
    loadServerConfigs.mockResolvedValue([]);

    const result = await validateFlowForRun('f1');
    // The bound model can't be checked, so the flow is not blocked on that basis.
    expect(result.issues.map((i) => i.code)).not.toContain('process-model-missing');
    expect(result.isRunnable).toBe(true);
  });

  it('treats a server config load error ({error}) as "skip server checks"', async () => {
    getFlow.mockResolvedValue({
      ...flowFixture('m1'),
      nodes: [
        ...flowFixture('m1').nodes,
        { id: 'mcp1', type: 'mcp', data: { label: 'MCP', type: 'mcp', properties: { boundServer: 'srv' } } },
      ],
      edges: [...flowFixture('m1').edges, { id: 'p-mcp1', source: 'p', target: 'mcp1', data: { edgeType: 'mcp' } }],
    });
    loadModels.mockResolvedValue([{ id: 'm1', name: 'gpt' }]);
    loadServerConfigs.mockResolvedValue({ error: 'boom' });

    const result = await validateFlowForRun('f1');
    // Server existence can't be verified, so no mcp-server-missing error.
    expect(result.issues.map((i) => i.code)).not.toContain('mcp-server-missing');
  });
});
