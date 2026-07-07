import {
  formatHandoffDescription,
  HandoffNodeSummary,
  MAX_HANDOFF_DESCRIPTION_CHARS,
  MAX_TOOLS_LISTED_PER_SERVER,
} from '@/shared/utils/handoffDescription';

// Richer handoff-tool descriptions (issue #38, Item A).
describe('formatHandoffDescription', () => {
  it('renders a header for a bare node', () => {
    const out = formatHandoffDescription({ label: 'Finish Node', type: 'finish' });
    expect(out).toBe('Hand off execution to Finish Node (finish).');
  });

  it('folds in a Process node model, role and MCP tools', () => {
    const summary: HandoffNodeSummary = {
      label: 'Researcher',
      type: 'process',
      modelName: 'Claude (opus)',
      promptSummary: 'You research topics thoroughly and cite sources.',
      servers: [{ name: 'brave-search', connected: true, tools: ['search', 'fetch'] }],
    };
    const out = formatHandoffDescription(summary);
    expect(out).toContain('Hand off execution to Researcher (process).');
    expect(out).toContain('Model: Claude (opus)');
    expect(out).toContain('Role: You research topics');
    expect(out).toContain('Tools (brave-search): search, fetch');
  });

  it('lists an offline server by name only', () => {
    const out = formatHandoffDescription({
      label: 'Worker',
      type: 'process',
      servers: [{ name: 'github', connected: false }],
    });
    expect(out).toContain('Tools (github): server not connected');
  });

  it('caps the number of tools listed per server and notes the remainder', () => {
    const tools = Array.from({ length: MAX_TOOLS_LISTED_PER_SERVER + 5 }, (_, i) => `t${i}`);
    const out = formatHandoffDescription({
      label: 'Worker',
      type: 'process',
      servers: [{ name: 'big', connected: true, tools }],
    });
    expect(out).toContain('+5 more');
    expect(out).toContain('t0');
    expect(out).not.toContain('t10,'); // the 11th tool is not listed inline
  });

  it('recursively summarises a subflow target', () => {
    const summary: HandoffNodeSummary = {
      label: 'Pipeline',
      type: 'subflow',
      subflowName: 'Data Pipeline',
      children: [
        { label: 'Extractor', type: 'process', modelName: 'GPT-4o' },
        {
          label: 'Nested',
          type: 'subflow',
          subflowName: 'Inner',
          children: [{ label: 'Leaf', type: 'process', modelName: 'GPT-4o-mini' }],
        },
      ],
    };
    const out = formatHandoffDescription(summary);
    expect(out).toContain('Runs the subflow "Data Pipeline"');
    expect(out).toContain('Extractor');
    expect(out).toContain('Inner');
    expect(out).toContain('Leaf');
  });

  it('notes when the recursion depth cap was reached', () => {
    const out = formatHandoffDescription({
      label: 'Deep',
      type: 'subflow',
      subflowName: 'Deep Flow',
      depthCapReached: true,
    });
    expect(out).toContain('recursion depth limit reached');
  });

  it('notes when subflow contents are unavailable (preview)', () => {
    const out = formatHandoffDescription({
      label: 'Pipeline',
      type: 'subflow',
      subflowDetailsUnavailable: true,
    });
    expect(out).toContain('contents summarised when the flow runs');
  });

  it('uses a user-authored description verbatim and synthesises nothing', () => {
    const out = formatHandoffDescription({
      label: 'Researcher',
      type: 'process',
      userDescription: 'Delegate anything requiring web research to this agent.',
      modelName: 'Claude (opus)',
    });
    expect(out).toBe('Delegate anything requiring web research to this agent.');
    expect(out).not.toContain('Model:');
  });

  it('bounds the total description length', () => {
    const tools = Array.from({ length: 400 }, (_, i) => `tool_number_${i}`);
    const out = formatHandoffDescription({
      label: 'Huge',
      type: 'process',
      servers: Array.from({ length: 40 }, (_, i) => ({ name: `srv${i}`, connected: true, tools })),
    });
    expect(out.length).toBeLessThanOrEqual(MAX_HANDOFF_DESCRIPTION_CHARS);
    expect(out.startsWith('Hand off execution to Huge (process).')).toBe(true);
  });
});
