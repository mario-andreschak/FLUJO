import type { Edge } from '@xyflow/react';
import type { FlowNode } from '@/shared/types/flow';
import {
  migrateHandoffPills,
  findHandoffTargetIds,
} from '@/frontend/components/Flow/FlowManager/FlowBuilder/utils/handoffPillMigration';

// Issue #178 — renaming a handoff-target node must rewrite the handoff pills
// that reference it inside predecessor nodes' promptTemplates.

function node(
  id: string,
  label: string,
  type = 'process',
  promptTemplate?: string
): FlowNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    data: {
      label,
      type,
      properties: promptTemplate !== undefined ? { promptTemplate } : {},
    },
  } as FlowNode;
}

function edge(
  id: string,
  source: string,
  target: string,
  data?: Record<string, unknown>
): Edge {
  return { id, source, target, sourceHandle: 'a', targetHandle: 'b', data } as Edge;
}

/** Rename a single node's label in a copy of the node list. */
function rename(nodes: FlowNode[], id: string, newLabel: string): FlowNode[] {
  return nodes.map(n =>
    n.id === id ? { ...n, data: { ...n.data, label: newLabel } } : n
  );
}

const pill = (name: string) => `\${tool:handoff__${name}}`;

describe('findHandoffTargetIds', () => {
  it('collects outgoing non-attachment targets', () => {
    const edges = [edge('e1', 'A', 'B'), edge('e2', 'A', 'C')];
    expect(findHandoffTargetIds('A', edges)).toEqual(['B', 'C']);
  });

  it('ignores mcp and resource attachment edges', () => {
    const edges = [
      edge('e1', 'A', 'B'),
      edge('e2', 'A', 'M', { edgeType: 'mcpEdge' }),
      edge('e3', 'A', 'R', { edgeType: 'resource' }),
    ];
    expect(findHandoffTargetIds('A', edges)).toEqual(['B']);
  });

  it('treats a bidirectional edge pointing at the node as a handoff target', () => {
    const edges = [edge('e1', 'T', 'P', { bidirectional: true })];
    expect(findHandoffTargetIds('P', edges)).toEqual(['T']);
  });

  it('dedupes multiple routes to the same target', () => {
    const edges = [edge('e1', 'A', 'B'), edge('e2', 'A', 'B')];
    expect(findHandoffTargetIds('A', edges)).toEqual(['B']);
  });
});

