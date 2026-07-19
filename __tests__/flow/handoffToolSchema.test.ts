/**
 * Tests for the handoff-tool schema shaping in ProcessNode.generateHandoffTools
 * (issue #96).
 *
 * A handoff tool is normally parameter-less. When its target is a Subflow node
 * in 'isolated' inputMode that opted into `allowCallerPrompt`, the tool must
 * instead expose an OPTIONAL `prompt` string so a routing model can instruct the
 * child flow. Every other target — including an isolated subflow that did NOT
 * opt in, and a subflow whose inputMode is not 'isolated' — must keep the
 * byte-identical empty schema (preserving the #89 prefix-cache stability).
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

import { ProcessNode, SubflowNode } from '@/backend/execution/flow/nodes';
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

function hasPromptParam(tool: any): boolean {
  return !!tool?.inputSchema?.properties?.prompt;
}

beforeEach(() => {
  getFlowMock.mockReset();
});

describe('ProcessNode.generateHandoffTools — caller-prompt schema (#96)', () => {
  it('exposes an optional `prompt` param ONLY for an isolated subflow with allowCallerPrompt', async () => {
    const proc = makeProcessNode([
      { edgeId: 'e-allow', nodeId: 'sub-allow' },
      { edgeId: 'e-plain', nodeId: 'sub-plain' },
      { edgeId: 'e-fullhist', nodeId: 'sub-fullhist' },
    ]);

    getFlowMock.mockResolvedValue({
      nodes: [
        // Has an authored promptTemplate, so `prompt` stays OPTIONAL (a caller
        // brief is a nice-to-have; the authored message is the fallback).
        { id: 'sub-allow', type: 'subflow', data: { properties: { inputMode: 'isolated', allowCallerPrompt: true, promptTemplate: 'do the default thing' } } },
        { id: 'sub-plain', type: 'subflow', data: { properties: { inputMode: 'isolated' } } },
        { id: 'sub-fullhist', type: 'subflow', data: { properties: { inputMode: 'full-history', allowCallerPrompt: true } } },
      ],
    });

    const sharedState = { flowId: 'flow-1' } as SharedState;
    const tools = await (proc as any).generateHandoffTools(sharedState);

    // Exactly one tool carries the prompt parameter.
    const withPrompt = tools.filter(hasPromptParam);
    expect(withPrompt).toHaveLength(1);

    // Map tool -> target node id via the recorded handoffNameMap to assert which.
    const nameToId = sharedState.handoffNameMap!;
    expect(nameToId[withPrompt[0].name]).toBe('sub-allow');

    // The prompt param is an OPTIONAL string.
    expect(withPrompt[0].inputSchema.properties.prompt.type).toBe('string');
    expect(withPrompt[0].inputSchema.required).toEqual([]);

    // Every other tool keeps the empty (parameter-less) schema.
    for (const tool of tools.filter((t: any) => !hasPromptParam(t))) {
      expect(tool.inputSchema).toEqual({ type: 'object', properties: {}, required: [] });
    }
  });

  it('keeps handoff tools parameter-less when no target opts in', async () => {
    const proc = makeProcessNode([{ edgeId: 'e-plain', nodeId: 'sub-plain' }]);
    getFlowMock.mockResolvedValue({
      nodes: [{ id: 'sub-plain', type: 'subflow', data: { properties: { inputMode: 'isolated' } } }],
    });

    const tools = await (proc as any).generateHandoffTools({ flowId: 'flow-1' } as SharedState);

    expect(tools).toHaveLength(1);
    expect(hasPromptParam(tools[0])).toBe(false);
    expect(tools[0].inputSchema).toEqual({ type: 'object', properties: {}, required: [] });
  });
});

describe('ProcessNode.generateHandoffTools — spawn-with-brief schema (#156)', () => {
  it('exposes an optional `task` param ONLY for a subflow with allowCallerFanout, with the multi-call instruction', async () => {
    const proc = makeProcessNode([
      { edgeId: 'e-spawn', nodeId: 'sub-spawn' },
      { edgeId: 'e-plain', nodeId: 'sub-plain' },
    ]);

    getFlowMock.mockResolvedValue({
      nodes: [
        { id: 'sub-spawn', type: 'subflow', data: { properties: { allowCallerFanout: true } } },
        { id: 'sub-plain', type: 'subflow', data: { properties: {} } },
      ],
    });

    const sharedState = { flowId: 'flow-1' } as SharedState;
    const tools = await (proc as any).generateHandoffTools(sharedState);

    const withTask = tools.filter((t: any) => !!t?.inputSchema?.properties?.task);
    expect(withTask).toHaveLength(1);

    const nameToId = sharedState.handoffNameMap!;
    expect(nameToId[withTask[0].name]).toBe('sub-spawn');

    // task is an OPTIONAL string; the legacy parallelFlows/concurrencyLimit
    // params are gone from the schema (the model must never name flows again).
    expect(withTask[0].inputSchema.properties.task.type).toBe('string');
    expect(withTask[0].inputSchema.properties.parallelFlows).toBeUndefined();
    expect(withTask[0].inputSchema.properties.concurrencyLimit).toBeUndefined();
    expect(withTask[0].inputSchema.required).toEqual([]);

    // The description teaches the model to call the tool once per parallel worker.
    expect(withTask[0].description).toContain('MULTIPLE TIMES');
    expect(withTask[0].description).toContain('task');

    // The non-opted subflow keeps the byte-identical empty schema.
    const plain = tools.find((t: any) => nameToId[t.name] === 'sub-plain');
    expect(plain.inputSchema).toEqual({ type: 'object', properties: {}, required: [] });
  });

  it('marks `prompt` REQUIRED for an isolated allowCallerPrompt subflow with NO authored promptTemplate (#169)', async () => {
    const proc = makeProcessNode([
      { edgeId: 'e-empty', nodeId: 'sub-empty' },
      { edgeId: 'e-authored', nodeId: 'sub-authored' },
      { edgeId: 'e-ws', nodeId: 'sub-ws' },
    ]);

    getFlowMock.mockResolvedValue({
      nodes: [
        // No authored message → caller MUST supply a prompt.
        { id: 'sub-empty', type: 'subflow', data: { properties: { inputMode: 'isolated', allowCallerPrompt: true } } },
        // Authored message → prompt stays optional.
        { id: 'sub-authored', type: 'subflow', data: { properties: { inputMode: 'isolated', allowCallerPrompt: true, promptTemplate: 'analyze the repo' } } },
        // Whitespace-only authored message counts as empty → required.
        { id: 'sub-ws', type: 'subflow', data: { properties: { inputMode: 'isolated', allowCallerPrompt: true, promptTemplate: '   \n  ' } } },
      ],
    });

    const sharedState = { flowId: 'flow-1' } as SharedState;
    const tools = await (proc as any).generateHandoffTools(sharedState);
    const nameToId = sharedState.handoffNameMap!;
    const byId = (id: string) => tools.find((t: any) => nameToId[t.name] === id);

    // Empty authored template → `prompt` present AND required.
    const empty = byId('sub-empty');
    expect(empty.inputSchema.properties.prompt.type).toBe('string');
    expect(empty.inputSchema.required).toEqual(['prompt']);
    expect(empty.description).toContain('MUST');

    // Authored template → `prompt` present but optional.
    const authored = byId('sub-authored');
    expect(authored.inputSchema.properties.prompt.type).toBe('string');
    expect(authored.inputSchema.required).toEqual([]);

    // Whitespace-only authored template is treated as empty → required.
    const ws = byId('sub-ws');
    expect(ws.inputSchema.required).toEqual(['prompt']);
  });

  it('keeps `prompt` OPTIONAL for a spawn (allowCallerFanout) target even with no authored message (#169 excludes spawn)', async () => {
    // Spawn targets expose `task`, not `prompt`, and must never force a required
    // arg — the #169 mandatory rule applies only to the non-parallel prompt path.
    const proc = makeProcessNode([{ edgeId: 'e-spawn', nodeId: 'sub-spawn' }]);
    getFlowMock.mockResolvedValue({
      nodes: [
        { id: 'sub-spawn', type: 'subflow', data: { properties: { inputMode: 'isolated', allowCallerPrompt: true, allowCallerFanout: true } } },
      ],
    });

    const tools = await (proc as any).generateHandoffTools({ flowId: 'flow-1' } as SharedState);
    expect(tools).toHaveLength(1);
    expect(tools[0].inputSchema.properties.task.type).toBe('string');
    expect(tools[0].inputSchema.properties.prompt).toBeUndefined();
    expect(tools[0].inputSchema.required).toEqual([]);
  });

  it('spawn wins over caller-prompt when both are opted in (only `task` is exposed)', async () => {
    const proc = makeProcessNode([{ edgeId: 'e-both', nodeId: 'sub-both' }]);
    getFlowMock.mockResolvedValue({
      nodes: [
        {
          id: 'sub-both',
          type: 'subflow',
          data: { properties: { inputMode: 'isolated', allowCallerPrompt: true, allowCallerFanout: true } },
        },
      ],
    });

    const tools = await (proc as any).generateHandoffTools({ flowId: 'flow-1' } as SharedState);

    expect(tools).toHaveLength(1);
    const props = tools[0].inputSchema.properties;
    expect(props.task.type).toBe('string');
    expect(props.prompt).toBeUndefined();
    expect(tools[0].inputSchema.required).toEqual([]);
  });
});
