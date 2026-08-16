import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { mockUseAskFlujo, mockUseAskFlujoPage } from '@/frontend/__tests__/mocks/askFlujoContext';
import MCPNodePropertiesModal from '@/frontend/components/Flow/FlowManager/FlowBuilder/Modals/MCPNodePropertiesModal';
import { useServerStatus } from '@/frontend/hooks/useServerStatus';
import { useServerTools } from '@/frontend/hooks/useServerTools';

jest.mock('@/frontend/contexts/AskFlujoContext', () => ({
  useAskFlujo: mockUseAskFlujo,
  useAskFlujoPage: mockUseAskFlujoPage,
}));
jest.mock('@/frontend/hooks/useServerStatus', () => ({ useServerStatus: jest.fn() }));
jest.mock('@/frontend/hooks/useServerTools', () => ({ useServerTools: jest.fn() }));
jest.mock('@/frontend/hooks/useCardPicker', () => ({
  useCardPicker: (_kind: string, items: unknown[]) => ({
    items,
    groups: null,
    searchTerm: '',
    setSearchTerm: jest.fn(),
    collapsedKeys: new Set<string>(),
    toggleGroup: jest.fn(),
  }),
}));
jest.mock('@/frontend/components/mcp/MCPServerManager/ServerCard', () => ({
  __esModule: true,
  default: ({ name, selected, onClick }: { name: string; selected: boolean; onClick: () => void }) => (
    <button type="button" aria-pressed={selected} onClick={onClick}>Server card {name}</button>
  ),
}));
jest.mock('@/frontend/components/mcp/MCPServerManager/Modals/ServerModal/tabs/ConfigureTab/RootsManager', () => ({
  __esModule: true,
  default: () => <div>Workspace folders</div>,
}));

const mockUseServerStatus = useServerStatus as jest.MockedFunction<typeof useServerStatus>;
const mockUseServerTools = useServerTools as jest.MockedFunction<typeof useServerTools>;

