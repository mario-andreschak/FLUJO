/**
 * Composition coverage for PromptRenderer (issue #104).
 *
 * Complements the binding-resolution suite (promptRendererBindings.test.ts, which
 * already covers resource/tool pills and the full `excludeSystemPrompt` #67 matrix)
 * by exercising the genuinely uncovered composition logic:
 *  - renderMode default (tool pills stay RAW due to the resolveBindings override),
 *  - includeConversationHistory placeholder injection,
 *  - start-node + model + node merge ordering and the exclusion flags,
 *    including option-over-node-property precedence in both directions.
 *
 * flow/model/mcp services are mocked so no real flow store, model, or MCP server runs.
 */

const getFlowMock = jest.fn();
jest.mock('@/backend/services/flow', () => ({
  flowService: { getFlow: (...a: unknown[]) => getFlowMock(...a) },
}));

const getModelMock = jest.fn();
jest.mock('@/backend/services/model', () => ({
  modelService: { getModel: (...a: unknown[]) => getModelMock(...a) },
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

const START_PROMPT = 'START_NODE_PROMPT_TEXT';
const MODEL_PROMPT = 'MODEL_PROMPT_TEXT';
const NODE_BODY = 'NODE_INSTRUCTION_BODY';
const HISTORY_PLACEHOLDER = '[Conversation History will be included here]';

/**
 * Build a two-node flow: a start node carrying `startPrompt`, and a process node
 * `node-1` carrying `nodePrompt` plus the given properties (bound model, exclusion flags).
 */
const flow = (opts: {
  startPrompt?: string;
  nodePrompt?: string;
  boundModel?: string;
  excludeModelPrompt?: boolean;
  excludeStartNodePrompt?: boolean;
  excludeSystemPrompt?: boolean;
}) => ({
  id: 'flow-1',
  nodes: [
    {
      id: 'start',
      type: 'start',
      data: { properties: { promptTemplate: opts.startPrompt ?? '' } },
    },
    {
      id: 'node-1',
      type: 'process',
      data: {
        properties: {
          promptTemplate: opts.nodePrompt ?? NODE_BODY,
          ...(opts.boundModel !== undefined ? { boundModel: opts.boundModel } : {}),
          ...(opts.excludeModelPrompt !== undefined
            ? { excludeModelPrompt: opts.excludeModelPrompt }
            : {}),
          ...(opts.excludeStartNodePrompt !== undefined
            ? { excludeStartNodePrompt: opts.excludeStartNodePrompt }
            : {}),
          ...(opts.excludeSystemPrompt !== undefined
            ? { excludeSystemPrompt: opts.excludeSystemPrompt }
            : {}),
        },
      },
    },
  ],
});

beforeEach(() => {
  getFlowMock.mockReset();
  getModelMock.mockReset();
  getServerStatusMock.mockReset();
  readResourceMock.mockReset();
  listServerToolsMock.mockReset();
  getModelMock.mockResolvedValue(null);
  getServerStatusMock.mockResolvedValue({ status: 'connected' });
  listServerToolsMock.mockResolvedValue({ tools: [] });
});

describe('PromptRenderer renderMode', () => {
  it('defaults to rendered, but tool pills stay RAW (resolveBindings forces raw)', async () => {
    // resolveBindings() hard-sets `renderMode = 'raw'` for tool pills ("keep tool
    // pills raw" override in PromptRenderer.ts), so even the DEFAULT ('rendered')
    // leaves a tool pill untouched. This asserts that actual current behavior; a
    // future change that expands tool pills by default would (intentionally) break it.
    getFlowMock.mockResolvedValue(
      flow({
        nodePrompt: 'Use ${tool:files__read} now',
        excludeStartNodePrompt: true,
        excludeModelPrompt: true,
        excludeSystemPrompt: true,
      })
    );

    const result = await promptRenderer.renderPrompt('flow-1', 'node-1');

    expect(result).toContain('${tool:files__read}');
    expect(listServerToolsMock).not.toHaveBeenCalled();
  });
});

describe('PromptRenderer includeConversationHistory', () => {
  it('appends the conversation-history placeholder when requested', async () => {
    getFlowMock.mockResolvedValue(
      flow({
        excludeStartNodePrompt: true,
        excludeModelPrompt: true,
        excludeSystemPrompt: true,
      })
    );

    const result = await promptRenderer.renderPrompt('flow-1', 'node-1', {
      includeConversationHistory: true,
    });

    expect(result).toContain(HISTORY_PLACEHOLDER);
    expect(result.trimEnd().endsWith(HISTORY_PLACEHOLDER)).toBe(true);
  });

  it('does not append the placeholder by default', async () => {
    getFlowMock.mockResolvedValue(
      flow({
        excludeStartNodePrompt: true,
        excludeModelPrompt: true,
        excludeSystemPrompt: true,
      })
    );

    const result = await promptRenderer.renderPrompt('flow-1', 'node-1');

    expect(result).not.toContain(HISTORY_PLACEHOLDER);
  });
});

describe('PromptRenderer start/model/node composition', () => {
  it('merges start prompt, model prompt, then node prompt in that order', async () => {
    getFlowMock.mockResolvedValue(
      flow({
        startPrompt: START_PROMPT,
        nodePrompt: NODE_BODY,
        boundModel: 'model-1',
        excludeSystemPrompt: true,
      })
    );
    getModelMock.mockResolvedValue({ name: 'M', promptTemplate: MODEL_PROMPT });

    const result = await promptRenderer.renderPrompt('flow-1', 'node-1');

    const iStart = result.indexOf(START_PROMPT);
    const iModel = result.indexOf(MODEL_PROMPT);
    const iNode = result.indexOf(NODE_BODY);
    expect(iStart).toBeGreaterThanOrEqual(0);
    expect(iModel).toBeGreaterThan(iStart);
    expect(iNode).toBeGreaterThan(iModel);
  });

  it('drops the start-node prompt when excludeStartNodePrompt is set on the node', async () => {
    getFlowMock.mockResolvedValue(
      flow({
        startPrompt: START_PROMPT,
        boundModel: 'model-1',
        excludeStartNodePrompt: true,
        excludeSystemPrompt: true,
      })
    );
    getModelMock.mockResolvedValue({ name: 'M', promptTemplate: MODEL_PROMPT });

    const result = await promptRenderer.renderPrompt('flow-1', 'node-1');

    expect(result).not.toContain(START_PROMPT);
    expect(result).toContain(MODEL_PROMPT);
    expect(result).toContain(NODE_BODY);
  });

  it('drops the model prompt when excludeModelPrompt is set on the node', async () => {
    getFlowMock.mockResolvedValue(
      flow({
        startPrompt: START_PROMPT,
        boundModel: 'model-1',
        excludeModelPrompt: true,
        excludeSystemPrompt: true,
      })
    );
    getModelMock.mockResolvedValue({ name: 'M', promptTemplate: MODEL_PROMPT });

    const result = await promptRenderer.renderPrompt('flow-1', 'node-1');

    expect(result).toContain(START_PROMPT);
    expect(result).not.toContain(MODEL_PROMPT);
    expect(result).toContain(NODE_BODY);
  });

  it('lets the excludeStartNodePrompt option override the node property (node false -> option true)', async () => {
    getFlowMock.mockResolvedValue(
      flow({
        startPrompt: START_PROMPT,
        excludeStartNodePrompt: false,
        excludeModelPrompt: true,
        excludeSystemPrompt: true,
      })
    );

    const result = await promptRenderer.renderPrompt('flow-1', 'node-1', {
      excludeStartNodePrompt: true,
    });

    expect(result).not.toContain(START_PROMPT);
  });

  it('lets the excludeStartNodePrompt option override the node property (node true -> option false)', async () => {
    getFlowMock.mockResolvedValue(
      flow({
        startPrompt: START_PROMPT,
        excludeStartNodePrompt: true,
        excludeModelPrompt: true,
        excludeSystemPrompt: true,
      })
    );

    const result = await promptRenderer.renderPrompt('flow-1', 'node-1', {
      excludeStartNodePrompt: false,
    });

    expect(result).toContain(START_PROMPT);
  });

  it('lets the excludeModelPrompt option override the node property (node true -> option false)', async () => {
    getFlowMock.mockResolvedValue(
      flow({
        boundModel: 'model-1',
        excludeModelPrompt: true,
        excludeStartNodePrompt: true,
        excludeSystemPrompt: true,
      })
    );
    getModelMock.mockResolvedValue({ name: 'M', promptTemplate: MODEL_PROMPT });

    const result = await promptRenderer.renderPrompt('flow-1', 'node-1', {
      excludeModelPrompt: false,
    });

    expect(result).toContain(MODEL_PROMPT);
  });
});
