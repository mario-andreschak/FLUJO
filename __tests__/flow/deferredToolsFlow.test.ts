/**
 * #1448 full flow: deferred tool descriptions and code mode through the real
 * ProcessNode.prep and ModelHandler.processToolCalls. Only the MCP service,
 * the server listing and the approval card are replaced.
 *
 * Deferred descriptions: the model first gets a catalog in `search_tools`,
 * searches, the found tool is loaded, the next turn offers its full schema,
 * and a direct call runs it.
 *
 * Code mode: `run_tool_script` runs a program whose tool calls pass the step's
 * tool list and the one approval gate, and only the program's result returns.
 */
const callToolMock = jest.fn();
const loadServerConfigsMock = jest.fn();
jest.mock('@/backend/services/mcp', () => {
  const actual = jest.requireActual('@/backend/services/mcp');
  return {
    ...actual,
    mcpService: {
      ...actual.mcpService,
      callTool: (...args: unknown[]) => callToolMock(...args),
      loadServerConfigs: (...args: unknown[]) => loadServerConfigsMock(...args),
      getClient: () => ({}),
      getClientGeneration: () => 0,
      getToolSchemaHash: () => undefined,
    },
  };
});

// The approval card: record what a person would see and answer it.
const approvalCards: Array<{ conversationId: string; name: string; args: Record<string, unknown> }> = [];
let approvalAnswer = true;
jest.mock('@/backend/execution/flow/toolApprovalRegistry', () => ({
  registerPendingApproval: (
    conversationId: string,
    toolCall: { function: { name: string; arguments: string } },
    resolve: (approved: boolean) => void,
  ) => {
    approvalCards.push({ conversationId, name: toolCall.function.name, args: JSON.parse(toolCall.function.arguments) });
    queueMicrotask(() => resolve(approvalAnswer));
  },
  withdrawPendingApproval: () => true,
  listPendingToolCalls: () => [],
}));

import OpenAI from 'openai';
import { ModelHandler } from '@/backend/execution/flow/handlers/ModelHandler';
import { ToolHandler } from '@/backend/execution/flow/handlers/ToolHandler';
import { encodeToolName } from '@/backend/execution/flow/handlers/toolNamespace';
import { ProcessNode } from '@/backend/execution/flow/nodes/ProcessNode';
import { addLoadedDeferredTools } from '@/backend/execution/flow/toolLoading/planStepTools';
import { applyApprovalDecision } from '@/backend/execution/flow/resumeAfterApproval';
import type { ProcessNodeParams, SharedState, ToolDefinition } from '@/backend/execution/flow/types';
import type { ToolCallProcessingInput } from '@/backend/execution/flow/types/modelHandler';
import { saveItem } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';

jest.setTimeout(30_000);

const SERVER_TOOLS: Record<string, Array<{ tool: string; description: string; properties: Record<string, unknown> }>> = {
  github: [
    { tool: 'create_issue', description: 'Create a new issue in a repository.', properties: { title: { type: 'string' }, body: { type: 'string' } } },
    { tool: 'list_issues', description: 'List the issues in a repository.', properties: { state: { type: 'string' } } },
    { tool: 'add_label', description: 'Add a label to an issue.', properties: { number: { type: 'number' }, label: { type: 'string' } } },
  ],
  files: [
    { tool: 'read_file', description: 'Read a file from disk.', properties: { path: { type: 'string' } } },
  ],
};
const CREATE = encodeToolName('github', 'create_issue');
const LIST = encodeToolName('github', 'list_issues');
const ADD_LABEL = encodeToolName('github', 'add_label');
const READ_FILE = encodeToolName('files', 'read_file');

const issues = Array.from({ length: 40 }, (_, index) => ({
  number: index + 1,
  labels: index % 4 === 0 ? [] : ['bug'],
  body: `SECRET-BODY-${index} ${'x'.repeat(1_000)}`,
}));

const toolCall = (id: string, name: string, args: Record<string, unknown> = {}): OpenAI.ChatCompletionMessageFunctionToolCall => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});

function params(properties: Record<string, unknown>): ProcessNodeParams {
  return {
    id: 'agent',
    label: 'agent',
    type: 'process',
    properties: {
      boundModel: 'model-1',
      promptTemplate: 'Prompt',
      mcpNodes: Object.entries(SERVER_TOOLS).map(([server, tools]) => ({
        id: `mcp-${server}`,
        properties: { boundServer: server, enabledTools: tools.map((entry) => entry.tool) },
      })),
      ...properties,
    },
  } as unknown as ProcessNodeParams;
}

