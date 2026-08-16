jest.mock('@/backend/services/flow', () => ({
  flowService: { getFlow: jest.fn() },
}));

jest.mock('@/backend/services/model', () => ({
  modelService: { getModel: jest.fn() },
}));

jest.mock('@/backend/services/mcp', () => ({
  mcpService: { loadServerConfigs: jest.fn() },
}));

jest.mock('@/backend/execution/flow/loadConversationState', () => ({
  loadConversationState: jest.fn(),
}));

jest.mock('@/backend/utils/resolveGlobalVars', () => {
  const visit = (value: unknown): unknown => {
    if (typeof value === 'string') return value.replace(/\$\{global:TENANT\}/g, 'secret-tenant');
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, visit(child)]));
    }
    return value;
  };
  return {
    resolveGlobalVars: jest.fn(async (value: unknown) => visit(value)),
    resolveNonSecretGlobalVars: jest.fn(async (value: unknown) => value),
  };
});

import { flowService } from '@/backend/services/flow';
import { loadConversationState } from '@/backend/execution/flow/loadConversationState';
import {
  applyPresetArguments,
  resolvePromptDynamicReferences,
} from '@/backend/utils/resolveDynamicReferences';

const mockedGetFlow = flowService.getFlow as jest.Mock;
const mockedLoadConversation = loadConversationState as jest.Mock;

describe('dynamic @ reference resolution', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetFlow.mockResolvedValue({
      id: 'flow-1',
      name: 'Daily report',
      folder: 'Finance',
      createdAt: 100,
      updatedAt: 200,
      nodes: [{ id: 'node-1', data: { label: 'Research', properties: {} } }],
      edges: [],
    });
    mockedLoadConversation.mockResolvedValue({
      title: 'Quarterly planning',
      createdAt: 300,
      updatedAt: 400,
    });
  });

  it('resolves current entities, selected metadata fields, and complete-token primitive values', async () => {
    await expect(resolvePromptDynamicReferences('@flows', { flowId: 'flow-1' })).resolves.toBe('flow-1');
    await expect(resolvePromptDynamicReferences(
      'Run @flows.name from @node.name in @conversation.name',
      { flowId: 'flow-1', nodeId: 'node-1', conversationId: 'chat-1' },
    )).resolves.toBe('Run Daily report from Research in Quarterly planning');
    await expect(resolvePromptDynamicReferences('@flows.updated', { flowId: 'flow-1' })).resolves.toBe(200);
  });

  it('uses an app URI as its stable id and derives a readable app name', async () => {
    await expect(resolvePromptDynamicReferences('@app[ui%3A%2F%2Fexample%2Fissue_tracker].name', {}))
      .resolves.toBe('Issue Tracker');
  });

  it('recursively resolves presets and makes them authoritative over model arguments', async () => {
    await expect(applyPresetArguments(
      { tenant: 'model-choice', query: 'forecast' },
      {
        tenant: '${global:TENANT}',
        flowName: '@flows.name',
        nested: { nodeId: '@node' },
      },
      { flowId: 'flow-1', nodeId: 'node-1' },
    )).resolves.toEqual({
      tenant: 'secret-tenant',
      query: 'forecast',
      flowName: 'Daily report',
      nested: { nodeId: 'node-1' },
    });
  });
});
