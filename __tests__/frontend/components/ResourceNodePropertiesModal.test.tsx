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