function newState(): SharedState {
  return {
    trackingInfo: { executionId: 'run', startTime: 1, nodeExecutionTracker: [] },
    messages: [{ role: 'user', content: 'Hello', id: 'm1', timestamp: 1 }],
    flowId: 'flow',
    flowSnapshot: {
      id: 'flow',
      name: 'Flow',
      nodes: [{ id: 'agent', type: 'process', position: { x: 0, y: 0 }, data: { type: 'process', label: 'agent', properties: { boundModel: 'model-1', promptTemplate: 'Prompt' } } }],
      edges: [],
    },
    conversationId: 'conversation',
    title: 'test',
    createdAt: 1,
    updatedAt: 1,
  } as unknown as SharedState;
}

/** What runFlow passes for a step's tool calls. */
function loopInput(state: SharedState, toolCalls: OpenAI.ChatCompletionMessageFunctionToolCall[], extra: Partial<ToolCallProcessingInput> = {}): ToolCallProcessingInput {
  return {
    toolCalls,
    toolNameMap: state.toolNameMap,
    offeredToolNames: state.offeredToolNames,
    mcpNodes: state.currentMCPNodes,
    toolCatalog: state.stepToolCatalog,
    markToolsLoaded: (names) => addLoadedDeferredTools(state, names),
    node: { nodeId: 'agent' },
    ...extra,
  };
}

async function run(input: ToolCallProcessingInput): Promise<unknown> {
  const result = await ModelHandler.processToolCalls(input);
  if (!result.success) throw new Error(result.error.message);
  return JSON.parse(String(result.value.toolCallMessages[0].content));
}

beforeEach(async () => {
  approvalCards.length = 0;
  approvalAnswer = true;
  callToolMock.mockReset().mockImplementation(async (_server: string, tool: string, args: Record<string, unknown>) => {
    if (tool === 'list_issues') return { success: true, data: { content: [{ type: 'text', text: JSON.stringify(issues) }] } };
    if (tool === 'add_label') return { success: true, data: { content: [{ type: 'text', text: `labelled ${String(args.number)}` }] } };
    return { success: true, data: { content: [{ type: 'text', text: `${tool} done` }] } };
  });
  loadServerConfigsMock.mockReset().mockResolvedValue([]);
  await saveItem(StorageKey.MODELS, [{ id: 'model-1', name: 'fixture', provider: 'openai', adapter: 'openai', ApiKey: '', contextWindow: 128_000 }]);
  jest.spyOn(ToolHandler, 'processMCPNodes').mockImplementation(async (input) => ({
    success: true,
    value: {
      availableTools: (input.mcpNodes ?? []).flatMap((node) => (node.properties.enabledTools ?? []).map((tool): ToolDefinition => {
        const server = node.properties.boundServer ?? '';
        const entry = SERVER_TOOLS[server].find((candidate) => candidate.tool === tool)!;
        return {
          name: encodeToolName(server, tool),
          originalName: tool,
          server,
          nodeId: node.id,
          description: entry.description,
          inputSchema: { type: 'object', properties: entry.properties },
        };
      })),
    },
  }));
});

afterEach(() => {
  jest.restoreAllMocks();
});

const names = (tools: ToolDefinition[] | undefined) => (tools ?? []).map((tool) => tool.name);

