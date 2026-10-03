import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ToolManager from '@/frontend/components/mcp/MCPToolManager';
import { mcpService } from '@/frontend/services/mcp';

jest.mock('@/frontend/services/mcp', () => ({
  mcpService: { listServerTools: jest.fn(), clearToolsCache: jest.fn(), callTool: jest.fn() },
}));
jest.mock('@/frontend/contexts/I18nContext', () => ({
  useI18n: () => ({ t: (key: string) => key, formatNumber: String }),
}));
jest.mock('@/frontend/contexts/StorageContext', () => ({
  useStorage: () => ({ globalEnvVars: {}, settings: { experimental: {} } }),
}));
jest.mock('@/frontend/utils/theme', () => ({
  useThemeUtils: () => ({ getThemeValue: (light: string) => light }),
}));
jest.mock('react-markdown', () => ({
  __esModule: true, default: ({ children }: { children: string }) => <>{children}</>,
}));
jest.mock('remark-gfm', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('@/utils/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));
const mockAppMount = jest.fn();
const mockAppUnmount = jest.fn();
jest.mock('@/frontend/components/Chat/McpAppFrame', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    __esModule: true,
    default: function MockAppFrame() {
      React.useEffect(() => {
        mockAppMount();
        return () => { mockAppUnmount(); };
      }, []);
      return <div data-testid="mcp-app-frame" />;
    },
  };
});

const fixtureTools = () => Array.from({ length: 128 }, (_, index) => ({
  name: `fixture_tool_${String(index + 1).padStart(3, '0')}`,
  description: 'A local acceptance fixture',
  inputSchema: {
    type: 'object' as const,
    required: ['url'],
    properties: { url: { type: 'string' }, options: { type: 'object' } },
  },
  _meta: { ui: { resourceUri: 'ui://fixture' } },
}));
const prefill = { toolName: 'fixture_tool_128', arguments: { url: 'https://example.test', options: { depth: 1 } } };
type ToolListResult = Awaited<ReturnType<typeof mcpService.listServerTools>>;
const mockList = mcpService.listServerTools as jest.MockedFunction<typeof mcpService.listServerTools>;

describe('MCP manager, discovery hook and real complex form', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockList.mockResolvedValue({ tools: fixtureTools() });
    (mcpService.callTool as jest.Mock).mockResolvedValue({
      success: true, data: { content: [{ type: 'text', text: 'fixture result' }] },
    });
  });

  it.each(['success', 'API error', 'thrown error'] as const)(
    'retains edited fields, result and App frame during and after a refresh: %s',
    async (outcome) => {
      let resolve!: (value: ToolListResult) => void;
      let reject!: (reason: Error) => void;
      const refresh = new Promise<ToolListResult>((res, rej) => { resolve = res; reject = rej; });
      render(<ToolManager serverName="fixture" prefill={prefill} />);
      const options = await screen.findByRole('textbox', { name: 'options (JSON object)' });
      const url = screen.getByRole('textbox', { name: 'url *' });
      fireEvent.change(options, { target: { value: '{"depth":2}' } });
      expect(mcpService.callTool).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'mcp.tester.test' }));
      await screen.findByText('fixture result');
      const app = screen.getByTestId('mcp-app-frame');
      expect(mcpService.callTool).toHaveBeenCalledWith('fixture', 'fixture_tool_128', {
        url: 'https://example.test', options: { depth: 2 },
      }, 60);

      // An unfinished JSON draft must survive too, without replacing the last
      // valid typed argument or causing an implicit invocation.
      fireEvent.change(options, { target: { value: '{"depth":' } });
      mockList.mockImplementationOnce(() => refresh);
      fireEvent.click(screen.getByRole('button', { name: 'mcp.tools.refresh' }));
      await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2));
      expect(screen.getByRole('textbox', { name: 'options (JSON object)' })).toBe(options);
      expect(options).toHaveValue('{"depth":');
      expect(screen.getByRole('textbox', { name: 'url *' })).toBe(url);
      expect(screen.getByTestId('mcp-app-frame')).toBe(app);

      await act(async () => {
        if (outcome === 'success') resolve({ tools: fixtureTools() });
        else if (outcome === 'API error') resolve({ tools: [], error: 'discovery failed' });
        else reject(new Error('connection lost'));
      });
      await waitFor(() => expect(screen.getByRole('button', { name: 'mcp.tools.refresh' })).toBeEnabled());
      expect(screen.getByRole('textbox', { name: 'options (JSON object)' })).toBe(options);
      expect(options).toHaveValue('{"depth":');
      expect(screen.getByText('fixture result')).toBeInTheDocument();
      expect(screen.getByTestId('mcp-app-frame')).toBe(app);
      expect(mockAppMount).toHaveBeenCalledTimes(1);
      expect(mockAppUnmount).not.toHaveBeenCalled();
      expect(mcpService.callTool).toHaveBeenCalledTimes(1);
      expect(mcpService.clearToolsCache).toHaveBeenCalledWith('fixture');
    },
  );

  it('makes all 128 tools selectable, including the final tool, without invoking one', async () => {
    render(<ToolManager serverName="fixture" />);
    const selector = await screen.findByRole('combobox', { name: 'mcp.tester.select' });
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(1));
    fireEvent.mouseDown(selector);
    const options = await screen.findAllByRole('option');
    expect(options).toHaveLength(129); // 128 tools plus the choose placeholder.
    expect(options.slice(1).map((option) => option.textContent)).toEqual(fixtureTools().map((tool) => tool.name));
    fireEvent.click(screen.getByRole('option', { name: 'fixture_tool_128' }));
    expect(selector).toHaveTextContent('fixture_tool_128');
    expect(screen.getByRole('textbox', { name: 'options (JSON object)' })).toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: 'mcp.tester.timeout' })).toBeInTheDocument();
    expect(mcpService.callTool).not.toHaveBeenCalled();
  });

  it('clears the previous server form and result when switching to a server with the same tool names', async () => {
    const view = render(<ToolManager serverName="A" prefill={prefill} />);
    await screen.findByRole('textbox', { name: 'options (JSON object)' });
    fireEvent.click(screen.getByRole('button', { name: 'mcp.tester.test' }));
    await screen.findByText('fixture result');
    view.rerender(<ToolManager serverName="B" />);
    await waitFor(() => expect(mockList).toHaveBeenCalledWith('B'));
    expect(screen.queryByText('fixture result')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mcp-app-frame')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'options (JSON object)' })).not.toBeInTheDocument();
  });
});
