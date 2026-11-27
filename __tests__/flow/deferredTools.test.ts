/**
 * Deferred tool descriptions (#1448): the planning, catalog and search rules.
 * The full flow through ProcessNode and the tool loop is in
 * deferredToolsFlow.test.ts.
 */
import type { ToolDefinition } from '@/backend/execution/flow/types';
import {
  CALL_TOOL_TOOL_NAME,
  SEARCH_TOOLS_TOOL_NAME,
  autoDeferThresholdTokens,
  buildDeferredToolCatalog,
  planToolLoading,
  searchDeferredTools,
  shouldDeferToolDescriptions,
  summarizeToolDescription,
  toolDefinitionTokens,
} from '@/backend/execution/flow/toolLoading/deferredTools';
import { addLoadedDeferredTools, planStepTools } from '@/backend/execution/flow/toolLoading/planStepTools';
import { normalizeToolLoadingMode, normalizeCodeModeSetting } from '@/shared/types/flow/toolLoading';
import { RUN_TOOL_SCRIPT_TOOL_NAME } from '@/backend/execution/flow/codeMode/codeModeTool';

function mcpTool(server: string, tool: string, description: string, extraProperties = 0): ToolDefinition {
  const properties: Record<string, unknown> = { id: { type: 'string', description: 'The id.' } };
  for (let index = 0; index < extraProperties; index++) {
    properties[`field_${index}`] = { type: 'string', description: `A long description of field number ${index} that takes some room.` };
  }
  return {
    name: `mcp_${tool}_${server}`,
    originalName: tool,
    server,
    description,
    inputSchema: { type: 'object', properties },
  };
}

const handoff: ToolDefinition = { name: 'handoff_to_finish', description: 'Finish.', inputSchema: { type: 'object' } };
const todo: ToolDefinition = { name: 'todo', description: 'Task list.', inputSchema: { type: 'object' } };

const small = [
  mcpTool('github', 'create_issue', 'Create a new issue in a repository. Returns the issue.'),
  mcpTool('github', 'list_issues', 'List issues in a repository.'),
  mcpTool('files', 'read_file', 'Read a file from disk.'),
];

const large = Array.from({ length: 60 }, (_, index) =>
  mcpTool(`server${index % 4}`, `tool_${index}`, `Does thing number ${index} with care.`, 12));

describe('settings', () => {
  it('defaults unknown values to auto', () => {
    expect(normalizeToolLoadingMode(undefined)).toBe('auto');
    expect(normalizeToolLoadingMode('bogus')).toBe('auto');
    expect(normalizeToolLoadingMode('on-demand')).toBe('on-demand');
    expect(normalizeCodeModeSetting(undefined)).toBe('auto');
    expect(normalizeCodeModeSetting('off')).toBe('off');
  });
});

describe('when descriptions are deferred', () => {
  it('auto defers only once full MCP descriptions would fill a share of the context window', () => {
    expect(toolDefinitionTokens(small)).toBeLessThan(autoDeferThresholdTokens(128_000));
    expect(shouldDeferToolDescriptions('auto', small, 128_000)).toBe(false);
    expect(toolDefinitionTokens(large)).toBeGreaterThan(autoDeferThresholdTokens(128_000));
    expect(shouldDeferToolDescriptions('auto', large, 128_000)).toBe(true);
  });

  it('scales the auto threshold with the context window, with a floor', () => {
    expect(autoDeferThresholdTokens(200_000)).toBe(10_000);
    expect(autoDeferThresholdTokens(8_000)).toBe(2_000);
    expect(autoDeferThresholdTokens(undefined)).toBe(Math.floor(128 * 1024 * 0.05));
  });

  it('on-demand always defers and up-front never does', () => {
    expect(shouldDeferToolDescriptions('on-demand', small, 128_000)).toBe(true);
    expect(shouldDeferToolDescriptions('up-front', large, 128_000)).toBe(false);
    expect(shouldDeferToolDescriptions('on-demand', [], 128_000)).toBe(false);
  });
});

