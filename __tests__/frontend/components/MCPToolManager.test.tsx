import { fireEvent, render, screen } from '@testing-library/react';
import ToolManager from '@/frontend/components/mcp/MCPToolManager';
import { useServerTools } from '@/frontend/hooks/useServerTools';

jest.mock('@/frontend/hooks/useServerTools', () => ({
  useServerTools: jest.fn(),
}));

jest.mock('@/frontend/components/mcp/MCPToolManager/ToolTester', () => ({
  __esModule: true,
  default: () => <div data-testid="tool-tester" />,
}));

jest.mock('@/frontend/contexts/I18nContext', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    formatNumber: (value: number) => String(value),
  }),
}));

jest.mock('@/frontend/utils/theme', () => ({
  useThemeUtils: () => ({ getThemeValue: (light: string) => light }),
}));

jest.mock('@/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

const mockUseServerTools = useServerTools as jest.MockedFunction<typeof useServerTools>;

describe('MCPToolManager refresh lifecycle', () => {
  const loadTools = jest.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    jest.clearAllMocks();
    mockUseServerTools.mockReturnValue({
      tools: [{ name: 'search', description: '', inputSchema: { type: 'object' } }],
      toolsServerName: 'records',
      isLoading: false,
      error: null,
      loadTools,
      retryLoadTools: jest.fn(),
      isRetrying: false,
      retryCount: 0,
      testTool: jest.fn(),
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('does not refresh tools on a timer', () => {
    jest.useFakeTimers();
    render(<ToolManager serverName="records" />);

    jest.advanceTimersByTime(120_000);

    expect(screen.getByTestId('tool-tester')).toBeInTheDocument();
    expect(loadTools).not.toHaveBeenCalled();
  });

  it('refreshes tools only when the user requests it', () => {
    render(<ToolManager serverName="records" />);

    fireEvent.click(screen.getByRole('button', { name: 'mcp.tools.refresh' }));

    expect(loadTools).toHaveBeenCalledTimes(1);
    expect(loadTools).toHaveBeenCalledWith(true);
  });
});
