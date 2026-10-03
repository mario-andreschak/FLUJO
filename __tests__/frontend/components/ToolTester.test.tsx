import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ToolTester, { type ToolTesterPrefill } from '@/frontend/components/mcp/MCPToolManager/ToolTester';

jest.mock('@/frontend/contexts/I18nContext', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    formatNumber: (value: number) => String(value),
  }),
}));

jest.mock('@/frontend/contexts/StorageContext', () => ({
  useStorage: () => ({
    globalEnvVars: {},
    settings: { experimental: {} },
  }),
}));

jest.mock('@/frontend/utils/theme', () => ({
  useThemeUtils: () => ({ getThemeValue: (light: string) => light }),
}));

jest.mock('@/frontend/components/Chat/McpAppFrame', () => () => null);

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: string }) => <>{children}</>,
}));

jest.mock('remark-gfm', () => ({ __esModule: true, default: jest.fn() }));

jest.mock('@/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

const complexTool = () => ({
  name: 'firecrawl_scrape',
  description: 'Scrape a page',
  inputSchema: {
    type: 'object',
    required: ['url'],
    properties: {
      url: { type: 'string', description: 'Page URL' },
      options: { type: 'object', description: 'Scrape options' },
    },
  },
});

describe('ToolTester complex parameter lifecycle', () => {
  it('preserves edited arguments across equivalent tool refreshes and invokes only after Test', async () => {
    const onTestTool = jest.fn().mockResolvedValue({ success: true, output: 'ok' });
    const prefill: ToolTesterPrefill = {
      toolName: 'firecrawl_scrape',
      arguments: {
        url: 'https://example.com',
        options: { depth: 1 },
      },
    };
    const view = render(
      <ToolTester
        serverName="firecrawl"
        tools={[complexTool()]}
        onTestTool={onTestTool}
        prefill={prefill}
      />,
    );

    const options = await screen.findByRole('textbox', { name: 'options (JSON object)' });
    expect(screen.getByRole('textbox', { name: 'url *' })).toHaveTextContent('https://example.com');
    expect(options).toHaveValue(JSON.stringify({ depth: 1 }, null, 2));
    expect(onTestTool).not.toHaveBeenCalled();

    fireEvent.change(options, { target: { value: '{"depth":2}' } });
    expect(options).toHaveValue('{"depth":2}');

    view.rerender(
      <ToolTester
        serverName="firecrawl"
        tools={[complexTool()]}
        onTestTool={onTestTool}
        prefill={prefill}
      />,
    );

    expect(screen.getByRole('textbox', { name: 'options (JSON object)' })).toHaveValue('{"depth":2}');
    expect(onTestTool).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'mcp.tester.test' }));

    await waitFor(() => expect(onTestTool).toHaveBeenCalledWith(
      'firecrawl_scrape',
      { url: 'https://example.com', options: { depth: 2 } },
      60,
    ));
  });

  it('applies a new explicit prefill request even when it targets the same tool', async () => {
    const onTestTool = jest.fn().mockResolvedValue({ success: true, output: 'ok' });
    const firstPrefill: ToolTesterPrefill = {
      toolName: 'firecrawl_scrape',
      arguments: { options: { depth: 1 } },
    };
    const view = render(
      <ToolTester
        serverName="firecrawl"
        tools={[complexTool()]}
        onTestTool={onTestTool}
        prefill={firstPrefill}
      />,
    );
    await screen.findByRole('textbox', { name: 'options (JSON object)' });

    view.rerender(
      <ToolTester
        serverName="firecrawl"
        tools={[complexTool()]}
        onTestTool={onTestTool}
        prefill={{ toolName: 'firecrawl_scrape', arguments: { options: { depth: 3 } } }}
      />,
    );

    await waitFor(() => expect(
      screen.getByRole('textbox', { name: 'options (JSON object)' }),
    ).toHaveValue(JSON.stringify({ depth: 3 }, null, 2)));
  });
});
