/**
 * Tests for the handoff-tool schema shaping in ProcessNode.generateHandoffTools
 * (issue #96).
 *
 * Every Subflow target exposes `task`: one call creates one child job and
 * repeated calls form its queue. Isolated Subflows without a default require
 * the task. Process-to-Process handoffs retain the older optional/required
 * `prompt` behavior, while ordinary Process targets stay parameterless.
 *
 * generateHandoffTools is private; it is exercised directly via a cast. Its only
 * external reads (the containing flow and each target's handoff description) are
 * mocked so the test never touches disk or a model.
 */
import { flowService } from '@/backend/services/flow/index';

jest.mock('@/backend/services/flow/index', () => ({
  flowService: { getFlow: jest.fn() },
}));

// Descriptions are synthesized elsewhere and covered by their own tests; stub it
// so this test focuses purely on the input schema.
jest.mock('@/backend/execution/flow/buildHandoffDescription', () => ({
  buildHandoffDescription: jest.fn(async () => 'stub description'),
}));

import { ProcessNode, SignalNode, SubflowNode } from '@/backend/execution/flow/nodes';
import { ModelHandler } from '@/backend/execution/flow/handlers/ModelHandler';
import type { SharedState } from '@/backend/execution/flow/types';

const getFlowMock = flowService.getFlow as jest.Mock;

function subflowTarget(id: string): SubflowNode {
  const node = new SubflowNode();
  node.setParams({}, { id, label: id, type: 'subflow', properties: {} });
  return node;
}

function makeProcessNode(targets: { edgeId: string; nodeId: string }[]): ProcessNode {
  const proc = new ProcessNode();
  proc.setParams({}, { id: 'proc', label: 'P', type: 'process', properties: {} });
  for (const t of targets) {
    proc.addSuccessor(subflowTarget(t.nodeId), t.edgeId);
  }
  return proc;
}

/** A PROCESS node used as a handoff target (issue #96 extended to process→process). */
function processTarget(id: string): ProcessNode {
  const node = new ProcessNode();
  node.setParams({}, { id, label: id, type: 'process', properties: {} });
  return node;
}

/** Build the source ProcessNode wiring in arbitrary-typed target nodes. */
function makeProcessNodeWith(targets: { edgeId: string; node: ProcessNode | SignalNode | SubflowNode }[]): ProcessNode {
  const proc = new ProcessNode();
  proc.setParams({}, { id: 'proc', label: 'P', type: 'process', properties: {} });
  for (const t of targets) proc.addSuccessor(t.node, t.edgeId);
  return proc;
}

function hasPromptParam(tool: any): boolean {
  return !!tool?.inputSchema?.properties?.prompt;
}

