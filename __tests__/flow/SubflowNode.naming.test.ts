import {
  SubflowNode,
  resolveSubAgentDisplayName,
} from '@/backend/execution/flow/nodes/SubflowNode';
import type {
  SharedState,
  SubflowLaneResult,
  SubflowNodeExecResult,
  SubflowNodeParams,
  SubflowNodePrepResult,
} from '@/backend/execution/flow/types';

function makeShared(): SharedState {
  return {
    conversationId: 'conv-naming',
    messages: [],
    trackingInfo: { nodeExecutionTracker: [] },
  } as unknown as SharedState;
}

function makeNode(): SubflowNode {
  const node = new SubflowNode();
  (node as unknown as { successors: Record<string, unknown> }).successors = { NEXT: {} };
  return node;
}

function makeParams(label?: string, legacyName?: string): SubflowNodeParams {
  return {
    id: 'subflow-node',
    type: 'subflow',
    label,
    properties: legacyName === undefined ? {} : { name: legacyName },
  } as unknown as SubflowNodeParams;
}

function makePrep(overrides: Partial<SubflowNodePrepResult> = {}): SubflowNodePrepResult {
  return {
    nodeType: 'subflow',
    depth: 1,
    showSteps: true,
    ...overrides,
  } as SubflowNodePrepResult;
}

function makeExec(
  outputText: string,
  lanes?: SubflowLaneResult[],
): SubflowNodeExecResult {
  return {
    success: true,
    outputText,
    ...(lanes ? { lanes } : {}),
  };
}

describe('resolveSubAgentDisplayName', () => {
  it.each([
    {
      name: 'lane identity wins when every candidate is present',
      args: {
        laneName: 'Lane child',
        nodeLabel: 'Node label',
        subflowName: 'Aggregate child',
        legacyName: 'Legacy',
      },
      expected: 'Lane child',
    },
    {
      name: 'node label wins without a lane identity',
      args: {
        nodeLabel: 'Node label',
        subflowName: 'Aggregate child',
        legacyName: 'Legacy',
      },
      expected: 'Node label',
    },
    {
      name: 'child-flow name wins without lane or node identities',
      args: {
        laneName: '  ',
        nodeLabel: '',
        subflowName: 'Aggregate child',
        legacyName: 'Legacy',
      },
      expected: 'Aggregate child',
    },
    {
      name: 'legacy name remains the final named fallback',
      args: {
        laneName: '',
        nodeLabel: '   ',
        subflowName: '\t',
        legacyName: 'Legacy',
      },
      expected: 'Legacy',
    },
    {
      name: 'unusable candidates return undefined',
      args: {
        laneName: '',
        nodeLabel: '   ',
        subflowName: '\n',
        legacyName: '\t',
      },
      expected: undefined,
    },
    {
      name: 'the selected identity is trimmed',
      args: {
        laneName: '  Lane child  ',
        nodeLabel: ' Node label ',
        subflowName: ' Aggregate child ',
        legacyName: ' Legacy ',
      },
      expected: 'Lane child',
    },
  ])('$name', ({ args, expected }) => {
    expect(resolveSubAgentDisplayName(args)).toBe(expected);
  });
});

describe('SubflowNode joined result identity', () => {
  it.each([
    {
      name: 'custom node label wins over the referenced child-flow name',
      label: 'Research specialist',
      childFlowName: 'Research flow',
      legacyName: 'Legacy',
      expectedWho: 'sub-agent "Research specialist"',
    },
    {
      name: 'the default node label still wins over the referenced child-flow name',
      label: 'Subflow Node',
      childFlowName: 'Research flow',
      legacyName: 'Legacy',
      expectedWho: 'sub-agent "Subflow Node"',
    },
    {
      name: 'a child-flow name wins when the node label is blank',
      label: '   ',
      childFlowName: 'Research flow',
      legacyName: 'Legacy',
      expectedWho: 'sub-agent "Research flow"',
    },
    {
      name: 'the legacy name wins when higher-priority names are blank',
      label: '',
      childFlowName: '  ',
      legacyName: 'Legacy',
      expectedWho: 'sub-agent "Legacy"',
    },
    {
      name: 'the unquoted fallback is used when no name is usable',
      label: ' ',
      childFlowName: '\t',
      legacyName: '',
      expectedWho: 'the sub-agent',
    },
  ])('$name', async ({ label, childFlowName, legacyName, expectedWho }) => {
    const node = makeNode();
    const shared = makeShared();
    const rawResult = 'RAW_CHILD_RESULT';

    const action = await node.post(
      makePrep({ subflowName: childFlowName, resultPresentation: 'joined' }),
      makeExec(rawResult),
      shared,
      makeParams(label, legacyName),
    );

    expect(action).toBe('NEXT');
    expect(shared.messages).toHaveLength(1);
    const framed = String(shared.messages[0].content);
    expect(framed).toContain(`[↩ Returned result from ${expectedWho} —`);
    expect(framed).toContain(rawResult);
    expect(shared.lastResponse).toBe(rawResult);
    if (expectedWho === 'the sub-agent') {
      expect(framed).not.toContain('"the sub-agent"');
    }
  });
});