describe('deferred tool descriptions, full flow', () => {
  it('shows a catalog, loads the found tool, offers its full schema next turn, and runs it', async () => {
    const state = newState();
    const first = await new ProcessNode().prep(state, params({ toolLoading: 'on-demand' }));

    // Turn 1: names and one-line summaries only.
    expect(names(first.availableTools)).toContain('search_tools');
    expect(names(first.availableTools)).not.toContain(CREATE);
    const search = first.availableTools!.find((tool) => tool.name === 'search_tools')!;
    expect(search.description).toContain(`- ${CREATE} (github): Create a new issue in a repository.`);
    expect(JSON.stringify(first.availableTools)).not.toContain('"title"');
    // The tools are still the step's tools, only not described yet.
    expect(state.offeredToolNames).toEqual(expect.arrayContaining([CREATE, LIST, ADD_LABEL, READ_FILE, 'search_tools']));
    expect(state.toolNameMap?.[CREATE]).toMatchObject({ server: 'github', tool: 'create_issue' });
    expect(first.currentPrompt).toContain('`search_tools`');

    // The model searches; FLUJO returns the full description and loads it.
    const found = await run(loopInput(state, [toolCall('c1', 'search_tools', { query: 'create issue' })])) as {
      tools: Array<{ name: string; description: string; inputSchema: { properties: Record<string, unknown> } }>;
      note: string;
    };
    expect(found.tools[0]).toMatchObject({ name: CREATE, description: 'Create a new issue in a repository.' });
    expect(Object.keys(found.tools[0].inputSchema.properties)).toEqual(['title', 'body']);
    expect(found.note).toMatch(/now loaded/);
    // Every match is loaded ("issue" also matches the other GitHub tools); read_file is not.
    expect(state.loadedDeferredTools).toEqual([ADD_LABEL, CREATE, LIST].sort());
    expect(callToolMock).not.toHaveBeenCalled();

    // Turn 2: loaded tools have their full schema; the rest stay deferred.
    const second = await new ProcessNode().prep(state, params({ toolLoading: 'on-demand' }));
    const loaded = second.availableTools!.find((tool) => tool.name === CREATE);
    expect(loaded?.inputSchema).toEqual({ type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' } } });
    expect(names(second.availableTools)).not.toContain(READ_FILE);
    // The catalog text did not change, so the provider's prompt cache holds.
    expect(second.availableTools!.find((tool) => tool.name === 'search_tools')?.description).toBe(search.description);

    // The model calls the loaded tool directly.
    const result = await ModelHandler.processToolCalls(loopInput(state, [toolCall('c2', CREATE, { title: 'Bug' })]));
    expect(result.success).toBe(true);
    expect(callToolMock).toHaveBeenCalledTimes(1);
    expect(callToolMock.mock.calls[0].slice(0, 3)).toEqual(['github', 'create_issue', { title: 'Bug' }]);
  });

  it('searches again after a restart, when the runtime catalog is gone, within the step offer only', async () => {
    const state = newState();
    await new ProcessNode().prep(state, params({ toolLoading: 'on-demand' }));
    const found = await run(loopInput(state, [toolCall('c1', 'search_tools', { query: 'read file issue' })], {
      toolCatalog: undefined,
      offeredToolNames: state.offeredToolNames!.filter((name) => name !== READ_FILE),
    })) as { tools: Array<{ name: string }> };
    expect(found.tools.map((tool) => tool.name)).not.toContain(READ_FILE);
    expect(found.tools.length).toBeGreaterThan(0);
  });

  it('keeps a small tool set up front in auto mode', async () => {
    const state = newState();
    const prep = await new ProcessNode().prep(state, params({}));
    expect(names(prep.availableTools)).toEqual(expect.arrayContaining([CREATE, LIST, ADD_LABEL, READ_FILE]));
    expect(names(prep.availableTools)).not.toContain('search_tools');
    expect(names(prep.availableTools)).not.toContain('run_tool_script');
  });

  it('respects the per-tool filter: a tool the MCP node does not enable is never in the catalog', async () => {
    const state = newState();
    const filtered = params({ toolLoading: 'on-demand' });
    (filtered.properties as { mcpNodes: Array<{ properties: { enabledTools: string[] } }> }).mcpNodes[0].properties.enabledTools = ['list_issues'];
    const prep = await new ProcessNode().prep(state, filtered);
    const search = prep.availableTools!.find((tool) => tool.name === 'search_tools')!;
    expect(search.description).toContain(LIST);
    expect(search.description).not.toContain(CREATE);
    const found = await run(loopInput(state, [toolCall('c1', 'search_tools', { names: [CREATE] })])) as { tools: unknown[] };
    expect(found.tools).toEqual([]);
  });
});

describe('code mode, full flow', () => {
  it('runs a program over the step tools and returns only its result', async () => {
    const state = newState();
    const prep = await new ProcessNode().prep(state, params({ codeMode: 'on', toolLoading: 'up-front' }));
    const script = prep.availableTools!.find((tool) => tool.name === 'run_tool_script')!;
    expect(script.description).toContain('- tools.github.list_issues');
    expect(prep.currentPrompt).toContain('`run_tool_script`');

    const answer = await run(loopInput(state, [toolCall('c1', 'run_tool_script', {
      code: [
        'const all = await tools.github.list_issues({ state: "open" });',
        'const bare = all.filter((issue) => issue.labels.length === 0);',
        'for (const issue of bare) await tools.github.add_label({ number: issue.number, label: "triage" });',
        'return { labelled: bare.map((issue) => issue.number) };',
      ].join('\n'),
    })])) as { ok: boolean; result: { labelled: number[] }; calls: Array<{ tool: string; ok: boolean }> };

    expect(answer.ok).toBe(true);
    expect(answer.result.labelled).toEqual([1, 5, 9, 13, 17, 21, 25, 29, 33, 37]);
    expect(answer.calls[0]).toEqual({ tool: 'list_issues', ok: true });
    expect(answer.calls).toHaveLength(11);
    // The 40 KB of issue bodies never reached the model.
    expect(JSON.stringify(answer)).not.toContain('SECRET-BODY');
    expect(callToolMock.mock.calls.map((call) => call[1])).toEqual(['list_issues', ...Array(10).fill('add_label')]);
  });

  it('asks the one approval gate for each call a step rule covers, with the real tool and arguments', async () => {
    const state = newState();
    await new ProcessNode().prep(state, params({ codeMode: 'on', toolLoading: 'up-front', requireApprovalFor: ['add_label'] }));
    approvalAnswer = false;

    const answer = await run(loopInput(state, [toolCall('c1', 'run_tool_script', {
      code: 'await tools.github.list_issues({}); try { await tools.github.add_label({ number: 3, label: "x" }); } catch (error) { return error.message; }',
    })], { conversationId: 'conversation' })) as { ok: boolean; result: string };

    expect(approvalCards).toEqual([{ conversationId: 'conversation', name: ADD_LABEL, args: { number: 3, label: 'x' } }]);
    expect(answer.result).toMatch(/did not approve/);
    expect(callToolMock.mock.calls.map((call) => call[1])).toEqual(['list_issues']);
  });

  it('asks for every call when the run requires approval, and runs approved calls', async () => {
    const state = newState();
    await new ProcessNode().prep(state, params({ codeMode: 'on', toolLoading: 'up-front' }));
    const answer = await run(loopInput(state, [toolCall('c1', 'run_tool_script', {
      code: 'return await tools.files.read_file({ path: "notes.txt" });',
    })], { conversationId: 'conversation', requireToolApproval: true })) as { ok: boolean; result: string };

    expect(approvalCards.map((card) => card.name)).toEqual([READ_FILE]);
    expect(answer).toMatchObject({ ok: true, result: 'read_file done' });
  });

  it('still asks for each call after a person approves the held program itself', async () => {
    const state = newState();
    await new ProcessNode().prep(state, params({ codeMode: 'on', toolLoading: 'up-front' }));
    state.requireApproval = true;
    state.status = 'awaiting_tool_approval';
    state.pendingToolCalls = [toolCall('p1', 'run_tool_script', { code: 'return await tools.files.read_file({ path: "a" });' })];

    const decision = await applyApprovalDecision(state, 'p1', 'approve');

    expect(decision.outcome).toBe('ready');
    expect(approvalCards).toEqual([{ conversationId: 'conversation', name: READ_FILE, args: { path: 'a' } }]);
    const answer = state.messages.find((message) => message.role === 'tool');
    expect(JSON.parse(String(answer?.content))).toMatchObject({ ok: true, result: 'read_file done' });
  });

  it('fails closed when approval is required and nobody can answer', async () => {
    const state = newState();
    await new ProcessNode().prep(state, params({ codeMode: 'on', toolLoading: 'up-front' }));
    const answer = await run(loopInput(state, [toolCall('c1', 'run_tool_script', {
      code: 'return await tools.files.read_file({ path: "notes.txt" });',
    })], { conversationId: 'conversation', requireToolApproval: true, onApprovalRequired: 'fail' })) as { ok: boolean; error: string };

    expect(answer.ok).toBe(false);
    expect(answer.error).toMatch(/no approver/);
    expect(callToolMock).not.toHaveBeenCalled();
  });

  it('refuses tools the step does not offer', async () => {
    const state = newState();
    const filtered = params({ codeMode: 'on', toolLoading: 'up-front' });
    (filtered.properties as { mcpNodes: Array<{ properties: { enabledTools: string[] } }> }).mcpNodes[1].properties.enabledTools = [];
    await new ProcessNode().prep(state, filtered);
    const answer = await run(loopInput(state, [toolCall('c1', 'run_tool_script', {
      code: `try { await callTool(${JSON.stringify(READ_FILE)}, { path: "a" }); } catch (error) { return error.message; }`,
    })])) as { result: string };
    expect(answer.result).toMatch(/not available in this step/);
    expect(callToolMock).not.toHaveBeenCalled();
  });

  it('is offered automatically together with deferred descriptions', async () => {
    const state = newState();
    const prep = await new ProcessNode().prep(state, params({ toolLoading: 'on-demand' }));
    expect(names(prep.availableTools)).toEqual(expect.arrayContaining(['search_tools', 'run_tool_script']));
    // A deferred tool can be called from a program without loading it first.
    const answer = await run(loopInput(state, [toolCall('c1', 'run_tool_script', {
      code: 'return await tools.github.create_issue({ title: "From a program" });',
    })])) as { ok: boolean; result: string };
    expect(answer).toMatchObject({ ok: true, result: 'create_issue done' });
  });
});