describe('migrateHandoffPills', () => {
  it('rewrites the pill in a single predecessor when the target is renamed', () => {
    const prev = [
      node('A', 'Process A', 'process', `Go: ${pill('handoff_to_process_b')}`),
      node('B', 'Process B'),
    ];
    const next = rename(prev, 'B', 'second step');
    const out = migrateHandoffPills(prev, next, [edge('e', 'A', 'B')]);
    expect(out.find(n => n.id === 'A')!.data.properties!.promptTemplate).toBe(
      `Go: ${pill('handoff_to_second_step')}`
    );
  });

  it('leaves prompts untouched when the renamed target has no predecessor pill', () => {
    const prev = [
      node('A', 'Process A', 'process', 'No pills here.'),
      node('B', 'Process B'),
    ];
    const next = rename(prev, 'B', 'second step');
    const out = migrateHandoffPills(prev, next, [edge('e', 'A', 'B')]);
    expect(out.find(n => n.id === 'A')!.data.properties!.promptTemplate).toBe(
      'No pills here.'
    );
  });

  it('returns nextNodes unchanged when no label changed', () => {
    const prev = [
      node('A', 'Process A', 'process', `Go: ${pill('handoff_to_process_b')}`),
      node('B', 'Process B'),
    ];
    // Same labels, only a property tweak elsewhere.
    const next = prev.map(n => ({ ...n }));
    const out = migrateHandoffPills(prev, next, [edge('e', 'A', 'B')]);
    expect(out).toBe(next);
  });

  it('updates every predecessor on fan-in', () => {
    const prev = [
      node('A', 'A', 'process', `${pill('handoff_to_target')}`),
      node('B', 'B', 'process', `also ${pill('handoff_to_target')}`),
      node('T', 'Target'),
    ];
    const next = rename(prev, 'T', 'Renamed Target');
    const out = migrateHandoffPills(prev, next, [
      edge('e1', 'A', 'T'),
      edge('e2', 'B', 'T'),
    ]);
    expect(out.find(n => n.id === 'A')!.data.properties!.promptTemplate).toBe(
      pill('handoff_to_renamed_target')
    );
    expect(out.find(n => n.id === 'B')!.data.properties!.promptTemplate).toBe(
      `also ${pill('handoff_to_renamed_target')}`
    );
  });

  it('updates a predecessor connected by a bidirectional edge', () => {
    const prev = [
      node('P', 'P', 'process', `${pill('handoff_to_target')}`),
      node('T', 'Target'),
    ];
    const next = rename(prev, 'T', 'New Target');
    // Bidirectional edge T <-> P: T is a handoff target of P.
    const out = migrateHandoffPills(prev, next, [
      edge('e', 'T', 'P', { bidirectional: true }),
    ]);
    expect(out.find(n => n.id === 'P')!.data.properties!.promptTemplate).toBe(
      pill('handoff_to_new_target')
    );
  });

  it('recomputes collision suffixes consistently when a rename causes a clash', () => {
    const prev = [
      node(
        'P',
        'P',
        'process',
        `${pill('handoff_to_alpha')} and ${pill('handoff_to_beta')}`
      ),
      node('A', 'Alpha'),
      node('B', 'Beta'),
    ];
    // Rename Alpha -> "Beta": now both targets slug to "beta". Target order
    // (A before B) gives A=handoff_to_beta, B=handoff_to_beta_2.
    const next = rename(prev, 'A', 'Beta');
    const out = migrateHandoffPills(prev, next, [
      edge('e1', 'P', 'A'),
      edge('e2', 'P', 'B'),
    ]);
    expect(out.find(n => n.id === 'P')!.data.properties!.promptTemplate).toBe(
      `${pill('handoff_to_beta')} and ${pill('handoff_to_beta_2')}`
    );
  });

  it('normalizes a legacy-format handoff pill to canonical form on rewrite', () => {
    const legacy = '${_-_-_handoff_-_-_handoff_to_process_b}';
    const prev = [
      node('A', 'A', 'process', `Legacy: ${legacy}`),
      node('B', 'Process B'),
    ];
    const next = rename(prev, 'B', 'second step');
    const out = migrateHandoffPills(prev, next, [edge('e', 'A', 'B')]);
    expect(out.find(n => n.id === 'A')!.data.properties!.promptTemplate).toBe(
      `Legacy: ${pill('handoff_to_second_step')}`
    );
  });

  it('leaves non-handoff pills untouched', () => {
    const prev = [
      node(
        'A',
        'A',
        'process',
        `${pill('handoff_to_process_b')} keep \${tool:filesystem__read_file} and \${resource:files__file:///x}`
      ),
      node('B', 'Process B'),
    ];
    const next = rename(prev, 'B', 'second step');
    const out = migrateHandoffPills(prev, next, [edge('e', 'A', 'B')]);
    expect(out.find(n => n.id === 'A')!.data.properties!.promptTemplate).toBe(
      `${pill('handoff_to_second_step')} keep \${tool:filesystem__read_file} and \${resource:files__file:///x}`
    );
  });

  it('does not treat mcp attachment targets as handoff targets', () => {
    const prev = [
      node('A', 'A', 'process', `${pill('handoff_to_mcp_server')}`),
      node('M', 'MCP Server', 'mcp'),
    ];
    const next = rename(prev, 'M', 'Renamed Server');
    const out = migrateHandoffPills(prev, next, [
      edge('e', 'A', 'M', { edgeType: 'mcpEdge' }),
    ]);
    // M is reached only by an attachment edge, so it is not a handoff target;
    // the pill (whatever it is) must be left alone.
    expect(out.find(n => n.id === 'A')!.data.properties!.promptTemplate).toBe(
      pill('handoff_to_mcp_server')
    );
  });
});
