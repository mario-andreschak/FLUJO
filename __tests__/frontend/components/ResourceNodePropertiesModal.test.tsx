/**
 * Component tests for the Resource Node properties modal (issue #183).
 *
 * Covers the UX refinements that are deterministically checkable under jsdom:
 *  - item 2: a NEW resource node defaults to the run-scoped "Temporary Data" type;
 *  - item 3: the run-scoped type is labelled "Temporary Data" (not "Run artifact");
 *  - item 1: Name/Description live behind a collapsed "Advanced" disclosure;
 *  - item 4: the name field auto-suggests ${res:NAME} names used elsewhere in the flow.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import ResourceNodePropertiesModal from '@/frontend/components/Flow/FlowManager/FlowBuilder/Modals/ResourceNodePropertiesModal';

// The modal reads live MCP server status and (in mcp scope) browses resources.
// Neither is relevant to these run-scope UX assertions — stub them out.
jest.mock('@/frontend/hooks/useServerStatus', () => ({
  useServerStatus: () => ({ servers: [], isLoading: false }),
}));
jest.mock('@/frontend/services/mcp', () => ({
  mcpService: { listServerResources: jest.fn().mockResolvedValue({ resources: [], resourceTemplates: [] }) },
}));

const freshNode: any = {
  id: 'r1',
  type: 'resource',
  position: { x: 0, y: 0 },
  data: { label: 'Resource Node', type: 'resource', properties: {} },
};

// A sibling process node whose prompt template references two run resources.
const flowNodes: any[] = [
  freshNode,
  {
    id: 'p1',
    type: 'process',
    position: { x: 10, y: 10 },
    data: { label: 'Step', type: 'process', properties: { promptTemplate: 'See ${res:summary} and ${res:draft}.' } },
  },
];

const renderModal = () =>
  render(
    <ResourceNodePropertiesModal
      open
      node={freshNode}
      onClose={() => {}}
      onSave={() => {}}
      flowNodes={flowNodes}
    />
  );

describe('ResourceNodePropertiesModal', () => {
  it('defaults a new node to the run-scoped "Temporary Data" type', () => {
    renderModal();
    const temp = screen.getByRole('radio', { name: 'Temporary Data' });
    const mcp = screen.getByRole('radio', { name: 'MCP resource' });
    expect(temp).toBeChecked();
    expect(mcp).not.toBeChecked();
    // The run-scope field uses the renamed label.
    expect(screen.getByLabelText('Temporary Data name')).toBeInTheDocument();
    // The old wording is gone.
    expect(screen.queryByText('Run artifact')).not.toBeInTheDocument();
  });

  it('hides Label/Description behind a collapsed Advanced disclosure', () => {
    renderModal();
    // Collapsed by default for a fresh node.
    expect(screen.queryByLabelText('Label')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Description')).not.toBeInTheDocument();
    // Reveal it.
    fireEvent.click(screen.getByRole('button', { name: /Advanced/i }));
    expect(screen.getByLabelText('Label')).toBeInTheDocument();
    expect(screen.getByLabelText('Description')).toBeInTheDocument();
  });

  it('auto-suggests ${res:NAME} names referenced elsewhere in the flow', () => {
    renderModal();
    const input = screen.getByLabelText('Temporary Data name');
    // Typing opens the freeSolo listbox and filters to the matching suggestion,
    // proving the options came from the sibling node's ${res:...} references.
    fireEvent.change(input, { target: { value: 'sum' } });
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options).toContain('summary');
  });
});

// --- #205 coverage top-up: MCP-scope reveal + save persistence / label fallback ---

const makeNode = (label: string, properties: Record<string, any> = {}): any => ({
  id: 'r1',
  type: 'resource',
  position: { x: 0, y: 0 },
  data: { label, type: 'resource', properties },
});

const renderNode = (node: any, onSave = jest.fn()) => {
  render(
    <ResourceNodePropertiesModal
      open
      node={node}
      onClose={() => {}}
      onSave={onSave}
      flowNodes={[node]}
    />
  );
  return onSave;
};

describe('ResourceNodePropertiesModal — scope reveal', () => {
  it('switching to MCP scope reveals the server/URI fields and hides the run-scope field', () => {
    renderNode(makeNode('Resource Node'));
    // Run-scope field is present initially, mcp-only field is not.
    expect(screen.getByLabelText('Temporary Data name')).toBeInTheDocument();
    expect(screen.queryByLabelText('Resource URI')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: 'MCP resource' }));

    // MCP fields appear; the run-scope name field is gone.
    expect(screen.getByLabelText('Resource URI')).toBeInTheDocument();
    expect(screen.queryByLabelText('Temporary Data name')).not.toBeInTheDocument();
  });
});

describe('ResourceNodePropertiesModal — save persistence', () => {
  it('persists only the run scope, dropping stale MCP bindings', () => {
    const onSave = renderNode(makeNode('Resource Node', { scope: 'run', runName: 'summary', boundServer: 'srv', uri: 'file:///x' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    const [, data] = onSave.mock.calls[0];
    expect(data.properties.scope).toBe('run');
    expect(data.properties.runName).toBe('summary');
    expect(data.properties.boundServer).toBeUndefined();
    expect(data.properties.uri).toBeUndefined();
  });

  it('persists only the MCP scope, dropping the stale run name', () => {
    const onSave = renderNode(makeNode('Resource Node', { scope: 'mcp', runName: 'stale', boundServer: 'srv', uri: 'file:///x' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    const [, data] = onSave.mock.calls[0];
    expect(data.properties.scope).toBe('mcp');
    expect(data.properties.runName).toBeUndefined();
    expect(data.properties.boundServer).toBe('srv');
    expect(data.properties.uri).toBe('file:///x');
  });

  it('falls back the label to the run name when no custom label is set', () => {
    // Empty label so the fallback path runs (the default "Resource Node" would be kept verbatim).
    const onSave = renderNode(makeNode('', { scope: 'run', runName: 'draft' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave.mock.calls[0][1].label).toBe('draft');
  });

  it('falls back the label to "Temporary Data" when neither label nor run name is set', () => {
    const onSave = renderNode(makeNode('', { scope: 'run' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave.mock.calls[0][1].label).toBe('Temporary Data');
  });

  it('falls back the label to "MCP resource" in MCP scope with no custom label', () => {
    const onSave = renderNode(makeNode('', { scope: 'mcp', boundServer: 'srv' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave.mock.calls[0][1].label).toBe('MCP resource');
  });
});