describe('SubflowNode separate result identity', () => {
  it('uses child-flow identity first and includes a distinct lane title exactly once', async () => {
    const node = makeNode();
    const shared = makeShared();
    const lanes: SubflowLaneResult[] = [
      {
        subflowId: 'child-a',
        subflowName: 'Child Alpha',
        laneTitle: 'Research',
        success: true,
        outputText: 'RESULT_A',
      },
      {
        subflowId: 'child-b',
        subflowName: 'Same name',
        laneTitle: 'Same name',
        success: true,
        outputText: 'RESULT_B',
      },
      {
        subflowId: 'child-c',
        subflowName: '   ',
        laneTitle: '  Fallback lane  ',
        success: true,
        outputText: 'RESULT_C',
      },
    ];

    await node.post(
      makePrep({ resultPresentation: 'separate', subflowName: 'Aggregate child' }),
      makeExec('RESULT_A\n\nRESULT_B\n\nRESULT_C', lanes),
      shared,
      makeParams('Node label', 'Legacy'),
    );

    expect(shared.messages).toHaveLength(3);
    const framed = shared.messages.map((message) => String(message.content));
    expect(framed[0]).toContain('sub-agent "Child Alpha" (Research)');
    expect(framed[0].match(/\(Research\)/g)).toHaveLength(1);
    expect(framed[1]).toContain('sub-agent "Same name" —');
    expect(framed[1]).not.toContain('(Same name)');
    expect(framed[2]).toContain('sub-agent "Fallback lane" —');
    expect(framed[2]).not.toContain('(Fallback lane)');
    expect(framed.map((message) => message.split('\n\n').at(-1))).toEqual([
      'RESULT_A',
      'RESULT_B',
      'RESULT_C',
    ]);
    expect(shared.lastResponse).toBe('RESULT_A\n\nRESULT_B\n\nRESULT_C');
  });

  it.each([
    {
      name: 'blank lane identities fall through to the node label',
      label: 'Node label',
      aggregateName: 'Aggregate child',
      legacyName: 'Legacy',
      expectedWho: 'sub-agent "Node label"',
    },
    {
      name: 'blank lane and node identities fall through to the aggregate child-flow name',
      label: ' ',
      aggregateName: 'Aggregate child',
      legacyName: 'Legacy',
      expectedWho: 'sub-agent "Aggregate child"',
    },
    {
      name: 'blank lane, node, and aggregate identities fall through to the legacy name',
      label: '',
      aggregateName: '\t',
      legacyName: 'Legacy',
      expectedWho: 'sub-agent "Legacy"',
    },
    {
      name: 'blank identities use the unquoted fallback',
      label: ' ',
      aggregateName: '',
      legacyName: '  ',
      expectedWho: 'the sub-agent',
    },
  ])('$name', async ({ label, aggregateName, legacyName, expectedWho }) => {
    const node = makeNode();
    const shared = makeShared();
    const lanes: SubflowLaneResult[] = [0, 1].map((index) => ({
      subflowId: `child-${index}`,
      subflowName: '   ',
      laneTitle: '\t',
      success: true,
      outputText: `RESULT_${index}`,
    }));

    await node.post(
      makePrep({ resultPresentation: 'separate', subflowName: aggregateName }),
      makeExec('RESULT_0\n\nRESULT_1', lanes),
      shared,
      makeParams(label, legacyName),
    );

    expect(shared.messages).toHaveLength(2);
    expect(String(shared.messages[0].content)).toContain(`${expectedWho} (Lane 1)`);
    expect(String(shared.messages[1].content)).toContain(`${expectedWho} (Lane 2)`);
    expect(shared.lastResponse).toBe('RESULT_0\n\nRESULT_1');
    if (expectedWho === 'the sub-agent') {
      expect(shared.messages.map((message) => String(message.content)).join('\n'))
        .not.toContain('"the sub-agent"');
    }
  });
});
