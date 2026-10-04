import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  it.each([true, false])('preserves prototype-like argument keys when schema coercion is %s', async withSchema => {
    const onTestTool = jest.fn().mockResolvedValue({ success: true, output: 'ok' });
    const argumentsData = JSON.parse('{"__proto__":{"marker":true},"constructor":"7","toString":"literal"}');
    const properties = Object.fromEntries([
      ['__proto__', { type: 'object' }],
      ['constructor', { type: 'integer' }],
      ['toString', { type: 'string' }],
    ]);
    render(<ToolTester serverName="data-boundary" tools={[{
      name: 'data_tool', description: 'Data boundary tool', inputSchema: withSchema ? { type: 'object', properties } : {},
    }]} onTestTool={onTestTool} prefill={{ toolName: 'data_tool', arguments: argumentsData }} />);
    await screen.findByRole('button', { name: 'mcp.tester.test' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'mcp.tester.test' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'mcp.tester.test' }));
    await waitFor(() => expect(onTestTool).toHaveBeenCalledTimes(1));
    const sent = onTestTool.mock.calls[0][1];
    expect(Object.getPrototypeOf(sent)).toBe(Object.prototype);
    expect(Object.hasOwn(sent, '__proto__')).toBe(true);
    expect(sent['__proto__']).toEqual({ marker: true });
    expect(sent.constructor).toBe(withSchema ? 7 : '7');
    expect(sent.toString).toBe('literal');
    expect(Object.hasOwn(Object.prototype, 'marker')).toBe(false);
  });
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
    const options = await screen.findByRole('textbox', { name: 'options (JSON object)' });
    fireEvent.change(options, { target: { value: '{"depth":2}' } });

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

  it('clears local JSON drafts when selecting a different tool with the same parameter name', async () => {
    const onTestTool = jest.fn().mockResolvedValue({ success: true, output: 'ok' });
    render(<ToolTester serverName="fixture" tools={[complexTool(), { ...complexTool(), name: 'other_tool' }]}
      onTestTool={onTestTool} prefill={{ toolName: 'firecrawl_scrape', arguments: { options: { depth: 1 } } }} />);
    const previous = await screen.findByRole('textbox', { name: 'options (JSON object)' });
    fireEvent.change(previous, { target: { value: '{"depth":' } });
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'mcp.tester.select' }));
    fireEvent.click(await screen.findByRole('option', { name: 'other_tool' }));
    const current = screen.getByRole('textbox', { name: 'options (JSON object)' });
    expect(current).not.toBe(previous);
    expect(current).toHaveValue('');
    expect(screen.getByRole('button', { name: 'mcp.tester.test' })).toBeEnabled();
    expect(onTestTool).not.toHaveBeenCalled();
  });

  it('blocks Test while any object or array JSON draft is invalid, including after refresh', async () => {
    const onTestTool = jest.fn().mockResolvedValue({ success: true, output: 'ok' });
    const tool = () => ({ ...complexTool(), inputSchema: { ...complexTool().inputSchema,
      properties: { ...complexTool().inputSchema.properties, tags: { type: 'array', items: { type: 'string' } } } } });
    const prefill = { toolName: 'firecrawl_scrape', arguments: { options: { depth: 1 }, tags: ['one'] } };
    const view = render(<ToolTester serverName="fixture" tools={[tool()]} onTestTool={onTestTool} prefill={prefill} />);
    const options = await screen.findByRole('textbox', { name: 'options (JSON object)' });
    const tags = screen.getByRole('textbox', { name: 'tags (JSON array)' });
    const run = () => screen.getByRole('button', { name: 'mcp.tester.test' });
    fireEvent.change(options, { target: { value: '{"depth":' } });
    await act(async () => { fireEvent.click(run()); });
    expect(onTestTool).not.toHaveBeenCalled();
    expect(run()).toBeDisabled();
    fireEvent.change(tags, { target: { value: '["two",' } });
    fireEvent.change(options, { target: { value: '{"depth":3}' } });
    expect(run()).toBeDisabled(); // Repairing one field must not hide another invalid draft.
    view.rerender(<ToolTester serverName="fixture" tools={[tool()]} onTestTool={onTestTool} prefill={prefill} />);
    expect(screen.getByRole('textbox', { name: 'tags (JSON array)' })).toBe(tags);
    expect(tags).toHaveValue('["two",');
    expect(run()).toBeDisabled();
    fireEvent.change(tags, { target: { value: '["two"]' } });
    expect(run()).toBeEnabled();
    fireEvent.click(run());
    await waitFor(() => expect(onTestTool).toHaveBeenCalledWith('firecrawl_scrape',
      { options: { depth: 3 }, tags: ['two'] }, 60));
    expect(onTestTool).toHaveBeenCalledTimes(1);
  });
});