describe('planToolLoading', () => {
  it('hides MCP tools behind search_tools and keeps FLUJO tools', () => {
    const plan = planToolLoading({ tools: [handoff, ...small, todo], mode: 'on-demand', callThrough: false });
    expect(plan.deferring).toBe(true);
    expect(plan.visible.map((tool) => tool.name)).toEqual(['handoff_to_finish', 'todo', SEARCH_TOOLS_TOOL_NAME]);
    expect(plan.deferred.map((tool) => tool.originalName)).toEqual(['create_issue', 'list_issues', 'read_file']);
    const search = plan.visible.find((tool) => tool.name === SEARCH_TOOLS_TOOL_NAME)!;
    expect(search.description).toContain('- mcp_create_issue_github (github): Create a new issue in a repository.');
    // The full schema is not in the catalog.
    expect(search.description).not.toContain('"properties"');
  });

  it('offers loaded tools with their full description and keeps the catalog unchanged', () => {
    const first = planToolLoading({ tools: small, mode: 'on-demand', callThrough: false });
    const second = planToolLoading({ tools: small, mode: 'on-demand', loadedNames: ['mcp_list_issues_github'], callThrough: false });
    expect(second.visible.map((tool) => tool.name)).toEqual(['mcp_list_issues_github', SEARCH_TOOLS_TOOL_NAME]);
    expect(second.deferred).toHaveLength(2);
    const search = (plan: typeof first) => plan.visible.find((tool) => tool.name === SEARCH_TOOLS_TOOL_NAME);
    expect(JSON.stringify(search(second))).toBe(JSON.stringify(search(first)));
  });

  it('adds call_tool when the adapter runs its own tool loop', () => {
    const plan = planToolLoading({ tools: small, mode: 'on-demand', callThrough: true });
    expect(plan.visible.map((tool) => tool.name)).toEqual([SEARCH_TOOLS_TOOL_NAME, CALL_TOOL_TOOL_NAME]);
    expect(plan.visible[0].description).toContain('call_tool');
  });

  it('leaves the tool list untouched when nothing is deferred', () => {
    const tools = [handoff, ...small];
    const plan = planToolLoading({ tools, mode: 'up-front', callThrough: false });
    expect(plan.visible).toEqual(tools);
    expect(plan.deferred).toEqual([]);
  });
});

describe('planStepTools', () => {
  const openai = { provider: 'openai' as const, adapter: 'openai' as const, contextWindow: 128_000 };
  const claude = { provider: 'anthropic' as const, adapter: 'claude-cli' as const, contextWindow: 200_000 };

  it('uses call_tool only for adapters that run their own loop, and not behind a fallback policy', () => {
    expect(planStepTools({ tools: small, toolLoading: 'on-demand', model: openai, restricted: false }).catalog.callThrough).toBe(false);
    expect(planStepTools({ tools: small, toolLoading: 'on-demand', model: claude, restricted: false }).catalog.callThrough).toBe(true);
    expect(planStepTools({ tools: small, toolLoading: 'on-demand', model: { ...claude, fallbackPolicy: {} }, restricted: false })
      .catalog.callThrough).toBe(false);
  });

  it('offers code mode with deferral in auto, always when on, never when off', () => {
    const names = (plan: ReturnType<typeof planStepTools>) => plan.tools.map((tool) => tool.name);
    expect(names(planStepTools({ tools: large, model: openai, restricted: false }))).toContain(RUN_TOOL_SCRIPT_TOOL_NAME);
    expect(names(planStepTools({ tools: small, model: openai, restricted: false }))).not.toContain(RUN_TOOL_SCRIPT_TOOL_NAME);
    expect(names(planStepTools({ tools: small, codeMode: 'on', model: openai, restricted: false }))).toContain(RUN_TOOL_SCRIPT_TOOL_NAME);
    expect(names(planStepTools({ tools: large, codeMode: 'off', model: openai, restricted: false }))).not.toContain(RUN_TOOL_SCRIPT_TOOL_NAME);
    expect(names(planStepTools({ tools: [handoff], codeMode: 'on', model: openai, restricted: false }))).not.toContain(RUN_TOOL_SCRIPT_TOOL_NAME);
  });

  it('keeps a private execution exactly as approved', () => {
    const plan = planStepTools({ tools: large, toolLoading: 'on-demand', codeMode: 'on', model: openai, restricted: true });
    expect(plan.tools).toHaveLength(large.length);
    expect(plan.catalog).toMatchObject({ deferring: false, codeMode: false });
    expect(plan.deferredNames).toEqual([]);
  });

  it('records loaded tools once, sorted', () => {
    const state: { loadedDeferredTools?: string[] } = {};
    addLoadedDeferredTools(state, ['b', 'a']);
    addLoadedDeferredTools(state, ['a']);
    addLoadedDeferredTools(state, []);
    expect(state.loadedDeferredTools).toEqual(['a', 'b']);
  });
});