const tools = [
  {
    name: 'read_record',
    title: 'Read a record',
    description: 'Retrieve one record.',
    inputSchema: { type: 'object' as const, properties: { id: { type: 'string' } }, required: ['id'] },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'delete_record',
    description: 'Delete one record.',
    inputSchema: { type: 'object' as const },
    outputSchema: { type: 'object' as const, properties: { deleted: { type: 'boolean' } } },
    annotations: { destructiveHint: true, openWorldHint: true },
    execution: { taskSupport: 'optional' as const },
    _meta: { ui: { resourceUri: 'ui://delete-record' } },
  },
  {
    name: 'create_record',
    description: 'Create one record.',
    inputSchema: { type: 'object' as const },
    annotations: { destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'legacy_tool',
    description: 'Has no behavior annotations.',
    inputSchema: { type: 'object' as const },
  },
];

const node = {
  id: 'mcp-one',
  type: 'mcp',
  position: { x: 0, y: 0 },
  data: {
    label: 'Records',
    type: 'mcp',
    properties: { boundServer: 'records', enabledTools: ['read_record'] },
  },
} as any;

const renderModal = (overrides: Partial<React.ComponentProps<typeof MCPNodePropertiesModal>> = {}) => {
  const props = {
    open: true,
    node,
    onClose: jest.fn(),
    onSave: jest.fn(),
    ...overrides,
  };
  return { ...render(<MCPNodePropertiesModal {...props} />), props };
};

beforeEach(() => {
  jest.clearAllMocks();
  mockUseServerStatus.mockReturnValue({
    servers: [
      { name: 'records', status: 'connected', transport: 'stdio' },
      { name: 'search', status: 'connected', transport: 'stdio' },
    ],
    isLoading: false,
    loadError: null,
    retryServer: jest.fn(),
  } as any);
  mockUseServerTools.mockReturnValue({
    tools,
    toolsServerName: 'records',
    isLoading: false,
    error: null,
    loadTools: jest.fn(),
  } as any);
});

describe('MCPNodePropertiesModal', () => {
  it('uses a large desktop split with servers on the left and behavior-grouped tools on the right', () => {
    renderModal();

    expect(screen.getByTestId('mcp-desktop-split')).toBeInTheDocument();
    expect(screen.getByTestId('mcp-server-pane')).toContainElement(screen.getByRole('button', { name: 'Server card records' }));
    expect(screen.getByTestId('mcp-tools-pane')).toHaveTextContent('Read-only tools');
    expect(screen.getByTestId('mcp-tools-pane')).toHaveTextContent('May make destructive changes');
    expect(screen.getByTestId('mcp-tools-pane')).toHaveTextContent('Other tools that make changes');
    expect(screen.getByText('Read a record')).toBeInTheDocument();
    expect(screen.queryByText('read_record')).not.toBeInTheDocument();
  });

  it('activates and deactivates every available tool', async () => {
    const onSave = jest.fn();
    renderModal({ onSave });

    fireEvent.click(screen.getByRole('button', { name: 'Activate all' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(
      'mcp-one',
      expect.objectContaining({ properties: expect.objectContaining({ enabledTools: tools.map((tool) => tool.name) }) }),
    ));

    onSave.mockClear();
    renderModal({ onSave });
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate all' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Save changes' }).at(-1)!);
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(
      'mcp-one',
      expect.objectContaining({ properties: expect.objectContaining({ enabledTools: [] }) }),
    ));
  });

  it('keeps schemas and raw protocol fields inside technical disclosure', () => {
    renderModal();

    expect(screen.queryByText('Programmatic name')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show technical details for Read a record' }));
    expect(screen.getByText('Programmatic name')).toBeInTheDocument();
    expect(screen.getByText('read_record')).toBeInTheDocument();
    expect(screen.getByText('Input schema')).toBeInTheDocument();
  });

  it('initializes a newly selected server from that server’s loaded tool list', async () => {
    const onSave = jest.fn();
    mockUseServerTools.mockImplementation((serverName) => ({
      tools: serverName === 'search'
        ? [{ name: 'web_search', description: 'Search the web.', inputSchema: { type: 'object' } }]
        : tools,
      toolsServerName: serverName,
      isLoading: false,
      error: null,
      loadTools: jest.fn(),
    }) as any);
    renderModal({ onSave });

    fireEvent.click(screen.getByRole('button', { name: 'Server card search' }));
    await waitFor(() => expect(screen.getByText('1 of 1 active')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(onSave).toHaveBeenCalledWith(
      'mcp-one',
      expect.objectContaining({
        properties: expect.objectContaining({ boundServer: 'search', enabledTools: ['web_search'] }),
      }),
    );
  });

  it('replaces inline server cards with a subflow-style picker on compact screens', () => {
    const previousMatchMedia = window.matchMedia;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: jest.fn().mockImplementation((query: string) => ({
        matches: query.includes('max-width:899.95px') || query.includes('max-width:599.95px'),
        media: query,
        onchange: null,
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        addListener: jest.fn(),
        removeListener: jest.fn(),
        dispatchEvent: jest.fn(),
      })),
    });
    try {
      renderModal();
      const tabs = screen.getByRole('tablist', { name: 'MCP node' });
      expect(within(tabs).getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
        'Connect to an MCP server',
        'Allowed tools',
        'Settings',
      ]);

      fireEvent.click(within(tabs).getByRole('tab', { name: 'Connect to an MCP server' }));
      expect(screen.getByTestId('mcp-compact-server-picker')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Server card records' })).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /records/ }));
      expect(screen.getByRole('dialog', { name: 'Connect to an MCP server' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Server card records' })).toBeInTheDocument();
    } finally {
      Object.defineProperty(window, 'matchMedia', { configurable: true, value: previousMatchMedia });
    }
  });
});
