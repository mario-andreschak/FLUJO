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
import { modelService } from '@/backend/services/model';
import { mcpService } from '@/backend/services/mcp';
import { promises as fs } from 'fs';
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
      nodes: [{ id: 'node-1', data: { label: 'Research', properties: { createdAt: 500, updatedAt: 600 } } }],
      edges: [],
    });
    mockedLoadConversation.mockResolvedValue({
      title: 'Quarterly planning',
      createdAt: 300,
      updatedAt: 400,
    });
    (modelService.getModel as jest.Mock).mockResolvedValue({ id: 'model-1', displayName: 'Demo model', createdAt: 700, updatedAt: 800 });
    (mcpService.loadServerConfigs as jest.Mock).mockResolvedValue([{ name: 'bank', createdAt: 900, updatedAt: 1000 }]);
  });

  const context = { conversationId: 'slack-team-thread-1', flowId: 'flow-1', nodeId: 'node-1', modelId: 'model-1', appId: 'bank' };
  const entities = [
    ['conversation', ['slack-team-thread-1', 'Quarterly planning', 300, 400]],
    ['flow', ['flow-1', 'Daily report', 100, 200]],
    ['flows', ['flow-1', 'Daily report', 100, 200]],
    ['node', ['node-1', 'Research', 500, 600]],
    ['model', ['model-1', 'Demo model', 700, 800]],
    ['app', ['bank', 'bank', 900, 1000]],
    ['folder', ['Finance', 'Finance', 100, 200]],
  ] as const;
  it.each(entities.flatMap(([kind, values]) => ['id', 'name', 'created', 'updated'].map((field, index) =>
    [`@current.${kind}.${field}`, values[index]] as const)))('resolves %s from this execution', async (command, expected) => {
    await expect(resolvePromptDynamicReferences(command, context)).resolves.toBe(expected);
  });

  it('resolves every date/time field using the executing process clock', async () => {
    jest.useFakeTimers();
    try {
      const now = new Date('2026-09-28T17:08:09Z');
      jest.setSystemTime(now);
      for (const kind of ['date', 'time']) {
        const id = kind === 'time' ? now.toTimeString().slice(0, 8)
          : `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        for (const [field, expected] of [['id', id], ['name', id], ['created', now.getTime()], ['updated', now.getTime()]] as const) {
          await expect(resolvePromptDynamicReferences(`@current.${kind}.${field}`, context)).resolves.toBe(expected);
        }
      }
    } finally { jest.useRealTimers(); }
  });

  it('resolves selected file/folder metadata and keeps missing current context explicit', async () => {
    const stat = jest.spyOn(fs, 'stat').mockResolvedValue({ birthtimeMs: 1100, mtimeMs: 1200 } as Awaited<ReturnType<typeof fs.stat>>);
    try {
      for (const kind of ['file', 'folder']) {
        for (const [field, expected] of [['id', '/workspace/report.txt'], ['name', 'report.txt'], ['created', 1100], ['updated', 1200]] as const) {
          await expect(resolvePromptDynamicReferences(`@${kind}[%2Fworkspace%2Freport.txt].${field}`, context)).resolves.toBe(expected);
        }
      }
      await expect(resolvePromptDynamicReferences('@current.model.id', {})).resolves.toBe('@current.model.id');
      await expect(resolvePromptDynamicReferences('@current.file.id', context)).resolves.toBe('@current.file.id');
    } finally { stat.mockRestore(); }
  });

  it('resolves current commands recursively in hidden presets while overriding forged values', async () => {
    await expect(applyPresetArguments({ conversation_id: 'foreign' }, {
      conversation_id: '@current.conversation.id', flow_id: '@current.flow.id', nested: ['@current.node.id'],
    }, context)).resolves.toEqual({ conversation_id: 'slack-team-thread-1', flow_id: 'flow-1', nested: ['node-1'] });
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