beforeEach(() => {
  getFlowMock.mockReset();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('ProcessNode.generateHandoffTools — Signal body (#307)', () => {
  it('requires a non-empty body for a Signal target', async () => {
    const signal = new SignalNode();
    signal.setParams({}, { id: 'sig', label: 'Signal', type: 'signal', properties: {} });
    const proc = makeProcessNodeWith([{ edgeId: 'e-sig', node: signal }]);
    getFlowMock.mockResolvedValue({
      nodes: [{ id: 'sig', type: 'signal', data: { properties: { topic: 'done' } } }],
    });

    const tools = await (proc as any).generateHandoffTools({ flowId: 'flow-1' } as SharedState);

    expect(tools).toHaveLength(1);
    expect(tools[0].inputSchema.properties.body).toMatchObject({ type: 'string', minLength: 1 });
    expect(tools[0].inputSchema.required).toEqual(['body']);
    expect(tools[0].description).toContain('MUST');
  });
});

describe('ProcessNode.generateHandoffTools — queued Subflow jobs', () => {
  it('exposes a caller-chosen sessionKey for an enabled per-key Subflow and lists reusable keys', async () => {
    jest.spyOn(ModelHandler, 'isSubflowSessionsEnabled').mockResolvedValueOnce(true);
    const proc = makeProcessNode([{ edgeId: 'e-keyed', nodeId: 'sub-keyed' }]);
    getFlowMock.mockResolvedValue({
      nodes: [{
        id: 'sub-keyed',
        type: 'subflow',
        data: { properties: { sessionScope: 'per-key', sessionKey: '{{scene_id}}', saveConversation: true } },
      }],
    });
    const sharedState = {
      flowId: 'flow-1',
      subflowSessions: {
        'run::sub-keyed::writer-main': {
          version: 1,
          conversationId: 'child-1',
          nodeId: 'sub-keyed',
          sessionKey: 'writer-main',
          visits: 1,
          lastUsedAt: 10,
          status: 'idle',
        },
      },
    } as unknown as SharedState;

    const tools = await (proc as any).generateHandoffTools(sharedState);

    expect(tools[0].inputSchema.properties.sessionKey).toMatchObject({
      type: 'string',
      maxLength: 128,
    });
    expect(tools[0].inputSchema.required).not.toContain('sessionKey');
    expect(tools[0].description).toContain('follow-up');
    expect(tools[0].description).toContain('writer-main');
  });

  it('does not expose sessionKey while the experiment is disabled', async () => {
    jest.spyOn(ModelHandler, 'isSubflowSessionsEnabled').mockResolvedValueOnce(false);
    const proc = makeProcessNode([{ edgeId: 'e-keyed', nodeId: 'sub-keyed' }]);
    getFlowMock.mockResolvedValue({
      nodes: [{ id: 'sub-keyed', type: 'subflow', data: { properties: { sessionScope: 'per-key' } } }],
    });

    const tools = await (proc as any).generateHandoffTools({ flowId: 'flow-1' } as SharedState);

    expect(tools[0].inputSchema.properties.sessionKey).toBeUndefined();
  });

  it('exposes a `task` on every Subflow handoff without an opt-in flag', async () => {
    const proc = makeProcessNode([
      { edgeId: 'e-legacy', nodeId: 'sub-legacy' },
      { edgeId: 'e-plain', nodeId: 'sub-plain' },
    ]);

    getFlowMock.mockResolvedValue({
      nodes: [
        { id: 'sub-legacy', type: 'subflow', data: { properties: { allowCallerFanout: true } } },
        { id: 'sub-plain', type: 'subflow', data: { properties: {} } },
      ],
    });

    const sharedState = { flowId: 'flow-1' } as SharedState;
    const tools = await (proc as any).generateHandoffTools(sharedState);

    const withTask = tools.filter((t: any) => !!t?.inputSchema?.properties?.task);
    expect(withTask).toHaveLength(2);

    for (const tool of withTask) {
      expect(tool.inputSchema.properties.task.type).toBe('string');
      expect(tool.inputSchema.properties.parallelFlows).toBeUndefined();
      expect(tool.inputSchema.properties.concurrencyLimit).toBeUndefined();
      expect(tool.inputSchema.required).toEqual([]);
      expect(tool.description).toContain('MULTIPLE TIMES');
      expect(tool.description).toContain('queued');
    }
  });

  it('requires `task` only when an isolated Subflow has no default prompt', async () => {
    const proc = makeProcessNode([
      { edgeId: 'e-empty', nodeId: 'sub-empty' },
      { edgeId: 'e-authored', nodeId: 'sub-authored' },
      { edgeId: 'e-ws', nodeId: 'sub-ws' },
    ]);

    getFlowMock.mockResolvedValue({
      nodes: [
        { id: 'sub-empty', type: 'subflow', data: { properties: { inputMode: 'isolated' } } },
        { id: 'sub-authored', type: 'subflow', data: { properties: { inputMode: 'isolated', promptTemplate: 'analyze the repo' } } },
        { id: 'sub-ws', type: 'subflow', data: { properties: { inputMode: 'isolated', promptTemplate: '   \n  ' } } },
      ],
    });

    const sharedState = { flowId: 'flow-1' } as SharedState;
    const tools = await (proc as any).generateHandoffTools(sharedState);
    const nameToId = sharedState.handoffNameMap!;
    const byId = (id: string) => tools.find((t: any) => nameToId[t.name] === id);

    const empty = byId('sub-empty');
    expect(empty.inputSchema.properties.task.type).toBe('string');
    expect(empty.inputSchema.properties.prompt).toBeUndefined();
    expect(empty.inputSchema.required).toEqual(['task']);

    const authored = byId('sub-authored');
    expect(authored.inputSchema.properties.task.type).toBe('string');
    expect(authored.inputSchema.required).toEqual([]);

    const ws = byId('sub-ws');
    expect(ws.inputSchema.required).toEqual(['task']);
  });

  it('legacy allowCallerPrompt opt-out does not disable queued task handoffs', async () => {
    const proc = makeProcessNode([{ edgeId: 'e-sub', nodeId: 'sub' }]);
    getFlowMock.mockResolvedValue({
      nodes: [{ id: 'sub', type: 'subflow', data: { properties: { inputMode: 'isolated', allowCallerPrompt: false } } }],
    });

    const tools = await (proc as any).generateHandoffTools({ flowId: 'flow-1' } as SharedState);
    expect(tools).toHaveLength(1);
    expect(tools[0].inputSchema.properties.task.type).toBe('string');
    expect(tools[0].inputSchema.properties.prompt).toBeUndefined();
    expect(tools[0].inputSchema.required).toEqual(['task']);
  });
});

describe('ProcessNode.generateHandoffTools — caller-prompt for an ISOLATED PROCESS target (#96 process→process)', () => {
  it('exposes an OPTIONAL `prompt` for an isolated process target with an authored isolatedPrompt', async () => {
    const proc = makeProcessNodeWith([{ edgeId: 'e', node: processTarget('proc-iso') }]);
    getFlowMock.mockResolvedValue({
      nodes: [
        // A process node authors its isolated message as `isolatedPrompt` (not
        // promptTemplate); present ⇒ the caller prompt is optional.
        { id: 'proc-iso', type: 'process', data: { properties: { inputMode: 'isolated', isolatedPrompt: 'do the default thing' } } },
      ],
    });

    const tools = await (proc as any).generateHandoffTools({ flowId: 'flow-1' } as SharedState);
    expect(tools).toHaveLength(1);
    expect(tools[0].inputSchema.properties.prompt.type).toBe('string');
    expect(tools[0].inputSchema.required).toEqual([]);
  });

  it('marks `prompt` REQUIRED for an isolated process target with NO authored isolatedPrompt (#169)', async () => {
    const proc = makeProcessNodeWith([{ edgeId: 'e', node: processTarget('proc-empty') }]);
    getFlowMock.mockResolvedValue({
      nodes: [
        { id: 'proc-empty', type: 'process', data: { properties: { inputMode: 'isolated' } } },
      ],
    });

    const tools = await (proc as any).generateHandoffTools({ flowId: 'flow-1' } as SharedState);
    expect(tools[0].inputSchema.properties.prompt.type).toBe('string');
    expect(tools[0].inputSchema.required).toEqual(['prompt']);
    expect(tools[0].description).toContain('MUST');
  });

  it('keeps the empty schema for a full-history process target', async () => {
    const proc = makeProcessNodeWith([{ edgeId: 'e', node: processTarget('proc-full') }]);
    getFlowMock.mockResolvedValue({
      nodes: [
        { id: 'proc-full', type: 'process', data: { properties: { inputMode: 'full-history' } } },
      ],
    });

    const tools = await (proc as any).generateHandoffTools({ flowId: 'flow-1' } as SharedState);
    expect(hasPromptParam(tools[0])).toBe(false);
    expect(tools[0].inputSchema).toEqual({ type: 'object', properties: {}, required: [] });
  });

  it('keeps the empty schema when an isolated process target opts out (allowCallerPrompt:false)', async () => {
    const proc = makeProcessNodeWith([{ edgeId: 'e', node: processTarget('proc-optout') }]);
    getFlowMock.mockResolvedValue({
      nodes: [
        { id: 'proc-optout', type: 'process', data: { properties: { inputMode: 'isolated', allowCallerPrompt: false, isolatedPrompt: 'x' } } },
      ],
    });

    const tools = await (proc as any).generateHandoffTools({ flowId: 'flow-1' } as SharedState);
    expect(hasPromptParam(tools[0])).toBe(false);
    expect(tools[0].inputSchema).toEqual({ type: 'object', properties: {}, required: [] });
  });
});