describe('catalog', () => {
  it('summarizes a description to its first sentence on one line', () => {
    expect(summarizeToolDescription('Read a file.\nMore detail here.')).toBe('Read a file.');
    expect(summarizeToolDescription('  no   period here  ')).toBe('no period here');
    expect(summarizeToolDescription('x'.repeat(300))).toHaveLength(100);
    expect(summarizeToolDescription(undefined)).toBe('');
  });

  it('falls back to names only, then counts per server, to stay within budget', () => {
    const withSummaries = buildDeferredToolCatalog(large);
    expect(withSummaries).toContain('Does thing number');
    const namesOnly = buildDeferredToolCatalog(large, 2_000);
    expect(namesOnly).not.toContain('Does thing number');
    expect(namesOnly).toContain('- mcp_tool_0_server0 (server0)');
    const counts = buildDeferredToolCatalog(large, 200);
    expect(counts).toBe([
      '- server0: 15 tools (search to see them)',
      '- server1: 15 tools (search to see them)',
      '- server2: 15 tools (search to see them)',
      '- server3: 15 tools (search to see them)',
    ].join('\n'));
  });

  it('is the same text for the same tools in any order', () => {
    expect(buildDeferredToolCatalog([...small].reverse())).toBe(buildDeferredToolCatalog(small));
  });
});

describe('searchDeferredTools', () => {
  it('ranks tools by name words, then server, then description', () => {
    expect(searchDeferredTools(small, { query: 'create issue' })[0].originalName).toBe('create_issue');
    expect(searchDeferredTools(small, { query: 'file' }).map((tool) => tool.originalName)).toEqual(['read_file']);
    expect(searchDeferredTools(small, { query: 'github' }).map((tool) => tool.originalName))
      .toEqual(['create_issue', 'list_issues']);
  });

  it('loads exact names first, by model-facing or MCP name', () => {
    const found = searchDeferredTools(small, { names: ['read_file', 'MCP_LIST_ISSUES_GITHUB'], query: 'create' });
    expect(found.map((tool) => tool.originalName)).toEqual(['read_file', 'list_issues', 'create_issue']);
  });

  it('returns nothing for unknown words and respects the limit', () => {
    expect(searchDeferredTools(small, { query: 'zebra' })).toEqual([]);
    expect(searchDeferredTools(large, { query: 'thing', limit: 3 })).toHaveLength(3);
  });
});

describe('system prompt', () => {
  // Imported here so the planning tests above stay free of prompt wiring.
  const { buildFlujoSystemPrompt } = jest.requireActual('@/shared/utils/flujoSystemPrompt') as typeof import('@/shared/utils/flujoSystemPrompt');
  const prompt = (names: string[]) => buildFlujoSystemPrompt({ tools: names.map((name) => ({ name })), handoffs: [], startedByAgent: false });

  it('explains search_tools, call_tool and run_tool_script only when the step has them', () => {
    expect(prompt(['search_tools'])).toContain('Read a tool\'s description with `search_tools` before you use it.');
    expect(prompt(['search_tools', 'call_tool'])).toContain('then run it with `call_tool`.');
    expect(prompt(['run_tool_script'])).toContain('write a short program with `run_tool_script`');
    expect(prompt(['todo'])).not.toMatch(/search_tools|run_tool_script/);
  });
});

describe('FlowSpec and the example flow', () => {
  const { compileFlowSpec, flowToSpec } = jest.requireActual('@/utils/shared/flowSpecCompiler') as typeof import('@/utils/shared/flowSpecCompiler');
  const example = jest.requireActual('../../docs/examples/code-mode-folder-report.flowspec.json') as import('@/utils/shared/flowSpecCompiler').FlowSpec;
  const context = { models: [{ id: 'model', name: '<your model>' }], servers: [{ name: 'filesystem' }] };

  it('compiles the documented code-mode example and keeps both settings', () => {
    const compiled = compileFlowSpec(example, context);
    expect(compiled.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    const step = compiled.flow!.nodes.find((node) => node.type === 'process')!;
    expect(step.data.properties).toMatchObject({ toolLoading: 'on-demand', codeMode: 'on' });
    const roundTrip = flowToSpec(compiled.flow!).nodes.find((node) => node.type === 'process')!;
    expect(roundTrip).toMatchObject({ toolLoading: 'on-demand', codeMode: 'on' });
  });

  it('stores nothing for the default and warns about an unknown value', () => {
    const spec = { ...example, nodes: example.nodes.map((node) => node.type === 'process'
      ? { ...node, toolLoading: 'auto' as const, codeMode: 'sometimes' as never }
      : node) };
    const compiled = compileFlowSpec(spec, context);
    const step = compiled.flow!.nodes.find((node) => node.type === 'process')!;
    expect(step.data.properties?.toolLoading).toBeUndefined();
    expect(step.data.properties?.codeMode).toBeUndefined();
    expect(compiled.issues.map((issue) => issue.code)).toContain('invalid-code-mode');
  });
});
