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

const objectAndArrayTool = () => ({
  ...complexTool(),
  inputSchema: { ...complexTool().inputSchema, properties: {
    ...complexTool().inputSchema.properties,
    tags: { type: 'array', items: { type: 'string' } },
  } },
});

const validComplexArguments = {
  url: 'https://example.test/page',
  options: { depth: 1 },
  tags: ['one'],
};

describe('ToolTester complex parameter lifecycle', () => {
  it.each([
    ['object', '[]'], ['object', 'null'], ['object', '"text"'], ['object', '7'], ['object', 'true'],
    ['array', '{}'], ['array', 'null'], ['array', '"text"'], ['array', '7'], ['array', 'false'],
  ] as const)('blocks a JSON %s draft with the wrong shape %s until repaired', async (type, text) => {
    const onTestTool = jest.fn().mockResolvedValue({ success: true, output: 'ok' });
    render(<ToolTester serverName="fixture" tools={[objectAndArrayTool()]} onTestTool={onTestTool}
      prefill={{ toolName: 'firecrawl_scrape', arguments: validComplexArguments }} />);
    const key = type === 'object' ? 'options' : 'tags';
    const input = await screen.findByRole('textbox', { name: `${key} (JSON ${type})` });
    fireEvent.change(input, { target: { value: text } });
    expect(input).toHaveValue(text);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText(type === 'object' ? 'schema.expectedObject' : 'schema.expectedArray')).toBeInTheDocument();
    const run = screen.getByRole('button', { name: 'mcp.tester.test' });
    expect(run).toBeDisabled();
    fireEvent.click(run);
    expect(onTestTool).not.toHaveBeenCalled();
    const repaired = type === 'object' ? { depth: 2, nested: { formats: ['markdown'], include: false } } : ['two', '三'];
    fireEvent.change(input, { target: { value: JSON.stringify(repaired) } });
    await waitFor(() => expect(run).toBeEnabled());
    expect(input).toHaveAttribute('aria-invalid', 'false');
    expect(onTestTool).not.toHaveBeenCalled();
    fireEvent.click(run);
    await waitFor(() => expect(onTestTool).toHaveBeenCalledWith('firecrawl_scrape',
      { ...validComplexArguments, [key]: repaired }, 60));
    expect(onTestTool).toHaveBeenCalledTimes(1);
  });

  it.each(['object', 'array'] as const)('blocks a prefilled JSON %s value with the wrong shape', async type => {
    const onTestTool = jest.fn().mockResolvedValue({ success: true, output: 'ok' });
    const key = type === 'object' ? 'options' : 'tags';
    const invalidValue = type === 'object' ? [] : {};
    render(<ToolTester serverName="fixture" tools={[objectAndArrayTool()]} onTestTool={onTestTool}
      prefill={{ toolName: 'firecrawl_scrape', arguments: { ...validComplexArguments, [key]: invalidValue } }} />);
    const input = await screen.findByRole('textbox', { name: `${key} (JSON ${type})` });
    const run = screen.getByRole('button', { name: 'mcp.tester.test' });
    await waitFor(() => expect(run).toBeDisabled());
    expect(input).toHaveAttribute('aria-invalid', 'true');
    fireEvent.click(run);
    expect(onTestTool).not.toHaveBeenCalled();
    const repaired = type === 'object' ? { depth: 2 } : ['two'];
    fireEvent.change(input, { target: { value: JSON.stringify(repaired) } });
    await waitFor(() => expect(run).toBeEnabled());
    fireEvent.click(run);
    await waitFor(() => expect(onTestTool).toHaveBeenCalledWith('firecrawl_scrape',
      { ...validComplexArguments, [key]: repaired }, 60));
    expect(onTestTool).toHaveBeenCalledTimes(1);
  });

  it('keeps Test blocked when repairing one field leaves another wrong-shaped draft', async () => {
    const onTestTool = jest.fn().mockResolvedValue({ success: true, output: 'ok' });
    const prefill = { toolName: 'firecrawl_scrape', arguments: validComplexArguments };
    const view = render(<ToolTester serverName="fixture" tools={[objectAndArrayTool()]} onTestTool={onTestTool} prefill={prefill} />);
    const options = await screen.findByRole('textbox', { name: 'options (JSON object)' });
    const tags = screen.getByRole('textbox', { name: 'tags (JSON array)' });
    const run = screen.getByRole('button', { name: 'mcp.tester.test' });
    fireEvent.change(options, { target: { value: 'null' } });
    fireEvent.change(tags, { target: { value: '{}' } });
    fireEvent.change(options, { target: { value: '{"depth":3}' } });
    expect(run).toBeDisabled();
    view.rerender(<ToolTester serverName="fixture" tools={[objectAndArrayTool()]} onTestTool={onTestTool} prefill={prefill} />);
    expect(tags).toHaveValue('{}');
    expect(run).toBeDisabled();
    fireEvent.click(run);
    expect(onTestTool).not.toHaveBeenCalled();
    fireEvent.change(tags, { target: { value: '["two"]' } });
    await waitFor(() => expect(run).toBeEnabled());
    fireEvent.click(run);
    await waitFor(() => expect(onTestTool).toHaveBeenCalledWith('firecrawl_scrape',
      { ...validComplexArguments, options: { depth: 3 }, tags: ['two'] }, 60));
    expect(onTestTool).toHaveBeenCalledTimes(1);
  });

  it.each(['object', 'array'] as const)('clears an optional wrong-shaped JSON %s draft without sending the old value', async type => {
    const onTestTool = jest.fn().mockResolvedValue({ success: true, output: 'ok' });
    render(<ToolTester serverName="fixture" tools={[objectAndArrayTool()]} onTestTool={onTestTool}
      prefill={{ toolName: 'firecrawl_scrape', arguments: validComplexArguments }} />);
    const key = type === 'object' ? 'options' : 'tags';
    const input = await screen.findByRole('textbox', { name: `${key} (JSON ${type})` });
    const run = screen.getByRole('button', { name: 'mcp.tester.test' });
    fireEvent.change(input, { target: { value: type === 'object' ? '[]' : '{}' } });
    expect(run).toBeDisabled();
    expect(onTestTool).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '  ' } });
    await waitFor(() => expect(run).toBeEnabled());
    expect(input).toHaveValue('  ');
    fireEvent.click(run);
    await waitFor(() => expect(onTestTool).toHaveBeenCalledTimes(1));
    const sent = onTestTool.mock.calls[0][1];
    expect(Object.hasOwn(sent, key)).toBe(false);
    expect(sent.url).toBe(validComplexArguments.url);
    expect(sent[type === 'object' ? 'tags' : 'options']).toEqual(validComplexArguments[type === 'object' ? 'tags' : 'options']);
  });

  it('edits and clears own prototype-like JSON keys from empty values while preserving validity', async () => {
    const onTestTool = jest.fn().mockResolvedValue({ success: true, output: 'ok' });
    const keys = ['__proto__', 'constructor', 'toString'];
    render(<ToolTester serverName="data-boundary" tools={[{
      name: 'data_tool', description: 'Data boundary tool',
      inputSchema: { type: 'object', properties: Object.fromEntries(keys.map(key => [key, { type: 'object' }])) },
    }]} prefill={{ toolName: 'data_tool', arguments: {} }} onTestTool={onTestTool} />);
    const proto = await screen.findByRole('textbox', { name: '__proto__ (JSON object)' });
    expect(proto).toHaveValue('');
    expect(screen.getByRole('textbox', { name: 'constructor (JSON object)' })).toHaveValue('');
    expect(screen.getByRole('textbox', { name: 'toString (JSON object)' })).toHaveValue('');
    fireEvent.change(proto, { target: { value: '{"marker":"proto-data"}' } });
    const constructor = screen.getByRole('textbox', { name: 'constructor (JSON object)' });
    fireEvent.change(constructor, { target: { value: '{' } });
    expect(screen.getByRole('button', { name: 'mcp.tester.test' })).toBeDisabled();
    expect(onTestTool).not.toHaveBeenCalled();
    fireEvent.change(constructor, { target: { value: '{"marker":"constructor-data"}' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'toString (JSON object)' }), { target: { value: '{"marker":"string-data"}' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'mcp.tester.test' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'mcp.tester.test' }));
    await waitFor(() => expect(onTestTool).toHaveBeenCalledTimes(1));
    const sent = onTestTool.mock.calls[0][1];
    expect(Object.getPrototypeOf(sent)).toBe(Object.prototype);
    for (const key of keys) expect(Object.hasOwn(sent, key)).toBe(true);
    expect(sent['__proto__']).toEqual({ marker: 'proto-data' });
    expect(sent.constructor).toEqual({ marker: 'constructor-data' });
    expect(sent.toString).toEqual({ marker: 'string-data' });
    fireEvent.change(proto, { target: { value: '' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'mcp.tester.test' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'mcp.tester.test' }));
    await waitFor(() => expect(onTestTool).toHaveBeenCalledTimes(2));
    expect(Object.hasOwn(onTestTool.mock.calls[1][1], '__proto__')).toBe(false);
  });
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
